/**
 * Walking skeleton: the minimal end-to-end path.
 *
 * `/loop` is parsed, round 1 runs immediately, one real cron record lands in the
 * real schedule assembly, and a real due delivery reaches the session through
 * the `[SCHEDULE REMINDER]` frame.
 * @module cordis-plugin-loop/test/integration
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalizeCronExpression, renderRecurringReminderBatchFraming } from '@deepseek-ai/dsh-schedule'
import { bootHost } from './harness.ts'

test('walking skeleton: parse, immediate round, real cron record, real delivery', async () => {
  const host = await bootHost({ withCommands: undefined, sessionId: 'skeleton' } as never)
  try {
    // 1. Register surface: the command and all four tools are present.
    assert.deepEqual(
      host.commands.definitions.map((entry) => entry.name),
      ['loop'],
      'the /loop command must be registered',
    )
    assert.deepEqual([...host.toolNames].sort(), ['loop_next', 'loop_start', 'loop_status', 'loop_stop'])

    // 2. Parse + immediate round + a real wall-clock cron record.
    const started = await host.commands.run('loop', host.agent, ' 10m check the build')
    assert.equal(started.kind, 'success', started.text)
    assert.match(started.text ?? '', /Loop started\./)
    assert.match(started.text ?? '', /Cadence: every 10 minutes, wall-clock anchored/)
    assert.match(started.text ?? '', /Title: DSH \/loop: check the build/)
    assert.equal(host.agent.messages.length, 1)
    assert.match(host.agent.messages[0]!.text, /round 1/)

    // 3. The record the scheduler actually stores, with its real fields.
    const catalog = await (host.ctx as unknown as { schedule: { catalog(): Promise<unknown[]> } }).schedule.catalog()
    assert.equal(catalog.length, 1)
    const record = catalog[0] as {
      id: string
      kind: string
      title: string
      prompt: string
      expression?: string
      everySeconds?: number
      timeZone?: string
      status: string
    }
    assert.equal(record.kind, 'cron')
    assert.equal(record.title, 'DSH /loop: check the build')
    assert.equal(record.status, 'active')
    assert.equal(record.everySeconds, undefined)
    assert.ok(record.expression !== undefined)
    assert.equal(canonicalizeCronExpression(record.expression), record.expression, 'stored text must be canonical')
    assert.equal(record.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
    assert.match(record.expression, /^(\*\/10|[0-9]+(-[0-9]+\/10)?) \* \* \* \*$/u)
    assert.match(record.prompt, /^DSH_LOOP \{/)
    assert.match(record.prompt, /Task:\ncheck the build/u)
    console.log(`--- stored record ---\n${JSON.stringify(record, null, 2)}`)

    // 3b. A coarser cadence, one that only the daily rule can express.
    const dayCommand = await host.commands.run('loop', host.agent, ' 18h check the build')
    assert.equal(dayCommand.kind, 'success', dayCommand.text)
    const afterDay = await (
      host.ctx as unknown as { schedule: { catalog(): Promise<unknown[]> } }
    ).schedule.catalog()
    const dayRecord = afterDay[0] as { expression: string; timeZone: string; kind: string }
    assert.equal(dayRecord.kind, 'cron')
    assert.equal(canonicalizeCronExpression(dayRecord.expression), dayRecord.expression)
    assert.match(dayRecord.expression, /^[0-9]+ 0 \* \* \*$/u, '18h must normalize onto a midnight daily rule')
    console.log(`--- 18h record ---\n${JSON.stringify(dayRecord, null, 2)}`)

    // 4. A real delivery: arm the same session with a 1-second one-shot and wait
    //    for the schedule runtime to hand the message to the agent. A cron loop
    //    cannot fire faster than the service minimum of one minute, so the live
    //    proof uses a one-shot and the loop's own framing is checked below.
    const sessionId = host.agent.id
    const probe = await host.schedule.create(sessionId as never, {
      prompt: 'one-shot delivery probe',
      title: 'probe',
      after_seconds: 1,
    })
    const delivered = await host.agent.waitFor((message) => message.text.includes('one-shot delivery probe'), 15000)
    console.log(`--- delivered message ---\n${delivered.text}`)
    assert.match(delivered.text, /\[SCHEDULE REMINDER\]/)
    assert.match(delivered.text, /reminder_prompt_json: "one-shot delivery probe"/)
    await host.schedule.delete({ sessionId: sessionId as never, id: probe.id })

    // 5. The loop's own prompt travels as data inside the recurrence frame the
    //    real service renders, so the model reads it as payload, not as an
    //    instruction the schedula itself authored.
    const stored = (await (host.ctx as unknown as { schedule: { catalog(): Promise<unknown[]> } }).schedule.catalog())[0] as {
      prompt: string
      scheduledAt: string
    }
    const frame = renderRecurringReminderBatchFraming([
      { record: stored as never, occurrenceAt: stored.scheduledAt },
    ])
    console.log(`--- loop recurrence frame (first 400 chars) ---\n${frame.slice(0, 400)}`)
    assert.match(frame, /\[SCHEDULE REMINDER BATCH\]/)
    assert.match(frame, /reminders_json: /)
    assert.ok(frame.includes('DSH_LOOP '), "the loop's own prompt must ride inside the frame")
    assert.ok(frame.includes('check the build'), 'the task must arrive as data')
    const payload = JSON.parse(frame.slice(frame.indexOf('reminders_json: ') + 'reminders_json: '.length)) as {
      schedule_id: string
      occurrence_at: string
      reminder_prompt: string
    }[]
    assert.equal(payload.length, 1)
    assert.equal(payload[0]!.reminder_prompt, stored.prompt)
    assert.match(payload[0]!.schedule_id, /^schedule-/u)
    assert.match(payload[0]!.occurrence_at, /^\d{4}-\d{2}-\d{2}T/u)

    // 6. The human status text and the model's status tool describe the same
    //    record, against the REAL schedule service rather than the double. The
    //    live record here is the 18h one the coarser-cadence step left behind.
    const human = await host.commands.run('loop', host.agent, 'status')
    assert.equal(human.kind, 'success', human.text)
    assert.match(human.text ?? '', /- [0-9a-f-]+ {2}every day at midnight/u)
    assert.match(human.text ?? '', /^ {2}next: /mu)
    assert.match(human.text ?? '', /^ {2}started by: user$/mu)
    assert.match(human.text ?? '', /^ {2}round limit: 24 \(reaching it stops the loop\)$/mu)
    const tool = await host.rawToolRuntime().execute({
      callId: 'call-loop-status' as never,
      name: 'loop_status',
      arguments: {},
      agent: host.agent as never,
      signal: new AbortController().signal,
    })
    const toolText = ((tool as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    console.log(`--- /loop status (real service) ---\n${human.text}\n--- loop_status tool ---\n${toolText}`)
    assert.match(toolText, /active: true/u)
    assert.match(toolText, /mode: fixed/u)
    assert.match(toolText, /cadence: every day at midnight/u)
    assert.match(toolText, /round: 1/u, 'round 1 is the round this session is on')
    assert.match(toolText, /startedBy: user/u)
    const live = (await (
      host.ctx as unknown as { schedule: { catalog(): Promise<unknown[]> } }
    ).schedule.catalog())[0] as { scheduledAt: string }
    assert.ok(toolText.includes(live.scheduledAt), 'the tool must report the record’s own next occurrence')
    assert.ok(human.text?.includes(live.scheduledAt) === true, 'and so must the human text')
  } finally {
    await host.dispose()
  }
})
