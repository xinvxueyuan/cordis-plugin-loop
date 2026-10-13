/**
 * The `/loop` command, the two continuation tools, and the omission guard.
 *
 * Every surface funnels through one serial queue, so a `/loop` command can
 * never interleave with a `loop_next` replacement or with the guard rewriting
 * the same record.
 * @module cordis-plugin-loop/registry
 */
import { parseLoopInput } from './grammar.ts'
import { missingTaskMessage, resolveLoopFile } from './loopfile.ts'
import type { LoopConfig } from './config.ts'
import type { EngineResult, LoopAgent, LoopEngine } from './engine.ts'
import type { LoopRecord } from './state.ts'
import type { LoopState } from './types.ts'

/** What one command or tool invocation needs to know about the caller. */
export interface Caller {
  /** Session identity. */
  readonly sessionId: string
  /** Working directory of the session. */
  readonly cwd: string
  /** Whether the session is a delegated child. */
  readonly isSubagent: boolean
  /** Deliver an immediate round to this exact session. */
  readonly send: (text: string) => void
  /**
   * The live agent object the caller was resolved from.
   *
   * Host services that are keyed by agent identity — `planMode.get(agent)`, for
   * one — need this exact object, not a session id: their lookups go through
   * `agent.session`. Absent in unit tests that drive the registry directly.
   */
  readonly agentRef?: unknown
}

/** Dependencies of the command and tool surfaces. */
export interface RegistryDeps {
  /** Effective plugin configuration. */
  readonly config: LoopConfig
  /** The engine that owns live loops. */
  readonly engine: LoopEngine
  /** Environment source for `DSH_HOME` and the kill switch. */
  readonly env: Record<string, string | undefined>
  /** Kill switch state, read once per invocation so a reload is observable. */
  readonly killSwitch: () => boolean
  /**
   * Optional plan-mode probe, evaluated with the calling agent.
   *
   * The host's plan-mode service answers per agent (`get(agent)`), so a
   * zero-argument probe could never read it; a mode that plans must never arm a
   * timer.
   */
  readonly planMode?: (agentRef: unknown) => boolean
  /** Discover this plugin's records across every session, for the kill switch. */
  readonly listAllLoopRecords?: () => Promise<readonly { sessionId: string; record: { id: string; prompt: string } }[]>
}

/** A serial queue: tasks run in submission order, never concurrently. */
export type Enqueue = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Create one serial queue.
 *
 * @returns An `enqueue` function that runs its task after every prior task.
 */
export function createQueue(): Enqueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T,>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/** Human text for a plan-mode refusal. */
export const PLAN_MODE_REFUSAL =
  'Plan mode is active, so /loop will not arm a timer. Leave plan mode and run /loop again.'

/**
 * Handle one `/loop` invocation.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @param rawInput - Exact text following the command name.
 * @param enqueue - Serial queue.
 * @returns The result to render.
 */
export async function runLoopCommand(
  deps: RegistryDeps,
  caller: Caller,
  rawInput: string,
  enqueue: Enqueue,
): Promise<EngineResult> {
  const command = parseLoopInput(rawInput)
  const agent = agentOf(caller)
  if (command.kind === 'status') return enqueue(() => deps.engine.status(agent))
  if (caller.isSubagent) {
    return { ok: false, text: 'A subagent session cannot start or stop a loop.' }
  }
  if (command.kind === 'stop') return enqueue(() => deps.engine.stop(agent, command.selector))
  // The plan-mode refusal sits ahead of every mutating path (the kill switch's
  // cancel included), so a start attempt in plan mode touches no storage at all.
  // Stopping stays available: an existing loop must always be cancellable.
  if (deps.planMode?.(caller.agentRef) === true) return { ok: false, text: PLAN_MODE_REFUSAL }
  if (deps.killSwitch() || !deps.config.enabled) {
    return enqueue(async () => {
      const reason = deps.killSwitch() ? 'the DSH_DISABLE_LOOP kill switch' : 'config.enabled: false'
      const { cancelled, leftAlone } = await cancelEverything(deps, reason)
      // A record whose header does not name the session it is bound to is left
      // alone (owner mismatch), and a delete that fails leaves its row too.
      // Neither is cured by the kill switch, so say so instead of implying the
      // profile is clean.
      const manual =
        leftAlone === 0
          ? ''
          : ` ${leftAlone} record(s) could not be cleared automatically (owner mismatch or a failed delete) and need manual removal with /loop stop; each skipped id was logged.`
      return {
        ok: false,
        text: `No new loop may start because ${reason} is set; ${cancelled} existing loop(s) were cancelled.${manual}`,
      }
    })
  }
  return enqueue(() => startFromCommand(deps, caller, rawInput))
}

async function startFromCommand(deps: RegistryDeps, caller: Caller, rawInput: string): Promise<EngineResult> {
  const command = parseLoopInput(rawInput)
  const agent = agentOf(caller)
  switch (command.kind) {
    case 'naked':
    case 'interval': {
      const file = resolveLoopFile(caller.cwd, deps.config.maxTaskBytes, deps.env)
      if (file.task === undefined) return { ok: false, text: missingTaskMessage(caller.cwd, deps.env) }
      return deps.engine.start(agent, {
        mode: 'fixed',
        requestedSeconds: command.kind === 'interval' ? command.interval.seconds : 600,
        taskFile: file.path,
        truncated: file.truncated,
      })
    }
    case 'task':
      return deps.engine.start(agent, { mode: 'self', task: command.task })
    case 'interval-task':
      return deps.engine.start(agent, {
        mode: 'fixed',
        requestedSeconds: command.interval.seconds,
        task: command.task,
      })
    default:
      return { ok: false, text: 'Unsupported /loop form.' }
  }
}

/**
 * Cancel every loop this plugin owns, discovered through the schedule catalog.
 *
 * A discovered record counts as removed only when the delete reported success;
 * everything left over — an owner mismatch, or a delete that failed — is
 * reported back so the caller can tell the user it needs manual removal.
 *
 * @param deps - Command dependencies.
 * @param reason - Why the cancel happened, for the log lines.
 * @returns How many rows were cancelled and how many were left behind.
 */
async function cancelEverything(
  deps: RegistryDeps,
  reason: string,
): Promise<{ readonly cancelled: number; readonly leftAlone: number }> {
  if (deps.listAllLoopRecords === undefined) return { cancelled: 0, leftAlone: 0 }
  const records = await deps.listAllLoopRecords()
  const cancelled = await deps.engine.cancelRecords(
    records.map((entry) => ({ sessionId: entry.sessionId, record: entry.record as never })),
    reason,
  )
  return { cancelled, leftAlone: Math.max(0, records.length - cancelled) }
}

/**
 * Translate a caller into the engine's agent view.
 *
 * @param caller - Invoking session.
 * @returns The engine-facing agent.
 */
function agentOf(caller: Caller): LoopAgent {
  return {
    sessionId: caller.sessionId,
    cwd: caller.cwd,
    isSubagent: caller.isSubagent,
    send: (message) => caller.send(message.text),
  }
}

/** Outcome of one tool call. */
export interface ToolOutcome {
  /** Whether the call succeeded. */
  readonly ok: boolean
  /** Model-facing text. */
  readonly text: string
}

/**
 * Implement `loop_next`.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @param args - Validated tool arguments.
 * @param enqueue - Serial queue.
 * @returns The outcome to render.
 */
export async function runLoopNext(
  deps: RegistryDeps,
  caller: Caller,
  args: { seconds: number; reason: string; quiet?: boolean },
  enqueue: Enqueue,
): Promise<ToolOutcome> {
  return enqueue(async () => {
    if (caller.isSubagent) {
      return { ok: false, text: 'A subagent session has no loop of its own to continue.' }
    }
    const agent = agentOf(caller)
    const listed = await deps.engine.list(agent)
    if (!listed.ok) return { ok: false, text: listed.text }
    const loops = listed.loops
    if (loops.length === 0) {
      return { ok: false, text: 'There is no loop in this session, so there is nothing to continue.' }
    }
    const loop = loops[0]!
    if (loop.state.mode !== 'self') {
      return {
        ok: false,
        text: `This session's loop runs on a fixed cadence (${loop.state.cadenceLabel}), so its timing cannot be replaced. Use loop_stop to end it.`,
      }
    }
    const seconds = Math.trunc(args.seconds)
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < deps.config.minNextSeconds ||
      seconds > deps.config.maxNextSeconds
    ) {
      return {
        ok: false,
        text: `seconds must be a whole number between ${deps.config.minNextSeconds} and ${deps.config.maxNextSeconds}.`,
      }
    }
    const now = deps.engine.now()
    if (loop.state.expiresAt <= now) {
      await deps.engine.deleteRecord(agent, loop.id)
      return {
        ok: false,
        text: `This loop reached its end of life (${new Date(loop.state.expiresAt).toISOString()}) and has been removed.`,
      }
    }
    const quiet = args.quiet === true
    const next: LoopState = {
      ...loop.state,
      cadenceSeconds: seconds,
      iteration: loop.state.iteration + 1,
      quietStreak: quiet ? loop.state.quietStreak + 1 : 0,
      omissions: 0,
      lastRunAt: now,
    }
    const committed = await deps.engine.rewrite(agent, loop, next, {
      kind: 'every',
      every_seconds: seconds,
    })
    if (committed === undefined) {
      return {
        ok: false,
        text: 'The loop record changed while this call was in flight, so the continuation was not stored. Call loop_next again.',
      }
    }
    const receipts = await deps.engine.receiptsOf(agent, loop.id)
    const newest = receipts[0]
    if (newest !== undefined) deps.engine.markContinued(caller.sessionId, loop.id, newest.scheduledAt, receipts.length)
    return {
      ok: true,
      text: [
        `Next round in ${seconds}s${quiet ? ' (quiet)' : ''}. Reason: ${args.reason}`,
        `Record ${shortOf(loop.id)} was replaced in place — the session still owns exactly one loop record.`,
        `Counters for the next round: iteration ${next.iteration}, quiet streak ${next.quietStreak}, omissions ${next.omissions}.`,
      ].join('\n'),
    }
  })
}

/**
 * Implement `loop_stop`.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @param args - Validated tool arguments.
 * @param enqueue - Serial queue.
 * @returns The outcome to render.
 */
export async function runLoopStop(
  deps: RegistryDeps,
  caller: Caller,
  args: { reason: string },
  enqueue: Enqueue,
): Promise<ToolOutcome> {
  return enqueue(async () => {
    if (caller.isSubagent) {
      return { ok: false, text: 'A subagent session has no loop of its own to stop.' }
    }
    const agent = agentOf(caller)
    const listed = await deps.engine.list(agent)
    if (!listed.ok) return { ok: false, text: listed.text }
    const loops = listed.loops
    if (loops.length === 0) {
      return { ok: false, text: 'There is no loop in this session, so there is nothing to stop.' }
    }
    const stopped: string[] = []
    for (const loop of loops) {
      await deps.engine.deleteRecord(agent, loop.id)
      stopped.push(shortOf(loop.id))
    }
    deps.engine.forgetSession(caller.sessionId)
    return { ok: true, text: `Loop stopped (${stopped.join(', ')}). Reason: ${args.reason}` }
  })
}

/**
 * Decide what a delivery the model did not continue means.
 *
 * @param deps - Registry dependencies.
 * @param caller - Session whose turn is closing.
 * @returns A description of what happened, or `undefined` when nothing was owed.
 */
export async function handleTurnStopping(deps: RegistryDeps, caller: Caller): Promise<string | undefined> {
  const agent = agentOf(caller)
  const listed = await deps.engine.list(agent)
  // The guard is the one caller that must never surface a failure: a turn is
  // closing, so a state read that could not be answered simply owes nothing.
  if (!listed.ok) return undefined
  const loops = listed.loops
  if (loops.length === 0) return undefined
  let report: string | undefined
  for (const loop of loops) {
    const outcome = await inspectLoop(deps, caller, agent, loop)
    if (outcome === undefined) continue
    report = report === undefined ? outcome : `${report}; ${outcome}`
  }
  return report
}

async function inspectLoop(
  deps: RegistryDeps,
  caller: Caller,
  agent: LoopAgent,
  loop: LoopRecord,
): Promise<string | undefined> {
  const now = deps.engine.now()
  if (loop.state.expiresAt <= now) {
    await deps.engine.deleteRecord(agent, loop.id)
    caller.send(
      [
        'The /loop in this session reached its end of life and has been removed.',
        `Last round delivered; nothing is scheduled any more (${shortOf(loop.id)}).`,
        'Start a new loop with /loop when you want to continue.',
      ].join('\n'),
    )
    return `expired ${shortOf(loop.id)}`
  }
  const receipts = await deps.engine.receiptsOf(agent, loop.id)
  const newest = receipts[0]
  if (newest === undefined) return undefined
  const accounted = deps.engine.accounted(caller.sessionId, loop.id)
  if (accounted !== undefined && accounted.scheduledAt === newest.scheduledAt) return undefined
  const alreadyGuarded = deps.engine.isGuarded(caller.sessionId, loop.id)
  deps.engine.markAccounted(caller.sessionId, loop.id, newest.scheduledAt, receipts.length)
  if (alreadyGuarded) {
    await deps.engine.deleteRecord(agent, loop.id)
    caller.send(
      [
        'The /loop in this session was not continued twice in a row, so it has been stopped and removed.',
        `Nothing is scheduled any more (${shortOf(loop.id)}). Start a new loop with /loop when you want to continue.`,
      ].join('\n'),
    )
    return `stopped after a second omission (${shortOf(loop.id)})`
  }
  deps.engine.markGuarded(caller.sessionId, loop.id)
  const next: LoopState = {
    ...loop.state,
    cadenceSeconds: deps.config.omissionCheckSeconds,
    omissions: loop.state.omissions + 1,
    lastRunAt: now,
  }
  const committed = await deps.engine.rewrite(agent, loop, next, {
    kind: 'every',
    every_seconds: deps.config.omissionCheckSeconds,
  })
  if (committed === undefined) return `omission noticed for ${shortOf(loop.id)}, but the guard could not be armed`
  return `armed a ${Math.round(deps.config.omissionCheckSeconds / 60)}-minute omission guard for ${shortOf(loop.id)}`
}

function shortOf(id: string): string {
  return id.replace(/^schedule-/u, '')
}
