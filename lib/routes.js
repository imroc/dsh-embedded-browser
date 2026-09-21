/**
 * HTTP and WebSocket routes the DSH Web UI talks to.
 *
 * Everything mounts on the DSH host webserver's own origin, and every route runs
 * the same guard the Web UI itself uses (`connection.requestRejection`): the
 * browser panel is exactly as reachable — and exactly as protected — as the GUI
 * it lives in. No extra port, no separate token, no tunnel.
 *
 * Every route carries a **session id**: the HTTP layer cannot infer which
 * conversation a request belongs to, so the panel sends its own. `GET /state`,
 * `GET /sessions` and the `/stream` upgrade take it as a query parameter; the
 * small POST endpoints accept it in the body.
 *
 * @module dsh-embedded-browser/routes
 */

/** Base path of every route this plugin owns. */
export const BASE_PATH = '/api/dsh-embedded-browser'

/** Maximum accepted JSON body for the small control endpoints. */
const MAX_BODY_BYTES = 64 * 1024

/** Write a JSON response. */
export function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Read a small JSON request body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Read one query parameter from a route path. */
function queryParam(req, name) {
  const raw = req.url ?? ''
  const index = raw.indexOf('?')
  if (index < 0) return undefined
  const params = new URLSearchParams(raw.slice(index + 1))
  const value = params.get(name)
  return value === null || value === '' ? undefined : value
}

/**
 * Reject an unauthenticated request with the same codes the GUI uses.
 *
 * The `connection` service object is passed in rather than read from `ctx`:
 * Cordis forbids reaching a service through the context proxy unless the plugin
 * declared it in `inject`, and this plugin keeps web services optional.
 */
function rejected(connection, req, res) {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/**
 * Build the plugin's plain HTTP routes.
 *
 * @param deps - context, browser manager, human broker, screencast hub.
 * @returns webserver route objects (registered by the caller inside an effect).
 */
export function makeRoutes({ connection, manager, human, hub, version }) {
  /** Browser-level state, plus one session's own page when a session is given. */
  const stateFor = async (sessionId) => {
    const status = await manager.status(sessionId)
    const stream = sessionId === undefined
      ? undefined
      : hub.watched === sessionId ? 'screencast' : hub.pollers.has(sessionId) ? 'poll' : 'idle'
    return {
      ...status,
      version,
      sessionId: sessionId ?? null,
      stream: stream ?? null,
      human: human.snapshot(sessionId) ?? null,
      panels: sessionId === undefined ? hub.connections.size : hub.connectionsFor(sessionId).length,
      framesDropped: hub.framesDropped,
    }
  }

  return [
    {
      kind: 'exact',
      path: `${BASE_PATH}/state`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          writeJson(res, 200, await stateFor(queryParam(req, 'session')))
        } catch (error) {
          writeJson(res, 500, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/sessions`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const browser = await manager.status()
          writeJson(res, 200, {
            version,
            running: browser.running,
            mode: browser.mode,
            sessions: manager.listSessions(),
            pending: human.snapshotAll(),
            watched: hub.watched ?? null,
          })
        } catch (error) {
          writeJson(res, 500, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/open`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const sessionId = body.sessionId ?? queryParam(req, 'session')
          if (typeof sessionId !== 'string' || sessionId === '') return writeJson(res, 400, { error: 'sessionId is required' })
          await manager.ensureSession(sessionId, { label: body.label })
          await hub.pushState({ force: true })
          writeJson(res, 200, await stateFor(sessionId))
        } catch (error) {
          writeJson(res, 500, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/close`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const sessionId = body.sessionId ?? queryParam(req, 'session')
          if (typeof sessionId !== 'string' || sessionId === '') return writeJson(res, 400, { error: 'sessionId is required' })
          human.cancel(sessionId, 'session closed from the panel')
          const closed = await manager.closeSession(sessionId, { reason: 'closed from the panel' })
          await hub.sync()
          await hub.pushState({ force: true })
          writeJson(res, 200, { ok: closed, sessionId })
        } catch (error) {
          writeJson(res, 500, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/human-done`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const settled = human.done(body.id, body.text !== undefined ? { reply: String(body.text) } : {})
          await hub.pushState({ force: true })
          writeJson(res, settled ? 200 : 409, { ok: settled })
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/health`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        const status = await manager.status()
        writeJson(res, 200, {
          ok: true,
          version,
          executable: manager.executable,
          mode: manager.mode,
          running: status.running,
          sessions: status.sessions,
          profileDir: manager.profileDir(),
        })
      },
    },
  ]
}

/**
 * Build the screencast/input upgrade route.
 *
 * @param deps - context and screencast hub.
 * @returns an upgrade route object, or undefined when the optional `ws` acceptance fails.
 */
export function makeUpgradeRoute({ connection, hub }) {
  return {
    path: `${BASE_PATH}/stream`,
    handler: (req, socket) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        socket.write(
          `HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
        )
        socket.destroy()
        return
      }
      const sessionId = queryParam(req, 'session')
      if (sessionId === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      // Imported lazily so a broken upgrade never affects plugin load.
      import('./ws.js')
        .then(({ acceptUpgrade }) => {
          acceptUpgrade(req, socket, undefined, (clientConnection) => {
            void hub.attach(clientConnection, sessionId)
          })
        })
        .catch(() => socket.destroy())
    },
  }
}
