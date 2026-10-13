/**
 * Shared types for the loop plugin's schedule seam.
 *
 * The seam is deliberately structural rather than a `dsh-schedule` import: the
 * plugin stays inert when the schedule service is absent, so the only thing the
 * lifecycle needs is the shape below.
 * @module cordis-plugin-loop/types
 */

/** Which engine drives a loop. */
export type LoopMode = 'fixed' | 'self'

/** The complete, durable live state of one loop. */
export interface LoopState {
  /** Prefix of the loop that created this record, for `status` and `stop`. */
  readonly owner: string
  /** Which engine drives the loop. */
  readonly mode: LoopMode
  /** Normalized cadence in seconds; `0` for a self-paced loop. */
  readonly cadenceSeconds: number
  /** Canonical cadence text; `self-paced` for a self-paced loop. */
  readonly cadenceLabel: string
  /** Stable fingerprint of `(session, cadence, task)`; drives the jitter. */
  readonly fingerprint: string
  /** Deterministic offset actually applied, in seconds. */
  readonly jitterSeconds: number
  /** Rounds this loop has delivered. */
  readonly iteration: number
  /** Consecutive rounds the model marked quiet. */
  readonly quietStreak: number
  /** Continuation omissions already observed and handled. */
  readonly omissions: number
  /** Epoch milliseconds this run ends; the last round runs before the delete. */
  readonly expiresAt: number
  /** Epoch milliseconds the current wait started from. */
  readonly lastRunAt: number
  /** Absolute path of the default-task file, when the task comes from one. */
  readonly taskFile?: string
  /** Whether the file text was truncated to the byte budget. */
  readonly truncated?: boolean
  /** Literal task text; present for an inline task. */
  readonly task?: string
}

/** Minimal structural view of one durable `dsh-schedule` record. */
export interface ScheduleRecordLike {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
  readonly everySeconds?: number
  readonly expression?: string
  readonly timeZone?: string
}

/** One host-wide catalogue row: the record plus its session and lifecycle status. */
export interface ScheduleCatalogEntryLike extends ScheduleRecordLike {
  /** Session the record is bound to. */
  readonly sessionId: string
  /** `active` while the row still schedules; `inactive` once a one-shot fired. */
  readonly status: string
  /** Newest durable delivery receipt, when the row has one. */
  readonly lastDelivery?: DeliveryReceiptLike
}

/** Minimal structural view of one delivery receipt. */
export interface DeliveryReceiptLike {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly messageId: string
}

/** Structural view of the `ctx.schedule` service this plugin uses. */
export interface SchedulePort {
  create(
    sessionId: string,
    request: {
      prompt: string
      title: string
      after_seconds?: number
      every_seconds?: number
      cron?: { expression: string; time_zone: string }
    },
  ): Promise<ScheduleRecordLike>
  list(request: { sessionId: string }): Promise<readonly ScheduleRecordLike[]>
  /**
   * Host-wide catalogue, including rows that already finished.
   *
   * Optional in the seam because only the kill switch's global cancel uses it,
   * and the real service always provides it. It is reached through the live
   * service rather than a forwarding adapter, so an assembly that composes a
   * partial double still behaves predictably: a missing `catalog` cancels
   * nothing instead of throwing.
   */
  catalog?(): Promise<readonly ScheduleCatalogEntryLike[]>
  history(request: {
    sessionId: string
    id: string
    limit: number
    before?: string
  }): Promise<
    | { readonly id: string; readonly records: readonly DeliveryReceiptLike[]; readonly earlierRecordsUnavailable: boolean }
    | { readonly id: string; readonly code: string }
  >
  delete(request: { sessionId: string; id: string }): Promise<{ readonly id: string; readonly deleted: boolean; readonly code?: string }>
  update(request: {
    sessionId: string
    id: string
    expected: unknown
    prompt?: string
    change?:
      | { readonly kind: 'at'; readonly at: string }
      | { readonly kind: 'every'; readonly every_seconds: number }
      | { readonly kind: 'cron'; readonly cron: { expression: string; time_zone: string } }
  }): Promise<
    | { readonly id: string; readonly updated: boolean; readonly record: ScheduleRecordLike }
    | { readonly id: string; readonly updated: false; readonly code: string }
    | { readonly code: string; readonly message: string }
  >
}
