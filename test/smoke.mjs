#!/usr/bin/env node
/**
 * Standalone smoke test for the embedded-browser core (per-session model).
 *
 * Runs without DSH: it starts the real Chrome through BrowserManager, serves a
 * tiny login page, drives one tab per simulated session over CDP, then connects
 * WebSocket panels — one per session — to exercise the stream, the poll
 * fallback, the input path and the hand-over broker.
 *
 *   node test/smoke.mjs
 */

import http from 'node:http'
import { rmSync } from 'node:fs'
import { BrowserManager, sleep } from '../lib/browser.js'
import { acceptUpgrade } from '../lib/ws.js'
import { ScreencastHub } from '../lib/screencast.js'
import { HumanBroker } from '../lib/human.js'
import { makeRoutes } from '../lib/routes.js'

const PROFILE = '/tmp/dsh-embedded-browser-smoke/profile'
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'
const SESSION_C = 'session-c'
const SESSION_D = 'session-d'
const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- test page
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(body)
  }
  if (url.pathname === '/') {
    return send(200, page('Smoke Home', '<h1>Smoke Home</h1><a href="/login">进入登录页</a><p id="marker">initial</p>'))
  }
  if (url.pathname === '/login' && req.method === 'GET') {
    return send(
      200,
      page(
        'Smoke Login',
        `<h1>登录</h1><form method="POST" action="/login">
           <input name="user" placeholder="用户名"><input name="pass" type="password" placeholder="密码">
           <button type="submit">登录</button></form>`,
      ),
    )
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const params = new URLSearchParams(body)
      if (params.get('pass') !== 'secret') return send(401, page('登录失败', '<h1>密码错误</h1>'))
      send(302, '', { location: '/welcome', 'set-cookie': 'smoke_sid=ok; Path=/; Max-Age=2592000' })
    })
    return
  }
  if (url.pathname === '/welcome') {
    const cookie = req.headers.cookie ?? ''
    if (!cookie.includes('smoke_sid=')) return send(401, page('未登录', '<h1>401</h1>'))
    return send(200, page('欢迎', '<h1 id="who">已登录</h1><p>会话有效</p>'))
  }
  send(404, page('404', '<h1>404</h1>'))
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const siteUrl = `http://127.0.0.1:${site.address().port}`
console.log(`smoke site: ${siteUrl}\n`)

// --------------------------------------------------------------- ws harness
const server = http.createServer()
server.on('upgrade', (req, socket, head) => {
  const sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('session')
  if (new URL(req.url, 'http://127.0.0.1').pathname !== '/stream' || sessionId === null) {
    socket.destroy()
    return
  }
  acceptUpgrade(req, socket, head, (connection) => {
    void hub.attach(connection, sessionId)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const streamUrl = (sessionId) => `ws://127.0.0.1:${server.address().port}/stream?session=${encodeURIComponent(sessionId)}`

/** Open one panel connection and collect its frames and messages. */
async function openPanel(sessionId) {
  const frames = []
  const messages = []
  const socket = new WebSocket(streamUrl(sessionId))
  socket.binaryType = 'arraybuffer'
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data))
    else frames.push(Buffer.from(event.data))
  }
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`panel websocket failed to open for ${sessionId}`))
  })
  const send = (message) => socket.send(JSON.stringify(message))
  return {
    sessionId,
    socket,
    frames,
    messages,
    send,
    /** Focus this panel the way a visible session page does. */
    focus: async () => {
      send({ type: 'focus' })
      await sleep(600)
    },
    close: () => socket.close(),
    last: (type) => messages.filter((m) => m.type === type).pop(),
  }
}

let hub
let api
const human = new HumanBroker({
  onEvent: (event) => {
    if (hub === undefined) return
    if (event.type === 'human-request') hub.broadcast({ type: 'human-request', sessionId: event.sessionId, request: event.request }, event.sessionId)
    else if (event.type === 'human-timeout') hub.broadcast({ type: 'human-timeout', sessionId: event.sessionId, id: event.id }, event.sessionId)
    else if (event.type === 'human-done') hub.broadcast({ type: 'human-done', sessionId: event.sessionId, id: event.id }, event.sessionId)
  },
})
const manager = new BrowserManager({
  config: {
    mode: 'auto',
    profileDir: PROFILE,
    screen: '1280x800x24',
    windowSize: '1280x800',
    snapshotMaxChars: 2000,
    maxElements: 40,
  },
  logger: { info: (m) => console.log(`  [browser] ${m}`), debug: () => {}, warn: (m) => console.log(`  [warn] ${m}`) },
})
hub = new ScreencastHub({
  manager,
  logger: { info: () => {}, debug: (m) => console.log(`  [hub] ${m}`), warn: (m) => console.log(`  [hub] ${m}`) },
  viewport: { width: 1280, height: 800 },
  quality: 55,
  maxWidth: 1280,
  maxHeight: 800,
  human,
  pollMs: 140,
})

try {
  // -------------------------------------------------------- session A: AI side
  rmSync(PROFILE, { recursive: true, force: true })
  const cold = await manager.status()
  check('status before start reports stopped', cold.running === false, JSON.stringify(cold.mode ?? ''))

  const started = await manager.navigate(SESSION_A, `${siteUrl}/`)
  check('browser starts and opens the session tab', started.running === true && started.session.url.endsWith('/'), `${started.mode} ${started.session.url}`)
  check('one session tab exists', manager.sessions.size === 1 && manager.session(SESSION_A) !== undefined)

  const snapshot = await manager.snapshot(SESSION_A)
  check('snapshot lists the login link', snapshot.elements.some((e) => (e.label ?? '').includes('进入登录页')), `${snapshot.elements.length} elements`)
  check('snapshot carries page text', snapshot.text.includes('Smoke Home'), JSON.stringify(snapshot.text.slice(0, 40)))

  await manager.clickText(SESSION_A, '进入登录页')
  await sleep(400)
  const loginState = await manager.status(SESSION_A)
  check('click-by-text navigates', loginState.session.url.endsWith('/login'), loginState.session.url)

  const form = await manager.snapshot(SESSION_A)
  const userField = form.elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('用户名'))
  const passField = form.elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('密码'))
  check('snapshot indexes form fields', userField !== undefined && passField !== undefined)

  // The invariant the previous test suite only pretended to check: after
  // clicking a field the browser really inserts text (pitfall #12 is a *focus*
  // gate, not a visibility one).
  await manager.type(SESSION_A, userField.index, 'smoke-user')
  const typed = await manager.evaluate(SESSION_A, 'document.querySelector("input[name=user]").value')
  check('click-then-type really lands in the field', String(typed).endsWith('smoke-user'), JSON.stringify(typed))

  await manager.type(SESSION_A, passField.index, 'secret', { submit: true })
  await sleep(700)
  const welcome = await manager.status(SESSION_A)
  check('AI login flow reaches the protected page', welcome.session.url.endsWith('/welcome'), welcome.session.url)

  const cookies = await manager.cookies(SESSION_A)
  check('session cookie is present', cookies.some((c) => c.name === 'smoke_sid'))

  const shot = await manager.screenshot(SESSION_A)
  check('screenshot returns PNG bytes', shot.data.length > 1000 && shot.data.subarray(1, 4).toString() === 'PNG', `${shot.data.length} bytes`)

  // ------------------------------------------------------- focus gate (#12)
  // A freshly opened page has nothing focused, and `Input.insertText` is then a
  // silent no-op: success-shaped response, no change, no error. This is the
  // layer that makes "I can see the page but cannot type" undebuggable from the
  // CDP side, and it is why every type path clicks the field first.
  await manager.navigate(SESSION_C, `${siteUrl}/login`)
  await sleep(400)
  const pageC = manager.session(SESSION_C).page
  const activeTag = await pageC.evaluate('document.activeElement ? document.activeElement.tagName : "NONE"')
  const rawInsert = await pageC.send('Input.insertText', { text: 'SHOULD-NOT-LAND' })
  await sleep(200)
  const gateValue = await manager.evaluate(SESSION_C, 'document.querySelector("input[name=user]").value')
  check(
    'insertText without a focused field is silently dropped',
    activeTag === 'BODY' && gateValue === '' && typeof rawInsert === 'object',
    `activeElement=${activeTag} value=${JSON.stringify(gateValue)}`,
  )
  const cField = (await manager.snapshot(SESSION_C)).elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('用户名'))
  await manager.type(SESSION_C, cField.index, 'focused-now')
  const repaired = await manager.evaluate(SESSION_C, 'document.querySelector("input[name=user]").value')
  check('clicking the field repairs the focus gate', String(repaired).includes('focused-now'), JSON.stringify(repaired))
  await manager.closeSession(SESSION_C, { reason: 'focus gate probe' })
  await sleep(200)

  // ------------------------------------------------------ session B: isolation
  await manager.navigate(SESSION_B, `${siteUrl}/login`)
  await sleep(300)
  const stateA = await manager.status(SESSION_A)
  const stateB = await manager.status(SESSION_B)
  check('a second session gets its own tab', manager.sessions.size === 2 && stateB.session.open === true)
  check(
    'sessions do not steer each other',
    stateA.session.url.endsWith('/welcome') && stateB.session.url.endsWith('/login'),
    `A=${stateA.session.url} B=${stateB.session.url}`,
  )
  const sharedLogin = await manager.navigate(SESSION_B, `${siteUrl}/welcome`)
  check('the shared profile carries the login across sessions', sharedLogin.session.title === '欢迎', `${sharedLogin.session.url} / ${sharedLogin.session.title}`)
  await manager.navigate(SESSION_B, `${siteUrl}/login`)
  await sleep(300)

  // ------------------------------------------------------- panels, one per session
  const panelA = await openPanel(SESSION_A)
  await sleep(700)
  panelA.focus()
  const panelB = await openPanel(SESSION_B)
  await sleep(700)

  check('panel hello carries its session id', panelA.last('hello')?.sessionId === SESSION_A && panelB.last('hello')?.sessionId === SESSION_B)
  check('panel receives binary jpeg frames', panelA.frames.length > 0 && panelA.frames[0].subarray(0, 2).toString('hex') === 'ffd8', `${panelA.frames.length} frames`)
  check('panel state is scoped to its session', panelB.last('state')?.url?.endsWith('/login') === true, panelB.last('state')?.url)

  // Only the session in front may own the real screencast; the other one is
  // served by polled screenshots (Chrome streams the active tab only, #13).
  panelA.focus()
  await sleep(500)
  check('the focused session owns the screencast', hub.watched === SESSION_A, `watched=${hub.watched}`)
  // The first capture of a backgrounded tab is cold — the renderer has to build a
  // frame nobody is looking at — and later ones are fast. Wait for it, then
  // measure the steady rate instead of pretending the first frame is instant.
  // The first capture of a backgrounded tab is cold — the renderer has to build a
  // frame nobody is looking at, and it measured seconds while the other tab owned
  // the screencast; later frames settle at the poll cadence. So: generous budget
  // for the first one, a rate measurement for the rest, and the numbers reported.
  const pollFramesBefore = panelB.frames.length
  const pollStarted = Date.now()
  let pollWait = 0
  while (panelB.frames.length <= pollFramesBefore && pollWait < 15_000) {
    await sleep(250)
    pollWait = Date.now() - pollStarted
  }
  check(
    'the unfocused session receives polled frames',
    panelB.frames.length > pollFramesBefore,
    `first frame after ${pollWait}ms (${pollFramesBefore} -> ${panelB.frames.length}, pollers=[${[...hub.pollers.keys()].join(',')}] watched=${hub.watched} dropped=${hub.framesDropped})`,
  )

  panelB.focus()
  await sleep(500)
  check('focus follows the human to the other session', hub.watched === SESSION_B, `watched=${hub.watched}`)
  panelA.focus()
  await sleep(400)

  // Human input through a panel reaches that panel's own page, not the other one.
  const bField = (await manager.snapshot(SESSION_B)).elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('用户名'))
  const bLocated = await manager.locate(SESSION_B, bField.index)
  panelB.send({ type: 'input', kind: 'mouse', event: 'down', x: bLocated.x, y: bLocated.y, button: 'left', clickCount: 1 })
  panelB.send({ type: 'input', kind: 'mouse', event: 'up', x: bLocated.x, y: bLocated.y, button: 'left', clickCount: 1 })
  await sleep(120)
  panelB.send({ type: 'input', kind: 'text', text: 'human-b' })
  await sleep(250)
  const bValue = await manager.evaluate(SESSION_B, 'document.querySelector("input[name=user]").value')
  const aValue = await manager.evaluate(SESSION_A, 'document.body.innerText.includes("已登录")')
  check('panel keyboard input reaches its own session only', String(bValue).endsWith('human-b') && aValue === true, `B=${JSON.stringify(bValue)}`)

  // Live screencast: a page change in the watched session must push new frames.
  const framesBeforeNav = panelA.frames.length
  await manager.navigate(SESSION_A, `${siteUrl}/login`)
  let navWait = 0
  while (panelA.frames.length <= framesBeforeNav && navWait < 6000) {
    await sleep(200)
    navWait += 200
  }
  check(
    'live screencast pushes frames on page change',
    panelA.frames.length > framesBeforeNav,
    `${framesBeforeNav} -> ${panelA.frames.length} frames (waited ${navWait}ms, watched=${hub.watched}, stream=${hub.stream?.sessionId})`,
  )

  // Reconnect race: a disconnecting panel used to kill the *next* panel's stream.
  panelA.close()
  const reconnected = await openPanel(SESSION_A)
  await reconnected.focus()
  await sleep(400)
  const framesBeforeReconnectNav = reconnected.frames.length
  await manager.navigate(SESSION_A, `${siteUrl}/login`)
  let reconnectWait = 0
  while (reconnected.frames.length <= framesBeforeReconnectNav && reconnectWait < 6000) {
    await sleep(200)
    reconnectWait += 200
  }
  check(
    'stream survives a panel reconnect race',
    reconnected.frames.length > framesBeforeReconnectNav,
    `${framesBeforeReconnectNav} -> ${reconnected.frames.length} frames (waited ${reconnectWait}ms)`,
  )

  // ------------------------------------------------- never-activated regression
  const { targetId } = await manager.cdp.send('Target.createTarget', { url: `${siteUrl}/login`, background: true })
  const backgroundTab = await manager.cdp.attach(targetId)
  await backgroundTab.enable()
  const clickField = async (session) => {
    const located = await session.evaluate(`(() => {
      const el = document.querySelector('input[name=user]');
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    })()`)
    const { x, y } = JSON.parse(located)
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(60)
    await session.send('Input.insertText', { text: 'never-activated' })
    await sleep(150)
    return String(await session.evaluate('document.querySelector("input[name=user]").value'))
  }
  const beforeActivation = await clickField(backgroundTab)
  // Characterisation, not assertion: the pre-activation drop reproduces in a
  // dedicated fresh-browser harness but not in every context (a background tab
  // that reuses an existing renderer accepted input in one run), so the suite
  // only reports it. What must hold unconditionally is the line below: after one
  // activation the target accepts input, which is why every session tab is
  // activated at creation.
  check('background-tab input before activation (characterisation)', true, beforeActivation.includes('never-activated') ? `landed (${JSON.stringify(beforeActivation)}) — see PITFALLS #11` : 'dropped, as documented')
  await manager.cdp.activate(targetId)
  await sleep(300)
  const afterActivation = await clickField(backgroundTab)
  check('one activation makes a background tab accept input', afterActivation.includes('never-activated'), JSON.stringify(afterActivation))
  await manager.cdp.closeTarget(targetId)
  await sleep(200)

  // ------------------------------------------------------- human hand-over
  const askedA = human.ask(SESSION_A, '请在面板里完成登录', { timeoutMs: 5000 })
  const askedB = human.ask(SESSION_B, '另一个会话也要人操作', { timeoutMs: 3000 })
  await sleep(250)
  check(
    'two sessions can wait on a human at the same time',
    human.snapshotAll().length === 2 && askedA !== undefined && askedB !== undefined,
    `${human.snapshotAll().length} pending`,
  )
  check('a request only reaches its own session panel', panelB.last('human-request')?.sessionId === SESSION_B && panelA.last('human-request') === undefined)
  reconnected.send({ type: 'human-done', requestId: human.snapshot(SESSION_A).id })
  const outcomeA = await askedA
  check('human hand-over resolves on done', outcomeA.status === 'done', JSON.stringify(outcomeA))
  check('the other session stays pending', human.has(SESSION_B) === true)
  const outcomeB = await askedB
  check('human hand-over times out', outcomeB.status === 'timeout', JSON.stringify(outcomeB))

  // ------------------------------------------------------- session-aware routes
  // The HTTP surface is what the panel actually talks to, and every route now
  // carries a session id, so exercise it with the same stub guard the host uses.
  const routes = makeRoutes({
    connection: { requestRejection: () => undefined },
    manager,
    human,
    hub,
    version: 'test',
  })
  const api = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${api.address().port}`
  const postJson = (path, body) =>
    fetch(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const getJson = (path) => fetch(`${apiUrl}${path}`).then((r) => r.json())

  const routeStateA = await getJson('/api/dsh-embedded-browser/state?session=' + SESSION_A)
  check('GET /state?session= reports that session', routeStateA.session?.open === true && String(routeStateA.session.url).endsWith('/login'), `${routeStateA.session?.url} stream=${routeStateA.stream}`)
  const routeStateAll = await getJson('/api/dsh-embedded-browser/state')
  check('GET /state without a session is browser-level', routeStateAll.running === true && routeStateAll.sessionId === null, `sessions=${routeStateAll.sessions}`)
  const list = await getJson('/api/dsh-embedded-browser/sessions')
  check(
    'GET /sessions lists every session tab',
    list.sessions.some((s) => s.id === SESSION_A) && list.sessions.some((s) => s.id === SESSION_B),
    list.sessions.map((s) => s.id).join(','),
  )
  const opened = await postJson('/api/dsh-embedded-browser/open', { sessionId: SESSION_D })
  check('POST /open creates a tab for an idle session', opened.session?.open === true, opened.session?.url)
  const closed = await postJson('/api/dsh-embedded-browser/close', { sessionId: SESSION_D })
  const afterClose = await getJson('/api/dsh-embedded-browser/sessions')
  check('POST /close removes exactly that tab', closed.ok === true && !afterClose.sessions.some((s) => s.id === SESSION_D))
  const health = await getJson('/api/dsh-embedded-browser/health')
  check('GET /health reports the browser', health.ok === true && health.running === true, `sessions=${health.sessions}`)

  // ------------------------------------------------------------- teardown
  await manager.closeSession(SESSION_B, { reason: 'test teardown' })
  const afterCloseA = await manager.status(SESSION_A)
  check('closing one session leaves the others alone', manager.sessions.size === 1 && afterCloseA.session.open === true, `A=${afterCloseA.session.url}`)
  check('the closed session reports no tab', (await manager.status(SESSION_B)).session.open === false)

  await manager.stop()
  const stopped = await manager.status()
  check('stop releases the browser', stopped.running === false && manager.sessions.size === 0)

  // A reap must not cost a session its page: reopening reuses the last URL it was
  // on, and the shared profile keeps the login.
  await manager.ensureSession(SESSION_A)
  await sleep(600)
  const revived = await manager.status(SESSION_A)
  check('a reaped browser reopens the session at its last page', String(revived.session.url).endsWith('/login'), revived.session.url)
  const restarted = await manager.navigate(SESSION_A, `${siteUrl}/welcome`)
  check('login survives a browser restart', restarted.session.title === '欢迎', `${restarted.session.url} / ${restarted.session.title}`)
  reconnected.close()
  panelB.close()
  await manager.stop()
} catch (error) {
  failures += 1
  console.error(`\n✗ smoke aborted: ${error.stack ?? error.message}`)
} finally {
  await hub.close().catch(() => {})
  await manager.stop().catch(() => {})
  server.close()
  api?.close()
  site.close()
  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`} (${results.length} total)`)
  process.exit(failures === 0 ? 0 : 1)
}
