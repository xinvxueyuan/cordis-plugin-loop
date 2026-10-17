/**
 * Loop record header: encoding, decoding, the foreign-record boundary, and the
 * task title.
 * @module cordis-plugin-loop/test/state
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTitle, TITLE_LIMIT } from '../src/engine.ts'
import { buildPrompt, decodeLoopRecord, HEADER_VERSION, MARKER, ownerOf, selectLoopRecords, shortId } from '../src/state.ts'
import type { LoopState, ScheduleRecordLike } from '../src/types.ts'

/** One complete, valid state. */
function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    owner: ownerOf('session-a'),
    mode: 'fixed',
    startedBy: 'user',
    cadenceSeconds: 600,
    cadenceLabel: 'every 10 minutes',
    fingerprint: 'abcdef0123456789',
    jitterSeconds: 60,
    iteration: 0,
    quietStreak: 0,
    omissions: 0,
    expiresAt: 1_700_000_000_000,
    lastRunAt: 1_699_999_000_000,
    task: 'check the build',
    ...overrides,
  }
}

/** Wrap a prompt as the schedule service would return it. */
function record(prompt: string, id = 'schedule-1'): ScheduleRecordLike {
  return { id, kind: 'cron', title: 'DSH /loop', prompt, scheduledAt: '2026-01-01T00:00:00.000Z' }
}

test('a built prompt round-trips through the decoder', () => {
  const original = state({ mode: 'self', cadenceSeconds: 0, cadenceLabel: 'self-paced', taskFile: '/tmp/loop.md' })
  const { prompt, header } = buildPrompt(original)
  assert.ok(header.startsWith(`${MARKER} `))
  assert.equal(prompt.split('\n')[0], header)
  assert.equal(prompt.split('\n').length > 3, true, 'the body must follow the header')
  const decoded = decodeLoopRecord(record(prompt))
  assert.ok(decoded !== undefined)
  assert.deepEqual(decoded.state, original)
  assert.equal(decoded.id, 'schedule-1')
})

test('the header carries every live counter and the expiry', () => {
  const { header } = buildPrompt(state({ iteration: 4, quietStreak: 2, omissions: 1 }))
  const payload = JSON.parse(header.slice(MARKER.length + 1)) as Record<string, unknown>
  assert.equal(payload['v'], HEADER_VERSION)
  assert.equal(payload['iteration'], 4)
  assert.equal(payload['quiet'], 2)
  assert.equal(payload['omissions'], 1)
  assert.equal(payload['expiresAt'], 1_700_000_000_000)
  assert.equal(payload['mode'], 'fixed')
  assert.equal(payload['cadence'], 600)
  assert.equal(payload['startedBy'], 'user', 'the origin travels with the record')
})

test("a record written before `startedBy` existed decodes as a user loop", () => {
  // Backward compatibility is load-bearing: decoding an old record as `agent`
  // would silently subject a person's live loop to a round cap.
  const legacy = `${MARKER} {"v":1,"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`
  const decoded = decodeLoopRecord(record(legacy))
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.startedBy, 'user')
  // A nonsense value is not trusted either.
  const nonsense = `${MARKER} {"v":1,"owner":"o","mode":"fixed","startedBy":"somebody","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`
  assert.equal(decodeLoopRecord(record(nonsense))?.state.startedBy, 'user')
})

test('an agent-armed record round-trips its origin and says so in the title', () => {
  const original = state({ startedBy: 'agent', task: 'watch the queue' })
  const { prompt } = buildPrompt(original)
  const decoded = decodeLoopRecord(record(prompt))
  assert.ok(decoded !== undefined)
  assert.equal(decoded.state.startedBy, 'agent')
  assert.equal(buildTitle(original), '[agent] DSH /loop: watch the queue')
  assert.equal(buildTitle(state({ task: 'watch the queue' })), 'DSH /loop: watch the queue')
})

test('a foreign or broken record decodes as undefined', () => {
  const cases: [string, string][] = [
    ['no marker', 'Hello, this is an ordinary reminder.'],
    ['another plugin prefix', 'OTHER_PLUGIN {"owner":"x"}'],
    ['marker without payload', `${MARKER} `],
    ['marker with broken JSON', `${MARKER} {"owner":`],
    ['marker with a JSON scalar', `${MARKER} 42`],
    ['marker with a JSON array', `${MARKER} [1,2,3]`],
    ['missing version', `${MARKER} {"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['version 2', `${MARKER} {"v":2,"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['version as a string', `${MARKER} {"v":"1","owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['version zero', `${MARKER} {"v":0,"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['missing owner', `${MARKER} {"v":1,"mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['negative iteration', `${MARKER} {"v":1,"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":-1,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['unknown mode', `${MARKER} {"v":1,"owner":"o","mode":"other","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['fractional cadence', `${MARKER} {"v":1,"owner":"o","mode":"fixed","cadence":1.5,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
    ['missing expiry', `${MARKER} {"v":1,"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"x","fingerprint":"f","iteration":0,"quiet":0,"omissions":0}`],
    ['empty cadence label', `${MARKER} {"v":1,"owner":"o","mode":"fixed","cadence":600,"cadenceLabel":"","fingerprint":"f","iteration":0,"quiet":0,"omissions":0,"expiresAt":1}`],
  ]
  for (const [label, prompt] of cases) {
    assert.equal(decodeLoopRecord(record(prompt)), undefined, `${label} must be foreign`)
  }
})

test('the header revision is required and must equal the current version', () => {
  const good = buildPrompt(state()).prompt
  assert.ok(decodeLoopRecord(record(good)) !== undefined, 'the current revision must decode')
  const newline = good.indexOf('\n')
  const payload = JSON.parse(good.slice(MARKER.length + 1, newline)) as Record<string, unknown>
  assert.equal(payload['v'], HEADER_VERSION)
  // Dropping `v`, or moving it off the current revision, makes the record
  // foreign: a future revision's field meanings are not this version's.
  for (const version of [undefined, 2, 0, '1', null, 1.5]) {
    const mutated: Record<string, unknown> = { ...payload }
    if (version === undefined) delete mutated['v']
    else mutated['v'] = version
    const prompt = `${MARKER} ${JSON.stringify(mutated)}\nbody`
    assert.equal(decodeLoopRecord(record(prompt)), undefined, `v=${String(version)} must be foreign`)
  }
})

test('a record from another session is not selected', () => {
  const mine = buildPrompt(state()).prompt
  const theirs = buildPrompt(state({ owner: ownerOf('session-b') })).prompt
  const foreign = 'an ordinary reminder'
  const selected = selectLoopRecords([record(mine, 'schedule-1'), record(theirs, 'schedule-2'), record(foreign, 'schedule-3')], ownerOf('session-a'))
  assert.deepEqual(selected.map((entry) => entry.id), ['schedule-1'])
})

test('the owner prefix is stable, short and session specific', () => {
  assert.equal(ownerOf('session-a'), ownerOf('session-a'))
  assert.notEqual(ownerOf('session-a'), ownerOf('session-b'))
  assert.match(ownerOf('session-a'), /^[0-9a-f]{12}$/u)
})

test('shortId drops the schedule- prefix only', () => {
  assert.equal(shortId('schedule-7'), '7')
  assert.equal(shortId('7'), '7')
  assert.equal(shortId('other-7'), 'other-7')
})

test('the title keeps the prefix, adds the task, and stays inside the limit', () => {
  assert.equal(buildTitle(state()), 'DSH /loop: check the build')
  assert.equal(buildTitle(state({ taskFile: '/tmp/loop.md', task: undefined })), 'DSH /loop: read /tmp/loop.md')
  assert.equal(buildTitle(state({ task: '  spaced   out  ' })), 'DSH /loop: spaced out')
  const long = buildTitle(state({ task: 'x'.repeat(500) }))
  assert.equal(long.length, TITLE_LIMIT)
  assert.ok(long.endsWith('...'))
  assert.ok(long.startsWith('DSH /loop: '))
})

test('the task body points at the file instead of copying it', () => {
  const { prompt } = buildPrompt(state({ taskFile: '/p/.dsh/loop.md', task: undefined }))
  assert.match(prompt, /Task source: the file \/p\/\.dsh\/loop\.md/u)
  assert.match(prompt, /Read that file at the start of every round/u)
  assert.match(prompt, /Read it fresh; the file is authoritative/u)
  const truncated = buildPrompt(state({ taskFile: '/p/.dsh/loop.md', truncated: true, task: undefined })).prompt
  assert.match(truncated, /exceeded the accepted size/u)
})

test('an omission round says so in its own framework text', () => {
  const clean = buildPrompt(state({ mode: 'self', omissions: 0 })).prompt
  assert.ok(!clean.includes('WARNING'), 'a clean round carries no warning')
  const guarded = buildPrompt(state({ mode: 'self', omissions: 1 })).prompt
  assert.match(guarded, /WARNING: the previous round of this loop ended without a continuation/u)
  assert.match(guarded, /omission 1 of 2/u)
  assert.match(guarded, /loop_next/u)
  assert.match(guarded, /loop_stop/u)
})

test('every round carries a machine-readable context line with the real counters', () => {
  const { prompt } = buildPrompt(state({ iteration: 3, quietStreak: 1, omissions: 1, mode: 'self', cadenceLabel: 'self-paced' }))
  const line = prompt.split('\n').find((entry) => entry.startsWith('round_context:'))
  assert.ok(line !== undefined)
  const payload = JSON.parse(line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"))) as Record<string, unknown>
  assert.deepEqual(payload, {
    loop: true,
    round: 4,
    iteration: 3,
    quietStreak: 1,
    omissions: 1,
    cadence: 'self-paced',
  })
})

test('the self-paced framework states the continuation contract and the stop route', () => {
  const { prompt } = buildPrompt(state({ mode: 'self', cadenceSeconds: 0, cadenceLabel: 'self-paced' }))
  assert.match(prompt, /loop_next\(<60-3600 seconds>/u)
  assert.match(prompt, /keeps exactly one loop/u)
  assert.match(prompt, /quiet: true/u)
  assert.match(prompt, /Stop with loop_stop/u)
})

test('the fixed framework states that no call is needed to continue', () => {
  const { prompt } = buildPrompt(state())
  assert.match(prompt, /next round fires on its own/u)
  assert.match(prompt, /to end it, call loop_stop/u)
})
