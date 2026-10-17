/**
 * The two continuation tools, executed through the real tool registry.
 *
 * This is the strongest available surface for the tool bodies: the definitions
 * are compiled by `defineTool`, registered on the real `ToolRuntime`, and
 * driven through `execute` with a real caller agent.
 * @module cordis-plugin-loop/test/tools
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootHost } from './harness.ts'
import { FakeSchedule } from './fake-schedule.ts'
import { decodeLoopRecord } from '../src/state.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** Text of every text block in a tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** Run one registered tool through the real registry. */
async function runTool(
  host: Awaited<ReturnType<typeof bootHost>>,
  name: string,
  args: Record<string, unknown>,
  agent: unknown,
): Promise<{ text: string; isError: boolean }> {
  const runtime = host.rawToolRuntime()
  const result = await runtime.execute({
    callId: `call-${name}` as unknown as ToolCallId,
    name,
    arguments: args,
    agent: agent as never,
    signal: new AbortController().signal,
  })
  return { text: textOf(result), isError: (result as { isError?: boolean }).isError === true }
}

/** Run one registered tool with no caller agent attached. */
async function runToolWithoutAgent(
  host: Awaited<ReturnType<typeof bootHost>>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const runtime = host.rawToolRuntime()
  const result = await runtime.execute({
    callId: `call-${name}-no-agent` as unknown as ToolCallId,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  return { text: textOf(result), isError: (result as { isError?: boolean }).isError === true }
}

/** One loop-owning caller agent. */
function loopAgentOf(host: Awaited<ReturnType<typeof bootHost>>): unknown {
  return host.caller()
}

/**
 * Read one tool's canonical value and its declared output schema.
 *
 * `ToolRuntime.execute` hands back rendered content only, so the structured
 * contract has to be read from the definition itself — the very function the
 * registry calls, with the same declared schema the registry validates against.
 *
 * @param host - The booted host.
 * @param name - Tool name.
 * @returns The canonical value and the declared output schema.
 */
async function runToolValue(
  host: Awaited<ReturnType<typeof bootHost>>,
  name: string,
  agent: unknown,
): Promise<{ value: Record<string, unknown>; schema: { properties?: Record<string, unknown> } }> {
  const runtime = host.rawToolRuntime() as unknown as {
    get(name: string):
      | { output: { schema: { properties?: Record<string, unknown> } }; execute(args: unknown, exec: unknown): Promise<unknown> }
      | undefined
  }
  const definition = runtime.get(name)
  if (definition === undefined) throw new Error(`${name} is not registered`)
  const value = (await definition.execute({}, { agent, signal: new AbortController().signal })) as Record<string, unknown>
  return { value, schema: definition.output.schema }
}

test('the registry owns exactly the four loop tools', async () => {
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: new FakeSchedule() })
  try {
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_start', 'loop_status', 'loop_stop'])
  } finally {
    await host.dispose()
  }
})

test('loop_next replaces the same record and reports the next counters', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    const started = await host.commands.run('loop', agent, 'watch the queue')
    assert.equal(started.kind, 'success', started.text)
    const created = (await double.list({ sessionId: 'tools' }))[0]!
    double.deliver(created.id)

    const { text, isError } = await runTool(host, 'loop_next', { seconds: 300, reason: 'nothing changed' }, agent)
    assert.equal(isError, false, text)
    assert.match(text, /Next round in 300s\. Reason: nothing changed/u)
    assert.match(text, /iteration 1, quiet streak 0, omissions 0/u)
    assert.equal(double.size, 1)
    assert.equal(double.createCalls, 1, 'the tool must not create a second record')
    assert.equal(double.all()[0]!.id, created.id)
    assert.equal(double.all()[0]!.everySeconds, 300)
    const decoded = decodeLoopRecord(double.all()[0]!)
    assert.ok(decoded !== undefined)
    assert.equal(decoded.state.iteration, 1)
  } finally {
    await host.dispose()
  }
})

test('loop_next rejects bad arguments through the registry schema, and bad state through its own check', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    await host.commands.run('loop', agent, 'watch the queue')
    // The declared parameter schema rejects a non-integer before the body runs.
    const fractional = await runTool(host, 'loop_next', { seconds: 3.5, reason: 'x' }, agent)
    assert.equal(fractional.isError, true)
    assert.match(fractional.text, /seconds|integer/u)
    const missing = await runTool(host, 'loop_next', { seconds: 300 }, agent)
    assert.equal(missing.isError, true)
    assert.match(missing.text, /reason/u)
    // A wait outside the configured window is refused by the body.
    const outOfWindow = await runTool(host, 'loop_next', { seconds: 10, reason: 'x' }, agent)
    assert.equal(outOfWindow.isError, true)
    assert.match(outOfWindow.text, /between 60 and 3600/u)
  } finally {
    await host.dispose()
  }
})

test('loop_next in a session with no loop is an explicit error, not a silent success', async () => {
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: new FakeSchedule() })
  try {
    const result = await runTool(host, 'loop_next', { seconds: 300, reason: 'x' }, loopAgentOf(host))
    assert.equal(result.isError, true)
    assert.match(result.text, /no loop in this session/u)
  } finally {
    await host.dispose()
  }
})

test('loop_next refuses a fixed-cadence loop with the reason', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    await host.commands.run('loop', agent, '10m check the build')
    const result = await runTool(host, 'loop_next', { seconds: 300, reason: 'x' }, agent)
    assert.equal(result.isError, true)
    assert.match(result.text, /fixed cadence/u)
    assert.match(result.text, /loop_stop/u)
  } finally {
    await host.dispose()
  }
})

test('a subagent cannot continue or stop a loop', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    await host.commands.run('loop', loopAgentOf(host), 'watch the queue')
    // A realistic child reports its own session id, so it owns no loop at all.
    const child = host.caller({ origin: 'subagent', sessionId: 'tools-child' })
    const next = await runTool(host, 'loop_next', { seconds: 300, reason: 'x' }, child)
    assert.equal(next.isError, true)
    assert.match(next.text, /subagent session has no loop/u)
    const stop = await runTool(host, 'loop_stop', { reason: 'x' }, child)
    assert.equal(stop.isError, true)
    assert.match(stop.text, /subagent session has no loop/u)
    // A child that reported the parent's id is still refused on its own header.
    const impostor = host.caller({ origin: 'subagent' })
    const refused = await runTool(host, 'loop_next', { seconds: 300, reason: 'x' }, impostor)
    assert.equal(refused.isError, true)
    assert.match(refused.text, /subagent session has no loop/u)
    assert.equal(double.size, 1, 'the parent loop is untouched')
  } finally {
    await host.dispose()
  }
})

test('loop_stop ends the loop and reports the reason', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    await host.commands.run('loop', agent, 'watch the queue')
    const result = await runTool(host, 'loop_stop', { reason: 'the task is done' }, agent)
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /Loop stopped \(1\)\. Reason: the task is done/u)
    assert.equal(double.size, 0)
    const again = await runTool(host, 'loop_stop', { reason: 'again' }, agent)
    assert.equal(again.isError, true)
    assert.match(again.text, /no loop in this session/u)
  } finally {
    await host.dispose()
  }
})

test('a tool state read failure is a friendly failed call, never a raw throw', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    await host.commands.run('loop', agent, 'watch the queue')
    double.breakList(true)

    const next = await runTool(host, 'loop_next', { seconds: 300, reason: 'x' }, agent)
    assert.equal(next.isError, true, 'the failure must surface as a failed call')
    assert.match(next.text, /Could not read the loop state: storage backend exploded/u)
    const stop = await runTool(host, 'loop_stop', { reason: 'x' }, agent)
    assert.equal(stop.isError, true)
    assert.match(stop.text, /Could not read the loop state: storage backend exploded/u)
    assert.equal(double.size, 1, 'neither call may remove the loop while the read is broken')
  } finally {
    await host.dispose()
  }
})

test('a call with no agent attached is a failed call, not a quiet success', async () => {
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: new FakeSchedule() })
  try {
    for (const [name, args] of [
      ['loop_next', { seconds: 300, reason: 'x' }],
      ['loop_stop', { reason: 'x' }],
    ] as const) {
      const result = await runToolWithoutAgent(host, name, args)
      assert.equal(result.isError, true, `${name} must fail without an agent`)
      assert.match(result.text, /needs a session context/u)
    }
  } finally {
    await host.dispose()
  }
})

test('the tool descriptions state the contract the model needs', async () => {
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: new FakeSchedule() })
  try {
    const runtime = host.rawToolRuntime()
    const definition = (name: string): { description: string } => {
      const found = (runtime as unknown as { get(name: string): { description: string } | undefined }).get(name)
      if (found === undefined) throw new Error(`${name} is not registered`)
      return found
    }
    const next = definition('loop_next')
    const stop = definition('loop_stop')
    const start = definition('loop_start')
    const status = definition('loop_status')
    assert.match(next.description, /60-3600/u)
    assert.match(next.description, /quiet/u)
    assert.match(next.description, /replaces this same schedule record/u)
    assert.match(stop.description, /delete its schedule record/u)
    assert.match(stop.description, /no loop in this session returns a clear error/u)
    // `loop_start` must say when to reach for it, what its arguments are, and
    // what it returns — a tool that omits the "when" gets called on every guess.
    assert.match(start.description, /when the user asks to keep watching/u)
    assert.match(start.description, /long-running objective/u)
    assert.match(start.description, /not for work you can finish in this turn/u)
    assert.match(start.description, /recorded as agent-started/u)
    assert.match(start.description, /cadence "fixed" fires on a wall-clock rhythm and needs seconds/u)
    assert.match(start.description, /re-time every round with loop_next/u)
    assert.match(start.description, /round limit/u)
    assert.match(status.description, /without changing anything/u)
    assert.match(status.description, /startedBy \(user when a person ran \/loop, agent when you ran loop_start\)/u)
    assert.match(status.description, /never disagrees with \/loop status/u)
  } finally {
    await host.dispose()
  }
})

test('loop_start runs the first round now and arms the cadence it was asked for', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    const started = await runTool(host, 'loop_start', { task: 'watch the deploy', cadence: 'self' }, agent)
    assert.equal(started.isError, false, started.text)
    assert.match(started.text, /Loop started\./u)
    assert.match(started.text, /Cadence: self-paced/u)
    assert.match(started.text, /Started by: agent · round limit: 24/u)
    // The first round is delivered immediately, exactly like the command's.
    assert.equal(host.agent.messages.length, 1)
    assert.match(host.agent.messages[0]!.text, /This is round 1 and it starts immediately/u)
    assert.match(host.agent.messages[0]!.text, /watch the deploy/u)
    assert.equal(host.agent.messages[0]!.sourceKind, 'loop')
    const record = double.all()[0]!
    assert.equal(record.kind, 'every', 'a self-paced loop is a recurring record so loop_next can replace it')
    assert.equal(record.everySeconds, 1800)
    const decoded = decodeLoopRecord(record)
    assert.ok(decoded !== undefined)
    assert.equal(decoded.state.mode, 'self')
    assert.equal(decoded.state.startedBy, 'agent', 'the origin is durable state, not a report-time guess')
    assert.match(record.title, /^\[agent\] DSH \/loop: watch the deploy$/u, 'the schedule list marks agent loops')

    // The loop the tool armed is one the model continues with loop_next, and the
    // record it replaces is the same one.
    double.deliver(record.id)
    const next = await runTool(host, 'loop_next', { seconds: 300, reason: 'nothing changed' }, agent)
    assert.equal(next.isError, false, next.text)
    assert.equal(double.size, 1)
    assert.equal(double.all()[0]!.id, record.id)
  } finally {
    await host.dispose()
  }
})

test('loop_start with a wall-clock cadence stores a real cron rule', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const started = await runTool(
      host,
      'loop_start',
      { task: 'check the build', cadence: 'fixed', seconds: 600 },
      loopAgentOf(host),
    )
    assert.equal(started.isError, false, started.text)
    assert.match(started.text, /Cadence: every 10 minutes, wall-clock anchored/u)
    const record = double.all()[0]!
    assert.equal(record.kind, 'cron')
    assert.equal(record.everySeconds, undefined)
    assert.ok(record.expression !== undefined)
    assert.equal(decodeLoopRecord(record)?.state.cadenceSeconds, 600)
  } finally {
    await host.dispose()
  }
})

test('loop_start takes its task literally and refuses an unusable request', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double, config: { maxRounds: 3 } })
  try {
    const agent = loopAgentOf(host)
    // A task that reads like an interval is still a task: the tool must not run
    // the command's text grammar over it.
    const literal = await runTool(host, 'loop_start', { task: '10m check the build', cadence: 'self' }, agent)
    assert.equal(literal.isError, false, literal.text)
    const decoded = decodeLoopRecord(double.all()[0]!)
    assert.ok(decoded !== undefined)
    assert.equal(decoded.state.task, '10m check the build')
    assert.equal(decoded.state.mode, 'self')
    await runTool(host, 'loop_stop', { reason: 'next case' }, agent)

    const noTask = await runTool(host, 'loop_start', { task: '   ' }, agent)
    assert.equal(noTask.isError, true)
    assert.match(noTask.text, /needs a task/u)
    const noSeconds = await runTool(host, 'loop_start', { task: 'watch', cadence: 'fixed' }, agent)
    assert.equal(noSeconds.isError, true)
    assert.match(noSeconds.text, /needs seconds/u)
    // The declared schema rejects a bad seconds value before the body runs.
    const badSeconds = await runTool(host, 'loop_start', { task: 'watch', cadence: 'fixed', seconds: 2.5 }, agent)
    assert.equal(badSeconds.isError, true)
    assert.match(badSeconds.text, /seconds|integer/u)
    const zeroSeconds = await runTool(host, 'loop_start', { task: 'watch', seconds: 0 }, agent)
    assert.equal(zeroSeconds.isError, true)
    assert.match(zeroSeconds.text, /positive number of seconds/u)
    assert.equal(double.size, 0, 'no refused request may leave a record behind')
  } finally {
    await host.dispose()
  }
})

test('loop_start shares the command guards: subagents, plan mode and the kill switch', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({
    sessionId: 'tools',
    scheduleDouble: double,
    services: { planMode: { get: () => ({ active: true }) } },
  })
  try {
    const planned = await runTool(host, 'loop_start', { task: 'watch' }, loopAgentOf(host))
    assert.equal(planned.isError, true)
    assert.match(planned.text, /Plan mode is active/u)
    assert.equal(double.size, 0)
    assert.equal(double.createCalls, 0, 'the plan-mode refusal precedes every storage write')
  } finally {
    await host.dispose()
  }

  const child = await bootHost({ sessionId: 'tools-child', scheduleDouble: new FakeSchedule() })
  try {
    const refused = await runTool(child, 'loop_start', { task: 'watch' }, child.caller({ origin: 'subagent' }))
    assert.equal(refused.isError, true)
    assert.match(refused.text, /subagent session cannot start/u)
    assert.equal(child.scheduleDoubleSize(), 0)
  } finally {
    await child.dispose()
  }
})

test('loop_status is read-only and reports the same value the projection serves', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double, config: { maxRounds: 3 } })
  try {
    const agent = loopAgentOf(host)
    const idle = await runTool(host, 'loop_status', {}, agent)
    assert.equal(idle.isError, false, idle.text)
    assert.match(idle.text, /active: false/u)
    assert.match(idle.text, /mode: self/u)
    assert.match(idle.text, /cadence: self-paced/u)
    assert.match(idle.text, /nextAt: null/u)
    assert.match(idle.text, /round: 0/u)
    assert.match(idle.text, /startedBy: user/u)
    assert.match(idle.text, /no loop in this session/u)
    assert.equal(double.size, 0, 'a read must not touch storage')

    const started = await host.commands.run('loop', agent, ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    const armed = await runTool(host, 'loop_status', {}, agent)
    assert.equal(armed.isError, false, armed.text)
    assert.match(armed.text, /active: true/u)
    assert.match(armed.text, /mode: fixed/u)
    assert.match(armed.text, /cadence: every 10 minutes/u)
    assert.match(armed.text, new RegExp(`nextAt: ${double.all()[0]!.scheduledAt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
    assert.match(armed.text, /startedBy: user/u)
    assert.equal(double.size, 1, 'reading the status changes nothing')

    // The structured value the model sees must equal the value the composer
    // capsule renders, so the human `/loop status` text carries the same facts.
    const human = await host.commands.run('loop', agent, 'status')
    assert.equal(human.kind, 'success', human.text)
    assert.match(human.text ?? '', /started by: user/u)
    assert.match(human.text ?? '', /round limit: 3/u)
    assert.match(human.text ?? '', new RegExp(`next: ${double.all()[0]!.scheduledAt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
    assert.equal(double.size, 1, 'reading the status changes nothing')
  } finally {
    await host.dispose()
  }
})

test('loop_status carries nextAt in its structured value, null included (T5-F2)', async () => {
  // The description promises `nextAt` may be null and the rendered text always
  // prints it, so the structured face must carry the key too: omitting it made
  // the two faces disagree (T5-F2).
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)

    // ① The declared schema permits the null the description promises.
    const idle = await runToolValue(host, 'loop_status', agent)
    assert.deepEqual(
      idle.schema.properties?.['nextAt'],
      { oneOf: [{ type: 'string' }, { type: 'null' }] },
      'nextAt must be declared nullable',
    )

    // ② With no loop the key is present and null — not omitted.
    assert.equal(
      Object.hasOwn(idle.value, 'nextAt'),
      true,
      `the structured value must carry nextAt; keys: ${Object.keys(idle.value).join(',')}`,
    )
    assert.equal(idle.value['nextAt'], null)
    assert.deepEqual(
      validateJsonSchemaValue(idle.schema as never, idle.value),
      [],
      'the declared schema must accept the value the tool returns',
    )

    // ③ Both faces state the same fact.
    const idleText = String(idle.value['text'] ?? '')
    assert.match(idleText, /^nextAt: null$/mu, 'the field list prints null')
    assert.match(idleText, /"nextAt": null/u, 'and the JSON block carries the same null')

    // ④ Armed, the same field carries the target the scheduler holds.
    const started = await host.commands.run('loop', agent, ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    const scheduledAt = double.all()[0]!.scheduledAt
    const armed = await runToolValue(host, 'loop_status', agent)
    assert.equal(armed.value['nextAt'], scheduledAt)
    assert.deepEqual(validateJsonSchemaValue(armed.schema as never, armed.value), [])
    const armedText = String(armed.value['text'] ?? '')
    const target = scheduledAt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    assert.match(armedText, new RegExp(`^nextAt: ${target}$`, 'mu'))
    assert.match(armedText, new RegExp(`"nextAt": "${target}"`, 'u'))
  } finally {
    await host.dispose()
  }
})

test('loop_status reports a model-armed loop as startedBy agent', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    await runTool(host, 'loop_start', { task: 'watch the queue' }, agent)
    const status = await runTool(host, 'loop_status', {}, agent)
    assert.equal(status.isError, false, status.text)
    assert.match(status.text, /startedBy: agent/u)
    assert.match(status.text, /active: true/u)
  } finally {
    await host.dispose()
  }
})

test('a status read that cannot be answered is reported, never dressed up as "no loop"', async () => {
  const double = new FakeSchedule()
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: double })
  try {
    const agent = loopAgentOf(host)
    await host.commands.run('loop', agent, '10m check the build')
    double.breakList(true)
    const status = await runTool(host, 'loop_status', {}, agent)
    assert.equal(status.isError, false, 'a read failure is an answer, not a failed call')
    assert.match(status.text, /unavailable/u)
    assert.match(status.text, /Could not read the loop state: storage backend exploded/u)
  } finally {
    await host.dispose()
  }
})

test('loop_start and loop_status need a session context like every other tool', async () => {
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: new FakeSchedule() })
  try {
    for (const [name, args] of [
      ['loop_start', { task: 'watch' }],
      ['loop_status', {}],
    ] as const) {
      const result = await runToolWithoutAgent(host, name, args)
      assert.equal(result.isError, true, `${name} must fail without an agent`)
      assert.match(result.text, /needs a session context/u)
    }
  } finally {
    await host.dispose()
  }
})
