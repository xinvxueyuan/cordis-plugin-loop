/**
 * Registration surface and configuration.
 *
 * The plugin must be inert, not broken, when the schedule service is absent:
 * it registers nothing and logs one warning, and the fiber still activates.
 * @module cordis-plugin-loop/test/register
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { DEFAULT_CONFIG, killSwitchFromEnv, resolveConfig } from '../src/config.ts'
import { loopMessage, type PlanModeLike } from '../src/index.ts'
import { bootHost } from './harness.ts'
import { FakeSchedule } from './fake-schedule.ts'

/** Run one registered tool through the real tool registry. */
async function runTool(
  host: Awaited<ReturnType<typeof bootHost>>,
  name: string,
  args: Record<string, unknown>,
  agent: unknown,
): Promise<{ text: string; isError: boolean }> {
  const result = await host.rawToolRuntime().execute({
    callId: `call-${name}`,
    name,
    arguments: args,
    agent: agent as never,
    signal: new AbortController().signal,
  })
  const shaped = result as { content?: { type: string; text?: string }[]; isError?: boolean }
  const text = (shaped.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  return { text, isError: shaped.isError === true }
}

test('with a schedule service the plugin registers one command and two tools', async () => {
  const host = await bootHost({ sessionId: 'register', scheduleDouble: new FakeSchedule() })
  try {
    assert.deepEqual(
      host.commands.definitions.map((entry) => entry.name),
      ['loop'],
    )
    const definition = host.commands.definitions[0]!
    assert.equal(definition.definitionId, '@xinvxueyuan/cordis-plugin-loop')
    assert.equal(definition.hint, '[<interval>] [<task>] | status | stop [<id>|all]')
    assert.equal(
      definition.description,
      'Run a task now, then keep checking it on a cadence',
      'the menu line keeps the short, built-in-sized wording',
    )
    assert.equal(definition.attachments, false, 'the command takes no composer attachments')
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_stop'])
    assert.deepEqual(host.warnings, [], 'the healthy path logs no warning')
  } finally {
    await host.dispose()
  }
})

test('starting a loop delivers exactly one first round, with the task text and its own source kind', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    const result = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(result.kind, 'success', result.text)
    // Exactly one delivery, and it is round one — not a cron ping, not a duplicate.
    assert.equal(host.agent.messages.length, 1, `saw ${host.agent.messages.length} deliveries`)
    const first = host.agent.messages[0]!
    assert.match(first.text, /A \/loop is now active in this session/u)
    assert.match(first.text, /This is round 1 and it starts immediately/u)
    assert.match(first.text, /round_context: '\{"loop":true,"round":1/u)
    assert.match(first.text, /check the build/u)
    assert.match(first.text, /Schedule id: 1/u)
    assert.equal(first.sourceKind, 'loop', 'the round carries this plugin\'s own source kind, not a borrowed one')
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'createUserMessage minted the host MessageId')
    console.log(`--- first round delivered ---\nid: ${first.id}\nsource: ${first.sourceKind}\n${first.text}`)
  } finally {
    await host.dispose()
  }
})

test('two injections in a row are both accepted, each with its own id', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    const started = await host.commands.run('loop', host.caller(), ' check the build')
    assert.equal(started.kind, 'success', started.text)
    // The second injection is where a missing id bites: the inbox already holds
    // "undefined", so a start that follows the old hand-rolled shape throws
    // `message "undefined" is already pending` before it can deliver.
    const replaced = await host.commands.run('loop', host.caller(), ' check the deploy')
    assert.equal(replaced.kind, 'success', replaced.text)
    assert.equal(host.agent.messages.length, 2, 'both rounds were injected')
    const [first, second] = host.agent.messages
    assert.notEqual(first!.id, second!.id, 'ids must differ, or the inbox treats the second as a duplicate')
    assert.equal(second!.sourceKind, 'loop')
    assert.match(second!.text, /check the deploy/u)
    assert.equal((await double.list({ sessionId: 'register' })).length, 1, 'the record count still holds at one')
  } finally {
    await host.dispose()
  }
})

test('the message double enforces the host inbox rules', async () => {
  const host = await bootHost({ sessionId: 'register', scheduleDouble: new FakeSchedule() })
  try {
    const agent = host.agent
    // A message without an id is the shape this project shipped once: the host's
    // inbox keeps "undefined" pending and refuses the next injection.
    assert.throws(
      () => agent.followup({ content: [{ type: 'text', text: 'no id' }], source: { kind: 'loop' } }),
      /requires a message id/u,
    )
    const message = loopMessage('first')
    agent.followup(message)
    assert.throws(() => agent.followup({ ...message }), /is already pending/u, 'the same pending id must be refused')
    agent.settle()
    agent.followup({ ...message })
    assert.equal(agent.messages.length, 2, 'once the turn consumed it, the id is reusable')
  } finally {
    await host.dispose()
  }
})

test('a refused replace never claims the previous loop was removed', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    const first = (await double.list({ sessionId: 'register' }))[0]!
    double.deleteFails = true
    const replaced = await host.commands.run('loop', host.caller(), ' 2h check the deploy')
    assert.equal(replaced.kind, 'success', replaced.text)
    assert.doesNotMatch(replaced.text ?? '', /replaced 1 previous loop/u, 'the removal did not happen')
    assert.match(replaced.text ?? '', /1 previous record\(s\) could not be removed and are still armed/u)
    const rows = await double.list({ sessionId: 'register' })
    assert.equal(rows.length, 2, 'both rows exist, and the text says so')
    assert.ok(rows.some((row) => row.id === first.id), 'the old row survived')
    assert.ok(
      host.warnings.some((line) => line.includes('left') && line.includes('in place')),
      `expected a warn about the record left in place, saw: ${host.warnings.join(' | ')}`,
    )
  } finally {
    await host.dispose()
  }
})

test('a replace that does remove the previous loop still says so', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    await host.commands.run('loop', host.caller(), ' 10m check the build')
    const replaced = await host.commands.run('loop', host.caller(), ' 2h check the deploy')
    assert.equal(replaced.kind, 'success', replaced.text)
    assert.match(replaced.text ?? '', /Loop restarted \(replaced 1 previous loop\)\./u)
    assert.equal((await double.list({ sessionId: 'register' })).length, 1)
  } finally {
    await host.dispose()
  }
})

test('a failed first-round delivery leaves no armed record and reports it friendly', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    host.failNextDelivery('the inbox is closed')
    const result = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(result.kind, 'error', result.text)
    assert.match(result.text ?? '', /Could not deliver the first round, so no loop was armed: the inbox is closed/u)
    assert.equal(double.size, 0, 'a failed delivery must leave zero records')
    assert.equal(double.createCalls, 1, 'the create is expected, then rolled back')
    assert.equal(double.deleteCalls, 1, 'the rollback must delete it')
    assert.equal(host.agent.messages.length, 0)
  } finally {
    await host.dispose()
  }
})

test('a failed first-round delivery does not disturb the loop it was replacing', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    const live = (await double.list({ sessionId: 'register' }))[0]!
    host.failNextDelivery('the inbox is closed')
    const replaced = await host.commands.run('loop', host.caller(), ' 2h check the deploy')
    assert.equal(replaced.kind, 'error', replaced.text)
    assert.match(replaced.text ?? '', /Could not deliver the first round, so no loop was armed/u)
    const remaining = await double.list({ sessionId: 'register' })
    assert.equal(remaining.length, 1, 'the previous loop must still be the live one')
    assert.equal(remaining[0]!.id, live.id, 'and it must keep its id')
    assert.match(remaining[0]!.prompt, /check the build/u, 'with its original task')
    assert.equal(host.agent.messages.length, 1, 'only the original first round was delivered')
  } finally {
    await host.dispose()
  }
})

test('the plan-mode refusal and the delivery failure both reach the model as failed calls', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double, services: { planMode: planModeDouble(true) } })
  try {
    const refused = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(refused.kind, 'error')
    assert.equal(double.size, 0)
    const status = await host.commands.run('loop', host.caller(), 'status')
    assert.equal(status.kind, 'success', 'status stays readable while planning')
    assert.match(status.text ?? '', /No loop is active/u)
  } finally {
    await host.dispose()
  }
})

test('the live command runtime admits the definition and runs it end to end', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    // Discovery and invocation both go through the real registry.
    const definition = host.commands.find('loop', host.caller())
    assert.ok(definition !== undefined, 'the real registry must expose the loop command')
    assert.equal(definition.definitionId, '@xinvxueyuan/cordis-plugin-loop')
    assert.equal(host.commands.parse('/loop status')?.name, 'loop')

    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    assert.equal(double.size, 1)
    // The real runtime logs its command/run + command/done pair.
    assert.deepEqual(
      host.agent.lifecycle.map((entry) => entry.type),
      ['command/run', 'command/done'],
    )

    const status = await host.commands.run('loop', host.caller(), 'status')
    assert.equal(status.kind, 'success', status.text)
    assert.match(status.text ?? '', /every 10 minutes/u)
  } finally {
    await host.dispose()
  }
})

test('without a schedule service the plugin is inert: nothing registered, one warning, still active', async () => {
  const host = await bootHost({ sessionId: 'register', withoutSchedule: true })
  try {
    assert.equal(host.hasScheduleService, false)
    assert.deepEqual(host.commands.definitions, [], 'no command may be registered')
    assert.deepEqual(host.toolNames, [], 'no tool may be registered')
    assert.equal(host.warnings.length, 1, `expected exactly one warning, saw: ${host.warnings.join(' | ')}`)
    assert.match(host.warnings[0]!, /schedule service is not composed/u)
    assert.match(host.warnings[0]!, /inert/u)
    assert.equal(host.pluginState(), 2, 'the plugin fiber must still be ACTIVE')
  } finally {
    await host.dispose()
  }
})

test('without a command registry the tools still register, and one warning explains the gap', async () => {
  const host = await bootHost({ sessionId: 'register', scheduleDouble: new FakeSchedule(), withoutCommands: true })
  try {
    assert.deepEqual(host.commands.definitions, [])
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_stop'])
    assert.equal(host.warnings.length, 1)
    assert.match(host.warnings[0]!, /command registry is not composed/u)
  } finally {
    await host.dispose()
  }
})

/**
 * The public surface of the host's plan-mode service, taken from the real class.
 *
 * Deriving it from `PlanModeController` instead of restating the shape by hand is
 * the point: a host-side rename or a changed return type breaks the double at
 * `tsc` time. The hand-written `{ active: boolean }` shape this replaced is what
 * once let a permanently-false predicate pass a fully green suite.
 */
type PlanModeSurface = Pick<PlanModeController, 'get' | 'set'>

/**
 * Compile-time bridge between the plugin's own seam and the host's signature.
 *
 * `src/index.ts` cannot name the host type: `@deepseek-ai/dsh-plan-mode` is a
 * devDependency, and a type from it in the emitted `lib/index.d.ts` would break
 * consumers that never install it. So the seam (`PlanModeLike`) is hand-written
 * and this file — which does have the real class — is what ties the two
 * together: change the host's `get` signature and the assertions below stop
 * compiling, which is the only way this seam can be caught drifting.
 *
 * The seam is intentionally *looser* than the host (it accepts `unknown` and
 * tolerates an absent service), so the two are not mutually assignable; each
 * assertion therefore covers one thing the probe actually relies on.
 */
type HostGet = PlanModeController['get']
type HostState = ReturnType<HostGet>
type SeamState = NonNullable<ReturnType<PlanModeLike['get']>>

/** The host still exposes the exact method the seam reads. */
const hostStillHasGet: 'get' extends keyof PlanModeController ? true : never = true
/** The host's state still satisfies the seam's (looser) state type. */
const hostStateFitsSeam: HostState extends SeamState ? true : never = true
/** `active` is still a boolean, so the probe's `=== true` remains meaningful. */
const activeIsBoolean: HostState['active'] extends boolean ? true : never = true
/** The seam still asks with an argument the host accepts (the live agent). */
const seamArgAccepted: Parameters<HostGet>[0] extends Parameters<PlanModeLike['get']>[0] ? true : never =
  true

void hostStillHasGet
void hostStateFitsSeam
void activeIsBoolean
void seamArgAccepted

/** The plan-mode double: the real surface plus the test's own bookkeeping. */
interface PlanModeDouble extends PlanModeSurface {
  /** Every `get` call, so a test can prove the probe ran. */
  readonly gets: unknown[]
  /** Whether plan mode is currently selected. */
  value: boolean
}

/**
 * A plan-mode double in the host's real shape.
 *
 * `@deepseek-ai/dsh-plan-mode` answers `get(agent)` with `{ active }` — plus
 * `pending` while a selection waits for the next accepted in-turn pre-step — and
 * selects with `set(agent, active)`. It has **no** service-level `active`
 * property, so the double only offers `get`/`set`; `get` reports `{ active }`
 * alone, which is exactly the host's shape when nothing is pending.
 *
 * @param active - Initial selection.
 * @returns The double.
 */
function planModeDouble(active: boolean): PlanModeDouble {
  const gets: unknown[] = []
  const double: PlanModeDouble = {
    gets,
    value: active,
    get(agent: unknown) {
      gets.push(agent)
      return { active: double.value }
    },
    set(agent: unknown, next: boolean): 'committed' {
      void agent
      double.value = next
      return 'committed'
    },
  }
  return double
}

test('an active plan mode refuses a start through the real context lookup', async () => {
  const planMode = planModeDouble(true)
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'register',
    scheduleDouble: double,
    services: { planMode },
  })
  try {
    const caller = host.caller()
    const result = await host.commands.run('loop', caller, '10m check the build')
    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /Plan mode is active/u)
    assert.equal(double.size, 0, 'plan mode must create zero records')
    assert.equal(double.createCalls, 0, 'no create may run before the refusal')
    assert.equal(double.deleteCalls, 0, 'no delete may run before the refusal')
    assert.ok(planMode.gets.length >= 1, 'the probe must go through get(agent)')
    assert.equal(planMode.gets[0], caller, 'the probe must be evaluated with the calling agent')
  } finally {
    await host.dispose()
  }
})

test('plan mode refuses a start even when the kill switch would also fire, with zero storage changes', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'register',
    scheduleDouble: double,
    services: { planMode: planModeDouble(true) },
    env: { DSH_DISABLE_LOOP: '1' },
  })
  try {
    const started = await host.commands.run('loop', host.caller(), '10m check the build')
    assert.equal(started.kind, 'error', started.text)
    assert.match(started.text ?? '', /Plan mode is active/u)
    assert.doesNotMatch(started.text ?? '', /cancelled/u, 'the cancel path must not run while planning')
    assert.equal(double.createCalls, 0)
    assert.equal(double.deleteCalls, 0)
    assert.equal(double.size, 0)
  } finally {
    await host.dispose()
  }
})

test('an inactive plan mode does not block a start', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'register',
    scheduleDouble: double,
    services: { planMode: planModeDouble(false) },
  })
  try {
    const result = await host.commands.run('loop', host.caller(), '10m check the build')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(double.size, 1)
  } finally {
    await host.dispose()
  }
})

test('a plan mode that flips on stops new loops and leaves the live one alone', async () => {
  const planMode = planModeDouble(false)
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'register',
    scheduleDouble: double,
    services: { planMode },
  })
  try {
    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    assert.equal(double.size, 1)
    planMode.value = true
    const refused = await host.commands.run('loop', host.caller(), ' 10m check the deploy')
    assert.equal(refused.kind, 'error', refused.text)
    assert.match(refused.text ?? '', /Plan mode is active/u)
    assert.equal(double.size, 1, 'the existing loop must survive a refused start')
    assert.equal(double.deleteCalls, 0, 'a refusal must not delete anything')
    // Stopping stays available while planning: a live loop must be cancellable.
    const stopped = await host.commands.run('loop', host.caller(), 'stop all')
    assert.equal(stopped.kind, 'success', stopped.text)
    assert.equal(double.size, 0)
  } finally {
    await host.dispose()
  }
})

test('the kill switch is honoured through the real apply path', async () => {
  const host = await bootHost({
    sessionId: 'register',
    scheduleDouble: new FakeSchedule(),
    env: { DSH_DISABLE_LOOP: '1' },
  })
  try {
    const result = await host.commands.run('loop', host.agent, '10m check the build')
    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /DSH_DISABLE_LOOP/u)
    assert.equal(host.scheduleDoubleSize(), 0)
  } finally {
    await host.dispose()
  }
})

test('the kill switch cancels a live loop through the double catalogue and logs its task', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'register', scheduleDouble: double })
  try {
    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    assert.equal(double.size, 1)

    process.env['DSH_DISABLE_LOOP'] = '1'
    try {
      const blocked = await host.commands.run('loop', host.caller(), ' 10m check the deploy')
      assert.equal(blocked.kind, 'error', blocked.text)
      assert.match(blocked.text ?? '', /1 existing loop\(s\) were cancelled/u)
    } finally {
      delete process.env['DSH_DISABLE_LOOP']
    }
    assert.equal(double.size, 0, 'the live loop must be gone')
    assert.ok(double.catalogCalls >= 1, 'discovery must have run through catalog()')
    const cancelLog = host.warnings.find((line) => line.includes('cancelling'))
    assert.ok(cancelLog !== undefined, `expected a cancelling log line, saw: ${host.warnings.join(' | ')}`)
    assert.match(cancelLog, /task: check the build/u)
  } finally {
    await host.dispose()
  }
})

test('the kill switch cancels a live loop against the REAL schedule service', async () => {
  // The regression this locks: `catalogFn` used to be handed the forwarding
  // adapter, which never exposes `catalog`, so this path silently cancelled
  // nothing while every test stayed green.
  const host = await bootHost({ sessionId: 'register' })
  try {
    assert.equal(host.hasScheduleService, true)
    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    const live = await host.schedule.list({ sessionId: 'register' as never })
    assert.equal(live.length, 1)

    process.env['DSH_DISABLE_LOOP'] = '1'
    try {
      const blocked = await host.commands.run('loop', host.caller(), ' 10m check the deploy')
      assert.equal(blocked.kind, 'error', blocked.text)
      assert.match(blocked.text ?? '', /1 existing loop\(s\) were cancelled/u)
    } finally {
      delete process.env['DSH_DISABLE_LOOP']
    }
    const remaining = await host.schedule.list({ sessionId: 'register' as never })
    assert.equal(remaining.length, 0, 'the real service must really have deleted the row')
    const cancelLog = host.warnings.find((line) => line.includes('cancelling'))
    assert.ok(cancelLog !== undefined, `expected a cancelling log line, saw: ${host.warnings.join(' | ')}`)
    assert.match(cancelLog, /task: check the build/u)
  } finally {
    await host.dispose()
  }
})

test('the resolved time zone is the one the record stores', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'register',
    scheduleDouble: double,
    services: { timeContext: { timeZone: 'Europe/Berlin' } },
  })
  try {
    const result = await host.commands.run('loop', host.agent, '10m check the build')
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text ?? '', /time zone Europe\/Berlin/u)
    assert.equal(double.all()[0]!.timeZone, 'Europe/Berlin')
  } finally {
    await host.dispose()
  }
})

test('configuration: every default is resolved and the documented values hold', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(resolveConfig({}), { ...DEFAULT_CONFIG })
  assert.equal(DEFAULT_CONFIG.lifetimeDays, 7)
  assert.equal(DEFAULT_CONFIG.safetyCheckSeconds, 1800)
  assert.equal(DEFAULT_CONFIG.omissionCheckSeconds, 1200)
  assert.equal(DEFAULT_CONFIG.minNextSeconds, 60)
  assert.equal(DEFAULT_CONFIG.maxNextSeconds, 3600)
  assert.equal(DEFAULT_CONFIG.maxTaskBytes, 25000)
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.deepEqual(resolveConfig({ enabled: false, lifetimeDays: 1 }), { ...DEFAULT_CONFIG, enabled: false, lifetimeDays: 1 })
})

test('configuration: a wrong shape is rejected instead of silently defaulted', () => {
  const cases: [unknown, RegExp][] = [
    [{ enabled: 'yes' }, /enabled must be a boolean/u],
    [{ lifetimeDays: 0 }, /lifetimeDays must be between/u],
    [{ lifetimeDays: 1.5 }, /lifetimeDays must be a safe integer/u],
    [{ maxTaskBytes: 0 }, /maxTaskBytes must be between/u],
    [{ safetyCheckSeconds: 10 }, /safetyCheckSeconds must be between/u],
    [{ minNextSeconds: 3600, maxNextSeconds: 60 }, /minNextSeconds must not exceed/u],
    ['nope', /config must be an object/u],
  ]
  for (const [input, expected] of cases) {
    assert.throws(() => resolveConfig(input), expected, `input ${JSON.stringify(input)} must be rejected`)
  }
})

test('the kill switch reads only an affirmative value', () => {
  for (const value of ['1', 'true', 'yes', 'on', ' TRUE ', 'anything']) {
    assert.equal(killSwitchFromEnv({ DSH_DISABLE_LOOP: value }), true, `"${value}" must disable`)
  }
  for (const value of ['', '0', 'false', 'off', 'no', 'disabled', ' OFF ']) {
    assert.equal(killSwitchFromEnv({ DSH_DISABLE_LOOP: value }), false, `"${value}" must not disable`)
  }
  assert.equal(killSwitchFromEnv({}), false)
})
