/**
 * Lazy tool registration: the browser tools appear only after the entry skill
 * has been invoked.
 *
 * Tool schemas are billed on **every** request, while a skill's catalog entry is
 * two lines and its body is read on demand. So the ten `browser_embedded_*`
 * schemas stay unpublished until something proves the model is actually doing
 * browser work: a successful `skill` tool call naming {@link SKILL_NAME}, a
 * `/browser-use` user gesture, or a past invocation found in a session log.
 *
 * The reveal is host-wide, not per session: `ctx.tools.register` publishes into
 * one registry that every session reads, so the first session to invoke the
 * skill opens the gate for all of them. That matches the shape of the registry
 * rather than inventing a per-session tool list nothing else understands.
 *
 * Reload safety (the failure mode that made the reference implementation
 * disable this): unload/remount must not lose a gate that was already opened.
 * A plugin that only listened for future events would stay silent for the rest
 * of the process after a reload, because the invocation that opened it is in the
 * past — so {@link armLazyTools} also replays every live session's log at arm
 * time, and a session created later replays its own on `session/created`.
 *
 * @module dsh-embedded-browser/lazy
 */

/**
 * Directory name of the entry skill that gates these tools.
 *
 * `browser-use` is the routing skill: it decides between this plugin's channel
 * and the BrowserSkill channel, and only the model that read it knows the
 * browser tools exist. The name is duplicated here on purpose — the skill lives
 * in the user's skill repository, not in this package, so there is nothing to
 * import.
 */
export const SKILL_NAME = 'browser-use'

/** Every tool name the gate publishes once it opens; for diagnostics only. */
export const TOOL_PREFIX = 'browser_embedded_'

/**
 * Read the skill name out of a `skill` tool call's arguments.
 *
 * Tool arguments reach an event listener either already normalized into an
 * object or still as the raw JSON string, so both shapes are accepted.
 *
 * @param args - the call's arguments, in either shape.
 * @returns the skill name, or undefined when the payload does not name one.
 */
function skillNameOf(args) {
  if (typeof args === 'string') {
    try {
      return skillNameOf(JSON.parse(args))
    } catch {
      return undefined
    }
  }
  if (typeof args === 'object' && args !== null && 'name' in args) {
    const name = args.name
    return typeof name === 'string' ? name : undefined
  }
  return undefined
}

/**
 * Whether one session event is the `/browser-use` user gesture.
 *
 * A slash command arrives as an ordinary message whose source carries the skill
 * identity, which is what makes it a skill invocation rather than prose.
 *
 * @param data - the event payload.
 * @returns whether it invokes {@link SKILL_NAME}.
 */
function isSkillInvocationMessage(data) {
  if (typeof data !== 'object' || data === null) return false
  const source = data.source
  if (typeof source !== 'object' || source === null) return false
  return source.kind === 'skill-invocation' && source.name === SKILL_NAME
}

/**
 * Whether a durable session log already proves a successful invocation.
 *
 * A `tool/call` alone is not proof — the model may have named a skill that does
 * not exist, or the call may have failed — so the matching `tool/result` must
 * come back without an error. A slash-command message needs no pairing.
 *
 * @param events - the session's events, in log order.
 * @returns whether the skill was successfully invoked at least once.
 */
function hasSuccessfulSkillInvocation(events) {
  if (!Array.isArray(events)) return false
  const callIds = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const data = event.data
    if (data?.name === 'skill' && skillNameOf(data.arguments) === SKILL_NAME) callIds.add(data.callId)
  }
  for (const event of events) {
    if (event?.type === 'tool/result') {
      const message = event.data?.message
      if (typeof message !== 'object' || message === null) continue
      if (message.isError === false && callIds.has(message.callId)) return true
    }
    if (isSkillInvocationMessage(event?.data)) return true
  }
  return false
}

/**
 * Publish the tool suite on first proof, and keep it published.
 *
 * @param ctx - host context whose fiber owns the listeners.
 * @param registerSuite - registers every tool and returns one disposer.
 * @param deps - logger for the failure path.
 * @returns a disposer that removes the listeners and, if it opened, the suite.
 */
export function armLazyTools(ctx, registerSuite, { logger } = {}) {
  const warn = (message) => logger?.warn?.(message)
  let suiteDisposer
  const open = () => {
    if (suiteDisposer !== undefined) return
    try {
      suiteDisposer = registerSuite()
    } catch (error) {
      suiteDisposer = undefined
      warn(`lazy tool registration failed: ${error.message}`)
    }
  }

  const disposers = []

  // `tools/result` and `session/event` are scope-filtered by design (an
  // agent-scoped listener sees only its own sessions), and an untagged listener
  // is already admitted everywhere — `{ global: true }` states that on purpose
  // rather than leaning on the default. The gate is host-wide, so it must not
  // depend on which agent happened to emit.
  const global = { global: true }

  // Path 1: the model called the skill and the call succeeded.
  disposers.push(
    ctx.on(
      'tools/result',
      (exec, result) => {
        if (result?.isError === true) return
        if (exec?.name !== 'skill') return
        if (skillNameOf(exec.arguments) === SKILL_NAME) open()
      },
      global,
    ),
  )

  // Path 2: the human typed `/browser-use`.
  disposers.push(
    ctx.on(
      'session/event',
      (_session, event) => {
        if (isSkillInvocationMessage(event?.data)) open()
      },
      global,
    ),
  )

  // Replay: a reload must not lose a gate a *past* session already opened.
  const scan = (session) => {
    if (suiteDisposer !== undefined) return
    try {
      if (hasSuccessfulSkillInvocation(session?.events)) open()
    } catch (error) {
      warn(`lazy reveal scan failed: ${error.message}`)
    }
  }
  disposers.push(ctx.on('session/created', (session) => scan(session), global))

  // The replay reads the live session store, which may mount *after* this plugin
  // (`ctx.get` at apply time would then find nothing and the reload path would be
  // lost to composition order — the client half of this plugin hit exactly that
  // bug on 2026-09-21). `ctx.inject` runs the callback as soon as the service
  // exists, which is immediately when it already does. The injected fiber is a
  // child of this context, so it is disposed with the gate.
  ctx.inject(['sessions'], (sessionCtx) => {
    try {
      if (typeof sessionCtx.sessions.list !== 'function') return
      for (const session of sessionCtx.sessions.list()) scan(session)
    } catch (error) {
      warn(`lazy reveal replay failed: ${error.message}`)
    }
  })

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
    suiteDisposer?.()
  }
}
