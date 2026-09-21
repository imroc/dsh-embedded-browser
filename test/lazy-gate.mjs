#!/usr/bin/env node
/**
 * Standalone tests for the lazy tool gate.
 *
 * Runs without DSH: `armLazyTools` only needs a context that can hold listeners
 * and hand back a `sessions` service, so the whole reveal contract is exercised
 * with a fake context and fabricated sessions. The interesting cases are the
 * ones a live run cannot set up on demand — a *past* invocation found after a
 * reload, and the three ways a near-miss must NOT open the gate.
 *
 *   node test/lazy-gate.mjs
 */

import { SKILL_NAME, armLazyTools } from '../lib/lazy.js'

const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** A context stub recording every listener so tests can emit through it. */
function makeContext({ sessions } = {}) {
  const listeners = new Map()
  const disposed = []
  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((entry) => entry !== handler))
      }
    },
    get(name) {
      return name === 'sessions' ? sessions : undefined
    },
  }
  return {
    ctx,
    disposed,
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args)
    },
    listenerCount(name) {
      return (listeners.get(name) ?? []).length
    },
  }
}

/** A session log that proves one successful `skill` call for `skillName`. */
function sessionWithInvocation(skillName, { failed = false } = {}) {
  return {
    id: 'session-fixture',
    events: [
      { type: 'tool/call', data: { name: 'skill', callId: 'call-1', arguments: { name: skillName } } },
      { type: 'tool/result', data: { message: { callId: 'call-1', isError: failed } } },
    ],
  }
}

/** Arm the gate over a fresh context and count how often the suite was installed. */
function arm({ sessions } = {}) {
  const harness = makeContext({ sessions })
  let opens = 0
  let teardowns = 0
  const dispose = armLazyTools(harness.ctx, () => {
    opens += 1
    return () => {
      teardowns += 1
    }
  })
  return { ...harness, dispose, opens: () => opens, teardowns: () => teardowns }
}

// ------------------------------------------------------- the gate starts closed

{
  const gate = arm()
  check('a freshly armed gate publishes nothing', gate.opens() === 0)
}

// ---------------------------------------------------- path 1: the skill tool call

{
  const gate = arm()
  gate.emit('tools/result', { name: 'skill', arguments: { name: SKILL_NAME } }, { isError: false })
  check('a successful skill call opens the gate', gate.opens() === 1)
}

{
  const gate = arm()
  // The arguments payload may still be raw JSON at the listener.
  gate.emit('tools/result', { name: 'skill', arguments: JSON.stringify({ name: SKILL_NAME }) }, { isError: false })
  check('a raw-JSON arguments payload is understood too', gate.opens() === 1)
}

{
  const gate = arm()
  gate.emit('tools/result', { name: 'skill', arguments: { name: SKILL_NAME } }, { isError: true })
  check('a failed skill call does not open the gate', gate.opens() === 0)
}

{
  const gate = arm()
  gate.emit('tools/result', { name: 'skill', arguments: { name: 'some-other-skill' } }, { isError: false })
  check('another skill does not open the gate', gate.opens() === 0)
}

{
  const gate = arm()
  gate.emit('tools/result', { name: 'read', arguments: { name: SKILL_NAME } }, { isError: false })
  check('a non-skill tool does not open the gate', gate.opens() === 0)
}

{
  const gate = arm()
  gate.emit('tools/result', { name: 'skill', arguments: { name: SKILL_NAME } }, { isError: false })
  gate.emit('tools/result', { name: 'skill', arguments: { name: SKILL_NAME } }, { isError: false })
  check('opening twice installs the suite once', gate.opens() === 1)
}

// ------------------------------------------------- path 2: the `/browser-use` gesture

{
  const gate = arm()
  gate.emit('session/event', { id: 's' }, { type: 'message', data: { source: { kind: 'skill-invocation', name: SKILL_NAME } } })
  check('a slash-command gesture opens the gate', gate.opens() === 1)
}

{
  const gate = arm()
  gate.emit('session/event', { id: 's' }, { type: 'message', data: { source: { kind: 'skill-invocation', name: 'other' } } })
  check('another slash command does not open the gate', gate.opens() === 0)
}

{
  const gate = arm()
  gate.emit('session/event', { id: 's' }, { type: 'message', data: {} })
  gate.emit('session/event', { id: 's' }, { type: 'message' })
  gate.emit('session/event', { id: 's' }, undefined)
  check('malformed session events are survived', gate.opens() === 0)
}

// ------------------------------- path 3: the reload replay (the regression that matters)

{
  // The failure this guards: a gate armed *after* the invocation only listens for
  // future events, so nothing ever opens it again in that process.
  const gate = arm({ sessions: { list: () => [sessionWithInvocation(SKILL_NAME)] } })
  check('a past successful invocation is replayed at arm time', gate.opens() === 1)
}

{
  const gate = arm({ sessions: { list: () => [sessionWithInvocation(SKILL_NAME, { failed: true })] } })
  check('a past *failed* invocation is not replayed', gate.opens() === 0)
}

{
  const gate = arm({ sessions: { list: () => [{ id: 's', events: [] }, { id: 't' }] } })
  check('sessions without events are survived', gate.opens() === 0)
}

{
  const gate = arm({ sessions: { list: () => { throw new Error('store unavailable') } } })
  check('a throwing session store does not break arming', gate.opens() === 0)
}

{
  const gate = arm()
  gate.emit('session/created', sessionWithInvocation(SKILL_NAME))
  check('a session created after arming replays its own log', gate.opens() === 1)
}

// ------------------------------------------------------------------- lifecycle

{
  const gate = arm()
  gate.dispose()
  check('disposing an unopened gate removes its listeners', gate.listenerCount('tools/result') === 0)
  gate.emit('tools/result', { name: 'skill', arguments: { name: SKILL_NAME } }, { isError: false })
  check('a disposed gate stays closed', gate.opens() === 0)
}

{
  const gate = arm()
  gate.emit('tools/result', { name: 'skill', arguments: { name: SKILL_NAME } }, { isError: false })
  gate.dispose()
  check('disposing an opened gate tears the suite down', gate.teardowns() === 1)
}

{
  const gate = arm()
  disposeTwice: {
    gate.dispose()
    gate.dispose()
  }
  check('disposing twice is harmless', gate.teardowns() === 0)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`} (${results.length} total)`)
process.exit(failures === 0 ? 0 : 1)
