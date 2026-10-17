/**
 * The `loop` session projection: one whole-value snapshot of a session's live
 * loop, served to the host and to the composer capsule that renders above the
 * input box.
 *
 * ## Why this unit is not a fold over the session log
 *
 * Every other projection in the harness (`goal`, `todos`, …) folds durable
 * events, because its truth *is* the session log. A loop's truth is a
 * `dsh-schedule` record, so this unit reads a process-local mirror instead.
 * The mirror is written through by the loop plugin's own serial queue — the one
 * path every command, every tool call and the omission guard already funnel
 * through — so the projection can never disagree with the engine about what is
 * armed.
 *
 * ## Freshness, and what this unit deliberately does not do
 *
 * Reads are always current without an event: `stateOf`, `snapshot` and the
 * persisted-checkpoint view all serve a live read-through view that re-reads the
 * mirror on every access. That is deliberately stronger than the log-folding
 * units, whose state is only as recent as the last committed event — and it is
 * necessary here, because a loop's timing is *not* an event: a delivery or a
 * `loop_next` changes the armed wait with no session-log write at all.
 *
 * The *change feed* is still event-driven, exactly like every other unit: when a
 * committed session event arrives after the value moved, the fold reports the
 * new value once and connected clients receive it. A client that connects, or
 * re-reads, is seeded from `snapshot` and is immediately current.
 * @module cordis-plugin-loop/loop-projection
 */
import { z } from 'zod'
import type {
  ProjectionDefinition,
  SessionProjectionMap,
  SessionProjectionStateMap,
} from '@deepseek-ai/dsh-session-projection'

/** Who started a loop: the human command surface, or the model's own tool. */
export type LoopStartedBy = 'user' | 'agent'

/** Whether a loop is driven by a wall-clock rule or by the model's own wait. */
export type LoopProjectionMode = 'fixed' | 'self'

/**
 * The whole client-visible value of the `loop` projection.
 *
 * The field set is the contract shared with the capsule: `mode` + `cadence`
 * describe the rhythm, `nextAt` is when the next round is due, `round` is which
 * round this is, and `startedBy` says whether a person or the model armed it.
 * `round` is the number the injected round header names (see
 * {@link roundsStarted}); it is `0` only when no loop is armed, which is also
 * how a client tells "no loop" from "capability not composed" — a session
 * without a loop carries `active: false` rather than an absent key.
 */
export interface LoopProjectionView {
  /** Whether a loop is armed right now. */
  readonly active: boolean
  /** Which engine drives it; `self` when there is no loop. */
  readonly mode: LoopProjectionMode
  /** Canonical cadence text; `self-paced` for a model-paced loop. */
  readonly cadence: string
  /** ISO instant of the next round, or `null` while none is armed. */
  readonly nextAt: string | null
  /** Which round the session is on; `0` while no loop is armed. */
  readonly round: number
  /** Who armed the loop; `user` when there is none. */
  readonly startedBy: LoopStartedBy
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Live-loop snapshot served to the host and to the composer capsule. */
    loop: LoopProjectionView
  }
  interface SessionProjectionMap {
    /**
     * The same value, on the wire.
     *
     * A client-visible unit must appear in *both* tables — the state table is
     * what the host folds, the wire table is what a client face reads through
     * `faceOf("loop")`. The two are the same object here because the served
     * value is plain JSON with no host-only fields to strip.
     */
    loop: LoopProjectionView
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    /** Live-loop snapshot served to the host and to the composer capsule. */
    loop: LoopProjectionView
  }
  interface SessionProjectionMap {
    /** The same value, on the wire. */
    loop: LoopProjectionView
  }
}

/**
 * Compile-time proof that this module's augmentation actually landed.
 *
 * `declare module` merging is silent when it fails: the key simply stays absent
 * and every downstream `ProjectionDefinition<'loop', …>` stops compiling for a
 * reason that reads like a typo. This assertion turns that into one named error.
 */
const AUGMENTATION_KEY: 'loop' extends keyof SessionProjectionStateMap ? 'loop' : never = 'loop'
void AUGMENTATION_KEY

/** The value a session with no loop reports, and the shape `init` returns. */
export const NO_LOOP: LoopProjectionView = Object.freeze({
  active: false,
  mode: 'self',
  cadence: 'self-paced',
  nextAt: null,
  round: 0,
  startedBy: 'user',
})

/** The value `loop_status` serves when no authoritative read was possible. */
export const UNAVAILABLE_LOOP: LoopProjectionView = Object.freeze({ ...NO_LOOP })

/**
 * Validates both the folded state and the wire payload.
 *
 * Strict on purpose: the persisted projection cache must never forward-apply a
 * field a later revision adds, and a client must never receive one.
 */
export const loopViewSchema = z.strictObject({
  active: z.boolean(),
  mode: z.enum(['fixed', 'self']),
  cadence: z.string(),
  nextAt: z.string().nullable(),
  round: z.number().int().min(0),
  startedBy: z.enum(['user', 'agent']),
})

/**
 * The state one projection cell holds.
 *
 * Three things are carried on purpose, and they answer three different
 * questions:
 *
 * - `current` is the *frozen plain value* the mirror published. It is what the
 *   fold compares, because the registry detects a change by reference and warns
 *   about payloads it cannot detach. It is also what gets persisted in the
 *   projection checkpoint, so it must always be real JSON.
 * - `sessionId` binds the cell to its session: a cell is per session and
 *   `apply(state, event)` is handed no session, so the binding travels in the
 *   state and one registration serves every session without ever reading
 *   another session's mirror.
 * - the *served* value is not stored here at all. It is derived from the mirror
 *   by `wire.view` and keyed by the mirror's revision, which is what makes the
 *   served reference change exactly when the loop moves — the condition the
 *   registry's client-frame push is built on.
 */
interface LoopProjectionState {
  /** Frozen plain value the fold compares; JSON by construction. */
  readonly current: LoopProjectionView
  /**
   * The session this cell belongs to, read from the header `init` was handed.
   *
   * It is how one registration serves every session without ever reading
   * another session's mirror.
   */
  readonly sessionId: string
}

/** The state schema: the compared value plus the session binding. */
const loopStateSchema = z.object({ current: loopViewSchema, sessionId: z.string() })

/** Persisted-cache invalidation version; bump when the fields or semantics change. */
export const LOOP_PROJECTION_STATE_VERSION = 1

/** One session's mirror entry: the frozen value the projection serves. */
interface MirrorEntry {
  /** Frozen value the projection serves for this session. */
  readonly snapshot: LoopProjectionView
  /**
   * Monotonic counter, bumped once per *effective* write to this session.
   *
   * The projection registry decides whether to publish a client frame by
   * comparing the wire view's references (`!Object.is(views[0], views[1])`), so a
   * value that changes while its served reference stays the same is never
   * pushed — exactly the "the capsule only updates after a page refresh" defect.
   * This counter is what tells the unit to hand out a *new* object for a new
   * value and the *same* object while the value stands.
   */
  readonly revision: number
}

/**
 * Process-local mirror of the authoritative live loop, per session.
 *
 * The store is keyed by session id and holds no session object, so it is safe
 * to write from a command, a tool, or a guard callback that only knows the id.
 *
 * The unit's *state* is deliberately the served value itself rather than a
 * wrapper: the projection contract constrains a unit's state to its key's entry
 * in `SessionProjectionStateMap`, so `loop`'s state is a {@link LoopProjectionView}
 * and nothing else. Movement is signalled by the reference instead: {@link publish}
 * keeps the previous frozen object when the value is unchanged, so the fold can
 * compare by identity exactly as the registry expects.
 */
export class LoopProjectionStore {
  /**
   * Session id → mirror entry.
   *
   * A null prototype is load-bearing: a session id is attacker-adjacent text,
   * and `__proto__` as an `Object` key would corrupt the whole table.
   */
  private readonly entries: Record<string, MirrorEntry | undefined> = Object.create(null)

  /**
   * Read one session's published value.
   *
   * @param sessionId - Session identity.
   * @returns The current value, or {@link NO_LOOP} when none was published.
   */
  snapshotOf(sessionId: string): LoopProjectionView {
    return this.entries[sessionId]?.snapshot ?? NO_LOOP
  }

  /**
   * Read the revision of one session's published value.
   *
   * It advances only when the value actually changed, so it is the "this really
   * moved" signal the projection registry's change feed needs: a value that
   * changes without its served reference changing is never pushed to a client.
   *
   * @param sessionId - Session identity.
   * @returns The current revision; `0` when nothing was ever published.
   */
  revisionOf(sessionId: string): number {
    return this.entries[sessionId]?.revision ?? 0
  }

  /**
   * Publish one loop view, establishing the reference the change feed compares.
   *
   * Republishing an identical value is a no-op: the snapshot reference stays the
   * same, so the change feed does not fire for a loop that did not change. That
   * matters twice over — the plugin republishes after every queued task,
   * including read-only ones, and the projection fold compares by identity.
   *
   * @param sessionId - Session identity.
   * @param view - The value to serve from now on.
   * @returns Whether the published value actually changed.
   */
  publish(sessionId: string, view: LoopProjectionView): boolean {
    const parsed = loopViewSchema.parse(view)
    const frozen = Object.freeze({ ...parsed })
    const current = this.entries[sessionId]
    if (current !== undefined && sameView(current.snapshot, frozen)) return false
    // Only an effective write advances the revision, so a reader that rebuilds on
    // a new revision rebuilds exactly when the loop moved — never on a no-op
    // republication such as the one that follows `/loop status`.
    this.entries[sessionId] = { snapshot: frozen, revision: (current?.revision ?? 0) + 1 }
    this.onPublish?.(sessionId, frozen)
    return true
  }

  /** Optional observer for tests and diagnostics; never part of the unit contract. */
  onPublish?: (sessionId: string, view: LoopProjectionView) => void

  /**
   * Set one session's published loop from the authoritative facts.
   *
   * @param sessionId - Session identity.
   * @param facts - The live loop, or `undefined` when none is armed.
   * @returns Whether the published value actually changed.
   */
  set(sessionId: string, facts: LoopProjectionFacts | undefined): boolean {
    return this.publish(sessionId, facts === undefined ? NO_LOOP : loopViewOf(facts))
  }

  /**
   * Publish the no-loop value for one session.
   *
   * @param sessionId - Session identity.
   * @returns Whether the published value actually changed.
   */
  publishNoLoop(sessionId: string): boolean {
    return this.set(sessionId, undefined)
  }

  /**
   * Drop one session's mirror entry entirely.
   *
   * Used when the session is disposed: the entry must not outlive it, which is
   * the purge half of the "no zombie projection" guarantee the lifecycle suite
   * also pins for the engine's bookkeeping.
   *
   * @param sessionId - Session identity.
   */
  clear(sessionId: string): void {
    delete this.entries[sessionId]
  }
}

/** The authoritative facts one projection value is derived from. */
export interface LoopProjectionFacts {
  /** Record id of the armed loop. */
  readonly id: string
  /** ISO instant of the next round. */
  readonly nextAt: string
  /** Which engine drives the loop. */
  readonly mode: LoopProjectionMode
  /** Canonical cadence text. */
  readonly cadenceLabel: string
  /** Rounds started so far. */
  readonly round: number
  /** Who armed it. */
  readonly startedBy: LoopStartedBy
}

/**
 * Derive the authoritative facts of one armed loop.
 *
 * This is the one place the served field set is assembled, so the projection,
 * the `loop_status` tool and the human `/loop status` text cannot drift apart:
 * all three read the shipped record and the delivery count through it.
 *
 * @param loop - The decoded loop record.
 * @param delivered - Rounds the scheduler has delivered for it, counted across
 *   history pages; a caller that could only read one page passes that page's
 *   length, which is a lower bound on the same number.
 * @returns The facts the served value is built from.
 */
export function loopFactsOf(loop: LoopRecordLike, delivered: number): LoopProjectionFacts {
  return {
    id: loop.id,
    nextAt: loop.record.scheduledAt,
    mode: loop.state.mode,
    // A self-paced record stores a wall-clock interval too (the currently armed
    // wait), so the label is derived from the mode rather than echoed: a client
    // must never read "1800s" for a loop the model is re-timing each round.
    cadenceLabel: loop.state.mode === 'self' ? 'self-paced' : loop.state.cadenceLabel,
    round: roundsStarted(loop.state.iteration, delivered),
    startedBy: loop.state.startedBy,
  }
}

/**
 * The number of the round one loop is on.
 *
 * This is the *same* quantity the injected round header names. The header of a
 * self-paced round N is rendered from a state whose `iteration` is `N - 1`, so
 * `1 + max(iteration, delivered)` is N both while that round is in flight and
 * after it has been accounted for. That equality is the contract the composer
 * capsule reads: a capsule showing "round N" must agree with the reminder the
 * model is holding, and {@link closedRounds} alone lags exactly one round behind
 * the header it describes.
 *
 * One boundary is worth naming: a fixed-cadence loop advances no durable counter
 * (its cron rule fires on its own), so between a delivery and the turn end that
 * accounts for it the delivery count leads the round the model is running by one.
 * The projection therefore reads one round ahead of that model for that window
 * and settles as soon as the turn closes, which is the honest direction: the
 * round is already in the model's inbox.
 *
 * Every call site passes an *armed* loop, so the smallest honest answer is 1.
 *
 * @param iteration - Rounds the durable counter has advanced through.
 * @param delivered - Rounds the scheduler delivered, counted across pages.
 * @returns The round number, or `0` when the caller passes the no-loop state.
 */
export function roundsStarted(iteration: number, delivered: number): number {
  return 1 + closedRounds(iteration, delivered)
}

/**
 * Rounds one loop has finished or had delivered: the budget it has spent.
 *
 * A self-paced loop advances the durable `iteration` counter whenever the model
 * continues it (`loop_next`) or a person presses the capsule's "next round"
 * button (`/loop next`); a fixed-cadence loop's cron rule fires on its own and
 * never touches that counter, so its delivery count is the larger truth. The
 * larger of the two is the honest measure of how much of the budget is gone,
 * and it is exactly one less than {@link roundsStarted} — the round currently in
 * flight has not been spent yet.
 *
 * @param iteration - Rounds the durable counter has advanced through.
 * @param delivered - Rounds the scheduler delivered, counted across pages.
 * @returns Rounds spent so far.
 */
export function closedRounds(iteration: number, delivered: number): number {
  return Math.max(iteration, delivered)
}

/** The minimum of a loop record this module derives a value from. */
export interface LoopRecordLike {
  /** Full record id. */
  readonly id: string
  /** The durable schedule record. */
  readonly record: { readonly scheduledAt: string }
  /** Decoded loop state. */
  readonly state: {
    readonly mode: LoopProjectionMode
    readonly cadenceLabel: string
    readonly iteration: number
    readonly startedBy: LoopStartedBy
  }
}

/**
 * Derive the served value from the authoritative facts.
 *
 * @param facts - One armed loop as the engine reports it.
 * @returns The frozen client value.
 */
export function loopViewOf(facts: LoopProjectionFacts): LoopProjectionView {
  return loopViewSchema.parse({
    active: true,
    mode: facts.mode,
    cadence: facts.cadenceLabel,
    nextAt: facts.nextAt,
    round: facts.round,
    startedBy: facts.startedBy,
  })
}

/**
 * Compare two served values field by field.
 *
 * @param left - Current value.
 * @param right - Candidate value.
 * @returns Whether every served field matches.
 */
function sameView(left: LoopProjectionView, right: LoopProjectionView): boolean {
  return (
    left.active === right.active &&
    left.mode === right.mode &&
    left.cadence === right.cadence &&
    left.nextAt === right.nextAt &&
    left.round === right.round &&
    left.startedBy === right.startedBy
  )
}

/**
 * The live view of one session's loop.
 *
 * This is the object a projection cell holds as its state, and its reads go
 * through to the mirror on every access. That indirection is not decoration: the
 * registry materializes a cell's state once (`init` at `session/created`, or a
 * lazy build) and thereafter only re-runs a unit's `apply` on a *committed
 * session event*. A mirror written by a command or a timer would therefore be
 * invisible to every read until some unrelated event happened to arrive, which
 * is exactly the staleness this unit exists to avoid. Serving a live object
 * makes `stateOf`, `snapshot` and the persisted-checkpoint view all observe the
 * current value, while the fold still reports "unchanged" (the reference is
 * stable), so the change feed stays quiet unless the loop really moved.
 *
 * `Object.freeze` is applied to the getters themselves, not to a copy: the
 * property values have no writable slots, and freezing is what keeps a consumer
 * from trying to mutate a live projection value.
 *
 * @param sessionId - Session identity.
 * @param store - The mirror.
 * @returns A frozen, live view.
 */
export function liveViewOf(sessionId: string, store: LoopProjectionStore): LoopProjectionView {
  return Object.freeze({
    get active(): boolean {
      return store.snapshotOf(sessionId).active
    },
    get mode(): LoopProjectionMode {
      return store.snapshotOf(sessionId).mode
    },
    get cadence(): string {
      return store.snapshotOf(sessionId).cadence
    },
    get nextAt(): string | null {
      return store.snapshotOf(sessionId).nextAt
    },
    get round(): number {
      return store.snapshotOf(sessionId).round
    },
    get startedBy(): LoopStartedBy {
      return store.snapshotOf(sessionId).startedBy
    },
  })
}

/**
 * Build the `loop` projection unit.
 *
 * Register this **once** for the whole plugin. The registry keeps exactly one
 * registration per key — a second `register()` for the same key only bumps a
 * refcount (`dsh-session-projection/lib/index.js`:
 * `if (existing === void 0) this.registrations.set(key, …) else { …refs… }`) —
 * so a definition cannot be private to a session. Registering one per session
 * (a `sessionId` baked into each closure) collapsed to whichever registered
 * first, and every other session then folded *that* session's mirror: the
 * cross-session leak T17 fixed.
 *
 * The session binding therefore lives in `init(header, …)`, which the registry
 * calls once per cell with that session's own header — the same shape
 * `dsh-goal` uses. A restored session, or any session whose first read happens
 * before its next turn ends, reads its own mirror immediately.
 *
 * `apply` deliberately ignores every event's payload: a loop's truth is not the
 * session log, so the fold only reports the change the mirror actually saw.
 * See {@link LoopProjectionState} for why the state carries three references.
 *
 * @param store - The mirror the loop plugin writes through.
 * @returns A registration-ready definition for `ctx.sessionProjections.register`.
 */
export function loopProjectionDefinitionFor(store: LoopProjectionStore): ProjectionDefinition<'loop'> {
  const key: 'loop' = AUGMENTATION_KEY
  /**
   * The served object per session, rebuilt exactly when the mirror's revision
   * moves.
   *
   * This is the whole point of the revision. The registry publishes a client
   * frame only when the wire view's reference differs from the one it published
   * last (`!Object.is(views[0], views[1])`), so a value that changes behind a
   * stable reference is never pushed and the capsule keeps rendering the stale
   * frame until a page reload. Caching *per revision* gives the wire view the
   * only identity rule that is both live and pushable: a new object the moment
   * the loop moves, the same object while it does not.
   */
  const wireValues = new Map<string, { revision: number; value: LoopProjectionView }>()
  /** The value this fold last reported, per session; absent means "not yet". */
  const reported = new Map<string, LoopProjectionView | undefined>()
  /**
   * The frozen plain value served for one session, right now.
   *
   * A read always reflects the mirror (the cache is keyed by the revision the
   * last effective write established), so `stateOf`/`snapshot` stay current
   * between events while the reference stays stable within one value.
   */
  const wireValueOf = (sessionId: string): LoopProjectionView => {
    const revision = store.revisionOf(sessionId)
    const cached = wireValues.get(sessionId)
    if (cached !== undefined && cached.revision === revision) return cached.value
    const value = Object.freeze({ ...store.snapshotOf(sessionId) })
    wireValues.set(sessionId, { revision, value })
    return value
  }
  /**
   * The session id off the header the registry handed `init`.
   *
   * A header without an id degrades to the empty key, which the mirror answers
   * with `NO_LOOP` — never with another session's value.
   *
   * @param header - The session header.
   * @returns The session id, or `''` when the header carries none.
   */
  const sessionIdOf = (header: unknown): string => {
    const id = (header as { id?: unknown } | null | undefined)?.id
    return typeof id === 'string' ? id : ''
  }
  const stateOf = (sessionId: string, current: LoopProjectionView): LoopProjectionState => ({
    current,
    sessionId,
  })
  const stateNow = (sessionId: string): LoopProjectionState => stateOf(sessionId, store.snapshotOf(sessionId))
  // The published contract types a unit's state as the key's single served value
  // (`SessionProjectionStateMap['loop']`, i.e. `LoopProjectionView`), because that
  // is what a log-folding unit reduces to and persists. This unit keeps the
  // compared reference and the served reference apart on purpose (see
  // `LoopProjectionState`): the registry consumes only `apply`'s return
  // reference, `wire.view(state)`, and a `structuredClone` of the state for the
  // persisted checkpoint, and `{ current, sessionId }` plus the revision-keyed
  // wire value answers all of them correctly. Casting here is therefore a
  // statement about the seam being narrower than this unit's state, not a
  // silenced mistake — `test/register.test.ts` pins each of those behaviours
  // against the real registry.
  const definition = {
    key,
    stateSchema: loopStateSchema,
    // A fresh cell starts with nothing reported, so its first drive always
    // publishes whatever the mirror holds; building a cell for an *empty* log
    // must not consume that guarantee.
    init: (header: unknown) => {
      const sessionId = sessionIdOf(header)
      reported.delete(sessionId)
      return stateNow(sessionId)
    },
    apply: (state: LoopProjectionState) => {
      const { sessionId } = state
      const current = store.snapshotOf(sessionId)
      const last = reported.get(sessionId)
      // Unchanged: hand back the same state reference, which is what tells the
      // registry there is nothing to republish.
      if (last !== undefined && sameView(last, current)) return state
      reported.set(sessionId, current)
      return stateOf(sessionId, current)
    },
    wire: {
      viewSchema: loopViewSchema,
      // The served value is rebuilt exactly when the mirror's revision moves, so
      // a consumer that reads between events still sees the current loop *and*
      // the registry sees a changed reference when — and only when — it did.
      view: (state: LoopProjectionState) => wireValueOf(state.sessionId),
    },
    stateVersion: LOOP_PROJECTION_STATE_VERSION,
  }
  return definition as unknown as ProjectionDefinition<'loop'>
}

/** Compile-time proof that both projection tables expose the key this unit registers. */
type LoopKeyInStateMap = 'loop' extends keyof SessionProjectionStateMap ? true : false
/** Compile-time proof that a client face can read the same key. */
type LoopKeyInWireMap = 'loop' extends keyof SessionProjectionMap ? true : false
export const PROJECTION_KEY_CHECK: { readonly state: LoopKeyInStateMap; readonly wire: LoopKeyInWireMap } = {
  state: true,
  wire: true,
}
