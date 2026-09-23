/**
 * dsh-embedded-browser — host half.
 *
 * Owns one Chrome instance for the whole DSH host and gives **every session its
 * own tab** in it. The AI drives its own tab through `browser_embedded_*` tools,
 * the human watches and takes over that same tab from the DSH Web UI, and the
 * whole host shares one persistent profile — so a login performed once works
 * for every session. Because the browser lives in the host, it works on a
 * machine with no display at all.
 *
 * @module dsh-embedded-browser
 */

import z from '@deepseek-ai/schemastery'
import { BrowserManager } from './browser.js'
import { HumanBroker } from './human.js'
import { ScreencastHub } from './screencast.js'
import { BASE_PATH, makeRoutes, makeUpgradeRoute } from './routes.js'
import { defineTools } from './tools.js'
import { SKILL_NAME, armLazyTools } from './lazy.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'embedded-browser'

/** Hard dependency: the tool registry. Web services are resolved optionally. */
export const inject = ['tools']

/** Version reported by the panel header and the health route. */
export const VERSION = '0.3.0'

/** Plugin configuration, overridable per row in `cordis.patch.yml`. */
export const Config = z.object({
  /** Explicit Chrome/Chromium path; empty means auto-detect. */
  browserPath: z.string().default(''),
  /** Persistent Chrome profile directory; empty means `$DSH_HOME/embedded-browser/profile`. */
  profileDir: z.string().default(''),
  /** auto = headed on a private Xvfb when available, otherwise headless. */
  mode: z.union([z.const('auto'), z.const('headed'), z.const('headless')]).default('auto'),
  /** Virtual display geometry for the private Xvfb (WxHxD). */
  screen: z.string().default('1440x900x24'),
  /** Chrome window size, used in headed mode. */
  windowSize: z.string().default('1440x900'),
  /** Emulated page viewport, also the panel canvas coordinate space. */
  viewport: z.string().default('1440x900'),
  /** Preferred X display number for the private Xvfb. */
  xvfbDisplay: z.string().default(':99'),
  /** Fixed DevTools port; 0 picks a free one. */
  port: z.number().default(0),
  /** First URL of a session's fresh tab. */
  startUrl: z.string().default('about:blank'),
  /** Extra Chrome command-line switches. */
  extraArgs: z.array(z.string()).default([]),
  /** Characters of page text returned by browser_embedded_snapshot. */
  snapshotMaxChars: z.number().default(4000),
  /** Maximum interactive elements listed per snapshot. */
  maxElements: z.number().default(80),
  /** JPEG quality of the panel picture (1-100). */
  screencastQuality: z.number().default(60),
  /** Maximum streamed frame width. */
  screencastMaxWidth: z.number().default(1440),
  /**
   * Poll interval for panels that cannot own the foreground screencast, in
   * milliseconds. Chrome streams only the active tab, so every other session is
   * served by polled screenshots.
   */
  pollFrameMs: z.number().default(140),
  /** Default budget of browser_embedded_ask_human, in seconds. */
  askHumanTimeoutSeconds: z.number().default(600),
  /**
   * Stop the browser (and every session tab) after this many idle minutes; 0
   * keeps it running. Reaping is not destructive: each session's tab is reopened
   * at its last URL on the next call, and the profile keeps every login.
   */
  idleShutdownMinutes: z.number().default(10),
  /** Start the browser together with the host, without waiting for a first call. */
  autoStart: z.boolean().default(false),
  /**
   * Publish the `browser_embedded_*` tools only after the `browser-use`
   * skill has been invoked, instead of registering them at load. The schemas are
   * billed on every request, so the default trades one extra skill read for a
   * much smaller tool list on requests that never touch a browser. Set false to
   * register the suite at load (a deployment that has no skill layer, or one
   * that wants the tools visible no matter what).
   */
  lazyTools: z.boolean().default(true),
  /** How long to wait for the DevTools endpoint after launching Chrome. */
  startTimeoutMs: z.number().default(20_000),
})

/** Parse `1440x900` into a viewport pair. */
function parseViewport(value) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(value ?? '').trim())
  if (match === null) return { width: 1440, height: 900 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * Mount the host half: browser lifecycle, panel routes, tools, prompt hint.
 *
 * @param ctx - host context carrying webserver, connection and tool services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const log = (level, message) => {
    const line = `embedded-browser: ${message}`
    try {
      const logger = ctx.logger
      if (logger !== undefined && typeof logger[level] === 'function') {
        logger[level](line)
        return
      }
    } catch {
      /* an unavailable logger service falls through to the console */
    }
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line)
  }
  const logger = {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
    debug: (message) => log('debug', message),
  }

  const viewport = parseViewport(settings.viewport ?? settings.windowSize)

  /** Declared before the broker so request events can reach connected panels. */
  let hub
  const human = new HumanBroker({
    onEvent: (event) => {
      if (hub === undefined) return
      // Session-scoped events reach that session's panel; the overview update
      // reaches everyone, so a human in another conversation still sees a badge.
      if (event.type === 'human-request') hub.broadcast({ type: 'human-request', sessionId: event.sessionId, request: event.request }, event.sessionId)
      else if (event.type === 'human-done') hub.broadcast({ type: 'human-done', sessionId: event.sessionId, id: event.id }, event.sessionId)
      else if (event.type === 'human-timeout') hub.broadcast({ type: 'human-timeout', sessionId: event.sessionId, id: event.id }, event.sessionId)
      void hub.pushState({ force: true })
    },
  })

  const manager = new BrowserManager({
    config: settings,
    logger,
    onEvent: (event) => {
      if (hub === undefined) return
      if (event.type === 'browser-stopped') {
        human.cancelAll('browser stopped')
        hub.broadcast({ type: 'browser-stopped' })
      }
      // A new session tab steals the foreground from a watching panel, and a
      // closed one may have been the stream source: let the hub re-decide.
      void hub.sync()
      void hub.pushState({ force: true })
    },
  })

  hub = new ScreencastHub({
    manager,
    logger,
    human,
    viewport,
    quality: Math.min(100, Math.max(10, settings.screencastQuality ?? 60)),
    maxWidth: settings.screencastMaxWidth ?? viewport.width,
    maxHeight: viewport.height,
    pollMs: settings.pollFrameMs ?? 140,
  })

  // A session tab must not outlive the session that owns it. `agent/disposed`
  // fires after the driver quiesced, which is exactly the point where nothing
  // can call browser_embedded_* for that session any more.
  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      const sessionId = agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (manager.session(sessionId) === undefined) return
      human.cancel(sessionId, 'session disposed')
      void manager
        .closeSession(sessionId, { reason: 'session disposed' })
        .then(() => hub.sync())
        .then(() => hub.pushState({ force: true }))
        .catch((error) => logger.warn(`session cleanup failed: ${error.message}`))
    },
    { global: true },
  )

  // Panel surfaces need the host webserver plus the GUI's own request guard.
  // Deployments without a Web UI (a headless CLI profile, the TUI) still get the
  // tools — they simply have no panel to mirror into.
  // `ctx.get` can miss a service that has not mounted yet, and the panel must
  // survive composition order, so the web surfaces wait for both services with
  // `ctx.inject` (the same pattern the shipped API gateway uses).
  let panelAvailable = false
  logger.info(`apply() entered (inject: tools=${ctx.get('tools') !== undefined})`)
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    panelAvailable = true
    for (const route of makeRoutes({ connection: webCtx.connection, manager, human, hub, version: VERSION })) {
      webCtx.effect(() => webCtx.webServer.register(route), `embedded-browser: ${route.path}`)
    }
    const upgrade = makeUpgradeRoute({ connection: webCtx.connection, hub })
    webCtx.effect(() => webCtx.webServer.registerUpgrade(upgrade), `embedded-browser: ${upgrade.path}`)
    logger.info(`panel surfaces mounted on ${BASE_PATH}/* (stream: ${upgrade.path})`)
  })
  const mountWatchdog = setTimeout(() => {
    if (!panelAvailable) {
      logger.warn('webServer/connection never became available — tools run without the visual panel')
    }
  }, 8000)
  mountWatchdog.unref?.()
  ctx.effect(() => () => clearTimeout(mountWatchdog), 'embedded-browser: mount watchdog')

  // Tools: the model's control surface over this session's own tab.
  // Resolved per call: optional services may mount after this plugin.
  const getAttachments = () => ctx.get('attachments')
  const registerSuite = () => {
    const disposers = defineTools({
      manager,
      human,
      hub,
      config: settings,
      getAttachments,
      logger,
      getPanelAvailable: () => panelAvailable,
    }).map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
  // The suite is either published now or armed behind the `browser-use` skill;
  // either way one effect owns it, so unloading removes exactly what this
  // activation added and nothing else.
  ctx.effect(() => {
    const dispose = settings.lazyTools === false
      ? registerSuite()
      : armLazyTools(ctx, registerSuite, { logger })
    logger.info(settings.lazyTools === false ? 'tools registered at load (lazyTools=false)' : `tools gated behind the ${SKILL_NAME} skill`)
    return dispose
  }, 'embedded-browser: tools')

  // Browser teardown belongs to this plugin's fiber: unloading must not leak Chrome.
  ctx.effect(
    () => () => {
      human.cancelAll('plugin unloading')
      void hub.close()
      void manager.stop()
    },
    'embedded-browser: browser lifetime',
  )

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'tool:embedded-browser',
          order: 109,
          text:
            'When a browser task needs a browser that lives inside this DSH host — no GUI, no human browser, works unattended — '
            + 'load the browser-use skill first: it routes browser work between this browser and the user\'s own, and invoking it '
            + 'is what publishes the browser_embedded_* tools. That gate is host-wide and stays open, so these tools may already '
            + 'be listed in a session that never read the skill — seeing them is not a substitute for the routing decision. '
            + 'Every session gets its own tab in one shared Chrome, and all sessions share a login profile, so a login performed once works everywhere. '
            + 'The human watches and takes over that tab in a right-sidebar tab that opens on demand, so when a step needs a person '
            + '(credentials, QR code, SMS/2FA code, CAPTCHA, SSO), call browser_embedded_ask_human with a clear instruction instead of guessing.',
        }),
      'embedded-browser: system prompt section',
    )
  })

  if (settings.autoStart === true) {
    void manager.ensureBrowser().catch((error) => logger.warn(`autoStart failed: ${error.message}`))
  }

  logger.info(`mounted (routes ${BASE_PATH}/*, viewport ${viewport.width}x${viewport.height}, assets from ${manager.profileDir()})`)
}

// The loader reads plugin metadata from the default-exported function, so the
// declarations above are attached to it explicitly: a bare `export default
// apply` would lose `inject` and every `ctx.tools` access would throw.
apply.inject = inject
apply.Config = Config

export default apply
