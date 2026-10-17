/**
 * Live probe: the `loop` session projection served by the REAL registry.
 *
 * Exercises code path B (boundary-true): the real
 * `@deepseek-ai/dsh-session-projection` registry, the real cordis event drive,
 * a real projected session object, the real tool registry and the real
 * `/loop` command — only `ctx.schedule` is the in-memory double, because a real
 * schedule delivery cannot be made faster than one minute.
 *
 * Run: npx tsx test/projection-smoke.ts   (or: node --experimental-strip-types test/projection-smoke.ts)
 * @module cordis-plugin-loop/test/projection-smoke
 */
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { bootHost } from './harness.ts'
import { FakeSchedule } from './fake-schedule.ts'
import { LoopProjectionStore, loopProjectionDefinitionFor } from '../src/loop-projection.ts'

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
 * `seq`, `snapshotEvents()` and `eventAt()`. A real `Session` publishes
 * `session/event` only while a `SessionStore` has it attached, so this probe
 * supplies those five members and publishes on the same context the registry
 * listens on.
 */
class ProbeSession {
  readonly header = { id: 'projection-smoke', cwd: process.cwd() }
  readonly inheritedEventCount = 0
  private readonly log: ProbeEvent[] = []

  /** Next event sequence number (`seq = log.length`). */
  get seq(): number {
    return this.log.length
  }

  /** Append one event. */
  append(type: string, data: unknown = {}): ProbeEvent {
    const event: ProbeEvent = { type, seq: this.log.length, time: Date.now(), data }
    this.log.push(event)
    return event
  }

  /** Materialize a frozen slice of the log. */
  snapshotEvents(fromSeq = 0, toSeqExclusive?: number): readonly ProbeEvent[] {
    const end = toSeqExclusive === undefined ? this.log.length : toSeqExclusive
    return Object.freeze(this.log.slice(fromSeq, end))
  }

  /** Read one event by position. */
  eventAt(seq: number): ProbeEvent | undefined {
    return this.log[seq]
  }
}

const line = (label: string, value: unknown): void => {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`)
}

const double = new FakeSchedule()
const ctx = new Context()
const registryFiber = (
  ctx as unknown as { plugin(plugin: unknown): { await(): Promise<unknown>; dispose(): Promise<void> } }
).plugin(SessionProjectionRegistry)
await registryFiber.await()
const emitRaw = (ctx as unknown as { emit(event: string, ...payload: unknown[]): void }).emit.bind(ctx)

const host = await bootHost({ sessionId: 'projection-smoke', scheduleDouble: double, ctx })
const session = new ProbeSession()
const asSession = session as unknown as Parameters<InstanceType<typeof SessionProjectionRegistry>['stateOf']>[0]
const registry = (ctx as unknown as { sessionProjections: InstanceType<typeof SessionProjectionRegistry> })
  .sessionProjections

// The unit is registered on `agent/created`, which `bootHost` already emitted,
// so announcing the session materializes its cell with the live view installed.
emitRaw('session/created', session)
const drive = (type: string): void => {
  emitRaw('session/event', session, session.append(type))
}

const changes: unknown[] = []
registry.onChanged((_session, key, value) => changes.push({ key, value }))

console.log('=== 1. no loop yet ===')
line('stateOf(session, "loop")', registry.stateOf(asSession, 'loop'))
line('snapshot().values.loop', registry.snapshot(asSession, ['loop']).values.loop)

console.log('\n=== 2. /loop 10m check the build (user-started) ===')
const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
console.log(`command: ${started.kind}`)
line('snapshot().values.loop', registry.snapshot(asSession, ['loop']).values.loop)
drive('turn/start')
line('change feed after the drive', changes)

console.log('\n=== 3. loop_start (agent-started, self-paced) ===')
const restarted = await host.rawToolRuntime().execute({
  callId: 'probe-loop-start' as never,
  name: 'loop_start',
  arguments: { task: 'watch the deploy', cadence: 'self' },
  agent: host.caller() as never,
  signal: new AbortController().signal,
})
const startedText = ((restarted as { content?: { type: string; text?: string }[] }).content ?? [])
  .filter((block) => block.type === 'text')
  .map((block) => block.text ?? '')
  .join('')
console.log(startedText)
line('record header', double.all()[0]!.prompt.split('\n')[0])
line('snapshot().values.loop', registry.snapshot(asSession, ['loop']).values.loop)

console.log('\n=== 4. the delivered round, then /loop status ===')
double.deliver(double.all()[0]!.id)
const status = await host.commands.run('loop', host.caller(), 'status')
console.log(status.text)
line('snapshot().values.loop', registry.snapshot(asSession, ['loop']).values.loop)
drive('turn/start')
line('change feed (newest last)', changes.at(-1))
const afterMove = changes.length
drive('turn/start')
drive('turn/start')
console.log(
  `no-op drives: ${changes.length === afterMove ? 'no frame pushed (correct)' : `PUSHED ${changes.length - afterMove} spurious frame(s)`}`,
)

console.log('\n=== 4b. the served reference moves only when the loop does (T24) ===')
{
  // The registry pushes a client frame only when the wire view it computes differs
  // from the one it published last, so this identity rule is what makes a capsule
  // update without a page reload.
  const store = new LoopProjectionStore()
  const definition = loopProjectionDefinitionFor(store) as unknown as {
    init(header: unknown): unknown
    apply(state: unknown, event: unknown): unknown
    wire: { view(state: unknown): unknown }
  }
  const facts = (nextAt: string): Parameters<LoopProjectionStore['set']>[1] => ({
    id: 'smoke',
    nextAt,
    mode: 'fixed',
    cadenceLabel: 'every 10 minutes',
    round: 1,
    startedBy: 'user',
  })
  store.set('smoke', facts('2023-11-14T22:21:00.000Z'))
  let state = definition.init({ id: 'smoke' })
  const first = definition.wire.view(state)
  store.set('smoke', facts('2023-11-14T22:21:00.000Z'))
  state = definition.apply(state, {})
  const sameRepublication = definition.wire.view(state)
  store.set('smoke', facts('2023-11-14T22:22:00.000Z'))
  state = definition.apply(state, {})
  const moved = definition.wire.view(state)
  console.log(`no-op republication keeps the reference: ${sameRepublication === first ? 'yes (correct)' : 'NO'}`)
  console.log(`a moved loop hands out a new reference:   ${moved !== first ? 'yes (correct)' : 'NO'}`)
  line('served value after the move', moved)
}

console.log('\n=== 5. /loop next (the capsule button) ===')
const next = await host.commands.run('loop', host.caller(), 'next')
console.log(next.text)
line('snapshot().values.loop', registry.snapshot(asSession, ['loop']).values.loop)
line('rounds the session received', host.agent.messages.length)

console.log('\n=== 6. /loop stop ===')
const stopped = await host.commands.run('loop', host.caller(), 'stop')
console.log(stopped.text)
line('stateOf(session, "loop")', registry.stateOf(asSession, 'loop'))
line('snapshot().values.loop', registry.snapshot(asSession, ['loop']).values.loop)
drive('turn/start')
line('change feed (newest last)', changes.at(-1))
console.log(`total change-feed notifications: ${changes.length}`)

await host.dispose()
await registryFiber.dispose()
