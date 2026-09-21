# Design notes

## The model: one browser, one tab per session, one shared identity

Three shapes were on the table once the plugin had to serve more than one conversation at a time:

| Approach | Page state | Identity (cookies, logins) | Verdict |
|---|---|---|---|
| One shared page for the whole host (0.1.x) | Shared — two conversations trample each other's page | Shared | Shipped first, then removed: a browser is a *place*, and two sessions working in different places is the normal case |
| One Chrome per session | Isolated | Isolated, unless cookies are transplanted | Rejected: N browsers' worth of memory, and the login-once property dies with it — copying cookies/`storageState` is exactly the fragile thing this plugin exists to avoid |
| **One Chrome, one tab per session** | Isolated per tab | Shared — one profile | **Chosen** |

The plugin's core promise is unchanged and now precise: the session the human creates *is* the session the AI uses, and the isolation that sessions get is **page state**, not identity. Logging in once is the whole point, so the identity is deliberately shared; what a session must not share is the page it is standing on.

Per-tab isolation is only possible because of a measured property of the browser, not by assumption: a target that has been activated once accepts injected input for the rest of its life, even while it is in the background (`references/PITFALLS.md` #11). Without #11's fix, a background session's tab would be deaf and the design would collapse back into "whoever is in front is the only usable session".

## Why every tab is activated once, at creation

Measured (#11): a target created in the background and never activated since the browser started has **no input routing at all** — every `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` returns success (`{}`) and does nothing, with no error on either side, while `Page.captureScreenshot` still returns a live picture and the page reports `visible`. One `Target.activateTarget` repairs it **permanently**, after which a hidden, unfocused tab accepts every input method normally.

So `BrowserManager.ensureSession()` activates the tab the moment it creates it. What that buys is the whole design:

- the AI's tab works while the human is looking at a different session;
- therefore the AI never has to steal the foreground, and a watching human's panel keeps its full-rate stream;
- therefore the hub — not the AI — is the single owner of "which tab is in front".

Honesty about the measurement: the pre-activation drop did not reproduce in *every* context (a background tab reusing an existing renderer accepted input in one run of the suite), so `test/smoke.mjs` only *reports* the pre-activation half and *asserts* the half that must hold unconditionally — after one activation the target accepts input. The activation is cheap, so the plugin takes the safe side.

Related and orthogonal (#12): text insertion is gated on the renderer having a **text-accepting element focused**, not on visibility. That is why every typing path clicks the field first, and why the AI's `browser_embedded_type` description says the click is not decoration. Nothing about activation changes this gate.

## Why two picture paths: screencast for the watched tab, polling for the rest

Measured (#13): Chrome only emits `Page.startScreencast` frames for the **active** tab. Over 10 s the active tab produced 34 distinct frames, a hidden tab running a continuously animating page produced **1**, and a never-activated tab produced **0**; two concurrent screencasts did not help (active 34, hidden 0). `Page.captureScreenshot` polling, by contrast, works on hidden *and* never-activated targets at roughly 130–150 ms per capture (~7 fps) with fresh content, and Chrome throttles timers in hidden tabs (~0.6–1 tick/s versus ~3.3 on the active tab), so "let every session keep its own screencast" is not a viable design.

Hence the hub has exactly two paths:

- the session whose tab the human is actually looking at sends `focus`; that session is activated and owns the real `Page.startScreencast` (full frame rate, `everyNthFrame: 1`);
- every other attached session is served by a per-session poller at `pollFrameMs` (default 140 ms ≈ 7 fps), with `optimizeForSpeed: true` — the flag matters: on a backgrounded tab the default capture path measured ~190 ms against ~59 ms with it. Absolute numbers are host-dependent (on the development container the local test page polls in 20–100 ms), and what is being bought is the flag, not the coefficient.

Costs, stated plainly: a polled panel is a still-picture stream, not full motion, and its **first** frame can be cold — seconds — while another tab owns the screencast; the smoke suite budgets for that instead of pretending it is instant. Input latency is untouched by any of this, because both mouse and keyboard events go straight into the panel's own target over the same WebSocket. And a newly attached panel is always seeded with one `Page.captureScreenshot` frame, because a static page emits no frames of its own (#9).

The measured alternative — giving each session its own non-overlapping window, which _does_ stream live while unfocused — needs a virtual screen larger than the window and explicit tiling, and turns every session into a window the human has to find. It is recorded in #13 as the fallback if polled stills ever prove insufficient.

## Why the tab lives in the right sidebar, and opens on demand

The canvas must be per session, and that decides the surface. A root-scoped `main` panel has one instance for the whole host and cannot know which conversation is on screen; a `conversation.view` entry (the fixed per-session view strip) gives the component its session id, but it is **pinned**: every conversation in the workbench would carry a 浏览器 / Browser tab whether or not it ever touches a browser, and for most sessions that is pure noise next to a chat that never opens a page.

So the surface moved to the right sidebar, and nothing is pinned any more:

- **`ctx.sidebarRightTabs.register({ id, kind, title, guide })` declares a page *type*** — a name, a chip title, an icon, and a guide-page entry (titled 内嵌浏览器 / Embedded browser, `order: 45`) so a human can open it by hand. Declaring the type opens **nothing**.
- **Two keyed seats draw it**, both under the type's id: `sidebar.right.pane.tab` (the body: the live picture, the take-over toolbar, the hand-over banner) and `sidebar.right.pane.tab.title` (the chip: glyph, 浏览器 / Browser, and a dot while that session waits for a person). A type whose body was never registered renders the owner's "nothing can view this" notice rather than throwing (#15).
- **Opening is an explicit act**: `ctx.sidebarRight.openTabIn(sessionId, 'embedded-browser')` — named by `kind`, not by `id`.

The sidebar, rather than anywhere else, because it is the workbench's addressing surface for "something belonging to this workspace and session" — file previews and canvases already live in that column, and a live page sitting beside the conversation flow is exactly the arrangement a hand-over wants: the human takes over the page while still seeing what the AI said about it.

**Who opens it, and why.** A client-side watcher (`watchSessions`) polls the plugin's own `GET /sessions` every 2 s (15 s while the document is hidden) and looks for exactly two reasons:

1. **this session has a browser tab** — the AI started driving one, or somebody pressed the open button in the empty state. This fires **once per stretch of "this session has a browser"**: a human who closes the tab is obeyed until the browser itself goes away and comes back, so the sidebar never fights the person using it;
2. **a new hand-over request** for this session — including one that arrives after the human closed the tab. This one overrides rule 1 on purpose: a request nobody can see is a request that hangs until it times out.

The watcher only ever acts on the session **currently on screen**, and re-evaluates immediately when the current session changes. Opening a tab in some other conversation would move the sidebar out from under whatever the human is doing, which is the same reason the reference implementation of this pattern only ever reveals into the active session.

**Visibility, not mount, is the focus protocol.** A docked body stays mounted while its tab is inactive or the column is collapsed, so "mounted" and "on screen" are different states (#14). The body reads `props.useTabInfo().tab.visible` and only then opens the WebSocket and asks the host for `focus`; a hidden tab holds no socket and keeps no claim on the browser's foreground. Unmounting still ends the stream, and neither path ever closes a browser tab — the tab belongs to the session, not to the surface.

The one thing given up: there is no host-wide overview any more (the root `main` panel and the `sidebar.panellist` entry are gone). "Some other session is waiting for a person" is now visible only as the dot on that session's chip, which requires switching to that session to see.

## Why the tools are published lazily

Tool schemas are paid for on **every** request: the suite travels with each turn's payload whether or not the turn touches a browser. A skill's catalog entry, by contrast, is two lines, and its body is read only when the model decides to read it. Measured on the development host: this plugin's ten `browser_panel_*` schemas (the prefix these tools carried before the 0.3.0 rename) serialize to **4,731 bytes**, the BrowserSkill plugin's six `browser_*` schemas to **10,866 bytes**, and all sixteen together to **15,597 bytes** — a browser nobody asked for is not free.

So the default (`lazyTools: true`) keeps the ten schemas off the tool list until something proves the model is doing browser work: a successful `skill` call naming `browser-use`, a `/browser-use` gesture from the human, or a successful invocation found in a session log at arm time.

Three properties of that gate are deliberate:

- **One skill read buys a permanently smaller request.** The gate is one-way for the life of the host process: once opened it never closes again, so the cost is one skill read and the saving is every following turn.
- **The reveal is host-wide, not per session.** `ctx.tools.register` publishes into a single registry that every session reads, so the first session to invoke the skill opens the gate for all of them. That follows the shape of the registry instead of inventing a per-session tool list nothing else understands.
- **Reload cannot lose an open gate.** A gate that only listens for future events stays shut for the rest of the process after a plugin reload, because the invocation that opened it is in the past (#16). So arming also replays every live session's log, and every session created later replays its own.

The cost is honest: a gated suite is *invisible*. Nothing tells a model that `browser_embedded_*` exists until it reads the routing skill, which is why the plugin contributes a system-prompt section naming that skill, and why the README tells a new installation to ship the skill alongside the package (`lazyTools: false` is the escape hatch for a deployment with no skill layer at all).

## Why the tools carry no session parameter

`browser_embedded_*` handlers read the calling session from their execution context (`exec.agent.id`) and resolve their tab from it. No tool takes a session id — that is what keeps the surface honest — and three properties fall out for free:

- the model never has to know that sessions, tabs, or ids exist;
- a session cannot steer another session's tab — there is no parameter through which to ask;
- an agentless dispatch (service-internal, UI, or command paths, where `exec.agent` is absent) is an **error** rather than a silent fallback to a host-wide page, because that fallback would quietly recreate the 0.1.x model.

The session binding is invariant; the *names* are not. 0.3.0 renamed the suite from `browser_panel_*` to `browser_embedded_*` to match the package, which meant a matching rename everywhere the old prefix was routed on, documented, or asserted in tests.

## Why human take-over is per session

The broker is keyed by session (`sessionId -> pending request`). Two conversations can therefore wait on two different humans simultaneously, and a request is delivered only to the sidebar tab of its own session — the write path behind the hand-over banner. Cancellation is per session as well: superseded by a newer request, session disposed (`agent/disposed`), browser stopped, or the tab closed.

Because there is no host-wide surface any more, the *discovery* path for a request raised while the human is reading another conversation is the chip dot on that session's tab plus the auto-open rule above (#15 for the seat mechanics).

## Why screencast instead of VNC

The obvious way to show a container browser to a human is a virtual display plus VNC plus a web viewer (Xvfb + x11vnc + noVNC). It works, but it costs a second protocol stack, a second port, a second authentication story, and (on this host) `x11vnc` would not even complete an RFB handshake.

The screencast path gives the same pixels through a channel the plugin already controls:

- one WebSocket on the DSH webserver's own origin, behind the Web UI's own session authentication;
- no second port, no tunnel, no mixed-content problem;
- input is replayed through `Input.dispatch*` into the very CDP target the AI drives — "the tab of the session this sidebar tab belongs to", which makes the shared-surface property structural rather than something to keep in sync.

The costs are honest ones: JPEG frames are heavier than a region-based VNC encoding (mitigated by dropping frames above a socket backlog), and file upload/download gestures inside the page are not proxied (the AI can still upload via CDP if it gets a path).

## Why headed on a private Xvfb by default

`--headless=new` is the same Chrome binary with no window, so it renders — but a browser that reports `HeadlessChrome` in its user agent, or that never has a window, is a weaker signal than one that does. `mode: auto` therefore prefers headed-on-Xvfb when `Xvfb` exists (no display hardware required, and on the development container it does) and falls back to headless when it does not. Nothing in the panel cares which one is running.

## Why zero dependencies

A profile plugin is linked into a running host process, and a bare `import` of a package that is not resolvable from the plugin's real path takes the whole plugin tree down with it. The two things needed — CDP over WebSocket and an RFC 6455 server — are a few hundred lines each and have no moving parts worth outsourcing. The result installs without a dependency tree and cannot break because an upstream package changed shape.

## Why the panel is where the human works

`browser_embedded_ask_human` deliberately does *not* ask the human to paste a code into the conversation. It brings up the sidebar tab of the asking session (reopening it if the human had closed it), states the instruction, and waits for a 我已完成 / Done click. The human then does exactly what they would do in any browser — password manager autofill, phone QR scan, SMS code, CAPTCHA — while the AI keeps the page state and continues the moment they finish.

## Deliberate limitations

- **One Chrome per host process.** A browser crash, a stop, or `idleShutdownMinutes` takes every session's tab with it. Sessions are isolated in page state, not in process lifetime; per-session *browsers* were rejected above.
- **Identity is shared by design.** A login performed in one session is a login in every session, and any session's AI can reach any site the shared profile is logged into. That is the feature; it is not a bug, and it is not a security boundary.
- **One viewport per instance**, shared by every tab, so the panel canvas maps 1:1 onto page coordinates with no resize plumbing. The emulated viewport is applied per tab and is deliberately *not* cleared when a stream stops, so coordinates never shift between two sizes mid-mapping (#10).
- **A polled session is ~7 fps**, and its first frame can be cold while another tab owns the screencast.
- **The sidebar tab is not pinned and there is no overview.** Cross-session awareness is one dot on the chip of the session that is waiting; finding it means switching to that session.
- **A gated suite can be missing.** With `lazyTools: true` and no `browser-use` skill installed, the ten tools are never published — the price of not paying their schemas on every request.
- **File upload by the human is not proxied** through the canvas; the AI can upload via CDP when it has a path.
- **The panel is not a general remote desktop**: it shows the session's browser tab, nothing else.
- **No shared-browser mode.** 0.2.0 removed it rather than keeping it behind a flag; the plugin had no users yet, and a host-wide page is the wrong default for a multi-session harness.
