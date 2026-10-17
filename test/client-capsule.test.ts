/**
 * The browser half's contract, exercised without a browser.
 *
 * `client.js` is a classic script that publishes one factory to
 * `window.__ModuleLoader__.load`, so this suite evaluates the real shipped bytes
 * against the page's own facade shape, then drives the plugin body, the pure
 * helpers, and the capsule component directly. React is a stand-in with the two
 * Hooks the component uses plus a re-render the test can force, which keeps the
 * component's own branching, wiring and copy under test without a DOM.
 *
 * What is exercised here: the registration options the dock seat receives, the
 * projection reading the capsule renders (cadence, countdown, round, originator,
 * hidden while inactive), and both verbs — the exact command line, the exact
 * Remote call shape, and the status text each outcome produces.
 *
 * What is NOT exercised here: real React rendering, the browser, and the live
 * page. Those are covered only by the live gate.
 * @module cordis-plugin-loop/test/client-capsule
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/** Absolute path of the unit under test (this file's parent's parent). */
const CLIENT_PATH = join(import.meta.dirname, '..', 'client.js')
/** The factory id the page's module graph keys this package by. */
const PACKAGE_ID = '@xinvxueyuan/cordis-plugin-loop'

/** A registered factory, as `window.__ModuleLoader__.load` receives it. */
interface Registration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => unknown
}

/** The plugin face a factory returns. */
interface PluginFace {
  readonly inject: readonly string[]
  readonly apply: (ctx: unknown) => void
}

/** Element shape produced by this suite's React stand-in. */
interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

/** One `loop` projection reading, as the host publishes it. */
interface LoopView {
  readonly active: boolean
  readonly mode: string
  readonly cadence: string
  readonly nextAt: string | null
  readonly round: number
  readonly startedBy: string
}

/**
 * Hook-slot ledger shared by every React stand-in in this process.
 *
 * `client.js` reads its `React` binding at call time, so a test that loads the
 * bundle again replaces the object the component will call; keeping the slots
 * here means that replacement cannot lose a state a verb just set.
 */
const HOOK_SLOTS: unknown[] = []

/** The one stand-in handed to every load, so Hook state always agrees. */
let SHARED_REACT: ReactStandIn | undefined

/** The capsule reading the pure helper derives. */
interface CapsuleReading {
  readonly visible: boolean
  readonly cadenceText?: string
  readonly cadenceKind?: string
  readonly countdown?: string
  readonly clock?: string
  readonly roundText?: string
  readonly starterText?: string
}

/** Translate function shape (a dictionary lookup that fills placeholders). */
type Translate = (key: string, vars?: Record<string, string>) => string

/** Children of one element, normalized to an array. */
function childrenOf(element: Element): readonly Element[] {
  const children = element.props.children
  if (children === undefined || children === null || children === false) return []
  return (Array.isArray(children) ? children : [children]).filter(
    (child) => typeof child === 'object' && child !== null,
  ) as Element[]
}

/** Flatten an element's text, depth first. */
function textOf(node: unknown): string {
  if (node === undefined || node === null || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const element = node as Element
  return textOf(element.props?.children)
}

/** Find the first element (depth first) whose props satisfy `match`. */
function findElement(node: unknown, match: (element: Element) => boolean): Element | undefined {
  if (node === undefined || node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, match)
      if (found !== undefined) return found
    }
    return undefined
  }
  const element = node as Element
  if (match(element)) return element
  return findElement(element.props?.children, match)
}

/** React stand-in: element building, two Hooks, and a forced re-render. */
interface ReactStandIn {
  readonly createElement: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => Element
  readonly useState: (initial: unknown) => [unknown, (next: unknown) => void]
  readonly useRef: (initial: unknown) => { current: unknown }
  readonly useEffect: (body: () => (() => void) | undefined, deps: readonly unknown[]) => void
  /** Switch on Hook-call tracking; a production render does not call Hooks outside one. */
  readonly beginRender: () => void
  /** Forget the effects of previous mounts, as unmounting them would. */
  readonly beginMount: () => void
  /** Current value of one hook slot (0 = tick, 1 = pending, 2 = notice). */
  readonly stateAt: (slot: number) => unknown
  /** Effects the component asked to run, with their cleanup result. */
  readonly effects: { readonly deps: readonly unknown[]; readonly cleanup: (() => void) | undefined }[]
  /**
   * Run every pending effect cleanup, as unmounting would.
   *
   * A test that mounts an armed capsule must call this: the capsule's countdown
   * is a real interval, and leaving it running keeps the test process alive.
   */
  readonly unmount: () => void
}

/**
 * Build the React stand-in.
 *
 * One stand-in serves the whole process: `client.js` reads its `React` binding
 * at call time, so a test that loads the bundle again (to read the helpers, or
 * to re-render the component) must not replace the object the previous render's
 * Hook slots and effect cleanups live in.
 *
 * @returns The stand-in.
 */
function createReact(): ReactStandIn {
  if (SHARED_REACT !== undefined) return SHARED_REACT
  const effects: ReactStandIn['effects'] = []
  const cleanups: (() => void)[] = []
  let tracking = false
  let index = 0
  SHARED_REACT = {
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState: (initial) => {
      const slot = index
      if (tracking) index += 1
      HOOK_SLOTS[slot] ??= initial
      return [
        HOOK_SLOTS[slot],
        (next: unknown) => {
          HOOK_SLOTS[slot] = typeof next === 'function' ? (next as (value: unknown) => unknown)(HOOK_SLOTS[slot]) : next
        },
      ]
    },
    useEffect: (body, deps) => {
      if (tracking) index += 1
      if (!tracking) return
      const cleanup = body()
      effects.push({ deps, cleanup })
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    // A ref needs no slot ledger: React hands the same box back for the life of
    // the mount, which is exactly one render sequence in this stand-in.
    useRef: (initial) => ({ current: initial }),
    beginRender: () => {
      // Committing a render first releases the effects the previous commit
      // installed — the rule that stops a re-render from stacking timers.
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      index = 0
      tracking = true
    },
    beginMount: () => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      effects.length = 0
    },
    stateAt: (slot) => HOOK_SLOTS[slot],
    effects,
    unmount: () => {
      // Every effect that ever ran, newest first: re-running an effect does not
      // release the timer its previous run installed in this stand-in.
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    },
  }
  return SHARED_REACT
}

/** A loaded bundle: the registered factory plus the face it resolved to. */
interface LoadedBundle {
  readonly registration: Registration
  readonly plugin: PluginFace
  /** Every specifier the factory asked the module table for. */
  readonly required: readonly string[]
}

/**
 * Evaluate `client.js` as the page would.
 *
 * @param react - The React stand-in the factory receives.
 * @returns The registration and the resolved plugin face.
 */
function loadBundle(react: unknown): LoadedBundle {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const pending: Registration[] = []
  const required: string[] = []
  const key = '__ModuleLoader__'
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = globals[key]
  globals[key] = {
    mode: 'queue',
    pendingQueue: pending,
    load(registration: Registration): void {
      pending.push(registration)
    },
    /** The inline queue script's `create()`, as the modules bundle walks it. */
    create(): unknown {
      return pending[pending.length - 1]
    },
  }
  try {
    // eslint-disable-next-line no-new-func -- the unit is a classic script, not a module
    new Function(source)()
  } finally {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  }
  assert.equal(pending.length, 1, 'the bundle must register exactly one factory')
  const registration = pending[0]!
  assert.equal(registration.id, PACKAGE_ID, 'the factory id must be the package name')
  const plugin = registration.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`unexpected external "${specifier}"`)
  }) as PluginFace
  return { registration, plugin, required }
}

/** The shipped browser bundle's source text. */
function clientSource(): string {
  return readFileSync(CLIENT_PATH, 'utf8')
}

/**
 * The bundle's source with comments removed.
 *
 * Both guards scan code, never prose: a comment that happens to name a service
 * or a token must not be able to demand a declaration.
 *
 * @returns The bundle's code text.
 */
function clientCode(): string {
  return readFileSync(CLIENT_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ')
}

/**
 * Every head of a `ctx.<head>` or `ctx.<head>.<ns>` read in one source text.
 *
 * @param source - The bundle's code text.
 * @returns The head names, de-duplicated.
 */
function readHeads(source: string): Set<string> {
  return new Set([...source.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)/gu)].map((match) => match[1]!))
}

/**
 * Every `ctx.<head>.<ns>` read that is used as a *value*, not called.
 *
 * A Remote namespace is granted per key, so exactly these must appear in
 * `inject` verbatim: `'<head>.<ns>'`, not merely `'<head>'`. A dotted read that
 * is immediately *called* (`ctx.slots.inject(…)`, `ctx.locale.register(…)`) is a
 * method of the head service and is already covered by the head rule, so it is
 * deliberately not part of this set.
 *
 * @param source - The bundle's code text.
 * @returns The dotted keys used as values, de-duplicated.
 */
function readNamespaces(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9]*)\b(?!\s*\()/gu)].map(
      (match) => `${match[1]!}.${match[2]!}`,
    ),
  )
}

/** The namespaced global the bundle publishes its pure helpers on. */
interface HelpersNamespace {
  readonly PACKAGE_ID: string
  readonly NS: string
  readonly PROJECTION_KEY: string
  readonly SLOT: string
  readonly TICK_MS: number
  readonly COMMAND_LINES: { readonly stop: string; readonly next: string }
  readonly zh: Record<string, string>
  readonly en: Record<string, string>
  readonly inject: readonly string[]
  readonly fill: (template: string, vars?: Record<string, string>) => string
  readonly formatWait: (seconds: number) => string
  readonly formatClock: (date: Date) => string
  readonly capsuleStateOf: (
    view: LoopView | undefined | null,
    nowMs: number,
    t: Translate,
  ) => CapsuleReading
  readonly outcomeTextOf: (result: unknown, line: string, t: Translate) => string | undefined
  readonly runLoopVerb: (commands: unknown, verb: string, sessionId: string) => Promise<unknown>
  readonly createLoopStateSource: (deps: Record<string, unknown>) => {
    getSnapshot: () => unknown
    subscribe: (listener: () => void) => () => void
  }
  readonly LoopDock: (props: Record<string, unknown>) => unknown
  readonly apply: (ctx: unknown) => void
}

/** Load the bundle and read the helpers it published. */
function load(): HelpersNamespace {
  loadBundle(createReact())
  const helpers = (globalThis as unknown as { __dshLoopClient?: HelpersNamespace }).__dshLoopClient
  assert.notEqual(helpers, undefined, 'the bundle must publish its helpers namespace')
  return helpers!
}

/** A translate function over one dictionary, mirroring the framework lookup. */
function translator(dict: Record<string, string>): Translate {
  return (key, vars) => {
    const text = dict[key]
    if (text === undefined) return key
    if (vars === undefined) return text
    return text.replace(/\{(\w+)\}/gu, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
    )
  }
}

/** A view of an armed loop, with overrides per case. */
function armed(overrides: Partial<LoopView> = {}): LoopView {
  return {
    active: true,
    mode: 'self',
    cadence: 'self-paced',
    nextAt: '2023-11-14T22:14:20.000Z',
    round: 4,
    startedBy: 'user',
    ...overrides,
  }
}

/** One Remote success carrying a command text. */
function okText(text: string): unknown {
  return { ok: true, value: { result: { kind: 'ok', text } } }
}

/** Let the component's async verb settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('client bundle loading', () => {
  it('registers one factory named by the package, requiring only react', () => {
    const loaded = loadBundle(createReact())
    assert.equal(loaded.registration.id, PACKAGE_ID)
    assert.deepEqual(loaded.required, ['react'], 'the bundle must not reach for another package')
  })

  it('declares exactly the client services it reads', () => {
    const loaded = loadBundle(createReact())
    assert.deepEqual([...loaded.plugin.inject], ['slots', 'sessions', 'locale', 'remote', 'remote.commands'])
  })

  it('declares every service the bundle reaches through `ctx` (T16)', () => {
    const loaded = loadBundle(createReact())
    const declared = new Set<string>(loaded.plugin.inject)
    // A Cordis context proxy throws on an undeclared service, and the throw
    // takes the whole slot entry down: the capsule then never renders. Reading
    // `ctx.remote` without `'remote'` in `inject` is exactly how that shipped, so
    // the declared list is derived-and-checked here rather than trusted.
    const read = [...readHeads(clientCode())].sort()
    // `ctx.effect` is the Context's own lifecycle method, not a service, so it is
    // not injectable; nothing else may escape the check.
    const contextApi = new Set(['effect', 'on'])
    const missing = read.filter((name) => !declared.has(name) && !contextApi.has(name))
    assert.deepEqual(
      missing,
      [],
      `client.js reads ctx.${missing.join(', ctx.')} without declaring it in inject (declared: ${JSON.stringify([...declared])})`,
    )
    assert.deepEqual(
      read.filter((name) => declared.has(name)).sort(),
      ['locale', 'remote', 'sessions', 'slots'],
      `every service the bundle declares must also be read (read: ${JSON.stringify(read)})`,
    )
  })

  it('declares every Remote namespace the bundle reaches through `ctx` (T18)', () => {
    const loaded = loadBundle(createReact())
    const declared = new Set<string>(loaded.plugin.inject)
    // The grant is per key, and a Remote namespace is its own key: `'remote'`
    // alone does not cover `ctx.remote.commands` (the plan capsule declares
    // `"remote"` + `"remote.commands"`, ui-goal `"remote"` + `"remote.goals"`).
    // Missing it is what printed `cannot get property "remote.commands" without
    // inject` in the capsule's body (T18).
    const read = [...readNamespaces(clientCode())].sort()
    assert.deepEqual(read, ['remote.commands'], `the namespaces this bundle reads (read: ${JSON.stringify(read)})`)
    const missing = read.filter((name) => !declared.has(name))
    assert.deepEqual(
      missing,
      [],
      `client.js reads ctx.${missing.join(', ctx.')} without declaring it in inject (declared: ${JSON.stringify([...declared])})`,
    )
  })

  it('is a classic script: no import/export, wrapped, and naming no host Client package', () => {
    const source = readFileSync(CLIENT_PATH, 'utf8')
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/m)
    assert.match(source, /\/\*__loop_client_iife_wrapper__\*\//u)
    assert.doesNotMatch(source, /@deepseek-ai\/dsh-client-/u, 'no host Client package may be named')
  })
})

describe('capsule registration', () => {
  /** Capture what `apply` asks the client context for. */
  function mount(): {
    readonly registrations: { options: Record<string, unknown>; component: unknown }[]
    readonly injections: string[]
    readonly locales: { ns: string; dicts: Record<string, Record<string, string>> }[]
    readonly effects: string[]
  } {
    const loaded = loadBundle(createReact())
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const injections: string[] = []
    const locales: { ns: string; dicts: Record<string, Record<string, string>> }[] = []
    const effects: string[] = []
    const ctx = {
      effect: (body: () => unknown, label: string) => {
        effects.push(label)
        return body()
      },
      locale: {
        register: (ns: string, dicts: Record<string, Record<string, string>>) => {
          locales.push({ ns, dicts })
          return () => {}
        },
      },
      slots: {
        inject: (key: string, callback: () => unknown) => {
          injections.push(key)
          return callback()
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      // The plugin reads the namespace off the context (`ctx.remote.commands`)
      // and the seat's session binding (`ctx.sessions.binding`), so the fake
      // context carries the same shape Cordis provides.
      sessions: {
        binding: () => ({
          session: {
            projections: {
              faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => undefined }),
            },
          },
        }),
      },
      on: () => () => undefined,
      remote: { commands: { execute: async () => ({ ok: true, value: undefined }) } },
    }
    loaded.plugin.apply(ctx)
    return { registrations, injections, locales, effects }
  }

  it('claims the dock seat once, with id, order and the loop namespace', () => {
    const mounted = mount()
    assert.deepEqual(mounted.injections, ['conversation.input.dock'])
    assert.equal(mounted.registrations.length, 1)
    const options = mounted.registrations[0]!.options
    assert.equal(options.name, 'conversation.input.dock')
    assert.equal(options.id, 'loop')
    assert.equal(options.order, 5)
    assert.equal(options.locale, 'loop')
    assert.equal(typeof options.inject, 'function', 'the entry must inject its session seat')
    assert.equal(typeof mounted.registrations[0]!.component, 'function')
  })

  it('builds the goal-shaped face: a hook source plus per-session callbacks', () => {
    const mounted = mount()
    const factory = mounted.registrations[0]!.options.inject as (sessionId: string) => Record<string, unknown>
    const injected = factory('session-1')
    const hooks = injected.hooks as Record<
      string,
      { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void }
    >
    assert.deepEqual(Object.keys(hooks), ['loopState'], 'one hook source, named like the goal activation source')
    assert.equal(typeof hooks.loopState!.getSnapshot, 'function')
    assert.equal(typeof hooks.loopState!.subscribe, 'function')
    assert.equal(typeof injected.onStop, 'function')
    assert.equal(typeof injected.onNext, 'function')
  })

  it('registers both dictionaries through one labelled ctx.effect', () => {
    const mounted = mount()
    assert.deepEqual(mounted.effects, ['ui-loop: dictionaries'])
    assert.equal(mounted.locales.length, 1)
    assert.equal(mounted.locales[0]!.ns, 'loop')
    assert.deepEqual(Object.keys(mounted.locales[0]!.dicts).sort(), ['en', 'zh'])
  })

  it('keeps the two dictionaries key-for-key identical and non-empty', () => {
    const mounted = mount()
    const { zh, en } = mounted.locales[0]!.dicts as { zh: Record<string, string>; en: Record<string, string> }
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    for (const value of Object.values(zh)) assert.notEqual(value.trim(), '')
    for (const value of Object.values(en)) assert.notEqual(value.trim(), '')
  })
})

describe('pure formatting', () => {
  it('fills placeholders and leaves unknown ones alone', () => {
    const { fill } = load()
    assert.equal(fill('Round {round}', { round: '3' }), 'Round 3')
    assert.equal(fill('{a}-{b}', { a: '1', b: '2' }), '1-2')
    assert.equal(fill('Round {round}'), 'Round {round}')
    assert.equal(fill('{missing}', { other: 'x' }), '{missing}')
  })

  it('formats a wait across the second, minute and hour ranges', () => {
    const { formatWait } = load()
    assert.equal(formatWait(0), 'now')
    assert.equal(formatWait(-5), 'now', 'an overdue round reads as due now, not as a negative wait')
    assert.equal(formatWait(45), '45s')
    assert.equal(formatWait(59), '59s')
    assert.equal(formatWait(60), '1m')
    assert.equal(formatWait(750), '12m30s')
    assert.equal(formatWait(3600), '1h')
    assert.equal(formatWait(7500), '2h5m')
    assert.equal(formatWait(Number.NaN), 'now')
  })

  it('formats a clock and survives an invalid instant', () => {
    const { formatClock } = load()
    assert.match(formatClock(new Date(Date.UTC(2023, 10, 14, 22, 14, 20))), /\d{2}:\d{2}:\d{2}/u)
    assert.equal(formatClock(new Date(Number.NaN)), '--')
  })
})

describe('capsule reading', () => {
  const reading = (
    view: LoopView | undefined | null,
    nowMs = Date.parse('2023-11-14T22:14:00.000Z'),
  ): CapsuleReading => {
    const { capsuleStateOf, zh } = load()
    return capsuleStateOf(view, nowMs, translator(zh))
  }

  it('renders nothing without a projection or without an active loop', () => {
    assert.equal(reading(undefined).visible, false)
    assert.equal(reading(null).visible, false)
    assert.equal(reading(armed({ active: false, nextAt: null, round: 0 })).visible, false)
  })

  it('shows cadence, countdown, round and originator', () => {
    const state = reading(armed({ mode: 'fixed', cadence: 'every 10 minutes', round: 7, startedBy: 'user' }))
    assert.equal(state.visible, true)
    assert.equal(state.cadenceText, '固定 · every 10 minutes')
    assert.equal(state.countdown, '下一轮 · 20s后')
    assert.equal(state.roundText, '第 7 轮')
    assert.equal(state.starterText, '你发起')
    assert.match(state.clock ?? '', /\d{2}:\d{2}:\d{2}/u)
  })

  it('speaks the self-paced mode and an agent originator', () => {
    const state = reading(armed({ mode: 'self', startedBy: 'agent' }))
    assert.equal(state.cadenceText, '自定 · 每轮重定')
    assert.equal(state.cadenceKind, '自定节奏')
    assert.equal(state.starterText, '模型发起')
  })

  it('produces the same reading in English', () => {
    const { capsuleStateOf, en } = load()
    const state = capsuleStateOf(
      armed({ mode: 'fixed', cadence: 'every 10 minutes' }),
      Date.parse('2023-11-14T22:14:00.000Z'),
      translator(en),
    )
    assert.equal(state.cadenceText, 'Fixed · every 10 minutes')
    assert.equal(state.countdown, 'Next round · in 20s')
    assert.equal(state.roundText, 'Round 4')
    assert.equal(state.starterText, 'Started by you')
  })

  it('reads a missing instant as "next round" without inventing a countdown', () => {
    const state = reading(armed({ nextAt: null }))
    assert.equal(state.visible, true)
    assert.equal(state.countdown, '下一轮')
    assert.equal(state.clock, '--')
  })
})

describe('button verbs', () => {
  it('sends exactly /loop stop and /loop next for the session', async () => {
    const { runLoopVerb, COMMAND_LINES } = load()
    const calls: unknown[][] = []
    const commands = {
      execute: async (...args: unknown[]) => {
        calls.push(args)
        return okText('Stopped 1 loop(s): 2.')
      },
    }
    await runLoopVerb(commands, 'stop', 'session-1')
    await runLoopVerb(commands, 'next', 'session-7')
    assert.deepEqual(calls, [
      ['session-1', '/loop stop', []],
      ['session-7', '/loop next', []],
    ])
    assert.equal(COMMAND_LINES.stop, '/loop stop')
    assert.equal(COMMAND_LINES.next, '/loop next')
  })

  it('reports an absent carrier instead of throwing', async () => {
    const { runLoopVerb, outcomeTextOf, zh } = load()
    const result = await runLoopVerb(undefined, 'stop', 'session-1')
    assert.equal(result, undefined)
    assert.equal(outcomeTextOf(result, '/loop stop', translator(zh)), '连接不可用，/loop stop 未执行')
  })

  it('shows the command text itself on success', () => {
    const { outcomeTextOf, zh } = load()
    const t = translator(zh)
    assert.equal(outcomeTextOf(okText('Stopped 1 loop(s): 2.'), '/loop stop', t), 'Stopped 1 loop(s): 2.')
    assert.equal(
      outcomeTextOf(
        okText('Next round delivered now (2); the following round is armed for 60s from now.'),
        '/loop next',
        t,
      ),
      'Next round delivered now (2); the following round is armed for 60s from now.',
    )
  })

  it('shows an unregistered admission honestly', () => {
    const { outcomeTextOf, zh } = load()
    assert.equal(outcomeTextOf({ ok: true, value: undefined }, '/loop next', translator(zh)), '命令未注册：/loop next')
  })

  it('shows a carrier failure as message plus code', () => {
    const { outcomeTextOf, zh } = load()
    assert.equal(
      outcomeTextOf(
        { ok: false, error: { code: 'not-found', message: 'no such session' } },
        '/loop stop',
        translator(zh),
      ),
      'no such session (not-found)',
    )
    assert.equal(
      outcomeTextOf({ ok: false, error: {} }, '/loop stop', translator(zh)),
      '连接不可用，/loop stop 未执行',
    )
  })

  it('reports no text when the command answered without one', () => {
    const { outcomeTextOf, zh } = load()
    assert.equal(outcomeTextOf({ ok: true, value: { result: { kind: 'ok' } } }, '/loop stop', translator(zh)), undefined)
  })
})

describe('capsule component', () => {
  /**
   * Render the capsule with a controllable React stand-in.
   *
   * @param view - The projection value the framework hook resolves.
   * @param execute - The Remote `commands.execute` stand-in.
   * @returns The rendered element, the stand-in, and a render function.
   */
  function render(
    view: LoopView | undefined,
    execute: (...args: unknown[]) => Promise<unknown>,
  ): {
    readonly element: Element
    readonly react: ReactStandIn
    readonly rendered: string[]
    readonly again: (nextView?: LoopView | undefined) => Element
    readonly unmount: () => void
  } {
    const react = createReact()
    loadBundle(react)
    const helpers = (globalThis as unknown as { __dshLoopClient?: HelpersNamespace }).__dshLoopClient!
    const rendered: string[] = []
    const commands = { execute }
    let current: LoopView | undefined = view
    // The same bundle instance re-renders against the same Hook slots, so a
    // state change made by a verb is observable by rendering again. A new loop
    // value is what the host's frame push hands over (t24: every revision is a
    // fresh reference), so `again(next)` models exactly that arrival. The
    // callbacks mirror the seat's inject face: they run the shipped
    // `runLoopVerb`, which is the real call shape the buttons reach.
    const props = {
      useProjection: (key: string) => {
        rendered.push(key)
        return current
      },
      useLoopState: (selector: (snapshot: { view: LoopView | undefined; nowMs: number }) => unknown) =>
        selector({ view: current, nowMs: Date.now() }),
      onStop: async () => await helpers.runLoopVerb(commands, 'stop', 'session-1'),
      onNext: async () => await helpers.runLoopVerb(commands, 'next', 'session-1'),
      t: translator(helpers.zh),
    }
    // A fresh mount: clear the ledger so no earlier test's state leaks in.
    HOOK_SLOTS.length = 0
    react.beginMount()
    react.beginRender()
    return {
      element: helpers.LoopDock(props) as Element,
      react,
      rendered,
      again: (nextView) => {
        if (nextView !== undefined) current = nextView
        react.beginRender()
        return helpers.LoopDock(props) as Element
      },
      unmount: react.unmount,
    }
  }
  it('renders nothing when the projection is absent or inactive', () => {
    assert.equal(render(undefined, async () => okText('x')).element, null)
    const idle = render(armed({ active: false }), async () => okText('x'))
    assert.equal(idle.element, null)
    idle.unmount()
  })

  it('hides when the framework projects no loop key at all', () => {
    const react = createReact()
    loadBundle(react)
    const helpers = (globalThis as unknown as { __dshLoopClient?: HelpersNamespace }).__dshLoopClient!
    HOOK_SLOTS.length = 0
    react.beginRender()
    assert.equal(
      helpers.LoopDock({
        t: (key: string) => key,
        onStop: undefined,
        onNext: undefined,
        useProjection: () => undefined,
        useLoopState: () => undefined,
      }),
      null,
      'a composition without the host unit must show no capsule',
    )
  })

  it('reads the loop projection and lays out every reading', () => {
    const active = armed({ mode: 'fixed', cadence: 'every 10 minutes', round: 7, startedBy: 'agent' })
    const { element, rendered, unmount } = render(active, async () => okText('x'))
    assert.deepEqual(rendered, ['loop'])
    const text = textOf(element)
    assert.match(text, /固定/u)
    assert.match(text, /every 10 minutes/u)
    assert.match(text, /下一轮/u)
    assert.match(text, /第 7 轮/u)
    assert.match(text, /模型发起/u)
    assert.match(text, /停止/u)
    assert.match(text, /立即下一轮/u)
    assert.equal(element.props['data-dsh-loop-state'], 'reading')
    unmount()
  })

  it('stops through the real call shape and hides only when the loop value turns inactive', async () => {
    const calls: unknown[][] = []
    const { element, react, again, unmount } = render(armed(), async (...args: unknown[]) => {
      calls.push(args)
      return okText('Stopped 1 loop(s): 2.')
    })
    const stop = findElement(element, (candidate) => candidate.props['data-dsh-loop-action'] === 'stop')
    assert.notEqual(stop, undefined, 'the capsule must offer a stop control')
    ;(stop!.props.onClick as () => void)()
    assert.equal(react.stateAt(0), 'stop', 'the verb must mark itself pending while in flight')
    await settle()
    assert.deepEqual(calls, [['session-1', '/loop stop', []]])
    assert.equal(react.stateAt(0), '', 'pending must clear when the call settles')
    // No retirement marker: the receipt is shown, and the capsule disappears when
    // the host's frame pushes the inactive value (t24 makes that a new reference).
    const withReceipt = again()
    assert.notEqual(withReceipt, null, 'the capsule still shows the receipt')
    assert.equal(withReceipt.props['data-dsh-loop-state'], 'notice')
    assert.match(textOf(withReceipt), /Stopped 1 loop\(s\): 2\./u)
    assert.equal(again(armed({ active: false, nextAt: null, round: 2 })), null, 'the inactive value hides it')
    unmount()
  })
  it('returns to the readings on the next loop value, keeping the new round', async () => {
    const calls: unknown[][] = []
    const { element, react, again, unmount } = render(armed({ round: 2 }), async (...args: unknown[]) => {
      calls.push(args)
      return okText('Next round delivered now (2); the following round is armed for 60s from now.\nRound 3 of at most 24 started by: user · cadence self-paced.')
    })
    const next = findElement(element, (candidate) => candidate.props['data-dsh-loop-action'] === 'next')
    assert.notEqual(next, undefined, 'the capsule must offer a next-round control')
    ;(next!.props.onClick as () => void)()
    await settle()
    assert.deepEqual(calls, [['session-1', '/loop next', []]])
    const withReceipt = again()
    assert.equal(withReceipt.props['data-dsh-loop-state'], 'notice')
    assert.match(textOf(withReceipt), /Round 3 of at most 24/u)
    // The next frame carries the new round: a fresh reference, so the readings
    // come back without polling and show the advanced counter.
    const advanced = again(armed({ round: 3 }))
    assert.equal(advanced.props['data-dsh-loop-state'], 'reading')
    assert.match(textOf(advanced), /第 3 轮/u)
    unmount()
  })

  it('drops a receipt whose frame already arrived, on a short window', async () => {
    const timers: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    ;(globalThis as { setTimeout: unknown }).setTimeout = (callback: () => void) => {
      timers.push(callback)
      return 0
    }
    try {
      const { element, react, again, unmount } = render(armed(), async () =>
        okText('Next round delivered now (1); the following round is armed for 60s from now.'),
      )
      const next = findElement(element, (candidate) => candidate.props['data-dsh-loop-action'] === 'next')
      ;(next!.props.onClick as () => void)()
      await settle()
      assert.equal(again().props['data-dsh-loop-state'], 'notice', 'the receipt is up')
      assert.equal(timers.length >= 1, true, 'a one-shot timer is armed for the receipt')
      for (const fire of timers) fire()
      assert.equal(react.stateAt(1), undefined, 'the timer clears the notice')
      // Same loop value, no new frame: the readings are back.
      assert.equal(again().props['data-dsh-loop-state'], 'reading')
      unmount()
    } finally {
      ;(globalThis as { setTimeout: unknown }).setTimeout = originalSetTimeout
    }
  })

  it('shows a failing verb message as-is', async () => {
    const calls: unknown[][] = []
    const { element, react, again, unmount } = render(armed({ startedBy: 'agent' }), async (...args: unknown[]) => {
      calls.push(args)
      return { ok: false, error: { code: 'internal', message: 'No active loop to stop.' } }
    })
    const next = findElement(element, (candidate) => candidate.props['data-dsh-loop-action'] === 'next')
    assert.notEqual(next, undefined, 'the capsule must offer a next-round control')
    ;(next!.props.onClick as () => void)()
    await settle()
    assert.deepEqual(calls, [['session-1', '/loop next', []]])
    assert.equal((react.stateAt(1) as { text: string }).text, 'No active loop to stop. (internal)')
    assert.match(textOf(again()), /No active loop to stop\./u)
    unmount()
  })

  it('swallows a rejecting carrier into a visible status', async () => {
    const { element, react, unmount } = render(armed(), async () => {
      throw new Error('carrier down')
    })
    const stop = findElement(element, (candidate) => candidate.props['data-dsh-loop-action'] === 'stop')!
    ;(stop.props.onClick as () => void)()
    await settle()
    assert.equal((react.stateAt(1) as { text: string }).text, 'carrier down')
    assert.equal(react.stateAt(0), '')
    unmount()
  })

  it('ignores a second press while one verb is in flight', async () => {
    let resolveCall: (value: unknown) => void = () => {}
    const calls: unknown[][] = []
    const { element, react, unmount } = render(armed(), async (...args: unknown[]) => {
      calls.push(args)
      return await new Promise((resolve) => {
        resolveCall = resolve
      })
    })
    const stop = findElement(element, (candidate) => candidate.props['data-dsh-loop-action'] === 'stop')!
    ;(stop.props.onClick as () => void)()
    ;(stop.props.onClick as () => void)()
    assert.equal(react.stateAt(0), 'stop')
    resolveCall(okText('Stopped 1 loop(s): 2.'))
    await settle()
    assert.equal(calls.length, 1, 'a press while pending must not re-issue the command')
    unmount()
  })

  it('hosts the clock in the hook source, not in the component (goal shape)', () => {
    // The component is a pure reading of `useLoopState` + the callbacks; the
    // ticking lives in the source the seat builds, which is exercised below. The
    // component's only timers are the short one-shot notice windows.
    const idleRender = render(armed({ active: false }), async () => okText('x'))
    assert.equal(idleRender.element, null, 'an inactive loop renders nothing')
    idleRender.unmount()
    const armedRender = render(armed(), async () => okText('x'))
    assert.notEqual(armedRender.element, null)
    armedRender.unmount()
  })
})

describe('loop state source', () => {
  /** Build the surface a seat's inject factory hands the slot. */
  function mountSource(view: LoopView | undefined): {
    readonly source: {
      getSnapshot: () => { view: LoopView | undefined; nowMs: number }
      subscribe: (listener: () => void) => () => void
    }
    readonly projectionListeners: Set<() => void>
    readonly resetListeners: Set<() => void>
    setView: (next: LoopView | undefined) => void
  } {
    loadBundle(createReact())
    const helpers = (globalThis as unknown as { __dshLoopClient?: HelpersNamespace }).__dshLoopClient!
    const projectionListeners = new Set<() => void>()
    const resetListeners = new Set<() => void>()
    let current = view
    const source = helpers.createLoopStateSource({
      projection: {
        getSnapshot: () => current,        subscribe: (listener: () => void) => {
          projectionListeners.add(listener)
          return () => {
            projectionListeners.delete(listener)
          }
        },
      },
      subscribeReset: (listener: () => void) => {
        resetListeners.add(listener)
        return () => {
          resetListeners.delete(listener)
        }
      },
    })
    return {
      // The bundle is plain JavaScript, so its published face is `unknown`-typed
      // here; the suite narrows it to the shape the seat actually hands the slot.
      source: source as unknown as {
        getSnapshot: () => { view: LoopView | undefined; nowMs: number }
        subscribe: (listener: () => void) => () => void
      },
      projectionListeners,
      resetListeners,
      setView: (next) => {
        current = next
      },
    }
  }

  it('publishes the projection face and re-publishes on a projection change', () => {
    const mounted = mountSource(armed({ round: 3 }))
    assert.equal(mounted.source.getSnapshot().view, undefined, 'nothing is read before a subscriber arrives')
    const seen: number[] = []
    const off = mounted.source.subscribe(() => seen.push(mounted.source.getSnapshot().view!.round))
    assert.equal(mounted.source.getSnapshot().view?.round, 3, 'attaching publishes the current value')
    mounted.setView(armed({ round: 4 }))
    for (const listener of [...mounted.projectionListeners]) listener()
    assert.equal(mounted.source.getSnapshot().view?.round, 4)
    assert.deepEqual(seen, [3, 4])
    off()
    assert.equal(mounted.projectionListeners.size, 0, 'unsubscribing releases the projection face')
    assert.equal(mounted.resetListeners.size, 0, 'and the connection reset listener with it')
  })

  it('advances the clock while armed and stops it when the loop ends', async () => {
    const mounted = mountSource(armed())
    let notifications = 0
    const off = mounted.source.subscribe(() => {
      notifications += 1
    })
    assert.equal(notifications, 1, 'attaching publishes once')
    await new Promise((resolve) => setTimeout(resolve, 1150))
    assert.ok(notifications >= 2, `the armed clock must tick; notifications=${notifications}`)
    mounted.setView(armed({ active: false }))
    for (const listener of [...mounted.projectionListeners]) listener()
    const afterStop = notifications
    await new Promise((resolve) => setTimeout(resolve, 1150))
    assert.equal(notifications, afterStop, 'an inactive loop must not keep ticking')
    off()
  })

  it('re-reads on a connection reset instead of serving a stale reading', () => {
    const mounted = mountSource(armed({ round: 1 }))
    const off = mounted.source.subscribe(() => undefined)
    mounted.setView(armed({ round: 7 }))
    for (const listener of [...mounted.resetListeners]) listener()
    assert.equal(mounted.source.getSnapshot().view?.round, 7)
    off()
  })
})

/* ------------------------------------------------------------------------- *
 * Theme-token guard (T5-F1)
 *
 * The capsule's styles must name tokens the Web shell really defines. A
 * hardcoded fallback hides a wrong name: the property silently freezes at the
 * fallback and stops following the theme. Before this guard existed, renaming a
 * token to nonsense kept the suite green.
 *
 * `THEME_TOKENS` is a frozen snapshot of the `--dsw-*` set the theme package
 * injects on `:root`, extracted from
 * `@deepseek-ai/dsh-client-ui-theme@0.2.0-rc.2`, `lib/client.js`
 * (sha256 B1C1D19438C15717DEC571032A3C911EED4038D4DAB8B4975CA797B7B7AFD6AB) with
 * `--dsw-[a-zA-Z0-9-]+` over the whole file, sorted and de-duplicated: 403
 * names. The theme ships inside the Harness installation and is not a
 * dependency of this package, so the snapshot is what lets the check run
 * off-line; when `DSH_THEME_CLIENT` points at that file, another test
 * re-extracts the set and requires it to equal this snapshot, so the frozen
 * copy can be re-verified instead of merely trusted.
 *
 * `LAYOUT_TOKEN_ALLOWLIST` is the escape hatch for a token that another client
 * package defines for layout (the `--dsh-*` family: `--dsh-content-font-size`,
 * `--dsh-scrollbar-*`, …). It is deliberately empty today: every token this
 * plugin uses is a theme token. An entry must name the defining package and why
 * the theme has no equivalent.
 * ------------------------------------------------------------------------- */
const THEME_TOKENS: readonly string[] = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-document-preview', '--dsw-alias-bg-document-selection', '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2',
  '--dsw-alias-bg-mask-3', '--dsw-alias-bg-mask-drop', '--dsw-alias-bg-mask-photo', '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select', '--dsw-alias-bg-overlay', '--dsw-alias-bg-skeleton', '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3', '--dsw-alias-border-l4', '--dsw-alias-brand-primary', '--dsw-alias-brand-primary-invert',
  '--dsw-alias-brand-primary-new-colorprimary-new-color', '--dsw-alias-brand-text', '--dsw-alias-button-contrast-fill', '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill', '--dsw-alias-button-floating-hover', '--dsw-alias-button-ghost-active-border', '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover', '--dsw-alias-button-info-fill', '--dsw-alias-button-info-hover', '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover', '--dsw-alias-button-tool-bar-fill', '--dsw-alias-button-tool-bar-fill-invisible',
  '--dsw-alias-button-tool-bar-hover', '--dsw-alias-code-diff-added', '--dsw-alias-code-diff-deleted', '--dsw-alias-file-diff-added-bg',
  '--dsw-alias-file-diff-added-gutter', '--dsw-alias-file-diff-added-marker', '--dsw-alias-file-diff-deleted-bg', '--dsw-alias-file-diff-deleted-gutter',
  '--dsw-alias-file-diff-deleted-marker', '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-interactive-bg-hover-solid', '--dsw-alias-label-caption', '--dsw-alias-label-deep-diving',
  '--dsw-alias-label-deep-diving-shimmer', '--dsw-alias-label-dimmed', '--dsw-alias-label-document-preview', '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish', '--dsw-alias-label-primary-dimmed', '--dsw-alias-label-primary-foreground', '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary', '--dsw-alias-label-shimmer', '--dsw-alias-label-tertiary', '--dsw-alias-link',
  '--dsw-alias-markdown-citation', '--dsw-alias-markdown-code-block', '--dsw-alias-markdown-code-block-banner', '--dsw-alias-markdown-code-segment-selected',
  '--dsw-alias-markdown-code-segment-unselected', '--dsw-alias-markdown-inline-code', '--dsw-alias-markdown-placeholder', '--dsw-alias-markdown-tag',
  '--dsw-alias-menu-group-header-fill', '--dsw-alias-menu-icon', '--dsw-alias-onboarding-accent', '--dsw-alias-onboarding-card-fill',
  '--dsw-alias-onboarding-checkbox-border', '--dsw-alias-onboarding-secondary-fill', '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1', '--dsw-alias-scrollbar-hover-l2', '--dsw-alias-settings-card-fill', '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary', '--dsw-alias-state-error-primary', '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-idle-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-success-secondary', '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label', '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-secondary', '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-switch-thumb', '--dsw-alias-toast-bg', '--dsw-alias-toast-label', '--dsw-alias-tooltip-bg',
  '--dsw-alias-tooltip-key-bg', '--dsw-alias-turn-trigger-bg', '--dsw-alias-turn-trigger-bg-hover', '--dsw-corner-shape',
  '--dsw-elevation-panel', '--dsw-elevation-prominent', '--dsw-elevation-soft', '--dsw-elevation-stroke',
  '--dsw-elevation-stroke-color', '--dsw-focus-ring-color', '--dsw-focus-ring-width', '--dsw-font-base-16',
  '--dsw-font-base-16-font-family', '--dsw-font-base-16-font-size', '--dsw-font-base-16-font-style', '--dsw-font-base-16-font-weight',
  '--dsw-font-base-16-line-height', '--dsw-font-base-strong-16', '--dsw-font-base-strong-16-font-family', '--dsw-font-base-strong-16-font-size',
  '--dsw-font-base-strong-16-font-style', '--dsw-font-base-strong-16-font-weight', '--dsw-font-base-strong-16-line-height', '--dsw-font-family',
  '--dsw-font-family-brand', '--dsw-font-l-20', '--dsw-font-l-20-font-family', '--dsw-font-l-20-font-size',
  '--dsw-font-l-20-font-style', '--dsw-font-l-20-font-weight', '--dsw-font-l-20-line-height', '--dsw-font-m-18',
  '--dsw-font-m-18-font-family', '--dsw-font-m-18-font-size', '--dsw-font-m-18-font-style', '--dsw-font-m-18-font-weight',
  '--dsw-font-m-18-line-height', '--dsw-font-markdown-base', '--dsw-font-markdown-base-font-family', '--dsw-font-markdown-base-font-size',
  '--dsw-font-markdown-base-font-style', '--dsw-font-markdown-base-font-weight', '--dsw-font-markdown-base-italic', '--dsw-font-markdown-base-italic-font-family',
  '--dsw-font-markdown-base-italic-font-size', '--dsw-font-markdown-base-italic-font-style', '--dsw-font-markdown-base-italic-font-weight', '--dsw-font-markdown-base-italic-line-height',
  '--dsw-font-markdown-base-line-height', '--dsw-font-markdown-base-strong', '--dsw-font-markdown-base-strong-font-family', '--dsw-font-markdown-base-strong-font-size',
  '--dsw-font-markdown-base-strong-font-style', '--dsw-font-markdown-base-strong-font-weight', '--dsw-font-markdown-base-strong-italic', '--dsw-font-markdown-base-strong-italic-font-family',
  '--dsw-font-markdown-base-strong-italic-font-size', '--dsw-font-markdown-base-strong-italic-font-style', '--dsw-font-markdown-base-strong-italic-font-weight', '--dsw-font-markdown-base-strong-italic-line-height',
  '--dsw-font-markdown-base-strong-line-height', '--dsw-font-markdown-code', '--dsw-font-markdown-code-block', '--dsw-font-markdown-code-block-font-family',
  '--dsw-font-markdown-code-block-font-size', '--dsw-font-markdown-code-block-font-style', '--dsw-font-markdown-code-block-font-weight', '--dsw-font-markdown-code-block-line-height',
  '--dsw-font-markdown-code-block-small', '--dsw-font-markdown-code-block-small-font-family', '--dsw-font-markdown-code-block-small-font-size', '--dsw-font-markdown-code-block-small-font-style',
  '--dsw-font-markdown-code-block-small-font-weight', '--dsw-font-markdown-code-block-small-line-height', '--dsw-font-markdown-code-font-family', '--dsw-font-markdown-code-font-size',
  '--dsw-font-markdown-code-font-style', '--dsw-font-markdown-code-font-weight', '--dsw-font-markdown-code-line-height', '--dsw-font-markdown-h1',
  '--dsw-font-markdown-h1-font-family', '--dsw-font-markdown-h1-font-size', '--dsw-font-markdown-h1-font-style', '--dsw-font-markdown-h1-font-weight',
  '--dsw-font-markdown-h1-line-height', '--dsw-font-markdown-h2', '--dsw-font-markdown-h2-font-family', '--dsw-font-markdown-h2-font-size',
  '--dsw-font-markdown-h2-font-style', '--dsw-font-markdown-h2-font-weight', '--dsw-font-markdown-h2-line-height', '--dsw-font-markdown-h3',
  '--dsw-font-markdown-h3-font-family', '--dsw-font-markdown-h3-font-size', '--dsw-font-markdown-h3-font-style', '--dsw-font-markdown-h3-font-weight',
  '--dsw-font-markdown-h3-line-height', '--dsw-font-markdown-h4', '--dsw-font-markdown-h4-font-family', '--dsw-font-markdown-h4-font-size',
  '--dsw-font-markdown-h4-font-style', '--dsw-font-markdown-h4-font-weight', '--dsw-font-markdown-h4-line-height', '--dsw-font-markdown-small',
  '--dsw-font-markdown-small-font-family', '--dsw-font-markdown-small-font-size', '--dsw-font-markdown-small-font-style', '--dsw-font-markdown-small-font-weight',
  '--dsw-font-markdown-small-italic', '--dsw-font-markdown-small-italic-font-family', '--dsw-font-markdown-small-italic-font-size', '--dsw-font-markdown-small-italic-font-style',
  '--dsw-font-markdown-small-italic-font-weight', '--dsw-font-markdown-small-italic-line-height', '--dsw-font-markdown-small-line-height', '--dsw-font-markdown-small-strong',
  '--dsw-font-markdown-small-strong-font-family', '--dsw-font-markdown-small-strong-font-size', '--dsw-font-markdown-small-strong-font-style', '--dsw-font-markdown-small-strong-font-weight',
  '--dsw-font-markdown-small-strong-italic', '--dsw-font-markdown-small-strong-italic-font-family', '--dsw-font-markdown-small-strong-italic-font-size', '--dsw-font-markdown-small-strong-italic-font-style',
  '--dsw-font-markdown-small-strong-italic-font-weight', '--dsw-font-markdown-small-strong-italic-line-height', '--dsw-font-markdown-small-strong-line-height', '--dsw-font-markdown-table',
  '--dsw-font-markdown-table-font-family', '--dsw-font-markdown-table-font-size', '--dsw-font-markdown-table-font-style', '--dsw-font-markdown-table-font-weight',
  '--dsw-font-markdown-table-head', '--dsw-font-markdown-table-head-font-family', '--dsw-font-markdown-table-head-font-size', '--dsw-font-markdown-table-head-font-style',
  '--dsw-font-markdown-table-head-font-weight', '--dsw-font-markdown-table-head-line-height', '--dsw-font-markdown-table-line-height', '--dsw-font-s-14',
  '--dsw-font-s-14-font-family', '--dsw-font-s-14-font-size', '--dsw-font-s-14-font-style', '--dsw-font-s-14-font-weight',
  '--dsw-font-s-14-line-height', '--dsw-font-s-strong-14', '--dsw-font-s-strong-14-font-family', '--dsw-font-s-strong-14-font-size',
  '--dsw-font-s-strong-14-font-style', '--dsw-font-s-strong-14-font-weight', '--dsw-font-s-strong-14-line-height', '--dsw-font-xl-24',
  '--dsw-font-xl-24-font-family', '--dsw-font-xl-24-font-size', '--dsw-font-xl-24-font-style', '--dsw-font-xl-24-font-weight',
  '--dsw-font-xl-24-line-height', '--dsw-font-xs-13', '--dsw-font-xs-13-font-family', '--dsw-font-xs-13-font-size',
  '--dsw-font-xs-13-font-style', '--dsw-font-xs-13-font-weight', '--dsw-font-xs-13-line-height', '--dsw-font-xs-strong-13',
  '--dsw-font-xs-strong-13-font-family', '--dsw-font-xs-strong-13-font-size', '--dsw-font-xs-strong-13-font-style', '--dsw-font-xs-strong-13-font-weight',
  '--dsw-font-xs-strong-13-line-height', '--dsw-font-xxs-12', '--dsw-font-xxs-12-font-family', '--dsw-font-xxs-12-font-size',
  '--dsw-font-xxs-12-font-style', '--dsw-font-xxs-12-font-weight', '--dsw-font-xxs-12-line-height', '--dsw-font-xxs-strong-12',
  '--dsw-font-xxs-strong-12-font-family', '--dsw-font-xxs-strong-12-font-size', '--dsw-font-xxs-strong-12-font-style', '--dsw-font-xxs-strong-12-font-weight',
  '--dsw-font-xxs-strong-12-line-height', '--dsw-font-xxxs-11', '--dsw-font-xxxs-11-font-family', '--dsw-font-xxxs-11-font-size',
  '--dsw-font-xxxs-11-font-style', '--dsw-font-xxxs-11-font-weight', '--dsw-font-xxxs-11-line-height', '--dsw-font-xxxs-strong-11',
  '--dsw-font-xxxs-strong-11-font-family', '--dsw-font-xxxs-strong-11-font-size', '--dsw-font-xxxs-strong-11-font-style', '--dsw-font-xxxs-strong-11-font-weight',
  '--dsw-font-xxxs-strong-11-line-height', '--dsw-gradient-onboarding-blue-stops', '--dsw-gradient-onboarding-cyan-stops', '--dsw-gradient-onboarding-violet-stops',
  '--dsw-linear-gradient-think', '--dsw-linear-think-select', '--dsw-mask-blur', '--dsw-menu-backdrop-filter',
  '--dsw-menu-surface-fill', '--dsw-radius-lg', '--dsw-radius-md', '--dsw-radius-panel',
  '--dsw-radius-sm', '--dsw-radius-xl', '--dsw-radius-xs', '--dsw-shadow-lv1',
  '--dsw-shadow-lv1-blur', '--dsw-shadow-lv2', '--dsw-shadow-lv3', '--dsw-specific-bubble',
  '--dsw-specific-bubble-highlight', '--dsw-specific-input-major', '--dsw-specific-login-input', '--dsw-specific-menu',
  '--dsw-specific-selector', '--dsw-specific-sidebar-fill', '--dsw-specific-sidebar-nav-item-active', '--dsw-specific-sidebar-nav-item-active-accent',
  '--dsw-specific-sidebar-nav-item-hover', '--dsw-specific-tip', '--dsw-static-amber-100', '--dsw-static-amber-400',
  '--dsw-static-amber-500', '--dsw-static-amber-600', '--dsw-static-amber-900', '--dsw-static-blue-100',
  '--dsw-static-blue-300', '--dsw-static-blue-400', '--dsw-static-blue-450', '--dsw-static-blue-50',
  '--dsw-static-blue-500', '--dsw-static-blue-50p', '--dsw-static-blue-600', '--dsw-static-blue-75',
  '--dsw-static-blue-800', '--dsw-static-blue-900', '--dsw-static-blue-950', '--dsw-static-deepseek-100',
  '--dsw-static-deepseek-200', '--dsw-static-deepseek-300', '--dsw-static-deepseek-400', '--dsw-static-deepseek-450',
  '--dsw-static-deepseek-50', '--dsw-static-deepseek-500', '--dsw-static-deepseek-600', '--dsw-static-deepseek-700-delete',
  '--dsw-static-deepseek-800', '--dsw-static-deepseek-900', '--dsw-static-green-100', '--dsw-static-green-400',
  '--dsw-static-green-500', '--dsw-static-green-500-a08', '--dsw-static-green-500-a12', '--dsw-static-green-900',
  '--dsw-static-neutral-00', '--dsw-static-neutral-100', '--dsw-static-neutral-1000', '--dsw-static-neutral-150',
  '--dsw-static-neutral-200', '--dsw-static-neutral-250', '--dsw-static-neutral-300', '--dsw-static-neutral-400',
  '--dsw-static-neutral-50', '--dsw-static-neutral-500', '--dsw-static-neutral-550', '--dsw-static-neutral-600',
  '--dsw-static-neutral-700', '--dsw-static-neutral-800', '--dsw-static-neutral-850', '--dsw-static-neutral-900',
  '--dsw-static-neutral-bluish-00', '--dsw-static-neutral-bluish-100', '--dsw-static-neutral-bluish-1000', '--dsw-static-neutral-bluish-150',
  '--dsw-static-neutral-bluish-200', '--dsw-static-neutral-bluish-300', '--dsw-static-neutral-bluish-400', '--dsw-static-neutral-bluish-50',
  '--dsw-static-neutral-bluish-500', '--dsw-static-neutral-bluish-60', '--dsw-static-neutral-bluish-600', '--dsw-static-neutral-bluish-700',
  '--dsw-static-neutral-bluish-75', '--dsw-static-neutral-bluish-750', '--dsw-static-neutral-bluish-800', '--dsw-static-neutral-bluish-850',
  '--dsw-static-neutral-bluish-875', '--dsw-static-neutral-bluish-900', '--dsw-static-neutral-bluish-950', '--dsw-static-red-100',
  '--dsw-static-red-400', '--dsw-static-red-400-a12', '--dsw-static-red-50', '--dsw-static-red-500',
  '--dsw-static-red-600', '--dsw-static-red-600-a08', '--dsw-static-red-900',
]

/** Tokens another client package defines, not the theme. See the note above. */
const LAYOUT_TOKEN_ALLOWLIST: readonly string[] = []

/** Every `var(--name…)` name in one source text, in order of appearance. */
function tokenNamesIn(source: string): string[] {
  return [...source.matchAll(/var\((--[a-zA-Z0-9-]+)/gu)].map((match) => match[1]!)
}

/** The names `source` uses that no known token set defines. */
function unknownTokenNames(source: string): string[] {
  const known = new Set<string>([...THEME_TOKENS, ...LAYOUT_TOKEN_ALLOWLIST])
  return [...new Set(tokenNamesIn(source))].filter((name) => !known.has(name))
}

describe('theme tokens', () => {
  const clientSource = readFileSync(CLIENT_PATH, 'utf8')

  it('names every styled token the shell actually defines (T5-F1)', () => {
    const used = [...new Set(tokenNamesIn(clientSource))]
    assert.ok(used.length > 0, 'the capsule must style itself from the theme')
    assert.deepEqual(
      unknownTokenNames(clientSource),
      [],
      `client.js names tokens the theme does not define: ${JSON.stringify(unknownTokenNames(clientSource))}`,
    )
  })

  it('styles the capsule with the six real tokens the capsule needs', () => {
    const used = tokenNamesIn(clientSource)
    for (const name of [
      '--dsw-alias-border-l1',
      '--dsw-alias-label-secondary',
      '--dsw-font-xxs-12-font-size',
      '--dsw-font-xxs-12-line-height',
      '--dsw-radius-md',
      '--dsw-radius-sm',
    ]) {
      assert.ok(used.includes(name), `client.js must style with ${name}`)
    }
  })

  it('keeps a var() fallback out of the styles, so no wrong name can hide', () => {
    const fallbacks = [...clientSource.matchAll(/var\(--[a-zA-Z0-9-]+\s*,/gu)].map((match) => match[0])
    assert.deepEqual(
      fallbacks,
      [],
      `a var() fallback freezes the property at the fallback when the name is wrong: ${JSON.stringify(fallbacks)}`,
    )
  })

  it('reports a renamed token instead of passing it (mutation proof)', () => {
    const mutated = clientSource.replace('--dsw-radius-md', '--dsw-radius-mdx')
    assert.notEqual(mutated, clientSource, 'the mutation must actually change the source')
    assert.deepEqual(unknownTokenNames(mutated), ['--dsw-radius-mdx'])
    assert.deepEqual(unknownTokenNames(clientSource), [], 'the pristine bundle is clean')
  })

  it('equals the installed theme set when DSH_THEME_CLIENT points at it', () => {
    assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length, 'the snapshot must not repeat a name')
    assert.ok(THEME_TOKENS.length >= 300, `the snapshot looks truncated: ${THEME_TOKENS.length} names`)
    const themeClient = process.env.DSH_THEME_CLIENT
    if (themeClient === undefined || themeClient === '') return
    const extracted = [
      ...new Set([...readFileSync(themeClient, 'utf8').matchAll(/--dsw-[a-zA-Z0-9-]+/gu)].map((match) => match[0])),
    ].sort()
    assert.deepEqual(extracted, [...THEME_TOKENS], 'the snapshot must equal the installed theme token set')
  })
})