# Releasing

Every release ships three things that must agree with each other: a **git tag**, a **GitHub release**, and an **npm version** — all pointing at the same code. There is no CI here, so the steps below *are* the pipeline.

## 0. Pre-flight

```sh
git status --short                 # must be clean
npm test                           # lazy-gate (19 checks, no DSH) + smoke (43 checks, real Chrome)
node --check lib/client.js         # the client half has no build step
```

- Bump `version` in `package.json`. Semver: while the plugin is `0.x`, a behaviour-level break is a **minor** bump (that is what `0.2.0` was: per-session tabs, no shared page) and a fix is a patch. A **rename** is a behaviour-level break too — `0.3.0` renamed the package, the tool prefix, the route prefix and the default profile directory, all in one minor bump.
- `README.md` / `README.zh.md` must describe the behaviour being released, and both must stay faithful translations of each other (same sections, same table rows, same code blocks). Anything in the docs that names a version number changes in the same commit — a stale version in the README is the most common release defect.
- `references/PITFALLS.md` gets any new mechanism learned while building the release; a claim that measurement contradicts is corrected *before* the tag, not after.
- **If the release renames anything** (the package, the tools, a route, the default profile directory), grep the whole repository for the old name before tagging and fix or annotate every hit — then follow section 6.

## 1. Commit and push

```sh
git add <only the files this release touches>
git commit -m "feat!: …"           # or fix: / docs:
git push origin main
```

## 2. Tag and release

Annotated tag on the release commit, then a GitHub release whose notes are the user-facing changelog:

```sh
git tag -a vX.Y.Z -m "X.Y.Z — <one line>"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "X.Y.Z — <one line>" --notes-file /tmp/relnotes-X.Y.Z.md --latest
```

The notes say, in this order: **what breaks** (if anything), **what changed and why**, **what an upgrading user must do**, and **how the release was verified**. Link or name the evidence — never claim verification that was not run. `gh release create --latest` keeps the newest release marked as such; there is no changelog file in this repository, so release notes *are* the changelog.

## 3. Publish to npm

```sh
npm pack --dry-run                 # inspect the exact tarball
npm publish                        # account imrocchan, unscoped, default access
```

- `files` in `package.json` is the allow-list and the single source of truth: `lib/`, `cordis.patch.yml`, the two READMEs and `LICENSE`. `references/`, `AGENTS.md` and `test/` stay out of the tarball on purpose.
- The registry takes roughly 40 s to serve a fresh version, and `npm view` can lag well beyond that. When in doubt, ask the registry API directly rather than trusting one `npm view`:

  ```sh
  curl -s https://registry.npmjs.org/dsh-embedded-browser | \
    python3 -c "import sys,json;d=json.load(sys.stdin);print(d['dist-tags'],sorted(d['versions']))"
  ```

## 4. Verify the published artifact

The point is to prove the tarball is the code that was tested — not that the command exited 0:

```sh
mkdir -p /tmp/npm-verify && cd /tmp/npm-verify
npm pack dsh-embedded-browser@X.Y.Z && tar xzf dsh-embedded-browser-X.Y.Z.tgz
grep -c "<a marker only this release has>" package/lib/client.js   # expect > 0
grep -c "<a marker the previous release had>" package/lib/browser.js  # expect 0
```

## 5. Install-path check

A `link:`-installed host runs the working tree, so it proves nothing about the published package. When a release changes composition (a new bundle row, a renamed export, a new dependency), install the published version into a throwaway `DSH_HOME` and confirm the plugin mounts and its routes answer — **401 means mounted and requiring the Web UI's own authentication, 404 means the route is missing**.

## 6. If the release renames anything

A name is not one string in one file. When 0.3.0 renamed `dsh-browser-panel` → `dsh-embedded-browser`, the same identity was spelled out in all of these places, and every one of them had to move in the same commit:

| Where | What carries the name |
|---|---|
| `package.json` | `name`, `description`, `repository`, `homepage`, `bugs`, `keywords` |
| GitHub | the repository (rename it, then `git remote set-url` — the old slug redirects, but nothing should still point at it) |
| `cordis.patch.yml` | the inserted row's `id` and `name` |
| `lib/index.js` | `export const name`, `VERSION`, and the comment naming the default profile directory |
| `lib/lazy.js` | `TOOL_PREFIX`, and the gate's `SKILL_NAME` if the rename reaches the skill |
| `lib/tools.js` | every `name:` — the tool prefix is an API: prompts, skills and habits are written against it |
| `lib/routes.js` | `BASE_PATH` (the HTTP and WebSocket prefix) |
| `lib/browser.js` | the default profile directory (`$DSH_HOME/<name>/profile`) |
| `lib/client.js` | `window.__ModuleLoader__.load({ id })`, the tab type id, the `data-*` scope attribute, the CSS class prefix |
| `test/smoke.mjs` | route paths and the temp profile directory |
| docs | every file here, plus any external note that links to them |

Two consequences are worth spelling out in the release notes, because an upgrading user hits them without any error message:

- **The default profile directory moves with the name.** A renamed `profileDir` default silently orphans the old profile, and an orphaned profile means every login is gone. Either the user sets `profileDir` back to the old path, or the notes say plainly that logins must be performed again.
- **The tool prefix is what other people's skills route on.** A renamed prefix needs the pairing skill (and any prompt that names the tools) updated in the same breath, or the model is told about tools that no longer exist.

Old names may stay in the repository only where they are *explaining* the rename (a "renamed in X.Y.Z" note) or as a marked historical record (`更名前` in `references/PITFALLS.md`, which documents failures under the names in force at the time). Anywhere else, a leftover old name is a defect — and the cheap way to find them is the grep in section 0.

## What this repository deliberately does not have

No CI, no changelog file, no release branches, no `.npmignore`, and no `prepublish` build step (the client half is plain JavaScript by design). If a release is wrong, fix it on `main` and cut the next patch version — **never retag or republish a version**, because npm will not accept the same version twice and nobody can tell which artifact they got.
