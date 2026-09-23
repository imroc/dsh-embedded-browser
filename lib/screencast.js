/**
 * The panel's live channel: one stream per *watched* session, input back to the
 * session the panel belongs to.
 *
 * Chrome only emits `Page.startScreencast` frames for the **active** tab
 * (`references/PITFALLS.md` #13), and a DSH host runs one Chrome for every
 * session. So this hub is the single owner of "which tab is in front": the
 * session whose panel is actually being looked at gets a real screencast, every
 * other attached session is served by polled `Page.captureScreenshot` frames,
 * and input is replayed into the panel's own session rather than into "the"
 * page. Activation is deliberately confined here — the AI never moves the
 * foreground, because every tab accepts injected input either way.
 *
 * @module dsh-embedded-browser/screencast
 */

import { sleep } from './browser.js'

/** Drop frames (rather than queue them) once a socket is this far behind. */
const MAX_BUFFERED_BYTES = 3 * 1024 * 1024

/** How often the panels are told about URL/title/session changes. */
const STATE_POLL_MS = 2500

/** A watched panel with no frame for this long counts as a stalled stream. */
const STALL_MS = 8000

/** Polled frame cadence for sessions that are not in front (~7 fps at 140 ms). */
const DEFAULT_POLL_MS = 140

/** CDP modifier bitmask values. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** Translate the panel's modifier list into the CDP bitmask. */
function modifierMask(list) {
  if (!Array.isArray(list)) return 0
  let mask = 0
  for (const name of list) mask |= MODIFIERS[name] ?? 0
  return mask
}

/**
 * Bridges every session's page to the panels that render it.
 */
export class ScreencastHub {
  /**
   * @param options - browser manager, logger, metrics config, human broker.
   */
  constructor({ manager, logger, viewport, quality, maxWidth, maxHeight, human, pollMs = DEFAULT_POLL_MS }) {
    this.manager = manager
    this.logger = logger
    this.viewport = viewport
    this.quality = quality
    this.maxWidth = maxWidth
    this.maxHeight = maxHeight
    this.human = human
    this.pollMs = Math.max(60, pollMs)
    /** Panel connections; each carries `sessionId`, `watching` and `focusedAt`. */
    this.connections = new Set()
    /** sessionId whose tab is held in front and streamed with the real screencast. */
    this.watched = undefined
    this.stream = undefined
    this.streamTask = Promise.resolve()
    /** sessionId -> { timer, busy, lastFrameAt } */
    this.pollers = new Map()
    this.stateTimer = undefined
    this.lastStates = new Map()
    this.lastOverview = undefined
    this.framesDropped = 0
    this.pollFrames = 0
    this.focusSeq = 0
  }

  /** Every panel attached to one session. */
  connectionsFor(sessionId) {
    const list = []
    for (const connection of this.connections) {
      if (connection.sessionId === sessionId) list.push(connection)
    }
    return list
  }

  /** Send one control message to every panel, or to one session's panels. */
  broadcast(message, sessionId) {
    for (const connection of this.connections) {
      if (sessionId !== undefined && connection.sessionId !== sessionId) continue
      connection.sendJson(message)
    }
  }

  /** Accept a panel connection for one session. */
  async attach(connection, sessionId) {
    connection.sessionId = sessionId
    connection.watching = false
    connection.focusedAt = 0
    this.connections.add(connection)
    connection.on('close', () => {
      this.connections.delete(connection)
      void this.sync()
    })
    connection.on('message', (message) => {
      if (message.type !== 'text') return
      let payload
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      void this.handleMessage(connection, payload).catch((error) => {
        this.logger?.debug?.(`panel message failed: ${error.message}`)
      })
    })
    const [status, browser] = await Promise.all([
      this.manager.status(sessionId),
      this.manager.status(),
    ])
    connection.sendJson({
      type: 'hello',
      sessionId,
      viewport: this.viewport,
      quality: this.quality,
      mode: status.session?.open === true ? 'poll' : 'idle',
      status,
      browser,
      human: this.human.snapshot(sessionId),
    })
    await this.seedFrame(connection)
    await this.sync()
    await this.pushState({ force: true })
  }

  /**
   * Recompute the foreground session and the poller set.
   *
   * Serialized through `streamTask`: a panel that disconnects stops its stream
   * asynchronously, and starting the next one before that finished used to kill
   * the new screencast (the reconnect race this plugin was born with).
   */
  async sync() {
    let want
    let best = -1
    for (const connection of this.connections) {
      if (connection.watching === true && connection.focusedAt > best) {
        best = connection.focusedAt
        want = connection.sessionId
      }
    }
    if (want !== this.watched) {
      this.watched = want
      this.manager.setWatched(want)
      this.streamTask = this.streamTask
        .then(async () => {
          await this.stopStream()
          if (want !== undefined) await this.startStream(want)
        })
        .catch((error) => this.logger?.warn?.(`screencast switch failed: ${error.message}`))
      await this.streamTask
    } else if (want !== undefined) {
      // A freshly created session tab steals the foreground; put it back.
      await this.manager.activateSession(want)
    }

    const needed = new Set()
    for (const connection of this.connections) {
      if (connection.sessionId !== this.watched) needed.add(connection.sessionId)
    }
    for (const sessionId of [...this.pollers.keys()]) {
      if (!needed.has(sessionId)) this.stopPoller(sessionId)
    }
    for (const sessionId of needed) {
      if (!this.pollers.has(sessionId)) this.startPoller(sessionId)
    }
    this.ensureStateTimer()
  }

  /** Start the real screencast for one session (it becomes the active tab). */
  async startStream(sessionId) {
    const record = this.manager.session(sessionId)
    if (record === undefined) {
      this.logger?.debug?.(`stream requested for ${sessionId} without a tab`)
      return
    }
    const page = record.page
    const stream = { sessionId, page, detach: [], lastFrameAt: Date.now() }
    this.stream = stream
    await this.manager.activateSession(sessionId)
    stream.detach.push(
      page.on('Page.screencastFrame', (params) => {
        void this.onFrame(params, sessionId)
      }),
      page.on('Page.frameNavigated', () => {
        void this.pushState()
      }),
    )
    await page.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.quality,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
      everyNthFrame: 1,
    })
    this.broadcast({ type: 'stream', mode: 'screencast' }, sessionId)
    this.logger?.debug?.(`screencast started (${sessionId})`)
  }

  /** Stop the active screencast, keeping the emulated viewport in place. */
  async stopStream() {
    const stream = this.stream
    if (stream === undefined) return
    this.stream = undefined
    for (const off of stream.detach) off()
    // Only the screencast stops here: clearing the emulated viewport as well
    // would flip the page between two sizes on every switch, and a panel
    // mid-mapping would then aim at the wrong coordinates.
    await stream.page.send('Page.stopScreencast').catch(() => {})
    this.logger?.debug?.(`screencast stopped (${stream.sessionId})`)
  }

  /** Fan one JPEG frame of a session to that session's panels. */
  async onFrame(params, sessionId) {
    const stream = this.stream
    if (stream === undefined || stream.sessionId !== sessionId) return
    let payload
    try {
      payload = Buffer.from(params.data, 'base64')
    } catch {
      return
    }
    stream.lastFrameAt = Date.now()
    for (const connection of this.connectionsFor(sessionId)) {
      if (connection.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.framesDropped += 1
        continue
      }
      connection.sendBinary(payload)
    }
    if (params.sessionId !== undefined) {
      await stream.page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    }
  }

  /** Poll one frame for a session that cannot own the foreground. */
  startPoller(sessionId) {
    const timer = setInterval(() => {
      void this.pollOnce(sessionId)
    }, this.pollMs)
    timer.unref?.()
    this.pollers.set(sessionId, { timer, busy: false, lastFrameAt: 0 })
    this.broadcast({ type: 'stream', mode: 'poll' }, sessionId)
  }

  stopPoller(sessionId) {
    const state = this.pollers.get(sessionId)
    if (state === undefined) return
    clearInterval(state.timer)
    this.pollers.delete(sessionId)
  }

  async pollOnce(sessionId) {
    const state = this.pollers.get(sessionId)
    if (state === undefined || state.busy) return
    const targets = this.connectionsFor(sessionId)
    if (targets.length === 0) return
    const record = this.manager.session(sessionId)
    if (record === undefined) return
    state.busy = true
    const startedAt = Date.now()
    try {
      // `optimizeForSpeed` matters here: a hidden tab is throttled, and the
      // default capture path measured ~190 ms against ~59 ms with this flag.
      const shot = await record.page.send('Page.captureScreenshot', { format: 'jpeg', quality: this.quality, optimizeForSpeed: true })
      const payload = Buffer.from(shot.data, 'base64')
      state.lastFrameAt = Date.now()
      this.pollFrames += 1
      this.logger?.debug?.(`poll frame ok (${sessionId}) in ${Date.now() - startedAt}ms, ${payload.length} bytes`)
      for (const connection of targets) {
        if (connection.bufferedAmount > MAX_BUFFERED_BYTES) {
          this.framesDropped += 1
          continue
        }
        connection.sendBinary(payload)
      }
    } catch (error) {
      this.logger?.debug?.(`poll frame failed (${sessionId}) after ${Date.now() - startedAt}ms: ${error.message}`)
    } finally {
      state.busy = false
    }
  }

  /** Keep the 2.5s state poll (and the stall watchdog) running while panels exist. */
  ensureStateTimer() {
    if (this.connections.size === 0) {
      clearInterval(this.stateTimer)
      this.stateTimer = undefined
      return
    }
    if (this.stateTimer !== undefined) return
    this.stateTimer = setInterval(() => {
      void this.pushState()
      this.checkStreamHealth()
    }, STATE_POLL_MS)
    this.stateTimer.unref?.()
  }

  /**
   * Self-heal a stalled screencast: Chrome stops emitting frames if an
   * acknowledgement is ever lost, and the panel would sit on a frozen image.
   */
  checkStreamHealth() {
    const stream = this.stream
    if (stream === undefined) return
    if (this.connectionsFor(stream.sessionId).length === 0) return
    if (Date.now() - stream.lastFrameAt < STALL_MS) return
    this.logger?.warn?.(`screencast stalled for ${stream.sessionId} — restarting`)
    const sessionId = stream.sessionId
    this.streamTask = this.streamTask
      .then(async () => {
        await this.stopStream()
        await this.startStream(sessionId)
      })
      .catch((error) => this.logger?.warn?.(`screencast restart failed: ${error.message}`))
  }

  /** Push per-session state (and the overview) to the panels that care. */
  async pushState({ force = false } = {}) {
    const sessions = new Set()
    for (const connection of this.connections) sessions.add(connection.sessionId)
    for (const sessionId of sessions) {
      const status = await this.manager.status(sessionId).catch(() => undefined)
      if (status === undefined) continue
      const next = {
        type: 'state',
        sessionId,
        running: status.running,
        mode: status.mode,
        open: status.session?.open === true,
        url: status.session?.url ?? null,
        title: status.session?.title ?? null,
        viewport: status.session?.viewport ?? null,
        stream: this.watched === sessionId ? 'screencast' : this.pollers.has(sessionId) ? 'poll' : 'idle',
        human: this.human.snapshot(sessionId) ?? null,
      }
      const previous = this.lastStates.get(sessionId)
      const changed =
        force ||
        previous === undefined ||
        previous.url !== next.url ||
        previous.title !== next.title ||
        previous.open !== next.open ||
        previous.running !== next.running ||
        // The panel maps its pointer events through this, so a resize it never
        // hears about would aim the human's clicks at the old geometry.
        previous.viewport?.width !== next.viewport?.width ||
        previous.viewport?.height !== next.viewport?.height ||
        JSON.stringify(previous.human) !== JSON.stringify(next.human) ||
        previous.stream !== next.stream
      this.lastStates.set(sessionId, next)
      if (changed) this.broadcast(next, sessionId)
    }
    const overview = {
      type: 'sessions',
      running: this.manager.cdp !== undefined,
      sessions: this.manager.listSessions(),
      pending: this.human.snapshotAll(),
      watched: this.watched ?? null,
    }
    const signature = JSON.stringify(overview)
    if (force || signature !== this.lastOverview) {
      this.lastOverview = signature
      this.broadcast(overview)
    }
  }

  /** Replay one panel message into that panel's own session. */
  async handleMessage(connection, message) {
    const sessionId = connection.sessionId
    if (message.type === 'focus') {
      connection.watching = true
      connection.focusedAt = ++this.focusSeq
      await this.sync()
      return
    }
    if (message.type === 'blur') {
      connection.watching = false
      await this.sync()
      return
    }
    if (message.type === 'human-done') {
      this.human.done(message.requestId, message.note !== undefined ? { note: message.note } : {})
      return
    }
    if (message.type === 'human-reply') {
      this.human.done(message.requestId, { reply: typeof message.text === 'string' ? message.text : '' })
      return
    }
    if (message.type === 'play') {
      await this.seedFrame(connection)
      return
    }
    if (message.type === 'open') {
      await this.manager.ensureSession(sessionId, { url: typeof message.url === 'string' ? message.url : undefined })
      await this.sync()
      await this.pushState({ force: true })
      return
    }
    if (message.type === 'close') {
      this.human.cancel(sessionId, 'session closed by the human')
      await this.manager.closeSession(sessionId, { reason: 'closed from the panel' })
      await this.sync()
      await this.pushState({ force: true })
      return
    }
    if (message.type === 'nav') {
      const action = message.action
      if (action === 'back') await this.manager.goBack(sessionId)
      else if (action === 'forward') await this.manager.goForward(sessionId)
      else if (action === 'reload') await this.manager.reload(sessionId)
      await this.pushState({ force: true })
      return
    }
    if (message.type !== 'input') return
    const record = this.manager.session(sessionId)
    if (record === undefined) return
    const page = record.page
    this.manager.touch()
    const input = message
    const mask = modifierMask(input.modifiers)
    if (input.kind === 'mouse') {
      const event = input.event
      const type = event === 'move' ? 'mouseMoved' : event === 'down' ? 'mousePressed' : 'mouseReleased'
      await page.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(input.x),
        y: Math.round(input.y),
        button: input.button ?? 'left',
        buttons: type === 'mouseReleased' || type === 'mouseMoved' ? 0 : 1,
        clickCount: input.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
        modifiers: mask,
      })
      return
    }
    if (input.kind === 'wheel') {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(input.x),
        y: Math.round(input.y),
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers: mask,
      })
      return
    }
    if (input.kind === 'text') {
      if (typeof input.text === 'string' && input.text !== '') await page.send('Input.insertText', { text: input.text })
      return
    }
    if (input.kind === 'key') {
      const down = input.event !== 'up'
      const common = {
        key: input.key,
        code: input.code ?? undefined,
        windowsVirtualKeyCode: input.keyCode ?? undefined,
        nativeVirtualKeyCode: input.keyCode ?? undefined,
        modifiers: mask,
      }
      if (down) {
        const printable = typeof input.text === 'string' && input.text !== '' && mask === 0
        await page.send('Input.dispatchKeyEvent', {
          type: printable ? 'keyDown' : 'rawKeyDown',
          ...common,
          ...(printable ? { text: input.text, unmodifiedText: input.text } : {}),
        })
      } else {
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      }
    }
  }

  /** Send one freshly captured frame to a single panel (fills a blank canvas). */
  async seedFrame(connection) {
    try {
      const record = this.manager.session(connection.sessionId)
      if (record === undefined) return
      const shot = await record.page.send('Page.captureScreenshot', { format: 'jpeg', quality: this.quality })
      connection.sendBinary(Buffer.from(shot.data, 'base64'))
    } catch (error) {
      this.logger?.debug?.(`seed frame failed: ${error.message}`)
    }
  }

  /** Stop every stream and poller, then drop the panels (plugin dispose). */
  async close() {
    for (const sessionId of [...this.pollers.keys()]) this.stopPoller(sessionId)
    clearInterval(this.stateTimer)
    this.stateTimer = undefined
    await this.streamTask.catch(() => {})
    await this.stopStream()
    for (const connection of this.connections) connection.close(1001, 'plugin unloading')
    this.connections.clear()
    await sleep(0)
  }
}
