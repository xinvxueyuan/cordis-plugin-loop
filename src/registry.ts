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
import { buildPrompt } from './state.ts'
import type { LoopConfig } from './config.ts'
import type { EngineResult, LoopAgent, LoopEngine } from './engine.ts'
import { NO_LOOP, UNAVAILABLE_LOOP, closedRounds, loopFactsOf, loopViewOf } from './loop-projection.ts'
import type { LoopProjectionView } from './loop-projection.ts'
import type { LoopRecord } from './state.ts'
import type { LoopStartedBy, LoopState, DeliveryTally } from './types.ts'

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
  /**
   * Structured log sink.
   *
   * The round cap must explain itself in the log the same way the kill switch's
   * per-record cancel does — "the loop is simply gone" is not an acceptable
   * report for a guard rail that fired. Defaults to a no-op so a bare test rig
   * needs no logger.
   */
  readonly reportEvent?: (event: LoopEvent) => void
}

/**
 * One structured event a guard rail reports.
 *
 * The `kind` is a stable discriminator so a log reader (and a test) can tell
 * *which* safety net fired instead of grepping prose that two of them share.
 * Only the rails that end a loop report: a start and an explicit stop are
 * already visible as the user's own action.
 */
export interface LoopEvent {
  /** Which guard or lifecycle edge produced this event. */
  readonly kind: 'round-limit' | 'expiry' | 'omissions'
  /** Session the event belongs to. */
  readonly sessionId: string
  /** Short id of the record concerned. */
  readonly id: string
  /** One line explaining the event, including the reason a loop ended. */
  readonly detail: string
}

/**
 * A serial queue: tasks run in submission order, never concurrently.
 *
 * The optional second argument is the session the task concerns. The plugin's
 * own queue uses it to refresh that session's projection after the task
 * committed, so every command, tool call and guard pass publishes its result
 * without each call site remembering to. A bare {@link createQueue} queue
 * simply ignores it, which is what keeps the deterministic unit rigs usable.
 */
export type Enqueue = <T>(task: () => Promise<T>, sessionId?: string) => Promise<T>

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
 * One start instruction, normalized away from its surface.
 *
 * This is the *only* shape that can arm a loop. A `/loop` invocation and a
 * `loop_start` call both become one of these and then take the identical path
 * below, so there is exactly one implementation of "check the guards, resolve
 * the cadence, create the record, deliver round one" in this plugin.
 */
export type StartInstruction =
  | {
      /** A wall-clock rule: `/loop 10m …`, or the tool's `cadence: "fixed"`. */
      readonly kind: 'timed'
      /** Cadence as written or as requested; the engine normalizes it. */
      readonly requestedSeconds: number
      /** Inline task text, when the caller supplied one. */
      readonly task?: string
      /** Whether the default-task file supplies the task instead. */
      readonly useTaskFile: boolean
    }
  | {
      /** A loop the model re-times each round with `loop_next`. */
      readonly kind: 'self-paced'
      /** Inline task text. */
      readonly task: string
    }

/** Who asked for the loop, in the vocabulary the durable header stores. */
export type LoopSurface = LoopStartedBy

/**
 * The single entry point that arms a loop.
 *
 * Both the `/loop` command (`runLoopCommand`) and the `loop_start` tool
 * (`runLoopStart`) funnel through here; neither duplicates a guard, a store
 * call, or the first-round delivery. The surface only decides two things that
 * genuinely differ: who is recorded as the origin, and how the instruction was
 * written down.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @param instruction - The normalized start instruction.
 * @param surface - `user` for the command, `agent` for the tool.
 * @param enqueue - Serial queue.
 * @returns The result to render.
 */
export async function startLoop(
  deps: RegistryDeps,
  caller: Caller,
  instruction: StartInstruction,
  surface: LoopSurface,
  enqueue: Enqueue,
): Promise<EngineResult> {
  if (caller.isSubagent) {
    return { ok: false, text: 'A subagent session cannot start or stop a loop.' }
  }
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
    }, caller.sessionId)
  }
  return enqueue(() => armLoop(deps, caller, instruction, surface), caller.sessionId)
}

/**
 * Resolve one instruction's task source and create the loop.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @param instruction - Normalized instruction.
 * @param surface - `user` or `agent`.
 * @returns The engine's confirmation or refusal.
 */
async function armLoop(
  deps: RegistryDeps,
  caller: Caller,
  instruction: StartInstruction,
  surface: LoopSurface,
): Promise<EngineResult> {
  const agent = agentOf(caller)
  if (instruction.kind === 'self-paced') {
    return deps.engine.start(agent, { mode: 'self', startedBy: surface, task: instruction.task })
  }
  if (instruction.task !== undefined) {
    return deps.engine.start(agent, {
      mode: 'fixed',
      startedBy: surface,
      requestedSeconds: instruction.requestedSeconds,
      task: instruction.task,
    })
  }
  if (!instruction.useTaskFile) {
    return { ok: false, text: 'A loop needs a task: pass one inline or create the default loop task file.' }
  }
  const file = resolveLoopFile(caller.cwd, deps.config.maxTaskBytes, deps.env)
  if (file.task === undefined) return { ok: false, text: missingTaskMessage(caller.cwd, deps.env) }
  return deps.engine.start(agent, {
    mode: 'fixed',
    startedBy: surface,
    requestedSeconds: instruction.requestedSeconds,
    taskFile: file.path,
    truncated: file.truncated,
  })
}

/**
 * Read the instruction a `/loop` invocation carries, if it is a start at all.
 *
 * @param rawInput - Exact text following the command name.
 * @returns The instruction, or `undefined` for `status`, `stop`, and refusals.
 */
export function startInstructionOf(rawInput: string): StartInstruction | undefined {
  const command = parseLoopInput(rawInput)
  switch (command.kind) {
    case 'naked':
      return { kind: 'timed', requestedSeconds: 600, useTaskFile: true }
    case 'interval':
      return { kind: 'timed', requestedSeconds: command.interval.seconds, useTaskFile: true }
    case 'task':
      return { kind: 'self-paced', task: command.task }
    case 'interval-task':
      return {
        kind: 'timed',
        requestedSeconds: command.interval.seconds,
        task: command.task,
        useTaskFile: false,
      }
    default:
      // `status`, `next` and `stop` are control forms, never a start.
      return undefined
  }
}

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
  if (command.kind === 'status') return enqueue(() => deps.engine.status(agent), caller.sessionId)
  // Every mutating subcommand sits behind the same refusal, `next` included: a
  // delegated child that forged its parent's session id must not be able to make
  // that session run a round. `status` stays above the guard because reading is
  // harmless and a child may legitimately ask what its parent is doing.
  if (caller.isSubagent) {
    return { ok: false, text: 'A subagent session cannot start or stop a loop.' }
  }
  if (command.kind === 'next') return enqueue(() => runLoopNextRound(deps, caller), caller.sessionId)
  if (command.kind === 'stop') return enqueue(() => deps.engine.stop(agent, command.selector), caller.sessionId)
  const instruction = startInstructionOf(rawInput)
  if (instruction === undefined) return { ok: false, text: 'Unsupported /loop form.' }
  // The origin is `user` on this path by construction: only a person types into
  // the composer. The tool's path differs in exactly this argument.
  return startLoop(deps, caller, instruction, 'user', enqueue)
}

/** How long `/loop next` arms the record for after it delivers the round. */
export const NEXT_ROUND_SECONDS = 60

/**
 * Handle `/loop next`: run the next round now.
 *
 * This is the composer capsule's "立即下一轮" button, and it is deliberately
 * *not* `loop_next`. `loop_next` is a model's continuation of a round it has
 * itself decided about, and it re-times the loop; this is a person saying "do
 * it now", so it may act on any live loop — fixed cadence included — and it
 * does not pretend the model decided anything.
 *
 * What it does to the record depends on the rhythm, because the two rhythms are
 * not interchangeable:
 *
 *  - a **self-paced** loop is already driven by a replaceable fixed-rate
 *    record, so the round is counted durably and the record is re-armed for
 *    {@link NEXT_ROUND_SECONDS};
 *  - a **fixed-cadence** loop is a wall-clock cron rule, and that rule is the
 *    loop. Re-timing it would silently turn a ten-minute cron rule into an
 *    every-60-seconds one while the header, the projection and the confirmation
 *    text all still said "every 10 minutes", so this path changes no timing at
 *    all: it delivers the round and leaves the rule's target untouched. A
 *    person pressing the button moves the *round*, not the clock.
 *
 * Either way the round is counted: it advances the durable `iteration` counter,
 * which {@link startedRounds} makes part of the round budget, so the button
 * cannot be used to bypass the cap.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @returns The result to render.
 */
export async function runLoopNextRound(deps: RegistryDeps, caller: Caller): Promise<EngineResult> {
  if (!deps.engine.available) {
    return { ok: false, text: 'The schedule service is not composed, so there is no loop to advance.' }
  }
  // The kill switch means "no further loop rounds", not just "no new loops": a
  // person who set it expects the session to stop being woken, and advancing an
  // existing loop by hand would do exactly that. The check sits before every
  // read and write, so a refused press changes nothing at all.
  if (deps.killSwitch()) {
    return {
      ok: false,
      text: 'No further round may run while the DSH_DISABLE_LOOP kill switch is set. Clear it and try again.',
    }
  }
  const agent = agentOf(caller)
  const listed = await deps.engine.list(agent)
  if (!listed.ok) return { ok: false, text: listed.text }
  const loop = listed.loops[0]
  if (loop === undefined) {
    return { ok: false, text: 'There is no loop in this session, so there is no next round to run.' }
  }
  const now = deps.engine.now()
  if (loop.state.expiresAt <= now) {
    await deps.engine.deleteRecord(agent, loop.id)
    return {
      ok: false,
      text: `This loop reached its end of life (${new Date(loop.state.expiresAt).toISOString()}) and has been removed.`,
    }
  }
  const fixed = loop.state.mode === 'fixed'
  // The record is written first: if the delivery below throws, nothing has been
  // claimed that did not happen, and the loop keeps its durable budget.
  const next: LoopState = { ...loop.state, iteration: loop.state.iteration + 1, lastRunAt: now }
  const committed = await deps.engine.rewrite(
    agent,
    loop,
    next,
    fixed ? undefined : { kind: 'every', every_seconds: NEXT_ROUND_SECONDS },
  )
  if (committed === undefined) {
    return {
      ok: false,
      text: 'The loop record changed while this call was in flight, so the next round was not armed. Try again.',
    }
  }
  try {
    caller.send(nextRoundPrompt(next, shortOf(loop.id), fixed ? undefined : NEXT_ROUND_SECONDS, deps.config.maxRounds))
  } catch (error) {
    await deps.engine.deleteRecord(agent, loop.id)
    return {
      ok: false,
      text: `The next round could not be delivered, so the loop was stopped and removed: ${messageOf(error)}`,
    }
  }
  const receipts = await deps.engine.receiptsOf(agent, loop.id)
  const newest = receipts[0]
  if (newest !== undefined) {
    deps.engine.markContinued(caller.sessionId, loop.id, newest.scheduledAt, receipts.length)
  }
  const cadence = next.mode === 'self' ? 'self-paced' : next.cadenceLabel
  return {
    ok: true,
    text: [
      fixed
        ? `Next round delivered now (${shortOf(loop.id)}); the wall-clock cadence is untouched, so the rule still fires at its own next occurrence.`
        : `Next round delivered now (${shortOf(loop.id)}); the following round is armed for ${NEXT_ROUND_SECONDS}s from now.`,
      `Round ${next.iteration + 1} of at most ${deps.config.maxRounds} started by: user · cadence ${cadence}.`,
    ].join('\n'),
  }
}

/** Flatten an unknown failure into one line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the text `/loop next` delivers.
 *
 * @param state - State after the round was counted.
 * @param id - Short record id.
 * @param nextSeconds - Wait the record was re-armed for, or `undefined` when the
 *   loop is wall-clock anchored and its rule was deliberately left alone.
 * @returns The model-visible prompt.
 */
function nextRoundPrompt(state: LoopState, id: string, nextSeconds: number | undefined, maxRounds: number): string {
  // The record's own stored prompt already carries the round context, the
  // omission warning and the task, so a re-render cannot drift from what the
  // scheduler would have delivered.
  const { prompt } = buildPrompt(state)
  const cadence = state.mode === 'self' ? 'self-paced' : state.cadenceLabel
  const timing =
    nextSeconds === undefined
      ? `This is the wall-clock loop ${state.cadenceLabel}; its rule was left exactly as it was, so the next scheduled round still fires at that rule's own occurrence (${id}).`
      : `The record was re-armed for ${nextSeconds}s from now (${id}), so a scheduled round would arrive if you then choose to continue.`
  return [
    'The user pressed "next round" in the composer capsule, so this round runs now rather than on its own cadence.',
    `This reminder is not a scheduled delivery; file/report it like the round it says it is — round ${state.iteration + 1}, cadence ${cadence}, round limit ${maxRounds}.`,
    timing,
    '',
    prompt,
  ].join('\n')
}

/**
 * Handle one `loop_start` tool call.
 *
 * A sibling of {@link runLoopCommand}: it resolves the structured tool
 * arguments into the same {@link StartInstruction} and hands them to the same
 * {@link startLoop}, recording `agent` as the origin instead of `user`.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @param request - Validated tool arguments.
 * @param enqueue - Serial queue.
 * @returns The result to render.
 */
export async function runLoopStart(
  deps: RegistryDeps,
  caller: Caller,
  request: StartToolRequest,
  enqueue: Enqueue,
): Promise<EngineResult> {
  const instruction = startInstructionFromTool(request)
  if ('error' in instruction) return { ok: false, text: instruction.error }
  return startLoop(deps, caller, instruction, 'agent', enqueue)
}

/** Validated arguments of one `loop_start` call. */
export interface StartToolRequest {
  /** `fixed` for a wall-clock rhythm, `self` for a model-paced loop. */
  readonly cadence?: 'fixed' | 'self'
  /** Wall-clock interval in seconds; required when `cadence` is `fixed`. */
  readonly seconds?: number
  /** The work each round must do. */
  readonly task: string
}

/**
 * Normalize the tool's structured arguments into a start instruction.
 *
 * The tool cannot reuse the command's text grammar: it takes a literal task, so
 * a task that happens to read like `10m check the build` must stay task text.
 * Every guard the two surfaces share still runs in {@link startLoop}.
 *
 * @param request - Validated tool arguments.
 * @returns The instruction, or a refusal text.
 */
export function startInstructionFromTool(
  request: StartToolRequest,
): StartInstruction | { readonly error: string } {
  const task = request.task.trim()
  if (task.length === 0) return { error: 'loop_start needs a task: describe the work each round must do.' }
  const cadence = request.cadence ?? 'self'
  if (request.seconds !== undefined) {
    if (!Number.isFinite(request.seconds) || request.seconds <= 0) {
      return { error: 'seconds must be a positive number of seconds.' }
    }
    return { kind: 'timed', requestedSeconds: request.seconds, task, useTaskFile: false }
  }
  if (cadence === 'fixed') {
    return {
      error:
        'cadence: "fixed" needs seconds — a wall-clock rhythm must state its interval (for example seconds: 600 for every ten minutes).',
    }
  }
  return { kind: 'self-paced', task }
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
  }, caller.sessionId)
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
  }, caller.sessionId)
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
    deps.reportEvent?.({
      kind: 'expiry',
      sessionId: caller.sessionId,
      id: shortOf(loop.id),
      detail: `reached its end of life at ${new Date(loop.state.expiresAt).toISOString()} and was removed`,
    })
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
  // The round cap is checked before the omission logic *and* before the
  // no-receipt early return on purpose: a loop that spent its budget must stop
  // for that reason, and the budget can be spent without any scheduler receipt
  // — the capsule's "next round" button advances the durable counter while
  // leaving none. Gating the cap on `newest` let a button-only loop sit past
  // `maxRounds` until its first scheduled delivery (T5-F1/V1).
  //
  // The count is walked across pages (one page holds at most 100 receipts while
  // `config.maxRounds` may be far larger) and it counts *started* rounds, which
  // is `max(iteration, delivered)`: a round the user started with the capsule's
  // "next round" button advances the durable counter but leaves no scheduler
  // receipt, and a budget the button could bypass would not be a budget.
  const tally = await deps.engine.countDeliveries(agent, loop.id, deps.config.maxRounds)
  const spent = closedRounds(loop.state.iteration, tally.count)
  const exhausted = roundLimitStop(deps, loop, spent, tally)
  if (exhausted !== undefined) {
    await deps.engine.deleteRecord(agent, loop.id)
    deps.reportEvent?.({
      kind: 'round-limit',
      sessionId: caller.sessionId,
      id: shortOf(loop.id),
      detail: `round limit reached after ${spent} delivered round(s) of ${deps.config.maxRounds}`,
    })
    caller.send(exhausted)
    return `stopped after reaching its round limit of ${deps.config.maxRounds} (${shortOf(loop.id)})`
  }
  // Nothing was delivered for this loop yet, so there is no omission to judge:
  // the cap above is the only guard that applies this early.
  if (newest === undefined) return undefined
  const accounted = deps.engine.accounted(caller.sessionId, loop.id)
  if (accounted !== undefined && accounted.scheduledAt === newest.scheduledAt) return undefined
  const alreadyGuarded = deps.engine.isGuarded(caller.sessionId, loop.id)
  deps.engine.markAccounted(caller.sessionId, loop.id, newest.scheduledAt, receipts.length)
  if (alreadyGuarded) {
    await deps.engine.deleteRecord(agent, loop.id)
    deps.reportEvent?.({
      kind: 'omissions',
      sessionId: caller.sessionId,
      id: shortOf(loop.id),
      detail: 'stopped after a second consecutive omitted continuation',
    })
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

/**
 * Decide whether one loop has spent its round budget.
 *
 * The count is {@link closedRounds} of `(durable iteration, delivered count)`:
 * every round the loop finished, whether the scheduler delivered it or the
 * capsule's button began it. A count that stopped at the pagination ceiling is a
 * lower bound, and the cap is enforced on it anyway (stopping too early is the
 * safe direction for a guard rail) with {@link unprovenTallyNote} appended so
 * the reader is told why.
 *
 * @param deps - Registry dependencies.
 * @param loop - The loop under inspection.
 * @param spent - Rounds spent so far, or a lower bound on them.
 * @param tally - The delivery count the value came from, when one was walked.
 * @returns The notice to send the session, or `undefined` while budget remains.
 */
export function roundLimitStop(
  deps: RegistryDeps,
  loop: LoopRecord,
  spent: number,
  tally?: DeliveryTally,
): string | undefined {
  if (spent < deps.config.maxRounds) return undefined
  return [
    `The /loop in this session reached its round limit of ${deps.config.maxRounds} round(s), so it has been stopped and removed (${shortOf(loop.id)}).`,
    'This cap bounds a loop that wakes a session by itself; it is a separate limit from the 7-day lifetime and from the two-omission stop, and it does not mask either of them.',
    'Nothing is scheduled any more. Raise config.maxRounds or start a new loop with /loop if the work should continue.',
    ...unprovenTallyNote(tally),
  ].join('\n')
}

/**
 * State the honest caveat when a round count could not be fully established.
 *
 * A truncated walk or a pruned history means the number is a floor. The cap is
 * still enforced — a guard rail must fail closed — but the message says which
 * number was actually read instead of implying an exact one.
 *
 * @param tally - The delivery count the decision used, when one was walked.
 * @returns Zero or one line to append.
 */
export function unprovenTallyNote(tally: DeliveryTally | undefined): readonly string[] {
  if (tally === undefined || (!tally.truncated && !tally.pruned)) return []
  const reason = tally.truncated
    ? 'the delivery history was longer than this walk reads'
    : 'the schedule service had already pruned older delivery records'
  return [
    `Note: the count stopped at ${tally.count} because ${reason}, so the real number of rounds may be higher; the cap was applied to the count that could be established.`,
  ]
}

/**
 * Assemble the authoritative status of one session's loop.
 *
 * This is the single reader behind the `loop_status` tool and, through
 * {@link loopFactsOf}, behind the `loop` session projection. The human
 * `/loop status` text is rendered by `LoopEngine.status` from the same decoded
 * record and the same delivery receipts, so all three report one truth about
 * `active`, `mode`, `cadence`, `nextAt` (the record's own `scheduledAt`),
 * `round`, and `startedBy`.
 *
 * @param deps - Registry dependencies.
 * @param caller - Invoking session.
 * @returns The status, plus a note when the value is not authoritative.
 */
export async function loopStatus(
  deps: RegistryDeps,
  caller: Caller,
): Promise<{ readonly available: boolean; readonly loop: LoopProjectionView; readonly note?: string }> {
  if (!deps.engine.available) {
    return {
      available: false,
      loop: LOOP_STATUS_UNAVAILABLE,
      note: 'The schedule service is not composed, so this profile has no loop state.',
    }
  }
  const listed = await deps.engine.list(agentOf(caller))
  if (!listed.ok) {
    // A read failure must not be dressed up as "no loop": an active loop that
    // merely cannot be read is a very different thing to answer with.
    return { available: false, loop: LOOP_STATUS_UNAVAILABLE, note: listed.text }
  }
  const loop = listed.loops[0]
  if (loop === undefined) return { available: true, loop: NO_LOOP }
  // The round number is the one the injected header names, so the count is
  // walked across history pages exactly as the cap check walks it: a one-page
  // count would let `loop_status` disagree with the guard that stopped the loop.
  const tally = await deps.engine.countDeliveries(agentOf(caller), loop.id)
  return { available: true, loop: loopViewOf(loopFactsOf(loop, tally.count)) }
}

/**
 * Render one loop status as text.
 *
 * @param status - The status value.
 * @returns The model-facing text, self-describing and machine-readable.
 */
export function renderLoopStatus(status: {
  readonly available: boolean
  readonly loop: LoopProjectionView
  readonly note?: string
}): string {
  const lines = [
    status.note === undefined ? 'Loop status:' : `Loop status (unavailable: ${status.note}):`,
    `active: ${status.loop.active}`,
    `mode: ${status.loop.mode}`,
    `cadence: ${status.loop.cadence}`,
    `nextAt: ${status.loop.nextAt ?? 'null'}`,
    `round: ${status.loop.round}`,
    `startedBy: ${status.loop.startedBy}`,
    `loop: ${JSON.stringify(status.loop, null, 2)}`,
  ]
  if (!status.loop.active && status.available) {
    lines.push('There is no loop in this session. Start one with the loop_start tool or /loop.')
  }
  return lines.join('\n')
}

/** The value `loop_status` returns when no authoritative read was possible. */
const LOOP_STATUS_UNAVAILABLE: LoopProjectionView = UNAVAILABLE_LOOP

function shortOf(id: string): string {
  return id.replace(/^schedule-/u, '')
}
