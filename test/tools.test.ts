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

test('the registry owns exactly loop_next and loop_stop', async () => {
  const host = await bootHost({ sessionId: 'tools', scheduleDouble: new FakeSchedule() })
  try {
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_stop'])
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
    assert.match(next.description, /60-3600/u)
    assert.match(next.description, /quiet/u)
    assert.match(next.description, /replaces this same schedule record/u)
    assert.match(stop.description, /delete its schedule record/u)
    assert.match(stop.description, /no loop in this session returns a clear error/u)
  } finally {
    await host.dispose()
  }
})
