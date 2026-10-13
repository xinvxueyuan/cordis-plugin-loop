/**
 * The default task source: `<cwd>/.dsh/loop.md`, then `$DSH_HOME/loop.md`.
 *
 * The file is never inlined into the loop record. The record carries a
 * *pointer* plus an instruction to read that file on every round, which is what
 * makes a default-task loop re-read its task instead of freezing a copy.
 * @module cordis-plugin-loop/loopfile
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Where one default-task file was looked for and what happened. */
export interface LoopFileProbe {
  /** Absolute path that was probed. */
  readonly path: string
  /** Whether the probe found a usable file. */
  readonly present: boolean
  /** Why the file was ignored, when it was found but unusable. */
  readonly ignored?: 'empty' | 'unreadable' | 'truncated'
  /** Byte length of the raw file, when it was readable. */
  readonly bytes?: number
}

/** Everything the confirmation text and the record prompt need about the source. */
export interface LoopFileResolution {
  /** Absolute path of the file the loop points at, when one was found. */
  readonly path?: string
  /** Exact file text, already truncated to the accepted byte budget. */
  readonly task?: string
  /** Whether the text was cut at the byte budget. */
  readonly truncated: boolean
  /** Every probe, in the order they were attempted. */
  readonly probes: readonly LoopFileProbe[]
}

/** Fixed byte budget documented for the default task file. */
export const LOOP_FILE_BYTE_LIMIT = 25000

/**
 * Resolve the DSH home directory.
 *
 * @param env - Environment source; defaults to `process.env`.
 * @returns The absolute home directory.
 */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env['DSH_HOME']
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(configured.trim())
  }
  return join(homedir(), '.dsh')
}

/**
 * List the default-task file candidates, in priority order.
 *
 * @param cwd - Session working directory.
 * @param env - Environment source; defaults to `process.env`.
 * @returns Absolute candidate paths, highest priority first.
 */
export function loopFilePaths(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  return Object.freeze([
    join(isAbsolute(cwd) ? cwd : resolve(cwd), '.dsh', 'loop.md'),
    join(dshHome(env), 'loop.md'),
  ])
}

/**
 * Cut a UTF-8 string to a byte budget without splitting a code point.
 *
 * @param text - Source text.
 * @param maxBytes - Inclusive byte budget.
 * @returns The clipped text and whether anything was removed.
 */
export function clipToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= maxBytes) return { text, truncated: false }
  let cut = maxBytes
  // Walk back off a UTF-8 continuation byte so the clip lands on a boundary.
  while (cut > 0 && (encoded[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1
  return { text: encoded.subarray(0, cut).toString('utf8'), truncated: true }
}

/**
 * Read the default task from the candidate files.
 *
 * An empty candidate is ignored rather than accepted, and a candidate over the
 * byte budget is accepted with its text truncated so the loop still runs.
 *
 * @param cwd - Session working directory.
 * @param maxBytes - Byte budget for the task text.
 * @param env - Environment source; defaults to `process.env`.
 * @returns The resolution, including the failed probes for diagnostics.
 */
export function resolveLoopFile(
  cwd: string,
  maxBytes: number = LOOP_FILE_BYTE_LIMIT,
  env: Record<string, string | undefined> = process.env,
): LoopFileResolution {
  const probes: LoopFileProbe[] = []
  for (const path of loopFilePaths(cwd, env)) {
    let bytes: number
    try {
      bytes = statSync(path).size
    } catch {
      probes.push({ path, present: false })
      continue
    }
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      probes.push({ path, present: false, ignored: 'unreadable', bytes })
      continue
    }
    if (raw.trim().length === 0) {
      probes.push({ path, present: false, ignored: 'empty', bytes })
      continue
    }
    const clipped = clipToBytes(raw, maxBytes)
    probes.push({ path, present: true, ignored: clipped.truncated ? 'truncated' : undefined, bytes })
    return Object.freeze({ path, task: clipped.text, truncated: clipped.truncated, probes: Object.freeze(probes) })
  }
  return Object.freeze({ truncated: false, probes: Object.freeze(probes) })
}

/**
 * Render the failure that lists every path a caller may populate.
 *
 * @param cwd - Session working directory.
 * @param env - Environment source; defaults to `process.env`.
 * @returns The multi-line error text.
 */
export function missingTaskMessage(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const paths = loopFilePaths(cwd, env)
  return [
    'No task given and no default loop task file was found.',
    `Looked for a non-empty file at:`,
    ...paths.map((path) => `  - ${path}`),
    'Pass a task inline (`/loop <task>`), or create one of those files.',
  ].join('\n')
}
