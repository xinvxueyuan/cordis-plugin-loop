/**
 * The text a loop round delivers.
 *
 * A `dsh-schedule` reminder arrives as data: the schedule package wraps the
 * stored prompt in a fixed `[SCHEDULE REMINDER]` frame and appends the prompt as
 * `reminder_prompt_json`. This module renders that stored prompt, so the model
 * reads one machine-readable context line before any prose, and every count it
 * carries is the count the record actually holds.
 * @module cordis-plugin-loop/prompt
 */
import type { LoopState } from './types.ts'

/** The single-quoted context line every round starts with, including the first. */
export function roundContextLine(state: LoopState, extra?: Record<string, unknown>): string {
  const context: Record<string, unknown> = {
    loop: true,
    round: state.iteration + 1,
    iteration: state.iteration,
    quietStreak: state.quietStreak,
    omissions: state.omissions,
    cadence: state.cadenceLabel,
    ...extra,
  }
  return `round_context: '${JSON.stringify(context)}'`
}

/** Shared closing instructions: how to continue, how to be quiet, how to stop. */
function controlLines(state: LoopState): string[] {
  if (state.mode === 'self') {
    return [
      'Continue this loop with loop_next(<60-3600 seconds>, "<reason>"[, quiet]) — it replaces this same reminder, so the session keeps exactly one loop.',
      'Pass quiet: true when this round needed no attention; the quiet streak is reported back to you each round so a run of quiet rounds stays visible.',
      'Stop with loop_stop("<reason>"), or ask the user for /loop stop.',
    ]
  }
  return [
    `This is a fixed-cadence loop (${state.cadenceLabel}) and the next round fires on its own, so no call is needed to continue it.`,
    'Report attention-worthy findings in your reply; to end it, call loop_stop("<reason>") or ask the user for /loop stop.',
  ]
}

/** Task body: a pointer to the default-task file, or the inline task text. */
function taskLines(state: LoopState): string[] {
  if (state.taskFile !== undefined) {
    return [
      `Task source: the file ${state.taskFile}.`,
      'Read that file at the start of every round. It is the task and it may have changed since the previous round, so never rely on a remembered copy.',
      state.truncated === true
        ? 'That file exceeded the accepted size when this loop started, so the snapshot below is incomplete — read the file itself.'
        : 'Read it fresh; the file is authoritative.',
    ]
  }
  return ['Task:', state.task ?? '(missing task)']
}

/** The warning a round carries when the round before it was not continued. */
function omissionWarning(state: LoopState): string[] {
  if (state.omissions === 0) return []
  return [
    '',
    `WARNING: the previous round of this loop ended without a continuation — neither loop_next nor loop_stop was called.`,
    `This is omission ${state.omissions} of 2; one more ends the loop automatically.`,
    'Either continue with loop_next, or end it explicitly with loop_stop.',
  ]
}

/**
 * Render the stored prompt for a self-paced loop.
 *
 * @param state - Loop state carried by the record.
 * @returns The prompt body below the header line.
 */
export function selfPacedPrompt(state: LoopState): string {
  return [
    roundContextLine(state),
    'You are inside a /loop: a task you run again and again, and each round wakes you with this reminder.',
    'This round starts now. Run the task, then decide how long to wait before the next round.',
    '',
    "If you are already working on this loop in the same session, keep going: this reminder is the loop's continuation, not a request to start over.",
    ...omissionWarning(state),
    '',
    ...taskLines(state),
    '',
    ...controlLines(state),
  ].join('\n')
}

/**
 * Render the stored prompt for a fixed-cadence loop.
 *
 * @param state - Loop state carried by the record.
 * @returns The prompt body below the header line.
 */
export function fixedPrompt(state: LoopState): string {
  return [
    roundContextLine(state),
    `You are inside a /loop running on a fixed, wall-clock anchored cadence: ${state.cadenceLabel}.`,
    'This round starts now. Run the task and report what changed.',
    '',
    "If you are already working on this loop in the same session, keep going: this reminder is the loop's continuation, not a request to start over.",
    ...omissionWarning(state),
    '',
    ...taskLines(state),
    '',
    ...controlLines(state),
  ].join('\n')
}

/**
 * Render the first-round text, delivered immediately at `/loop` time rather than
 * through the scheduler.
 *
 * @param state - Loop state of the new loop.
 * @param firstWaitSeconds - Seconds until the next round fires or is armed.
 * @param scheduleId - The created record id.
 * @returns The model-visible first-round prompt.
 */
export function firstRoundPrompt(state: LoopState, firstWaitSeconds: number, scheduleId: string): string {
  const wait =
    firstWaitSeconds < 3600
      ? `${Math.max(1, Math.round(firstWaitSeconds / 60))} minute(s)`
      : `${Math.round((firstWaitSeconds / 3600) * 10) / 10} hour(s)`
  const next =
    state.mode === 'self'
      ? `The next round is a self-paced safety check in ${wait}. Continue with loop_next(<60-3600 seconds>, "<reason>"[, quiet]); it replaces this same reminder so the session keeps exactly one loop.`
      : `The next round fires on its own wall-clock cadence in ${wait}; call loop_stop("<reason>") to end the loop.`
  return [
    roundContextLine(state),
    `A /loop is now active in this session. This is round 1 and it starts immediately — do the task now.`,
    '',
    ...taskLines(state),
    '',
    next,
    `Schedule id: ${scheduleId}. Ends at ${new Date(state.expiresAt).toISOString()} unless restarted.`,
  ].join('\n')
}
