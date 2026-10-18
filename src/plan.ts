/**
 * The one place a start request becomes a loop plan.
 *
 * Both surfaces that can arm a loop — the `/loop` command and the `loop_start`
 * tool — and the read-only `--dry-run` preview all resolve their request here,
 * so a preview cannot drift from what a real start would store: there is
 * exactly one normalization, one fingerprint, one jitter draw and one expiry
 * computation in this plugin.
 *
 * The function is pure on purpose: no I/O, no context, no clock of its own. The
 * caller supplies `now` and the already-resolved default-task file, which is
 * what lets the preview run under a plan mode, a subagent session or a kill
 * switch without touching storage.
 * @module cordis-plugin-loop/plan
 */
import {
  approximationNote,
  cronExpression,
  jitterMinutes,
  loopFingerprint,
  normalizeFixed,
} from './cadence.ts'
import { ownerOf } from './state.ts'
import type { LoopConfig } from './config.ts'
import type { LoopState } from './types.ts'

/** Everything a loop plan needs from the caller. */
export interface PlanInput {
  /** Session the loop would be bound to. */
  readonly sessionId: string
  /** `fixed` drives a cron rule; `self` arms the first safety check. */
  readonly mode: 'fixed' | 'self'
  /** Who asked for the loop; durable state, never waived by the caller. */
  readonly startedBy: 'user' | 'agent'
  /** Requested interval in seconds, when the caller supplied one. */
  readonly requestedSeconds?: number
  /** Exact task text, when the loop carries one inline. */
  readonly task?: string
  /** Absolute path of the default task file, when the task comes from one. */
  readonly taskFile?: string
  /** Whether the file text was truncated at the byte budget. */
  readonly truncated?: boolean
  /** Effective plugin configuration. */
  readonly config: LoopConfig
  /** Explicit IANA time zone every cron record carries. */
  readonly timeZone: string
  /** Wall clock the plan is anchored at, in epoch milliseconds. */
  readonly now: number
}

/**
 * One fully normalized loop, before anything is stored.
 *
 * Every member below is exactly what the durable header would carry, so a
 * preview that prints this object and a `start` that stores it can be compared
 * field by field.
 */
export interface LoopPlan {
  /** `fixed` for a wall-clock rule, `self` for a model-paced loop. */
  readonly mode: 'fixed' | 'self'
  /** Normalized cadence in seconds; `0` for a self-paced loop. */
  readonly cadenceSeconds: number
  /** Canonical cadence text; `self-paced` for a self-paced loop. */
  readonly cadenceLabel: string
  /** Stable fingerprint of `(session, cadence, task)`. */
  readonly fingerprint: string
  /** Deterministic phase offset actually applied, in seconds. */
  readonly jitterSeconds: number
  /** The same offset in whole minutes, as the cron phase uses it. */
  readonly offsetMinutes: number
  /**
   * The **requested** cron expression, in the form this plugin would hand the
   * schedule service.
   *
   * The service canonicalizes the expression when it stores it (a uniform list
   * becomes `a-b/n`), so this is not the durable text: only a `create` return
   * value is. Absent for a self-paced loop.
   */
  readonly expression?: string
  /** Disclosure of how far a day-step cadence sits from the request, if at all. */
  readonly approximation?: string
  /** Epoch milliseconds the run would end. */
  readonly expiresAt: number
  /** Schedule task title, as the durable record would carry it. */
  readonly title: string
  /** Complete prompt of the record, header line included. */
  readonly prompt: string
  /** Code points of the inline task; `0` when the task comes from a file. */
  readonly taskCodePoints: number
  /** The loop state the record would store, exactly as `create` would write it. */
  readonly state: LoopState
  /**
   * First wait in seconds, for a self-paced loop.
   *
   * Absent for a fixed cadence: the exact first firing instant comes from the
   * `create` return value's `scheduledAt`, which no plan can know.
   */
  readonly firstWaitSeconds?: number
}

/** What the plan needs from the engine, narrowed to the one hook it uses. */
export interface PlanHooks {
  /** Whether the schedule seam is composed. */
  readonly available: boolean
  /** Build the durable title of a loop state. */
  readonly buildTitle: (state: LoopState) => string
  /** Build the durable prompt of a loop state. */
  readonly buildPrompt: (state: LoopState) => { readonly prompt: string }
}

/**
 * Normalize one start request into the loop that would be stored.
 *
 * The refusals are the engine's own, in the engine's own words: a start and its
 * preview must refuse identically, or the preview would be a second, drifting
 * implementation of the guards.
 *
 * @param input - Session, request, configuration, clock and time zone.
 * @param hooks - The engine's title and prompt builders.
 * @returns The plan, or the refusal text.
 */
export function planLoop(input: PlanInput, hooks: PlanHooks): LoopPlan | { readonly error: string } {
  if (!hooks.available) {
    return { error: 'The schedule service is not composed, so /loop cannot create a reminder.' }
  }
  const task = input.task ?? ''
  if (task.trim().length === 0 && input.taskFile === undefined) {
    return { error: 'A loop needs a task: pass one inline or create the default loop task file.' }
  }
  // The inline limit is counted in code points, so one astral character is one
  // unit; the default task file is budgeted in bytes instead (see README).
  const taskCodePoints = codePointLength(task)
  if (taskCodePoints > input.config.maxTaskBytes) {
    return {
      error: `The task is ${taskCodePoints} code points; the accepted maximum is ${input.config.maxTaskBytes}. Move it into a loop task file instead.`,
    }
  }
  const identity = task.length > 0 ? task : `file:${input.taskFile ?? ''}`
  let cadenceSeconds = 0
  let cadenceLabel = 'self-paced'
  // The identity deliberately excludes the origin: `startedBy` was added after
  // v0.1.1 shipped, and folding it in would re-draw the jitter phase (and so
  // re-order the cron expression) of every loop a user restarts the same way.
  // Which surface armed a loop is disclosed in the title and the confirmation
  // text instead.
  let fingerprint = loopFingerprint(input.sessionId, 0, identity)
  let offsetMinutes = 0
  let expression: string | undefined
  let approximation: string | undefined
  if (input.mode === 'fixed') {
    const requestedSeconds = input.requestedSeconds ?? Number.NaN
    const probe = normalizeFixed(requestedSeconds)
    if ('error' in probe) return { error: probe.error }
    cadenceSeconds = probe.periodSeconds
    cadenceLabel = probe.label
    approximation = approximationNote(probe, requestedSeconds)
    fingerprint = loopFingerprint(input.sessionId, cadenceSeconds, identity)
    offsetMinutes = jitterMinutes(fingerprint, cadenceSeconds)
    expression = cronExpression(probe, offsetMinutes)
  } else {
    // A self-paced loop is driven by a recurring fixed-rate record: a fired
    // one-shot turns inactive and then rejects `update` with `schedule_ended`,
    // so it could never be re-armed by the model. The interval stored here is
    // the currently armed wait, and `loop_next` replaces it in place.
    cadenceSeconds = input.config.safetyCheckSeconds
  }
  const state: LoopState = {
    owner: ownerOf(input.sessionId),
    mode: input.mode,
    startedBy: input.startedBy,
    cadenceSeconds,
    cadenceLabel,
    fingerprint,
    jitterSeconds: offsetMinutes * 60,
    iteration: 0,
    quietStreak: 0,
    omissions: 0,
    expiresAt: input.now + input.config.lifetimeDays * 86_400_000,
    lastRunAt: input.now,
    ...(input.taskFile === undefined ? {} : { taskFile: input.taskFile }),
    ...(input.truncated === true ? { truncated: true } : {}),
    ...(input.task === undefined ? {} : { task: input.task }),
  }
  const title = hooks.buildTitle(state)
  const { prompt } = hooks.buildPrompt(state)
  return Object.freeze({
    mode: input.mode,
    cadenceSeconds,
    cadenceLabel,
    fingerprint,
    jitterSeconds: offsetMinutes * 60,
    offsetMinutes,
    ...(expression === undefined ? {} : { expression }),
    ...(approximation === undefined ? {} : { approximation }),
    expiresAt: state.expiresAt,
    title,
    prompt,
    taskCodePoints,
    state,
    ...(input.mode === 'self' ? { firstWaitSeconds: input.config.safetyCheckSeconds } : {}),
  })
}

/**
 * Count the code points of one string.
 *
 * `String.length` counts UTF-16 code units, so an astral character would count
 * as two. The inline task budget is documented in code points, and the default
 * task file budget in bytes (`src/loopfile.ts`), so the two units are never
 * silently mixed.
 *
 * @param text - Text to measure.
 * @returns The number of Unicode code points.
 */
export function codePointLength(text: string): number {
  return [...text].length
}
