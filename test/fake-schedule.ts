/**
 * An in-memory `ctx.schedule` double for the unit tests.
 *
 * It canonicalizes cron expressions with the real package helper and keeps the
 * same request/response shapes, so the engine, the command surface and the
 * omission guard run unmodified against it. `integration.test.ts` covers the
 * real service; this double exists so a fake clock can drive the deterministic
 * cases.
 * @module cordis-plugin-loop/test/fake-schedule
 */
import {
  ScheduleId,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createCronScheduleRecord,
  createEveryScheduleRecord,
  resolveCronOccurrence,
  resolveEveryOccurrence,
} from '@deepseek-ai/dsh-schedule'
import type {
  DeliveryReceiptLike,
  ScheduleCatalogEntryLike,
  SchedulePort,
  ScheduleRecordLike,
} from '../src/types.ts'

/** One stored row of the double. */
interface FakeRow {
  /** Durable record as the caller sees it. */
  record: ScheduleRecordLike
  /** Owning session. */
  readonly sessionId: string
  /** Retained delivery receipts, oldest first. */
  readonly receipts: DeliveryReceiptLike[]
  /** Whether `history` fails for this row. */
  historyFails?: boolean
  /**
   * Whether the row is still schedulable.
   *
   * The real service flips a one-shot to `inactive` once it delivers, and that
   * inactive row then leaves `list` and rejects `update` with
   * `schedule_ended`. The double mirrors that, because the self-paced driver's
   * record kind depends on it.
   */
  active: boolean
}

/** What one create request may carry. */
export interface FakeCreateRequest {
  /** Stored prompt. */
  readonly prompt: string
  /** Stored title. */
  readonly title: string
  /** One-shot delay in seconds. */
  readonly after_seconds?: number
  /** Fixed-rate interval in seconds. */
  readonly every_seconds?: number
  /** Five-field cron expression. */
  readonly cron?: { readonly expression: string; readonly time_zone: string }
}

/**
 * Adapt one real domain record into the structural shape callers read.
 *
 * @param record - A record built by a real `@deepseek-ai/dsh-schedule` factory.
 * @returns The same members, typed as the seam's record view.
 */
function toLike(record: {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
  readonly everySeconds?: number
  readonly expression?: string
  readonly timeZone?: string
}): ScheduleRecordLike {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    prompt: record.prompt,
    scheduledAt: record.scheduledAt,
    ...(record.everySeconds === undefined ? {} : { everySeconds: record.everySeconds }),
    ...(record.expression === undefined ? {} : { expression: record.expression }),
    ...(record.timeZone === undefined ? {} : { timeZone: record.timeZone }),
  }
}

/** A controllable schedule service double. */
export class FakeSchedule implements SchedulePort {
  private readonly rows = new Map<string, FakeRow>()
  private sequence = 0
  private messageSequence = 0
  /** Wall clock the double reads when no external source is installed. */
  now = 1_700_000_000_000
  /**
   * Optional external clock.
   *
   * A test that also moves an engine's clock installs the same source here so
   * the row targets and the engine deadlines never disagree.
   */
  external?: () => number
  /** Number of `create` calls, for "one record per loop" assertions. */
  createCalls = 0
  /** Number of `update` calls. */
  updateCalls = 0
  /** Number of `delete` calls. */
  deleteCalls = 0
  /** Number of `catalog` calls, so a test can prove discovery really ran. */
  catalogCalls = 0
  /** Failure text `list` throws while set, for the read-failure path. */
  listFails?: string
  /** While set, `delete` reports `deleted: false` and keeps the row. */
  deleteFails = false

  /** Read the current time from the external source or the local field. */
  private time(): number {
    return this.external?.() ?? this.now
  }

  /**
   * Create one row.
   *
   * Targets, phase, and canonicalisation all come from the real
   * `@deepseek-ai/dsh-schedule` domain functions, so a cron row's `scheduledAt`
   * is the expression's true next occurrence rather than a stand-in.
   *
   * @param sessionId - Owning session.
   * @param request - Prompt, title, and exactly one selector.
   * @returns The stored record.
   */
  async create(sessionId: string, request: FakeCreateRequest): Promise<ScheduleRecordLike> {
    this.createCalls += 1
    const id = `schedule-${++this.sequence}`
    const now = this.time()
    const record = toLike(
      request.cron !== undefined
        ? createCronScheduleRecord(ScheduleId(id), request.prompt, request.cron, now, request.title)
        : request.every_seconds !== undefined
          ? createEveryScheduleRecord(ScheduleId(id), request.prompt, request.every_seconds, now, request.title)
          : createAfterScheduleRecord(
              ScheduleId(id),
              request.prompt,
              request.after_seconds ?? 60,
              now,
              request.title,
            ),
    )
    this.rows.set(id, { record, sessionId, receipts: [], active: true })
    return record
  }

  /**
   * List one session's rows that are still schedulable.
   *
   * @param request - Session identity.
   * @returns The active records in creation order.
   */
  async list(request: { sessionId: string }): Promise<readonly ScheduleRecordLike[]> {
    if (this.listFails !== undefined) throw new Error(this.listFails)
    return [...this.rows.values()]
      .filter((row) => row.sessionId === request.sessionId && row.active)
      .map((row) => row.record)
  }

  /**
   * List every row, active or not, in the shape the live service returns.
   *
   * @returns The catalogue entries in creation order.
   */
  async catalog(): Promise<readonly ScheduleCatalogEntryLike[]> {
    this.catalogCalls += 1
    return [...this.rows.values()].map((row) => ({
      ...row.record,
      sessionId: row.sessionId,
      status: row.active ? 'active' : 'inactive',
      ...(row.receipts.length === 0 ? {} : { lastDelivery: row.receipts[row.receipts.length - 1]! }),
    }))
  }

  /**
   * Read one row's receipts, newest first.
   *
   * @param request - Session, id, and page size.
   * @returns The page, or a not-found result.
   */
  async history(request: {
    sessionId: string
    id: string
    limit: number
    before?: string
  }): Promise<
    | {
        readonly id: string
        readonly records: readonly DeliveryReceiptLike[]
        readonly earlierRecordsUnavailable: boolean
      }
    | { readonly id: string; readonly code: string }
  > {
    const row = this.rows.get(request.id)
    if (row === undefined || row.sessionId !== request.sessionId) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    if (row.historyFails === true) throw new Error('fake history failure')
    const newestFirst = [...row.receipts].reverse()
    const start = request.before === undefined ? 0 : newestFirst.findIndex((entry) => entry.messageId === request.before) + 1
    return {
      id: request.id,
      records: newestFirst.slice(start, start + request.limit),
      earlierRecordsUnavailable: false,
    }
  }

  /**
   * Delete one row.
   *
   * @param request - Session and id.
   * @returns Whether a row was removed.
   */
  async delete(request: { sessionId: string; id: string }): Promise<{
    readonly id: string
    readonly deleted: boolean
    readonly code?: string
  }> {
    this.deleteCalls += 1
    const row = this.rows.get(request.id)
    if (row === undefined || row.sessionId !== request.sessionId) {
      return { id: request.id, deleted: false, code: 'schedule_not_found' }
    }
    if (this.deleteFails) {
      // A store that refuses the delete while the row stays present: the caller
      // must not report the removal it did not get.
      return { id: request.id, deleted: false, code: 'schedule_store_error' }
    }
    this.rows.delete(request.id)
    return { id: request.id, deleted: true }
  }

  /**
   * Compare-and-update one row.
   *
   * @param request - Session, id, expected record, optional prompt, optional timing change.
   * @returns The committed record, a miss, or an error.
   */
  async update(request: {
    sessionId: string
    id: string
    expected: unknown
    prompt?: string
    change?:
      | { readonly kind: 'at'; readonly at: string }
      | { readonly kind: 'every'; readonly every_seconds: number }
      | { readonly kind: 'cron'; readonly cron: { readonly expression: string; readonly time_zone: string } }
  }): Promise<
    | { readonly id: string; readonly updated: boolean; readonly record: ScheduleRecordLike }
    | { readonly id: string; readonly updated: false; readonly code: string }
    | { readonly code: string; readonly message: string }
  > {
    this.updateCalls += 1
    const row = this.rows.get(request.id)
    if (row === undefined || row.sessionId !== request.sessionId) {
      return { id: request.id, updated: false, code: 'schedule_not_found' }
    }
    if (!row.active) return { id: request.id, updated: false, code: 'schedule_ended' }
    const expected = request.expected as ScheduleRecordLike
    if (expected.scheduledAt !== row.record.scheduledAt || expected.prompt !== row.record.prompt) {
      return { id: request.id, updated: false, code: 'schedule_conflict' }
    }
    const now = this.time()
    // Every timing change is recomputed by the real domain factories with the
    // accepting instant as its anchor, which is exactly what the service does
    // ("the new first target is the host's acceptance time plus the interval").
    let retimed: ScheduleRecordLike = row.record
    if (request.change !== undefined && request.change.kind === 'at') {
      retimed = { ...row.record, kind: 'at', scheduledAt: new Date(Date.parse(request.change.at)).toISOString() }
    } else if (request.change !== undefined && request.change.kind === 'every') {
      retimed = toLike(
        createEveryScheduleRecord(
          ScheduleId(row.record.id),
          request.prompt ?? row.record.prompt,
          request.change.every_seconds,
          now,
          row.record.title,
        ),
      )
    } else if (request.change !== undefined) {
      retimed = toLike(
        createCronScheduleRecord(
          ScheduleId(row.record.id),
          request.prompt ?? row.record.prompt,
          request.change.cron,
          now,
          row.record.title,
        ),
      )
    }
    const next: ScheduleRecordLike = {
      ...retimed,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    }
    row.record = next
    return { id: request.id, updated: true, record: next }
  }

  /**
   * Simulate one due delivery: append its receipt and advance the row the way
   * the real runtime does — a one-shot retires, a recurring rule moves to the
   * occurrence the real resolver picks.
   *
   * @param id - Row to deliver.
   * @param scheduledAt - Occurrence the delivery is for; defaults to the row's target.
   */
  deliver(id: string, scheduledAt?: string): void {
    const row = this.rows.get(id)
    if (row === undefined) throw new Error(`unknown record ${id}`)
    const now = this.time()
    const occurrence = scheduledAt ?? row.record.scheduledAt
    // Simulating a due delivery means the target has been reached, so the
    // decided instant is at or after it — which is what the real resolver
    // requires ("a cron dispatch cannot precede the active scheduledAt").
    const decidedAt = Math.max(now, Date.parse(occurrence))
    row.receipts.push({
      scheduledAt: occurrence,
      deliveredAt: new Date(decidedAt).toISOString(),
      messageId: `message-${++this.messageSequence}`,
    })
    if (row.record.kind === 'at' || row.record.kind === 'after') {
      row.active = false
      return
    }
    // Advance with the real resolver, so a cron row lands on its expression's
    // next occurrence instead of a stand-in interval.
    const record = row.record as unknown as Parameters<typeof resolveCronOccurrence>[0]
    const advanced =
      row.record.kind === 'cron'
        ? resolveCronOccurrence(record, decidedAt)
        : resolveEveryOccurrence(record as never, decidedAt)
    if (advanced.nextScheduledAt !== undefined) {
      row.record = { ...row.record, scheduledAt: advanced.nextScheduledAt }
    } else {
      row.active = false
    }
  }

  /**
   * Make `list` fail, to exercise the friendly read-failure path.
   *
   * @param fails - Whether the read fails.
   * @param message - Failure text.
   */
  breakList(fails = true, message = 'storage backend exploded'): void {
    this.listFails = fails ? message : undefined
  }

  /**
   * Make one row's history read fail, to exercise the guard's containment.
   *
   * @param id - Row to break.
   * @param fails - Whether the read fails.
   */
  breakHistory(id: string, fails = true): void {
    const row = this.rows.get(id)
    if (row === undefined) throw new Error(`unknown record ${id}`)
    row.historyFails = fails
  }

  /**
   * Read one stored record.
   *
   * @param id - Row id.
   * @returns The record, or `undefined`.
   */
  peek(id: string): ScheduleRecordLike | undefined {
    return this.rows.get(id)?.record
  }

  /**
   * Read every stored row.
   *
   * @returns The records, in creation order.
   */
  all(): readonly ScheduleRecordLike[] {
    return [...this.rows.values()].map((row) => row.record)
  }

  /** Number of stored rows. */
  get size(): number {
    return this.rows.size
  }
}
