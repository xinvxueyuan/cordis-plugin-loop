/**
 * `/loop` for DeepSeek Harness: run a task now, then keep running it on a fixed
 * cadence or on one the model chooses each round.
 *
 * The plugin is deliberately inert without `ctx.schedule`: it then registers no
 * command and no tool and logs one warning, so composing it into a profile that
 * has no schedule service never breaks the profile.
 * @module cordis-plugin-loop
 */
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildLoopCommand } from './command.ts'
import { Config, killSwitchFromEnv, resolveConfig, type LoopConfig } from './config.ts'
import { LoopEngine } from './engine.ts'
import { createQueue, handleTurnStopping, runLoopCommand, type Caller, type RegistryDeps } from './registry.ts'

/**
 * Register this plugin's own message source.
 *
 * `dsh-experimental-auto-review` skips messages tagged `kind: 'tool'`, and that
 * tag belongs to tool-role results anyway, so a plugin that injects rounds must
 * declare a kind of its own — mirroring the way `dsh-schedule` declares
 * `'schedule'`.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One immediate round injected by `/loop`. */
    loop: { kind: 'loop' }
  }
}
import { defineLoopNextTool, defineLoopStopTool } from './tools.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SchedulePort, ScheduleRecordLike } from './types.ts'

/** Cordis plugin name. */
export const name = 'cordis-plugin-loop'
/** `tools` is required to register the continuation tools; everything else is optional. */
export const inject = ['tools']
export { Config }
export type { LoopConfig }

/** Time zone used when the harness exposes none. */
const FALLBACK_TIME_ZONE = 'UTC'

/**
 * The host plan-mode service's per-agent surface.
 *
 * `@deepseek-ai/dsh-plan-mode` answers `get(agent)` with the agent's logged
 * state (`{ active }`, plus `pending` while a selection is queued) and selects
 * with `set(agent, active)`. There is **no service-level `active` property** —
 * reading one is the bug this plugin once shipped — so the probe must go through
 * `get` with the live agent, which is what the real controller's
 * `get(agent: Agent): { active: boolean; pending?: boolean }` requires.
 *
 * `active` is optional here on purpose: this mirror tolerates a service that
 * omits it, and the probe reads `?.active === true` so an absent state can never
 * be mistaken for an active one.
 *
 * This mirror is deliberately hand-written: `@deepseek-ai/dsh-plan-mode` is a
 * devDependency, and naming its type here would put an unresolvable import into
 * the emitted `lib/index.d.ts` for consumers that do not install it. The link to
 * the host is therefore asserted at compile time in the test suite
 * (`test/register.test.ts`), which is where the real class is available.
 */
export interface PlanModeLike {
  /** Read one agent's plan-mode state. */
  get(agentRef: unknown): { readonly active?: boolean } | undefined
}

/** Narrow view of the optional services and events this plugin reads. */
interface OptionalContext {
  /** The schedule service, when composed. */
  readonly schedule?: SchedulePort
  /** The command registry, when composed. */
  readonly commands?: {
    register(definition: {
      definitionId?: unknown
      name: string
      description: string
      input?: { hint: string; attachments?: boolean }
      handler: (invocation: {
        agent: unknown
        rawInput: string
      }) => Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }>
    }): () => void
  }
  /** The time-context service, when composed; supplies the resolved zone. */
  readonly timeContext?: { readonly timeZone?: string }
}

/**
 * Register the `/loop` command, the continuation tools, and the omission guard.
 *
 * @param ctx - Plugin context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: LoopConfig): void {
  const effective = resolveConfig(config)
  const env = process.env
  const scheduleService = optional<SchedulePort>(ctx, 'schedule')
  const commands = optional<OptionalContext['commands']>(ctx, 'commands')
  const planMode = optional<PlanModeLike>(ctx, 'planMode')
  const timeContext = optional<{ readonly timeZone?: string }>(ctx, 'timeContext')
  const port = scheduleService === undefined ? undefined : schedulePortOf(scheduleService)
  const logger = {
    warn: (message: string): void => {
      try {
        ctx.logger.warn(message)
      } catch {
        // Logging must never be the reason a loop fails.
      }
    },
    info: (message: string): void => {
      try {
        ctx.logger.info(message)
      } catch {
        // see above
      }
    },
  }
  if (port === undefined || scheduleService === undefined) {
    logger.warn(
      'loop: the schedule service is not composed, so /loop is inert in this profile (no command and no tools were registered).',
    )
    return
  }
  const engine = new LoopEngine({
    config: effective,
    schedule: port,
    timeZone: resolveTimeZone(timeContext),
    logger,
  })
  const enqueue = createQueue()
  const deps: RegistryDeps = {
    config: effective,
    engine,
    env,
    killSwitch: () => killSwitchFromEnv(env),
    // The host plan-mode service is keyed per agent and exposes `get(agent)`;
    // it has no `active` property of its own, so the probe must be evaluated
    // with the calling agent or it can never be true.
    planMode: planMode === undefined ? undefined : (agentRef) => planMode.get(agentRef)?.active === true,
    // Built from the LIVE service, not from the forwarding adapter: the adapter
    // deliberately exposes only the five lifecycle calls this engine needs, so a
    // catalogue lookup through it could never find `catalog`.
    listAllLoopRecords: catalogFn(scheduleService),
  }

  if (commands !== undefined) {
    const definition = buildLoopCommand({ registry: deps, enqueue, callerFrom: callerFromAgent })
    commands.register({
      definitionId: CommandDefinitionId(definition.definitionId),
      name: definition.name,
      description: definition.description,
      input: definition.input,
      handler: definition.handler,
    })
  } else {
    logger.warn('loop: the command registry is not composed, so /loop has no human command surface here.')
  }

  ctx.tools.register(defineLoopNextTool(deps, enqueue))
  ctx.tools.register(defineLoopStopTool(deps, enqueue))

  // The omission guard: one serial listener on the turn-stop boundary for every
  // agent, including subagents (whose loops simply never exist).
  ctx.on('agent/turn-stopping', async (payload: { agent: unknown }) => {
    const caller = callerFromAgent(payload.agent)
    if (caller === undefined) return
    try {
      await enqueue(async () => {
        const report = await handleTurnStopping(deps, caller)
        if (report !== undefined) logger.info(`loop guard: ${report}`)
      })
    } catch (error) {
      logger.warn(`loop guard failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ctx.on('agent/disposed', (payload: { agent: unknown }) => {
    const id = agentIdOf(payload.agent)
    if (id === undefined) return
    void enqueue(async () => engine.forgetSession(id))
  })
}

/** Read the time zone the harness resolved, falling back to the process zone. */
function resolveTimeZone(timeContext: { readonly timeZone?: string } | undefined): string {
  const zone = timeContext?.timeZone
  if (typeof zone === 'string' && zone.trim().length > 0) return zone.trim()
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof resolved === 'string' && resolved.length > 0 ? resolved : FALLBACK_TIME_ZONE
}

/**
 * Read an optional service without declaring it as a required dependency.
 *
 * A plain `ctx.<name>` read on a service outside the plugin's `inject` list
 * throws, and this plugin's whole point is to stay inert when `schedule` is not
 * composed, so every optional read goes through `ctx.reflect.get` here.
 *
 * @param ctx - Plugin context.
 * @param name - Service name.
 * @returns The service, or `undefined` when it is not composed.
 */
function optional<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { reflect: { get(service: string, strict?: boolean): T | undefined } }).reflect.get(
      name,
      false,
    )
  } catch {
    return undefined
  }
}

/**
 * Adapt the live service into the structural port the engine uses.
 *
 * The adapter is deliberately narrow: it forwards exactly the five calls the
 * lifecycle needs, and nothing else. Callers that need a wider surface (the
 * kill switch's catalogue lookup) must hold the live service instead.
 *
 * @param service - The live `ctx.schedule` service.
 * @returns The engine-facing port.
 */
function schedulePortOf(service: SchedulePort): SchedulePort {
  return {
    create: (sessionId, request) => service.create(sessionId, request) as Promise<ScheduleRecordLike>,
    list: (request) => service.list(request),
    history: (request) => service.history(request),
    delete: (request) => service.delete(request),
    update: (request) => service.update(request),
  }
}

/**
 * Discover this plugin''s records across every session, for the kill switch.
 *
 * Exported so the tests drive this exact function instead of a re-implementation: a
 * hand-built stand-in here is what once hid a catalog lookup that could never
 * succeed.
 *
 * @param service - The live `ctx.schedule` service, which owns `catalog`.
 * @returns A function returning one entry per record this plugin owns.
 */
export function catalogFn(
  service: SchedulePort,
): () => Promise<readonly { sessionId: string; record: ScheduleRecordLike }[]> {
  return async () => {
    if (typeof service.catalog !== 'function') return Object.freeze([])
    const entries = await service.catalog()
    return entries
      .filter((entry) => entry.prompt.startsWith('DSH_LOOP '))
      .map((entry) => ({ sessionId: entry.sessionId, record: entry as ScheduleRecordLike }))
  }
}

/**
 * Resolve one live agent reference into a caller description.
 *
 * @param agent - Agent from a command invocation or an agent event payload.
 * @returns The caller, or `undefined` when the value is not a usable agent.
 */
export function callerFromAgent(agent: unknown): Caller | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const candidate = agent as {
    id?: unknown
    session?: { header?: { cwd?: string; origin?: string } }
    followup?: (message: unknown) => void
  }
  if (typeof candidate.id !== 'string') return undefined
  const header = candidate.session?.header
  const cwd = header?.cwd
  // `followup` is a prototype method on the live agent (`followup(input) { this.send(...) }`),
  // so it must keep its receiver: detaching it makes `this` undefined in strict
  // mode and the first round throws instead of being delivered.
  const followup = typeof candidate.followup === 'function' ? candidate.followup.bind(candidate) : undefined
  return {
    sessionId: candidate.id,
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
    isSubagent: header?.origin === 'subagent',
    send: (text: string): void => {
      if (followup === undefined) return
      followup(loopMessage(text))
    },
    agentRef: candidate,
  }
}

/**
 * Build the model-visible message for one immediate round.
 *
 * The message goes through the host's own factory rather than a hand-rolled
 * object literal for two reasons the host cares about: `createUserMessage` mints
 * the `id` that the durable inbox dedupes and locates pending messages by (a
 * message without one makes the second injection throw
 * `message "undefined" is already pending`), and the `source` tag is a declared
 * member of `MessageSourceMap`, so it must be a real kind rather than borrowed
 * from another role.
 *
 * @param text - Round text.
 * @returns A frozen user-role message the agent's `followup` accepts.
 */
export function loopMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'loop' },
  })
}

/** Read the identity of an agent reference, for bookkeeping cleanup. */
function agentIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}
