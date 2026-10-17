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
import { buildLoopCommand } from './command.ts'
import { Config, killSwitchFromEnv, resolveConfig, type LoopConfig } from './config.ts'
import { LoopEngine } from './engine.ts'
import { LoopProjectionStore, loopFactsOf, loopProjectionDefinitionFor } from './loop-projection.ts'
import { loopMessage } from './message.ts'
import {
  createQueue,
  handleTurnStopping,
  runLoopCommand,
  type Caller,
  type Enqueue,
  type LoopEvent,
  type RegistryDeps,
} from './registry.ts'
import { defineLoopNextTool, defineLoopStartTool, defineLoopStatusTool, defineLoopStopTool } from './tools.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SchedulePort, ScheduleRecordLike } from './types.ts'

/**
 * The schedule service's post-commit announcement, declared here for the same
 * reason as {@link SessionProjectionsLike}: this plugin reads the event
 * structurally rather than importing `@deepseek-ai/dsh-schedule`, so the
 * package's own `declare module '@deepseek-ai/cordis'` augmentation is not in
 * this program's module graph and the event key would look unknown. The event
 * itself is real — `ScheduleService.emitChanged()` emits it after every durable
 * task write, including a delivery — and the test suite asserts the wiring
 * against the live service, which is where the two declarations meet.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Durable schedule state changed; emitted after every committed task write. */
    'schedule/changed'(): void
  }
}

/** Cordis plugin name. */
export const name = 'cordis-plugin-loop'
/**
 * The two services this plugin cannot do anything without, declared as hard
 * dependencies so Cordis activates the plugin only once both are provided.
 *
 * `tools` carries the four continuation tools. `schedule` is the backend the
 * whole feature is about: `apply` used to *probe* for it and return early when
 * it was missing, which a cold start can trigger — the loader composes its
 * entries in one pass, and a service is only in the store after its own fiber
 * has provided it. The plugin was then activated with an ACTIVE fiber, logged
 * one warning and registered nothing at all, permanently, because nothing
 * re-runs `apply` (T15: no tools, no `/loop` until an unrelated reload).
 * Declaring `schedule` here makes activation wait for it instead of guessing.
 *
 * `commands` is deliberately NOT in this list: the command surface is optional,
 * the tools must never be held hostage by it, and a registry that appears late
 * is picked up reactively where the command is registered below.
 */
export const inject = ['tools', 'schedule']
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
 * The host session-projection seam.
 *
 * Hand-written rather than imported for the same reason as {@link PlanModeLike}:
 * a type from `@deepseek-ai/dsh-session-projection` in the emitted
 * `lib/index.d.ts` would make the package a hard requirement for consumers that
 * only want `/loop`. The link is asserted at compile time in the test suite,
 * which does have the real package.
 *
 * Only two members are declared because only two are used: the plugin registers
 * one unit per session, and drops it when that session goes away. Nothing here
 * writes projection state — the unit reads the plugin's own mirror.
 */
export interface SessionProjectionsLike {
  /**
   * Register one projection unit; the returned disposer unregisters it.
   *
   * @param definition - The unit definition.
   * @returns The exact disposer for this registration.
   */
  register(definition: unknown): () => void
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
  // The projection mirror is written through by the serial queue below, so the
  // client value can never disagree with the engine about what is armed.
  const projections = new LoopProjectionStore()
  const sessionProjections = optional<SessionProjectionsLike>(ctx, 'sessionProjections')

  // Register the `loop` unit exactly ONCE, for the whole plugin.
  //
  // The registry keeps one registration per key — a second `register()` for the
  // same key only bumps a refcount — so a definition cannot be private to a
  // session. Registering one per session (with the id baked into each closure)
  // collapsed to whichever registered first and served *its* mirror to every
  // other session (T17). The unit binds the session in `init(header)` instead,
  // which is also what makes a restored or long-idle session read its own mirror
  // without waiting for its next turn end.
  if (sessionProjections !== undefined) {
    try {
      sessionProjections.register(loopProjectionDefinitionFor(projections))
    } catch (error) {
      // A profile without the projection seam must not cost the user the tool
      // surfaces this plugin exists for.
      logger.warn(`loop: registering the loop session projection failed: ${messageOf(error)}`)
    }
  }

  /**
   * Every session this plugin has served, for the `schedule/changed` re-read.
   *
   * The projection registration is key-level now, so this set is plain
   * bookkeeping: it is how a post-commit schedule write knows which sessions to
   * re-read. Ids arrive through the serial queue below, the one funnel every
   * command, tool call and guard pass already goes through.
   */
  const knownSessions = new Set<string>()

  /**
   * Re-read the authoritative loop and publish it to the projection.
   *
   * This runs inside the serial queue, after the task that changed something, so
   * it observes the committed state rather than a guess. It never writes, never
   * throws, and never reports: a projection is a view, and a view that cannot be
   * refreshed must not turn a successful command into a failure.
   */
  const refreshProjection = async (sessionId: string): Promise<void> => {
    knownSessions.add(sessionId)
    try {
      const reader = engineAgentOf(sessionId)
      const listed = await engine.list(reader)
      if (!listed.ok) {
        // A state that cannot be read must not keep describing the loop it used
        // to have: publishing the old `active: true` would leave the capsule
        // offering buttons for a loop nobody can verify. The no-loop value is
        // the honest degradation — nothing is claimed, and the capsule hides.
        projections.publishNoLoop(sessionId)
        logger.warn(`loop: the loop projection for ${sessionId} was cleared because the state read failed`)
        return
      }
      const loop = listed.loops[0]
      if (loop === undefined) {
        projections.publishNoLoop(sessionId)
        return
      }
      const receipts = await engine.receiptsOf(reader, loop.id)
      projections.set(sessionId, loopFactsOf(loop, receipts.length))
    } catch (error) {
      logger.warn(`loop: refreshing the loop projection failed: ${messageOf(error)}`)
      projections.publishNoLoop(sessionId)
    }
  }

  // Every command, tool call and guard pass already funnels through this one
  // queue, which is why it — and not each call site — is where the projection is
  // refreshed.
  const queue = createQueue()
  const enqueue: Enqueue = <T,>(task: () => Promise<T>, sessionId?: string): Promise<T> =>
    queue(async () => {
      try {
        return await task()
      } finally {
        if (sessionId !== undefined && sessionId.length > 0) await refreshProjection(sessionId)
      }
    })

  /**
   * Re-read one session's projection without doing anything else.
   *
   * The queue's `finally` is the refresh, so an empty task is not a trick: it is
   * how the `schedule/changed` edge asks for exactly one re-read through the same
   * serial boundary every other refresh goes through.
   */
  const refreshThroughQueue = (sessionId: string): void => {
    void enqueue(async () => undefined, sessionId)
  }

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
    reportEvent: (event) => logger.info(formatLoopEvent(event)),
  }

  // The tool surface comes first: it is the plugin's primary interface, and it
  // must not sit behind — or depend on — the optional command registry below
  // (T15: the command path ran first, so anything that went wrong or arrived
  // late there took the four tools down with it).
  //
  // Each registration is wired through `ctx.effect` so its disposer belongs to
  // this plugin's fiber. The tool registry scopes a registration to the service
  // that owns it (`ToolRuntime.register` → `layers.effect(this.ctx, …)`), not to
  // the caller, so a plugin unloaded and applied again in the same process would
  // otherwise collide with its own still-registered names ("tool … is already
  // registered"). A cold start registers on its first apply, which is precisely
  // when that collision becomes reachable.
  for (const definition of [
    defineLoopStartTool(deps, enqueue),
    defineLoopStatusTool(deps, enqueue),
    defineLoopNextTool(deps, enqueue),
    defineLoopStopTool(deps, enqueue),
  ]) {
    ctx.effect(() => ctx.tools.register(definition), `loop: ${definition.name}`)
  }

  // The command surface is optional (a profile may compose the tools without a
  // command registry) but it is not one-shot: a registry that appears after this
  // apply still gets `/loop` without a reload, exactly like `schedule` does.
  // Composing inside `ctx.inject` is what gives it that lifetime.
  ctx.inject(['commands'], (commandCtx: Context) => {
    const registry = optional<OptionalContext['commands']>(commandCtx, 'commands')
    if (registry === undefined) return
    const definition = buildLoopCommand({ registry: deps, enqueue, callerFrom: callerFromAgent })
    registry.register({
      definitionId: CommandDefinitionId(definition.definitionId),
      name: definition.name,
      description: definition.description,
      input: definition.input,
      handler: definition.handler,
    })
  })
  if (optional<OptionalContext['commands']>(ctx, 'commands') === undefined) {
    logger.warn('loop: the command registry is not composed, so /loop has no human command surface here.')
  }

  // The omission guard: one serial listener on the turn-stop boundary for every
  // agent, including subagents (whose loops simply never exist).
  ctx.on('agent/turn-stopping', async (payload: { agent: unknown }) => {
    const caller = callerFromAgent(payload.agent)
    if (caller === undefined) return
    try {
      await enqueue(async () => {
        const report = await handleTurnStopping(deps, caller)
        if (report !== undefined) logger.info(`loop guard: ${report}`)
      }, caller.sessionId)
    } catch (error) {
      logger.warn(`loop guard failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // The schedule service announces every post-commit task write — a delivery
  // included — with `schedule/changed`. Re-reading the projected sessions there
  // is what keeps a scheduled round from showing up late: without it the capsule
  // would keep the previous `nextAt`/`round` until the delivered session's turn
  // happened to end, which for a loop that fires and is still being worked on is
  // a whole round of staleness. The event carries no session identity, so every
  // session this plugin has already served is re-read; the refresh rides the same
  // serial queue and publishes nothing when a session's value did not move.
  ctx.on('schedule/changed', () => {
    for (const sessionId of knownSessions) refreshThroughQueue(sessionId)
    return undefined
  })
  ctx.on('agent/disposed', (payload: { agent: unknown }) => {
    const id = agentIdOf(payload.agent)
    if (id === undefined) return
    void enqueue(async () => {
      engine.forgetSession(id)
      knownSessions.delete(id)
      projections.clear(id)
    })
  })
}

/** Read the time zone the harness resolved, falling back to the process zone. */
function resolveTimeZone(timeContext: { readonly timeZone?: string } | undefined): string {
  const zone = timeContext?.timeZone
  if (typeof zone === 'string' && zone.trim().length > 0) return zone.trim()
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof resolved === 'string' && resolved.length > 0 ? resolved : FALLBACK_TIME_ZONE
}

/** Flatten an unknown failure into one line. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Render one guard-rail event as a single log line.
 *
 * The `kind` discriminator comes first so a reader (or a grep) can tell *which*
 * safety net fired without matching prose that two of them share.
 *
 * @param event - The event the registry reported.
 * @returns One log line.
 */
export function formatLoopEvent(event: LoopEvent): string {
  return `loop ${event.kind}: session ${event.sessionId} record ${event.id}: ${event.detail}`
}

/**
 * Build the engine-facing agent view for one session id.
 *
 * Used by the projection refresh, which only knows the session identity and
 * must never be able to deliver a round.
 *
 * @param sessionId - Session identity.
 * @returns An agent view whose `send` is a no-op.
 */
function engineAgentOf(sessionId: string): {
  readonly sessionId: string
  readonly cwd: string
  readonly isSubagent: boolean
  readonly send: () => void
} {
  return { sessionId, cwd: process.cwd(), isSubagent: false, send: () => undefined }
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
 * Re-exported from {@link module:cordis-plugin-loop/message} so the command, the
 * `loop_start` tool and this module all build the identical message; it stays a
 * named export of the package root because that is the public surface a consumer
 * (and the test suite) already imports.
 */
export { loopMessage }

/** Read the identity of an agent reference, for bookkeeping cleanup. */
function agentIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}
