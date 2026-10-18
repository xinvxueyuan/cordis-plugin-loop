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
  // A preview on the real service first: it must arm nothing at all, so the
  // stored row count goes 0 (before) → 0 (after the preview) → 1 (after the
  // real start). A double can only prove what the plugin asked for; this proves
  // what the shipped service ended up holding.
  const armed = async (): Promise<number> =>
    (await host.schedule.list({ sessionId: 'integration-smoke' as never })).length
  assert.equal(await armed(), 0, 'the session must start with no stored row')
  const preview = await host.commands.run('loop', host.caller(), '--dry-run 10m smoke check')
  assert.equal(preview.kind, 'success', preview.text)
  assert.match(preview.text ?? '', /^Loop preview \(nothing was armed\):/u)
  assert.match(preview.text ?? '', /Blockers: none/u)
  assert.equal(await armed(), 0, 'the preview must store no row')
  assert.equal(host.agent.messages.length, 0, 'the preview must deliver no round')
  console.log('preview: stored rows 0 -> 0')

  const started = await host.commands.run('loop', host.caller(), ' 10m smoke check')
  assert.equal(started.kind, 'success', started.text)
  assert.equal(await armed(), 1, 'the real start must store exactly one row')
  console.log('real start: stored rows 0 -> 1')
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
