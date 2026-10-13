/**
 * The two continuation tools: `loop_next` and `loop_stop`.
 *
 * Both are session-scoped by construction: they resolve the calling agent from
 * the execution context, so a subagent (or any session without a loop) gets a
 * clear refusal instead of touching another session's reminder.
 * @module cordis-plugin-loop/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runLoopNext, runLoopStop, type Caller, type Enqueue, type RegistryDeps } from './registry.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** The minimum of an execution context these tools read. */
interface ToolAgentLike {
  readonly id: string
  readonly session?: { readonly header?: { readonly cwd?: string; readonly origin?: string } }
}

/** Execution context shape handed to a tool body. */
interface ExecLike {
  readonly agent?: ToolAgentLike
}

/**
 * Resolve the calling session from one tool execution.
 *
 * @param exec - Tool execution context.
 * @returns The caller description, or `undefined` when no agent is attached.
 */
export function callerFrom(exec: unknown): Caller | undefined {
  const agent = (exec as ExecLike).agent
  if (agent === undefined || typeof agent.id !== 'string') return undefined
  const header = agent.session?.header
  const cwd = header?.cwd
  return {
    sessionId: agent.id,
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
    isSubagent: header?.origin === 'subagent',
    send: (): void => {
      // A tool call never needs to push an immediate round; the guard and the
      // `/loop` command own every outbound message.
    },
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
