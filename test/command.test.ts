/**
 * The `/loop` command surface: every call form, every refusal, and every
 * stop/status path, driven through a fake clock.
 * @module cordis-plugin-loop/test/command
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LoopEngine } from '../src/engine.ts'
import { jitterCapMinutes, jitterMinutes, loopFingerprint } from '../src/cadence.ts'
import { createQueue, runLoopCommand, type Caller, type RegistryDeps } from '../src/registry.ts'
import { buildPrompt, decodeLoopRecord, ownerOf } from '../src/state.ts'
import { killSwitchFromEnv, DEFAULT_CONFIG, type LoopConfig } from '../src/config.ts'
import { catalogFn } from '../src/index.ts'
import { FakeSchedule } from './fake-schedule.ts'

/** One assembled command surface over the double. */
interface Surface {
  /** The command dependencies. */
  readonly deps: RegistryDeps
  /** The serial queue. */
  readonly enqueue: ReturnType<typeof createQueue>
  /** The schedule double. */
  readonly schedule: FakeSchedule
  /** The engine under test. */
  readonly engine: LoopEngine
  /** Everything the plugin logged. */
  readonly logs: string[]
  /** Run one command line. */
  readonly run: (rawInput: string, overrides?: Partial<Caller>) => Promise<{ ok: boolean; text: string }>
}

/** Build one command surface. */
function surface(options: {
  config?: Partial<LoopConfig>
  env?: Record<string, string | undefined>
  planMode?: boolean
  clock?: { now: number }
  schedule?: FakeSchedule
} = {}): Surface {
  const schedule = options.schedule ?? new FakeSchedule()
  const clock = options.clock ?? { now: schedule.now }
  schedule.external = () => clock.now
  const logs: string[] = []
  const config: LoopConfig = { ...DEFAULT_CONFIG, ...(options.config ?? {}) }
  const env = options.env ?? {}
  const engine = new LoopEngine({
    config,
    schedule,
    timeZone: 'Asia/Shanghai',
    logger: {
      warn: (message) => logs.push(`warn: ${message}`),
      info: (message) => logs.push(`info: ${message}`),
    },
    now: () => clock.now,
  })
  const deps: RegistryDeps = {
    config,
    engine,
    env,
    killSwitch: () => killSwitchFromEnv(env),
    planMode: options.planMode === undefined ? undefined : () => options.planMode === true,
    // The REAL discovery function, against a catalogue-shaped double: a
    // hand-written stand-in here is exactly what once hid a catalogue lookup
    // that could never succeed against the live service.
    listAllLoopRecords: catalogFn(schedule),
  }
  const enqueue = createQueue()
  const base: Caller = {
    sessionId: 'session-a',
    cwd: process.cwd(),
    isSubagent: false,
    send: () => undefined,
  }
  return {
    deps,
    enqueue,
    schedule,
    engine,
    logs,
    run: async (rawInput, overrides = {}) =>
      runLoopCommand(deps, { ...base, ...overrides }, rawInput, enqueue),
  }
}

test('/loop with no task and no default file refuses and lists both paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'command-'))
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const surfaceA = surface({ env: { DSH_HOME: join(root, 'home') } })
  try {
    for (const line of ['', '   ', '10m']) {
      const result = await surfaceA.run(line, { cwd })
      assert.equal(result.ok, false, `"${line}" must fail without a task`)
      assert.match(result.text, /No task given/u)
      assert.ok(result.text.includes(join(cwd, '.dsh', 'loop.md')))
      assert.ok(result.text.includes(join(root, 'home', 'loop.md')))
    }
    assert.equal(surfaceA.schedule.size, 0, 'a refusal must create no record')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a bare /loop and /loop <interval> both use the default task file, every 10 minutes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'command-'))
  const cwd = join(root, 'project')
  await mkdir(join(cwd, '.dsh'), { recursive: true })
  await writeFile(join(cwd, '.dsh', 'loop.md'), 'tend the garden\n', 'utf8')
  const surfaceA = surface({ env: { DSH_HOME: join(root, 'home') } })
  try {
    const bare = await surfaceA.run('', { cwd })
    assert.equal(bare.ok, true, bare.text)
    assert.match(bare.text, /Cadence: every 10 minutes/u)
    const record = surfaceA.schedule.all()[0]!
    assert.match(record.prompt, /Task source: the file/u)
    assert.match(record.prompt, new RegExp(join(cwd, '.dsh', 'loop.md').replace(/\\/gu, '\\\\')))
    const replaced = await surfaceA.run('2h', { cwd })
    assert.equal(replaced.ok, true, replaced.text)
    assert.match(replaced.text, /Loop restarted \(replaced 1 previous loop\)/u)
    assert.equal(surfaceA.schedule.size, 1, 'one loop per session')
    assert.match(surfaceA.schedule.all()[0]!.prompt, /every 2 hours/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/loop <task> is self-paced, and the record is the recurring safety-check driver', async () => {
  const surfaceA = surface()
  const result = await surfaceA.run('watch the queue')
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /Cadence: self-paced/u)
  assert.match(result.text, /safety check/u)
  const record = surfaceA.schedule.all()[0]!
  // Recurring, not a one-shot: a fired one-shot turns inactive and then rejects
  // `update` with `schedule_ended`, so it could never be re-armed.
  assert.equal(record.kind, 'every')
  assert.equal(record.everySeconds, 30 * 60)
  assert.match(record.prompt, /Task:\nwatch the queue/u)
  assert.match(record.title, /^DSH \/loop: watch the queue$/u)
})

test('/loop <interval> <task> and /loop <task> every <interval> agree', async () => {
  const first = surface()
  const lead = await first.run('10m check the build')
  assert.equal(lead.ok, true, lead.text)
  const trailing = surface()
  const tail = await trailing.run('check the build every 10 minutes')
  assert.equal(tail.ok, true, tail.text)
  assert.equal(first.schedule.all()[0]!.expression, trailing.schedule.all()[0]!.expression)
  assert.match(first.schedule.all()[0]!.prompt, /Task:\ncheck the build/u)
})

test('an out-of-range interval is refused with a clear message and creates nothing', async () => {
  const surfaceA = surface()
  const cases: [string, RegExp][] = [
    ['0m', /positive duration|at least 1 minute/u],
    ['30s', /at least 1 minute/u],
    ['32d', /at most 31 days/u],
    ['1000d', /at most 31 days/u],
  ]
  for (const [line, expected] of cases) {
    const result = await surfaceA.run(`${line} check the build`)
    assert.equal(result.ok, false, `"${line}" must be refused`)
    assert.match(result.text, expected)
  }
  assert.equal(surfaceA.schedule.size, 0)
})

test('an over-long inline task is refused and points at the file route', async () => {
  const surfaceA = surface({ config: { maxTaskBytes: 100 } })
  const result = await surfaceA.run(`do the thing ${'x'.repeat(200)}`)
  assert.equal(result.ok, false)
  assert.match(result.text, /accepted maximum is 100/u)
  assert.match(result.text, /loop task file/u)
})

test('the inline task budget counts code points, not UTF-16 units', async () => {
  const surfaceA = surface({ config: { maxTaskBytes: 100 } })
  // 100 astral characters are 200 UTF-16 units and 400 UTF-8 bytes: the inline
  // budget is documented in code points, so this is exactly at the limit.
  const accepted = await surfaceA.run('😀'.repeat(100))
  assert.equal(accepted.ok, true, accepted.text)
  assert.match(accepted.text, /Task: 100 code points, inline/u)
  assert.match(accepted.text, /: 100 code points, inline/u)
  assert.equal(surfaceA.schedule.size, 1)

  const refused = await surfaceA.run('😀'.repeat(101))
  assert.equal(refused.ok, false)
  assert.match(refused.text, /The task is 101 code points; the accepted maximum is 100/u)
  assert.equal(surfaceA.schedule.size, 1, 'a refusal must not create a second record')
})

test('status reports the inline task size in the same unit', async () => {
  const surfaceA = surface({ config: { maxTaskBytes: 100 } })
  await surfaceA.run('😀'.repeat(50))
  const status = await surfaceA.run('status')
  assert.equal(status.ok, true, status.text)
  assert.match(status.text, /task: 50 code points inline/u)
})

test('plan mode refuses to start a loop and creates no record', async () => {
  const surfaceA = surface({ planMode: true })
  const result = await surfaceA.run('10m check the build')
  assert.equal(result.ok, false)
  assert.match(result.text, /Plan mode is active/u)
  assert.equal(surfaceA.schedule.size, 0)
  assert.equal(surfaceA.schedule.createCalls, 0)
})

test('the kill switch refuses new loops, cancels the live one, and logs its task first', async () => {
  const schedule = new FakeSchedule()
  const surfaceA = surface({ schedule })
  const started = await surfaceA.run('10m check the build')
  assert.equal(started.ok, true, started.text)
  assert.equal(schedule.size, 1)
  const blocked = surface({ schedule, env: { DSH_DISABLE_LOOP: '1' } })
  const result = await blocked.run('10m check the deploy')
  assert.equal(result.ok, false)
  assert.match(result.text, /DSH_DISABLE_LOOP/u)
  assert.match(result.text, /cancelled/u)
  assert.equal(schedule.size, 0, 'the existing loop must be cancelled')
  assert.ok(schedule.catalogCalls >= 1, 'cancellation must go through the real catalogue discovery')
  const cancelLog = blocked.logs.find((line) => line.includes('cancelling'))
  assert.ok(cancelLog !== undefined, 'the cancel must be logged')
  assert.match(cancelLog, /task: check the build/u)
})

test('the kill switch leaves a foreign record alone even though discovery sees it', async () => {
  const schedule = new FakeSchedule()
  const surfaceA = surface({ schedule })
  await surfaceA.run('10m check the build')
  await schedule.create('session-a', { prompt: 'ordinary reminder', title: 'other', every_seconds: 120 })
  const blocked = surface({ schedule, env: { DSH_DISABLE_LOOP: '1' } })
  const result = await blocked.run('10m check the deploy')
  assert.equal(result.ok, false)
  assert.match(result.text, /1 existing loop\(s\) were cancelled/u)
  assert.equal(schedule.size, 1, 'the foreign record must survive')
  assert.match(schedule.all()[0]!.prompt, /ordinary reminder/u)
})

test('the cancel path keeps the owner check: another session\'s header is not cancelled', async () => {
  const schedule = new FakeSchedule()
  const surfaceA = surface({ schedule })
  // A loop header that belongs to a different session, stored under this one:
  // the prefix matches, so only the owner check can stop the cancel.
  const foreign = buildPrompt({
    owner: ownerOf('session-b'),
    mode: 'fixed',
    cadenceSeconds: 600,
    cadenceLabel: 'every 10 minutes',
    fingerprint: 'abcdef0123456789',
    jitterSeconds: 0,
    iteration: 0,
    quietStreak: 0,
    omissions: 0,
    expiresAt: Date.now() + 86_400_000,
    lastRunAt: Date.now(),
    task: 'owned by another session',
  }).prompt
  await schedule.create('session-a', { prompt: foreign, title: 'DSH /loop: wrong owner', every_seconds: 600 })
  const blocked = surface({ schedule, env: { DSH_DISABLE_LOOP: '1' } })
  const result = await blocked.run('10m check the deploy')
  assert.equal(result.ok, false)
  assert.match(result.text, /0 existing loop\(s\) were cancelled/u)
  assert.equal(schedule.size, 1, 'a record owned by another session must survive')
  assert.match(
    result.text,
    /1 record\(s\) could not be cleared automatically \(owner mismatch or a failed delete\) and need manual removal with \/loop stop/u,
    'the refusal must say the leftover needs manual removal',
  )
  assert.ok(
    blocked.logs.some((line) => line.includes('leaving') && line.includes('owned by that session')),
    `expected a "leaving … alone" line, saw: ${blocked.logs.join(' | ')}`,
  )
})

test('a clean kill-switch cancel says nothing about manual removal', async () => {
  const schedule = new FakeSchedule()
  const surfaceA = surface({ schedule })
  await surfaceA.run('10m check the build')
  const blocked = surface({ schedule, env: { DSH_DISABLE_LOOP: '1' } })
  const result = await blocked.run('10m check the deploy')
  assert.equal(result.ok, false)
  assert.match(result.text, /1 existing loop\(s\) were cancelled/u)
  assert.doesNotMatch(result.text, /manual removal/u, 'nothing was left behind, so say nothing')
  assert.equal(schedule.size, 0)
})

test("a write failure while reading the loop state is reported friendly, not thrown", async () => {
  const surfaceA = surface()
  await surfaceA.run('10m check the build')
  surfaceA.schedule.breakList(true)

  const status = await surfaceA.run('status')
  assert.equal(status.ok, false)
  assert.match(status.text, /^Could not read the loop state: storage backend exploded$/u)

  const stop = await surfaceA.run('stop all')
  assert.equal(stop.ok, false)
  assert.match(stop.text, /Could not read the loop state: storage backend exploded/u)

  const restart = await surfaceA.run('10m check the deploy')
  assert.equal(restart.ok, false)
  assert.match(restart.text, /Could not read the loop state: storage backend exploded/u)
  assert.ok(
    surfaceA.logs.some((line) => line.includes('reading the session\'s loop state failed')),
    'the failure must also reach the log',
  )
})

test('the guard still contains a state read failure and never throws', async () => {
  const bench = { ...surface() }
  await bench.run('watch the queue')
  bench.schedule.deliver(bench.schedule.all()[0]!.id)
  bench.schedule.breakList(true)
  const { handleTurnStopping } = await import('../src/registry.ts')
  const caller: Caller = { sessionId: 'session-a', cwd: process.cwd(), isSubagent: false, send: () => undefined }
  assert.equal(await handleTurnStopping(bench.deps, caller), undefined)
  assert.equal(bench.schedule.size, 1, 'a failed read must not remove the loop')
})

test('config.enabled = false refuses new loops the same way', async () => {
  const surfaceA = surface({ config: { enabled: false } })
  const result = await surfaceA.run('10m check the build')
  assert.equal(result.ok, false)
  assert.match(result.text, /config\.enabled: false/u)
  assert.equal(surfaceA.schedule.size, 0)
})

test('a subagent session may not start or stop a loop, and sees a clear error', async () => {
  const surfaceA = surface()
  for (const line of ['10m check the build', 'check the build', 'stop', 'stop all']) {
    const result = await surfaceA.run(line, { isSubagent: true })
    assert.equal(result.ok, false, `"${line}" must be refused for a subagent`)
    assert.match(result.text, /subagent/u)
  }
  assert.equal(surfaceA.schedule.size, 0)
  const status = await surfaceA.run('status', { isSubagent: true })
  assert.equal(status.ok, true, 'status stays readable for a subagent')
  assert.match(status.text, /No loop is active/u)
})

test('status reports the live loop, its counters, and the real delivery count', async () => {
  const surfaceA = surface()
  const empty = await surfaceA.run('status')
  assert.equal(empty.ok, true)
  assert.match(empty.text, /No loop is active in this session/u)
  await surfaceA.run('10m check the build')
  const id = surfaceA.schedule.all()[0]!.id
  surfaceA.schedule.deliver(id)
  surfaceA.schedule.deliver(id)
  const status = await surfaceA.run('status')
  assert.equal(status.ok, true, status.text)
  assert.match(status.text, /every 10 minutes/u)
  assert.match(status.text, /delivered so far: 2/u)
  assert.match(status.text, /omissions 0/u)
  assert.match(status.text, new RegExp(id.replace(/^schedule-/u, '')))
})

test('stop removes the record by short id, by full id, and via stop all', async () => {
  const surfaceA = surface()
  await surfaceA.run('10m check the build')
  const short = surfaceA.schedule.all()[0]!.id.replace(/^schedule-/u, '')
  const stopped = await surfaceA.run(`stop ${short}`)
  assert.equal(stopped.ok, true, stopped.text)
  assert.equal(surfaceA.schedule.size, 0)
  const again = await surfaceA.run(`stop ${short}`)
  assert.equal(again.ok, false)
  assert.match(again.text, /No loop is active in this session; nothing to stop\./u)

  await surfaceA.run('10m one')
  await surfaceA.run('10m two')
  assert.equal(surfaceA.schedule.size, 1, 'the second start replaces the first')
  const all = await surfaceA.run('stop all')
  assert.equal(all.ok, true, all.text)
  assert.match(all.text, /Stopped 1 loop\(s\)/u)
  assert.equal(surfaceA.schedule.size, 0)
})

test('an unknown stop id reports the live ids instead of succeeding silently', async () => {
  const surfaceA = surface()
  await surfaceA.run('10m check the build')
  const result = await surfaceA.run('stop 9999')
  assert.equal(result.ok, false)
  assert.match(result.text, /No loop with id "9999" is active/u)
  assert.match(result.text, /Active: /u)
  assert.equal(surfaceA.schedule.size, 1, 'a miss must not stop anything')
})

test('a bare stop stops every loop of the session', async () => {
  const surfaceA = surface()
  await surfaceA.run('10m check the build')
  const result = await surfaceA.run('stop')
  assert.equal(result.ok, true, result.text)
  assert.equal(surfaceA.schedule.size, 0)
})

test('a foreign record is neither listed nor stopped', async () => {
  const surfaceA = surface()
  await surfaceA.run('10m check the build')
  await surfaceA.schedule.create('session-a', {
    prompt: 'an ordinary reminder from another plugin',
    title: 'other',
    after_seconds: 60,
  })
  const status = await surfaceA.run('status')
  assert.equal(status.ok, true, status.text)
  assert.equal(status.text.split('\n').filter((line) => line.startsWith('- ')).length, 1)
  const all = await surfaceA.run('stop all')
  assert.equal(all.ok, true)
  assert.equal(surfaceA.schedule.size, 1, 'the foreign record must survive stop all')
})

test('the confirmation text discloses the jitter, the title and the expiry', async () => {
  const surfaceA = surface()
  const result = await surfaceA.run('10m check the build')
  assert.match(result.text, /Title: DSH \/loop: check the build/u)
  assert.match(result.text, /cron `/u)
  assert.match(result.text, /time zone Asia\/Shanghai/u)
  assert.match(result.text, /Expires: \d{4}-/u)
  assert.match(result.text, /\(7 days\)/u)
  assert.match(result.text, /iteration counter does not advance/u)
  // The disclosed offset must be exactly the one the fingerprint resolves to.
  const fingerprint = loopFingerprint('session-a', 600, 'check the build')
  const offset = jitterMinutes(fingerprint, 600)
  const cap = jitterCapMinutes(600)
  const disclosed =
    offset > 0
      ? `Jitter: ${offset * 60}s = ${offset} minute(s)`
      : cap === 0
        ? 'Jitter: 0 (minute precision cannot express a smaller offset'
        : `Jitter: 0 (the fingerprint drew no offset; this cadence could carry up to ${cap} minute(s).`
  assert.ok(result.text.includes(disclosed), `the text must disclose offset ${offset}: ${result.text}`)
  assert.ok(result.text.includes(fingerprint), 'the text must name the fingerprint')
  const decoded = decodeLoopRecord(surfaceA.schedule.all()[0]!)
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.jitterSeconds, offset * 60, 'the header must record the applied offset')
  assert.equal(decoded.state.cadenceSeconds, 600)
  assert.equal(decoded.state.fingerprint, fingerprint)
})

test('a cadence whose share is under a minute reports jitter 0 with the reason', async () => {
  const surfaceA = surface()
  const result = await surfaceA.run('5m check the build')
  assert.match(result.text, /Jitter: 0 \(minute precision cannot express a smaller offset/u)
})

test('an integer-minute cadence with a zero draw keeps the star-step expression', async () => {
  const surfaceA = surface()
  await surfaceA.run('5m check the build')
  const record = surfaceA.schedule.all()[0]!
  assert.equal(record.expression, '*/5 * * * *')
})
