/**
 * Cadence normalization and deterministic jitter.
 *
 * Every fixed cadence is expressed as a wall-clock **cron** rule: a `/loop 5m`
 * fires at :00/:05/:10 rather than five minutes after the command, which is the
 * only way a fixed cadence can carry a phase offset. The phase offset is drawn
 * from a stable fingerprint, never from the wall clock, so the same
 * `(session, cadence, task)` triple always resolves to the same expression.
 * @module cordis-plugin-loop/cadence
 */
import { createHash } from 'node:crypto'

/** Normalization band a fixed request landed in. */
export type CadenceUnit = 'minute' | 'hour' | 'day'

/** One normalized fixed cadence, before its phase offset is applied. */
export interface FixedCadence {
  /** Which field carries the step. */
  readonly unit: CadenceUnit
  /** Step inside the unit: 1-30 minutes, 1-12 hours, or 1-31 days. */
  readonly step: number
  /** Normalized period in seconds; the jitter cap is derived from it. */
  readonly periodSeconds: number
  /** Canonical human description, e.g. `every 10 minutes`. */
  readonly label: string
}

/** Longest interval a caller may ask for, in seconds (31 days). */
export const MAX_INTERVAL_SECONDS = 31 * 86400
/** Shortest accepted interval, in seconds. */
export const MIN_INTERVAL_SECONDS = 60
/** Hard ceiling on the jitter offset, in seconds. */
export const MAX_JITTER_SECONDS = 900
/** The offset is at most this share of the normalized period. */
export const JITTER_SHARE = 0.1

/** Minute steps the cron star-step form may use. */
export const MINUTE_STEPS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30])
/** Hour steps the cron star-step hour field may use. */
export const HOUR_STEPS: readonly number[] = Object.freeze([1, 2, 3, 4, 6, 8, 12])
/** Day steps the monthly day list expresses, for a request of one day or more. */
export const DAY_STEPS: readonly number[] = Object.freeze(
  Array.from({ length: 31 }, (_value, index) => index + 1),
)

/**
 * Every cadence a fixed request may land on, ascending.
 *
 * Snapping picks the nearest entry and breaks a tie upward, so a request never
 * silently drifts more than half a step away from what the caller asked for.
 */
export const CADENCE_LADDER: readonly FixedCadence[] = Object.freeze([
  ...MINUTE_STEPS.map((step) =>
    Object.freeze({
      unit: 'minute' as const,
      step,
      periodSeconds: step * 60,
      label: step === 1 ? 'every minute' : `every ${step} minutes`,
    }),
  ),
  ...HOUR_STEPS.map((step) =>
    Object.freeze({
      unit: 'hour' as const,
      step,
      periodSeconds: step * 3600,
      label: step === 1 ? 'every hour' : `every ${step} hours`,
    }),
  ),
  ...DAY_STEPS.map((step) =>
    Object.freeze({
      unit: 'day' as const,
      step,
      periodSeconds: step * 86400,
      label: step === 1 ? 'every day at midnight' : `every ${step} days (day ${dayPreview(step)} of each month)`,
    }),
  ),
])

/**
 * Normalize a requested interval onto the nearest supported wall-clock cadence.
 *
 * @param seconds - Requested interval in seconds.
 * @returns The normalized cadence, or the refusal text.
 */
export function normalizeFixed(seconds: number): FixedCadence | { readonly error: string } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { error: 'interval must be a positive duration' }
  if (seconds < MIN_INTERVAL_SECONDS) return { error: 'interval must be at least 1 minute' }
  if (seconds > MAX_INTERVAL_SECONDS) return { error: 'interval must be at most 31 days' }
  let best = CADENCE_LADDER[0]!
  let bestDistance = Math.abs(best.periodSeconds - seconds)
  for (const candidate of CADENCE_LADDER) {
    const distance = Math.abs(candidate.periodSeconds - seconds)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
      continue
    }
    // A tie rounds up, which is what makes 8m land on 10m and 18h on one day.
    if (distance === bestDistance && candidate.periodSeconds > best.periodSeconds) {
      best = candidate
    }
  }
  return best
}

/**
 * Describe how far a normalized day list sits from the interval requested.
 *
 * A five-field cron expression can only spell a day-of-month list, so a large
 * day step fires more often than the interval it stands for. Anything that
 * drifts more than 15% below the request is disclosed rather than hidden.
 *
 * @param cadence - Normalized cadence.
 * @param requestedSeconds - Interval the caller asked for.
 * @returns `undefined` when the cadence is faithful, else a one-line disclosure.
 */
export function approximationNote(cadence: FixedCadence, requestedSeconds: number): string | undefined {
  if (cadence.unit !== 'day' || cadence.step === 1) return undefined
  const occurrencesPerMonth = listOfDays(cadence.step).length
  const effectiveDays = 31 / occurrencesPerMonth
  const requestedDays = requestedSeconds / 86400
  if (effectiveDays >= requestedDays * 0.85) return undefined
  return `cron can only spell a day-of-month list, so day ${dayPreview(cadence.step)} of each month fires about every ${round1(effectiveDays)} days rather than every ${round1(requestedDays)} days`
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function dayPreview(step: number): string {
  const days = listOfDays(step)
  const shown = days.slice(0, 3).join(', ')
  return days.length > 3 ? `${shown}, …` : shown
}

/**
 * Compute the largest offset this cadence may carry, in whole minutes.
 *
 * @param periodSeconds - Normalized period in seconds.
 * @returns The cap in minutes; `0` when minute precision cannot express it.
 */
export function jitterCapMinutes(periodSeconds: number): number {
  const capSeconds = Math.min(periodSeconds * JITTER_SHARE, MAX_JITTER_SECONDS)
  if (!Number.isFinite(capSeconds) || capSeconds <= 0) return 0
  return Math.floor(capSeconds / 60)
}

/**
 * Derive the deterministic 0..1 draw for one fingerprint.
 *
 * @param fingerprint - Stable identity string.
 * @returns A value in `[0, 1)`.
 */
export function fingerprintUnit(fingerprint: string): number {
  const digest = createHash('sha256').update(fingerprint, 'utf8').digest()
  return digest.readUInt32BE(0) / 0x1_0000_0000
}

/**
 * Draw the phase offset for one cadence.
 *
 * The value is `min(10% of the normalized period, 15 minutes)` rounded down to
 * whole minutes, and the draw spans `0..cap` inclusive, so the offset is always
 * expressible in the cron minute field. A period whose share is shorter than a
 * minute yields `0`.
 *
 * @param fingerprint - Stable identity string built by {@link loopFingerprint}.
 * @param periodSeconds - Normalized period in seconds.
 * @returns The offset in whole minutes.
 */
export function jitterMinutes(fingerprint: string, periodSeconds: number): number {
  const cap = jitterCapMinutes(periodSeconds)
  if (cap <= 0) return 0
  return Math.floor(fingerprintUnit(fingerprint) * (cap + 1))
}

/**
 * Build the stable jitter fingerprint for one loop.
 *
 * @param sessionId - Session the loop is bound to.
 * @param periodSeconds - Normalized period in seconds; `0` for a self-paced loop.
 * @param task - Exact task identity the loop runs.
 * @returns A hex fingerprint that identifies this exact loop configuration.
 */
export function loopFingerprint(sessionId: string, periodSeconds: number, task: string): string {
  return createHash('sha256')
    .update(`${sessionId}\u0000${periodSeconds}\u0000${task}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * Render the cron expression for one cadence and offset.
 *
 * The schedule service canonicalizes the expression when it stores it (a
 * uniform list becomes `a-b/n`), so callers print the stored value rather than
 * this one when they need to quote the durable text.
 *
 * @param cadence - Normalized cadence.
 * @param offsetMinutes - Phase offset in whole minutes; `0` keeps the star-step form.
 * @returns A five-field Vixie cron expression.
 */
export function cronExpression(cadence: FixedCadence, offsetMinutes: number): string {
  const offset = Math.max(0, Math.trunc(offsetMinutes))
  if (cadence.unit === 'minute') {
    return offset === 0
      ? `*/${cadence.step} * * * *`
      : `${listOfMinutes(offset, cadence.step).join(',')} * * * *`
  }
  if (cadence.unit === 'hour') {
    return `${offset} */${cadence.step} * * *`
  }
  if (cadence.step === 1) return `${offset} 0 * * *`
  return `${offset} 0 ${listOfDays(cadence.step).join(',')} * *`
}

/**
 * List the minute values `offset, offset + step, …` within one hour.
 *
 * @param offset - First minute.
 * @param step - Minute step.
 * @returns Ascending minute values, at most 60 entries.
 */
export function listOfMinutes(offset: number, step: number): number[] {
  const values: number[] = []
  for (let value = offset; value <= 59; value += step) values.push(value)
  return values
}

/**
 * List the day-of-month values `1, 1 + step, …` within one month.
 *
 * @param step - Day step.
 * @returns Ascending day values.
 */
export function listOfDays(step: number): number[] {
  const values: number[] = []
  for (let value = 1; value <= 31; value += step) values.push(value)
  return values
}

/**
 * Resolve the complete plan for one request: cadence, offset, and expression.
 *
 * @param seconds - Requested interval in seconds.
 * @param fingerprint - Stable identity string built by {@link loopFingerprint}.
 * @returns The plan, or the refusal text.
 */
export function planFixed(
  seconds: number,
  fingerprint: string,
): { readonly cadence: FixedCadence; readonly offsetMinutes: number; readonly expression: string } | { readonly error: string } {
  const cadence = normalizeFixed(seconds)
  if ('error' in cadence) return cadence
  const offsetMinutes = jitterMinutes(fingerprint, cadence.periodSeconds)
  return { cadence, offsetMinutes, expression: cronExpression(cadence, offsetMinutes) }
}
