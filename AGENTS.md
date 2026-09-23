# AGENTS.md — instructions for AI agents working in this repository

You are contributing to **dsh-embedded-browser**, a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profile bundle: a browser that lives on the DSH host, where **every DSH session owns one tab**, driven by the AI through `browser_embedded_*` tools and by the human through an on-demand right-Sidebar tab inside the DSH Web UI.

> Renamed in 0.3.0: until 0.2.0 this repository was `dsh-browser-panel`, its tools were `browser_panel_*`, and its routes and profile directory carried the old name. `dsh-browser-panel` / `browser_panel_*` are historical names now — use them only when explaining the rename.

This file is the project-facing companion to `README.md`: the README explains the plugin to users, this file explains the repository to you.

## Layout

```
lib/index.js        host half: config, wiring, session-tab lifecycle, prompt hint, tool gate
lib/lazy.js         the lazy gate: when the tools get published, plus the reload replay
lib/browser.js      Chrome lifecycle (Xvfb + spawn + CDP) and the sessionId -> tab registry
lib/cdp.js          dependency-free Chrome DevTools Protocol client
lib/ws.js           dependency-free RFC 6455 server (one upgrade route)
lib/screencast.js   per-session stream hub: which tab owns the screencast, pollers for the
                    rest, and input replay into the panel's own session
lib/human.js        the ask-human broker (one pending request per session, timeout, resume)
lib/routes.js       /api/dsh-embedded-browser routes (session-scoped ones carry a session id,
                    plus the host-level /sessions and /health) and the stream upgrade
lib/tools.js        the twelve model-facing tools, each bound to its calling session
lib/client.js       browser half: the right-Sidebar tab (type + two keyed seats), the
                    auto-open watcher, and the panel itself (no build step)
test/smoke.mjs      66-check standalone core test — no DSH needed
test/lazy-gate.mjs  22-check standalone test for the gate: reveal paths, reload replay,
                    near-misses, disposal (fake context, no DSH, no browser)
test/human-input.mjs real pointer/keyboard events into the panel canvas, verified in the page
cordis.patch.yml    bundle layer: inserts the plugin row (id: embedded-browser)
```

Repository documents:

```
README.md / README.zh.md   user-facing documentation (bilingual, kept in lockstep)
references/DESIGN.md       why the architecture is what it is
references/PITFALLS.md     every measured trap, with the evidence
references/RELEASING.md    the release pipeline: tag + GitHub release + npm, and how to verify each
```

## Development loop

```sh
npm test                   # test/lazy-gate.mjs, then test/smoke.mjs
node test/lazy-gate.mjs    # the lazy gate alone: fake context, no DSH, no browser
node test/smoke.mjs        # core: per-session tabs, CDP ops, real input, streams, hand-over
node --check lib/client.js # the client half has no build step; syntax-check it
```

- `test/smoke.mjs` drives a **real Chrome** (found the same way the plugin finds it: `browserPath`, `PATH`, then the Playwright/Puppeteer caches; Xvfb is optional) and needs no DSH. Its 66 checks are the definition of "the per-session model still holds": two sessions get two tabs, the tabs do not steer each other, a click-then-type really lands in the field (the focus gate), panel input reaches **its own** session only, the watched session owns the screencast while the other is served by polled frames, a panel reconnect does not kill the next stream, one activation makes a never-activated target accept input, two sessions can wait on a human at the same time, a device preset resizes exactly one tab and `reset` undoes it, startup sweeps the tabs a restored session left behind, `eval` answers with JSON for values Chrome cannot round-trip, a resize reaches the panel, and a login survives a browser restart.
- `test/lazy-gate.mjs` covers the gate's whole contract the way a live run cannot set it up on demand: a *past* invocation found after a reload, a session created later replaying its own log, and the near-misses that must **not** open the gate (a failed `skill` call, a different skill, a `tool/call` with no successful result). It needs a context stub, not a host.
- What neither suite reaches is the browser page: the Sidebar seats and the auto-open watcher are verified by hand against a running host (open a browser, watch the tab appear, hide it and watch the stream stop).
- **Host half changes need a DSH restart** (`bundle` rows are a boot-time composition change, and Cordis' cascaded loader caches modules — editing a linked plugin's `lib/*.js` does *not* hot-reload).
- **Client half changes only need a page refresh**, but the served bundle carries a `rev` — if the rev does not change, restart the instance.
- A plugin row can be hot-inserted through the *profile patch file* (`~/.dsh/profiles/<profile>/cordis.patch.yml`, `patchReload: live`), which is handy for iterating on a live GUI without a restart. Watch for duplicate rows if the package is also in `dsh.profile.bundles`.

## Invariants (learned the hard way — see `references/PITFALLS.md`)

1. Plugin metadata must be attached to the **default-exported function** (`apply.inject`, `apply.Config`); named exports alone are ignored by the loader.
2. Never read `ctx.<service>` unless it is in `inject`. `ctx.get(name)` returns `undefined` while a service is still mounting, so web surfaces are registered inside `ctx.inject(['webServer', 'connection'], …)`.
3. Tool canonical values must be lossless JSON — no `undefined`, no class instances.
4. Tool names are prefixed `browser_embedded_*`: the BrowserSkill plugin owns `browser_*` for the user's real browser, and a duplicate tool name aborts plugin load outright. The prefix is also what the `browser-use` skill routes on, so the skill and this suite are renamed together or not at all.
5. Client slot registration needs the slot to be **declared** first: use `ctx.slots.inject(slot, () => ctx.slots.register(…))`.
6. The panel must never be able to take the GUI down: failures in the client half are logged, never thrown, and the host half keeps working without a webserver (the tools simply lose the visual panel). Every Sidebar seat is feature-checked for the same reason.
7. **Session tabs are the model.** One Chrome per host process, one tab per DSH session, created lazily by `BrowserManager.ensureSession(sessionId)`. There is no shared-page fallback, and 0.2.0 removed the one that existed — do not reintroduce it.
8. Every session tab is **activated once** at creation (#11). A never-activated target silently discards every injected input event for the rest of its life, and the repair is permanent. Do not "optimise" the activation away, and do not gate behaviour on `document.visibilityState` — it is not a predictor of input delivery (typing is gated on renderer focus, #12).
9. Only the **hub** decides which tab is in front, and only because Chrome streams the active tab alone (#13). The AI path must never activate a tab for its own convenience: a session's tab accepts injected input while it is in the background.
10. A tab belongs to the **session**, not to the surface: the Sidebar tab never closes a browser tab, and a tab body that unmounts must not take the browser with it. The focus protocol is **visibility**, not mount — a docked body stays mounted while its tab is inactive or the column is collapsed (#14).
11. Tools take their session from `exec.agent.id` inside the handler (`sessionOf`). Never add a `sessionId` tool parameter, and never fall back to a host-wide page: a call without an owning session is an error.
12. Session-scoped routes must carry a session id (`/state?session=…`, the `/stream?session=…` upgrade, `POST /open|/close` with `sessionId` in the body); the host-level ones (`/sessions`, `/health`, `POST /human-done`) describe every session or settle a request by id, and must not invent one. Every route and the upgrade run `connection.requestRejection`.
13. The profile — and therefore the identity — is shared by every session **on purpose**; per-session isolation covers page state only. Do not "fix" cross-session cookie sharing.
14. The Sidebar tab type is **two halves under one id**: `ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, … })` is the static definition, and the keyed seats `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` must register under the **same `TAB_ID`** (the body) and be reachable by **`TAB_KIND`** (`ctx.sidebarRight.openTabIn(sessionId, TAB_KIND)`). Registering only one half renders the owner's "nothing can view this" notice instead of failing loudly (#15).
15. `lazyTools` defaults to `true`, and the gate's skill name is the hard-coded `SKILL_NAME` in `lib/lazy.js`. Renaming the skill means editing that constant, and the **reload replay must survive**: an event-only gate stays shut forever after a plugin reload, because the invocation that opened it is in the past (#16, upstream Tencent/BrowserSkill #269). Keep the arm-time replay of live session logs plus the `session/created` listener, and remember the reveal is host-wide — `ctx.tools.register` publishes into one registry every session reads.
16. The panel's stream is opened from `props.useTabInfo().tab.visible` (`visible !== false`), never from "the component mounted": a hidden tab that holds a WebSocket also keeps asking for the browser foreground, which quietly breaks whoever is watching (#14).
17. **Emulation is per target and never inherited.** `browser_embedded_emulate` writes CDP overrides onto *one* tab — that is what makes it safe in a one-tab-per-session browser (no restart, no config write, no effect on any other session) — and a *replaced* tab starts from `defaultEmulation()` again. "Reset" means the configured `viewport`, not Chrome's real window: the plugin pins one viewport so the panel has a stable coordinate space. Every apply re-sends every field including its off form (`userAgent: ''`, `enabled: false`, `features: []`), because the overrides are independent (#19).
18. **The panel maps pointer events through the *reported page viewport*, never through the canvas's intrinsic size.** Chrome scales screencast frames down to the hub's `maxWidth`/`maxHeight`, so canvas size equals the viewport only while the viewport fits inside those caps; past that they diverge (an iPad preset, a 1920-wide desktop check) and a canvas-based mapping aims the human's clicks tens of percent away. The frame is the whole viewport with its aspect preserved, so the canvas *box* ratio is the exact mapping — and the host must push `viewport` when it changes (`pushState` compares it), or the panel keeps using the old geometry (#20, #21).
19. **`eval` must stay total.** `Runtime.evaluate` with `returnByValue` answers an object Chrome cannot round-trip with an empty `{}` rather than an error — a `CSSStyleDeclaration` is the everyday case — so `evaluateJson` fetches the value by reference and pushes it through the bounded serializer. Never trade that back for one round trip: a silent empty answer is worse than a loud failure, and "the value was not serializable" is not something a model can act on (#22).

## Releasing

Cutting a version means a **git tag + a GitHub release + an npm version that all point at the same code**, in that order, with the published tarball verified afterwards. The full pipeline — pre-flight, bump rules, release-note format, registry-lag checks, the throwaway-`DSH_HOME` install check, and what this repository deliberately does not have — lives in `references/RELEASING.md`. Read it before touching `version` in `package.json`; never retag or republish a version.

A rename is a release-time concern: the npm package name, the GitHub remote, the bundle row's `name`, the client mount id, the `NAME`/`VERSION` constants and every document naming them change in the same commit. See `references/RELEASING.md` for what a rename release has to move.

## House rules

- Zero runtime dependencies: CDP and the WebSocket server are implemented in-tree. Keep it that way unless there is a very good reason.
- Comments explain *why* (a protocol quirk, a lifecycle trap), not *what*.
- Documentation stays bilingual: `README.md` (English, default) and `README.zh.md`, cross-linked at the top of both, and faithful translations of each other — same sections, same table rows, same code blocks.
- No machine-specific facts (paths, ports, hostnames, credentials) in this repository.
- The entry skill (`browser-use`) is **not** part of this package: it lives in the user's skill repository, so the only coupling allowed is the name string in `lib/lazy.js`.

## Knowledge routing

Deeper DSH mechanism notes live in the author's harness knowledge base, outside this repository: Cordis composition and service injection, the slot system, the no-display-browser research that produced this plugin (Xvfb, CDP screencast), and plugin development practice (bundle install, restart orchestration, client bundle rules). None of it is required to build, test or release this package.
