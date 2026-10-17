/**
 * Loop lifecycle: self-paced continuation, the omission safety net, the round
 * cap, expiry, and the containment that keeps the guard out of turn teardown.
 * @module cordis-plugin-loop/test/lifecycle
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoopEngine } from '../src/engine.ts'
import { createQueue, handleTurnStopping, runLoopCommand, runLoopNext, runLoopStart, runLoopStop, type Caller, type LoopEvent, type RegistryDeps } from '../src/registry.ts'
import { decodeLoopRecord } from '../src/state.ts'
import { DEFAULT_CONFIG, type LoopConfig } from '../src/config.ts'
import { FakeSchedule } from './fake-schedule.ts'
import { bootHost } from './harness.ts'

/**
 * Run one `loop_start` tool call through the registry exactly as the tool does.
 *
 * @param bench - The rig to run against.
 * @param request - Validated tool arguments.
 * @returns The result to render.
 */
function runStartTool(
  bench: Rig,
  request: { task: string; cadence?: 'fixed' | 'self'; seconds?: number },
): Promise<{ ok: boolean; text: string }> {
  return runLoopStart(bench.deps, bench.caller, request, bench.enqueue)
}

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
  /** Every guard-rail event the registry reported. */
  readonly events: LoopEvent[]
  /** The caller these surfaces run as. */
  readonly caller: Caller
  /** The kill switch this rig's dependencies consult, so a test can flip it. */
  readonly killSwitch: { on: boolean }
}

/** Build one rig. */
function rig(config: Partial<LoopConfig> = {}): Rig {
  const schedule = new FakeSchedule()
  const clock = { now: schedule.now }
  // One clock for the engine and the double, so row targets and deadlines agree.
  schedule.external = () => clock.now
  const sent: string[] = []
  const logs: string[] = []
  const events: LoopEvent[] = []
  const killSwitch = { on: false }
  const effective: LoopConfig = { ...DEFAULT_CONFIG, ...config }
  const engine = new LoopEngine({
    config: effective,
    schedule,
    timeZone: 'Asia/Shanghai',
    logger: { warn: (message) => logs.push(message), info: (message) => logs.push(message) },
    now: () => clock.now,
  })
  const deps: RegistryDeps = {
    config: effective,
    engine,
    env: {},
    killSwitch: () => killSwitch.on,
    reportEvent: (event) => {
      events.push(event)
      logs.push(`${event.kind}: ${event.detail}`)
    },
  }
  return {
    deps,
    enqueue: createQueue(),
    schedule,
    engine,
    clock,
    sent,
    logs,
    events,
    killSwitch,
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

test('a turn-stopping pass with no new delivery leaves a loop that still has budget alone', async () => {
  // The pass below *does* evaluate the round cap; what this case pins is the
  // under-budget outcome, so the default 24 rounds and no button presses must
  // decide nothing and write nothing.
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  assert.equal(await handleTurnStopping(bench.deps, bench.caller), undefined)
  assert.equal(bench.schedule.updateCalls, 0, 'no write happens without a new delivery')
  assert.equal(bench.schedule.deleteCalls, 0)
  assert.deepEqual(bench.events, [], 'and no guard rail is reported')
})

test('the round limit stops a button-only loop before any receipt exists (V1)', async () => {
  // A capsule press advances the durable counter but leaves no scheduler receipt,
  // so the budget has to be evaluated *before* the no-receipt early return:
  // gating the cap on a receipt let `maxRounds` be walked past by hand (V1).
  const bench = rig({ maxRounds: 2 })
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  assert.equal(bench.sent.length, 1, 'the start delivers round 1')
  for (const expected of [1, 2]) {
    const pressed = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
    assert.equal(pressed.ok, true, pressed.text)
    assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.iteration, expected, 'each press is durable')
  }
  assert.equal(bench.schedule.size, 1, 'the loop is still armed before the guard pass')

  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'stopped after reaching its round limit of 2 (1)')
  assert.equal(bench.schedule.size, 0, 'rows 1 -> 0: the record is deleted')
  assert.deepEqual(bench.events.map((event) => event.kind), ['round-limit'])
  assert.equal(bench.events[0]?.detail, 'round limit reached after 2 delivered round(s) of 2')
  const notice = bench.sent.at(-1)!
  assert.match(notice, /reached its round limit of 2 round\(s\), so it has been stopped and removed \(1\)/u)
  assert.match(notice, /it is a separate limit from the 7-day lifetime and from the two-omission stop/u)
  assert.match(notice, /Raise config.maxRounds or start a new loop/u)
})

test('the same button-only presses do not stop a loop that still has budget', async () => {
  const bench = rig({ maxRounds: 24 })
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  for (let press = 0; press < 2; press += 1) {
    const pressed = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
    assert.equal(pressed.ok, true, pressed.text)
  }
  assert.equal(await handleTurnStopping(bench.deps, bench.caller), undefined)
  assert.equal(bench.schedule.size, 1, 'rows stay 1: no false stop')
  assert.deepEqual(bench.events, [], 'and no guard rail is reported')
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


test('a loop stops when it reaches its round limit, and says which guard rail fired', async () => {
  const bench = rig({ maxRounds: 2 })
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  const id = bench.schedule.all()[0]!.id

  // Round 1 was delivered by the start; the first turn end is the first round
  // the model finished, and the budget is not spent yet.
  bench.clock.now += 10 * 60 * 1000
  bench.schedule.deliver(id)
  assert.equal(await handleTurnStopping(bench.deps, bench.caller), 'armed a 20-minute omission guard for 1')
  assert.equal(bench.schedule.size, 1, 'one round of two must not stop the loop')

  // Round 2 lands, and the limit is reached: the loop stops for THAT reason,
  // not for the omission the same turn also contains.
  bench.clock.now += 20 * 60 * 1000
  bench.schedule.deliver(id)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'stopped after reaching its round limit of 2 (1)')
  assert.equal(bench.schedule.size, 0, 'the loop must be gone')
  const notice = bench.sent.at(-1)!
  assert.match(notice, /reached its round limit of 2 round\(s\)/u)
  assert.match(notice, /separate limit from the 7-day lifetime and from the two-omission stop/u)
  assert.match(notice, /Raise config.maxRounds/u)
  const kinds = bench.events.map((event) => event.kind)
  assert.deepEqual(kinds, ['round-limit'], `expected only the round-limit rail, saw: ${JSON.stringify(bench.events)}`)
  assert.match(bench.logs.at(-1)!, /^round-limit: round limit reached after 2 delivered round\(s\) of 2/u)
})

test('the round limit applies to a self-paced loop the model armed itself', async () => {
  const bench = rig({ maxRounds: 3 })
  const started = await runStartTool(bench, { task: 'watch the queue' })
  assert.equal(started.ok, true, started.text)
  const id = bench.schedule.all()[0]!.id
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.startedBy, 'agent')
  // Round 1 is delivered by the start; the model continues twice, which spends
  // rounds 2 and 3 and must end the loop.
  for (let round = 2; round <= 3; round += 1) {
    bench.clock.now += 5 * 60 * 1000
    bench.schedule.deliver(id)
    const continued = await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: `round ${round}` }, bench.enqueue)
    assert.equal(continued.ok, true, continued.text)
  }
  bench.clock.now += 5 * 60 * 1000
  bench.schedule.deliver(id)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'stopped after reaching its round limit of 3 (1)')
  assert.equal(bench.schedule.size, 0)
  assert.deepEqual(bench.events.map((event) => event.kind), ['round-limit'])
})

test('the two guard rails cannot mask each other', async () => {
  // The lifetime wins when it expires first, even with budget left...
  const early = rig({ maxRounds: 24, lifetimeDays: 1 })
  await runLoopCommand(early.deps, early.caller, '10m check the build', early.enqueue)
  early.clock.now += 86_400_000 + 1000
  assert.equal(await handleTurnStopping(early.deps, early.caller), 'expired 1')
  assert.deepEqual(early.events.map((event) => event.kind), ['expiry'])
  assert.match(early.sent.at(-1)!, /reached its end of life/u)
  assert.doesNotMatch(early.sent.at(-1)!, /round limit/u)

  // ...and the round limit wins when it is reached first, even with a week left.
  const late = rig({ maxRounds: 1, lifetimeDays: 7 })
  await runLoopCommand(late.deps, late.caller, '10m check the build', late.enqueue)
  const id = late.schedule.all()[0]!.id
  late.clock.now += 10 * 60 * 1000
  late.schedule.deliver(id)
  assert.equal(await handleTurnStopping(late.deps, late.caller), 'stopped after reaching its round limit of 1 (1)')
  assert.deepEqual(late.events.map((event) => event.kind), ['round-limit'])
  assert.match(late.sent.at(-1)!, /reached its round limit/u)
  assert.doesNotMatch(late.sent.at(-1)!, /end of life/u)
  assert.equal(late.clock.now < late.engine.now() + 7 * 86_400_000, true, 'the loop had days of lifetime left')
})

test('an omission guard is still reported as an omission when no limit is reached', async () => {
  const bench = rig({ maxRounds: 24 })
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  bench.clock.now += 30 * 60 * 1000
  bench.schedule.deliver(id)
  assert.equal(await handleTurnStopping(bench.deps, bench.caller), 'armed a 20-minute omission guard for 1')
  bench.clock.now += 20 * 60 * 1000
  bench.schedule.deliver(id)
  assert.equal(await handleTurnStopping(bench.deps, bench.caller), 'stopped after a second omission (1)')
  assert.deepEqual(bench.events.map((event) => event.kind), ['omissions'])
  assert.match(bench.logs.at(-1)!, /^omissions: stopped after a second consecutive omitted continuation/u)
})

test('a round budget deeper than one history page is still counted exactly', async () => {
  // Regression: the cap compared a single `history({limit:100})` page against
  // `config.maxRounds`, so any cap above 100 was unreachable in silence.
  const bench = rig({ maxRounds: 150 })
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  for (let round = 0; round < 150; round += 1) bench.schedule.deliver(id)
  assert.equal(bench.schedule.size, 1, 'the loop is still armed before the guard')
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'stopped after reaching its round limit of 150 (1)')
  assert.equal(bench.schedule.size, 0)
  const limitLog = bench.logs.find((line) => line.includes('round-limit'))
  assert.match(limitLog ?? '', /round limit reached after 150 delivered round\(s\) of 150/u)
  assert.deepEqual(bench.events.map((event) => event.kind), ['round-limit'])
})

test('a round the capsule button began spends the same budget as a delivered one', async () => {
  // Regression: `/loop next` advanced the durable counter but the cap counted
  // only scheduler receipts, so five presses at maxRounds=2 left the loop live.
  const bench = rig({ maxRounds: 2 })
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.iteration, 0)
  for (const expected of [1, 2]) {
    const pressed = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
    assert.equal(pressed.ok, true, pressed.text)
    assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.iteration, expected)
  }
  assert.equal(bench.schedule.size, 1, 'no receipt exists yet, so the guard has not run')
  // The next turn end is where the spent budget is enforced.
  bench.schedule.deliver(bench.schedule.all()[0]!.id)
  const report = await handleTurnStopping(bench.deps, bench.caller)
  assert.equal(report, 'stopped after reaching its round limit of 2 (1)')
  assert.equal(bench.schedule.size, 0)
  assert.deepEqual(bench.events.map((event) => event.kind), ['round-limit'])
  assert.ok(
    !bench.logs.some((line) => line.includes('second consecutive omitted continuation')),
    'the cap must be reported as the cap, not as an omission',
  )
})

test('`/loop next` runs the next round now, for a loop the user started', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  assert.equal(bench.sent.length, 1, 'round 1 ran at start time')
  const id = bench.schedule.all()[0]!.id
  bench.clock.now += 60_000
  const beforePress = bench.schedule.all()[0]!
  const receiptsBefore = (await bench.engine.countDeliveries({ sessionId: bench.caller.sessionId, cwd: process.cwd(), isSubagent: false, send: () => undefined }, id)).count

  const result = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /Next round delivered now \(1\)/u)
  assert.match(result.text, /the wall-clock cadence is untouched/u)
  assert.match(result.text, /Round 2 of at most 24 started by: user · cadence every 10 minutes/u)
  assert.equal(bench.sent.length, 2, 'the button delivers a round immediately')
  assert.match(bench.sent[1]!, /The user pressed "next round" in the composer capsule/u)
  assert.match(bench.sent[1]!, /is not a scheduled delivery/u)
  assert.match(bench.sent[1]!, /round_context: '\{"loop":true,"round":2/u)
  assert.match(bench.sent[1]!, /check the build/u)
  assert.equal(bench.schedule.size, 1, 'the record is replaced in place, never duplicated')
  assert.equal(bench.schedule.all()[0]!.id, id, 'and it keeps its id')
  // The regression this locks: the button must not re-time a wall-clock rule.
  const afterPress = bench.schedule.all()[0]!
  assert.equal(afterPress.kind, 'cron', 'a fixed-cadence loop stays a cron rule through the press')
  assert.equal(afterPress.expression, beforePress.expression, 'and its expression is unchanged')
  assert.equal(afterPress.everySeconds, undefined, 'no fixed-rate interval may be introduced')
  assert.equal(afterPress.scheduledAt, beforePress.scheduledAt, 'and its wall-clock target is untouched')
  assert.equal(bench.schedule.updateCalls, 1, 'the press still updates the record once (the round counter)')
  const after = await bench.engine.countDeliveries({ sessionId: bench.caller.sessionId, cwd: process.cwd(), isSubagent: false, send: () => undefined }, id)
  assert.equal(after.count, receiptsBefore, 'the press fabricates no scheduler receipt')
  const decoded = decodeLoopRecord(afterPress)
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.iteration, 1, 'the button counts as a round for the cap and the projection')
  assert.equal(decoded.state.mode, 'fixed', 'the durable rhythm is unchanged')
  assert.equal(decoded.state.cadenceSeconds, 600, 'and so is the durable cadence')
  assert.equal(decoded.state.startedBy, 'user')
})

test('`/loop next` re-arms only a self-paced loop, and keeps its cadence text honest', async () => {
  const bench = rig()
  const started = await runStartTool(bench, { task: 'watch the queue' })
  assert.equal(started.ok, true, started.text)
  const id = bench.schedule.all()[0]!.id
  const result = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /the following round is armed for 60s from now/u)
  assert.match(result.text, /Round 2 of at most 24 started by: user · cadence self-paced/u)
  assert.equal(bench.schedule.all()[0]!.everySeconds, 60, 'a self-paced loop is re-armed for the follow-up round')
  assert.equal(bench.schedule.all()[0]!.id, id)
})

test('`/loop next` works on a fixed-cadence loop, where loop_next is refused', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  const model = await runLoopNext(bench.deps, bench.caller, { seconds: 300, reason: 'x' }, bench.enqueue)
  assert.equal(model.ok, false, 'the model cannot re-time a wall-clock loop')
  assert.match(model.text, /fixed cadence/u)

  const user = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(user.ok, true, user.text)
  assert.equal(bench.sent.length, 2)
})

test('`/loop next` works on a loop the model armed, and `/loop stop` ends either one', async () => {
  const bench = rig()
  const started = await runStartTool(bench, { task: 'watch the queue' })
  assert.equal(started.ok, true, started.text)
  assert.equal(bench.sent.length, 1)

  const advanced = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(advanced.ok, true, advanced.text)
  assert.match(advanced.text, /started by: user/u, 'the button is a person acting, whatever armed the loop')
  assert.equal(bench.sent.length, 2, 'the agent-armed loop runs its round immediately')
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.startedBy, 'agent', 'the loop keeps its origin')

  const stopped = await runLoopCommand(bench.deps, bench.caller, 'stop', bench.enqueue)
  assert.equal(stopped.ok, true, stopped.text)
  assert.match(stopped.text, /Stopped 1 loop\(s\): 1\./u)
  assert.equal(bench.schedule.size, 0)
})

test('`/loop next` refuses clearly when there is nothing to advance', async () => {
  const bench = rig()
  const idle = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(idle.ok, false)
  assert.match(idle.text, /no next round to run/u)
  assert.equal(bench.sent.length, 0, 'a refusal must not wake the session')

  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  bench.clock.now += 7 * 86_400_000 + 1000
  const expired = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(expired.ok, false)
  assert.match(expired.text, /reached its end of life/u)
  assert.equal(bench.schedule.size, 0, 'an expired loop is removed, not advanced')
})

test('`/loop next` rolls the record back when the delivery fails', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  const failing: Caller = { ...bench.caller, send: () => { throw new Error('the inbox is closed') } }
  const result = await runLoopCommand(bench.deps, failing, 'next', bench.enqueue)
  assert.equal(result.ok, false)
  assert.match(result.text, /could not be delivered, so the loop was stopped and removed: the inbox is closed/u)
  assert.equal(bench.schedule.size, 0, 'a loop that cannot deliver must not be left armed')
  assert.equal(bench.sent.length, 1, 'no round was reported as delivered')
  void id
})


test('F5: `/loop next` is refused for a subagent caller, and delivers nothing', async () => {
  // Regression: the `next` branch sat ahead of the subagent guard, so a child
  // that reported its parent's session id could make that session run a round.
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  assert.equal(bench.sent.length, 1, 'round 1 ran at start time')
  const id = bench.schedule.all()[0]!.id

  const impostor: Caller = { ...bench.caller, isSubagent: true }
  const refused = await runLoopCommand(bench.deps, impostor, 'next', bench.enqueue)
  assert.equal(refused.ok, false, refused.text)
  assert.match(refused.text, /subagent session cannot start or stop a loop/u)
  assert.equal(bench.sent.length, 1, 'a refused press must not deliver a round')
  assert.equal(bench.schedule.updateCalls, 0, 'and must not touch the record either')
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.iteration, 0, 'no round was counted')
  // A genuinely separate child session owns no loop at all.
  const child: Caller = { ...bench.caller, isSubagent: true, sessionId: 'session-child' }
  const idle = await runLoopCommand(bench.deps, child, 'next', bench.enqueue)
  assert.equal(idle.ok, false)
  assert.match(idle.text, /subagent session cannot start or stop a loop/u)
  assert.equal(bench.schedule.size, 1, 'the parent loop is untouched')
  // Reading stays available: `status` is above the guard on purpose.
  const status = await runLoopCommand(bench.deps, impostor, 'status', bench.enqueue)
  assert.equal(status.ok, true, status.text)
  assert.equal(decodeLoopRecord(bench.schedule.peek(id)!)?.state.iteration, 0)
})

test('F8: the kill switch refuses `/loop next` and delivers nothing', async () => {
  const bench = rig()
  await runLoopCommand(bench.deps, bench.caller, 'watch the queue', bench.enqueue)
  const id = bench.schedule.all()[0]!.id
  const before = bench.sent.length
  bench.killSwitch.on = true
  const refused = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(refused.ok, false, refused.text)
  assert.match(refused.text, /DSH_DISABLE_LOOP kill switch is set/u)
  assert.equal(bench.sent.length, before, 'no round may be delivered while the switch is set')
  assert.equal(bench.schedule.updateCalls, 0, 'and the record is not rewritten')
  assert.equal(bench.schedule.size, 1, 'the existing loop is left for /loop stop, exactly like the start path')
  assert.equal(decodeLoopRecord(bench.schedule.all()[0]!)?.state.iteration, 0)
  bench.killSwitch.on = false
  const allowed = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(allowed.ok, true, allowed.text)
  assert.equal(bench.sent.length, before + 1)
  void id
})

test('F6: a fixed-cadence `/loop next` names the real round limit and cadence', async () => {
  const bench = rig({ maxRounds: 7 })
  await runLoopCommand(bench.deps, bench.caller, '10m check the build', bench.enqueue)
  const result = await runLoopCommand(bench.deps, bench.caller, 'next', bench.enqueue)
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /Round 2 of at most 7 started by: user · cadence every 10 minutes/u)
  const delivered = bench.sent.at(-1)!
  // The sentence must state the configured round limit, never the cadence label.
  assert.match(delivered, /round limit 7/u)
  assert.doesNotMatch(delivered, /of at most every/u)
  assert.doesNotMatch(delivered, /at most every 10 minutes/u)
  assert.match(delivered, /cadence every 10 minutes/u)
})
