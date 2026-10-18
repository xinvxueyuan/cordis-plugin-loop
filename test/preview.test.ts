/**
 * `/loop --dry-run` and `loop_start({dryRun:true})`: the read-only preview.
 *
 * The load-bearing case here is the **anti-drift** one: the fields a preview
 * prints must be the fields a real start of the same input actually stores. It
 * is checked against the rendered preview text — what a caller reads — and not
 * against a second planning call, so a preview that drifted from the start path
 * would fail it.
 *
 * The cases run on two rigs, and each case says which one it uses:
 *
 *  - the **double** rig (`bootHost({scheduleDouble})`) counts every call on the
 *    seam, which is how "nothing was written" is proved exactly;
 *  - the **real** rig (plain `bootHost()`) composes the genuine
 *    `@deepseek-ai/dsh-schedule` service over the real JSON storage backend, so
 *    "nothing was written" is proved on the shipped service as well.
 * @module cordis-plugin-loop/test/preview
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { canonicalizeCronExpression } from '@deepseek-ai/dsh-schedule'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { jitterCapMinutes } from '../src/cadence.ts'
import { PLAN_MODE_REFUSAL } from '../src/registry.ts'
import { decodeLoopRecord } from '../src/state.ts'
import { bootHost } from './harness.ts'
import { FakeSchedule } from './fake-schedule.ts'

/** The exact text the code-point budget refusal carries. */
const OVERLONG_REFUSAL = (codePoints: number, max: number): string =>
  `The task is ${codePoints} code points; the accepted maximum is ${max}. Move it into a loop task file instead.`

/** The fixed refusal for `--dry-run` combined with a control subcommand. */
const DRY_RUN_CONTROL_REFUSAL =
  '--dry-run previews starting a loop; it cannot be combined with status, next or stop. Run /loop --dry-run <interval> [<task>] instead.'

/** Read one `Label: value` line out of a rendered text. */
function lineOf(text: string, label: string): string {
  const line = text.split('\n').find((entry) => entry.startsWith(`${label}: `))
  assert.ok(line !== undefined, `the text must carry a "${label}:" line; got:\n${text}`)
  return line.slice(label.length + 2)
}

/** Whether a rendered text carries a given label at all. */
function hasLabel(text: string, label: string): boolean {
  return text.split('\n').some((entry) => entry.startsWith(`${label}: `))
}

/**
 * The accepted renderings of a preview's `Jitter:` line, for a plan.
 *
 * `0` is a real draw, not a missing value: the offset is drawn from
 * `[0, cap]` inclusive, so a small cadence (whose cap is one minute) renders
 * zero about half the time. The zero case has two wordings because a zero cap
 * and a zero draw are different facts, exactly as the start confirmation
 * distinguishes them.
 *
 * @param jitterSeconds - Offset the stored record carries.
 * @param fingerprint - Fingerprint the stored record carries.
 * @param capMinutes - Largest offset the cadence could carry, in whole minutes.
 * @returns The accepted renderings.
 */
function jitterLines(jitterSeconds: number, fingerprint: string, capMinutes: number): readonly string[] {
  if (jitterSeconds > 0) {
    return [
      `${jitterSeconds}s = ${jitterSeconds / 60} minute(s), drawn from min(10% of the normalized cadence, 15 min) with fingerprint ${fingerprint}`,
    ]
  }
  if (capMinutes === 0) {
    return [`0 (minute precision cannot express a smaller offset for this cadence; fingerprint ${fingerprint})`]
  }
  return [
    `0 (the fingerprint drew no offset; this cadence could carry up to ${capMinutes} minute(s). fingerprint ${fingerprint})`,
  ]
}

/**
 * The lifetime a preview's `Expires:` line states, in milliseconds.
 *
 * A preview and a real start run at different instants — the preview cannot
 * know the instant a later `create` will be accepted — so the lifetime, and not
 * the absolute instant, is the value the two must agree on. That is exactly why
 * the line says "if started now".
 *
 * @param text - Rendered preview text.
 * @param startedAt - Epoch milliseconds the preview ran at.
 * @returns The stated lifetime in milliseconds.
 */
function statedLifetimeMs(text: string, startedAt: number): number {
  const stated = /^(\S+) \(if started now; lifetime (\d+) days\)$/u.exec(lineOf(text, 'Expires'))
  assert.ok(
    stated !== null,
    `the Expires line must carry "if started now" and the lifetime; got "${lineOf(text, 'Expires')}"`,
  )
  return Date.parse(stated[1]!) - startedAt
}

/** Wait for a bounded window, so "no delivery arrived" is an observation. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One event the probe session holds. */
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
 * `seq`, `snapshotEvents()` and `eventAt()`; a real `Session` publishes
 * `session/event` only while a store is attached, so a probe supplies those five
 * members and publishes on the same context the registry listens on.
 */
class ProbeSession {
  readonly header: { readonly id: string; readonly cwd: string }
  readonly inheritedEventCount = 0
  private readonly log: ProbeEvent[] = []

  /**
   * @param id - Session identity.
   * @param cwd - Working directory the header reports.
   */
  constructor(id: string, cwd: string) {
    this.header = { id, cwd }
  }

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

test('a tab, a newline or end of input all still separate the flag at the command surface', async () => {
  // The unit grammar case is not enough here: the consequence of missing the
  // separator is that the *command* arms a real loop while the caller believes it
  // asked for a preview. So this drives the real command surface and asserts the
  // preview happened and nothing was written.
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-separator', scheduleDouble: double })
  // A default task file, so the bare `--dry-run<TAB>` form has something to
  // preview instead of refusing for the unrelated reason of a missing task.
  const taskFile = join(host.cwd, '.dsh', 'loop.md')
  await mkdir(dirname(taskFile), { recursive: true })
  await writeFile(taskFile, 'watch the build\n', 'utf8')
  try {
    const agent = host.caller()
    for (const [label, input] of [
      ['tab', '--dry-run\t10m watch the queue'],
      ['newline', '--dry-run\n10m watch the queue'],
      ['carriage return', '--dry-run\r\n10m watch the queue'],
      ['trailing tab', '--dry-run\t'],
      ['multiple spaces', '--dry-run   10m watch the queue'],
    ] as const) {
      const result = await host.commands.run('loop', agent, input)
      assert.equal(result.kind, 'success', `${label}: ${result.text}`)
      assert.match(result.text ?? '', /^Loop preview \(nothing was armed\):/u, label)
      assert.doesNotMatch(result.text ?? '', /^Loop started\./mu, `${label} must not arm a loop`)
      assert.doesNotMatch(result.text ?? '', /^Id: /mu, label)
    }
    assert.equal(double.createCalls, 0, 'no separator form may arm a loop')
    assert.equal(double.updateCalls, 0)
    assert.equal(double.deleteCalls, 0)
    assert.equal(double.size, 0)
    assert.equal(host.agent.messages.length, 0, 'no separator form may deliver a round')

    // And the strict cases are still strict at this surface too. The second one
    // replaces the loop the first one armed, so both are real starts rather than
    // previews — which is the whole point of the check.
    for (const input of ['--dry-runny', '10m check the --dry-run flag']) {
      const result = await host.commands.run('loop', agent, input)
      assert.equal(result.kind, 'success', `${input}: ${result.text}`)
      assert.match(result.text ?? '', /^Loop (started|restarted)/u, `"${input}" is a real start`)
      assert.match(result.text ?? '', /^Id: /mu, `"${input}" is a real start and carries an id`)
    }
    assert.equal(double.createCalls, 2, 'each of the two strict cases arms one loop')
  } finally {
    await host.dispose()
  }
})

test('the preview flag is lifted only when it leads, and never swallows task text', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-flag', scheduleDouble: double })
  // A default task file, so the naked form has something to preview and the
  // "flag leads every start form" claim covers all four of them.
  const taskFile = join(host.cwd, '.dsh', 'loop.md')
  await mkdir(dirname(taskFile), { recursive: true })
  await writeFile(taskFile, 'watch the build\n', 'utf8')
  try {
    const agent = host.caller()
    // A `--dry-run` that is not the first token is task text, and the start is
    // real: this is the case a naive "split on whitespace" implementation fails.
    const started = await host.commands.run('loop', agent, '10m check the --dry-run flag')
    assert.equal(started.kind, 'success', started.text)
    assert.match(started.text ?? '', /check the --dry-run flag/u)
    assert.equal(double.createCalls, 1)
    assert.equal(double.all()[0]?.title, 'DSH /loop: check the --dry-run flag')
    await host.commands.run('loop', agent, 'stop all')

    // The flag leads all four start forms and is stripped in each.
    for (const input of [
      '--dry-run',
      '--dry-run 10m',
      '--dry-run watch the queue',
      '--dry-run 10m watch the queue',
      '--dry-run 10m watch the queue every 10 minutes',
    ]) {
      const result = await host.commands.run('loop', agent, input)
      assert.equal(result.kind, 'success', `${input}: ${result.text}`)
      const text = result.text ?? ''
      assert.match(text, /^Loop preview \(nothing was armed\):/u)
      assert.doesNotMatch(text, /^Id: /mu)
      // The flag itself never survives into the task text.
      assert.doesNotMatch(text, /--dry-run/u)
    }
    // The naked form previews the default-task file with the default 10m rule.
    const naked = await host.commands.run('loop', agent, '--dry-run')
    assert.equal(naked.kind, 'success', naked.text)
    assert.equal(lineOf(naked.text ?? '', 'Mode'), 'fixed, wall-clock anchored (every 10 minutes)')
    assert.match(lineOf(naked.text ?? '', 'Task'), /loop\.md \(file budget: bytes\)$/u)

    // A task that merely mentions the flag keeps it, as literal task text.
    const literal = await host.commands.run('loop', agent, '--dry-run 10m check the --dry-run flag')
    assert.equal(literal.kind, 'success', literal.text)
    assert.equal(lineOf(literal.text ?? '', 'Title'), 'DSH /loop: check the --dry-run flag')

    // Combined with a control subcommand it is refused, in the fixed sentence,
    // and the subcommand does not run.
    for (const input of ['--dry-run status', '--dry-run next', '--dry-run stop', '--dry-run stop all']) {
      const result = await host.commands.run('loop', agent, input)
      assert.equal(result.kind, 'error', `/loop ${input} must be refused`)
      assert.equal(result.text, DRY_RUN_CONTROL_REFUSAL, `/loop ${input} must carry the fixed refusal verbatim`)
    }
    assert.equal(double.createCalls, 1, 'no preview or refusal may arm a loop')
    assert.equal(double.deleteCalls, 1, 'only the explicit stop all may delete anything')
  } finally {
    await host.dispose()
  }
})

test('the preview prints the fields a real start of the same input stores (anti-drift, command path)', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-drift', scheduleDouble: double })
  try {
    const agent = host.caller()
    const previewedAt = Date.now()
    // `18m` snaps to the 20-minute step and its fingerprint draws a non-zero
    // offset for this session, so the `Jitter:` line carries a real number
    // rather than the zero draw a ten-minute cadence happens to get. That is
    // deliberate: a preview that silently zeroed the offset would be invisible
    // on a cadence whose honest offset is already zero.
    const preview = await host.commands.run('loop', agent, '--dry-run 18m watch the queue')
    assert.equal(preview.kind, 'success', preview.text)
    const text = preview.text ?? ''
    assert.match(text, /^Loop preview \(nothing was armed\):/u)
    assert.match(text, /This was a preview: no record was created and no round was delivered\.$/u)
    assert.doesNotMatch(text, /^Id: /mu)
    assert.equal(double.createCalls, 0, 'the preview must not create a record')
    assert.equal(double.size, 0, 'the preview must leave storage empty')
    assert.equal(host.agent.messages.length, 0, 'the preview must not deliver a round')

    // The same input, really started.
    const started = await host.commands.run('loop', agent, '18m watch the queue')
    assert.equal(started.kind, 'success', started.text)
    assert.equal(double.createCalls, 1)
    assert.equal(host.agent.messages.length, 1, 'a real start delivers round one')
    const record = double.all()[0]
    assert.ok(record !== undefined, 'the real start must store one record')
    const decoded = decodeLoopRecord(record)
    assert.ok(decoded !== undefined, 'the stored record must decode as a loop record')

    // Field by field: what the preview promised, what the record holds.
    assert.equal(lineOf(text, 'Mode'), `fixed, wall-clock anchored (${decoded.state.cadenceLabel})`)
    // The preview prints the expression this plugin *requested*; the record
    // holds the text the schedule service accepted, which canonicalizes a
    // uniform minute list into the `a-b/n` form. So the two are compared through
    // the service's own canonicalizer — which is precisely the caveat the
    // preview line discloses, and why it may not call itself durable text.
    const printedCron = lineOf(text, 'Cron').split(' (requested form;')[0]!
    assert.equal(canonicalizeCronExpression(printedCron), record.expression)
    assert.equal(canonicalizeCronExpression(record.expression ?? ''), record.expression)
    assert.ok(
      jitterLines(
        decoded.state.jitterSeconds,
        decoded.state.fingerprint,
        jitterCapMinutes(decoded.state.cadenceSeconds),
      ).includes(lineOf(text, 'Jitter')),
      `the preview's Jitter line must be the one the record carries; got "${lineOf(text, 'Jitter')}"`,
    )
    assert.equal(decoded.state.jitterSeconds, 60, 'this cadence and session must draw a real offset')
    assert.equal(
      lineOf(text, 'Jitter'),
      `60s = 1 minute(s), drawn from min(10% of the normalized cadence, 15 min) with fingerprint ${decoded.state.fingerprint}`,
    )
    // The lifetime, not the absolute instant: the preview ran a millisecond or
    // two before the start did, and a preview cannot know when a later `create`
    // will be accepted — which is exactly what "if started now" discloses.
    const lifetime = statedLifetimeMs(text, previewedAt)
    const storedLifetime = decoded.state.expiresAt - decoded.state.lastRunAt
    assert.ok(
      Math.abs(lifetime - storedLifetime) <= 2000,
      `the preview's stated lifetime (${lifetime}ms) must be the record's (${storedLifetime}ms)`,
    )
    assert.equal(storedLifetime, 7 * 86_400_000, 'the default lifetime is 7 days')
    assert.equal(lineOf(text, 'Round limit'), `24 (reaching it stops the loop and says so)`)
    assert.equal(lineOf(text, 'Title'), record.title)
    assert.equal(lineOf(text, 'Task'), `${[...(decoded.state.task ?? '')].length} code points, inline`)
    assert.equal(lineOf(text, 'Blockers'), 'none')
  } finally {
    await host.dispose()
  }
})

test('a self-paced preview and its real start agree too, and print no wall-clock lines', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-drift-self', scheduleDouble: double })
  try {
    const agent = host.caller()
    const previewedAt = Date.now()
    const preview = await host.commands.run('loop', agent, '--dry-run keep an eye on the deploy')
    assert.equal(preview.kind, 'success', preview.text)
    const text = preview.text ?? ''
    assert.equal(lineOf(text, 'Mode'), 'self-paced (the wait is replaced each round with loop_next)')
    // A self-paced loop has no wall-clock phase, so neither text prints these.
    assert.equal(hasLabel(text, 'Jitter'), false, 'a self-paced preview prints no Jitter line')
    assert.equal(hasLabel(text, 'Cron'), false, 'a self-paced preview prints no Cron line')
    assert.equal(hasLabel(text, 'First fire'), false, 'a self-paced preview prints no First fire line')
    assert.equal(double.size, 0)

    const started = await host.commands.run('loop', agent, 'keep an eye on the deploy')
    assert.equal(started.kind, 'success', started.text)
    const record = double.all()[0]!
    const decoded = decodeLoopRecord(record)
    assert.ok(decoded !== undefined)
    assert.equal(decoded.state.mode, 'self')
    assert.ok(
      Math.abs(statedLifetimeMs(text, previewedAt) - (decoded.state.expiresAt - decoded.state.lastRunAt)) <= 2000,
      'the preview must state the lifetime the record carries',
    )
    assert.equal(lineOf(text, 'Title'), record.title)
    // A self-paced loop's first wait is knowable, so the preview states it.
    assert.equal(lineOf(text, 'First wait'), '1800 seconds (self-paced safety check); round 1 would run immediately.')
  } finally {
    await host.dispose()
  }
})

test('the tool path previews the agent-armed title a real tool call stores (anti-drift, tool path)', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-drift-tool', scheduleDouble: double })
  try {
    const agent = host.caller()
    const runtime = host.rawToolRuntime()
    const preview = await runtime.execute({
      callId: 'call-dry-run' as never,
      name: 'loop_start',
      arguments: { task: 'watch the queue', cadence: 'fixed', seconds: 600, dryRun: true },
      agent: agent as never,
      signal: new AbortController().signal,
    })
    const text = (preview as { content?: { type: string; text?: string }[] }).content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('') ?? ''
    assert.notEqual((preview as { isError?: boolean }).isError, true, text)
    assert.match(text, /^Loop preview \(nothing was armed\):/u)
    // The tool's origin is `agent`, so the title it prints must be the one the
    // real call stores — `[agent] DSH /loop: …`, not the person's title.
    assert.equal(lineOf(text, 'Title'), '[agent] DSH /loop: watch the queue')
    assert.equal(double.size, 0, 'the preview must leave storage empty')

    const real = await runtime.execute({
      callId: 'call-real' as never,
      name: 'loop_start',
      arguments: { task: 'watch the queue', cadence: 'fixed', seconds: 600 },
      agent: agent as never,
      signal: new AbortController().signal,
    })
    const realText = (real as { content?: { type: string; text?: string }[] }).content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('') ?? ''
    assert.equal(double.size, 1)
    const record = double.all()[0]!
    assert.equal(record.title, '[agent] DSH /loop: watch the queue')
    assert.match(realText, /\[agent\] DSH \/loop: watch the queue/u)
    assert.equal(lineOf(text, 'Title'), record.title)
    // And the same record is what the person's path would not have produced.
    const decoded = decodeLoopRecord(record)
    assert.equal(decoded?.state.startedBy, 'agent')
  } finally {
    await host.dispose()
  }
})

test('the preview answers under every refusal condition and lists it as a blocker', async () => {
  // A group of one: each rig is booted, used and disposed in turn, because the
  // conditions live in the assembly (plan mode, the kill switch) rather than in
  // the request.
  const planModeDouble = {
    active: true,
    gets: [] as unknown[],
    get(agent: unknown): { active: boolean } {
      this.gets.push(agent)
      return { active: this.active }
    },
    set(_agent: unknown, active: boolean): void {
      this.active = active
    },
  }

  // 1. plan mode
  {
    const double = new FakeSchedule()
    const host = await bootHost({
      sessionId: 'preview-block-plan',
      scheduleDouble: double,
      services: { planMode: planModeDouble },
    })
    try {
      const result = await host.commands.run('loop', host.caller(), '--dry-run 10m watch the queue')
      assert.equal(result.kind, 'success', result.text)
      assert.equal(lineOf(result.text ?? '', 'Blockers'), PLAN_MODE_REFUSAL)
      assert.equal(double.createCalls, 0)
      assert.equal(host.agent.messages.length, 0)
    } finally {
      await host.dispose()
    }
  }

  // 2. a subagent session
  {
    const double = new FakeSchedule()
    const host = await bootHost({ sessionId: 'preview-block-subagent', scheduleDouble: double })
    try {
      const result = await host.commands.run('loop', host.caller({ origin: 'subagent' }), '--dry-run 10m watch the queue')
      assert.equal(result.kind, 'success', result.text)
      assert.equal(lineOf(result.text ?? '', 'Blockers'), 'A subagent session cannot start or stop a loop.')
      assert.equal(double.createCalls, 0)
      assert.equal(host.agent.messages.length, 0)
    } finally {
      await host.dispose()
    }
  }

  // 3. the kill switch
  {
    const double = new FakeSchedule()
    const host = await bootHost({
      sessionId: 'preview-block-kill',
      scheduleDouble: double,
      env: { DSH_DISABLE_LOOP: '1' },
    })
    try {
      const result = await host.commands.run('loop', host.caller(), '--dry-run 10m watch the queue')
      assert.equal(result.kind, 'success', result.text)
      assert.match(lineOf(result.text ?? '', 'Blockers'), /DSH_DISABLE_LOOP kill switch/u)
      // A kill-switch preview must not scan the global catalogue either.
      assert.equal(double.catalogCalls, 0, 'a preview must never run the kill switch\'s global scan')
      assert.equal(double.createCalls, 0)
      assert.equal(double.deleteCalls, 0)
      assert.equal(host.agent.messages.length, 0)
    } finally {
      await host.dispose()
    }
  }

  // 4. config.enabled: false
  {
    const double = new FakeSchedule()
    const host = await bootHost({
      sessionId: 'preview-block-disabled',
      scheduleDouble: double,
      config: { enabled: false },
    })
    try {
      const result = await host.commands.run('loop', host.caller(), '--dry-run 10m watch the queue')
      assert.equal(result.kind, 'success', result.text)
      assert.match(lineOf(result.text ?? '', 'Blockers'), /config\.enabled is false/u)
      assert.equal(double.catalogCalls, 0)
      assert.equal(double.createCalls, 0)
      assert.equal(double.deleteCalls, 0)
    } finally {
      await host.dispose()
    }
  }
})

test('every blocker gets its own line, in the order a real start would hit them', async () => {
  // All four conditions at once. `startLoop` returns on the first refusal, but a
  // preview reports every one of them — and each on its own line, so the number
  // of things standing in the way is visible at a glance. The order is the order
  // `startLoop` evaluates them in, so the first line is the refusal a real start
  // would actually hit first.
  const double = new FakeSchedule()
  const planModeDouble = {
    active: true,
    get: (): { active: boolean } => ({ active: true }),
    set: (): void => undefined,
  }
  const host = await bootHost({
    sessionId: 'preview-block-combined',
    scheduleDouble: double,
    services: { planMode: planModeDouble },
    env: { DSH_DISABLE_LOOP: '1' },
    config: { enabled: false },
  })
  try {
    // A subagent, so the first condition holds too.
    const result = await host.commands.run(
      'loop',
      host.caller({ origin: 'subagent' }),
      '--dry-run 10m watch the queue',
    )
    assert.equal(result.kind, 'success', result.text)
    const text = result.text ?? ''
    const blockerLines = text.split('\n').filter((line) => line.startsWith('Blockers: '))
    assert.equal(blockerLines.length, 4, `four conditions must be four lines; got:\n${text}`)
    // Each line carries exactly one condition, in the real evaluation order.
    assert.equal(blockerLines[0], 'Blockers: A subagent session cannot start or stop a loop.')
    assert.equal(blockerLines[1], `Blockers: ${PLAN_MODE_REFUSAL}`)
    assert.match(blockerLines[2]!, /^Blockers: The DSH_DISABLE_LOOP kill switch is set/u)
    assert.equal(blockerLines[3], 'Blockers: config.enabled is false, so no new loop may start.')
    for (const line of blockerLines) {
      assert.doesNotMatch(line, /\n/u)
    }
    // And still zero writes, with the kill switch's global scan untouched.
    assert.equal(double.catalogCalls, 0)
    assert.equal(double.createCalls, 0)
    assert.equal(double.updateCalls, 0)
    assert.equal(double.deleteCalls, 0)
    assert.equal(double.size, 0)
    assert.equal(host.agent.messages.length, 0)
  } finally {
    await host.dispose()
  }
})

test('a single blocker stays a single line, and `none` stays one line too', async () => {
  // The multi-line change must not leak into the two cases that were already
  // right: one condition is one line, and no condition is the one-line positive
  // statement.
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'preview-block-single',
    scheduleDouble: double,
    env: { DSH_DISABLE_LOOP: '1' },
  })
  try {
    const blocked = await host.commands.run('loop', host.caller(), '--dry-run 10m watch the queue')
    assert.equal(blocked.kind, 'success', blocked.text)
    const blockedLines = (blocked.text ?? '').split('\n').filter((line) => line.startsWith('Blockers: '))
    assert.equal(blockedLines.length, 1, `one condition must be one line; got:\n${blocked.text}`)
    assert.match(blockedLines[0]!, /DSH_DISABLE_LOOP kill switch/u)
  } finally {
    await host.dispose()
  }

  const clean = await bootHost({ sessionId: 'preview-block-none', scheduleDouble: new FakeSchedule() })
  try {
    const result = await clean.commands.run('loop', clean.caller(), '--dry-run 10m watch the queue')
    assert.equal(result.kind, 'success', result.text)
    const lines = (result.text ?? '').split('\n').filter((line) => line.startsWith('Blockers: '))
    assert.deepEqual(lines, ['Blockers: none'])
  } finally {
    await clean.dispose()
  }
})

test('a request that describes no loop is refused with the start path\'s own sentence', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-refusals', scheduleDouble: double, config: { maxTaskBytes: 20 } })
  try {
    const agent = host.caller()

    // Missing task: no inline task and no default task file.
    const missing = await host.commands.run('loop', agent, '--dry-run')
    assert.equal(missing.kind, 'error', missing.text)
    assert.match(missing.text ?? '', /^No task given and no default loop task file was found\./u)

    // Overlong task, counted in code points.
    const overlong = await host.commands.run('loop', agent, `--dry-run ${'x'.repeat(21)}`)
    assert.equal(overlong.kind, 'error', overlong.text)
    assert.equal(overlong.text, OVERLONG_REFUSAL(21, 20))

    // An interval the ladder refuses.
    for (const [input, expected] of [
      ['--dry-run 0m watch the queue', 'interval must be a positive duration'],
      ['--dry-run 30s watch the queue', 'interval must be at least 1 minute'],
      ['--dry-run 32d watch the queue', 'interval must be at most 31 days'],
    ] as const) {
      const result = await host.commands.run('loop', agent, input)
      assert.equal(result.kind, 'error', `${input}: ${result.text}`)
      assert.equal(result.text, expected)
    }

    // The tool's `cadence: "fixed"` without `seconds`.
    const runtime = host.rawToolRuntime()
    const noSeconds = await runtime.execute({
      callId: 'call-no-seconds' as never,
      name: 'loop_start',
      arguments: { task: 'watch the queue', cadence: 'fixed', dryRun: true },
      agent: agent as never,
      signal: new AbortController().signal,
    })
    assert.equal((noSeconds as { isError?: boolean }).isError, true)
    const noSecondsText = (noSeconds as { content?: { type: string; text?: string }[] }).content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('') ?? ''
    assert.match(noSecondsText, /cadence: "fixed" needs seconds/u)

    // Every one of those refusals wrote nothing and delivered nothing.
    assert.equal(double.createCalls, 0)
    assert.equal(double.updateCalls, 0)
    assert.equal(double.deleteCalls, 0)
    assert.equal(double.size, 0)
    assert.equal(host.agent.messages.length, 0)
  } finally {
    await host.dispose()
  }
})

test('the guards a preview may not weaken still refuse a real start', async () => {
  // The preview is allowed where a start is not; that must not have loosened the
  // start path. Each case asserts the real start still refuses, in the original
  // wording, with zero writes.
  const planModeDouble = {
    active: true,
    get: (): { active: boolean } => ({ active: true }),
    set: (): void => undefined,
  }
  {
    const double = new FakeSchedule()
    const host = await bootHost({
      sessionId: 'preview-guard-plan',
      scheduleDouble: double,
      services: { planMode: planModeDouble },
    })
    try {
      const result = await host.commands.run('loop', host.caller(), '10m watch the queue')
      assert.equal(result.kind, 'error', result.text)
      assert.equal(result.text, PLAN_MODE_REFUSAL)
      assert.equal(double.createCalls, 0)
    } finally {
      await host.dispose()
    }
  }
  {
    const double = new FakeSchedule()
    const host = await bootHost({ sessionId: 'preview-guard-subagent', scheduleDouble: double })
    try {
      const result = await host.commands.run('loop', host.caller({ origin: 'subagent' }), '10m watch the queue')
      assert.equal(result.kind, 'error', result.text)
      assert.equal(result.text, 'A subagent session cannot start or stop a loop.')
      assert.equal(double.createCalls, 0)
    } finally {
      await host.dispose()
    }
  }
  {
    const double = new FakeSchedule()
    const host = await bootHost({
      sessionId: 'preview-guard-kill',
      scheduleDouble: double,
      env: { DSH_DISABLE_LOOP: '1' },
    })
    try {
      const result = await host.commands.run('loop', host.caller(), '10m watch the queue')
      assert.equal(result.kind, 'error', result.text)
      assert.match(result.text ?? '', /kill switch/u)
      assert.equal(double.createCalls, 0)
      // The kill switch's real start DOES scan the catalogue, unlike a preview.
      assert.equal(double.catalogCalls, 1)
    } finally {
      await host.dispose()
    }
  }
})

test('Would replace reports the live loops, and admits when the read failed', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'preview-replace', scheduleDouble: double })
  try {
    const agent = host.caller()
    const first = await host.commands.run('loop', agent, 'watch the queue')
    assert.equal(first.kind, 'success', first.text)
    const live = double.all()[0]!.id.replace(/^schedule-/u, '')

    const replace = await host.commands.run('loop', agent, '--dry-run 10m watch the queue')
    assert.equal(replace.kind, 'success', replace.text)
    assert.equal(lineOf(replace.text ?? '', 'Would replace'), live)
    assert.equal(double.size, 1, 'the preview must not remove the live loop')

    // A read failure must be reported as "cannot confirm", never as "clean".
    double.breakList(true, 'storage backend exploded')
    const unreadable = await host.commands.run('loop', agent, '--dry-run 10m watch the queue')
    assert.equal(unreadable.kind, 'success', unreadable.text)
    const line = lineOf(unreadable.text ?? '', 'Would replace')
    assert.match(line, /could not be read, so this preview cannot confirm what would be replaced/u)
    assert.match(line, /storage backend exploded/u)
    assert.doesNotMatch(line, /^none$/u)
    assert.equal(double.size, 1, 'the failed read must not remove anything either')
  } finally {
    await host.dispose()
  }
})

test('a preview does not move the served projection, bump its revision or push a frame', async () => {
  // The queue's `finally` re-reads the projection after every task, previews
  // included, so "the preview changed nothing" has to hold all the way out to
  // the served value a client reads — not merely at the storage seam.
  const double = new FakeSchedule()
  const ctx = new Context()
  const registryFiber = (
    ctx as unknown as { plugin(plugin: unknown): { await(): Promise<unknown>; dispose(): Promise<void> } }
  ).plugin(SessionProjectionRegistry)
  await registryFiber.await()
  const emitRaw = (ctx as unknown as { emit(event: string, ...payload: unknown[]): void }).emit.bind(ctx)
  const host = await bootHost({ sessionId: 'preview-projection', scheduleDouble: double, ctx })
  try {
    const session = new ProbeSession('preview-projection', host.cwd)
    const asSession = session as unknown as Parameters<
      InstanceType<typeof SessionProjectionRegistry>['stateOf']
    >[0]
    const registry = (ctx as unknown as { sessionProjections: InstanceType<typeof SessionProjectionRegistry> })
      .sessionProjections
    const changes: unknown[] = []
    registry.onChanged((_session, key, value) => changes.push({ key, value }))
    emitRaw('session/created', session)
    const drive = (): void => {
      emitRaw('session/event', session, session.append('turn/start'))
    }

    const started = await host.commands.run('loop', host.caller(), '10m watch the queue')
    assert.equal(started.kind, 'success', started.text)
    // The first frame a session publishes is not a "change"; settle it before
    // measuring, or the baseline would count the loop's own arrival.
    drive()
    const before = registry.snapshot(asSession, ['loop'])
    const beforeLoop = before.values.loop
    assert.ok(beforeLoop !== undefined, 'the live loop must be projected first')
    assert.equal(beforeLoop.active, true, 'the live loop must be projected first')
    const changesBefore = changes.length

    const preview = await host.commands.run('loop', host.caller(), '--dry-run 10m watch the queue')
    assert.equal(preview.kind, 'success', preview.text)
    drive()
    const after = registry.snapshot(asSession, ['loop'])
    // The served *value* is what a client reads, and the change feed is what
    // makes it reach the client. The registry hands out a rebuilt view per read,
    // so reference identity is not the contract — the feed and the value are.
    assert.deepEqual(after.values.loop, beforeLoop, 'the served value must not move')
    assert.equal(changes.length, changesBefore, 'a preview must push no frame')

    // Control: a real start DOES move both, so the checks above can fail. It is
    // a self-paced start rather than a restart of the same rule, because the
    // same input resolves to the same facts and would not move the value.
    const real = await host.rawToolRuntime().execute({
      callId: 'call-control' as never,
      name: 'loop_start',
      arguments: { task: 'watch the queue', cadence: 'self' },
      agent: host.caller() as never,
      signal: new AbortController().signal,
    })
    assert.notEqual((real as { isError?: boolean }).isError, true)
    drive()
    assert.ok(changes.length > changesBefore, 'a real start must push a frame')
    const moved = registry.snapshot(asSession, ['loop'])
    assert.notDeepEqual(moved.values.loop, beforeLoop, 'a real start must move the served value')
  } finally {
    await host.dispose()
    await registryFiber.dispose()
  }
})

test('on the real schedule service a preview writes nothing and delivers nothing', async () => {
  // The real rig: the genuine ScheduleService over the real JSON storage
  // backend. A double can only prove what the plugin asked for; this proves what
  // the shipped service ended up holding.
  const host = await bootHost({ sessionId: 'preview-real' })
  try {
    const before = await host.schedule.catalog!()
    const beforeDeliveries = host.agent.messages.length
    const result = await host.commands.run('loop', host.caller(), '--dry-run 10m watch the queue')
    assert.equal(result.kind, 'success', result.text)
    const after = await host.schedule.catalog!()
    assert.equal(after.length, before.length, 'the catalogue must not grow')
    assert.deepEqual(
      after.map((entry) => entry.id),
      before.map((entry) => entry.id),
      'the catalogue must not change at all',
    )
    // A cron rule's next occurrence is at least a minute away, so a bounded
    // window with no delivery is an observation, not an assumption.
    await sleep(1500)
    const delivered = host.agent.messages.filter((message) => message.text.includes('[SCHEDULE REMINDER]'))
    assert.equal(delivered.length, beforeDeliveries, 'no reminder may be delivered')

    // And the real start that follows really does arm one row.
    const started = await host.commands.run('loop', host.caller(), '10m watch the queue')
    assert.equal(started.kind, 'success', started.text)
    const armed = await host.schedule.list({ sessionId: 'preview-real' as never })
    assert.equal(armed.length, 1)
  } finally {
    await host.dispose()
  }
})
