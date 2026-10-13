/**
 * Grammar tests: the six accepted call forms, the reserved words, and the
 * interval vocabulary.
 * @module cordis-plugin-loop/test/grammar
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseInterval, parseLoopInput } from '../src/grammar.ts'

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
  assert.deepEqual(parseLoopInput('stop'), { kind: 'stop', selector: undefined })
  assert.deepEqual(parseLoopInput('stop all'), { kind: 'stop', selector: 'all' })
  assert.deepEqual(parseLoopInput('stop 3'), { kind: 'stop', selector: '3' })
  assert.deepEqual(parseLoopInput('STOP'), { kind: 'stop', selector: undefined })
  assert.deepEqual(parseLoopInput('Status'), { kind: 'status' })
  assert.equal(parseLoopInput('status report').kind, 'task')
  assert.equal(parseLoopInput('stop the world').kind, 'task')
  assert.equal(parseLoopInput('statuses').kind, 'task')
})

test('an interval-form task keeps its exact text', () => {
  const parsed = parseLoopInput('2h tidy the repo every friday')
  assert.equal(parsed.kind, 'interval-task')
  if (parsed.kind !== 'interval-task') return
  assert.equal(parsed.interval.seconds, 7200)
  assert.equal(parsed.task, 'tidy the repo every friday')
})
