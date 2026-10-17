/**
 * Plugin configuration schema and the single place every default lives.
 * @module cordis-plugin-loop/config
 */
import z from '@deepseek-ai/schemastery'

/** Effective plugin configuration; every member is resolved before `apply` runs. */
export interface LoopConfig {
  /** Master switch. `false` refuses new loops and cancels every loop this plugin owns. */
  enabled: boolean
  /** How long one loop lives, in days; the last round runs before the record is deleted. */
  lifetimeDays: number
  /**
   * Hard cap on the rounds one loop may start.
   *
   * It bounds a loop the model armed on its own initiative — and, like every
   * other guard here, it bounds a person's loop too, because "unbounded" is not
   * a useful default for something that wakes a session by itself. Reaching the
   * cap stops the loop with its own reason, distinct from the 7-day lifetime and
   * from the two-omissions stop.
   */
  maxRounds: number
  /** First wait of a self-paced loop, in seconds. */
  safetyCheckSeconds: number
  /** Guard-rail wait armed after the first omitted continuation, in seconds. */
  omissionCheckSeconds: number
  /** Longest accepted `loop_next` wait, in seconds. */
  maxNextSeconds: number
  /** Shortest accepted `loop_next` wait, in seconds. */
  minNextSeconds: number
  /** Longest accepted task text, in bytes; a longer default-task file is truncated. */
  maxTaskBytes: number
}

/** The documented defaults, mirrored by {@link Config}. */
export const DEFAULT_CONFIG: Readonly<LoopConfig> = Object.freeze({
  enabled: true,
  lifetimeDays: 7,
  maxRounds: 24,
  safetyCheckSeconds: 1800,
  omissionCheckSeconds: 1200,
  maxNextSeconds: 3600,
  minNextSeconds: 60,
  maxTaskBytes: 25000,
})

/**
 * Schemastery schema. Every member carries its default, so the loader's
 * validation already produces a complete {@link LoopConfig}.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  lifetimeDays: z.number().step(1).min(1).max(3650).default(DEFAULT_CONFIG.lifetimeDays),
  maxRounds: z.number().step(1).min(1).max(100_000).default(DEFAULT_CONFIG.maxRounds),
  safetyCheckSeconds: z.number().step(1).min(60).max(3600).default(DEFAULT_CONFIG.safetyCheckSeconds),
  omissionCheckSeconds: z.number().step(1).min(60).max(3600).default(DEFAULT_CONFIG.omissionCheckSeconds),
  maxNextSeconds: z.number().step(1).min(60).max(3600).default(DEFAULT_CONFIG.maxNextSeconds),
  minNextSeconds: z.number().step(1).min(60).max(3600).default(DEFAULT_CONFIG.minNextSeconds),
  maxTaskBytes: z.number().step(1).min(1).max(1_000_000).default(DEFAULT_CONFIG.maxTaskBytes),
})

/**
 * Resolve one raw configuration into a complete {@link LoopConfig}.
 *
 * This is the runtime-safe path used by unit tests and by callers that invoke
 * `apply` directly instead of going through a loader: the schema above is
 * authoritative for a composed profile, and this function only fills the
 * documented defaults and rejects an inverted `loop_next` window.
 *
 * @param raw - Untrusted configuration value.
 * @returns The complete configuration.
 * @throws {TypeError} when a supplied member has the wrong shape.
 */
export function resolveConfig(raw: unknown): LoopConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object') throw new TypeError('loop: config must be an object')
  const input = raw as Record<string, unknown>
  const boolean = (key: keyof LoopConfig): boolean => {
    const value = input[key]
    if (value === undefined) return DEFAULT_CONFIG[key] as boolean
    if (typeof value !== 'boolean') throw new TypeError(`loop: config.${key} must be a boolean`)
    return value
  }
  const integer = (key: keyof LoopConfig, min: number, max: number): number => {
    const value = input[key]
    if (value === undefined) return DEFAULT_CONFIG[key] as number
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new TypeError(`loop: config.${key} must be a safe integer`)
    }
    if (value < min || value > max) throw new TypeError(`loop: config.${key} must be between ${min} and ${max}`)
    return value
  }
  const config: LoopConfig = {
    enabled: boolean('enabled'),
    lifetimeDays: integer('lifetimeDays', 1, 3650),
    maxRounds: integer('maxRounds', 1, 100_000),
    safetyCheckSeconds: integer('safetyCheckSeconds', 60, 3600),
    omissionCheckSeconds: integer('omissionCheckSeconds', 60, 3600),
    maxNextSeconds: integer('maxNextSeconds', 60, 3600),
    minNextSeconds: integer('minNextSeconds', 60, 3600),
    maxTaskBytes: integer('maxTaskBytes', 1, 1_000_000),
  }
  if (config.minNextSeconds > config.maxNextSeconds) {
    throw new TypeError('loop: config.minNextSeconds must not exceed config.maxNextSeconds')
  }
  return config
}

/** Spellings accepted as "the kill switch is off". */
const KILL_SWITCH_OFF = new Set(['', '0', 'false', 'off', 'no', 'n', 'disabled'])

/**
 * Read the kill switch from the environment.
 *
 * Anything outside {@link KILL_SWITCH_OFF} counts as ON, because a kill switch
 * whose failure mode is "did not disable" is the wrong default.
 *
 * @param env - Environment source; defaults to `process.env`.
 * @returns Whether `DSH_DISABLE_LOOP` asks for the loop to stay off.
 */
export function killSwitchFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env['DSH_DISABLE_LOOP']
  if (raw === undefined) return false
  return !KILL_SWITCH_OFF.has(raw.trim().toLowerCase())
}
