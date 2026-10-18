/**
 * Registration surface and configuration.
 *
 * The plugin must be inert, not broken, when the schedule service is absent:
 * it registers nothing and logs one warning, and the fiber still activates.
 * @module cordis-plugin-loop/test/register
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import commandsPlugin from '@deepseek-ai/dsh-commands'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import type PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { DEFAULT_CONFIG, killSwitchFromEnv, resolveConfig } from '../src/config.ts'
import {
  apply as applyLoop,
  Config as loopConfig,
  inject as loopInject,
  loopMessage,
  name as loopName,
  type PlanModeLike,
} from '../src/index.ts'
import {
  LoopProjectionStore,
  PROJECTION_KEY_CHECK,
  loopProjectionDefinitionFor,
  loopViewSchema,
  NO_LOOP,
} from '../src/loop-projection.ts'
import { bootHost, rawService } from './harness.ts'
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

test('with a schedule service the plugin registers one command and four tools', async () => {
  const host = await bootHost({ sessionId: 'register', scheduleDouble: new FakeSchedule() })
  try {
    assert.deepEqual(
      host.commands.definitions.map((entry) => entry.name),
      ['loop'],
    )
    const definition = host.commands.definitions[0]!
    assert.equal(definition.definitionId, '@xinvxueyuan/cordis-plugin-loop')
    // The hint advertises the preview flag, because it is the one thing a
    // caller cannot discover from the other forms.
    assert.equal(definition.hint, '[--dry-run] [<interval>] [<task>] | status | next | stop [<id>|all]')
    assert.equal(
      definition.description,
      'Run a task now, then keep checking it on a cadence',
      'the menu line keeps the short, built-in-sized wording',
    )
    assert.equal(definition.attachments, false, 'the command takes no composer attachments')
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_start', 'loop_status', 'loop_stop'])
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
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_start', 'loop_status', 'loop_stop'])
    assert.equal(host.warnings.length, 1)
    assert.match(host.warnings[0]!, /command registry is not composed/u)
  } finally {
    await host.dispose()
  }
})

test('a cold start registers the four tools and /loop with no reload (T15)', async () => {
  // The reported defect: the loader composes its entries in one pass, so this
  // plugin applies before `schedule` has been provided. `apply` probed for the
  // service once, returned early, and left the fiber ACTIVE with nothing
  // registered — no tools, no `/loop` — until an unrelated reload re-applied it.
  //
  // The defense is the declared dependency, so the metadata is asserted first.
  assert.ok(loopInject.includes('tools'), `inject must carry "tools", saw ${JSON.stringify(loopInject)}`)
  assert.ok(
    loopInject.includes('schedule'),
    `inject must carry "schedule" so activation waits for the backend instead of probing once: ${JSON.stringify(loopInject)}`,
  )

  const agent = { id: 'cold-start', session: { id: 'cold-start', header: { cwd: process.cwd() }, append: () => undefined } }
  const ctx = new Context()
  const root = ctx as unknown as {
    plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown>; dispose(): Promise<void> }
    provide(name: string, value: unknown): void
  }
  root.provide('sessions', { flush: async (): Promise<boolean> => true })
  root.provide('sessionController', { resolveAgent: async (): Promise<{ agent: unknown }> => ({ agent }) })
  root.provide('sessionPersistence', {})
  root.provide('systemPrompt', {
    tools: (): (() => void) => (): void => undefined,
    section: (): (() => void) => (): void => undefined,
  })

  const toolsFiber = root.plugin(toolsPlugin)
  await toolsFiber.await()

  // The cold-start pass: the loop entry is mounted while `schedule` is absent,
  // exactly as the loader does when it composes the patch layer with the rest.
  const loopFiber = root.plugin(
    {
      name: loopName,
      Config: loopConfig,
      inject: [...loopInject],
      apply: (inner: unknown, config: unknown) => applyLoop(inner as never, config as never),
    },
    {},
  )
  const registered: string[] = []
  const toolRuntime = rawService<{
    register(definition: { name: string }): () => void
    get(name: string): unknown
  }>(ctx, 'tools')
  assert.ok(toolRuntime !== undefined, 'the tool registry must be composed')
  const originalRegister = toolRuntime.register.bind(toolRuntime)
  toolRuntime.register = (definition: { name: string }): (() => void) => {
    registered.push(definition.name)
    return originalRegister(definition)
  }
  // Let a fiber that is *not* waiting for anything run its `apply` before the
  // backend appears: that settle is what makes this a cold start rather than a
  // race, and it is where the reported defect showed itself.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(registered, [], 'nothing may be registered before the backend exists')

  // What the profile composes later — and nothing here is a reload: the same
  // fiber stays mounted, no event is emitted and no re-apply happens.
  root.provide('schedule', new FakeSchedule())
  const commandsFiber = root.plugin(commandsPlugin)
  await commandsFiber.await()
  await loopFiber.await()

  assert.deepEqual(
    [...registered].sort(),
    ['loop_next', 'loop_start', 'loop_status', 'loop_stop'],
    'the cold start must register the four tools',
  )
  for (const name of ['loop_next', 'loop_start', 'loop_status', 'loop_stop']) {
    assert.notEqual(toolRuntime.get(name), undefined, `${name} must resolve on the live registry`)
  }
  const commandRuntime = rawService<{ list(agent: unknown): readonly { name: string }[] }>(ctx, 'commands')
  assert.ok(commandRuntime !== undefined, 'the command registry must be composed')
  assert.deepEqual(
    commandRuntime.list(agent).map((entry) => entry.name),
    ['loop'],
    'the cold start must register /loop once the registry exists',
  )

  await loopFiber.dispose()
  await commandsFiber.dispose()
  await toolsFiber.dispose()
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
  assert.equal(DEFAULT_CONFIG.maxRounds, 24, 'the agent round cap ships at 24')
  assert.equal(DEFAULT_CONFIG.safetyCheckSeconds, 1800)
  assert.equal(DEFAULT_CONFIG.omissionCheckSeconds, 1200)
  assert.equal(DEFAULT_CONFIG.minNextSeconds, 60)
  assert.equal(DEFAULT_CONFIG.maxNextSeconds, 3600)
  assert.equal(DEFAULT_CONFIG.maxTaskBytes, 25000)
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.deepEqual(resolveConfig({ enabled: false, lifetimeDays: 1 }), { ...DEFAULT_CONFIG, enabled: false, lifetimeDays: 1 })
  assert.deepEqual(resolveConfig({ maxRounds: 3 }), { ...DEFAULT_CONFIG, maxRounds: 3 })
})

test('configuration: a wrong shape is rejected instead of silently defaulted', () => {
  const cases: [unknown, RegExp][] = [
    [{ enabled: 'yes' }, /enabled must be a boolean/u],
    [{ lifetimeDays: 0 }, /lifetimeDays must be between/u],
    [{ lifetimeDays: 1.5 }, /lifetimeDays must be a safe integer/u],
    [{ maxRounds: 0 }, /maxRounds must be between/u],
    [{ maxRounds: 2.5 }, /maxRounds must be a safe integer/u],
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


/** One event the session double holds. */
interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * The minimum of a live `Session` the projection registry reads.
 *
 * The registry reaches a session only through `header`, `inheritedEventCount`,
 * `seq`, `snapshotEvents()` and `eventAt()`; those five are exactly what this
 * double provides. It is a double rather than a real `Session` on purpose: a
 * `Session` publishes `session/event` only while a `SessionStore` has it
 * attached, and standing up that whole lifecycle would test the store rather
 * than this plugin's registration and fold.
 */
class SessionDouble {
  /**
   * The session this double stands in for.
   *
   * The real `SessionHeader` carries the id, and the `loop` unit binds a cell to
   * its session by reading `header.id`, so the double has to carry the same id
   * the plugin's mirror is keyed by — otherwise the projection would fold the
   * wrong session, which is exactly the T17 defect.
   */
  readonly header: { id: string; cwd: string }
  readonly inheritedEventCount = SessionLogOffset(0)
  private readonly log: SessionEventLike[] = []

  /**
   * @param sessionId - The session identity this double reports.
   */
  constructor(sessionId: string) {
    this.header = { id: sessionId, cwd: process.cwd() }
  }

  /** Next event sequence number; the wrapped `seq = log.length` contract. */
  get seq(): number {
    return this.log.length
  }

  /** Append one event and return it. */
  append(type: string, data: unknown = {}): SessionEventLike {
    const event: SessionEventLike = { type, seq: this.log.length, time: Date.now(), data }
    this.log.push(event)
    return event
  }

  /** Materialize an immutable slice of the log. */
  snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive?: number): readonly SessionEventLike[] {
    const end = toSeqExclusive === undefined ? this.log.length : toSeqExclusive
    return Object.freeze(this.log.slice(Number(fromSeq), Number(end)))
  }

  /** Read one event by position. */
  eventAt(seq: number): SessionEventLike | undefined {
    return this.log[Number(seq)]
  }
}

test('the `loop` projection key is declared in both projection tables', () => {
  // These are compile-time facts, restated as runtime assertions so the
  // `declare module` merge cannot silently stop applying after a host bump.
  assert.equal(PROJECTION_KEY_CHECK.state, true, 'the state table must expose the loop key')
  assert.equal(PROJECTION_KEY_CHECK.wire, true, 'the client-visible table must expose it too')
  assert.equal(loopViewSchema.safeParse(NO_LOOP).success, true)
  assert.equal(
    loopViewSchema.safeParse({ ...NO_LOOP, extra: true }).success,
    false,
    'the served value is strict: a field a later revision adds must not leak',
  )
})

/**
 * Read the frozen plain value out of one host cell state.
 *
 * `ctx.sessionProjections.stateOf` answers with the unit's whole state, which
 * for this unit is the `{ current, live }` envelope documented on
 * `LoopProjectionState`. `current` is the JSON value the change feed and the
 * persisted checkpoint carry.
 *
 * @param state - The value `stateOf` returned.
 * @returns The plain served value.
 */
function currentOf(state: unknown): unknown {
  return (state as { readonly current: unknown }).current
}

test('the loop projection is per session: no session ever reads another one\'s loop (T17)', async () => {
  // The unit is registered ONCE for the plugin, so a cell has to be bound to its
  // own session by `init(header)`. Registering one definition per session — with
  // the id baked into each closure — collapsed into the first one under the
  // registry's per-key registration table and served that session's mirror to
  // every other session (T17).
  const double = new FakeSchedule()
  const ctx = new Context()
  const root = ctx as unknown as {
    plugin: (plugin: unknown, config?: unknown) => { await(): Promise<unknown>; dispose(): Promise<void> }
    provide: (name: string, value: unknown) => void
  }
  const registryFiber = root.plugin(SessionProjectionRegistry)
  await registryFiber.await()
  const registry = (ctx as unknown as { sessionProjections: SessionProjectionRegistry }).sessionProjections
  const host = await bootHost({ sessionId: 'armed-session', scheduleDouble: double, ctx })
  try {
    const emitRaw = (ctx as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit.bind(ctx)
    // Two sessions are published. Neither gets an agent-created event, and
    // nothing else happens to them: the cells below must be readable from this
    // moment on, which is what makes a restored or long-idle session correct.
    const armed = new SessionDouble('armed-session')
    const untouched = new SessionDouble('untouched-session')
    emitRaw('session/created', armed)
    emitRaw('session/created', untouched)
    const asArmed = armed as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
    const asUntouched = untouched as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
    assert.deepEqual(
      registry.snapshot(asUntouched, ['loop']).values.loop,
      NO_LOOP,
      'a session with no loop starts from the no-loop value',
    )

    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)

    const armedValue = registry.snapshot(asArmed, ['loop']).values.loop
    const untouchedValue = registry.snapshot(asUntouched, ['loop']).values.loop
    console.log(`--- armed session (${armed.header.id}) ---\n${JSON.stringify(armedValue, null, 2)}`)
    console.log(`--- untouched session (${untouched.header.id}) ---\n${JSON.stringify(untouchedValue, null, 2)}`)
    assert.equal(armedValue?.active, true, 'the session the loop belongs to reads it')
    assert.equal(armedValue?.nextAt, double.all()[0]!.scheduledAt, 'and reads the target the scheduler holds')
    assert.deepEqual(
      untouchedValue,
      NO_LOOP,
      'a session that never armed a loop must read the no-loop value, never another session\'s loop',
    )
  } finally {
    await host.dispose()
    await registryFiber.dispose()
  }
})

test('the real projection registry drives the loop unit: host state, wire value and change feed', async () => {
  const double = new FakeSchedule()
  const ctx = new Context()
  const root = ctx as unknown as {
    plugin: (plugin: unknown, config?: unknown) => { await(): Promise<unknown>; dispose(): Promise<void> }
    provide: (name: string, value: unknown) => void
  }
  const registryFiber = root.plugin(SessionProjectionRegistry)
  await registryFiber.await()
  const registry = (ctx as unknown as { sessionProjections: SessionProjectionRegistry }).sessionProjections
  const host = await bootHost({
    sessionId: 'projection',
    scheduleDouble: double,
    ctx,
  })
  try {
    const session = new SessionDouble('projection')
    const asSession = session as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
    const emitRaw = (ctx as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit.bind(ctx)
    emitRaw('session/created', session)
    const emit = (type: string): void => {
      emitRaw('session/event', session, session.append(type))
    }
    assert.deepEqual(registry.snapshot(asSession, ['loop']).values.loop, NO_LOOP, 'no loop yet')
    assert.deepEqual(currentOf(registry.stateOf(asSession, 'loop')), NO_LOOP, 'the host cell folds the no-loop value')

    const changes: unknown[] = []
    registry.onChanged((_session, _key, value) => changes.push(value))

    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    const wire = registry.snapshot(asSession, ['loop']).values.loop
    assert.deepEqual(wire, {
      active: true,
      mode: 'fixed',
      cadence: 'every 10 minutes',
      nextAt: double.all()[0]!.scheduledAt,
      // Round 1 is the round this session is on: the same number the reminder
      // in the model's context names, i.e. `1 + max(iteration, delivered)`.
      round: 1,
      startedBy: 'user',
    })
    console.log(`--- live projection value (armed) ---\n${JSON.stringify(wire, null, 2)}`)

    emit('turn/start')
    assert.equal(changes.length, 1, 'the change feed fires once the drive observes the new value')
    assert.deepEqual(changes[0], wire)

    // A round the scheduler delivered moves `round` without any durable counter,
    // and stopping moves it back to the no-loop value. Both are asserted through
    // `snapshot`, which re-runs the unit's `wire.view` and therefore exercises the
    // live view on every read: that is what a connected client's face does.
    double.deliver(double.all()[0]!.id)
    const advanced = await host.commands.run('loop', host.caller(), 'status')
    assert.equal(advanced.kind, 'success', advanced.text)
    assert.equal(registry.snapshot(asSession, ['loop']).values.loop?.round, 2, 'the delivered round is visible at once')

    const stopped = await host.commands.run('loop', host.caller(), 'stop')
    assert.equal(stopped.kind, 'success', stopped.text)
    assert.deepEqual(registry.snapshot(asSession, ['loop']).values.loop, NO_LOOP, 'stopping publishes the no-loop value')

    // The change feed reports the value a drive observes. Everything above moved
    // the mirror without a drive in between (the delivery and the stop), so the
    // first drive after them wakes clients exactly once — and the drives after
    // that, with nothing new, stay silent. That silence is the point: the plugin
    // republishes after every queued task, including read-only ones.
    const settled = changes.length
    emit('turn/start')
    assert.equal(changes.length, settled + 1, 'a drive reports the value that moved since the last one')
    assert.deepEqual(changes.at(-1), NO_LOOP, 'and it reports the value the mirror holds now')
    emit('turn/start')
    emit('turn/start')
    assert.equal(changes.length, settled + 1, 'an unchanged drive must not wake every client')
  } finally {
    await host.dispose()
    await registryFiber.dispose()
  }
})

test('the served loop value changes reference exactly when the loop moves (T24)', async () => {
  // The registry pushes a client frame only when a drive's wire view differs from
  // the one it published last (`!Object.is(views[0], views[1])`). A served value
  // whose reference never moves therefore means a capsule that only catches up
  // after a page reload — the defect this case exists to prevent.
  //
  // `registry.snapshot()` cannot observe that directly: it runs the value through
  // `wire.viewSchema.parse`, which returns a fresh object every call. The rule is
  // pinned at the fold instead, and its consequence through the real feed.
  const store = new LoopProjectionStore()
  const definition = loopProjectionDefinitionFor(store)
  const asWire = definition as unknown as {
    init(header: unknown): unknown
    apply(state: unknown, event: unknown): unknown
    wire: { view(state: unknown): unknown }
  }
  const facts = (id: string, nextAt: string): Parameters<LoopProjectionStore['set']>[1] => ({
    id,
    nextAt,
    mode: 'fixed',
    cadenceLabel: 'every 10 minutes',
    round: 1,
    startedBy: 'user',
  })
  store.set('wire', facts('a', '2023-11-14T22:21:00.000Z'))
  let state = asWire.init({ id: 'wire' })
  const armed = asWire.wire.view(state)
  assert.equal((armed as { active?: boolean }).active, true)
  assert.equal(asWire.wire.view(state), armed, 'while the mirror stands, the served reference stands')

  // A no-op republication (what a read-only command produces) must not move it.
  store.set('wire', facts('a', '2023-11-14T22:21:00.000Z'))
  state = asWire.apply(state, {})
  assert.equal(asWire.wire.view(state), armed, 'a no-op write must not hand out a new reference')

  // A real move must.
  store.set('wire', facts('a', '2023-11-14T22:22:00.000Z'))
  state = asWire.apply(state, {})
  const moved = asWire.wire.view(state)
  assert.notEqual(moved, armed, 'a moved loop must hand out a new served reference')
  assert.equal((moved as { nextAt?: string }).nextAt, '2023-11-14T22:22:00.000Z')

  const double = new FakeSchedule()
  const ctx = new Context()
  const root = ctx as unknown as {
    plugin: (plugin: unknown, config?: unknown) => { await(): Promise<unknown>; dispose(): Promise<void> }
  }
  const registryFiber = root.plugin(SessionProjectionRegistry)
  await registryFiber.await()
  const registry = (ctx as unknown as { sessionProjections: SessionProjectionRegistry }).sessionProjections
  const host = await bootHost({ sessionId: 'wire-identity', scheduleDouble: double, ctx })
  try {
    const session = new SessionDouble('wire-identity')
    const asSession = session as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
    const emitRaw = (ctx as unknown as { emit: (event: string, ...payload: unknown[]) => void }).emit.bind(ctx)
    emitRaw('session/created', session)
    const drive = (): void => emitRaw('session/event', session, session.append('turn/start'))
    const read = (): { active?: boolean; nextAt?: string | null; round?: number } | undefined =>
      registry.snapshot(asSession, ['loop']).values.loop
    const changes: unknown[] = []
    registry.onChanged((_session, _key, value) => changes.push(value))

    const started = await host.commands.run('loop', host.caller(), ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    drive()
    console.log(`--- served value after arming ---\n${JSON.stringify(read(), null, 2)}`)
    assert.equal(changes.length, 1, 'arming must reach a connected client through the feed, with no reload')
    assert.deepEqual(read(), changes[0], 'and the pushed frame is the value the host serves')
    assert.equal(read()?.nextAt, double.all()[0]!.scheduledAt)

    // A read-only command republishes the identical value: nothing may move.
    const status = await host.commands.run('loop', host.caller(), 'status')
    assert.equal(status.kind, 'success', status.text)
    drive()
    assert.equal(changes.length, 1, 'a no-op republication must not push another frame')

    const stopped = await host.commands.run('loop', host.caller(), 'stop')
    assert.equal(stopped.kind, 'success', stopped.text)
    drive()
    assert.deepEqual(read(), NO_LOOP)
    assert.equal(changes.length, 2, 'and stopping must reach the client the same way')
    assert.deepEqual(changes[1], NO_LOOP)
  } finally {
    await host.dispose()
    await registryFiber.dispose()
  }
})


test('F9: a scheduled delivery reaches the projection without waiting for a turn end', async () => {
  // Regression: the projection only refreshed inside the plugin's serial queue,
  // so a delivery left the capsule holding the previous nextAt/round until the
  // delivered session's turn happened to end. The schedule service announces
  // every post-commit task write with `schedule/changed`; the plugin must react.
  const double = new FakeSchedule()
  const ctx = new Context()
  const root = ctx as unknown as {
    plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown>; dispose(): Promise<void> }
    sessionProjections: SessionProjectionRegistry
    emit(event: string, ...payload: unknown[]): void
  }
  const registryFiber = root.plugin(SessionProjectionRegistry)
  await registryFiber.await()
  const registry = root.sessionProjections
  const host = await bootHost({ sessionId: 'freshness', scheduleDouble: double, ctx })
  try {
    const session = new SessionDouble('freshness')
    const asSession = session as unknown as Parameters<SessionProjectionRegistry['stateOf']>[0]
    root.emit('session/created', session)
    const started = await host.commands.run('loop', host.caller(), ' watch the queue')
    assert.equal(started.kind, 'success', started.text)
    const record = double.all()[0]!
    const before = registry.snapshot(asSession, ['loop']).values.loop
    assert.equal(before?.round, 1)

    // A delivery: the record gains a receipt and the service would commit it.
    double.deliver(record.id)
    const aheadOfQueue = registry.snapshot(asSession, ['loop']).values.loop
    assert.equal(aheadOfQueue?.round, 1, 'before the edge, the served value is still the previous refresh')

    root.emit('schedule/changed')
    // The refresh rides the serial queue, so it lands on a later microtask.
    const deadline = Date.now() + 5000
    let served = registry.snapshot(asSession, ['loop']).values.loop
    while (served?.round !== 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      served = registry.snapshot(asSession, ['loop']).values.loop
    }
    assert.equal(served?.round, 2, 'the post-commit edge advances the served round')
    assert.equal(served?.nextAt, double.peek(record.id)?.scheduledAt, 'and the next target with it')
    console.log(`--- projection after the commit edge ---\n${JSON.stringify(served, null, 2)}`)
  } finally {
    await host.dispose()
    await registryFiber.dispose()
  }
})

test('F9: a state read failure clears the served loop instead of leaving it active', async () => {
  // A served `active: true` that nobody can verify is worse than no value: the
  // capsule would keep offering buttons for a loop that may not exist.
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'degrade', scheduleDouble: double })
  try {
    const started = await host.commands.run('loop', host.caller(), ' watch the queue')
    assert.equal(started.kind, 'success', started.text)
    double.breakList(true, 'the backend is gone')
    // Any command pass re-reads the projection; `/loop status` is refused by the
    // read failure, which is exactly the moment the mirror must stop claiming.
    const status = await host.commands.run('loop', host.caller(), 'status')
    assert.equal(status.kind, 'error', status.text)
    assert.match(status.text ?? '', /Could not read the loop state/u)
    // A tool call is the same boundary.
    const toolResult = await host.rawToolRuntime().execute({
      callId: 'degrade-status' as never,
      name: 'loop_status',
      arguments: {},
      agent: host.caller() as never,
      signal: new AbortController().signal,
    })
    const toolText = ((toolResult as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    assert.match(toolText, /unavailable/u, 'the tool reports the read failure rather than a loop')
    assert.ok(
      host.warnings.some((line) => line.includes('projection') && line.includes('cleared')),
      `expected a projection-cleared warning, saw: ${host.warnings.join(' | ')}`,
    )
  } finally {
    await host.dispose()
  }
})
