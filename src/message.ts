/**
 * The one model-visible message this plugin injects.
 *
 * Both surfaces that can deliver a round — the `/loop` command and the
 * `loop_start` tool — build that message here, so a round looks and behaves
 * identically whichever one armed it.
 * @module cordis-plugin-loop/message
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Register this plugin's own message source.
 *
 * `dsh-experimental-auto-review` skips messages tagged `kind: 'tool'`, and that
 * tag belongs to tool-role results anyway, so a plugin that injects rounds must
 * declare a kind of its own — mirroring the way `dsh-schedule` declares
 * `'schedule'`.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One round injected by `/loop`. */
    loop: { kind: 'loop' }
  }
}

/**
 * Build the model-visible message for one immediate round.
 *
 * The message goes through the host's own factory rather than a hand-rolled
 * object literal for two reasons the host cares about: `createUserMessage` mints
 * the `id` that the durable inbox dedupes and locates pending messages by (a
 * message without one makes the second injection throw
 * `message "undefined" is already pending`), and the `source` tag is a declared
 * member of `MessageSourceMap`, so it must be a real kind rather than borrowed
 * from another role.
 *
 * @param text - Round text.
 * @returns A frozen user-role message the agent's `followup` accepts.
 */
export function loopMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'loop' },
  })
}
