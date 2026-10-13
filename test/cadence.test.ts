/**
 * Cadence truth table, per-band jitter caps, and offset determinism.
 *
 * Every fixed cadence must land on a wall-clock cron expression, the phase
 * offset must be reproducible and truly reflected in that expression, and the
 * out-of-range requests must be refused.
 * @module cordis-plugin-loop/test/cadence
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalizeCronExpression } from '@deepseek-ai/dsh-schedule'
import {
  approximationNote,
  CADENCE_LADDER,
  cronExpression,
  jitterCapMinutes,
  jitterMinutes,
  listOfDays,
  listOfMinutes,
  loopFingerprint,
  normalizeFixed,
  planFixed,
  type FixedCadence,
} from '../src/cadence.ts'

const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/** Snapping pairs: requested seconds → the normalized unit, step, and label. */
const SNAPPING: [number, string, number, string][] = [
  // Minute band: nearest entry, ties upward.
  [1 * MINUTE, 'minute', 1, 'every minute'],
  [2 * MINUTE, 'minute', 2, 'every 2 minutes'],
  [3 * MINUTE, 'minute', 3, 'every 3 minutes'],
  [4 * MINUTE, 'minute', 4, 'every 4 minutes'],
  [5 * MINUTE, 'minute', 5, 'every 5 minutes'],
  [6 * MINUTE, 'minute', 6, 'every 6 minutes'],
  [7 * MINUTE, 'minute', 6, 'every 6 minutes'],
  [8 * MINUTE, 'minute', 10, 'every 10 minutes'],
  [9 * MINUTE, 'minute', 10, 'every 10 minutes'],
  [10 * MINUTE, 'minute', 10, 'every 10 minutes'],
  [11 * MINUTE, 'minute', 12, 'every 12 minutes'],
  [12 * MINUTE, 'minute', 12, 'every 12 minutes'],
  [13 * MINUTE, 'minute', 12, 'every 12 minutes'],
  [14 * MINUTE, 'minute', 15, 'every 15 minutes'],
  [15 * MINUTE, 'minute', 15, 'every 15 minutes'],
  [16 * MINUTE, 'minute', 15, 'every 15 minutes'],
  [17 * MINUTE, 'minute', 15, 'every 15 minutes'],
  [18 * MINUTE, 'minute', 20, 'every 20 minutes'],
  [20 * MINUTE, 'minute', 20, 'every 20 minutes'],
  [25 * MINUTE, 'minute', 30, 'every 30 minutes'],
  [30 * MINUTE, 'minute', 30, 'every 30 minutes'],
  [31 * MINUTE, 'minute', 30, 'every 30 minutes'],
  [45 * MINUTE, 'hour', 1, 'every hour'],
  [59 * MINUTE, 'hour', 1, 'every hour'],
  // Hour band.
  [1 * HOUR, 'hour', 1, 'every hour'],
  [90 * MINUTE, 'hour', 2, 'every 2 hours'],
  [2 * HOUR, 'hour', 2, 'every 2 hours'],
  [3 * HOUR, 'hour', 3, 'every 3 hours'],
  [5 * HOUR, 'hour', 6, 'every 6 hours'],
  [6 * HOUR, 'hour', 6, 'every 6 hours'],
  [7 * HOUR, 'hour', 8, 'every 8 hours'],
  [8 * HOUR, 'hour', 8, 'every 8 hours'],
  [10 * HOUR, 'hour', 12, 'every 12 hours'],
  [12 * HOUR, 'hour', 12, 'every 12 hours'],
  [13 * HOUR, 'hour', 12, 'every 12 hours'],
  [17 * HOUR, 'hour', 12, 'every 12 hours'],
  [18 * HOUR, 'day', 1, 'every day at midnight'],
  [19 * HOUR, 'day', 1, 'every day at midnight'],
  [23 * HOUR, 'day', 1, 'every day at midnight'],
  // Day band.
  [1 * DAY, 'day', 1, 'every day at midnight'],
  [28 * HOUR, 'day', 1, 'every day at midnight'],
  [2 * DAY, 'day', 2, 'every 2 days (day 1, 3, 5, … of each month)'],
  [5 * DAY, 'day', 5, 'every 5 days (day 1, 6, 11, … of each month)'],
  [7 * DAY, 'day', 7, 'every 7 days (day 1, 8, 15, … of each month)'],
  [10 * DAY, 'day', 10, 'every 10 days (day 1, 11, 21, … of each month)'],
  [16 * DAY, 'day', 16, 'every 16 days (day 1, 17 of each month)'],
  [24 * DAY, 'day', 24, 'every 24 days (day 1, 25 of each month)'],
  [31 * DAY, 'day', 31, 'every 31 days (day 1 of each month)'],
]

function normalize(seconds: number): FixedCadence {
  const result = normalizeFixed(seconds)
  if ('error' in result) assert.fail(`expected a cadence for ${seconds}s, got: ${String(result.error)}`)
  if ('error' in result) throw new Error('unreachable')
  return result
}

test('truth table: snapping takes the nearest step and rounds a tie upward', () => {
  for (const [seconds, unit, step, label] of SNAPPING) {
    const cadence = normalize(seconds)
    assert.equal(cadence.unit, unit, `${seconds}s unit`)
    assert.equal(cadence.step, step, `${seconds}s step`)
    assert.equal(cadence.label, label, `${seconds}s label`)
  }
})

test('the correction cases are pinned: 7m, 13m, 17m, 11m, 8m, 18h, 45m', () => {
  assert.equal(normalize(7 * MINUTE).step, 6, '7m is nearer 6m than 10m')
  assert.equal(normalize(13 * MINUTE).step, 12, '13m is nearer 12m than 15m')
  assert.equal(normalize(17 * MINUTE).step, 15, '17m is nearer 15m than 20m')
  assert.equal(normalize(11 * MINUTE).step, 12, '11m is a tie and rounds up')
  assert.equal(normalize(8 * MINUTE).step, 10, '8m is a tie and rounds up')
  assert.equal(normalize(18 * HOUR).unit, 'day', '18h is a tie and rounds up')
  assert.equal(normalize(45 * MINUTE).unit, 'hour', '45m is a tie and rounds up')
})

test('the ladder is strictly ascending and never exceeds 31 days', () => {
  for (let index = 1; index < CADENCE_LADDER.length; index += 1) {
    assert.ok(
      CADENCE_LADDER[index]!.periodSeconds > CADENCE_LADDER[index - 1]!.periodSeconds,
      'the ladder must ascend',
    )
  }
  assert.equal(CADENCE_LADDER[CADENCE_LADDER.length - 1]!.periodSeconds, 31 * DAY)
})

test('per-band jitter caps: min(10% of the normalized cadence, 900s) in whole minutes', () => {
  const rows: [number, number][] = [
    [1 * MINUTE, 0],
    [5 * MINUTE, 0],
    [6 * MINUTE, 0],
    [10 * MINUTE, 1],
    [12 * MINUTE, 1],
    [15 * MINUTE, 1],
    [20 * MINUTE, 2],
    [30 * MINUTE, 3],
    [1 * HOUR, 6],
    [2 * HOUR, 12],
    [3 * HOUR, 15],
    [4 * HOUR, 15],
    [6 * HOUR, 15],
    [8 * HOUR, 15],
    [12 * HOUR, 15],
    [1 * DAY, 15],
    [2 * DAY, 15],
    [10 * DAY, 15],
    [31 * DAY, 15],
  ]
  for (const [normalizedSeconds, cap] of rows) {
    assert.equal(jitterCapMinutes(normalizedSeconds), cap, `${normalizedSeconds}s cap`)
  }
  // The cap is taken from the *normalized* period: 45m lands on one hour.
  assert.equal(normalize(45 * MINUTE).periodSeconds, HOUR)
  assert.equal(jitterCapMinutes(normalize(45 * MINUTE).periodSeconds), 6)
})

test('the day list is 1, 1+N, … and stops at the 31st', () => {
  assert.deepEqual(listOfDays(10), [1, 11, 21, 31])
  assert.deepEqual(listOfDays(16), [1, 17])
  assert.deepEqual(listOfDays(31), [1])
  assert.deepEqual(listOfDays(2), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31])
  assert.deepEqual(listOfMinutes(0, 30), [0, 30])
  assert.deepEqual(listOfMinutes(1, 10), [1, 11, 21, 31, 41, 51])
})

test('truth table: out-of-range requests are refused with a clear message', () => {
  const refusal = (seconds: number): string => {
    const result = normalizeFixed(seconds)
    assert.ok('error' in result, `${seconds}s must be refused`)
    return 'error' in result ? result.error : ''
  }
  for (const seconds of [0, -60, Number.NaN, 30, 59]) refusal(seconds)
  assert.match(refusal(31 * DAY + 1), /at most 31 days/u)
  assert.match(refusal(0), /positive duration/u)
  assert.match(refusal(30), /at least 1 minute/u)
})

test('jitter: the same fingerprint always yields the same offset inside the cap', () => {
  const seen = new Set<number>()
  for (let index = 0; index < 200; index += 1) {
    const offset = jitterMinutes(`fingerprint-${index}`, 10 * MINUTE)
    assert.ok(offset >= 0 && offset <= 1, `offset ${offset} must stay inside the cap`)
    assert.equal(jitterMinutes(`fingerprint-${index}`, 10 * MINUTE), offset, 'same input, same offset')
    seen.add(offset)
  }
  assert.deepEqual([...seen].sort(), [0, 1], 'a 1-minute cap must be reachable at both ends')
  for (let index = 0; index < 200; index += 1) {
    const offset = jitterMinutes(`big-${index}`, 31 * DAY)
    assert.ok(offset >= 0 && offset <= 15, `offset ${offset} must stay inside the 15-minute cap`)
  }
})

test('jitter: a period whose share is under a minute yields zero', () => {
  assert.equal(jitterMinutes('any', 1 * MINUTE), 0)
  assert.equal(jitterMinutes('any', 5 * MINUTE), 0)
  assert.equal(jitterMinutes('any', 6 * MINUTE), 0)
})

test('the offset really lands in the expression: 0 keeps the star step, > 0 shifts the phase', () => {
  const minuteCadence = normalize(10 * MINUTE)
  assert.equal(cronExpression(minuteCadence, 0), '*/10 * * * *')
  assert.equal(cronExpression(minuteCadence, 1), '1,11,21,31,41,51 * * * *')
  const hourCadence = normalize(HOUR)
  assert.equal(cronExpression(hourCadence, 0), '0 */1 * * *')
  assert.equal(cronExpression(hourCadence, 6), '6 */1 * * *')
  const dailyCadence = normalize(DAY)
  assert.equal(cronExpression(dailyCadence, 0), '0 0 * * *')
  assert.equal(cronExpression(dailyCadence, 15), '15 0 * * *')
  const dayCadence = normalize(10 * DAY)
  assert.equal(cronExpression(dayCadence, 0), '0 0 1,11,21,31 * *')
  assert.equal(cronExpression(dayCadence, 15), '15 0 1,11,21,31 * *')
})

test('every generated expression is accepted, and the stored text is the canonical form', () => {
  const requests: number[] = []
  for (let minutes = 1; minutes <= 60; minutes += 1) requests.push(minutes * MINUTE)
  for (let hours = 1; hours <= 24; hours += 1) requests.push(hours * HOUR)
  for (let days = 1; days <= 31; days += 1) requests.push(days * DAY)
  for (const seconds of requests) {
    for (const offset of [0, 1, 3, 6, 15]) {
      const cadence = normalize(seconds)
      const expression = cronExpression(cadence, offset)
      const canonical = canonicalizeCronExpression(expression)
      assert.equal(canonicalizeCronExpression(canonical), canonical, `${expression} must be stable`)
      // The list form and its canonical `a-b/n` spelling select the same minutes.
      assert.equal(
        phaseOf(canonical),
        phaseOf(expression),
        `${expression} and ${canonical} must select the same minutes`,
      )
    }
  }
  const samples: [number, number][] = [
    [10 * MINUTE, 1],
    [30 * MINUTE, 3],
    [1 * HOUR, 6],
    [2 * HOUR, 12],
    [18 * HOUR, 15],
    [10 * DAY, 15],
    [31 * DAY, 0],
  ]
  for (const [seconds, offset] of samples) {
    const cadence = normalize(seconds)
    console.log(
      `${String(seconds).padStart(8)}s step=${cadence.unit}/${cadence.step} offset=${String(offset).padStart(2)}m  ` +
        `${cronExpression(cadence, offset).padEnd(24)} -> ${canonicalizeCronExpression(cronExpression(cadence, offset))}`,
    )
  }
})

test('the approximation note discloses a coarse monthly day list', () => {
  const note = approximationNote(normalize(30 * DAY), 30 * DAY)
  assert.ok(note !== undefined, '30 days is a coarse approximation and must be disclosed')
  assert.match(note, /every 15\.5 days rather than every 30 days/u)
  assert.match(approximationNote(normalize(10 * DAY), 10 * DAY) ?? '', /every 7\.8 days rather than every 10 days/u)
  assert.equal(approximationNote(normalize(2 * DAY), 2 * DAY), undefined)
  assert.equal(approximationNote(normalize(7 * DAY), 7 * DAY), undefined)
  assert.equal(approximationNote(normalize(16 * DAY), 16 * DAY), undefined)
  assert.equal(approximationNote(normalize(31 * DAY), 31 * DAY), undefined)
  assert.equal(approximationNote(normalize(45 * MINUTE), 45 * MINUTE), undefined)
})

test('fingerprint: session, cadence and task all take part, and the value is stable', () => {
  const base = loopFingerprint('session-a', 600, 'check the build')
  assert.equal(loopFingerprint('session-a', 600, 'check the build'), base)
  assert.notEqual(loopFingerprint('session-b', 600, 'check the build'), base)
  assert.notEqual(loopFingerprint('session-a', 300, 'check the build'), base)
  assert.notEqual(loopFingerprint('session-a', 600, 'check the deploy'), base)
  assert.match(base, /^[0-9a-f]{16}$/u)
})

test('planFixed combines snapping, offset and expression', () => {
  const planned = planFixed(7 * MINUTE, 'fingerprint')
  assert.ok(!('error' in planned))
  if ('error' in planned) return
  assert.equal(planned.cadence.step, 6)
  assert.equal(planned.offsetMinutes, 0, 'a 6-minute cadence cannot express a sub-minute share')
  assert.equal(planned.expression, '*/6 * * * *')
})

/** Resolve the absolute minute set an expression selects within one hour. */
function phaseOf(expression: string): string {
  const minuteField = expression.split(' ')[0]!
  const values = new Set<number>()
  if (minuteField === '*') {
    for (let value = 0; value <= 59; value += 1) values.add(value)
  } else {
    for (const part of minuteField.split(',')) {
      const [rangeText, stepText] = part.split('/')
      const step = stepText === undefined ? 1 : Number(stepText)
      const bounds = rangeText === '*' ? [0, 59] : rangeText!.split('-').map(Number)
      const from = bounds[0]!
      const to = bounds.length > 1 ? bounds[1]! : from
      for (let value = from; value <= to; value += step) values.add(value)
    }
  }
  return [...values].sort((left, right) => left - right).join(',')
}
