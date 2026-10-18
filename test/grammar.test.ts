/**
 * Grammar tests: the seven accepted call forms, the reserved words, the
 * interval vocabulary, and the leading preview flag.
 * @module cordis-plugin-loop/test/grammar
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseInterval, parseLoopInput, stripDryRunFlag } from '../src/grammar.ts'

test('bare /loop is its own form', () => {
  assert.deepEqual(parseLoopInput(''), { kind: 'naked' })
  assert.deepEqual(parseLoopInput('   '), { kind: 'naked' })
})

test('an interval is recognized in every supported spelling', () => {
  const spellings: [string, number][] = [
    ['10m', 600],
    ['10 m', 600],
    ['10min', 600],
    ['10 mins', 600],
    ['10 minutes', 600],
    ['10minute', 600],
    ['45s', 45],
    ['45 sec', 45],
    ['45 secs', 45],
    ['45 second', 45],
    ['45 seconds', 45],
    ['2h', 7200],
    ['2 hr', 7200],
    ['2 hrs', 7200],
    ['2 hour', 7200],
    ['2 hours', 7200],
    ['1d', 86400],
    ['1 day', 86400],
    ['1 days', 86400],
    ['1.5h', 5400],
    ['.5h', 1800],
  ]
  for (const [text, seconds] of spellings) {
    const parsed = parseInterval(text)
    assert.ok(parsed !== undefined, `"${text}" must parse as an interval`)
    assert.equal(parsed.seconds, seconds, `"${text}" must convert to ${seconds}s`)
  }
})

test('non-interval text is not an interval', () => {
  for (const text of ['check', '10', 'm10', '10x', 'ten minutes', '', '10 minutes please', '-5m']) {
    assert.equal(parseInterval(text), undefined, `"${text}" must not parse as an interval`)
  }
})

test('/loop <interval> keeps the default task', () => {
  const parsed = parseLoopInput('10m')
  assert.equal(parsed.kind, 'interval')
  assert.equal(parsed.kind === 'interval' ? parsed.interval.seconds : 0, 600)
})

test('/loop <task> is a bare task, including a bare word', () => {
  for (const text of ['check the build', 'every', 'status of the deploy', 'stop the world']) {
    const parsed = parseLoopInput(text)
    assert.equal(parsed.kind, 'task', `"${text}" must stay a task`)
    assert.equal(parsed.kind === 'task' ? parsed.task : '', text)
  }
})

test('/loop <interval> <task> splits at the interval', () => {
  const parsed = parseLoopInput('10m check the build')
  assert.equal(parsed.kind, 'interval-task')
  if (parsed.kind !== 'interval-task') return
  assert.equal(parsed.interval.seconds, 600)
  assert.equal(parsed.task, 'check the build')
})

test('/loop <task> every <interval> keeps the whole task, spaces included', () => {
  const parsed = parseLoopInput('check the build every 10 minutes')
  assert.equal(parsed.kind, 'interval-task')
  if (parsed.kind !== 'interval-task') return
  assert.equal(parsed.task, 'check the build')
  assert.equal(parsed.interval.seconds, 600)
})

test('reserved words are reserved only on an exact whole-input match', () => {
  assert.deepEqual(parseLoopInput('status'), { kind: 'status' })
  assert.deepEqual(parseLoopInput('next'), { kind: 'next' })
  assert.deepEqual(parseLoopInput('  NEXT  '), { kind: 'next' })
  assert.deepEqual(parseLoopInput('stop'), { kind: 'stop', selector: undefined })
  assert.deepEqual(parseLoopInput('stop all'), { kind: 'stop', selector: 'all' })
  assert.deepEqual(parseLoopInput('stop 3'), { kind: 'stop', selector: '3' })
  assert.deepEqual(parseLoopInput('STOP'), { kind: 'stop', selector: undefined })
  assert.deepEqual(parseLoopInput('Status'), { kind: 'status' })
  assert.equal(parseLoopInput('status report').kind, 'task')
  assert.equal(parseLoopInput('stop the world').kind, 'task')
  assert.equal(parseLoopInput('statuses').kind, 'task')
  // The capsule's "next round" button is spelled `next`; a task that merely
  // starts with it must stay a task.
  assert.equal(parseLoopInput('next steps for the review').kind, 'task')
  assert.equal(parseLoopInput('next 10m').kind, 'task')
})

test('an interval-form task keeps its exact text', () => {
  const parsed = parseLoopInput('2h tidy the repo every friday')
  assert.equal(parsed.kind, 'interval-task')
  if (parsed.kind !== 'interval-task') return
  assert.equal(parsed.interval.seconds, 7200)
  assert.equal(parsed.task, 'tidy the repo every friday')
})

test('the preview flag is lifted only as the first token, and only on an exact match', () => {
  // Leading: lifted, and the rest is the same input the grammar already knows.
  assert.deepEqual(stripDryRunFlag('--dry-run'), { dryRun: true, input: '' })
  assert.deepEqual(stripDryRunFlag('  --dry-run  '), { dryRun: true, input: '' })
  assert.deepEqual(stripDryRunFlag('--dry-run 10m'), { dryRun: true, input: '10m' })
  assert.deepEqual(stripDryRunFlag('--dry-run watch the queue'), {
    dryRun: true,
    input: 'watch the queue',
  })
  assert.deepEqual(stripDryRunFlag('--dry-run 10m watch the queue'), {
    dryRun: true,
    input: '10m watch the queue',
  })
  // Not leading: the word is task text and must survive verbatim, or a preview
  // would swallow part of the work it is previewing.
  for (const input of [
    '10m check the --dry-run flag',
    'check the --dry-run flag',
    '--dry-run-ish task',
    '--dry-runx',
    'a --dry-run',
  ]) {
    assert.deepEqual(stripDryRunFlag(input), { dryRun: false, input }, `"${input}" must not be stripped`)
  }
  // An input without the flag is handed back untouched, not trimmed: every
  // existing path must keep the exact text it was given.
  assert.deepEqual(stripDryRunFlag(''), { dryRun: false, input: '' })
  assert.deepEqual(stripDryRunFlag('  10m  x  '), { dryRun: false, input: '  10m  x  ' })
})

test('a stripped flag leaves a start form the grammar still recognizes', () => {
  for (const input of ['', '10m', 'watch the queue', '10m watch the queue']) {
    const flag = stripDryRunFlag(`--dry-run ${input}`)
    assert.equal(flag.dryRun, true)
    assert.deepEqual(parseLoopInput(flag.input), parseLoopInput(input), `"${input}" must parse identically`)
  }
})

test('any whitespace after the flag separates it, and end of input counts as one', () => {
  // This is the case with real consequences: a caller who wrote a tab meant a
  // preview, and failing to recognize the flag turns the whole line into task
  // text and *arms a real loop*. So every separator is checked, not just a space.
  const separated: [string, string][] = [
    ['--dry-run 10m watch the queue', '10m watch the queue'],
    ['--dry-run\t10m watch the queue', '10m watch the queue'],
    ['--dry-run\n10m watch the queue', '10m watch the queue'],
    ['--dry-run\r\n10m watch the queue', '10m watch the queue'],
    ['--dry-run  10m', '10m'],
    ['--dry-run\t\twatch the queue', 'watch the queue'],
    ['--dry-run\n', ''],
    ['--dry-run\t', ''],
  ]
  for (const [input, rest] of separated) {
    assert.deepEqual(
      stripDryRunFlag(input),
      { dryRun: true, input: rest },
      `"${JSON.stringify(input)}" must be recognized as the flag`,
    )
  }
  // End of input, in every surrounding-whitespace shape.
  for (const input of ['--dry-run', '--dry-run ', '--dry-run\t', '  --dry-run\n  ']) {
    assert.deepEqual(stripDryRunFlag(input), { dryRun: true, input: '' }, `"${JSON.stringify(input)}"`)
  }
  // And the tab form still reaches the same start form a space form does.
  assert.deepEqual(parseLoopInput(stripDryRunFlag('--dry-run\t10m watch the queue').input), {
    kind: 'interval-task',
    interval: { text: '10m', amount: 10, unit: 'm', seconds: 600 },
    task: 'watch the queue',
  })
  // The stricter cases stay strict: only an exact, leading, whole-token match.
  for (const input of ['--dry-runny', '--dry-run-ish task', '--dry-runx', '10m check the --dry-run flag']) {
    assert.deepEqual(stripDryRunFlag(input), { dryRun: false, input }, `"${input}" must not be stripped`)
  }
})
