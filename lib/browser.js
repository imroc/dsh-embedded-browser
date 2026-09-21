/**
 * Browser lifecycle and per-session page operations.
 *
 * One Chrome instance per DSH host process, launched against a persistent
 * `--user-data-dir` so a human login survives restarts — with **one tab per DSH
 * session**. Every session drives its own page; sessions deliberately share the
 * profile, and therefore the login state, because logging in once and using it
 * everywhere is the point of the plugin.
 *
 * Two invariants are load-bearing (both measured on the production binary, see
 * `references/PITFALLS.md` #11/#12):
 *
 * - a target must be **activated once** after creation, or it silently discards
 *   every injected input event for the rest of its life;
 * - only the **active** tab emits screencast frames, so the hub, not this class,
 *   decides which tab stays in front once a session tab exists.
 *
 * @module dsh-embedded-browser/browser
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Cdp, fetchVersion } from './cdp.js'

/** Folders searched for a Chromium-family binary, in order. */
const PATH_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'chrome',
]

/** Cache roots of the two Node browser drivers, searched when no system Chrome exists. */
const CACHE_ROOTS = [
  join(homedir(), '.cache', 'ms-playwright'),
  join(homedir(), '.cache', 'puppeteer'),
  join(homedir(), 'Library', 'Caches', 'ms-playwright'),
]

/** Keys understood by {@link BrowserManager#press}. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  EscapeSequence: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
}

/** Sleep helper. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ask the OS for a currently free TCP port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Resolve a Chromium-family executable: explicit config first, then PATH, then caches. */
export function resolveBrowserPath(configured) {
  if (configured !== undefined && configured !== '') {
    if (!existsSync(configured)) throw new Error(`browser executable not found: ${configured}`)
    return configured
  }
  for (const name of PATH_CANDIDATES) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (dir === '') continue
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const root of CACHE_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root).sort().reverse()) {
      if (!entry.startsWith('chromium') && !entry.startsWith('chrome')) continue
      for (const inner of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = join(root, entry, inner)
        if (existsSync(candidate) && !candidate.endsWith('headless_shell')) return candidate
      }
    }
  }
  throw new Error(
    'no Chrome/Chromium binary found — install google-chrome-stable, or set browserPath in the plugin config',
  )
}

/** Whether an XVFB display lock is free. */
function displayAvailable(display) {
  const number = display.replace(/^:/, '').split('.')[0]
  return !existsSync(`/tmp/.X${number}-lock`)
}

/** Find Xvfb on PATH (any directory). */
function resolveXvfb() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'Xvfb')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Owns the Chrome process, its virtual display, and one attached tab per session.
 */
export class BrowserManager {
  /**
   * @param options - resolved plugin config plus a logger and a change notifier.
   */
  constructor({ config, logger, onEvent }) {
    this.config = config
    this.logger = logger
    this.onEvent = onEvent ?? (() => {})
    this.cdp = undefined
    /** sessionId -> { id, label, page, targetId, createdAt, lastUsedAt, url, title } */
    this.sessions = new Map()
    this.chrome = undefined
    this.xvfb = undefined
    this.display = undefined
    this.port = undefined
    this.executable = undefined
    this.mode = undefined
    this.startedAt = undefined
    this.lastUsedAt = Date.now()
    this.starting = undefined
    this.stopping = false
    this.idleTimer = undefined
    /** Last page of every session seen in this process, so a browser restart can
     * reopen it instead of dropping the session back to about:blank. */
    this.lastUrls = new Map()
    /** Session whose tab the hub currently keeps in front, for `/state`. */
    this.watchedSessionId = undefined
  }

  /**
   * Everything the panel needs to render a status line.
   *
   * @param sessionId - optional session whose own page state is included.
   * @returns browser-level state, plus `session` when an id was given.
   */
  async status(sessionId) {
    const base = {
      running: this.cdp !== undefined,
      mode: this.mode ?? null,
      executable: this.executable ?? null,
      profileDir: this.profileDir(),
      port: this.port ?? null,
      display: this.display ?? null,
      startedAt: this.startedAt ?? null,
      sessions: this.sessions.size,
      watched: this.watchedSessionId ?? null,
    }
    if (sessionId === undefined) return base
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      return {
        ...base,
        session: { id: sessionId, open: false, url: null, title: null, viewport: null, watched: false, createdAt: null },
      }
    }
    let url
    let title
    let viewport
    try {
      const info = await record.page.evaluate(
        'JSON.stringify({url: location.href, title: document.title, w: innerWidth, h: innerHeight})',
      )
      const parsed = JSON.parse(info)
      url = parsed.url
      title = parsed.title
      viewport = { width: parsed.w, height: parsed.h }
      record.url = url
      record.title = title
      if (typeof url === 'string' && url !== '' && url !== 'about:blank') this.lastUrls.set(sessionId, url)
    } catch {
      /* the page may be navigating; report what we last saw */
      url = record.url
      title = record.title
    }
    return {
      ...base,
      session: {
        id: sessionId,
        open: true,
        label: record.label ?? null,
        url: url ?? null,
        title: title ?? null,
        viewport: viewport ?? null,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        watched: this.watchedSessionId === sessionId,
      },
    }
  }

  /** Every open session tab, newest first — the sidebar overview's data. */
  listSessions() {
    const entries = [...this.sessions.values()].map((record) => ({
      id: record.id,
      label: record.label ?? null,
      url: record.url ?? null,
      title: record.title ?? null,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      watched: this.watchedSessionId === record.id,
    }))
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return entries
  }

  /** Absolute path of the persistent Chrome profile. */
  profileDir() {
    const configured = this.config.profileDir
    if (configured !== undefined && configured !== '') return configured.replace(/^~(?=\/)/, homedir())
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'embedded-browser', 'profile')
  }

  /** The live record for one session, or undefined when it has no tab. */
  session(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Start (or reuse) the browser process. */
  async ensureBrowser() {
    this.lastUsedAt = Date.now()
    if (this.cdp !== undefined) return
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /**
   * The tab belonging to one session, created on first use.
   *
   * Creation activates the tab once — without it the target never receives
   * injected input (see the module header) — and records it so the hub can put
   * the foreground back where a watching human expects it.
   *
   * @param sessionId - the calling DSH session.
   * @param options - optional display label and first URL.
   * @returns the session record.
   */
  async ensureSession(sessionId, { label, url } = {}) {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      this.touch()
      return existing
    }
    await this.ensureBrowser()
    const target = url ?? this.lastUrls.get(sessionId) ?? this.config.startUrl ?? 'about:blank'
    const page = await this.cdp.newPage(target)
    try {
      await page.enable()
      await this.applyViewport(page)
      // The one activation that matters: a target that was never activated drops
      // every Input.* call for the rest of its life.
      await this.cdp.activate(page.targetId).catch(() => {})
    } catch (error) {
      await page.close().catch(() => {})
      throw error
    }
    const record = {
      id: sessionId,
      label: label ?? undefined,
      page,
      targetId: page.targetId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      url: target,
      title: undefined,
    }
    this.sessions.set(sessionId, record)
    this.touch()
    this.logger?.info?.(`session tab opened (${sessionId}${label !== undefined ? `, ${label}` : ''})`)
    this.onEvent({ type: 'session-created', sessionId })
    return record
  }

  /** Apply the emulated viewport so the panel's canvas space matches the page. */
  async applyViewport(page, viewport = this.viewportSize()) {
    await page
      .send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch(() => {})
  }

  /** Configured emulated viewport, falling back to the window size. */
  viewportSize() {
    const raw = String(this.config.viewport ?? this.config.windowSize ?? '1440x900')
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw.trim())
    if (match === null) return { width: 1440, height: 900 }
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  /** Bring one session's tab to the front (the hub does this for watched panels). */
  async activateSession(sessionId) {
    const record = this.sessions.get(sessionId)
    if (record === undefined || this.cdp === undefined) return false
    await this.cdp.activate(record.targetId).catch(() => {})
    return true
  }

  /** Remember which session the hub is streaming, so `/state` can report it. */
  setWatched(sessionId) {
    this.watchedSessionId = sessionId
  }

  /**
   * Close one session's tab and forget it.
   *
   * @param sessionId - the session to tear down.
   * @param options - reason recorded in the log and returned to callers.
   * @returns whether a tab was actually closed.
   */
  async closeSession(sessionId, { reason = 'closed' } = {}) {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return false
    this.sessions.delete(sessionId)
    if (this.watchedSessionId === sessionId) this.watchedSessionId = undefined
    await record.page.close().catch(() => {})
    await this.cdp?.closeTarget(record.targetId).catch(() => {})
    this.lastUrls.delete(sessionId)
    this.logger?.info?.(`session tab closed (${sessionId}, ${reason})`)
    this.onEvent({ type: 'session-closed', sessionId, reason })
    return true
  }

  /** Close every session tab, keeping the browser process alive. */
  async closeAllSessions(reason = 'closed') {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId, { reason }).catch(() => {})
    }
  }

  async start() {
    this.executable = resolveBrowserPath(this.config.browserPath)
    const profileDir = this.profileDir()
    mkdirSync(profileDir, { recursive: true })

    const wanted = this.config.mode ?? 'auto'
    const xvfb = resolveXvfb()
    let mode = 'headless'
    let display = process.env.DISPLAY
    if (wanted === 'auto' || wanted === 'headed') {
      if (display !== undefined && display !== '') {
        mode = 'headed'
      } else if (xvfb !== undefined) {
        const base = Number((this.config.xvfbDisplay ?? ':99').replace(/^:/, '')) || 99
        for (let offset = 0; offset < 12; offset += 1) {
          const candidate = `:${base + offset}`
          if (!displayAvailable(candidate)) continue
          await this.startXvfb(xvfb, candidate)
          display = candidate
          mode = 'headed'
          break
        }
        if (mode !== 'headed' && wanted === 'headed') throw new Error('no free X display for the headed browser')
      } else if (wanted === 'headed') {
        throw new Error('headed mode requested but neither $DISPLAY nor Xvfb is available')
      }
    }

    const port = this.config.port !== undefined && this.config.port > 0 ? this.config.port : await freePort()
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--password-store=basic',
      '--use-mock-keychain',
      '--hide-crash-restore-bubble',
      `--window-size=${(this.config.windowSize ?? '1440x900').replace('x', ',')}`,
      '--window-position=0,0',
    ]
    if (mode === 'headless') args.push('--headless=new')
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
    if (Array.isArray(this.config.extraArgs)) args.push(...this.config.extraArgs)
    // Chrome always needs at least one page target; sessions open their own.
    args.push('about:blank')

    const env = { ...process.env }
    if (mode === 'headed' && display !== undefined) env.DISPLAY = display
    this.chrome = spawn(this.executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.chrome.stdout.on('data', (chunk) => this.logger?.debug?.(`chrome: ${String(chunk).trim()}`))
    this.chrome.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') this.logger?.debug?.(`chrome: ${text}`)
    })
    this.chrome.on('exit', (code, signal) => {
      this.logger?.info?.(`chrome exited (code=${code} signal=${signal})`)
      this.cdp?.close()
      this.cdp = undefined
      this.sessions.clear()
      this.watchedSessionId = undefined
      this.chrome = undefined
      this.onEvent({ type: 'browser-stopped' })
    })

    this.port = port
    this.mode = mode
    this.display = mode === 'headed' ? display : undefined

    const version = await fetchVersion(port, this.config.startTimeoutMs ?? 20_000)
    this.cdp = await Cdp.connect(port, { version })
    this.cdp.onClose(() => {
      this.sessions.clear()
    })
    this.startedAt = Date.now()
    this.logger?.info?.(`browser ready (mode=${mode} port=${port} profile=${profileDir})`)
    this.scheduleIdleShutdown()
    this.onEvent({ type: 'browser-started' })
  }

  async startXvfb(xvfb, display) {
    const screen = this.config.screen ?? '1440x900x24'
    this.xvfb = spawn(xvfb, [display, '-screen', '0', screen, '-nolisten', 'tcp', '-noreset'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.xvfb.stderr.on('data', (chunk) => this.logger?.debug?.(`xvfb: ${String(chunk).trim()}`))
    this.xvfb.on('exit', () => {
      this.xvfb = undefined
    })
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (existsSync(`/tmp/.X${display.replace(/^:/, '')}-lock`)) {
        await sleep(150)
        return
      }
      await sleep(100)
    }
    this.logger?.warn?.(`xvfb ${display} did not report a lock file; continuing`)
  }

  /** Stop Chrome (and the private Xvfb) and drop every session tab. */
  async stop({ keepProfile = true } = {}) {
    this.stopping = true
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const records = [...this.sessions.values()]
    for (const record of records) {
      if (typeof record.url === 'string' && record.url !== '' && record.url !== 'about:blank') this.lastUrls.set(record.id, record.url)
    }
    this.sessions.clear()
    this.watchedSessionId = undefined
    for (const record of records) await record.page.close().catch(() => {})
    if (this.cdp !== undefined) {
      // Ask Chrome to exit gracefully: cookies and storage only flush on a clean
      // shutdown, and a lost flush would log the human out.
      await this.cdp.send('Browser.close', undefined, 3000).catch(() => {})
      this.cdp.close()
      this.cdp = undefined
    }
    if (this.chrome !== undefined) {
      const chrome = this.chrome
      const exited = new Promise((resolve) => chrome.once('exit', resolve))
      const timer = setTimeout(() => chrome.kill('SIGKILL'), 4000)
      await exited.catch(() => {})
      clearTimeout(timer)
      this.chrome = undefined
    }
    if (this.xvfb !== undefined) {
      this.xvfb.kill('SIGTERM')
      this.xvfb = undefined
    }
    if (!keepProfile) {
      const dir = this.profileDir()
      rmSync(dir, { recursive: true, force: true })
    }
    this.stopping = false
    this.startedAt = undefined
    this.onEvent({ type: 'browser-stopped' })
  }

  /** Restart the browser process, keeping the profile (and every login in it). */
  async restart() {
    await this.stop()
    return this.ensureBrowser()
  }

  scheduleIdleShutdown() {
    const minutes = this.config.idleShutdownMinutes ?? 0
    clearTimeout(this.idleTimer)
    if (!(minutes > 0)) return
    this.idleTimer = setTimeout(() => {
      const idleFor = Date.now() - this.lastUsedAt
      if (idleFor >= minutes * 60_000) void this.stop()
      else this.scheduleIdleShutdown()
    }, Math.min(minutes * 60_000, 5 * 60_000))
    this.idleTimer.unref?.()
  }

  /** Record activity so the idle timer does not fire mid-use. */
  touch() {
    this.lastUsedAt = Date.now()
    this.scheduleIdleShutdown()
  }

  // ---------------------------------------------------------------- page ops

  /** Resolve a session's page, creating its tab when needed. */
  async pageFor(sessionId, { label, url } = {}) {
    const record = await this.ensureSession(sessionId, { label, url })
    this.touch()
    return record.page
  }

  /** Evaluate an expression in one session's page. */
  async evaluate(sessionId, expression) {
    const page = await this.pageFor(sessionId)
    return page.evaluate(expression)
  }

  /** Navigate one session's page. */
  async navigate(sessionId, url, options) {
    const page = await this.pageFor(sessionId)
    await page.navigate(url, options)
    return this.status(sessionId)
  }

  /** Replace a session's tab with a fresh one (the old page is discarded). */
  async replaceTab(sessionId, url) {
    await this.closeSession(sessionId, { reason: 'replaced' })
    const record = await this.ensureSession(sessionId, { url })
    return this.status(record.id)
  }

  async goBack(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.evaluate('history.back()')
    await sleep(600)
    return this.status(sessionId)
  }

  async goForward(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.evaluate('history.forward()')
    await sleep(600)
    return this.status(sessionId)
  }

  async reload(sessionId) {
    const page = await this.pageFor(sessionId)
    await page.send('Page.reload')
    await sleep(600)
    return this.status(sessionId)
  }

  /** Structured page read: text plus a numbered inventory of actionable elements. */
  async snapshot(sessionId, { maxChars, maxElements } = {}) {
    const page = await this.pageFor(sessionId)
    const textLimit = maxChars ?? this.config.snapshotMaxChars ?? 4000
    const elementLimit = maxElements ?? this.config.maxElements ?? 80
    const raw = await page.evaluate(`(() => {
      const limit = ${elementLimit};
      const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable="true"],[onclick]';
      for (const stale of document.querySelectorAll('[data-dsh-bp-index]')) stale.removeAttribute('data-dsh-bp-index');
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const label = (el) => {
        const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('name') || '';
        return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 100);
      };
      const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, limit);
      elements.forEach((el, index) => el.setAttribute('data-dsh-bp-index', String(index)));
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: String(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${textLimit}),
        elements: elements.map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          label: label(el),
          value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value || '').slice(0, 100) : undefined,
          disabled: el.disabled === true ? true : undefined,
        })),
      });
    })()`)
    return JSON.parse(raw)
  }

  /** Screen-space centre of an indexed element, scrolled into view. */
  async locate(sessionId, index) {
    const page = await this.pageFor(sessionId)
    const raw = await page.evaluate(`(() => {
      const el = document.querySelector('[data-dsh-bp-index="${index}"]');
      if (!el) return JSON.stringify({ found: false });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        tag: el.tagName.toLowerCase(),
        label: String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      });
    })()`)
    const located = JSON.parse(raw)
    if (located.found !== true) throw new Error(`element #${index} is gone — call browser_embedded_snapshot again`)
    return located
  }

  /** Click one indexed element with real input events. */
  async click(sessionId, index) {
    const page = await this.pageFor(sessionId)
    const located = await this.locate(sessionId, index)
    const base = { x: located.x, y: located.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: located.x, y: located.y, buttons: 0 })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await sleep(30)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(120)
    return located
  }

  /** Click by visible text — a convenience for stable, human-readable targets. */
  async clickText(sessionId, text) {
    const snapshot = await this.snapshot(sessionId, { maxChars: 0 })
    const needle = text.trim().toLowerCase()
    const match =
      snapshot.elements.find((element) => (element.label ?? '').toLowerCase() === needle) ??
      snapshot.elements.find((element) => (element.label ?? '').toLowerCase().includes(needle))
    if (match === undefined) throw new Error(`no clickable element matching ${JSON.stringify(text)}`)
    const located = await this.click(sessionId, match.index)
    return { ...located, index: match.index }
  }

  /**
   * Focus an indexed field and insert text.
   *
   * The click is not decoration: `Input.insertText` is a silent no-op unless the
   * renderer has a focused text-accepting element (references/PITFALLS.md #12).
   */
  async type(sessionId, index, text, { submit = false } = {}) {
    const page = await this.pageFor(sessionId)
    const located = await this.locate(sessionId, index)
    const base = { x: located.x, y: located.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(60)
    if (text !== undefined && text !== '') await page.send('Input.insertText', { text })
    await sleep(60)
    if (submit) await this.press(sessionId, 'Enter')
    return { ...located, submitted: submit === true }
  }

  /** Dispatch one named key press. */
  async press(sessionId, key) {
    const page = await this.pageFor(sessionId)
    const spec = KEYS[key]
    if (spec === undefined) throw new Error(`unsupported key ${JSON.stringify(key)}; use one of ${Object.keys(KEYS).join(', ')}`)
    const common = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    }
    await page.send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, text: spec.text })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(80)
    return { key }
  }

  /** Scroll the viewport, either in whole pages or by an explicit delta. */
  async scroll(sessionId, direction, { pixels } = {}) {
    const page = await this.pageFor(sessionId)
    const viewport = await page.viewport()
    const step = pixels ?? Math.round(viewport.height * 0.85)
    const deltas = {
      down: { deltaX: 0, deltaY: step },
      up: { deltaX: 0, deltaY: -step },
      left: { deltaX: -step, deltaY: 0 },
      right: { deltaX: step, deltaY: 0 },
      top: { deltaX: 0, deltaY: -1_000_000 },
      bottom: { deltaX: 0, deltaY: 1_000_000 },
    }
    const delta = deltas[direction]
    if (delta === undefined) throw new Error(`unsupported direction ${JSON.stringify(direction)}`)
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(viewport.width / 2),
      y: Math.round(viewport.height / 2),
      ...delta,
    })
    await sleep(350)
    return this.status(sessionId)
  }

  /** PNG screenshot as raw bytes. */
  async screenshot(sessionId, { format = 'png', fullPage = false } = {}) {
    const page = await this.pageFor(sessionId)
    const result = await page.send('Page.captureScreenshot', { format, captureBeyondViewport: fullPage })
    return { data: Buffer.from(result.data, 'base64'), mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
  }

  /** Current cookies (names and domains only — values are truncated). */
  async cookies(sessionId) {
    const page = await this.pageFor(sessionId)
    const result = await page.send('Network.getAllCookies')
    return (result.cookies ?? []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      session: cookie.session,
    }))
  }
}
