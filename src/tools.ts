/**
 * The four model-facing tools: `loop_start`, `loop_status`, `loop_next` and
 * `loop_stop`.
 *
 * All four are session-scoped by construction: they resolve the calling agent
 * from the execution context, so a subagent (or any session without a loop)
 * gets a clear refusal instead of touching another session's reminder.
 *
 * `loop_start` is deliberately *not* a second implementation of `/loop`: it
 * resolves its structured arguments into the same start instruction and calls
 * the same `startLoop` entry point the command uses, recording `agent` as the
 * origin instead of `user`.
 * @module cordis-plugin-loop/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loopMessage } from './message.ts'
import {
  loopStatus,
  renderLoopStatus,
  runLoopNext,
  runLoopStart,
  runLoopStop,
  type Caller,
  type Enqueue,
  type RegistryDeps,
  type StartToolRequest,
} from './registry.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** The minimum of an execution context these tools read. */
interface ToolAgentLike {
  readonly id: string
  readonly session?: { readonly header?: { readonly cwd?: string; readonly origin?: string } }
  /** Host prototype method that delivers one message as the next turn. */
  readonly followup?: (message: unknown) => void
}

/** Execution context shape handed to a tool body. */
interface ExecLike {
  readonly agent?: ToolAgentLike
}

/**
 * Resolve the calling session from one tool execution.
 *
 * The caller can *deliver* a round, not merely describe one: `loop_start` runs
 * its first round immediately, exactly like the command does, and that delivery
 * goes through the host's own `followup` (bound to its receiver — detaching it
 * makes `this` undefined in strict mode and the delivery throws).
 *
 * @param exec - Tool execution context.
 * @returns The caller description, or `undefined` when no agent is attached.
 */
export function callerFrom(exec: unknown): Caller | undefined {
  const agent = (exec as ExecLike).agent
  if (agent === undefined || typeof agent.id !== 'string') return undefined
  const header = agent.session?.header
  const cwd = header?.cwd
  const followup = typeof agent.followup === 'function' ? agent.followup.bind(agent) : undefined
  return {
    sessionId: agent.id,
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
    isSubagent: header?.origin === 'subagent',
    send: (text: string): void => {
      if (followup === undefined) return
      followup(loopMessage(text))
    },
    agentRef: agent,
  }
}

/**
 * Render one tool outcome as a single text block.
 *
 * @param value - The canonical value produced by `execute`.
 * @returns One model-facing text block.
 */
function renderOutcome(value: { ok?: boolean; text?: string }): string {
  return value.text ?? ''
}

/** A refusal the model and the UI must see as a failed call, not as prose. */
export class LoopToolError extends Error {
  /** Stable name, so a failure log keeps the message readable. */
  override readonly name = 'LoopToolError'
}

/**
 * Turn one engine outcome into the tool's canonical value, failing the call
 * when the engine refused it.
 *
 * @param outcome - The engine's result.
 * @returns The canonical success value.
 * @throws {LoopToolError} when the call was refused.
 */
function unwrap(outcome: { ok: boolean; text: string }): { ok: true; text: string } {
  if (!outcome.ok) throw new LoopToolError(outcome.text)
  return { ok: true, text: outcome.text }
}

/**
 * Build `loop_next`.
 *
 * @param deps - Registry dependencies.
 * @param enqueue - Serial queue.
 * @returns The registry-ready tool definition.
 */
export function defineLoopNextTool(deps: RegistryDeps, enqueue: Enqueue): ToolDefinition {
  return defineTool({
    name: 'loop_next',
    description:
      'Continue the /loop running in this session. Use it at the end of a round to say how long to wait before the next one: seconds is the wait (60-3600), reason is one line explaining the choice, and quiet: true marks a round that needed no attention (it feeds the quiet streak reported back each round). It replaces this same schedule record in place, so the session still has exactly one loop. Only a self-paced loop can be continued this way; a fixed-cadence loop fires on its own and only accepts loop_stop.',
    parameters: {
      seconds: {
        type: 'integer',
        required: true,
        description: 'Seconds to wait before the next round (60-3600).',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'One line explaining why this wait and what the round found.',
      },
      quiet: {
        type: 'boolean',
        description: 'True when this round needed no attention; it increments the quiet streak.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caller = callerFrom(exec)
      if (caller === undefined) {
        throw new LoopToolError('loop_next needs a session context; no agent was attached to this call.')
      }
      return unwrap(await runLoopNext(deps, caller, args, enqueue))
    },
  })
}

/**
 * Describe `loop_start` for the model.
 *
 * The description carries the whole decision: when to reach for it, what each
 * argument means, and what comes back. It is deliberately explicit that this
 * arms a real timer that will wake the session again, because the cost of an
 * unnecessary loop is paid by the user, not by the caller. The `dryRun`
 * parameter's own rules live in that parameter's description; this one only
 * points at it.
 */
const LOOP_START_DESCRIPTION =
  'Start a /loop in this session: run a task now, then keep running it on a cadence, waking this session again for every round. Use it when the user asks to keep watching, polling, retrying, or following something up, or when a long-running objective genuinely needs you to check back on your own — not for work you can finish in this turn, and not as a way to poll something you can await now. The loop is armed for this session only, and it is recorded as agent-started. cadence "fixed" fires on a wall-clock rhythm and needs seconds (a cron rule, rounded to whole minutes); cadence "self" waits a first safety interval and then you re-time every round with loop_next. Set dryRun to see what would be armed without arming it: a real start returns the loop id, the exact first wait, the expiry, and the round limit, while a preview carries no id — reaching that limit stops the loop and says so. Its human counterpart is /loop.'

/**
 * Describe `loop_status` for the model.
 *
 * Read-only by construction, and the field list is stated so the model and the
 * composer capsule provably read the same value.
 */
const LOOP_STATUS_DESCRIPTION =
  'Read the authoritative loop state of this session without changing anything: active, mode (fixed or self), cadence (the human label, e.g. "every 10 minutes" or "self-paced"), nextAt (ISO instant of the next round, or null), round (which round this is — the same number the round_context line of the reminder in your context names, and 0 when no loop is armed), and startedBy (user when a person ran /loop, agent when you ran loop_start). Use it to answer a status question or before deciding whether a loop already exists; with active false there is no loop here. It reads the same value the composer capsule renders, so it never disagrees with /loop status.'

/**
 * Build `loop_start`.
 *
 * @param deps - Registry dependencies.
 * @param enqueue - Serial queue.
 * @returns The registry-ready tool definition.
 */
export function defineLoopStartTool(deps: RegistryDeps, enqueue: Enqueue): ToolDefinition {
  return defineTool({
    name: 'loop_start',
    description: LOOP_START_DESCRIPTION,
    parameters: {
      task: {
        type: 'string',
        required: true,
        description:
          'The work each round must do, as one imperative line. It is stored as literal task text (never parsed as an interval), so a task that begins with something like "10m" stays a task.',
      },
      cadence: {
        type: 'string',
        enum: ['fixed', 'self'],
        description:
          'fixed = a wall-clock rhythm you must also give seconds for; self = the loop waits its first safety interval and you choose each following wait with loop_next. Defaults to self.',
      },
      seconds: {
        type: 'integer',
        description:
          'Wall-clock interval in seconds; required with cadence "fixed" and refused with a cadence hint on a self-paced loop. Example: 600 for every ten minutes.',
      },
      dryRun: {
        type: 'boolean',
        description:
          'True to preview only: describe the loop this call would arm and arm nothing. No schedule record is created and no round is delivered, so it is safe to call when you are unsure whether a loop is warranted, or to check a cadence before committing to it. It is answered even where a start would be refused — plan mode, a subagent session, the DSH_DISABLE_LOOP kill switch, or config.enabled: false — because a read is harmless; those conditions come back as a "Blockers:" line in the text instead of as an error. The text is a preview and says so; it carries no id. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caller = callerFrom(exec)
      if (caller === undefined) {
        throw new LoopToolError('loop_start needs a session context; no agent was attached to this call.')
      }
      const request: StartToolRequest = {
        task: args.task,
        ...(args.cadence === undefined ? {} : { cadence: args.cadence }),
        ...(args.seconds === undefined ? {} : { seconds: args.seconds }),
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
      }
      return unwrap(await runLoopStart(deps, caller, request, enqueue))
    },
  })
}

/**
 * Build `loop_status`.
 *
 * The tool returns the whole status value the projection serves, so a caller
 * that reads `text` and a caller that reads `loop.startedBy` are looking at the
 * same read.
 *
 * @param deps - Registry dependencies.
 * @param enqueue - Serial queue.
 * @returns The registry-ready tool definition.
 */
export function defineLoopStatusTool(deps: RegistryDeps, enqueue: Enqueue): ToolDefinition {
  return defineTool({
    name: 'loop_status',
    description: LOOP_STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          available: { type: 'boolean' },
          active: { type: 'boolean' },
          mode: { type: 'string' },
          cadence: { type: 'string' },
          nextAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          round: { type: 'integer' },
          startedBy: { type: 'string' },
        },
      },
      // The canonical `text` carries the identical field list in one block, so a
      // client that only forwards text loses no information.
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const caller = callerFrom(exec)
      if (caller === undefined) {
        throw new LoopToolError('loop_status needs a session context; no agent was attached to this call.')
      }
      const status = await enqueue(() => loopStatus(deps, caller))
      return {
        text: renderLoopStatus(status),
        available: status.available,
        active: status.loop.active,
        mode: status.loop.mode,
        cadence: status.loop.cadence,
        // Always carried, `null` included: the description promises "or null"
        // and the rendered text always prints it, so omitting the key here made
        // the structured face disagree with both (T5-F2).
        nextAt: status.loop.nextAt,
        round: status.loop.round,
        startedBy: status.loop.startedBy,
      }
    },
  })
}

/**
 * Build `loop_stop`.
 *
 * @param deps - Registry dependencies.
 * @param enqueue - Serial queue.
 * @returns The registry-ready tool definition.
 */
export function defineLoopStopTool(deps: RegistryDeps, enqueue: Enqueue): ToolDefinition {
  return defineTool({
    name: 'loop_stop',
    description:
      'End the /loop running in this session and delete its schedule record. Use it when the task is finished, when it is no longer useful, or when it needs a human decision. reason is one line explaining the ending; it is reported back to the user. Calling it with no loop in this session returns a clear error rather than succeeding silently.',
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'One line explaining why the loop ends.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caller = callerFrom(exec)
      if (caller === undefined) {
        throw new LoopToolError('loop_stop needs a session context; no agent was attached to this call.')
      }
      return unwrap(await runLoopStop(deps, caller, args, enqueue))
    },
  })
}
