/**
 * The loop engine: one live loop per session, driven by `ctx.schedule`.
 *
 * A fixed cadence is a wall-clock cron rule. A self-paced loop is a **recurring**
 * fixed-rate record whose interval is the wait the model last chose, so
 * `loop_next` can replace it in place: a fired one-shot turns inactive and then
 * rejects `update` with `schedule_ended`, which would leave the model no way to
 * continue. Both live in the same durable task, and a session never owns more
 * than one loop created by this plugin.
 * @module cordis-plugin-loop/engine
 */
import { jitterCapMinutes } from './cadence.ts'
import { buildPrompt, ownerOf, selectLoopRecords, shortId, TASK_TITLE, type LoopRecord } from './state.ts'
import { codePointLength as countCodePoints, planLoop, type PlanInput } from './plan.ts'
import { roundsStarted } from './loop-projection.ts'
import { firstRoundPrompt } from './prompt.ts'
import type { LoopConfig } from './config.ts'
import type {
  DeliveryReceiptLike,
  DeliveryTally,
  LoopStartedBy,
  LoopState,
  SchedulePort,
  ScheduleRecordLike,
} from './types.ts'

/** Largest page of delivery receipts the live service will return in one read. */
export const RECEIPT_PAGE = 100

/**
 * How many pages one round count will walk before it calls itself truncated.
 *
 * 100 pages is 10000 receipts, far beyond the service's own retention cap
 * (200 records by default), so this is a liveness guard against a pathological
 * or lying backend rather than a working limit.
 */
export const MAX_RECEIPT_PAGES = 100

/** Model-visible text the engine hands to the session. */
export interface LoopMessage {
  /** Message text. */
  readonly text: string
}

/** Transport the engine uses to reach the calling agent. */
export interface LoopAgent {
  /** Session identity of the agent. */
  readonly sessionId: string
  /** Working directory the session was created in. */
  readonly cwd: string
  /** Whether this agent is a delegated child rather than a root session. */
  readonly isSubagent: boolean
  /** Send one immediate, wake-up round to the agent. */
  readonly send: (message: LoopMessage) => void
}

/** Dependencies the engine needs; all injected so tests can drive a fake clock. */
export interface EngineDeps {
  /** Effective plugin configuration. */
  readonly config: LoopConfig
  /** The schedule seam, or `undefined` when the plugin is inactive. */
  readonly schedule: SchedulePort | undefined
  /** Explicit IANA time zone used by every cron record. */
  readonly timeZone: string
  /** Logger used for warnings and cancel notices. */
  readonly logger: {
    warn: (message: string) => void
    info: (message: string) => void
  }
  /** Wall-clock source; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Outcome of one engine call, ready to render. */
export interface EngineResult {
  /** Whether the call succeeded. */
  readonly ok: boolean
  /** Text returned to the caller. */
  readonly text: string
}

/** Options for {@link LoopEngine.start}. */
export interface StartRequest {
  /** `fixed` drives a cron rule; `self` arms the first safety check. */
  readonly mode: 'fixed' | 'self'
  /**
   * Who asked for the loop.
   *
   * Every command invocation is a person; every `loop_start` call is the model.
   * The value is durable state, not a parameter the caller may waive, because
   * the round cap and the projection's `startedBy` both read it back later.
   */
  readonly startedBy: LoopStartedBy
  /** Requested interval in seconds, when the caller supplied one. */
  readonly requestedSeconds?: number
  /** Exact task text, when the loop carries one inline. */
  readonly task?: string
  /** Absolute path of the default task file, when the task comes from one. */
  readonly taskFile?: string
  /** Whether the file text was truncated at the byte budget. */
  readonly truncated?: boolean
}

/** Outcome of one session-scoped read: the loops, or a friendly refusal. */
export type ListResult =
  | { readonly ok: true; readonly loops: readonly LoopRecord[] }
  | { readonly ok: false; readonly text: string }

/** Per-session in-memory bookkeeping the omission guard relies on. */
interface SessionBookkeeping {
  /** Record id → newest receipt already accounted for, plus the receipt count. */
  readonly receipts: Map<string, { scheduledAt: string; delivered: number }>
  /** Record ids that already spent their first omission guard. */
  readonly guarded: Set<string>
}

/**
 * The one object that owns every live loop in this process.
 */
export class LoopEngine {
  private readonly deps: EngineDeps
  private readonly clock: () => number
  private readonly sessions = new Map<string, SessionBookkeeping>()

  /**
   * @param deps - Configuration, the schedule seam, the time zone, and a logger.
   */
  constructor(deps: EngineDeps) {
    this.deps = deps
    this.clock = deps.now ?? ((): number => Date.now())
  }

  /** Whether the schedule seam is available. */
  get available(): boolean {
    return this.deps.schedule !== undefined
  }

  /** The explicit IANA time zone every cron record of this engine carries. */
  get timeZone(): string {
    return this.deps.timeZone
  }

  /**
   * Read the engine's clock.
   *
   * The registry and the guard share this clock so a test can move one value
   * and have every deadline agree.
   *
   * @returns Epoch milliseconds.
   */
  now(): number {
    return this.clock()
  }

  /**
   * Start one loop, replacing any loop this session already owns.
   *
   * @param agent - Calling agent.
   * @param request - Mode and task source.
   * @returns The confirmation text, or a refusal.
   */
  async start(agent: LoopAgent, request: StartRequest): Promise<EngineResult> {
    const schedule = this.deps.schedule
    if (agent.isSubagent) {
      return { ok: false, text: 'A subagent session cannot start a loop.' }
    }
    const now = this.clock()
    // Every refusal and every normalization below is shared with the read-only
    // `--dry-run` preview (`src/plan.ts`), so a preview cannot disagree with what
    // this call would store. The refusals keep their exact original wording.
    const planned = planLoop(this.planInputOf(agent, request, now), {
      available: schedule !== undefined,
      buildTitle,
      buildPrompt,
    })
    if ('error' in planned) return { ok: false, text: planned.error }
    const plan = planned
    const state = plan.state
    const task = request.task ?? ''
    const taskCodePoints = plan.taskCodePoints
    const listed = await this.list(agent)
    if (!listed.ok) return { ok: false, text: listed.text }
    const existing = listed.loops
    let created: ScheduleRecordLike
    try {
      created =
        plan.expression === undefined
          ? await schedule!.create(agent.sessionId, {
              prompt: plan.prompt,
              title: plan.title,
              every_seconds: this.deps.config.safetyCheckSeconds,
            })
          : await schedule!.create(agent.sessionId, {
              prompt: plan.prompt,
              title: plan.title,
              cron: { expression: plan.expression, time_zone: this.deps.timeZone },
            })
    } catch (error) {
      return { ok: false, text: `Could not create the loop reminder: ${messageOf(error)}` }
    }
    const firstWaitSeconds =
      plan.expression === undefined
        ? this.deps.config.safetyCheckSeconds
        : Math.max(0, Math.round((Date.parse(created.scheduledAt) - now) / 1000))
    // Deliver round one BEFORE anything about the session's previous state
    // changes. If the delivery fails the created row is rolled back, so a failed
    // start leaves storage exactly as it was: no armed record, and a replaced
    // loop is still the live one.
    try {
      agent.send({ text: firstRoundPrompt(state, firstWaitSeconds, shortId(created.id)) })
    } catch (error) {
      const rolledBack = await this.deleteRecord(agent, created.id)
      return {
        ok: false,
        text: rolledBack
          ? `Could not deliver the first round, so no loop was armed: ${messageOf(error)}`
          : `Could not deliver the first round, so the new reminder is not armed; it could not be removed itself, so remove it with /loop stop: ${messageOf(error)}`,
      }
    }
    let replaced = 0
    for (const record of existing) {
      if (await this.deleteRecord(agent, record.id)) {
        replaced += 1
      } else {
        this.deps.logger.warn(
          `loop: replacing the loop left ${record.id} in place; it is still armed and keeps firing until it is removed with /loop stop`,
        )
      }
    }
    this.bookkeeping(agent.sessionId).receipts.set(created.id, { scheduledAt: '', delivered: 0 })

    const lines: string[] = []
    if (existing.length === 0) lines.push('Loop started.')
    else if (replaced === existing.length) lines.push(`Loop restarted (replaced ${replaced} previous loop).`)
    else {
      // Never claim a replacement that did not happen: the previous record is
      // still there, so this session now owns more than one loop.
      lines.push(
        `Loop restarted, but ${existing.length - replaced} previous record(s) could not be removed and are still armed (see the log); remove them with /loop stop.`,
      )
    }
    lines.push(`Id: ${shortId(created.id)}`)
    lines.push(`Title: ${plan.title}`)
    if (state.mode === 'self') {
      lines.push(
        `Cadence: self-paced — the wait is currently ${Math.round(state.cadenceSeconds / 60)} minute(s) (a recurring reminder), and you replace it each round with loop_next`,
      )
    } else {
      lines.push(
        `Cadence: ${state.cadenceLabel}, wall-clock anchored (cron \`${created.expression ?? plan.expression}\`, time zone ${this.deps.timeZone})`,
      )
      const cap = jitterCapMinutes(plan.cadenceSeconds)
      lines.push(
        plan.offsetMinutes > 0
          ? `Jitter: ${plan.jitterSeconds}s = ${plan.offsetMinutes} minute(s), drawn from min(10% of the normalized cadence, 15 min) with fingerprint ${plan.fingerprint}`
          : cap === 0
            ? `Jitter: 0 (minute precision cannot express a smaller offset for this cadence; fingerprint ${plan.fingerprint})`
            : `Jitter: 0 (the fingerprint drew no offset; this cadence could carry up to ${cap} minute(s). fingerprint ${plan.fingerprint})`,
      )
      if (plan.approximation !== undefined) lines.push(`Approximation: ${plan.approximation}.`)
      lines.push(
        'Round counters: the cron rule fires on its own, so the stored iteration counter does not advance; /loop status reports the real delivery count, the quiet streak and the omission count.',
      )
    }
    lines.push(
      plan.expression === undefined
        ? `First wait: ${Math.round(firstWaitSeconds / 60)} minute(s) (self-paced safety check); round 1 runs immediately now.`
        : `First fire: ${created.scheduledAt} (${Math.round(firstWaitSeconds / 60)} minute(s)); round 1 runs immediately now.`,
    )
    lines.push(`Expires: ${new Date(state.expiresAt).toISOString()} (${this.deps.config.lifetimeDays} days)`)
    lines.push(
      `Started by: ${state.startedBy} · round limit: ${this.deps.config.maxRounds} (reaching it stops the loop and says so)`,
    )
    lines.push(
      `Task: ${request.taskFile === undefined ? `${taskCodePoints} code points, inline` : `${request.taskFile} (file budget: bytes)`}`,
    )
    return { ok: true, text: lines.join('\n') }
  }

  /**
   * Build the shared planner's input for one start request.
   *
   * Keeping the mapping in one place is what makes `start` and the read-only
   * preview plan from byte-identical inputs.
   *
   * @param agent - Calling agent.
   * @param request - Mode and task source.
   * @param now - Epoch milliseconds the plan is anchored at.
   * @returns The planner input.
   */
  private planInputOf(agent: LoopAgent, request: StartRequest, now: number): PlanInput {
    return {
      sessionId: agent.sessionId,
      mode: request.mode,
      startedBy: request.startedBy,
      ...(request.requestedSeconds === undefined ? {} : { requestedSeconds: request.requestedSeconds }),
      ...(request.task === undefined ? {} : { task: request.task }),
      ...(request.taskFile === undefined ? {} : { taskFile: request.taskFile }),
      ...(request.truncated === true ? { truncated: true } : {}),
      config: this.deps.config,
      timeZone: this.deps.timeZone,
      now,
    }
  }

  /**
   * Every loop this session owns, in creation order.
   *
   * A read failure is reported as a refusal rather than thrown: the engine's
   * callers are a command surface and two tools, and all of them owe the model
   * a friendly message, exactly like a failed create does.
   *
   * @param agent - Calling agent.
   * @returns The decoded loop records, or the refusal text.
   */
  async list(agent: LoopAgent): Promise<ListResult> {
    const schedule = this.deps.schedule
    if (schedule === undefined) return { ok: true, loops: Object.freeze([]) }
    try {
      const records = await schedule.list({ sessionId: agent.sessionId })
      return { ok: true, loops: selectLoopRecords(records, ownerOf(agent.sessionId)) }
    } catch (error) {
      this.deps.logger.warn(`loop: reading the session's loop state failed: ${messageOf(error)}`)
      return { ok: false, text: `Could not read the loop state: ${messageOf(error)}` }
    }
  }

  /**
   * Render `/loop status`.
   *
   * @param agent - Calling agent.
   * @returns The status text.
   */
  async status(agent: LoopAgent): Promise<EngineResult> {
    if (!this.available) return { ok: false, text: 'The schedule service is not composed, so there is no loop state to read.' }
    const listed = await this.list(agent)
    if (!listed.ok) return { ok: false, text: listed.text }
    const loops = listed.loops
    if (loops.length === 0) {
      return { ok: true, text: 'No loop is active in this session.\nStart one with /loop [<interval>] [<task>].' }
    }
    const lines = ['Active loops in this session:', '']
    for (const loop of loops) {
      // The panel prints the same two numbers the projection serves: the
      // delivered count across every history page, and the round it makes this
      // loop's current one. A one-page read here would disagree with the guard
      // that stops the loop and with the capsule above the composer.
      const tally = await this.countDeliveries(agent, loop.id)
      const cadence = loop.state.mode === 'self' ? 'self-paced' : loop.state.cadenceLabel
      lines.push(`- ${shortId(loop.id)}  ${cadence}`)
      lines.push(`  next: ${loop.record.scheduledAt}`)
      lines.push(`  expires: ${new Date(loop.state.expiresAt).toISOString()}`)
      lines.push(`  started by: ${loop.state.startedBy}`)
      lines.push(`  round: ${roundsStarted(loop.state.iteration, tally.count)}`)
      lines.push(
        `  delivered so far: ${tally.count}${tally.truncated ? '+' : ''} · record iteration ${loop.state.iteration} · quiet streak ${loop.state.quietStreak} · omissions ${loop.state.omissions}`,
      )
      lines.push(`  round limit: ${this.deps.config.maxRounds} (reaching it stops the loop)`)
      lines.push(
        `  task: ${loop.state.taskFile ?? `${countCodePoints(loop.state.task ?? '')} code points inline`}`,
      )
      if (tally.truncated) {
        lines.push('  note: the delivery history was longer than one walk reads, so the count is a lower bound.')
      }
    }
    return { ok: true, text: lines.join('\n') }
  }

  /**
   * Stop one loop, several loops, or every loop of this session.
   *
   * @param agent - Calling agent.
   * @param selector - Short id, full id, `all`, or `undefined` (also `all`).
   * @returns The report text.
   */
  async stop(agent: LoopAgent, selector: 'all' | string | undefined): Promise<EngineResult> {
    if (!this.available) return { ok: false, text: 'The schedule service is not composed, so there is nothing to stop.' }
    const listed = await this.list(agent)
    if (!listed.ok) return { ok: false, text: listed.text }
    const loops = listed.loops
    if (loops.length === 0) return { ok: false, text: 'No loop is active in this session; nothing to stop.' }
    if (selector === 'all' || selector === undefined) {
      const stopped: string[] = []
      for (const loop of loops) {
        await this.deleteRecord(agent, loop.id)
        stopped.push(shortId(loop.id))
      }
      return { ok: true, text: `Stopped ${stopped.length} loop(s): ${stopped.join(', ')}.` }
    }
    const wanted = selector.trim()
    const match = loops.find((loop) => shortId(loop.id) === wanted.replace(/^schedule-/u, '') || loop.id === wanted)
    if (match === undefined) {
      const live = loops.map((loop) => shortId(loop.id)).join(', ')
      return { ok: false, text: `No loop with id "${selector}" is active in this session. Active: ${live}.` }
    }
    await this.deleteRecord(agent, match.id)
    return { ok: true, text: `Stopped loop ${shortId(match.id)}.` }
  }

  /**
   * Read the retained delivery receipts of one record, newest first.
   *
   * @param agent - Calling agent.
   * @param id - Record id.
   * @param limit - Page size for the first read; the live service caps it at 100.
   * @returns The receipts, or an empty list when the record is gone.
   */
  async receiptsOf(agent: LoopAgent, id: string, limit = RECEIPT_PAGE): Promise<readonly DeliveryReceiptLike[]> {
    const schedule = this.deps.schedule
    if (schedule === undefined) return Object.freeze([])
    try {
      const page = await schedule.history({ sessionId: agent.sessionId, id, limit })
      if ('records' in page) return page.records
    } catch {
      // A history read is diagnostic only; a failure must not break the caller.
    }
    return Object.freeze([])
  }

  /**
   * Count how many rounds one record's retained history proves were delivered.
   *
   * The service returns one page of at most {@link RECEIPT_PAGE} receipts and
   * publishes `nextBefore` only while older ones remain, so a single read can
   * never answer "how many rounds have there been" for a loop that ran past one
   * page. That mattered: the round cap compared a one-page count against
   * `config.maxRounds`, which the schema allows up to 100000, so any cap above
   * one page was unreachable in silence.
   *
   * The walk stops as soon as `atLeast` is reached, which is what the cap check
   * needs, and it stops after {@link MAX_RECEIPT_PAGES} pages no matter what, so
   * a pathological history cannot stall a turn teardown. A walk that hits that
   * ceiling reports `truncated` rather than a number it did not establish.
   *
   * @param agent - Calling agent.
   * @param id - Record id.
   * @param atLeast - Stop once this many receipts were seen.
   * @returns The tally, with `truncated` set when older pages were left unread.
   */
  async countDeliveries(agent: LoopAgent, id: string, atLeast = Number.MAX_SAFE_INTEGER): Promise<DeliveryTally> {
    const schedule = this.deps.schedule
    if (schedule === undefined) return { count: 0, truncated: false, pruned: false }
    let before: string | undefined
    let count = 0
    let truncated = false
    let pruned = false
    for (let page = 0; page < MAX_RECEIPT_PAGES; page += 1) {
      let read: Awaited<ReturnType<SchedulePort['history']>>
      try {
        read = await schedule.history({
          sessionId: agent.sessionId,
          id,
          limit: RECEIPT_PAGE,
          ...(before === undefined ? {} : { before }),
        })
      } catch (error) {
        // A history read is diagnostic; a failure must not break the caller.
        this.deps.logger.warn(`loop: counting the rounds of ${id} failed: ${messageOf(error)}`)
        return { count, truncated: true, pruned }
      }
      if (!('records' in read)) return { count, truncated: false, pruned }
      pruned = pruned || read.earlierRecordsPruned === true
      count += read.records.length
      if (count >= atLeast) return { count, truncated: false, pruned }
      if (read.records.length < RECEIPT_PAGE) return { count, truncated: false, pruned }
      const cursor = read.nextBefore ?? read.records.at(-1)?.messageId
      if (cursor === undefined || cursor === '') return { count, truncated: false, pruned }
      before = cursor
    }
    truncated = true
    return { count, truncated, pruned }
  }

  /**
   * Replace the live record of one loop with new state.
   *
   * @param agent - Calling agent.
   * @param loop - The loop being rewritten.
   * @param state - New loop state.
   * @param change - Timing change; omitted keeps the committed target.
   * @returns The committed record, or `undefined` when the write lost a race.
   */
  async rewrite(
    agent: LoopAgent,
    loop: LoopRecord,
    state: LoopState,
    change?: { kind: 'at'; at: string } | { kind: 'every'; every_seconds: number },
  ): Promise<ScheduleRecordLike | undefined> {
    const schedule = this.deps.schedule
    if (schedule === undefined) return undefined
    const { prompt } = buildPrompt(state)
    try {
      const outcome = await schedule.update({
        sessionId: agent.sessionId,
        id: loop.id,
        expected: loop.record as unknown,
        prompt,
        ...(change === undefined ? {} : { change }),
      })
      if ('record' in outcome && outcome.updated) return outcome.record
    } catch (error) {
      this.deps.logger.warn(`loop: updating ${loop.id} failed: ${messageOf(error)}`)
    }
    return undefined
  }

  /**
   * Delete one record and forget its bookkeeping.
   *
   * @param agent - Calling agent.
   * @param id - Record id.
   * @returns Whether a row was removed.
   */
  async deleteRecord(agent: LoopAgent, id: string): Promise<boolean> {
    const schedule = this.deps.schedule
    if (schedule === undefined) return false
    let deleted = false
    try {
      const result = await schedule.delete({ sessionId: agent.sessionId, id })
      deleted = result.deleted
    } catch (error) {
      this.deps.logger.warn(`loop: deleting ${id} failed: ${messageOf(error)}`)
    }
    this.bookkeeping(agent.sessionId).receipts.delete(id)
    this.bookkeeping(agent.sessionId).guarded.delete(id)
    return deleted
  }

  /**
   * Cancel records discovered by a scan, logging each task before removal.
   *
   * The owner check is enforced here, not just in the log text: a row is removed
   * only when its header names the session it is bound to. A `DSH_LOOP`-prefixed
   * record whose header owner is somebody else — a hand-edited header, or a
   * record another writer left behind — is reported and left alone.
   *
   * @param records - Records bound to their owning session.
   * @param reason - Why the cancel happened.
   * @returns How many rows were removed.
   */
  async cancelRecords(
    records: readonly { readonly sessionId: string; readonly record: ScheduleRecordLike }[],
    reason: string,
  ): Promise<number> {
    const schedule = this.deps.schedule
    if (schedule === undefined) return 0
    let removed = 0
    for (const entry of records) {
      const decoded = selectLoopRecords([entry.record], ownerOf(entry.sessionId))[0]
      if (decoded === undefined) {
        this.deps.logger.warn(
          `loop: leaving ${entry.record.id} in session ${entry.sessionId} alone (${reason}): its header is not a loop record owned by that session`,
        )
        continue
      }
      this.deps.logger.warn(
        `loop: cancelling ${entry.record.id} in session ${entry.sessionId} (${reason}); task: ${taskSummary(decoded.state)}`,
      )
      try {
        const result = await schedule.delete({ sessionId: entry.sessionId, id: entry.record.id })
        if (result.deleted) removed += 1
      } catch (error) {
        this.deps.logger.warn(`loop: cancelling ${entry.record.id} failed: ${messageOf(error)}`)
      }
    }
    return removed
  }

  /**
   * Record that one loop's newest delivery is accounted for.
   *
   * This is a watermark only: it never touches the omission-guard flag, so the
   * guard's own pass cannot erase the evidence that it already fired.
   *
   * @param sessionId - Session identity.
   * @param id - Record id.
   * @param scheduledAt - Newest receipt the caller is answering.
   * @param delivered - Receipt count observed with it.
   */
  markAccounted(sessionId: string, id: string, scheduledAt: string, delivered: number): void {
    this.bookkeeping(sessionId).receipts.set(id, { scheduledAt, delivered })
  }

  /**
   * Record that the model answered one loop during the current turn.
   *
   * @param sessionId - Session identity.
   * @param id - Record id.
   * @param scheduledAt - Newest receipt the model is answering.
   * @param delivered - Receipt count observed with it.
   */
  markContinued(sessionId: string, id: string, scheduledAt: string, delivered: number): void {
    this.markAccounted(sessionId, id, scheduledAt, delivered)
    this.bookkeeping(sessionId).guarded.delete(id)
  }

  /**
   * Read the bookkeeping for one loop.
   *
   * @param sessionId - Session identity.
   * @param id - Record id.
   * @returns The newest accounted receipt, or `undefined` when none is known.
   */
  accounted(sessionId: string, id: string): { scheduledAt: string; delivered: number } | undefined {
    return this.sessions.get(sessionId)?.receipts.get(id)
  }

  /**
   * Read whether one loop already spent its first omission guard.
   *
   * @param sessionId - Session identity.
   * @param id - Record id.
   * @returns Whether the guard was used.
   */
  isGuarded(sessionId: string, id: string): boolean {
    return this.sessions.get(sessionId)?.guarded.has(id) ?? false
  }

  /**
   * Record that one loop used its omission guard.
   *
   * @param sessionId - Session identity.
   * @param id - Record id.
   */
  markGuarded(sessionId: string, id: string): void {
    this.bookkeeping(sessionId).guarded.add(id)
  }

  /**
   * Drop the in-memory bookkeeping of one session.
   *
   * @param sessionId - Session identity.
   */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Resolve the cadence for one start request.
   *
   * @param request - Start request.
   * @returns The cadence facts or a refusal text.
   */
  private bookkeeping(sessionId: string): SessionBookkeeping {
    let entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      entry = { receipts: new Map(), guarded: new Set() }
      this.sessions.set(sessionId, entry)
    }
    return entry
  }
}

/**
 * Build the schedule task title: the fixed prefix plus a task excerpt, so a
 * user reading the schedule list can tell two loops apart.
 *
 * A loop the model armed on its own instinct carries `[agent]` so a person
 * scanning the schedule list can tell at a glance which loops they asked for.
 *
 * @param state - Loop state of the record being created.
 * @returns A trimmed title of at most {@link TITLE_LIMIT} characters.
 */
export function buildTitle(state: LoopState): string {
  const excerpt = titleExcerpt(state)
  const origin = state.startedBy === 'agent' ? '[agent] ' : ''
  const title = excerpt.length === 0 ? `${origin}${TASK_TITLE}` : `${origin}${TASK_TITLE}: ${excerpt}`
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 3)}...`
}

/** Longest title the schedule service accepts. */
export const TITLE_LIMIT = 120

function titleExcerpt(state: LoopState): string {
  const source = state.taskFile === undefined ? (state.task ?? '') : `read ${state.taskFile}`
  return source.replace(/\s+/gu, ' ').trim()
}

/** Flatten an unknown failure into one line. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Count the code points of one string.
 *
 * Re-exported from the shared planner so the plugin keeps exactly one
 * implementation of the code-point budget and every existing importer keeps
 * working.
 *
 * @param text - Text to measure.
 * @returns The number of Unicode code points.
 */
export { countCodePoints as codePointLength }

/** First line of a loop's task, short enough for a log line. */
function taskSummary(state: LoopState): string {
  if (state.taskFile !== undefined) return `file ${state.taskFile}`
  const text = (state.task ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}
