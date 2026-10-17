/**
 * The capsule's live path, against the real host.
 *
 * This suite answers the part of the live gate that does not need a browser:
 * it mounts the real `@deepseek-ai/dsh-session-projection` registry, the real
 * command runtime, the real tool registry and the real loop plugin (only
 * `ctx.schedule` is the in-memory double, because a real delivery cannot be made
 * faster than a minute), and then drives the *same* two things the page drives:
 *
 *  - the projection the capsule reads — through the client's own
 *    `ProjectionValueStore`, fed the way the Host feeds a connected client
 *    (`apply(key, value, seq)`), and
 *  - the verbs the buttons call — through the shipped `runLoopVerb`, whose call
 *    shape is the generated Remote's `commands.execute(sessionId, line, [])`,
 *    bound to the host's real `CommandRuntime.execute`.
 *
 * Both origins are covered: a human `/loop` run and a model `loop_start` call.
 * @module cordis-plugin-loop/test/client-live-path
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { bootHost } from './harness.ts'
import { FakeSchedule } from './fake-schedule.ts'

/**
 * The client-side projection face, reduced to what `useProjection` resolves.
 *
 * The page's own store (`ProjectionValueStore`) is browser-only: it ships inside
 * the Web bundle's module table and is not exported for a Node process to
 * import. This stand-in therefore reproduces the *contract the capsule depends
 * on* — a key-addressed face whose snapshot changes reference exactly when a
 * whole value lands — and is fed the real host value the same way a frame feeds
 * the page (`apply(key, value, seq)`). Anything the page's store does beyond
 * that (seq arbitration, cached rows) cannot change which value the capsule
 * reads here, because this test writes every value itself.
 */
class ClientProjectionFace {
  private value: unknown
  private readonly listeners = new Set<() => void>()

  /**
   * Apply one whole value for a key, as a Host frame would.
   *
   * @param key - Projection key.
   * @param next - The whole value.
   * @returns Whether the stored reference changed.
   */
  apply(key: string, next: unknown): boolean {
    if (key !== 'loop') return false
    if (Object.is(this.value, next)) return false
    this.value = next
    for (const listener of this.listeners) listener()
    return true
  }

  /**
   * The identity-stable face the framework hook binds.
   *
   * @returns The face.
   */
  faceOf(key: string): { getSnapshot(): unknown; subscribe(listener: () => void): () => void } {
    if (key !== 'loop') throw new Error(`unexpected projection key "${key}"`)
    return {
      getSnapshot: () => this.value,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
    }
  }
}

/** Absolute path of the browser half under test. */
const CLIENT_PATH = join(import.meta.dirname, '..', 'client.js')

/** The capsule reading the browser half derives. */
interface CapsuleReading {
  readonly visible: boolean
  readonly cadenceText?: string
  readonly countdown?: string
  readonly clock?: string
  readonly roundText?: string
  readonly starterText?: string
}

/** The `loop` projection value as it crosses the wire. */
interface LoopView {
  readonly active: boolean
  readonly mode: string
  readonly cadence: string
  readonly nextAt: string | null
  readonly round: number
  readonly startedBy: string
}

/** What the client half publishes for its own test suite. */
interface HelpersNamespace {
  readonly capsuleStateOf: (view: LoopView | undefined, nowMs: number, t: Translate) => CapsuleReading
  readonly runLoopVerb: (commands: unknown, verb: string, sessionId: string) => Promise<unknown>
  readonly outcomeTextOf: (result: unknown, line: string, t: Translate) => string | undefined
  readonly zh: Record<string, string>
}

/** Translate function shape. */
type Translate = (key: string, vars?: Record<string, string>) => string

/**
 * Evaluate the shipped browser half once and read the helpers it publishes.
 *
 * `client.js` is a classic script with no module exports; this is the same
 * loader contract the page uses, without a page.
 *
 * @returns The helper namespace.
 */
function loadHelpers(): HelpersNamespace {
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = globals.__ModuleLoader__
  globals.__ModuleLoader__ = {
    load(registration: { id: string }): void {
      assert.equal(registration.id, '@xinvxueyuan/cordis-plugin-loop')
    },
  }
  try {
    // eslint-disable-next-line no-new-func -- the unit is a classic script
    new Function(readFileSync(CLIENT_PATH, 'utf8'))()
  } finally {
    if (previous === undefined) delete globals.__ModuleLoader__
    else globals.__ModuleLoader__ = previous
  }
  const helpers = (globalThis as unknown as { __dshLoopClient?: HelpersNamespace }).__dshLoopClient
  assert.notEqual(helpers, undefined)
  return helpers!
}

/**
 * A translate function over one dictionary, mirroring the framework lookup.
 *
 * @param dict - The dictionary to read.
 * @returns The translate function.
 */
function translator(dict: Record<string, string>): Translate {
  return (key, vars) => {
    const text = dict[key]
    if (text === undefined) return key
    if (vars === undefined) return text
    return text.replace(/\{(\w+)\}/gu, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
    )
  }
}

/** One event the projected session holds. */
interface ProbeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * The minimum of a live `Session` the projection registry reads.
 *
 * The registry reaches a session only through `header`, `inheritedEventCount`,
 * `seq`, `snapshotEvents()` and `eventAt()`, so this probe supplies those five
 * members and publishes on the same context the registry listens on.
 */
class ProbeSession {
  /** The real header carries the session id; the loop cell binds by it. */
  readonly header = { id: 'capsule-live', cwd: process.cwd() }
  readonly inheritedEventCount = 0
  private readonly log: ProbeEvent[] = []

  /** Next event sequence number. */
  get seq(): number {
    return this.log.length
  }

  /**
   * Append one event.
   *
   * @param type - Event type.
   * @returns The appended event.
   */
  append(type: string): ProbeEvent {
    const event: ProbeEvent = { type, seq: this.log.length, time: Date.now(), data: {} }
    this.log.push(event)
    return event
  }

  /**
   * Materialize a frozen slice of the log.
   *
   * @param fromSeq - First sequence to include.
   * @param toSeqExclusive - Exclusive upper bound.
   * @returns The slice.
   */
  snapshotEvents(fromSeq = 0, toSeqExclusive?: number): readonly ProbeEvent[] {
    const end = toSeqExclusive === undefined ? this.log.length : toSeqExclusive
    return Object.freeze(this.log.slice(fromSeq, end))
  }

  /**
   * Read one event by position.
   *
   * @param seq - Sequence to read.
   * @returns The event, or undefined.
   */
  eventAt(seq: number): ProbeEvent | undefined {
    return this.log[seq]
  }
}

describe('the capsule against the real host', () => {
  it('reads the same loop the host serves, starts, nexts and stops it for both origins', async () => {
    const helpers = loadHelpers()
    const t = translator(helpers.zh)
    const double = new FakeSchedule()
    const ctx = new Context()
    const registryFiber = (
      ctx as unknown as { plugin(plugin: unknown): { await(): Promise<unknown>; dispose(): Promise<void> } }
    ).plugin(SessionProjectionRegistry)
    await registryFiber.await()
    const host = await bootHost({ sessionId: 'capsule-live', scheduleDouble: double, ctx })
    try {
      const registry = (ctx as unknown as { sessionProjections: SessionProjectionRegistry }).sessionProjections
      const session = new ProbeSession()
      const asSession = session as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
      const emitRaw = (ctx as unknown as { emit(event: string, ...payload: unknown[]): void }).emit.bind(ctx)
      // The unit is registered on `agent/created`, which `bootHost` already
      // emitted, so announcing the session materializes its cell.
      emitRaw('session/created', session)

      /** One client-side projection face, the capsule's actual read face. */
      const store = new ClientProjectionFace()
      const face = store.faceOf('loop')
      const row = (): LoopView => registry.snapshot(asSession, ['loop']).values.loop as LoopView
      /** Push what the Host serves into the client face, as a frame would. */
      const sync = (): LoopView => {
        store.apply('loop', row())
        return row()
      }
      /** The capsule's reading, from the client-visible value only. */
      const reading = (): CapsuleReading =>
        helpers.capsuleStateOf(face.getSnapshot() as LoopView | undefined, Date.now(), t)

      // --- 1. no loop: the capsule hides -------------------------------------
      sync()
      assert.equal(reading().visible, false, 'no loop must render no capsule')

      // --- 2. a human-started loop (the /loop path) --------------------------
      const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
      assert.equal(started.kind, 'success', started.text)
      const userView = sync()
      assert.deepEqual(userView, {
        active: true,
        mode: 'fixed',
        cadence: 'every 10 minutes',
        nextAt: double.all()[0]!.scheduledAt,
        // The round number the reminder names: the loop is on round 1.
        round: 1,
        startedBy: 'user',
      })
      const userReading = reading()
      assert.equal(userReading.visible, true)
      assert.match(String(userReading.cadenceText), /^固定 · every 10 minutes$/u)
      assert.equal(userReading.starterText, '你发起')
      assert.equal(userReading.roundText, '第 1 轮')
      assert.match(String(userReading.countdown), /^下一轮 · /u)

      // --- 3. the same value the human status command prints -----------------
      const status = await host.commands.run('loop', host.caller(), 'status')
      assert.match(String(status.text), /every 10 minutes/u)
      assert.match(String(status.text), /started by: user/u)

      // --- 4. a model-started loop (the loop_start path) ---------------------
      const toolResult = await host.rawToolRuntime().execute({
        callId: 'capsule-loop-start' as never,
        name: 'loop_start',
        arguments: { task: 'watch the deploy', cadence: 'self' },
        agent: host.caller() as never,
        signal: new AbortController().signal,
      })
      const toolText = ((toolResult as { content?: { type: string; text?: string }[] }).content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      assert.match(toolText, /Started/u)
      const agentView = sync()
      assert.equal(agentView.startedBy, 'agent')
      assert.equal(agentView.mode, 'self')
      assert.equal(agentView.cadence, 'self-paced')
      const agentReading = reading()
      assert.equal(agentReading.starterText, '模型发起')
      assert.match(String(agentReading.cadenceText), /^自定 · /u)
      assert.equal(agentReading.roundText, '第 1 轮')

      // --- 5. the next-round button, through the shipped Remote call shape ---
      // Both loops are live here, which is exactly the case `stop all` and a
      // per-session stop have to differ on; the next verb re-anchors the newest.
      const nextResult = await helpers.runLoopVerb(
        { execute: (...args: unknown[]) => realExecute(args[0], args[1], args[2]) },
        'next',
        'capsule-live',
      )
      assert.equal((nextResult as { ok: boolean }).ok, true)
      const nextText = helpers.outcomeTextOf(nextResult, '/loop next', t)
      assert.equal(typeof nextText, 'string')
      assert.doesNotMatch(String(nextText), /not registered|Not connected/u)
      emitRaw('session/event', session, session.append('turn/start'))
      const afterNext = sync()
      assert.equal(afterNext.round, 2, 'the pressed round is counted, so the session is on round 2')
      assert.equal(reading().roundText, '第 2 轮')
      assert.match(String(reading().countdown), /^下一轮 · /u)

      // --- 6. the stop button: storage empty, then no delivery at all --------
      const stopped = await helpers.runLoopVerb(
        { execute: (...args: unknown[]) => realExecute(args[0], args[1], args[2]) },
        'stop',
        'capsule-live',
      )
      assert.equal((stopped as { ok: boolean }).ok, true)
      const stopText = helpers.outcomeTextOf(stopped, '/loop stop', t)
      assert.match(String(stopText), /Stopped \d+ loop/u)
      assert.equal(double.size, 0, 'stop must clear the storage')
      const afterStop = sync()
      assert.equal(afterStop.active, false)
      assert.equal(reading().visible, false, 'a stopped loop must hide the capsule')
      const deliveredBefore = double.all().length
      assert.equal(deliveredBefore, 0, 'a stopped loop leaves no armed record behind')
    } finally {
      await host.dispose()
    }

    /**
     * The host's real command entry point, bound exactly as the Remote carrier
     * binds it: the page passes a session id and a full command line.
     *
     * @param sessionId - Session whose command surface receives the line.
     * @param line - Complete slash-command line.
     * @param attachments - Submitted attachments; the capsule sends none.
     * @returns The Remote result the client half unwraps.
     */
    async function realExecute(sessionId: unknown, line: unknown, attachments: unknown): Promise<unknown> {
      const runtime = (
        ctx as unknown as {
          commands: {
            execute(
              agent: unknown,
              line: string,
              submitted: readonly unknown[],
              signal: AbortSignal,
            ): Promise<{ result: { kind: string; text?: string } } | undefined>
          }
        }
      ).commands
      const agent = host.caller({ sessionId: String(sessionId) })
      const execution = await runtime.execute(
        agent,
        String(line),
        (attachments ?? []) as readonly unknown[],
        new AbortController().signal,
      )
      return execution === undefined ? { ok: true, value: undefined } : { ok: true, value: execution }
    }
  })

  it('reports a stop honestly when no loop is active', async () => {
    const helpers = loadHelpers()
    const t = translator(helpers.zh)
    const double = new FakeSchedule()
    const ctx = new Context()
    const registryFiber = (
      ctx as unknown as { plugin(plugin: unknown): { await(): Promise<unknown>; dispose(): Promise<void> } }
    ).plugin(SessionProjectionRegistry)
    await registryFiber.await()
    const host = await bootHost({ sessionId: 'capsule-empty', scheduleDouble: double, ctx })
    try {
      const runtime = (ctx as unknown as { commands: { execute: unknown } }).commands
      const result = await helpers.runLoopVerb(
        {
          execute: async (sessionId: unknown, line: unknown, attachments: unknown) => {
            const execution = await (
              runtime as {
                execute(
                  agent: unknown,
                  line: string,
                  submitted: readonly unknown[],
                  signal: AbortSignal,
                ): Promise<{ result: { kind: string; text?: string } } | undefined>
              }
            ).execute(
              host.caller({ sessionId: String(sessionId) }),
              String(line),
              (attachments ?? []) as readonly unknown[],
              new AbortController().signal,
            )
            return execution === undefined ? { ok: true, value: undefined } : { ok: true, value: execution }
          },
        },
        'stop',
        'capsule-empty',
      )
      const text = helpers.outcomeTextOf(result, '/loop stop', t)
      assert.equal(typeof text, 'string')
      assert.equal(String(text), 'No loop is active in this session; nothing to stop.')
      assert.equal(double.size, 0)
    } finally {
      await host.dispose()
    }
  })
})


/**
 * What this case asserts, and why it is not a key count.
 *
 * The dictionary's *size* is not a contract: the handover note that claimed "21
 * keys" was wrong twice over (the real counts were 18, and 17 after the dead
 * `state.notDelivered` entry was removed), and a suite that pins the total goes
 * red for adding or dropping a key while saying nothing about whether the
 * dictionary is correct — which is precisely how it deadlocked the dead-key
 * repair. The contract that does not rot is the pair of invariants this case
 * enforces instead:
 *
 *  1. the two locales carry exactly the same key set; and
 *  2. every registered key is read somewhere in the bundle (F7's semantic — a
 *     dead key is a translation nobody looks up), with no read of a key the
 *     dictionary does not carry.
 */
describe('the registered dictionary stays consistent', () => {
  it('hands the framework the same key set in both locales, with every key actually read', () => {
    const globals = globalThis as unknown as Record<string, unknown>
    const previous = globals.__ModuleLoader__
    let captured: { ns: string; table: { zh?: Record<string, string>; en?: Record<string, string> } } | undefined
    let injected: string[] = []
    globals.__ModuleLoader__ = {
      load(registration: {
        id: string
        factory(require: (name: string) => unknown): { inject?: unknown; apply(ctx: unknown): unknown }
      }) {
        const exports = registration.factory((name: string) => {
          if (name === 'react') return { createElement: () => undefined, Fragment: () => undefined, useEffect: () => undefined, useState: () => [undefined, () => undefined], useSyncExternalStore: () => undefined, useCallback: (fn: unknown) => fn }
          throw new Error(`the bundle must not require ${name}`)
        })
        const ctx = {
          effect: (fn: () => unknown) => {
            fn()
            return () => undefined
          },
          slots: {
            inject: (name: string, fn: () => unknown) => {
              injected = [...injected, name]
              fn()
              return () => undefined
            },
            register: () => () => undefined,
          },
          locale: {
            register: (ns: string, table: { zh?: Record<string, string>; en?: Record<string, string> }) => {
              captured = { ns, table }
              return () => undefined
            },
          },
          logger: { warn: () => undefined, info: () => undefined },
          remote: { commands: { execute: async () => undefined } },
        }
        exports.apply(ctx)
      },
    }
    try {
      const source = readFileSync(CLIENT_PATH, 'utf8')
      // eslint-disable-next-line no-new-func -- the unit is a classic script
      new Function(source)()
    } finally {
      globals.__ModuleLoader__ = previous
    }
    assert.ok(captured !== undefined, 'the bundle must register its dictionaries')
    assert.equal(captured.ns, 'loop')
    assert.deepEqual(injected, ['conversation.input.dock'], 'the dock seat is claimed through slots.inject')

    const zhKeys = Object.keys(captured.table.zh ?? {})
    const enKeys = Object.keys(captured.table.en ?? {})
    // ① Same key set in both locales — the only size rule, and a relative one.
    assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'both locales must carry exactly the same key set')
    assert.ok(zhKeys.length > 0, 'the dictionary must carry at least one key')
    for (const key of zhKeys) {
      assert.equal(typeof captured.table.zh?.[key], 'string', `${key} must have a zh string`)
      assert.equal(typeof captured.table.en?.[key], 'string', `${key} must have an en string`)
    }

    // The scan recognizes a dictionary key as a namespace-qualified quoted
    // literal in one of this bundle's namespaces, which covers every spelling it
    // uses (`t('capsule.round', …)`, a ternary arm, a lookup passed a variable).
    // The namespace list keeps unrelated dotted literals — the dock seat's own
    // `'conversation.input.dock'`, for one — out of the account.
    const namespaces = new Set(zhKeys.map((key) => key.split('.')[0]!))
    const source = readFileSync(CLIENT_PATH, 'utf8')
    const lines = source.split('\n')
    const references = new Map<string, number[]>()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      for (const match of line.matchAll(/'([^']*)'/gu)) {
        const key = match[1]!
        const head = key.split('.')[0]!
        if (!namespaces.has(head) || !key.includes('.')) continue
        const seen = references.get(key)
        if (seen === undefined) references.set(key, [index + 1])
        else seen.push(index + 1)
      }
    }
    /**
     * A dictionary entry *defines* its key: the line opens with `'key':`.
     *
     * The anchor matters — a read site can sit on a line that also carries a
     * colon (a ternary arm inside a `t(...)` call, for one), so a bare
     * `'key'\s*:` search would mistake a read for a definition and report the
     * key as dead.
     */
    const defining = (line: string, key: string): boolean =>
      new RegExp(`^\\s*'${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'\\s*:`, 'u').test(line)
    const reads = (key: string): boolean =>
      (references.get(key) ?? []).some((lineNumber) => !defining(lines[lineNumber - 1] ?? '', key))
    const unread = zhKeys.filter((key) => !reads(key))
    assert.deepEqual(unread, [], `every dictionary key must be read by the bundle; unread: ${unread.join(', ')}`)
    const registered = new Set(zhKeys)
    const strays = [...references.keys()].filter((key) => !registered.has(key) && reads(key))
    assert.deepEqual(strays, [], `the bundle must not look up keys the dictionary does not carry; strays: ${strays.join(', ')}`)
  })
})
