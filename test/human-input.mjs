#!/usr/bin/env node
/**
 * Human-side end-to-end check: dispatch real pointer/keyboard events on the
 * browser panel's canvas inside a running DSH Web UI, then confirm in the shared
 * browser that the human's action actually reached the page.
 *
 *   1. open the DSH Web UI in a browser you can attach to and open the panel
 *   2. node test/human-input.mjs <guiDevToolsPort> <sharedBrowserDevToolsPort>
 *
 * Both ports speak CDP: the first is the browser showing the GUI, the second is
 * the browser the plugin runs (its port is in /api/dsh-embedded-browser/state).
 */
import { Cdp } from '../lib/cdp.js'

const GUI_PORT = Number(process.argv[2] ?? 0)
const SHARED_PORT = Number(process.argv[3] ?? 0)
if (GUI_PORT === 0 || SHARED_PORT === 0) {
  console.error('usage: node test/human-input.mjs <guiDevToolsPort> <sharedBrowserDevToolsPort>')
  process.exit(2)
}

/**
 * Attach to the VISIBLE page target of one DevTools port.
 *
 * The plugin guarantees its shared page is the foreground tab (a background tab
 * makes Chrome drop injected input), so the visible target *is* the shared page;
 * "the last target" would pick a stray tab.
 */
async function attach(port) {
  const cdp = await Cdp.connect(port)
  const targets = (await cdp.pages()).reverse()
  for (const target of targets) {
    const page = await cdp.attach(target.id)
    await page.enable()
    const visibility = await page.evaluate('document.visibilityState').catch(() => 'unknown')
    if (visibility === 'visible') return { cdp, page }
    await page.close()
  }
  throw new Error(`no visible page target on DevTools port ${port}`)
}

const gui = await attach(GUI_PORT)
const shared = await attach(SHARED_PORT)

// 1) Park the shared browser on the login page and read the field's viewport position.
await shared.page.navigate('http://127.0.0.1:8899/login')
const field = JSON.parse(
  await shared.page.evaluate(
    `(() => { const el = document.querySelector('input[name=user]'); const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()`,
  ),
)

// 2) The panel canvas maps the emulated viewport onto its own box.
const canvas = JSON.parse(
  await gui.page.evaluate(
    `(() => { const c = document.querySelector('[data-dsh-embedded-browser] canvas'); const r = c.getBoundingClientRect();
      return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height, cw: c.width, ch: c.height }) })()`,
  ),
)
const guiX = Math.round(canvas.left + (field.x / canvas.cw) * canvas.width)
const guiY = Math.round(canvas.top + (field.y / canvas.ch) * canvas.height)
console.log(
  `shared field @(${field.x},${field.y}) → panel canvas @(${guiX},${guiY})  ` +
    `[canvas ${canvas.width.toFixed(0)}x${canvas.height.toFixed(0)}, viewport ${canvas.cw}x${canvas.ch}]`,
)

// 3) Regression guard: the canvas must be the topmost element at the target
// point. An informational overlay without `pointer-events: none` silently eats
// every click, which is exactly how "I can see the page but cannot click it"
// happens.
const topmost = await gui.page.evaluate(
  `(() => { const el = document.elementFromPoint(${guiX}, ${guiY});
    return JSON.stringify({ tag: el?.tagName, cls: el?.className, isCanvas: el?.tagName === 'CANVAS' }) })()`,
)
const hit = JSON.parse(topmost)
if (hit.isCanvas !== true) {
  console.error(`❌ canvas is covered at (${guiX},${guiY}) by <${hit.tag}> .${hit.cls} — clicks would never reach the page`)
  process.exit(1)
}
console.log(`topmost element at (${guiX},${guiY}): <${hit.tag}> ✓`)

// 4) Real pointer events, so the panel's own handlers run (not a JS .click()).
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await gui.page.send('Input.dispatchMouseEvent', {
    type,
    x: guiX,
    y: guiY,
    button: 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: 1,
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
}
await new Promise((resolve) => setTimeout(resolve, 400))

// 5) Type: focus sits on the panel's keyboard sink, whose input event is forwarded.
await gui.page.send('Input.insertText', { text: 'human-user' })
await new Promise((resolve) => setTimeout(resolve, 600))

// 6) Verify in the shared browser.
const typed = await shared.page.evaluate(`document.querySelector('input[name=user]').value`)
const focused = await shared.page.evaluate(`document.activeElement && document.activeElement.name`)
console.log(`shared input value = ${JSON.stringify(typed)} (focused field: ${focused})`)
console.log(typed === 'human-user' ? '✅ human input in the GUI reached the container browser' : '❌ input never arrived')
process.exit(typed === 'human-user' ? 0 : 1)
