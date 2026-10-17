/*__loop_client_iife_wrapper__*/
/*
 * Browser half of @xinvxueyuan/cordis-plugin-loop.
 *
 * This file is the package's `./client` export: the client module system reads
 * it as one classic script and serves it to the page, which evaluates it and
 * registers the factory below with `window.__ModuleLoader__.load`. Its factory
 * id is the package name — the same string the host module graph keys the entry
 * by — and React arrives through the module table, so this file imports nothing
 * and depends on no other plugin's bundle.
 *
 * ## Shape: the goal capsule's, deliberately
 *
 * The control capsule is modelled on the goal capsule (`dsh-client-ui-goal`) and
 * its host half (`dsh-goal`), not on an ad-hoc design. The isomorphic points are:
 *
 *  - the seat registration `{ name: 'conversation.input.dock', id, order,
 *    locale, inject: (sessionId) => ({ hooks, on… }) }` (goal: ui-goal lines
 *    557-604) — the session comes from the seat, the business face and the hook
 *    source are built per session;
 *  - the state source is the session's **own projection face**
 *    (`binding.session.projections.faceOf('loop')`), read through a
 *    subscriber-counted hook source exactly like the goal's activation source;
 *  - the two verbs are per-session callbacks in that face (`onStop`/`onNext`,
 *    goal's `onPause`/`onResume`), so the component never touches the context;
 *  - the durable value itself is a **single key-level projection** registered
 *    once by the host half (goal: `dsh-goal/lib/index.js` `key: 'goal'`).
 *
 * The action channel stays the session command surface (`remote.commands`), the
 * plan capsule's precedent, so a press runs the same path a typed line runs.
 *
 * Everything this file declares sits inside one function scope: the loader may
 * evaluate these bytes again in the same realm (an HMR swap), and top-level
 * lexical declarations would make the second evaluation a parse error.
 */
;(function () {
  'use strict'

  /** React binding, assigned by the factory from the browser module table. */
  let React

  /** Factory id: the package name the host module graph keys this entry by. */
  const PACKAGE_ID = '@xinvxueyuan/cordis-plugin-loop'

  /** Dictionary namespace owned by this plugin. */
  const NS = 'loop'

  /** The projection key the host half publishes for a session's live loop. */
  const PROJECTION_KEY = 'loop'

  /**
   * Client services this plugin needs before its body may run.
   *
   * A Cordis context proxy only exposes declared services, and a Remote
   * namespace is a service key of its own: `ctx.remote.commands` needs
   * `'remote.commands'`, not merely `'remote'` — the plan capsule declares
   * `"remote"` + `"remote.commands"` (and the goal capsule `"remote"` +
   * `"remote.goals"`) for exactly this reason. `'sessions'` is the goal capsule's
   * own dependency: the seat's session binding is how the entry reaches its
   * projection face. Both omissions shipped and were caught in the real page
   * (T16, T18), so `test/client-capsule.test.ts` asserts that every `ctx.<a>`
   * and every `ctx.<a>.<b>` read in this file is declared here.
   */
  const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.commands']

  /** Slot key: full-width entries above the composer card. */
  const SLOT = 'conversation.input.dock'

  /** How often an armed loop's countdown is recomputed (milliseconds). */
  const TICK_MS = 1000

  /**
   * How long a verb's receipt stays up before the readings come back.
   *
   * A receipt is a momentary answer, not the capsule's content: the readings
   * resume on the next loop value the host pushes, or after this window when no
   * frame follows, whichever comes first. No polling is involved.
   */
  const NOTICE_MS = 2500

  /** Seconds in one minute (short waits) and in one hour (long waits). */
  const SECONDS_PER_MINUTE = 60
  const SECONDS_PER_HOUR = 3600

  /** Simplified Chinese dictionary (the key-set source of truth). */
  const zh = {
    'capsule.aria': '循环控制',
    'capsule.cadence.fixed': '固定节奏',
    'capsule.cadence.self': '自定节奏',
    'capsule.cadenceText.fixed': '固定 · {cadence}',
    'capsule.cadenceText.self': '自定 · 每轮重定',
    'capsule.countdown.kind': '下一轮',
    'capsule.countdown.in': '下一轮 · {wait}后',
    'capsule.round': '第 {round} 轮',
    'capsule.starter.user': '你发起',
    'capsule.starter.agent': '模型发起',
    'action.stop': '停止',
    'action.next': '立即下一轮',
    'action.pending': '处理中…',
    'state.stopped': '已停止',
    'state.nextDelivered': '已投递下一轮',
    'error.noValue': '命令未注册：{line}',
    'error.unreachable': '连接不可用，{line} 未执行',
  }

  /** English dictionary, checked complete against the zh key set. */
  const en = {
    'capsule.aria': 'Loop controls',
    'capsule.cadence.fixed': 'Fixed cadence',
    'capsule.cadence.self': 'Self-paced',
    'capsule.cadenceText.fixed': 'Fixed · {cadence}',
    'capsule.cadenceText.self': 'Self-paced · re-timed each round',
    'capsule.countdown.kind': 'Next round',
    'capsule.countdown.in': 'Next round · in {wait}',
    'capsule.round': 'Round {round}',
    'capsule.starter.user': 'Started by you',
    'capsule.starter.agent': 'Started by the model',
    'action.stop': 'Stop',
    'action.next': 'Run next round now',
    'action.pending': 'Working…',
    'state.stopped': 'Stopped',
    'state.nextDelivered': 'Next round delivered',
    'error.noValue': 'Command not registered: {line}',
    'error.unreachable': 'Not connected; {line} did not run',
  }

  /**
   * Substitute `{name}` placeholders.
   *
   * A key the dictionary does not carry is returned verbatim by `t`, so this
   * pass keeps a missing entry visible as its own key instead of as silently
   * empty text. An unknown placeholder is left in place for the same reason.
   *
   * @param template - Dictionary text carrying zero or more `{name}` slots.
   * @param vars - Values by placeholder name.
   * @returns The filled text.
   */
  function fill(template, vars) {
    const text = String(template)
    if (vars === undefined) return text
    return text.replace(/\{(\w+)\}/gu, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
    )
  }

  /**
   * Format a wait as one short human string.
   *
   * `0s` is rendered rather than clamped away: it is the honest reading of a
   * delivery that is due and has not landed yet.
   *
   * @param seconds - Remaining seconds; a negative value means overdue.
   * @returns Text such as `now`, `45s`, `12m30s`, or `2h5m`.
   */
  function formatWait(seconds) {
    const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
    if (total === 0) return 'now'
    if (total < SECONDS_PER_MINUTE) return `${total}s`
    if (total < SECONDS_PER_HOUR) {
      const minutes = Math.floor(total / SECONDS_PER_MINUTE)
      const rest = total % SECONDS_PER_MINUTE
      return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
    }
    const hours = Math.floor(total / SECONDS_PER_HOUR)
    const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
    return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
  }

  /**
   * Format an instant as a local wall-clock time.
   *
   * No locale id is threaded in: the browser formats in the reader's own
   * language, which is where a clock belongs, while every capsule word comes
   * from the registered `loop` dictionaries.
   *
   * @param date - The instant to show.
   * @returns Text such as `19:42:05`, or `--` for an invalid instant.
   */
  function formatClock(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '--'
    try {
      return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    } catch {
      return date.toISOString().slice(11, 19)
    }
  }

  /**
   * What the capsule shows for one projection reading.
   *
   * Returning a whole value (instead of rendering inline) is what lets the copy
   * be unit-tested without React or a browser: the component's remaining job is
   * to lay these strings out. `visible: false` is the "render nothing" verdict
   * for an absent projection or an inactive one.
   *
   * @param view - The `loop` projection value, or `undefined` while absent.
   * @param nowMs - Reading time, in epoch milliseconds.
   * @param t - The registration's translate function for the `loop` namespace.
   * @returns The capsule reading.
   */
  function capsuleStateOf(view, nowMs, t) {
    if (view === undefined || view === null || view.active !== true) {
      return { visible: false }
    }
    const nextAtMs = view.nextAt === null || view.nextAt === undefined ? Number.NaN : Date.parse(view.nextAt)
    const known = Number.isFinite(nextAtMs)
    return {
      visible: true,
      cadenceText: t(
        view.mode === 'fixed' ? 'capsule.cadenceText.fixed' : 'capsule.cadenceText.self',
        { cadence: view.cadence },
      ),
      cadenceKind: t(view.mode === 'fixed' ? 'capsule.cadence.fixed' : 'capsule.cadence.self'),
      countdown: known
        ? t('capsule.countdown.in', { wait: formatWait((nextAtMs - nowMs) / 1000) })
        : t('capsule.countdown.kind'),
      clock: known ? formatClock(new Date(nextAtMs)) : '--',
      roundText: t('capsule.round', { round: view.round }),
      starterText: t(view.startedBy === 'agent' ? 'capsule.starter.agent' : 'capsule.starter.user'),
    }
  }

  /**
   * Translate one command outcome into the capsule's status line.
   *
   * Error handling copies the plan capsule's contract
   * (`dsh-client-ui-plan/lib/client.js`: a failed Remote reads
   * `message (code)`, and an admitted line the registry does not know reads as
   * an unregistered command) — both are shown, never swallowed.
   *
   * @param result - The Remote result of `commands.execute`.
   * @param line - The exact command line that was sent.
   * @param t - The registration's translate function.
   * @returns Status text.
   */
  function outcomeTextOf(result, line, t) {
    if (result === undefined || result === null) return t('error.unreachable', { line })
    if (result.ok !== true) {
      const error = result.error ?? {}
      const message = typeof error.message === 'string' ? error.message : ''
      const code = typeof error.code === 'string' ? error.code : ''
      if (message === '') return t('error.unreachable', { line })
      return code === '' ? message : `${message} (${code})`
    }
    if (result.value === undefined) return t('error.noValue', { line })
    const text = result.value?.result?.text
    return typeof text === 'string' && text !== '' ? text : undefined
  }

  /** The exact command line each capsule verb sends. */
  const COMMAND_LINES = Object.freeze({ stop: '/loop stop', next: '/loop next' })

  /**
   * Run one capsule verb through the session command surface.
   *
   * The call shape is the generated Remote's own
   * (`commands.execute(agentId, line, submittedAttachments, signal)`), matching
   * the plan capsule's exit verb, so the command executes in the session exactly
   * as if the line had been typed.
   *
   * @param commands - The `remote.commands` namespace face captured from `ctx`
   *   by the seat's inject factory.
   * @param verb - `stop` or `next`.
   * @param sessionId - Session whose command surface receives the line.
   * @returns The Remote result, or `undefined` when the carrier is absent.
   */
  async function runLoopVerb(commands, verb, sessionId) {
    const line = COMMAND_LINES[verb]
    if (commands === undefined || commands === null || typeof commands.execute !== 'function') return undefined
    return await commands.execute(sessionId, line, [])
  }

  /**
   * Visual language, copied value for value from the goal capsule's own
   * stylesheet (`dsh-client-ui-goal/lib/client.js`, `GoalBar.module.css`):
   * a 36px card with `--dsw-radius-md`, the elevation panel shadow (whose stroke
   * colour is `--dsw-alias-border-l1`), the menu surface as its background, a
   * tertiary glyph, a primary label, a dimmed ellipsised line and 28px round icon
   * buttons with a hover fill. Hand-written `var()` fallbacks stay banned: a
   * made-up name with a fallback freezes the property at that fallback and the
   * capsule silently stops following the theme (T5-F1).
   */
  const dockStyle = Object.freeze({
    boxSizing: 'border-box',
    // The goal bar's own alignment recipe: the composer layout publishes side
    // clearance and dock inset, and the strip narrows itself by both so the card
    // lines up with the composer card instead of spanning the whole pane.
    width:
      'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
    margin: '0 auto',
    display: 'flex',
    justifyContent: 'center',
  })

  /** The card itself. */
  const barStyle = Object.freeze({
    '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: 'calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset))',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '0 auto',
    padding: '4px 5px 4px 12px',
    border: '0',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-specific-menu)',
    backdropFilter: 'var(--dsw-menu-backdrop-filter)',
    boxShadow: 'var(--dsw-elevation-panel)',
    position: 'relative',
  })

  /** Leading glyph: the goal bar's own tertiary tint, sized with its label. */
  const glyphStyle = Object.freeze({
    color: 'var(--dsw-alias-label-tertiary)',
    flex: 'none',
    display: 'inline-flex',
    fontSize: '14px',
    lineHeight: '1',
  })

  /** The label slot (goal uses it for the phase). */
  const labelStyle = Object.freeze({
    color: 'var(--dsw-alias-label-primary)',
    flex: 'none',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: '24px',
  })

  /** The flexing reading line: one ellipsised row, never a second line. */
  const readingStyle = Object.freeze({
    minWidth: 0,
    flex: '1 1 auto',
    color: 'var(--dsw-alias-label-primary-dimmed)',
    fontSize: '13px',
    lineHeight: '20px',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  })

  /** A failed verb reads in the goal bar's own error styling. */
  const errorStyle = Object.freeze({
    minWidth: 0,
    flex: '1 1 auto',
    color: 'var(--dsw-alias-state-error-primary)',
    fontSize: '12px',
    lineHeight: '20px',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  })

  /** Right-hand control cluster. */
  const actionsStyle = Object.freeze({
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  })

  /** Round 28px icon button, the goal bar's own control. */
  const iconButtonStyle = Object.freeze({
    width: '28px',
    height: '28px',
    display: 'inline-flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 0,
    border: '0',
    borderRadius: '999px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
  })

  /** Hover fill and text, matching `.iconBtn:hover`. */
  const iconButtonHoverStyle = Object.freeze({
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  })

  /** Disabled opacity, matching `.iconBtn:disabled`. */
  const iconButtonDisabledStyle = Object.freeze({ opacity: 0.4, cursor: 'default' })

  /**
   * The dock's hook source: one session's live loop reading as an observable.
   *
   * Mirrors the goal capsule's activation source (`createGoalActivationSource`):
   * the value comes from that session's **own projection face** — the durable
   * truth the host publishes — and this source adds only what the durable value
   * cannot carry: a 1 Hz reading clock so a countdown moves, plus a re-read on
   * `connection/reset`. Attachment is subscriber-counted, so nothing is
   * subscribed and no timer exists until the dock actually renders this entry,
   * and everything is released when the last subscriber leaves.
   *
   * The published snapshot keeps its identity between ticks, so React only
   * re-renders when the reading really moved (a new second while armed, or a new
   * projection value).
   *
   * @param deps - The session's projection face and its reset subscription.
   * @returns A `HostObservable`-shaped source the slot turns into `useLoopState`.
   */
  function createLoopStateSource(deps) {
    /** Last published reading; replaced only when the view or the second moves. */
    let snapshot = Object.freeze({ view: undefined, nowMs: Date.now() })
    /** Dock renderers currently observing this source. */
    const listeners = new Set()
    let timer
    let offProjection
    let offReset

    const read = () => ({ view: deps.projection.getSnapshot(), nowMs: Date.now() })

    /** Compare two projection values field by field (identity short-circuits). */
    const sameView = (left, right) =>
      left === right ||
      (left !== undefined &&
        left !== null &&
        right !== undefined &&
        right !== null &&
        left.active === right.active &&
        left.mode === right.mode &&
        left.cadence === right.cadence &&
        left.nextAt === right.nextAt &&
        left.round === right.round &&
        left.startedBy === right.startedBy)

    const publish = (next) => {
      snapshot = Object.freeze(next)
      for (const listener of [...listeners]) listener()
    }

    const sync = (force) => {
      const next = read()
      if (force === true || !sameView(next.view, snapshot.view)) publish(next)
    }

    /** Run the reading clock only while a loop is armed. */
    const arm = () => {
      const active = snapshot.view !== undefined && snapshot.view !== null && snapshot.view.active === true
      if (active && timer === undefined) {
        timer = setInterval(() => {
          sync(true)
        }, TICK_MS)
      }
      if (!active && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const attach = () => {
      offProjection ??= deps.projection.subscribe(() => {
        sync(false)
        arm()
      })
      offReset ??= deps.subscribeReset(() => {
        sync(true)
        arm()
      })
      sync(false)
      arm()
    }

    const detach = () => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      if (offProjection !== undefined) {
        offProjection()
        offProjection = undefined
      }
      if (offReset !== undefined) {
        offReset()
        offReset = undefined
      }
    }

    return Object.freeze({
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        if (listeners.size === 1) attach()
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) detach()
        }
      },
    })
  }

  /**
   * The capsule: the goal dock's shape over the loop projection.
   *
   * Props are the framework's session seats (`useProjection`), this plugin's own
   * hook (`useLoopState`, from `hooks.loopState`), the two per-session callbacks
   * from the inject face, and the locale seat `t`. The component never reaches
   * for `ctx`.
   *
   * "Hidden" means "render nothing": an absent projection (the host unit is not
   * mounted, or no baseline has carried the key yet) and a projection reporting
   * `active: false` both return `null`, so the strip above the composer stays
   * empty instead of showing a dead control — the goal capsule hides the same
   * way when there is no goal.
   *
   * A verb's outcome replaces the readings with the command's own reported text
   * on success and with the failure's own message plus code on failure: a
   * control that silently does nothing is worse than a visible line, and a
   * status replaces the readings rather than stacking, so the strip never grows
   * a second row.
   *
   * @param props - The composed registration props.
   * @returns The capsule element, or `null` while no loop is armed.
   */
  function LoopDock(props) {
    const projected = typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : undefined
    const reading = typeof props.useLoopState === 'function' ? props.useLoopState((snapshot) => snapshot) : undefined
    const t = props.t
    const view = projected !== undefined && projected !== null ? projected : reading === undefined ? undefined : reading.view
    const nowMs = reading === undefined ? Date.now() : reading.nowMs
    const [pending, setPending] = React.useState('')
    // The verb receipt, together with the loop value it was produced against.
    // A notice is a momentary answer, not the capsule's content: it yields to the
    // readings as soon as the host pushes a new loop value (t24 makes every
    // revision a fresh reference), or after NOTICE_MS when no frame follows —
    // whichever comes first. Nothing here polls.
    const [notice, setNotice] = React.useState(undefined)
    /** Which icon button the pointer is over; drives the goal bar's hover fill. */
    const [hover, setHover] = React.useState('')
    // The in-flight flag is a ref, not the `pending` state: two clicks inside one
    // render both read the state the last render closed over, so only the ref
    // actually blocks the second request on the wire.
    const inFlight = React.useRef('')
    const active = view !== undefined && view !== null && view.active === true
    const showingNotice = notice !== undefined && notice.at === projected

    // Drop the notice as soon as the loop value it belonged to is replaced.
    React.useEffect(() => {
      if (notice !== undefined && notice.at !== projected) setNotice(undefined)
    }, [notice, projected])

    // Fallback for a receipt whose frame already arrived before it did: the
    // readings come back after a short window instead of waiting for the next
    // round. One timer per notice, cleared on unmount.
    React.useEffect(() => {
      if (notice === undefined) return undefined
      const timer = setTimeout(() => {
        setNotice((current) => (current === notice ? undefined : current))
      }, NOTICE_MS)
      return () => {
        clearTimeout(timer)
      }
    }, [notice])

    if (!active) return null

    const state = capsuleStateOf(view, nowMs, t)
    if (!state.visible) return null

    const run = (verb, action) => {
      if (inFlight.current !== '') return
      inFlight.current = verb
      setPending(verb)
      void (async () => {
        try {
          const result = await action()
          const text = outcomeTextOf(result, COMMAND_LINES[verb], t)
          const failed = result === undefined || result === null || result.ok !== true
          setNotice({
            at: projected,
            level: failed ? 'error' : 'status',
            text:
              text === undefined
                ? verb === 'stop'
                  ? t('state.stopped')
                  : t('state.nextDelivered')
                : text,
          })
        } catch (error) {
          setNotice({
            at: projected,
            level: 'error',
            text: error instanceof Error ? error.message : String(error),
          })
        } finally {
          inFlight.current = ''
          setPending('')
        }
      })()
    }

    /** One 14px icon button, the goal bar's own size and states. */
    const iconButton = (verb, label, icon) => {
      const disabled = pending !== ''
      return React.createElement(
        'button',
        {
          key: verb,
          type: 'button',
          'data-dsh-loop-action': verb,
          disabled,
          title: label,
          'aria-label': label,
          style: {
            ...iconButtonStyle,
            ...(disabled ? iconButtonDisabledStyle : hover === verb ? iconButtonHoverStyle : {}),
          },
          onMouseEnter: () => {
            setHover(verb)
          },
          onMouseLeave: () => {
            setHover('')
          },
          onClick: () => {
            run(verb, verb === 'stop' ? props.onStop : props.onNext)
          },
        },
        icon,
      )
    }

    const stopIcon = React.createElement(
      'svg',
      { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
      React.createElement('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor' }),
    )
    const nextIcon = React.createElement(
      'svg',
      { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
      React.createElement('path', { d: 'M4.6 3.4 10.2 8 4.6 12.6Z', fill: 'currentColor' }),
      React.createElement('rect', { x: 10.7, y: 3.4, width: 1.7, height: 9.2, rx: 0.85, fill: 'currentColor' }),
    )

    // The label slot keeps the durable "which round" reading, exactly as the goal
    // bar keeps its phase label while the objective slot carries the content: the
    // flexing line below carries cadence · countdown · starter, or a verb receipt.
    return React.createElement(
      'div',
      {
        'data-dsh-loop-capsule': '',
        'data-dsh-loop-state': showingNotice ? 'notice' : 'reading',
        'data-dsh-loop-active': String(active),
        role: 'note',
        'aria-label': t('capsule.aria'),
        style: dockStyle,
      },
      React.createElement(
        'div',
        { 'data-dsh-loop-bar': '', style: barStyle },
        React.createElement('span', { key: 'glyph', 'aria-hidden': true, style: glyphStyle }, '⟳'),
        React.createElement('span', { key: 'label', style: labelStyle }, state.roundText),
        showingNotice
          ? React.createElement(
              'span',
              {
                key: 'notice',
                role: notice.level === 'error' ? 'alert' : 'status',
                style: notice.level === 'error' ? errorStyle : readingStyle,
              },
              notice.text,
            )
          : React.createElement(
              'span',
              { key: 'reading', title: state.clock, style: readingStyle },
              [state.cadenceText, state.countdown, state.starterText].join(' · '),
            ),
        React.createElement(
          'div',
          { key: 'actions', style: actionsStyle },
          iconButton('stop', pending === 'stop' ? t('action.pending') : t('action.stop'), stopIcon),
          iconButton('next', pending === 'next' ? t('action.pending') : t('action.next'), nextIcon),
        ),
      ),
    )
  }

  /**
   * Client plugin body: register the namespace dictionaries and claim the dock
   * seat, the goal capsule's own shape.
   *
   * `ctx.slots.inject` waits for the seat's declaration, so this plugin never
   * registers into a slot that is not declared yet. The seat's inject factory is
   * where the per-session state source and the two callbacks are built — the
   * component itself stays context-free.
   *
   * @param ctx - client root context.
   */
  function apply(ctx) {
    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'ui-loop: dictionaries',
    )
    const sessions = ctx.sessions
    ctx.slots.inject(SLOT, () =>
      ctx.slots.register(
        {
          name: SLOT,
          id: 'loop',
          order: 5,
          locale: NS,
          /**
           * The seat's business face, built per session.
           *
           * `binding.session.projections.faceOf(PROJECTION_KEY)` is the goal
           * capsule's own state route: the session's projection face, not a
           * global store. The namespace is read here as `ctx.remote.commands` so
           * that this file contains the exact key it depends on — a read hidden
           * behind a captured parent object is invisible to the static guard,
           * which is how the missing `'remote.commands'` grant shipped (T18).
           */
          inject: (sessionId) => {
            const binding = sessions.binding(sessionId)
            if (binding === undefined) throw new Error(`ui-loop: session "${sessionId}" is unavailable`)
            const commands = ctx.remote.commands
            return {
              hooks: {
                loopState: createLoopStateSource({
                  projection: binding.session.projections.faceOf(PROJECTION_KEY),
                  subscribeReset: (listener) => ctx.on('connection/reset', listener),
                }),
              },
              onStop: async () => await runLoopVerb(commands, 'stop', sessionId),
              onNext: async () => await runLoopVerb(commands, 'next', sessionId),
            }
          },
        },
        LoopDock,
      ),
    )
  }

  /**
   * The pure helpers this bundle exposes to its own test suite.
   *
   * A client bundle is a classic script with no module exports, and this file is
   * the unit's only source of truth (there is no second copy under `src/`), so
   * the helpers are published on one namespaced global rather than duplicated
   * into the test. Nothing else reads this property.
   */
  globalThis.__dshLoopClient = Object.freeze({
    PACKAGE_ID,
    NS,
    PROJECTION_KEY,
    SLOT,
    TICK_MS,
    NOTICE_MS,
    COMMAND_LINES,
    zh,
    en,
    inject,
    fill,
    formatWait,
    formatClock,
    capsuleStateOf,
    outcomeTextOf,
    runLoopVerb,
    createLoopStateSource,
    LoopDock,
    apply,
  })

  const loader = globalThis.__ModuleLoader__
  loader?.load({
    id: PACKAGE_ID,
    factory(require) {
      React = require('react')
      return { inject, apply }
    },
  })
})()
