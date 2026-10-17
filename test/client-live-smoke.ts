/**
 * Live probe: what the control capsule reads and what its two buttons do,
 * printed as raw JSON for the release gate.
 *
 * This is the evidence path of `test/client-live-path.test.ts`: it mounts the
 * real `@deepseek-ai/dsh-session-projection` registry, the real command runtime,
 * the real tool registry and the real loop plugin (only `ctx.schedule` is the
 * in-memory double, because a real delivery cannot be made faster than one
 * minute), then prints, for a human-started and a model-started loop:
 *
 *  - the value the Host serves for the `loop` projection,
 *  - the reading the shipped `client.js` derives from it (cadence, countdown,
 *    round, originator, hidden-when-inactive),
 *  - the raw outcome of the exact Remote call each button issues.
 *
 * Run: node test/client-live-smoke.ts
 * @module cordis-plugin-loop/test/client-live-smoke
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { bootHost } from './harness.ts'
import { FakeSchedule } from './fake-schedule.ts'

/** A `loop` projection value as it crosses the wire. */
interface LoopView {
  readonly active: boolean
  readonly mode: string
  readonly cadence: string
  readonly nextAt: string | null
  readonly round: number
  readonly startedBy: string
}

/** The reading the browser half derives from one projection value. */
interface CapsuleReading {
  readonly visible: boolean
  readonly cadenceText?: string
  readonly countdown?: string
  readonly clock?: string
  readonly roundText?: string
  readonly starterText?: string
}

/** What the browser half publishes for its own test suite. */
interface Helpers {
  readonly capsuleStateOf: (view: LoopView | undefined, nowMs: number, t: Translate) => CapsuleReading
  readonly runLoopVerb: (commands: unknown, verb: string, sessionId: string) => Promise<unknown>
  readonly outcomeTextOf: (result: unknown, line: string, t: Translate) => string | undefined
  readonly zh: Record<string, string>
}

/** Translate shape. */
type Translate = (key: string, vars?: Record<string, string>) => string

/** One event the projected session holds. */
interface ProbeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** The minimum of a live `Session` the projection registry reads. */
class ProbeSession {
  readonly header = { id: 'capsule-smoke', cwd: process.cwd() }
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

const line = (label: string, value: unknown): void => {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`)
}

const here = import.meta.dirname
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')
const pendingRegistrations: { id: string }[] = []
;(globalThis as unknown as Record<string, unknown>).__ModuleLoader__ = {
  load: (registration: { id: string }) => pendingRegistrations.push(registration),
}
// eslint-disable-next-line no-new-func -- the browser half is a classic script
new Function(clientSource)()
console.log(`client.js registered: ${JSON.stringify(pendingRegistrations.map((entry) => entry.id))}`)
const helpers = (globalThis as unknown as { __dshLoopClient?: Helpers }).__dshLoopClient!
const t: Translate = (key, vars) => {
  const text = helpers.zh[key] ?? key
  if (vars === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  )
}

const double = new FakeSchedule()
const ctx = new Context()
const registryFiber = (
  ctx as unknown as { plugin(plugin: unknown): { await(): Promise<unknown>; dispose(): Promise<void> } }
).plugin(SessionProjectionRegistry)
await registryFiber.await()
const host = await bootHost({ sessionId: 'capsule-smoke', scheduleDouble: double, ctx })
const registry = (ctx as unknown as { sessionProjections: SessionProjectionRegistry }).sessionProjections
const session = new ProbeSession()
const asSession = session as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
const emitRaw = (ctx as unknown as { emit(event: string, ...payload: unknown[]): void }).emit.bind(ctx)
emitRaw('session/created', session)

/** The value the Host serves for the `loop` key right now. */
const served = (): LoopView => registry.snapshot(asSession, ['loop']).values.loop as LoopView
/** The capsule's reading of the value a client would hold. */
const reading = (): CapsuleReading => helpers.capsuleStateOf(served(), Date.now(), t)

/** The host's real command entry point, bound as the Remote carrier binds it. */
async function remoteExecute(sessionId: string, line_: string, attachments: readonly unknown[]): Promise<unknown> {
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
  const execution = await runtime.execute(
    host.caller({ sessionId }),
    line_,
    attachments,
    new AbortController().signal,
  )
  return execution === undefined ? { ok: true, value: undefined } : { ok: true, value: execution }
}
/** The `remote` face the capsule's entry injects. */
const commands = { execute: remoteExecute }

try {
  console.log('\n=== 1. no loop: the capsule must hide ===')
  line('served projection', served())
  line('capsule reading', reading())

  console.log('\n=== 2. a human runs /loop 10m check the build ===')
  console.log((await host.commands.run('loop', host.caller(), ' 10m check the build')).text)
  line('served projection', served())
  line('capsule reading', reading())

  console.log('\n=== 3. the model runs loop_start (self-paced) ===')
  const toolResult = await host.rawToolRuntime().execute({
    callId: 'smoke-loop-start' as never,
    name: 'loop_start',
    arguments: { task: 'watch the deploy', cadence: 'self' },
    agent: host.caller() as never,
    signal: new AbortController().signal,
  })
  console.log(
    ((toolResult as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(''),
  )
  line('served projection', served())
  line('capsule reading', reading())

  console.log('\n=== 4. the "run next round now" button ===')
  const nextResult = await helpers.runLoopVerb(commands, 'next', 'capsule-smoke')
  line('raw Remote result', nextResult)
  line('status line the capsule shows', helpers.outcomeTextOf(nextResult, '/loop next', t))
  emitRaw('session/event', session, session.append('turn/start'))
  line('served projection after the round', served())
  line('capsule reading after the round', reading())

  console.log('\n=== 5. the stop button ===')
  const stopResult = await helpers.runLoopVerb(commands, 'stop', 'capsule-smoke')
  line('raw Remote result', stopResult)
  line('status line the capsule shows', helpers.outcomeTextOf(stopResult, '/loop stop', t))
  line('served projection after the stop', served())
  line('capsule reading after the stop', reading())
  line('armed schedule rows', double.size)

  console.log('\n=== 6. the stop button with no loop (honest failure) ===')
  const emptyResult = await helpers.runLoopVerb(commands, 'stop', 'capsule-smoke')
  line('raw Remote result', emptyResult)
  line('status line the capsule shows', helpers.outcomeTextOf(emptyResult, '/loop stop', t))

  assert.equal(reading().visible, false)
  console.log('\nCLIENT LIVE SMOKE OK')
} finally {
  await host.dispose()
}
