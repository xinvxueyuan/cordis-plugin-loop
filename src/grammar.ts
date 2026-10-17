/**
 * The `/loop` command grammar.
 *
 * Eight call forms are accepted; the reserved words (`status`, `stop`, `next`)
 * are only reserved when the whole input matches them exactly, so
 * `stop the build` and `next steps for the review` stay task text.
 * @module cordis-plugin-loop/grammar
 */

/** One parsed interval literal, before range validation. */
export interface IntervalLiteral {
  /** The exact text the caller wrote, e.g. `10m` or `1 hour`. */
  readonly text: string
  /** Numeric magnitude as written. */
  readonly amount: number
  /** Unit exactly as written (short or spelled out). */
  readonly unit: string
  /** Converted duration in seconds; fractional values are kept. */
  readonly seconds: number
}

/** The parsed shape of one `/loop` invocation. */
export type LoopCommand =
  | { readonly kind: 'naked' }
  | { readonly kind: 'interval'; readonly interval: IntervalLiteral }
  | { readonly kind: 'task'; readonly task: string }
  | { readonly kind: 'interval-task'; readonly interval: IntervalLiteral; readonly task: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'next' }
  | { readonly kind: 'stop'; readonly selector: 'all' | string | undefined }

/** Seconds per supported unit; spelled-out synonyms map onto the same base. */
const UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
})

/** `12`, `1.5`, `.5` — a magnitude accepted before a unit. */
const AMOUNT = String.raw`\d+(?:\.\d+)?|\.\d+`
/** One interval token: `<amount>` + optional space + a supported unit. */
const INTERVAL_RE = new RegExp(`^(${AMOUNT})\\s*([A-Za-z]+)$`, 'u')
/** The `every <interval>` tail. */
const EVERY_RE = new RegExp(`^(.*?)\\s+every\\s+(${AMOUNT})\\s*([A-Za-z]+)$`, 'u')

/**
 * Parse one interval token.
 *
 * @param text - Candidate interval text, already trimmed.
 * @returns The parsed literal, or `undefined` when the text is not an interval.
 */
export function parseInterval(text: string): IntervalLiteral | undefined {
  const match = INTERVAL_RE.exec(text.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  const scale = UNIT_SECONDS[unit]
  if (scale === undefined || !Number.isFinite(amount)) return undefined
  return Object.freeze({
    text: text.trim(),
    amount,
    unit,
    seconds: amount * scale,
  })
}

/**
 * Parse one `/loop` invocation.
 *
 * @param rawInput - Text following the command name, verbatim.
 * @returns The parsed command shape.
 */
export function parseLoopInput(rawInput: string): LoopCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'naked' }
  const lowered = input.toLowerCase()
  if (lowered === 'status') return { kind: 'status' }
  // `next` is the composer capsule's "run the next round now". Like `stop`, it
  // is only reserved on an exact whole-input match.
  if (lowered === 'next') return { kind: 'next' }
  if (lowered === 'stop') return { kind: 'stop', selector: undefined }
  // `stop` followed by a selector is the stop form. Anything else after `stop`
  // reads as task text, so `/loop stop the world` still starts a loop.
  if (/^stop\s+\S+$/iu.test(input)) {
    const selector = input.slice('stop'.length).trim()
    if (selector.toLowerCase() === 'all') return { kind: 'stop', selector: 'all' }
    if (/^[a-z0-9][a-z0-9:.-]*$/u.test(selector.toLowerCase())) return { kind: 'stop', selector }
  }
  const every = EVERY_RE.exec(input)
  if (every !== null) {
    const task = every[1]!.trim()
    const interval = parseInterval(`${every[2]}${every[3]!}`)
    if (interval !== undefined && task.length > 0) return { kind: 'interval-task', interval, task }
    if (interval !== undefined) return { kind: 'interval', interval }
  }
  const head = input.split(/\s+/u, 1)[0]!
  const interval = parseInterval(head)
  if (interval !== undefined) {
    const rest = input.slice(head.length).trim()
    if (rest.length === 0) return { kind: 'interval', interval }
    return { kind: 'interval-task', interval, task: rest }
  }
  return { kind: 'task', task: input }
}

/**
 * Split an input into whitespace-delimited tokens, for diagnostics only.
 *
 * @param input - Raw input text.
 * @returns Non-empty tokens.
 */
export function tokensOf(input: string): string[] {
  return input.trim().split(/\s+/u).filter((token) => token.length > 0)
}
