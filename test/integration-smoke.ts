/**
 * Local integration smoke: the real `@deepseek-ai/dsh-schedule` assembly with
 * the real local JSON storage backend, driven by one genuine one-second
 * reminder delivery.
 *
 * This is the pre-publish check that CI cannot run the same way, so it is also
 * a real `package.json` script (`npm run test:integration`). It lives under
 * `test/` because that is the directory the package's typecheck and scope cover.
 * @module cordis-plugin-loop/test/integration-smoke
 */
import assert from 'node:assert/strict'
import { canonicalizeCronExpression } from '@deepseek-ai/dsh-schedule'
import { bootHost } from './harness.ts'

const host = await bootHost({ sessionId: 'integration-smoke' })
try {
  const started = await host.commands.run('loop', host.caller(), ' 10m smoke check')
  assert.equal(started.kind, 'success', started.text)
  const [record] = await host.schedule.list({ sessionId: 'integration-smoke' as never })
  assert.ok(record !== undefined, 'the loop must exist')
  assert.ok(record.expression !== undefined, 'a fixed cadence must be a cron rule')
  assert.equal(canonicalizeCronExpression(record.expression), record.expression)
  console.log(`stored record: kind=${record.kind} expression=${record.expression}`)
  console.log(`title: ${record.title}`)

  await host.schedule.create('integration-smoke' as never, {
    prompt: 'integration smoke probe',
    title: 'probe',
    after_seconds: 1,
  })
  const delivered = await host.agent.waitFor((message) => message.text.includes('integration smoke probe'), 15000)
  assert.match(delivered.text, /\[SCHEDULE REMINDER\]/)
  console.log('delivery frame received:')
  console.log(delivered.text)

  const stopped = await host.commands.run('loop', host.caller(), 'stop all')
  assert.equal(stopped.kind, 'success', stopped.text)
  const remaining = await host.schedule.list({ sessionId: 'integration-smoke' as never })
  assert.equal(remaining.length, 0)
  console.log('integration smoke: OK')
} finally {
  await host.dispose()
}
