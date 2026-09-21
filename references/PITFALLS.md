# Pitfalls hit while building this plugin

Every entry is a real failure observed while developing this plugin against DSH `0.1.5-rc.2` and later. They are written down because each one presents as something else entirely.

> **A note on names.** Until 0.2.0 this plugin was `dsh-browser-panel`, its tools were `browser_panel_*`, and its client half mounted as `dbp-*` under a `conversation.view` tab. Entries written before the 0.3.0 rename keep the names that were in force when the failure happened (they are marked 更名前 / "before the rename" where the old name is load-bearing); the current names are in the README.

## 1. Plugin metadata on the wrong export

**Symptom**: the plugin mounts, but every `ctx.tools.register(...)` throws `cannot get property "tools" without inject`, and boot fails with `plugin tree failed to load`.

**Cause**: the module exported `inject` / `Config` as *named* exports and a bare `export default apply`. The loader reads metadata from the default-exported function.

**Fix**:

```js
export const inject = ['tools']
export const Config = z.object({ … })
export function apply(ctx, config) { … }

apply.inject = inject      // ← the loader reads these two
apply.Config = Config
export default apply
```

## 2. `ctx.get()` at apply time misses services that mount later

**Symptom**: the WebSocket route answers `404` (the shared `/api` handler), the HTTP route answers `400` (the webserver's catch-all for a throwing handler), and the plugin's own log line never appears.

**Cause**: `const webServer = ctx.get('webServer')` ran before the webserver service existed, so `webServer === undefined` and the routes were silently skipped.

**Fix**: wait for declarations with dynamic injection — the pattern the shipped API gateway uses:

```js
ctx.inject(['webServer', 'connection'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register(route), 'label')
})
```

## 3. Reaching a service through the context proxy

**Symptom**: an HTTP route answers `400` with an empty body (the webserver turns handler errors into `400`), and nothing is logged anywhere useful.

**Cause**: the handler called `ctx.connection.requestRejection(req)` while `connection` was not in the plugin's `inject` list. Cordis throws on property access.

**Fix**: keep web services optional and pass the *service object* into route factories instead of the context.

## 4. Tool outputs that are not lossless JSON

**Symptom**: a tool call fails with a serialization error while its body clearly returned an object.

**Cause**: `{ running: false, mode: undefined, … }` — `undefined` has no JSON representation, and the tool registry validates the canonical value before rendering.

**Fix**: run every canonical return through a `JSON.parse(JSON.stringify(value ?? null))` cleaner, and prefer `null` over absent fields in status objects.

## 5. Slot registration before the slot is declared

**Symptom**: the client half runs (its `<style>` tag is in the DOM) but no sidebar entry appears. Console: `slot "sidebar.panellist" is not declared (a parent entry's children table must declare it)`.

**Cause**: `ctx.slots.register({ name: 'sidebar.panellist', … })` executed before the sidebar plugin declared that slot.

**Fix**:

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, label }, Icon))
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, Panel))
```

## 6. Module caching makes "hot reload" a lie for host code

**Symptom**: after editing a linked plugin's host file and letting the profile patch reload, behaviour does not change.

**Cause**: Cordis' cascaded loader caches module jobs; re-adding the row re-applies the plugin but not necessarily a fresh module evaluation.

**Consequence**: treat host changes as restart-requiring; treat client changes as page-refresh-requiring (and watch the served `rev`).

## 7. `ws` frames vs. a stalled reader

**Symptom**: after leaving the panel open on a busy page, frames lag by seconds.

**Cause**: queueing every JPEG frame for a slow reader.

**Fix**: the hub drops frames above a 3 MiB socket backlog instead of buffering, and always acknowledges the frame to Chrome so the screencast keeps flowing.

## 8. Killing Chrome loses the login

**Symptom**: the human logs in, the host restarts the browser, and the session is gone.

**Cause**: cookies flush on graceful shutdown; a hard kill loses the write.

**Fix**: `Browser.close` over CDP first, then wait for the process to exit, and only then `SIGKILL` as a fallback.

## 9. Repainting a static page

**Symptom**: a freshly opened panel shows a blank canvas although the browser is running.

**Cause**: `Page.startScreencast` only emits frames when the page changes.

**Fix**: seed a fresh `Page.captureScreenshot` frame on connect (and on an explicit `play` request from the toolbar).

## 10. An informational overlay that keeps eating every click

**Symptom**: the page streams in the panel and looks completely alive, but clicking an input does nothing — no console error, no failed request, nothing. Reported as "I can see the login form but I cannot click it".

**Cause**: two client-side bugs compounding. The overlay that reports `starting` / `stopped` / `empty` (`.dbp-overlay`) had no `pointer-events: none`, so it stayed a full-canvas click target sitting on top of the page; and the flag meant to unmount it once frames arrive lived in a **ref**, and a ref does not re-render — so the overlay stayed mounted forever, transparent-looking but click-blocking.

**Fix**: make every overlay click-through, and keep the first-frame gate in React state:

```js
// style — the overlay must never intercept the pointer
.dbp-overlay { … ; pointer-events: none }      // 更名前: the class prefix is `deb-` since 0.3.0

// component — a ref does not re-render, so the overlay never unmounted
const [hasFrame, setHasFrame] = useState(false)
// … in the frame painter: setHasFrame(true)
// … render gate: !hasFrame && connection === 'connected' ? overlay : null
```

**How to find it next time**: in the GUI page, evaluate `document.elementFromPoint(x, y)` at the point you clicked. It names the element actually swallowing the event, which is rarely the one you suspected.

**It is the head of a chain, not a standalone bug.** A swallowed click means nothing gains focus, and the *next* `Input.insertText` then dies silently in the focus gate (#12) — with success-shaped responses all the way down. That chain reproduces the original report verbatim ("I can see the login form but I cannot click it"), and it was reproduced on the production binary with a screenshot to prove it.

Two mapping bugs shipped in the same fix: pointer coordinates now map through the canvas' **intrinsic size** (so they stay correct even when the emulated viewport changes underneath the panel), and stopping the stream no longer clears the device-metrics override (which used to flip the page between 1439×756 and 1440×900 on every reconnect). A stale frame is still dangerous on its own: coordinates read off a frozen picture missed by ~144 px once the page had scrolled underneath (#13).

## 11. A tab that was never activated silently discards *all* injected input

> **Corrected 2026-09-14.** This entry previously claimed *"Chrome silently drops CDP-injected input in a background tab"*. A controlled experiment on the exact production binary (`chromium-1243` = Chrome for Testing 153.0.8010.12, Xvfb, no window manager) could **not** reproduce that claim, and this repo's own regression test only ever asserted that `visibilityState` returns to `visible` — it never asserted that input was lost. The claim was never true as written. What *was* measured is narrower, and is below.

**Symptom**: every `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` against a target returns success (`{}`) and nothing happens — no click, no character, no focus change, no error, on either side.

**Cause**: a target created in the background (`Target.createTarget { background: true }`) and **never activated since the browser started** has no input routing at all. Every `Input.*` call is a silent no-op, *regardless of `document.visibilityState`* — and such a page typically reports `visible`, because without a window manager Chrome's visibility signal does not come from X mapping. `Page.startScreencast` yields **zero** frames for it, while `Page.captureScreenshot` still returns a live, correct picture — so a panel can look perfectly alive while the target is deaf.

**Fix**: activate each target **once**, right after creating or attaching it (`Target.activateTarget` / `Page.bringToFront`). The repair is **permanent**: afterwards a hidden tab (`visibilityState=hidden`, `hasFocus=false`) accepts every input method normally. Do **not** poll `visibilityState` to decide whether input will land — it is not a predictor (see #12 for what actually gates typing).

**Latent, and context dependent**: the drop reproduces reliably in a dedicated harness that creates the target in a fresh browser, but **not in every context** — in the plugin's own smoke suite a background-created tab that reused an existing renderer accepted injected input in one run and dropped it in others (see `test/smoke.mjs`, where the pre-activation result is reported as a characterisation rather than asserted). Treat the *invariant* as unconditional anyway: activate every tab once at creation, so the guarantee does not depend on which renderer Chrome happened to reuse.

## 12. Text insertion is gated on renderer *focus*, not on visibility

**Symptom**: `Input.insertText` returns `{}` and the field stays empty — while `Input.dispatchKeyEvent` still delivers `keydown` to the document but types nothing. Clicking a `<button>` also leaves `document.activeElement === body` on this build.

**Cause**: `Input.insertText` is a silent no-op unless the target's renderer has a **text-accepting element focused**. This is orthogonal to visibility — measured: it drops on a *visible, focused* tab and lands on a *hidden* one.

**Fix**: click the field first (`Input.dispatchMouseEvent`), then type. And watch for the trap that makes this so hard to read: after a click that was swallowed by something else (#10) the page still flips `document.hasFocus()` to `true`, so every "obvious" focus check reports that all is well.

## 13. `Page.startScreencast` only streams the **active** tab

**Symptom**: with more than one target driven, most panels show a frozen picture (or a single stale frame) while one of them updates at full rate.

**Cause**: measured on the production binary — over 10 s the active tab produced 34 distinct frames, a hidden tab running a continuously animating page produced **1**, and a never-activated tab produced **0**. Concurrent screencasts do not help: active 34, hidden 0.

**Measured alternatives** (same run):

- **Polled `Page.captureScreenshot` works on hidden *and* never-activated targets**, at ~130–150 ms per capture (~7 fps), and the content stays fresh. This plugin already uses that call to seed a frame; a per-target poll can serve any number of panels without caring which tab is active. (CPU cost was not measured.)
- **Separate, non-overlapping windows stream live even when unfocused** (27 + 27 frames / 8 s side by side on a 2880×900 screen); a fully covered window freezes and recovers when uncovered. This needs a virtual screen larger than the window and explicit non-overlapping placement.

**Consequence for per-session designs**: "one Chrome, one tab per session, one live screencast per session" is **not viable**. Either activate the tab whose panel is actually being watched, or poll `captureScreenshot` per panel, or give each session its own window (tiled) or its own browser process. The shipped plugin does the first, with the second as the fallback for panels that do not hold the foreground.

**Serving the fallback well** (measured while building the per-session model):

- `optimizeForSpeed: true` on a **backgrounded** tab averaged **59 ms** per capture against **190 ms** with the default path (same page, same quality) — the flag is what makes polling usable at all.
- The **first** capture of a backgrounded tab is cold: measured ~2 s, and up to ~8 s in the smoke suite while another tab owned an active screencast, against ~30 ms for every capture after it. So seed a frame when a panel connects (the plugin does) and give the first polled frame a generous budget instead of assuming instant updates.
- Polling one tab does **not** slow the screencast of another down; the reverse — a live screencast on one tab stalling captures on another — is what the numbers above show.

Also measured: hidden tabs throttle `setInterval` to roughly 0.6–1 tick/s versus ~3.3 on the active tab, so anything on a shared page that depends on fast timers behaves differently once it is not the visible tab.

## 14. "Mounted" is not "on screen": a hidden sidebar tab kept the stream alive

**Symptom**: with the browser tab *open but not on screen* — the sidebar column collapsed, or the human reading a different tab in the same pane — the plugin still behaved as if somebody were watching: the session's tab stayed activated, it kept the full-rate `Page.startScreencast`, and a human watching a *different* session's tab was pushed onto the polled path (~7 fps) for no reason. Bandwidth was being spent on a picture nobody could see.

**Cause**: a docked sidebar body is **not unmounted** when its tab goes inactive or the column collapses — React keeps it mounted so switching back is instant, and only `props.useTabInfo().tab.visible` flips to `false`. The first version of the component opened its WebSocket and sent `focus` from a mount effect, because that was the contract of the *old* surface: under the per-session `conversation.view` tab (更名前), mounting **was** selection — the component only existed while its tab was the visible one. After the move to the right sidebar, "mounted" silently came to mean "every session that ever opened the tab", and the focus protocol quietly inverted.

**Fix**: drive the stream from visibility, and pass it in from the seat rather than trusting the component's own mount:

```js
// the seat: the slot gives the body its tab's live visibility
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, function Body(props) {
  const info = props.useTabInfo?.()
  return h(SessionPanel, { ...props, dict, visible: info?.tab?.visible !== false })
})

// the component: no socket, no focus request, when nobody can see it
if (sessionId === '' || open !== true || visible !== true) { setConnection('idle'); return undefined }
```

**Consequence beyond this plugin**: any surface the host can hide without unmounting (docked panes, collapsible columns, background tabs) has this trap, and it fails in the *polite* direction — nothing errors, something else just gets slower. The rule is written down as an invariant ("visibility, not mount, is the focus protocol"), and the same reasoning applies to any "open on mount" side effect.

## 15. A sidebar tab type is two halves — and registering it is not opening it

**Symptom**: the chip renders, the guide-page entry is clickable, and clicking it *does* open a pane — which then shows the owner's generic "nothing can view this" notice. No exception in the browser console, no line in the host log, no obvious broken name. It reads like a rendering bug rather than a registration mistake.

**Cause**: two separate registrations have to agree, under one string:

1. `ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, title, guide })` — the static definition of a page **type**: its title, its icon, its guide entry, and the `kind` that `openTabIn` names.
2. the **keyed seats** that draw it: `sidebar.right.pane.tab` (the body) and `sidebar.right.pane.tab.title` (the chip), both registered with `key: TAB_ID`.

The body is looked up by the type's id, so a mismatch — e.g. the type registered as `dsh-embedded-browser/panel` while the seat registers under `embedded-browser/panel` — produces a type whose body nobody registered and a body nothing can address. The host renders its placeholder rather than complaining, which is exactly why this is expensive to find: every individual name looks plausible.

**Fix**: one constant, two uses (here `TAB_ID`), and a separate constant for the kind that `openTabIn` takes; register both halves or neither. The client half also feature-checks every service, because on an older or headless client the seats simply do not exist and a browser-only plugin must not take the workbench down with it.

**And the second half of the sentence**: declaring a type opens **nothing**. The tab appears only when something calls `ctx.sidebarRight.openTabIn(sessionId, kind, { revealIfOpened: true })` — note **`kind`**, not `id`. That separation is the feature (a type can exist for a whole deployment while no session shows it), but it means "I registered the tab" and "the tab is visible" are two different bugs to look for.

## 16. A plugin reload closes an event-only lazy gate forever

**Symptom**: the lazily published tools (`browser_embedded_*`) are simply missing for the rest of the host process, even though the model successfully invoked the gating `browser-use` skill a minute earlier in the same, still-live session. Asking the model to invoke the skill again "fixes" it, which makes it look like a flaky model rather than a broken gate.

**Cause**: the gate was opened by *listening for future events* — `tools/result` for a successful `skill` call, plus `session/event` for the `/browser-use` gesture. A plugin reload (or any re-arm of the same composition) installs fresh listeners, and the invocation that opened the previous gate is in the **past**: a past event never fires again, so nothing ever opens the new gate. Every session in the process stays gated, and only an explicit new invocation can lift it.

**Fix**: an event listener is not enough — arm time must also **replay** what already happened:

```js
// the gate is host-wide, so its listeners are registered { global: true }: an
// agent-scoped listener only ever sees its own sessions, and the reveal must not
// depend on which agent happened to invoke the skill.
const global = { global: true }

// replay every live session's log when the gate is armed…
const sessions = ctx.get('sessions')
if (sessions !== undefined && typeof sessions.list === 'function') for (const session of sessions.list()) scan(session)
// …and keep replaying for sessions created later
ctx.on('session/created', (session) => scan(session), global)
```

with `scan` reading the durable log, not a cache. A matching `tool/result` whose `isError !== true` is what proves the skill call succeeded when replaying — a `tool/call` alone is not proof, because the model may have named a skill that does not exist or the call may have failed. A `skill-invocation` message (the `/browser-use` gesture) needs no pairing.

**Same trap, upstream**: Tencent/BrowserSkill issue #269 is this exact failure, and the reference implementation disabled its lazy exposure after hitting it. The lesson generalises to any gate keyed on "this happened once": **if arming it does not consult history, a reload turns it into a one-way door.**


## 17. Renaming the plugin silently throws away the logins

**Symptom**: after the 0.3.0 rename the browser starts fine but every site asks for a login again. Nothing errored, no file was deleted, and the old profile directory is still sitting on disk with its `Cookies` and `Login Data` in place.

**Cause**: the profile directory is **derived from the plugin's own name** (`join(DSH_HOME, 'embedded-browser', 'profile')`), so a rename moves the default. The new directory is simply empty, and Chrome happily creates a fresh profile in it — the old one is never read again. On a host that had been running for a while this is the same as wiping every session, including the SSO cookies the whole point of this plugin is to reuse.

**Fix**: a rename is not only strings in code — it moves a **data directory** too, and the migration has to happen before the first start of the renamed plugin:

```sh
# no Chrome may be running on it; confirm with `ps` first
mv ~/.dsh/browser-panel ~/.dsh/embedded-browser
```

Alternatively, point `profileDir` at the old directory and keep it. Either way, a release that renames the plugin must say so in its release notes: the failure is silent, and the user only notices when a site asks them to log in again. `references/RELEASING.md` lists the rename's other obligations.
