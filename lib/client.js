/**
 * dsh-embedded-browser — browser half.
 *
 * One Chrome lives on the DSH host and **every DSH session owns one tab in it**.
 * This half puts that tab in the Web UI as an **on-demand right-Sidebar tab**:
 *
 * - `ctx.sidebarRightTabs` declares the page type (`kind` {@link TAB_KIND}, id
 *   {@link TAB_ID}), and the keyed `sidebar.right.pane.tab` /
 *   `sidebar.right.pane.tab.title` seats draw its body and chip. Registering a
 *   type is not opening one — no session shows a 浏览器 tab until it actually
 *   has a browser, which is what keeps the surface out of everybody else's way.
 * - The body is the live picture of *this* session's tab, with the human's
 *   mouse, wheel, keyboard and IME replayed into the very CDP target the AI
 *   drives, plus the hand-over banner `browser_embedded_ask_human` waits on. The
 *   slot entry is session-scoped, so the component always knows which tab it
 *   shows, and its mount/unmount lifetime *is* the focus protocol (mount asks
 *   the host to put this tab in front and stream it at full rate, unmount gives
 *   it back — unmount never closes the tab).
 * - {@link watchSessions} opens that tab by itself the moment the session has a
 *   browser, or a human request lands in a session whose tab is closed. It is
 *   the only reason a tab ever appears: nothing is pinned per session any more.
 *
 * Plain JavaScript on purpose: the module loader factory must not depend on a
 * build step or on npm packages beyond React, which the host provides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-embedded-browser',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** Tab type identity: the `id` both keyed seats (body, title) register under. */
    const TAB_ID = 'dsh-embedded-browser/panel'
    /** Page kind the type opens; `sidebarRight.openTabIn(session, TAB_KIND)` names it. */
    const TAB_KIND = 'embedded-browser'
    /** Every route this plugin owns; all same-origin, all cookie-authenticated. */
    const BASE = '/api/dsh-embedded-browser'
    const STREAM_PATH = `${BASE}/stream`
    const STATE_PATH = `${BASE}/state`
    const SESSIONS_PATH = `${BASE}/sessions`
    const OPEN_PATH = `${BASE}/open`
    const CLOSE_PATH = `${BASE}/close`
    const DONE_PATH = `${BASE}/human-done`
    /** Session state poll, used only while the websocket is not live. */
    const STATE_POLL_MS = 2000
    /** Reconnect backoff, so a host restart does not become a request storm. */
    const RECONNECT_BASE_MS = 800
    const RECONNECT_MAX_MS = 15000
    /** Pointer moves are throttled to ~25/s; a page does not need more. */
    const MOVE_THROTTLE_MS = 40
    /**
     * Auto-open poll. Deliberately unhurried: the only thing it is waiting for
     * is "this session just got a browser", and nobody is staring at the Sidebar
     * waiting for it. Every tick is one more request on an origin whose
     * connections are already scarce — the live tab holds a WebSocket, and on
     * HTTP/1.1 a browser allows about six per origin shared by every tab, which
     * streaming plugins each sit on (see references/PITFALLS.md #18).
     */
    const REVEAL_POLL_MS = 5000
    /** Auto-open poll while the document is hidden: nothing is being watched. */
    const REVEAL_IDLE_POLL_MS = 20000
    /** The chip's hand-over dot is decoration: a slow poll is enough. */
    const TITLE_POLL_MS = 5000

    /** Copy for both shipped locales. */
    const DICT = {
      zh: {
        title: '浏览器',
        guideTitle: '内嵌浏览器',
        guideDescription: '在容器内自带 Chrome 里打开一个页面，可在此查看并接管（登录、扫码、验证码）。',
        back: '后退',
        forward: '前进',
        reload: '刷新',
        refresh: '重绘',
        closeTab: '结束并清理',
        closeTabTitle: '关闭这个会话的浏览器标签页（未提交的页面状态会丢失）',
        closeTabConfirm: '关闭这个会话的浏览器标签页？未提交的表单与页面状态会丢失；登录态存在共享 profile 里，不会丢。',
        connecting: '连接中…',
        connected: '已连接',
        offline: '连接断开，正在重连…',
        stopped: '浏览器未启动',
        failed: '浏览器启动失败',
        checking: '正在检查这个会话的浏览器…',
        empty: '这个会话还没有打开浏览器',
        emptyHint: '打开后这里就是 AI 正在操作的页面；登录、扫码、验证码都可以直接在这里完成。',
        open: '在此会话打开浏览器',
        starting: '正在打开…',
        openFailed: '打开失败',
        waitingFrame: '正在获取画面…',
        humanTitle: '需要你操作',
        humanDone: '我已完成',
        humanHint: '完成上方操作后点此按钮，AI 会接着往下做；也可以留一句话再回复。',
        reply: '回复',
        replyPlaceholder: '留一句话给 AI（可选）',
        pollHint: '降帧快照 ~7fps（标签页不在前台）',
        noSession: '这里拿不到会话 id，无法确定这个标签页对应哪个浏览器标签页。',
        pending: '需要你',
        tab: '把焦点移到下一个可输入元素（免鼠标定位）',
        shiftTab: '焦点移到上一个元素',
        enter: '回车（提交 / 确认）',
        instructions: '点画面任意处即可聚焦，然后用键盘/输入法打字（登录页常用）；表单还可以用工具栏的 Tab / Enter 逐项跳转提交。AI 看到的是同一个页面。',
      },
      en: {
        title: 'Browser',
        guideTitle: 'Embedded browser',
        guideDescription: 'Open a page in a Chrome that lives in this container, and watch or take it over here (logins, QR codes, CAPTCHAs).',
        back: 'Back',
        forward: 'Forward',
        reload: 'Reload',
        refresh: 'Repaint',
        closeTab: 'Close tab',
        closeTabTitle: 'Close this session’s browser tab (its page state is discarded)',
        closeTabConfirm: 'Close this session’s browser tab? Unsaved form and page state are lost — logins live in the shared profile and stay.',
        connecting: 'Connecting…',
        connected: 'Connected',
        offline: 'Disconnected — reconnecting…',
        stopped: 'Browser not running',
        failed: 'Browser failed to start',
        checking: 'Checking this session’s browser…',
        empty: 'This session has no browser open yet',
        emptyHint: 'Once opened, this is the page the AI is working on — logins, QR codes and CAPTCHAs can be done right here.',
        open: 'Open a browser in this session',
        starting: 'Opening…',
        openFailed: 'Could not open',
        waitingFrame: 'Fetching the first frame…',
        humanTitle: 'Your turn',
        humanDone: 'Done',
        humanHint: 'Finish the step above, then press this — the AI continues from there. You can also leave a note in the reply field.',
        reply: 'Reply',
        replyPlaceholder: 'Leave the AI a note (optional)',
        pollHint: 'Low-rate stills ~7fps (tab not in front)',
        noSession: 'No session id here, so this tab cannot tell which browser tab it shows.',
        pending: 'Needs you',
        tab: 'Move focus to the next field (no mouse aiming needed)',
        shiftTab: 'Move focus to the previous element',
        enter: 'Enter (submit / confirm)',
        instructions: 'Click anywhere in the picture to focus it, then type with your keyboard or IME (handy for logins); use the Tab / Enter buttons to walk a form without aiming the mouse. The AI sees the same page.',
      },
    }

    /** Pick the dictionary that matches the GUI language. */
    function pickDict(locale) {
      const code = String(locale ?? '').toLowerCase()
      return code.startsWith('zh') ? DICT.zh : DICT.en
    }

    /**
     * Stylesheet, scoped by data attribute; colours follow the host theme.
     *
     * `.deb-overlay` is an *informational* layer over a live canvas and must stay
     * click-through (a full-canvas overlay without `pointer-events:none` silently
     * eats every click on the page below — see references/PITFALLS.md #10). The
     * interactive empty state is a separate class without that rule.
     */
    const CSS = `
      [data-dsh-embedded-browser]{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#111);color:var(--dsw-alias-label-primary,#eee)}
      [data-dsh-embedded-browser] .deb-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,transparent);font-size:12.5px}
      [data-dsh-embedded-browser] .deb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e0a020);flex:none}
      [data-dsh-embedded-browser] .deb-dot[data-state="online"]{background:var(--dsw-alias-state-success-primary,#3ecf8e)}
      [data-dsh-embedded-browser] .deb-dot[data-state="offline"]{background:var(--dsw-alias-state-error-primary,#e5484d)}
      [data-dsh-embedded-browser] .deb-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}
      [data-dsh-embedded-browser] .deb-url{color:var(--dsw-alias-label-secondary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;font-variant-numeric:tabular-nums}
      [data-dsh-embedded-browser] .deb-note{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}
      [data-dsh-embedded-browser] .deb-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,transparent)}
      [data-dsh-embedded-browser] button.deb-btn{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;border-radius:6px;padding:3px 9px;font-size:12.5px;font-family:inherit;cursor:pointer;flex:none}
      [data-dsh-embedded-browser] button.deb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.18))}
      [data-dsh-embedded-browser] button.deb-btn:disabled{opacity:.45;cursor:default}
      [data-dsh-embedded-browser] button.deb-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
      [data-dsh-embedded-browser] button.deb-primary{border:0;border-radius:6px;padding:5px 14px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;flex:none}
      [data-dsh-embedded-browser] button.deb-primary:disabled{opacity:.5;cursor:default}
      [data-dsh-embedded-browser] .deb-spacer{flex:1;min-width:8px}
      [data-dsh-embedded-browser] .deb-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;background:var(--dsw-alias-bg-overlay,rgba(224,160,32,.16));border-bottom:1px solid var(--dsw-alias-state-warn-primary,#e0a020);font-size:13px}
      [data-dsh-embedded-browser] .deb-banner strong{color:var(--dsw-alias-state-warn-primary,#e0a020);flex:none}
      [data-dsh-embedded-browser] .deb-banner .deb-grow{flex:1;min-width:140px}
      [data-dsh-embedded-browser] .deb-banner input.deb-reply{flex:0 1 240px;min-width:140px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-base,#111);color:inherit;padding:4px 8px;font-size:12.5px;font-family:inherit}
      [data-dsh-embedded-browser] .deb-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-base,#0b0b0b)}
      [data-dsh-embedded-browser] canvas.deb-canvas{display:block;max-width:100%;max-height:100%;outline:none;cursor:default;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)}
      [data-dsh-embedded-browser] .deb-hint{position:absolute;left:12px;right:12px;bottom:10px;font-size:12px;text-align:center;color:var(--dsw-alias-label-secondary,#999);pointer-events:none}
      [data-dsh-embedded-browser] .deb-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary,#999);font-size:13px;text-align:center;padding:24px;pointer-events:none}
      [data-dsh-embedded-browser] .deb-sink{position:absolute;opacity:0;width:1px;height:1px;border:0;padding:0;resize:none;left:0;top:0}
      [data-dsh-embedded-browser] .deb-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-embedded-browser] .deb-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#eee)}
      [data-dsh-embedded-browser] .deb-empty-note{max-width:420px;line-height:1.6}
      [data-dsh-embedded-browser] .deb-empty-error{max-width:420px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-word}
      [data-dsh-embedded-browser] .deb-notice{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;padding:24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#999)}
      .deb-tab-title{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%}
      .deb-tab-title .deb-tab-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .deb-tab-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e0a020)}
    `

    /** Modifier list for the host's key dispatch. */
    const modifiersOf = (event) => {
      const list = []
      if (event.altKey) list.push('alt')
      if (event.ctrlKey) list.push('ctrl')
      if (event.metaKey) list.push('meta')
      if (event.shiftKey) list.push('shift')
      return list
    }

    /** Keys forwarded explicitly; everything else is typed through the sink. */
    const SPECIAL_KEYS = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    }

    /**
     * Fetch one JSON document on the GUI's own origin.
     *
     * Every route is protected by the Web UI's session cookie, so the request
     * must stay same-origin and credentialed; a non-2xx answer is an error the
     * caller renders instead of a silently empty panel.
     */
    async function requestJson(url, options) {
      const { method = 'GET', body } = options ?? {}
      const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * The page's CSS viewport out of a host payload, or `null` when the host has
     * not measured one yet (no tab open, or the page is mid-navigation).
     */
    function viewportOf(raw) {
      if (raw === null || raw === undefined) return null
      const width = Number(raw.width)
      const height = Number(raw.height)
      if (!(width > 0) || !(height > 0)) return null
      return { width, height }
    }

    /**
     * Normalize the `/state` payload (`GET /state`, the body of `POST /open`, and
     * the `status` field of a `hello` message) into the few fields the panel uses.
     */
    function snapshotFromState(payload) {
      const session = payload?.session ?? {}
      return {
        open: session.open === true,
        running: payload?.running === true,
        url: typeof session.url === 'string' ? session.url : null,
        title: typeof session.title === 'string' ? session.title : null,
        viewport: viewportOf(session.viewport),
        human: payload?.human ?? null,
        stream: payload?.stream === 'poll' || payload?.stream === 'screencast' ? payload.stream : null,
      }
    }

    /** Normalize a pushed `{ type: 'state' }` message (a flatter shape). */
    function snapshotFromMessage(message) {
      return {
        open: message.open === true,
        running: message.running === true,
        url: typeof message.url === 'string' ? message.url : null,
        title: typeof message.title === 'string' ? message.title : null,
        viewport: viewportOf(message.viewport),
        human: message.human ?? null,
        stream: message.stream === 'poll' || message.stream === 'screencast' ? message.stream : null,
      }
    }

    /** Whether two pending-request snapshots describe the same request. */    function sameHuman(left, right) {
      if (left === right) return true
      if (left === undefined || left === null || right === undefined || right === null) return false
      return left.id === right.id && left.instruction === right.instruction
    }

    /** The sidebar entry glyph: a small window with a cursor. */
    function BrowserIcon(props) {
      const { size = 16, active = false } = props ?? {}
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3 }),
        h('path', { d: 'M1.5 5.5h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 3.6, cy: 4, r: 0.6, fill: 'currentColor' }),
        h('circle', { cx: 5.6, cy: 4, r: 0.6, fill: 'currentColor' }),
        h('path', { d: 'M7 8.5l4.6 1.9-1.8.8-.8 1.8z', fill: 'currentColor' }),
      )
    }

    /**
     * One session's browser tab, drawn as the right-Sidebar tab body.
     *
     * The slot entry is session-scoped, so `sessionId` already identifies the
     * very browser tab this component must show. Its **visibility** is the focus
     * protocol: a docked body is mounted while its tab is the visible one, which
     * is the moment to ask the host to put this browser tab in front and stream
     * it at full rate; hiding hands the foreground back. **It never closes the
     * browser tab** — that belongs to the session, not to the surface.
     */
    function SessionPanel(props) {
      const { dict } = props
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : ''
      // A docked body stays mounted while its tab is inactive or the column is
      // collapsed, so "am I on screen" is not "am I mounted": the stream must be
      // driven by visibility, or a hidden tab would keep stealing the browser's
      // foreground and spend bandwidth nobody is looking at.
      const visible = props.visible !== false
      const canvasRef = useRef(null)
      const sinkRef = useRef(null)
      const socketRef = useRef(null)
      const bitmapRef = useRef(undefined)
      const decodingRef = useRef(false)
      const lastMoveRef = useRef(0)
      /** The page's own CSS viewport, as last reported by the host. */
      const viewportRef = useRef(null)
      const [open, setOpen] = useState(undefined)
      const [connection, setConnection] = useState('idle')
      const [status, setStatus] = useState({})
      const [streamMode, setStreamMode] = useState(undefined)
      const [human, setHuman] = useState(undefined)
      const [failure, setFailure] = useState(undefined)
      const [hasFrame, setHasFrame] = useState(false)
      const [busy, setBusy] = useState(false)
      const [reply, setReply] = useState('')

      /**
       * Fold one normalized snapshot into render state.
       *
       * The functional setters keep object identities stable when nothing
       * changed, so the 2s poll cannot re-render the canvas away or fight a
       * half-typed reply.
       */
      const applySnapshot = useCallback((snapshot) => {
        if (snapshot === undefined || snapshot === null) return
        setOpen(snapshot.open === true)
        // A ref, not state: the pointer handlers read it while they run, and the
        // mapping must never be a render behind the viewport it describes.
        const size = snapshot.viewport
        viewportRef.current = size !== null && size !== undefined && size.width > 0 && size.height > 0 ? size : null
        setStatus((current) =>
          current.running === snapshot.running && current.url === snapshot.url && current.title === snapshot.title
            ? current
            : { running: snapshot.running, url: snapshot.url, title: snapshot.title },
        )
        setHuman((current) => (sameHuman(current, snapshot.human) ? current : snapshot.human ?? undefined))
        setStreamMode((current) => {
          const next = snapshot.stream === 'screencast' || snapshot.stream === 'poll' ? snapshot.stream : undefined
          return current === next ? current : next
        })
      }, [])

      /** Paint one JPEG frame onto the canvas. */
      const paint = useCallback(async (buffer) => {
        const canvas = canvasRef.current
        if (canvas === null) return
        try {
          const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }))
          bitmapRef.current = bitmap
          setHasFrame(true)
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0)
          // A frame that paints is the proof that whatever failed has recovered:
          // a genuinely broken browser stops sending them, and the note stays.
          setFailure(undefined)
        } catch {
          /* a torn frame is not worth surfacing */
        }
      }, [])

      /** Send one panel message when the socket is open; otherwise do nothing. */
      const send = useCallback((message) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(message))
      }, [])

      /**
       * Map a pointer event to page viewport coordinates.
       *
       * The canvas paints the whole frame, and the frame is the whole page
       * viewport scaled to fit — same aspect, no letterboxing — so the canvas box
       * *ratio* is the entire mapping. Reading the page's own viewport (instead of
       * the canvas's intrinsic size, which is what the frame happens to be) is what
       * keeps it right once the two stop agreeing: Chrome caps screencast frames at
       * the configured maximum, so any viewport taller than the cap arrives
       * downscaled — an iPad preset or a 1920-wide desktop check would otherwise
       * put every human click tens of percent away from where it was aimed. The
       * intrinsic size stays as the fallback for the first moments, before the host
       * has reported a viewport.
       */
      const toPageCoords = (event) => {
        const canvas = canvasRef.current
        if (canvas === null) return { x: 0, y: 0 }
        const rect = canvas.getBoundingClientRect()
        const size = viewportRef.current ?? { width: canvas.width, height: canvas.height }
        return {
          x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * size.width,
          y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * size.height,
        }
      }

      /** Send one key and keep the keyboard sink focused for follow-up typing. */
      const pressKey = (spec, modifiers = []) => {
        send({ type: 'input', kind: 'key', event: 'down', ...spec, modifiers })
        send({ type: 'input', kind: 'key', event: 'up', ...spec, modifiers })
        sinkRef.current?.focus?.()
      }

      /**
       * The live channel of *this* session's tab.
       *
       * Reconnects with backoff while this tab is on screen, asks for `focus` on
       * (re)connect — the host then activates this browser tab and upgrades it to
       * a full-rate screencast — and seeds one frame with `play`, because a static
       * page produces no frames of its own. A session without a tab, or a tab the
       * human is not looking at, never holds a socket at all.
       */
      useEffect(() => {
        if (sessionId === '' || open !== true || visible !== true) {
          setConnection('idle')
          return undefined
        }
        let disposed = false
        let attempt = 0
        let timer
        const clearTimer = () => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
        }
        const schedule = () => {
          if (disposed) return
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt) + Math.round(Math.random() * 250)
          attempt += 1
          clearTimer()
          timer = setTimeout(connect, delay)
        }
        const connect = () => {
          if (disposed) return
          setConnection('connecting')
          const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
          let socket
          try {
            socket = new WebSocket(`${scheme}//${window.location.host}${STREAM_PATH}?session=${encodeURIComponent(sessionId)}`)
          } catch {
            schedule()
            return
          }
          socket.binaryType = 'arraybuffer'
          socketRef.current = socket
          socket.onopen = () => {
            if (disposed) {
              try {
                socket.close()
              } catch {
                /* already closing */
              }
              return
            }
            attempt = 0
            setConnection('live')
            setFailure(undefined)
            if (document.visibilityState !== 'hidden') socket.send(JSON.stringify({ type: 'focus' }))
            // A static page emits nothing by itself: ask for one frame.
            socket.send(JSON.stringify({ type: 'play' }))
          }
          socket.onclose = () => {
            if (socketRef.current === socket) socketRef.current = null
            if (disposed) return
            setConnection('offline')
            schedule()
          }
          socket.onerror = () => {
            /* `onclose` always follows and owns the reconnect */
          }
          socket.onmessage = (event) => {
            if (typeof event.data !== 'string') {
              if (decodingRef.current) return
              decodingRef.current = true
              void paint(event.data).finally(() => {
                decodingRef.current = false
              })
              return
            }
            let message
            try {
              message = JSON.parse(event.data)
            } catch {
              return
            }
            if (message.type === 'hello') {
              const snapshot = snapshotFromState(message.status ?? {})
              if (message.human !== undefined && message.human !== null) snapshot.human = message.human
              snapshot.stream = message.mode === 'screencast' || message.mode === 'poll' ? message.mode : null
              applySnapshot(snapshot)
              return
            }
            if (message.type === 'state') {
              applySnapshot(snapshotFromMessage(message))
              return
            }
            if (message.type === 'stream') {
              setStreamMode(message.mode === 'screencast' || message.mode === 'poll' ? message.mode : undefined)
              return
            }
            if (message.type === 'human-request') {
              setHuman(message.request ?? undefined)
              return
            }
            if (message.type === 'human-done' || message.type === 'human-timeout') {
              setHuman((current) => (current !== undefined && current.id === message.id ? undefined : current))
              return
            }
            if (message.type === 'error') {
              setFailure(String(message.message ?? 'failed'))
              return
            }
            if (message.type === 'browser-stopped') {
              setFailure(undefined)
              setHasFrame(false)
            }
            // `sessions` overview messages belong to the sidebar panel, not here.
          }
        }
        connect()
        return () => {
          disposed = true
          clearTimer()
          const socket = socketRef.current
          socketRef.current = null
          if (socket !== null) {
            try {
              if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'blur' }))
            } catch {
              /* the socket may already be gone */
            }
            try {
              socket.close()
            } catch {
              /* already closed */
            }
          }
          setConnection('idle')
        }
      }, [sessionId, open, visible, applySnapshot, paint])

      /**
       * State poll for everything the socket cannot tell us yet: whether this
       * session has a tab at all, and what it shows while the socket is down
       * (reconnecting, or the host restarted). It stays out of the way while the
       * socket is live, which pushes state itself.
       */
      useEffect(() => {
        if (sessionId === '') return undefined
        let cancelled = false
        const tick = async () => {
          const socket = socketRef.current
          if (socket !== null && socket.readyState === 1) return
          try {
            const payload = await requestJson(`${STATE_PATH}?session=${encodeURIComponent(sessionId)}`)
            if (cancelled) return
            applySnapshot(snapshotFromState(payload))
          } catch {
            /* the GUI may be reloading; the next tick recovers */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), STATE_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, applySnapshot])

      /**
       * The wheel must reach the page instead of scrolling the GUI behind the
       * canvas. React registers `wheel` passively at its root, where
       * `preventDefault()` is a no-op, so this one listener is attached natively.
       */
      useEffect(() => {
        if (open !== true) return undefined
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.addEventListener !== 'function') return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const point = toPageCoords(event)
          send({ type: 'input', kind: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [open, send, sessionId])

      // Focus the keyboard sink as soon as a picture exists, so typing works
      // without an extra click (a click also focuses it — see onPointerDown).
      useEffect(() => {
        if (open !== true) return undefined
        const timer = setTimeout(() => sinkRef.current?.focus?.(), 120)
        return () => clearTimeout(timer)
      }, [open])

      /** A human arriving (or leaving) the page changes whether we want frames. */
      useEffect(() => {
        if (sessionId === '') return undefined
        const onVisibility = () => {
          const socket = socketRef.current
          if (socket === null || socket.readyState !== 1) return
          if (document.visibilityState === 'hidden') socket.send(JSON.stringify({ type: 'blur' }))
          else {
            socket.send(JSON.stringify({ type: 'focus' }))
            socket.send(JSON.stringify({ type: 'play' }))
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [sessionId])

      /**
       * Answer a takeover request: over the socket when it is open, otherwise over
       * the HTTP endpoint, so a request can still be settled while the picture is
       * reconnecting.
       */
      const sendOrPost = (message, body) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) {
          socket.send(JSON.stringify(message))
          return
        }
        void requestJson(DONE_PATH, { method: 'POST', body }).catch(() => {})
      }

      /** 「我已完成」: settle the pending request without a reply. */
      const finishHuman = () => {
        const requestId = human?.id
        if (requestId === undefined) return
        sendOrPost({ type: 'human-done', requestId }, { id: requestId })
        setHuman(undefined)
      }

      /** Reply: settles the request with a note the waiting tool call receives. */
      const submitReply = () => {
        const requestId = human?.id
        const text = reply.trim()
        if (requestId === undefined || text === '') return
        sendOrPost({ type: 'human-reply', requestId, text }, { id: requestId, text })
        setReply('')
        setHuman(undefined)
      }

      /** Empty state: open this session's tab, then let the socket take over. */
      const openBrowser = async () => {
        if (sessionId === '') return
        setBusy(true)
        try {
          const payload = await requestJson(OPEN_PATH, { method: 'POST', body: { sessionId } })
          applySnapshot(snapshotFromState(payload))
          setFailure(undefined)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      /** Toolbar close: discards the page, so it always asks first. */
      const closeTab = async () => {
        if (sessionId === '') return
        if (typeof window.confirm === 'function' && !window.confirm(dict.closeTabConfirm)) return
        setBusy(true)
        try {
          await requestJson(CLOSE_PATH, { method: 'POST', body: { sessionId } })
          setHasFrame(false)
          setFailure(undefined)
          applySnapshot({ open: false, running: status.running !== false, url: null, title: null, human: null, stream: null })
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const onPointerDown = (event) => {
        sinkRef.current?.focus?.()
        canvasRef.current?.setPointerCapture?.(event.pointerId)
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'down', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      }
      const onPointerUp = (event) => {
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'up', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      }
      const onPointerMove = (event) => {
        const now = Date.now()
        if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return
        lastMoveRef.current = now
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'move', x: point.x, y: point.y })
      }
      const onKeyDown = (event) => {
        const special = SPECIAL_KEYS[event.key]
        if (special !== undefined) {
          event.preventDefault()
          send({
            type: 'input',
            kind: 'key',
            event: 'down',
            key: special.key,
            code: special.code,
            keyCode: special.keyCode,
            text: special.text,
            modifiers: modifiersOf(event),
          })
          return
        }
        // Everything else is typed: the sink's input event carries the glyph,
        // and IME composition arrives through compositionend.
      }
      const onKeyUp = (event) => {
        const special = SPECIAL_KEYS[event.key]
        if (special === undefined) return
        send({
          type: 'input',
          kind: 'key',
          event: 'up',
          key: special.key,
          code: special.code,
          keyCode: special.keyCode,
          modifiers: modifiersOf(event),
        })
      }
      const onInput = (event) => {
        const text = event.target.value
        event.target.value = ''
        if (text !== '') send({ type: 'input', kind: 'text', text })
      }
      const onCompositionEnd = (event) => {
        const text = event.data
        if (typeof text === 'string' && text !== '') send({ type: 'input', kind: 'text', text })
      }
      const onPaste = (event) => {
        const text = event.clipboardData?.getData?.('text') ?? ''
        if (text !== '') {
          event.preventDefault()
          send({ type: 'input', kind: 'text', text })
        }
      }

      if (sessionId === '') {
        return h('div', { 'data-dsh-embedded-browser': '' }, h('div', { className: 'deb-notice' }, dict.noSession))
      }

      const url = typeof status.url === 'string' ? status.url : ''
      const title = typeof status.title === 'string' ? status.title : ''
      const running = status.running !== false
      const live = connection === 'live'
      const canType = live && open === true
      const dotState = open === true && live ? (running ? 'online' : 'offline') : connection === 'offline' ? 'offline' : ''
      // The status line carries the connection state; the downgrade to polled
      // stills only shows up as a subtle note, because it never blocks input.
      const barNote =
        open !== true
          ? ''
          : live
            ? streamMode === 'poll'
              ? dict.pollHint
              : dict.connected
            : connection === 'offline'
              ? dict.offline
              : dict.connecting
      // Typing/pointer help only makes sense once there is a picture to act on.
      const hint = open === true ? (live ? dict.instructions : barNote) : ''

      return h(
        'div',
        { 'data-dsh-embedded-browser': '' },
        h(
          'div',
          { className: 'deb-bar' },
          h('span', { className: 'deb-dot', 'data-state': dotState }),
          h('span', { className: 'deb-title', title: title !== '' ? title : dict.title }, title !== '' ? title : dict.title),
          h('span', { className: 'deb-url', title: url }, url),
          barNote !== '' ? h('span', { className: 'deb-note' }, barNote) : null,
        ),
        open === true
          ? h(
              'div',
              { className: 'deb-tools' },
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.back, onClick: () => send({ type: 'nav', action: 'back' }) }, '←'),
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.forward, onClick: () => send({ type: 'nav', action: 'forward' }) }, '→'),
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.reload, onClick: () => send({ type: 'nav', action: 'reload' }) }, '⟳'),
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.refresh, onClick: () => send({ type: 'play' }) }, '❐'),
              h('span', { className: 'deb-spacer' }),
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.tab, onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }) }, '⇥ Tab'),
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.shiftTab, onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }, ['shift']) }, '⇤ ⇧Tab'),
              h('button', { type: 'button', className: 'deb-btn', disabled: !canType, title: dict.enter, onClick: () => pressKey({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }) }, '⏎ Enter'),
              h('span', { className: 'deb-spacer' }),
              h('button', { type: 'button', className: 'deb-btn deb-danger', disabled: busy, title: dict.closeTabTitle, onClick: () => void closeTab() }, dict.closeTab),
            )
          : null,
        human !== undefined
          ? h(
              'div',
              { className: 'deb-banner' },
              h('strong', null, `${dict.humanTitle}：`),
              h('span', { className: 'deb-grow' }, human.instruction),
              h('input', {
                className: 'deb-reply',
                value: reply,
                placeholder: dict.replyPlaceholder,
                onChange: (event) => setReply(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  submitReply()
                },
              }),
              h('button', { type: 'button', className: 'deb-primary', disabled: reply.trim() === '', onClick: submitReply }, dict.reply),
              h('button', { type: 'button', className: 'deb-primary', title: dict.humanHint, onClick: finishHuman }, dict.humanDone),
            )
          : null,
        h(
          'div',
          { className: 'deb-stage' },
          open === true
            ? h('canvas', {
                ref: canvasRef,
                className: 'deb-canvas',
                tabIndex: 0,
                onPointerDown,
                onPointerUp,
                onPointerMove,
                onFocus: () => sinkRef.current?.focus?.(),
              })
            : null,
          open === true
            ? h('textarea', {
                ref: sinkRef,
                className: 'deb-sink',
                'aria-label': 'browser panel keyboard sink',
                onInput,
                onKeyDown,
                onKeyUp,
                onCompositionEnd,
                onPaste,
              })
            : null,
          open === true && failure !== undefined ? h('div', { className: 'deb-overlay' }, `${dict.failed}：${failure}`) : null,
          open === true && failure === undefined && running === false ? h('div', { className: 'deb-overlay' }, dict.stopped) : null,
          open === true && failure === undefined && running && !hasFrame && live ? h('div', { className: 'deb-overlay' }, dict.waitingFrame) : null,
          open === undefined ? h('div', { className: 'deb-empty' }, h('div', { className: 'deb-empty-note' }, dict.checking)) : null,
          open === false
            ? h(
                'div',
                { className: 'deb-empty' },
                h('div', { className: 'deb-empty-title' }, dict.empty),
                h('div', { className: 'deb-empty-note' }, dict.emptyHint),
                h('button', { type: 'button', className: 'deb-primary', disabled: busy, onClick: () => void openBrowser() }, busy ? dict.starting : dict.open),
                failure !== undefined ? h('div', { className: 'deb-empty-error' }, `${dict.openFailed}：${failure}`) : null,
              )
            : null,
          hint !== '' ? h('div', { className: 'deb-hint' }, hint) : null,
        ),
      )
    }

    /**
     * The tab chip: the glyph the type is recognised by, plus a dot while the
     * session it belongs to is waiting for a person.
     *
     * The chip is the discovery path for a request raised while the human is
     * looking at something else, so it polls on its own instead of reading the
     * body's state — a body is not even mounted while its tab is inactive.
     */
    function BrowserTabTitle(props) {
      const { dict, sessionId } = props
      const [waiting, setWaiting] = useState(false)
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const payload = await requestJson(SESSIONS_PATH)
            if (cancelled) return
            const pending = Array.isArray(payload?.pending) ? payload.pending : []
            setWaiting(pending.some((request) => request?.sessionId === sessionId))
          } catch {
            /* cosmetic badge: a failed poll keeps the last known value */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), TITLE_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId])
      return h(
        'span',
        { className: 'deb-tab-title' },
        h(BrowserIcon, { size: 14 }),
        h('span', { className: 'deb-tab-text' }, dict.title),
        waiting ? h('span', { className: 'deb-tab-dot', title: dict.pending }) : null,
      )
    }

    /** Guide-page glyph: the same mark, at the size that page asks for. */
    function GuideIcon(props) {
      return h(BrowserIcon, { size: props?.size ?? 16 })
    }

    /**
     * Open this plugin's tab by itself, the moment there is something to show.
     *
     * Nothing is pinned per session any more, so this watcher is the *only*
     * reason the tab appears. Two reasons count:
     *
     * - the session has a browser tab at all (the AI started driving one), once
     *   per stretch of "this session has a browser" — a human who closes the tab
     *   is obeyed until the browser itself comes back;
     * - a **new** hand-over request landed for this session, which reopens the
     *   tab even if the human closed it before: a request nobody can see is a
     *   request that hangs until it times out.
     *
     * It polls the **host-wide** state, because "does this session have a
     * browser" is exactly what a closed tab cannot tell us — but it only ever
     * acts on the session currently on screen. Opening into a session nobody is
     * looking at would move the Sidebar out from under whatever the human is
     * actually doing, and the chip's dot already covers discovery for the
     * sessions they switch to.
     *
     * @param ctx - client context; `sessions` and `sidebarRight` are optional.
     * @returns a disposer removing the poll and its subscription.
     */
    function watchSessions(ctx) {
      const sessions = ctx.get('sessions')
      const sidebar = ctx.get('sidebarRight')
      // `ctx.inject` already waited for both; these stay as the cheap guard for
      // a Sidebar build that provides the name without the Tab-domain method.
      if (sessions === undefined || sidebar === undefined) return () => {}
      if (typeof sidebar.openTabIn !== 'function') return () => {}
      const list = sessions.list
      if (list === undefined || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return () => {}

      /** Sessions we already opened for the browser being present. */
      const openedForBrowser = new Set()
      /** Session → the hand-over request id we already opened for. */
      const openedForRequest = new Map()
      let disposed = false
      let timer

      const evaluate = async () => {
        if (disposed) return
        let payload
        try {
          payload = await requestJson(SESSIONS_PATH)
        } catch {
          return /* the GUI may be reloading; the next tick recovers */
        }
        if (disposed) return
        const current = list.getSnapshot()?.current
        if (typeof current !== 'string' || current === '') return
        const rows = Array.isArray(payload?.sessions) ? payload.sessions : []
        const pending = Array.isArray(payload?.pending) ? payload.pending : []
        if (!rows.some((row) => row?.id === current)) {
          // The browser for this session is gone: forget it, so opening one
          // again later brings the tab back on its own.
          openedForBrowser.delete(current)
          openedForRequest.delete(current)
          return
        }
        const request = pending.find((entry) => entry?.sessionId === current)
        if (request !== undefined && openedForRequest.get(current) !== request.id) {
          openedForRequest.set(current, request.id)
          openedForBrowser.add(current)
          reveal(sidebar, current)
          return
        }
        if (openedForBrowser.has(current)) return
        openedForBrowser.add(current)
        reveal(sidebar, current)
      }

      const reveal = (service, sessionId) => {
        try {
          service.openTabIn(sessionId, TAB_KIND, { revealIfOpened: true })
        } catch (error) {
          console.warn('[dsh-embedded-browser] could not open the sidebar tab:', error)
        }
      }

      const schedule = () => {
        if (disposed) return
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        clearTimeout(timer)
        timer = setTimeout(() => {
          void evaluate().finally(schedule)
        }, hidden ? REVEAL_IDLE_POLL_MS : REVEAL_POLL_MS)
      }

      const dispose = () => {
        if (disposed) return
        disposed = true
        clearTimeout(timer)
        unsubscribe?.()
      }

      const unsubscribe = list.subscribe(() => {
        // A new current session must be evaluated at once, not up to two
        // seconds later: that is exactly the moment its tab should appear.
        schedule()
      })
      void evaluate().finally(schedule)

      return () => {
        if (disposed) {
          unsubscribe()
          return
        }
        dispose()
      }
    }

    /**
     * Mount the surfaces: styles, the tab type, its two keyed seats, and the
     * watcher that opens the tab when there is something to show.
     *
     * @param ctx - the client context provided by the DSH web runtime.
     */
    function apply(ctx) {
      const dict = pickDict(typeof navigator !== 'undefined' ? navigator.language : 'en')

      // Styles: inserted once per plugin activation and removed with the fiber.
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-embedded-browser'
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(() => () => style.remove())

      // The tab type is two halves that must agree: a static definition in the
      // registry (what the type IS, and what `openTab` names) and a keyed slot
      // body under the very same id (what it looks like). A kind whose type
      // registered no body renders the owner's "nothing can view this" notice,
      // so both halves are installed together or not at all.
      //
      // **`ctx.get` is the wrong tool for a service that mounts later**, and on
      // the client half this plugin really is loaded before the Sidebar's
      // `provide()` runs even though the boot graph lists us last: reading it at
      // apply time came back `undefined` and the tab type was silently never
      // registered (found in the browser console, 2026-09-21). `ctx.inject`
      // waits for the declaration instead — the same rule the host half follows
      // for `webServer`/`connection`. A client without the Sidebar at all just
      // never runs these callbacks, which is the desired outcome: a browser-only
      // plugin must not take the workbench down with it.
      ctx.inject(['sidebarRightTabs'], (tabsCtx) =>
        tabsCtx.effect(
          () =>
            tabsCtx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => dict.title,
              guide: [
                {
                  order: 45,
                  title: () => dict.guideTitle,
                  description: () => dict.guideDescription,
                  icon: GuideIcon,
                },
              ],
            }),
          'embedded-browser: tab type',
        ),
      )

      // Slot declarations arrive with their owning plugin's fiber, which may
      // mount after this one: `slots.inject` waits for the declaration instead
      // of failing registration.
      const disposers = []
      const track = (dispose) => {
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      try {
        track(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, function Body(props) {
              const info = props.useTabInfo?.()
              return h(SessionPanel, { ...props, dict, visible: info?.tab?.visible !== false })
            }),
          ),
        )
        track(
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, (props) =>
              h(BrowserTabTitle, { ...props, dict }),
            ),
          ),
        )
      } catch (error) {
        console.warn('[dsh-embedded-browser] slot registration failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      })

      // Same rule for the watcher: it drives `sidebarRight.openTabIn` and reads
      // the `sessions` list, so it waits for both rather than deciding from an
      // apply-time snapshot that they are missing.
      ctx.inject(['sessions', 'sidebarRight'], (watchCtx) =>
        watchCtx.effect(() => watchSessions(watchCtx), 'embedded-browser: tab reveal watcher'),
      )
    }

    const exports = { apply, inject: ['slots'] }
    return exports
  },
})
