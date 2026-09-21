/**
 * Human-in-the-loop broker, one outstanding request per session.
 *
 * The AI can hand its own tab over to the person in front of the DSH Web UI —
 * logging in, scanning a QR code, answering a CAPTCHA. Requests are keyed by
 * session: two sessions can be waiting on two different humans at the same time,
 * and a panel only ever sees the request belonging to the session it renders.
 *
 * @module dsh-embedded-browser/human
 */

/** Monotonic request ids. */
let sequence = 0

/** JSON-safe projection of one pending request. */
function project(entry) {
  if (entry === undefined) return undefined
  const { id, sessionId, instruction, createdAt, timeoutMs } = entry
  return { id, sessionId, instruction, createdAt, timeoutMs, expiresAt: createdAt + timeoutMs }
}

/**
 * Tracks the outstanding human request of every session.
 */
export class HumanBroker {
  /**
   * @param options - change notifier plus the default timeout from config.
   */
  constructor({ onEvent } = {}) {
    /** sessionId -> { id, sessionId, instruction, createdAt, timeoutMs, waiter, timer } */
    this.pending = new Map()
    this.onEvent = onEvent ?? (() => {})
  }

  /**
   * Current request of one session in a JSON-safe shape.
   *
   * @param sessionId - the session to look up; omitted returns the newest request
   *   across sessions (kept for callers that do not know about sessions).
   */
  snapshot(sessionId) {
    if (sessionId !== undefined) return project(this.pending.get(sessionId))
    let newest
    for (const entry of this.pending.values()) {
      if (newest === undefined || entry.createdAt > newest.createdAt) newest = entry
    }
    return project(newest)
  }

  /** Every outstanding request, oldest first — the sidebar overview's data. */
  snapshotAll() {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt).map((entry) => project(entry))
  }

  /** Whether a session is currently waiting on a person. */
  has(sessionId) {
    return this.pending.has(sessionId)
  }

  /**
   * Ask the human of one session to act, resolving when they confirm or the
   * budget elapses.
   *
   * @param sessionId - the session whose tab the human should operate.
   * @param instruction - what to do, phrased for a person.
   * @param options - timeout budget in milliseconds.
   * @returns the outcome, including how long the human took.
   */
  ask(sessionId, instruction, { timeoutMs = 600_000 } = {}) {
    this.cancel(sessionId, 'superseded')
    const id = `human-${++sequence}`
    const createdAt = Date.now()
    const entry = { id, sessionId, instruction, createdAt, timeoutMs, waiter: undefined, timer: undefined }
    this.pending.set(sessionId, entry)
    const outcome = new Promise((resolve) => {
      entry.timer = setTimeout(() => {
        this.pending.delete(sessionId)
        this.onEvent({ type: 'human-timeout', sessionId, id })
        resolve({ status: 'timeout', waitedMs: Date.now() - createdAt })
      }, timeoutMs)
      entry.timer.unref?.()
      entry.waiter = {
        resolve: (extra) => {
          clearTimeout(entry.timer)
          resolve({ status: 'done', waitedMs: Date.now() - createdAt, ...extra })
        },
      }
    })
    this.onEvent({ type: 'human-request', sessionId, request: project(entry) })
    return outcome
  }

  /**
   * Resolve one outstanding request.
   *
   * @param id - request id from the panel; a mismatched id is ignored.
   * @param extra - optional human-supplied reply or note.
   * @returns whether a request was actually settled.
   */
  done(id, extra = {}) {
    const entry = this.find(id)
    if (entry === undefined) return false
    this.pending.delete(entry.sessionId)
    this.onEvent({ type: 'human-done', sessionId: entry.sessionId, id: entry.id })
    entry.waiter?.resolve(extra)
    return true
  }

  /** Locate a pending request by id (or the single one when id is unknown). */
  find(id) {
    if (id !== undefined) {
      for (const entry of this.pending.values()) {
        if (entry.id === id) return entry
      }
      return undefined
    }
    for (const entry of this.pending.values()) return entry
    return undefined
  }

  /**
   * Drop one session's request without a human action.
   *
   * @param sessionId - the session whose request is dropped.
   * @param reason - status reported to the waiting tool call.
   * @returns whether a request was pending.
   */
  cancel(sessionId, reason = 'cancelled') {
    const entry = this.pending.get(sessionId)
    if (entry === undefined) return false
    this.pending.delete(sessionId)
    clearTimeout(entry.timer)
    entry.waiter?.resolve({ status: reason })
    return true
  }

  /** Drop every outstanding request (plugin dispose, browser stop). */
  cancelAll(reason = 'cancelled') {
    let dropped = false
    for (const sessionId of [...this.pending.keys()]) {
      if (this.cancel(sessionId, reason)) dropped = true
    }
    return dropped
  }
}
