/**
 * Shared test harness: a real `@deepseek-ai/dsh-schedule` assembly over the real
 * local JSON storage backend, with a stub session controller and agent.
 *
 * Nothing here fakes the scheduler — deliveries go through the real
 * `ScheduleService` timer, real `scheduleDomain` persistence, and the real
 * `[SCHEDULE REMINDER]` framing. Only the session boundary is a stub, because
 * the loop plugin never touches it beyond `resolveAgent` and `flush`.
 * @module cordis-plugin-loop/test/harness
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import agentRegistry from '@deepseek-ai/dsh-agent'
import commandsPlugin from '@deepseek-ai/dsh-commands'
import schedule from '@deepseek-ai/dsh-schedule'
import storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import { apply as applyLoop } from '../src/index.ts'
import type { LoopConfig } from '../src/config.ts'
import type { SchedulePort, ScheduleRecordLike } from '../src/types.ts'
import type { Context as CordisContext } from '@deepseek-ai/cordis'

/** One message the agent received, with its identity and source. */
export interface CapturedMessage {
  /** The id the host minted; the durable inbox dedupes and locates by it. */
  readonly id: string
  /** Text of every text block, joined. */
  readonly text: string
  /** Source kind recorded on the message. */
  readonly sourceKind: string
  /** Epoch milliseconds the message was captured. */
  readonly at: number
}

/** A stub agent that records everything delivered to it. */
export interface StubAgent {
  /** Session identity shared by the agent and the schedule row. */
  readonly id: string
  /** Live session object handed to `ctx.sessions.flush`. */
  readonly session: {
    readonly id: string
    /** Session metadata the plugin reads: working directory and delegation origin. */
    readonly header: { id?: string; cwd?: string; origin?: string }
    /** Log-only lifecycle append channel the real command runtime uses. */
    readonly append: (type: string, data: unknown) => void
  }
  /** Every delivered message, in order. */
  readonly messages: CapturedMessage[]
  /** Log-only lifecycle events the command runtime appended. */
  readonly lifecycle: { readonly type: string; readonly data: unknown }[]
  /**
   * Wake the agent with one model-visible message, exactly like the host:
   * a prototype method that routes through `send` and therefore needs `this`.
   */
  readonly followup: (message: unknown) => void
  /**
   * When set, the next delivery throws this text.
   *
   * The double fails the same way the host would: from inside `send`, which is
   * what `followup` calls, so a caller that swallows the failure is visible.
   */
  failNextSend: string | undefined
  /**
   * Model the turn that consumes everything currently pending.
   *
   * The host drops a message from the inbox once the turn it woke has been
   * assembled, which is what makes its id reusable; a test that injects twice
   * across turns calls this between the two.
   */
  readonly settle: () => void
  /** Wait until a message matching `predicate` arrives, or reject on timeout. */
  readonly waitFor: (
    predicate: (message: CapturedMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<CapturedMessage>
}

/** One command definition as the real registry resolved it. */
export interface RegisteredCommand {
  /** Stable identity, stringified. */
  readonly definitionId: string
  /** Command name. */
  readonly name: string
  /** Discovery summary. */
  readonly description: string
  /** Input hint, when the definition declared one. */
  readonly hint: string
  /** Whether the definition accepts composer attachments. */
  readonly attachments: boolean
}

/** The live command surface under test: the real `CommandRuntime`. */
export interface CommandsSurface {
  /** Descriptors the real registry reports for the stub agent. */
  readonly definitions: RegisteredCommand[]
  /** Invoke one command the way a UI adapter does. */
  readonly run: (name: string, agent: unknown, rawInput: string) => Promise<{ kind: string; text?: string }>
  /** Resolve one definition from the live registry. */
  readonly find: (name: string, agent: unknown) => RegisteredCommand | undefined
  /** Parse a full command line, for admission assertions. */
  readonly parse: (line: string) => { name: string; rawInput: string } | undefined
}

/** The assembled host under test. */
export interface LoopHost {
  /** Root context every plugin was mounted on. */
  readonly ctx: Context
  /** The schedule service under test; the real one, or the double. */
  readonly schedule: SchedulePort
  /** Whether this assembly actually composed a schedule service. */
  readonly hasScheduleService: boolean
  /** The stub agent bound to `sessionId`. */
  readonly agent: StubAgent
  /** Working directory the session reports. */
  readonly cwd: string
  /** Directory holding the JSON storage unit files. */
  readonly storageRoot: string
  /** The live command surface the loop plugin registered on. */
  readonly commands: CommandsSurface
  /** Tool names the loop plugin registered on the real tool registry. */
  readonly toolNames: readonly string[]
  /** Warnings the plugin wrote to the logger. */
  readonly warnings: readonly string[]
  /** The plugin fiber's lifecycle state (2 = ACTIVE). */
  readonly pluginState: () => number
  /** Number of rows the schedule double holds; throws for the real service. */
  readonly scheduleDoubleSize: () => number
  /** Dispatch one real `agent/turn-stopping` event through the composed listeners. */
  readonly emitTurnStopping: (agent: unknown) => void
  /**
   * Make the agent's next delivery throw, exactly as a broken host channel would.
   *
   * The failure happens inside the host-shaped `send`, so any caller that
   * detaches `followup` from its receiver, or that arms a record before
   * delivering round one, becomes visible.
   */
  readonly failNextDelivery: (message?: string) => void
  /** The exact stub agent instance, for identity assertions. */
  readonly callerAgent: () => unknown
  /**
   * Build a caller view of the stub agent.
   *
   * The plugin reads `session.header` for the working directory and the
   * delegation origin, so a caller that overrides either must keep the rest of
   * the session intact — spreading a fresh session would drop the lifecycle
   * append channel the real command runtime needs.
   */
  readonly caller: (overrides?: { cwd?: string; origin?: 'subagent'; sessionId?: string }) => unknown
  /** The raw tool registry, so a test can execute a registered tool directly. */
  readonly rawToolRuntime: () => {
    register(definition: { name: string }): () => void
    list(): readonly { name: string; description: string }[]
    execute(input: Record<string, unknown>): Promise<unknown>
  }
  /** Wait until one stored record satisfies a predicate. */
  readonly waitForRecord: (
    id: string,
    predicate: (record: ScheduleRecordLike) => boolean,
    timeoutMs?: number,
  ) => Promise<ScheduleRecordLike>
  /** Unmount every plugin and remove the temporary directory. */
  readonly dispose: () => Promise<void>
}

/** Options accepted by {@link bootHost}. */
export interface BootOptions {
  /** Session identity; defaults to a fixed test id. */
  readonly sessionId?: string
  /** Session working directory; defaults to a fresh temporary directory. */
  readonly cwd?: string
  /** Plugin configuration overrides. */
  readonly config?: Partial<LoopConfig>
  /** Extra environment entries for the plugin, e.g. the kill switch. */
  readonly env?: Record<string, string | undefined>
  /** Mount the assembly without the schedule plugin, to observe the inert path. */
  readonly withoutSchedule?: boolean
  /** Extra services to provide before the plugin loads, e.g. `planMode`. */
  readonly services?: Record<string, unknown>
  /** Register no command surface, to observe the degraded path. */
  readonly withoutCommands?: boolean
  /**
   * Provide this schedule implementation instead of mounting the real service.
   *
   * The plugin, the real tool registry, and the real event dispatch stay in
   * place, so a deterministic double can drive the guard through the genuine
   * `agent/turn-stopping` path without waiting for a real timer.
   */
  readonly scheduleDouble?: SchedulePort
  /**
   * Mount the assembly on an existing root context instead of a fresh one.
   *
   * A test that must observe the plugin through a *host service* — the real
   * `SessionProjectionRegistry`, whose registration the plugin performs on the
   * very context it was handed — has to give the plugin that same context.
   * Supplying one here is what makes such a test exercise the shipped wiring
   * instead of two unrelated registries that happen to share a name.
   */
  readonly ctx?: Context
}

/** One waiter for a future delivery. */
interface Waiter {
  /** Message predicate. */
  predicate: (message: CapturedMessage) => boolean
  /** Resolve the waiting promise. */
  resolve: (message: CapturedMessage) => void
  /** Timeout that rejects the waiting promise. */
  timer: ReturnType<typeof setTimeout>
}

/**
 * The stub agent, shaped like the host's live agent.
 *
 * `followup` and `send` are **prototype methods** that go through `this`,
 * mirroring `dsh-agent-loop`'s `followup(input) { this.send(input, "next-turn", true) }`.
 * That shape is the point: a double built from arrow-function properties cannot
 * catch a caller that detaches the method from its receiver, which is exactly
 * how the start path once shipped broken while the suite stayed green.
 */
export class StubAgentImpl implements StubAgent {
  /** Session identity shared by the agent and the schedule row. */
  readonly id: string
  /** Live session object handed to `ctx.sessions.flush`. */
  readonly session: {
    readonly id: string
    /** Session metadata the plugin reads: working directory and delegation origin. */
    readonly header: { id?: string; cwd?: string; origin?: string }
    /** Log-only lifecycle append channel the real command runtime uses. */
    readonly append: (type: string, data: unknown) => void
  }
  /** Every delivered message, in order. */
  readonly messages: CapturedMessage[] = []
  /** Log-only lifecycle events the command runtime appended. */
  readonly lifecycle: { readonly type: string; readonly data: unknown }[] = []
  /** When set, the next `send` throws this text, simulating a broken delivery. */
  failNextSend: string | undefined
  /** Ids the inbox still holds, i.e. messages no turn has consumed yet. */
  private readonly pendingIds = new Set<string>()
  private readonly waiters: Waiter[] = []

  /**
   * @param sessionId - Session identity to report.
   */
  constructor(sessionId: string) {
    this.id = sessionId
    this.session = {
      id: sessionId,
      // The real `SessionHeader` always carries the session id, and the loop
      // projection binds a cell to its session by reading exactly this field, so
      // a double without it would exercise a shape the host never produces.
      header: { id: sessionId },
      append: (type: string, data: unknown): void => {
        this.lifecycle.push({ type, data })
      },
    }
  }

  /**
   * Mirror of the host's `followup`: deliver one message as the next turn.
   *
   * @param input - Message to deliver.
   */
  followup(input: unknown): void {
    this.send(input, 'next-turn', true)
  }

  /**
   * Mirror of the host's `send`: validate the inbox rules, then record.
   *
   * The host's durable inbox requires an `id` on every message and rejects a
   * second pending message carrying an id it already holds
   * (`message "<id>" is already pending`). Both rules are enforced here, so a
   * hand-rolled message literal — no id, or a repeated one — fails in the suite
   * the same way it fails in a real session.
   *
   * @param input - Message to deliver.
   * @param target - Inbox the host would use.
   * @param wakeup - Whether the host would start a turn.
   */
  send(input: unknown, target: string, wakeup: boolean): void {
    void target
    void wakeup
    if (this.failNextSend !== undefined) {
      const failure = this.failNextSend
      this.failNextSend = undefined
      throw new Error(failure)
    }
    const record = input as { id?: unknown; content?: { type: string; text?: string }[]; source?: { kind?: string } }
    const rawId = record.id
    // The host keys pending messages by `id`, so a message without one lands
    // under the literal key `undefined` and the NEXT injection is refused with
    // `message "undefined" is already pending`. Both halves are modelled: a
    // missing id is refused here (the host type requires it, so such a message
    // must never reach a session), and it still occupies the pending key, which
    // is what makes a repeat produce the host's own error text.
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : String(rawId)
    if (this.pendingIds.has(id)) {
      throw new Error(`message "${id}" is already pending`)
    }
    if (typeof rawId !== 'string' || rawId.length === 0) {
      this.pendingIds.add(id)
      throw new Error('the host inbox requires a message id; build the message with createUserMessage')
    }
    const text = (record.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    const captured: CapturedMessage = {
      id,
      text,
      sourceKind: record.source?.kind ?? 'unknown',
      at: Date.now(),
    }
    this.pendingIds.add(id)
    this.messages.push(captured)
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!
      if (!waiter.predicate(captured)) continue
      this.waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(captured)
    }
  }

  /**
   * Model the turn that consumes everything currently pending.
   *
   * The host drops a message from the inbox once the turn it woke has been
   * assembled, which is what makes its id reusable; a test that injects twice
   * across turns calls this between the two.
   */
  settle(): void {
    this.pendingIds.clear()
  }

  /**
   * Wait until a message matching `predicate` arrives.
   *
   * @param predicate - Message predicate.
   * @param timeoutMs - Timeout before rejecting.
   * @returns The matching message.
   */
  waitFor(predicate: (message: CapturedMessage) => boolean, timeoutMs = 5000): Promise<CapturedMessage> {
    return new Promise<CapturedMessage>((resolve, reject) => {
      const existing = this.messages.find(predicate)
      if (existing !== undefined) {
        resolve(existing)
        return
      }
      const waiter: Waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error(`no matching delivery within ${timeoutMs}ms; saw ${this.messages.length} message(s)`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }
}

/**
 * Build one stub agent.
 *
 * @param sessionId - Session identity to report.
 * @returns The recording agent.
 */
export function createStubAgent(sessionId: string): StubAgent {
  return new StubAgentImpl(sessionId)
}

/**
 * Build the live command surface over the real `CommandRuntime`.
 *
 * The plugin's definition is therefore accepted (or rejected) by the same
 * `normalizeDefinition` the package ships, and an invocation goes through the
 * real admission and lifecycle path instead of a stand-in.
 *
 * @param runtime - The live `ctx.commands` service.
 * @param agentRef - Agent used as the scoped-layer key for discovery.
 * @returns The surface the tests drive.
 */
function commandSurface(
  runtime: {
    list(agent: unknown): readonly {
      definitionId?: unknown
      name: string
      description: string
      input?: { hint?: string; attachments?: boolean }
    }[]
    execute(
      agent: unknown,
      line: string,
      attachments: readonly unknown[],
      signal: AbortSignal,
    ): Promise<{ result: { kind: string; text?: string } } | undefined>
  },
  agentRef: unknown,
): CommandsSurface {
  const listAll = (): RegisteredCommand[] =>
    runtime.list(agentRef).map((found) => ({
      definitionId: String(found.definitionId ?? ''),
      name: found.name,
      description: found.description,
      hint: found.input?.hint ?? '',
      attachments: found.input?.attachments === true,
    }))
  return {
    get definitions(): RegisteredCommand[] {
      return listAll()
    },
    find: (name, agent) => {
      const found = runtime.list(agent).find((entry) => entry.name === name)
      if (found === undefined) return undefined
      return {
        definitionId: String(found.definitionId ?? ''),
        name: found.name,
        description: found.description,
        hint: found.input?.hint ?? '',
        attachments: found.input?.attachments === true,
      }
    },
    parse: (line) => {
      const match = /^\/([a-z0-9-]+)([\s\S]*)$/u.exec(line)
      if (match === null) return undefined
      return { name: match[1]!, rawInput: match[2]! }
    },
    run: async (name, agent, rawInput) => {
      // The real parser splits a line into a name and its verbatim remainder, so
      // a raw input that does not start with a separator needs one inserted.
      const line = `/${name}${rawInput.startsWith(' ') ? '' : ' '}${rawInput}`.trimEnd()
      const execution = await runtime.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error(`command "${name}" is not registered`)
      return execution.result
    },
  }
}

/**
 * A schedule stand-in for an assembly that deliberately has none.
 *
 * Every call rejects with the same diagnostic, so a test that reaches for the
 * service in the inert configuration fails loudly instead of silently
 * no-opping.
 *
 * @returns A port whose every method rejects.
 */
function absentSchedule(): SchedulePort {
  const reject = (): Promise<never> => Promise.reject(new Error('this assembly has no schedule service'))
  return {
    create: reject,
    list: reject,
    history: reject,
    delete: reject,
    update: reject,
  } as unknown as SchedulePort
}

/**
 * Read a service's raw implementation, bypassing the tracing proxy that
 * `ctx.reflect.get` wraps a tracked service in.
 *
 * @param ctx - Context the service was provided on.
 * @param name - Service name.
 * @returns The raw service value, or `undefined` when it is not provided.
 */
export function rawService<T>(ctx: Context, name: string): T | undefined {
  const isolate = (ctx as unknown as Record<symbol, Record<string, symbol>>)[Symbol.for('cordis.isolate')]
  const store = (ctx as unknown as { reflect: { store?: Record<string, { value?: unknown }> } }).reflect.store
  const key = isolate?.[name]
  if (key === undefined || store === undefined) return undefined
  return store[key as unknown as string]?.value as T | undefined
}

/**
 * Boot a full schedule assembly plus the loop plugin.
 *
 * @param options - Session identity, cwd, plugin config, and environment.
 * @returns The live host.
 */
export async function bootHost(options: BootOptions = {}): Promise<LoopHost> {
  const sessionId = options.sessionId ?? 'session-under-test'
  const root = await mkdtemp(join(tmpdir(), 'loop-test-'))
  const storageRoot = join(root, 'storage')
  const cwd = options.cwd ?? root
  const agent = createStubAgent(sessionId)
  agent.session.header.cwd = cwd
  const ctx = options.ctx ?? new Context()
  const root0 = ctx as unknown as {
    plugin: (plugin: unknown, config?: unknown) => { await(): Promise<unknown>; dispose(): Promise<void> }
    provide: (name: string, value: unknown) => void
  }

  root0.provide('sessions', { flush: async (): Promise<boolean> => true })
  root0.provide('sessionController', { resolveAgent: async (): Promise<{ agent: unknown }> => ({ agent }) })
  root0.provide('sessionPersistence', {})
  // The tool registry loads behind a system-prompt service; this stub only has
  // to accept its two registrations for the registry to activate.
  root0.provide('systemPrompt', {
    tools: (): (() => void) => (): void => undefined,
    section: (): (() => void) => (): void => undefined,
  })

  const toolsFiber = root0.plugin(toolsPlugin)
  await toolsFiber.await()
  const agentsFiber = root0.plugin(agentRegistry)
  await agentsFiber.await()
  const storageFiber = root0.plugin(storage)
  await storageFiber.await()
  const jsonFiber = root0.plugin(storageJson, { root: storageRoot })
  await jsonFiber.await()
  const domainFiber = root0.plugin(storageDomain, { backend: 'json' })
  await domainFiber.await()
  const scheduleFiber =
    options.withoutSchedule === true || options.scheduleDouble !== undefined
      ? undefined
      : root0.plugin(schedule, {})
  if (scheduleFiber !== undefined) await scheduleFiber.await()
  if (options.scheduleDouble !== undefined) root0.provide('schedule', options.scheduleDouble)

  const env = { DSH_HOME: join(root, 'dsh-home'), ...(options.env ?? {}) }
  // The plugin reads the LIVE `process.env` for DSH_HOME and the kill switch,
  // and keeps that reference, so a test may flip the switch after apply. Setting
  // and restoring individual keys preserves that reference; replacing the whole
  // object would hand the plugin a copy it can never observe again.
  const savedEnv = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // The real command runtime: the plugin's definition has to survive the
  // package's own normalization and invocation path, not a stand-in.
  const commandsFiber = options.withoutCommands === true ? undefined : root0.plugin(commandsPlugin)
  if (commandsFiber !== undefined) await commandsFiber.await()
  for (const [name, value] of Object.entries(options.services ?? {})) root0.provide(name, value)
  // Capture the plugin's own warnings; it logs through `ctx.logger`.
  const warnings: string[] = []
  const loggerService = (ctx as unknown as { logger: { warn: (message: string) => void } }).logger
  const originalWarn = loggerService.warn.bind(loggerService)
  loggerService.warn = (message: string): void => {
    warnings.push(String(message))
    originalWarn(message)
  }
  const toolRuntime = rawService<{
    register(definition: { name: string }): () => void
    list(): readonly { name: string; description: string }[]
    execute(input: Record<string, unknown>): Promise<unknown>
  }>(ctx, 'tools')
  const originalRegister = toolRuntime?.register.bind(toolRuntime)
  const registered: string[] = []
  if (toolRuntime !== undefined && originalRegister !== undefined) {
    toolRuntime.register = (definition: { name: string }): (() => void) => {
      registered.push(definition.name)
      return originalRegister(definition)
    }
  }
  const fiber = root0.plugin(
    {
      name: 'cordis-plugin-loop-test',
      inject: ['tools'],
      apply: (inner: CordisContext, innerConfig: unknown) => {
        applyLoop(inner, innerConfig as LoopConfig)
      },
    },
    options.config ?? {},
  )
  await fiber.await()
  // The agent registry announces every live agent with `agent/created`; the loop
  // plugin registers its session-projection unit on that edge, so the stub agent
  // has to be announced the same way or the projection would never exist here.
  ;(ctx as unknown as { emit: (event: string, payload: unknown) => void }).emit('agent/created', { agent })
  if (process.env['LOOP_TEST_DEBUG'] === '1') {
    const debugCtx = ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }
    const states = {
      tools: (toolsFiber as unknown as { state?: number }).state,
      agents: (agentsFiber as unknown as { state?: number }).state,
      storage: (storageFiber as unknown as { state?: number }).state,
      json: (jsonFiber as unknown as { state?: number }).state,
      domain: (domainFiber as unknown as { state?: number }).state,
      schedule: scheduleFiber === undefined ? 'skipped' : (scheduleFiber as unknown as { state?: number }).state,
      loop: (fiber as unknown as { state?: number }).state,
    }
    console.log('[debug] fiber states:', JSON.stringify(states))
    console.log(
      '[debug] loop inject:',
      JSON.stringify((fiber as unknown as { inject?: unknown }).inject),
      'store:',
      JSON.stringify(Object.keys((fiber as unknown as { store?: object }).store ?? {})),
    )
    for (const name of ['tools', 'agents', 'storage', 'storageDomain', 'schedule', 'commands', 'sessions']) {
      console.log(`[debug] reflect.get(${name}):`, typeof debugCtx.reflect.get(name, false))
    }
    console.log('[debug] registered tools:', registered.join(','))
  }

  const resolvedSchedule = ctx.reflect.get('schedule', false) as SchedulePort | undefined
  const commandRuntime = ctx.reflect.get('commands', false) as Parameters<typeof commandSurface>[0] | undefined
  const commands = commandSurface(
    commandRuntime ?? {
      list: () => [],
      execute: async () => undefined,
    },
    agent,
  )

  return {
    ctx,
    schedule: resolvedSchedule ?? absentSchedule(),
    hasScheduleService: resolvedSchedule !== undefined,
    agent,
    cwd,
    storageRoot,
    commands,
    toolNames: registered,
    warnings,
    pluginState: () => (fiber as unknown as { state: number }).state,
    scheduleDoubleSize: () => {
      const candidate = options.scheduleDouble as unknown as { size?: number } | undefined
      if (candidate === undefined || typeof candidate.size !== 'number') {
        throw new Error('no schedule double is installed')
      }
      return candidate.size
    },
    emitTurnStopping: (target: unknown) => {
      const emitter = ctx as unknown as { emit: (event: string, payload: unknown) => void }
      emitter.emit('agent/turn-stopping', {
        agent: target,
        turn: 1,
        signal: new AbortController().signal,
      })
    },
    failNextDelivery: (message = 'the delivery channel is closed') => {
      agent.failNextSend = message
    },
    callerAgent: () => agent,
    caller: (overrides = {}) => {
      // A caller *view* of the same agent, not a shallow copy: spreading a class
      // instance drops its prototype methods, which would hide a detached-call
      // bug (`followup` missing) behind a passing test. `Object.create` keeps
      // every prototype method reachable while `id`/`session` are shadowed.
      const view = Object.create(agent) as StubAgent & {
        id: string
        session: {
          readonly id: string
          readonly header: { id?: string; cwd?: string; origin?: string }
          readonly append: (type: string, data: unknown) => void
        }
      }
      const sessionId = overrides.sessionId ?? agent.id
      Object.defineProperty(view, 'id', { value: sessionId, enumerable: true })
      Object.defineProperty(view, 'session', {
        value: {
          ...agent.session,
          id: sessionId,
          header: {
            cwd: overrides.cwd ?? cwd,
            ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
          },
        },
        enumerable: true,
      })
      return view
    },
    rawToolRuntime: () => {
      if (toolRuntime === undefined) throw new Error('the tool registry was not mounted')
      return toolRuntime
    },
    waitForRecord: async (id, predicate, timeoutMs = 10000) => {
      const schedule = resolvedSchedule ?? absentSchedule()
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const records = await schedule.list({ sessionId: sessionId as never })
        const found = (records as readonly ScheduleRecordLike[]).find((entry) => entry.id === id)
        if (found !== undefined && predicate(found)) return found
        if (Date.now() > deadline) {
          throw new Error(`record ${id} did not satisfy the predicate within ${timeoutMs}ms`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
    dispose: async () => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      const schedule = resolvedSchedule ?? absentSchedule()
      try {
        const list = await schedule.list({ sessionId: sessionId as never })
        for (const record of list) {
          await schedule.delete({ sessionId: sessionId as never, id: record.id })
        }
      } catch {
        // A missing record at teardown is fine.
      }
      await fiber.dispose()
      if (toolRuntime !== undefined && originalRegister !== undefined) toolRuntime.register = originalRegister
      if (scheduleFiber !== undefined) await scheduleFiber.dispose()
      await domainFiber.dispose()
      await jsonFiber.dispose()
      await storageFiber.dispose()
      await agentsFiber.dispose()
      if (commandsFiber !== undefined) await commandsFiber.dispose()
      await toolsFiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
