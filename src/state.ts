/**
 * The loop record header: how one loop's live state travels inside the
 * `dsh-schedule` task it creates.
 *
 * The schedule package owns the durable row and the delivery timer; this plugin
 * owns the record's *text*. A single-line JSON header at the top of the prompt
 * is therefore the whole state channel — that is why `loop_next`, `/loop stop`
 * and the omission guard can all rewrite one record with `ctx.schedule.update`
 * without a second store.
 * @module cordis-plugin-loop/state
 */
import { createHash } from 'node:crypto'
import { fixedPrompt, selfPacedPrompt } from './prompt.ts'
import type { LoopState, ScheduleRecordLike } from './types.ts'

/** Poison prefix identifying a record this plugin owns. */
export const MARKER = 'DSH_LOOP'
/** Current header revision. */
export const HEADER_VERSION = 1
/** Task title used for every loop record, so the schedule card is recognisable. */
export const TASK_TITLE = 'DSH /loop'

/** A decoded record belonging to this plugin. */
export interface LoopRecord {
  /** The durable schedule record. */
  readonly record: ScheduleRecordLike
  /** The record id. */
  readonly id: string
  /** Decoded loop state. */
  readonly state: LoopState
}

/** JSON header line plus rendered body; the exact `prompt` of a loop record. */
export interface LoopPrompt {
  /** The complete prompt text stored on the record. */
  readonly prompt: string
  /** The header alone, for diagnostics. */
  readonly header: string
}

/**
 * Short id shown in confirmation texts and accepted by `/loop stop`.
 *
 * @param id - Full schedule id.
 * @returns The id without its `schedule-` prefix.
 */
export function shortId(id: string): string {
  return id.replace(/^schedule-/u, '')
}

/**
 * Derive the stable owner prefix for one session id.
 *
 * @param sessionId - Session identity.
 * @returns A stable, non-reversible owner prefix.
 */
export function ownerOf(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 12)
}

/**
 * Build the full prompt for one loop state.
 *
 * @param state - Complete loop state.
 * @returns The prompt plus its header line.
 */
export function buildPrompt(state: LoopState): LoopPrompt {
  const encoded: Record<string, unknown> = {
    v: HEADER_VERSION,
    owner: state.owner,
    mode: state.mode,
    cadence: state.cadenceSeconds,
    cadenceLabel: state.cadenceLabel,
    fingerprint: state.fingerprint,
    jitter: state.jitterSeconds,
    iteration: state.iteration,
    quiet: state.quietStreak,
    omissions: state.omissions,
    expiresAt: state.expiresAt,
    lastRunAt: state.lastRunAt,
  }
  if (state.taskFile !== undefined) encoded['taskFile'] = state.taskFile
  if (state.truncated === true) encoded['truncated'] = true
  if (state.task !== undefined) encoded['task'] = state.task
  const header = `${MARKER} ${JSON.stringify(encoded)}`
  const body = state.mode === 'fixed' ? fixedPrompt(state) : selfPacedPrompt(state)
  return { prompt: `${header}\n${body}`, header }
}

/**
 * Read a loop record's header.
 *
 * @param record - Durable schedule record.
 * @returns The decoded loop record, or `undefined` when this plugin does not own it.
 */
export function decodeLoopRecord(record: ScheduleRecordLike): LoopRecord | undefined {
  const prompt = record.prompt
  const newline = prompt.indexOf('\n')
  const header = newline === -1 ? prompt : prompt.slice(0, newline)
  if (!header.startsWith(`${MARKER} `)) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(header.slice(MARKER.length + 1))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = payload as Record<string, unknown>
  // The header revision is part of a record's identity: a future or unknown
  // revision carries field meanings this version does not know, so it is
  // foreign rather than partially readable.
  if (raw['v'] !== HEADER_VERSION) return undefined
  const owner = raw['owner']
  const mode = raw['mode']
  const cadenceSeconds = raw['cadence']
  const cadenceLabel = raw['cadenceLabel']
  const fingerprint = raw['fingerprint']
  const iteration = raw['iteration']
  const quietStreak = raw['quiet']
  const omissions = raw['omissions']
  const expiresAt = raw['expiresAt']
  const lastRunAt = raw['lastRunAt']
  if (typeof owner !== 'string' || owner.length === 0) return undefined
  if (mode !== 'fixed' && mode !== 'self') return undefined
  if (typeof cadenceSeconds !== 'number' || !Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 0) {
    return undefined
  }
  if (typeof cadenceLabel !== 'string' || cadenceLabel.length === 0) return undefined
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return undefined
  if (typeof iteration !== 'number' || !Number.isSafeInteger(iteration) || iteration < 0) return undefined
  if (typeof quietStreak !== 'number' || !Number.isSafeInteger(quietStreak) || quietStreak < 0) return undefined
  if (typeof omissions !== 'number' || !Number.isSafeInteger(omissions) || omissions < 0) return undefined
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return undefined
  const taskFile = raw['taskFile']
  const task = raw['task']
  const state: LoopState = {
    owner,
    mode,
    cadenceSeconds,
    cadenceLabel,
    fingerprint,
    jitterSeconds: typeof raw['jitter'] === 'number' ? raw['jitter'] : 0,
    iteration,
    quietStreak,
    omissions,
    expiresAt,
    lastRunAt: typeof lastRunAt === 'number' && Number.isSafeInteger(lastRunAt) ? lastRunAt : 0,
    ...(typeof taskFile === 'string' && taskFile.length > 0 ? { taskFile } : {}),
    ...(raw['truncated'] === true ? { truncated: true } : {}),
    ...(typeof task === 'string' ? { task } : {}),
  }
  return { record, id: record.id, state }
}

/**
 * Pick this plugin's records out of a session's schedule list.
 *
 * A record whose header is missing or unparseable is a foreign record: this
 * plugin neither lists it nor stops it.
 *
 * @param records - Every active record the session owns.
 * @param owner - Owner prefix of the calling session.
 * @returns The decoded loop records this session may manage.
 */
export function selectLoopRecords(
  records: readonly ScheduleRecordLike[],
  owner: string,
): readonly LoopRecord[] {
  const selected: LoopRecord[] = []
  for (const record of records) {
    const decoded = decodeLoopRecord(record)
    if (decoded === undefined) continue
    if (decoded.state.owner !== owner) continue
    selected.push(decoded)
  }
  return Object.freeze(selected)
}
