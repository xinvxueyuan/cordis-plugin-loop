/**
 * The `/loop` command surface.
 *
 * Building the definition separately from `apply` keeps the handler testable
 * without a Cordis loader and without a real command runtime.
 * @module cordis-plugin-loop/command
 */
import { runLoopCommand, type Caller, type Enqueue, type RegistryDeps } from './registry.ts'

/** Stable identity of this plugin's command definition. */
export const COMMAND_DEFINITION_ID = '@xinvxueyuan/cordis-plugin-loop'

/** The minimal command definition a registry accepts. */
export interface LoopCommandDefinition {
  /** Stable plugin-owned identity. */
  readonly definitionId: string
  /** Command name without its slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Free-form input hint advertised to capable clients. */
  readonly input: { readonly hint: string }
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: {
    readonly agent: unknown
    readonly rawInput: string
  }) => Promise<{ readonly kind: 'success'; readonly text: string } | { readonly kind: 'error'; readonly text: string }>
}

/** Everything the command handler needs to resolve one invoking agent. */
export interface CommandDeps {
  /** Registry dependencies. */
  readonly registry: RegistryDeps
  /** Serial queue shared with the tools and the guard. */
  readonly enqueue: Enqueue
  /** Turn one agent reference into a caller, or `undefined` when unusable. */
  readonly callerFrom: (agent: unknown) => Caller | undefined
}

/**
 * Build the `/loop` command definition.
 *
 * @param deps - Registry dependencies, the queue, and the agent adapter.
 * @returns A registry-ready definition.
 */
export function buildLoopCommand(deps: CommandDeps): LoopCommandDefinition {
  return {
    definitionId: COMMAND_DEFINITION_ID,
    name: 'loop',
    description: 'Run a task now, then keep checking it on a cadence',
    input: { hint: '[<interval>] [<task>] | status | next | stop [<id>|all]' },
    handler: async (invocation) => {
      const caller = deps.callerFrom(invocation.agent)
      if (caller === undefined) {
        return { kind: 'error', text: 'The /loop command needs a session context.' }
      }
      const outcome = await runLoopCommand(deps.registry, caller, invocation.rawInput, deps.enqueue)
      return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
    },
  }
}
