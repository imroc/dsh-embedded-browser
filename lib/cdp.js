/**
 * Minimal zero-dependency Chrome DevTools Protocol client.
 *
 * Two layers:
 * - `Cdp` owns the browser-level WebSocket (`/json/version` -> webSocketDebuggerUrl)
 *   and can attach to page targets.
 * - `Session` owns one attached target (flatten mode) and carries the page-level
 *   commands and events used by the browser manager and the screencast bridge.
 *
 * No third-party module is required: Node >= 22 ships global `fetch` and `WebSocket`.
 *
 * @module dsh-embedded-browser/cdp
 */

/** Default per-command budget; screencast capture and navigation pass their own. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Error carrying the CDP error payload so callers can branch on it. */
export class CdpError extends Error {
  constructor(method, detail) {
    super(`cdp ${method} failed: ${detail}`)
    this.name = 'CdpError'
    this.method = method
  }
}

/** One WebSocket carrying JSON-RPC frames, with pending-call bookkeeping. */
class Wire {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.closeListeners = new Set()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve()
      this.socket.onerror = () => reject(new Error(`cdp: cannot open ${url}`))
    })
    this.socket.onmessage = (event) => this.dispatch(String(event.data))
    this.socket.onclose = () => {
      this.closed = true
      for (const [, entry] of this.pending) entry.reject(new Error('cdp: connection closed'))
      this.pending.clear()
      for (const listener of this.closeListeners) listener()
    }
  }

  dispatch(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new CdpError(entry.method, JSON.stringify(message.error)))
      else entry.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    const key = message.sessionId === undefined ? message.method : `${message.sessionId}:${message.method}`
    const handlers = this.listeners.get(key)
    if (handlers === undefined) return
    for (const handler of [...handlers]) {
      try {
        handler(message.params ?? {})
      } catch {
        /* listener errors never break the wire */
      }
    }
  }

  send(method, params, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('cdp: connection is closed'))
    const id = this.nextId++
    const frame = { id, method }
    if (params !== undefined) frame.params = params
    if (sessionId !== undefined) frame.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(method, 'timeout'))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify(frame))
    })
  }

  on(method, handler, sessionId) {
    const key = sessionId === undefined ? method : `${sessionId}:${method}`
    let set = this.listeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.listeners.delete(key)
    }
  }

  onClose(handler) {
    this.closeListeners.add(handler)
    return () => this.closeListeners.delete(handler)
  }

  close() {
    this.closed = true
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

/** Browser-level CDP connection plus target attachment helpers. */
export class Cdp {
  constructor(wire) {
    this.wire = wire
    this.port = undefined
    this.version = undefined
  }

  /**
   * Connect to an already running browser's DevTools endpoint.
   * @param port - DevTools HTTP port.
   * @param options - timeout budget and version payload reuse.
   * @returns connected client.
   */
  static async connect(port, { timeoutMs = 10_000, version } = {}) {
    const info = version ?? (await fetchVersion(port, timeoutMs))
    const wire = new Wire(info.webSocketDebuggerUrl)
    await wire.ready
    const cdp = new Cdp(wire)
    cdp.port = port
    cdp.version = info
    return cdp
  }

  send(method, params, timeoutMs) {
    return this.wire.send(method, params, undefined, timeoutMs)
  }

  on(method, handler) {
    return this.wire.on(method, handler)
  }

  onClose(handler) {
    return this.wire.onClose(handler)
  }

  /** Every page target, in Chrome's own order (an "active" flag is not exposed). */
  async pages() {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`)
    const list = await response.json()
    return list.filter((entry) => entry.type === 'page')
  }

  /** Create a tab and return its attached session. */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url })
    return this.attach(targetId)
  }

  /** Attach to one target in flatten mode and return a page session. */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    return new Session(this, targetId, sessionId)
  }

  /** Attach to the newest page target, creating one when the browser has none. */
  async attachAnyPage() {
    const pages = await this.pages()
    if (pages.length === 0) return this.newPage()
    return this.attach(pages[pages.length - 1].id)
  }

  /** Bring a target to the foreground so the human's panel shows that tab. */
  async activate(targetId) {
    await this.send('Target.activateTarget', { targetId })
  }

  async closeTarget(targetId) {
    await this.send('Target.closeTarget', { targetId })
  }

  close() {
    this.wire.close()
  }
}

/** One attached target: page commands, events, and the helpers built on them. */
export class Session {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp
    this.targetId = targetId
    this.sessionId = sessionId
  }

  send(method, params, timeoutMs) {
    return this.cdp.wire.send(method, params, this.sessionId, timeoutMs)
  }

  on(method, handler) {
    return this.cdp.wire.on(method, handler, this.sessionId)
  }

  /** Resolve on the next matching event, or on timeout (`undefined`). */
  next(method, timeoutMs = 30_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(undefined)
      }, timeoutMs)
      const off = this.on(method, (params) => {
        clearTimeout(timer)
        off()
        resolve(params)
      })
    })
  }

  async enable() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable').catch(() => {})
    await this.send('Network.enable').catch(() => {})
  }

  /** Navigate and wait for the load event (best effort; SPAs settle later). */
  async navigate(url, { waitMs = 30_000 } = {}) {
    const loaded = this.next('Page.loadEventFired', waitMs)
    await this.send('Page.navigate', { url }, waitMs)
    await loaded
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeoutMs,
    )
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed'
      throw new Error(detail)
    }
    return result.result?.value
  }

  async viewport() {
    const metrics = await this.send('Page.getLayoutMetrics').catch(() => undefined)
    const visual = metrics?.cssVisualViewport ?? metrics?.visualViewport
    if (visual !== undefined) {
      return { width: Math.round(visual.clientWidth), height: Math.round(visual.clientHeight) }
    }
    const size = await this.evaluate('JSON.stringify({w:innerWidth,h:innerHeight})')
    const parsed = JSON.parse(size)
    return { width: parsed.w, height: parsed.h }
  }

  async title() {
    return this.evaluate('document.title')
  }

  close() {
    return this.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {})
  }
}

/** Read the DevTools version payload, retrying until the endpoint answers. */
export async function fetchVersion(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
      lastError = new Error(`devtools endpoint answered ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) throw new Error(`devtools endpoint on port ${port} is not ready: ${lastError?.message}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
