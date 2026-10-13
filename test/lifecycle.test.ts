/**
 * Loop lifecycle: self-paced continuation, the omission safety net, expiry, and
 * the containment that keeps the guard out of turn teardown.
 * @module cordis-plugin-loop/test/lifecycle
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoopEngine } from '../src/engine.ts'
import { createQueue, handleTurnStopping, runLoopCommand, runLoopNext, runLoopStop, type Caller, type RegistryDeps } from '../src/registry.ts'
import { decodeLoopRecord } from '../src/state.ts'
import { DEFAULT_CONFIG, type LoopConfig } from '../src/config.ts'
import { FakeSchedule } from './fake-schedule.ts'
import { bootHost } from './harness.ts'

/** One assembled lifecycle surface with a movable clock. */
interface Rig {
  /** Registry dependencies. */
  readonly deps: RegistryDeps
  /** Serial queue. */
  readonly enqueue: ReturnType<typeof createQueue>
  /** The schedule double. */
  readonly schedule: FakeSchedule
  /** The engine under test. */
  readonly engine: LoopEngine
  /** The movable clock. */
  readonly clock: { now: number }
  /** Everything the loop plugin sent to the session. */
  readonly sent: string[]
  /** Everything the plugin logged. */
  readonly logs: string[]
  /** The caller these surfaces run as. */
  readonly caller: Caller
}

/** Build one rig. */
function rig(config: Partial<LoopConfig> = {}): Rig {
  const schedule = new FakeSchedule()
  const clock = { now: schedule.now }
  // One clock for the engine and the double, so row targets and deadlines agree.
  schedule.external = () => clock.now
  const sent: string[] = []
  const logs: string[] = []
  const effective: LoopConfig = { ...DEFAULT_CONFIG, ...config }
  const engine = new LoopEngine({
    config: effective,
    schedule,
    timeZone: 'Asia/Shanghai',
    logger: { warn: (message) => logs.push(message), info: (message) => logs.push(message) },
    now: () => clock.now,
  })
  const deps: RegistryDeps = { config: effective, engine, env: {}, killSwitch: () => false }
  return {
    deps,
    enqueue: createQueue(),
    schedule,
    engine,
    clock,
    sent,
    logs,
    caller: {
      sessionId: 'session-a',
      cwd: process.cwd(),
      isSubagent: false,
      send: (text) => sent.push(text),
    },
  }
}

test('a self-paced loop arms the safety check first and loop_next replaces the same record', async () => {
  const bench = rig()
  const started = await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  assert.equal(started.ok, true, started.text)
  const first = bench.schedule.all()[0]!
  assert.equal(bench.schedule.createCalls, 1)
  // A recurring record, because a fired one-shot turns inactive and then
  // rejects `update` with schedule_ended — it could never be re-armed.
  assert.equal(first.kind, 'every')
  assert.equal(first.everySeconds, 30 * 60)
  assert.equal(Date.parse(first.scheduledAt) - bench.clock.now, 30 * 60 * 1000, 'the safety check is 30 minutes')

  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(first.id)
  const next = await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: 'nothing changed' }, bench.enqueue)
  assert.equal(next.ok, true, next.text)
  assert.equal(bench.schedule.size, 1, 'loop_next must not create a second record')
  assert.equal(bench.schedule.createCalls, 1, 'the session must still own exactly one record')
  assert.equal(bench.schedule.updateCalls, 1)
  assert.equal(bench.schedule.all()[0]!.id, first.id, 'the id is preserved')
  assert.equal(bench.schedule.all()[0]!.everySeconds, 300)
  assert.equal(Date.parse(bench.schedule.all()[0]!.scheduledAt) - bench.clock.now, 5 * 60 * 1000)
  const decoded = decodeLoopRecord(bench.schedule.all()[0]!)
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.iteration, 1)
  assert.equal(decoded.state.quietStreak, 0)
  assert.equal(decoded.state.omissions, 0)
  assert.equal(decoded.state.cadenceSeconds, 300, 'the header tracks the armed wait')
  assert.match(bench.schedule.all()[0]!.prompt, /"round":2/u)
  assert.match(bench.schedule.all()[0]!.prompt, /"iteration":1/u)
})

test('loop_next marks a quiet round and the streak travels to the next framework', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(bench.schedule.all()[0]!.id)
  const first = await runLoopNext(bench.deps, bench.caller, { seconds: 120, reason: 'quiet', quiet: true }, bench.enqueue)
  assert.equal(first.ok, true, first.text)
  bench.clock.now += 120 * 1000
  bench.schedule.deliver(bench.schedule.all()[0]!.id)
  const second = await runLoopNext(bench.deps, bench.caller, { seconds: 120, reason: 'still quiet', quiet: true }, bench.enqueue)
  assert.equal(second.ok, true, second.text)
  const decoded = decodeLoopRecord(bench.schedule.all()[0]!)
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.quietStreak, 2)
  assert.match(bench.schedule.all()[0]!.prompt, /"quietStreak":2/u)
  assert.match(bench.schedule.all()[0]!.prompt, /"round":3/u)
  const louder = await runLoopNext(bench.deps, bench.caller, { seconds: 120, reason: 'something happened' }, bench.enqueue)
  assert.equal(louder.ok, true, louder.text)
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.quietStreak, 0, 'a non-quiet round resets the streak')
})

test('loop_next refuses a fixed-cadence loop and an out-of-window wait', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  const fixed = await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: 'nope' }, bench.enqueue)
  assert.equal(fixed.ok, false)
  assert.match(fixed.text, /fixed cadence/u)

  const self = rig()
  await runLoopCommand(self.deps, self.caller, 'watch the queue', self.enqueue)
  for (const seconds of [59, 3601, 0, -10, 3.5]) {
    const result = await runLoopNext(self.deps, self.caller, { seconds, reason: 'x' }, self.enqueue)
    assert.equal(result.ok, false, `${seconds}s must be refused`)
  }
  assert.match((await runLoopNext(self.deps, self.caller, { seconds: 30, reason: 'x' }, self.enqueue)).text, /between 60 and 3600/u)
})

test('loop_next in a session without a loop reports that clearly', async () => {
  const bench = rig()
  const result = await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: 'x' }, bench.enqueue)
  assert.equal(result.ok, false)
  assert.match(result.text, /There is no loop in this session/u)
})

test('the first omission arms a 20-minute check that says the previous round was not continued', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(id)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'armed a 20-minute omission guard for 1')
  assert.equal(bench.schedule.size, 1, 'the loop survives its first omission')
  const record = bench.schedule.all()[0]!
  assert.equal(record.id, id)
  assert.equal(Date.parse(record.scheduledAt) - bench.clock.now, 20 * 60 * 1000)
  assert.match(record.prompt, /WARNING: the previous round of this loop ended without a continuation/u)
  assert.match(record.prompt, /omission 1 of 2/u)
  assert.match(record.prompt, /Either continue with loop_next, or end it explicitly with loop_stop/u)
  const decoded = decodeLoopRecord(record)
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.omissions, 1)
  assert.equal(decoded.state.iteration, 0, 'an omission is not a round')
  assert.equal(bench.sent.length, 1, 'the first omission adds no message beyond round one')
})

test('a second omission stops the loop and tells the session', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(id)
  await handleTurnStopping(bench.deps, bench.caller)
  bench.clock.now += 20 * 60 * 1000
  bench.schedule.deliver(id)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'stopped after a second omission (1)')
  assert.equal(bench.schedule.size, 0, 'the loop must be gone')
  assert.equal(bench.sent.length, 2, 'round one plus the final notice')
  assert.match(bench.sent[1]!, /not continued twice in a row, so it has been stopped and removed/u)
  assert.match(bench.sent[1]!, /Start a new loop with \/loop/u)
})

test('a continued round is not an omission, and the guard is not re-armed', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(id)
  await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: 'still watching' }, bench.enqueue)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, undefined)
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.omissions, 0)
})

test('a turn-stopping pass with no new delivery does nothing at all', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  assert.equal(await handleTurnStopping(bench.deps, bench.caller), undefined)
  assert.equal(bench.schedule.updateCalls, 0, 'no write happens without a new delivery')
  assert.equal(bench.schedule.deleteCalls, 0)
})

test('a delivery after the end of life runs one last round and then removes the loop', async () => {
  const bench = rig({ lifetimeDays: 7 })
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  assert.equal(bench.sent.length, 1, 'round one runs immediately')
  const start = bench.clock.now
  bench.clock.now = start + 7 * 86_400_000 + 1000
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'expired 1')
  assert.equal(bench.schedule.size, 0)
  assert.equal(bench.sent.length, 2)
  assert.match(bench.sent[1]!, /reached its end of life and has been removed/u)
  assert.match(bench.sent[1]!, /nothing is scheduled any more/u)
})

test('loop_next refuses to continue a loop past its end of life and removes it', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  bench.clock.now += 7 * 86_400_000 + 1000
  const result = await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: 'x' }, bench.enqueue)
  assert.equal(result.ok, false)
  assert.match(result.text, /reached its end of life \(.*\) and has been removed/u)
  assert.equal(bench.schedule.size, 0)
})

test('loop_stop removes the loop from the model side too', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const stopped = await runLoopStop(bench.deps, bench.caller, { reason: 'task is done' }, bench.enqueue)
  assert.equal(stopped.ok, true, stopped.text)
  assert.match(stopped.text, /Loop stopped \(1\)\. Reason: task is done/u)
  assert.equal(bench.schedule.size, 0)
  const again = await runLoopStop(bench.deps, bench.caller, { reason: 'again' }, bench.enqueue)
  assert.equal(again.ok, false)
  assert.match(again.text, /There is no loop in this session/u)
})

test('a history read failure never throws out of the guard', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(id)
  bench.schedule.breakHistory(id, true)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, undefined, 'a broken history read degrades to "nothing owed"')
  assert.equal(bench.schedule.size, 1, 'and must not remove the loop')
})

test('the composed plugin: a real turn-stopping dispatch drives the guard through the double', async () => {
  // A real recurring delivery cannot be made faster than the service minimum of
  // one minute, so this case wires the genuine plugin, the genuine tool
  // registry, and the genuine cordis dispatch to a deterministic schedule
  // double. `integration.test.ts` proves real delivery separately.
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'lifecycle',
    scheduleDouble: double,
    config: { omissionCheckSeconds: 1200 },
  })
  try {
    const loopAgent = host.caller()
    const started = await host.commands.run('loop', loopAgent, 'watch the queue')
    assert.equal(started.kind, 'success', started.text)
    const created = (await double.list({ sessionId: 'lifecycle' }))[0]!
    assert.equal(created.kind, 'every')
    double.deliver(created.id)
    const messagesBefore = host.agent.messages.length

    host.emitTurnStopping(loopAgent)
    const guarded = await host.waitForRecord(
      created.id,
      (record) => record.prompt.includes('WARNING: the previous round'),
      10000,
    )
    assert.equal(host.agent.messages.length, messagesBefore, 'a first omission sends no message')
    assert.match(guarded.prompt, /omission 1 of 2/u)
    assert.equal(guarded.everySeconds, 1200, 'the guard arms a 20-minute check')
    const decoded = decodeLoopRecord(guarded)
    assert.ok(decoded !== undefined)
    assert.equal(decoded.state.omissions, 1)
    assert.equal(decoded.state.iteration, 0)
    assert.equal(decoded.state.cadenceSeconds, 1200)

    // The second omission ends the loop for good and tells the session.
    double.deliver(created.id)
    host.emitTurnStopping(loopAgent)
    const deadline = Date.now() + 10000
    while (double.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(double.size, 0, 'the second omission must remove the loop')
    const final = host.agent.messages.at(-1)!
    assert.match(final.text, /not continued twice in a row, so it has been stopped and removed/u)
  } finally {
    await host.dispose()
  }
})
