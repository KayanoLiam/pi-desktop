# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is a fork of the **Cline** monorepo (`origin` → cline/cline) being turned into **Pi Desktop**: a native desktop app for the Pi coding agent, built by reworking Cline's Tauri desktop example. Branch `pi-desktop`, remote `pi-desktop` → KayanoLiam/pi-desktop. The root `README.md` describes the Pi Desktop project; almost everything else in the tree is inherited Cline code.

**Where the migration stands (version `0.1.0-beta.1`; check `git log` and both READMEs for anything newer):**

- **New local threads run through the user's installed `pi` CLI** (`pi --mode rpc`), since `f87141ee2`: streaming text/thinking, tool cards, opt-in tool approvals, extension dialogs, stop/queue, Pi session history (open, continue, rename, delete). Later commits added Pi slash commands through RPC (`e41d676ea`), scoped models (`bf21b316f`), `/tree` session navigation (`66d95c094`) management of installed Pi extensions in Settings → Extensions (`7f6043b59`), a sidecar-held queue with edit/remove/steer (`f701510e4`) and fork / edit-earlier-message (`96c331f75`).
- Still on the inherited Cline runtime (`@cline/core` Hub): existing Cline sessions and SSH remote environments. Not supported for Pi threads yet: file checkpoints.
- Next milestones, in README order: SSH remote threads and file checkpoints through Pi; replace or extract the remaining Cline workspace/runtime dependencies; migrate updates, signing and release automation; resolve inherited test/type/lint failures and set up desktop CI.
- The desktop still depends on `@cline/core`, `@cline/llms`, `@cline/shared`, `@cline/ui` from `sdk/packages/`. Copying only the desktop directory does not build. `apps/cli`, `apps/vscode`, `apps/cline-hub` and the other `apps/examples/*` are retained upstream projects, not the focus.
- The app is named **Pi** (`Pi Dev` / `Pi Beta` / `Pi Nightly`); on Linux it is **Pi Desktop** (`src-tauri/tauri.linux.conf.json`) so the deb package is `pi-desktop`, not Ubuntu's unrelated `pi`. The window title uses the bundle's product name from Tauri. The Rust crate is `pi-desktop`, bundle identifiers are `io.github.kayanoliam.pi-desktop` (`.dev` / `.beta` / `.nightly` overlays) and the updater endpoints are empty, so shipped builds never poll Cline's feed. The updater `pubkey` in `tauri.conf.json` is still Cline's; generate a Pi key (`bun tauri signer generate`) before re-enabling endpoints.
- Release tooling is inherited and Cline-specific: don't tag from `desktop-publish.yml` (hard-wired to `cline/cline`, `main`, Slack and Azure signing), and treat the `publish-*` skills and `.claude/commands/release.md` / `hotfix-release.md` as Cline flows, not evidence of Pi Desktop compatibility.
- **CI:** the only Pi-specific workflow is `.github/workflows/pi-desktop-package.yml` (manual `workflow_dispatch`). It builds unsigned test installers (macOS arm64 + x64 ad-hoc-signed DMG/zip, Windows NSIS, Linux DEB/RPM) and only checks that the files exist and the deb is named `pi-desktop`; it runs no tests and publishes nothing. The inherited `sdk-test.yml` / `desktop-test.yml` trigger on `main` / `desktop-experimental`, so **nothing tests `pi-desktop` pushes**; verify locally.
- The baseline is **not all green** (see "Known baseline"). When you report results, give the exact command and its outcome. A passing web build is not a passing webview typecheck.

Deeper references: `apps/examples/desktop-app/README.md` and `sidecar/ARCHITECTURE.md` (desktop), `apps/examples/desktop-app/CHANGELOG.md` (Pi beta notes above the divider), `sdk/AGENTS.md` + `sdk/ARCHITECTURE.md` (SDK boundaries and Hub flows), root `AGENTS.md` (cloud-VM setup notes), `apps/cli/DEVELOPMENT.md`, `.clinerules/*.md` (VS Code extension tribal knowledge).

## Toolchain

- **Bun 1.3.13** for install, scripts and `bunx`; **Node ≥ 22** is the runtime. Never `npm`/`yarn`/`pnpm`/`npx`/`ts-node`. One root `bun.lock` for the whole workspace. Node-runtime references in build scripts (`platform: "node"`, `node:` imports, `TARGET_NODE_VERSION`) are intentional; don't rewrite them to Bun (`.clinerules/bun-and-node.md`).
- Desktop native build: stable **Rust ≥ 1.85** (crate graph needs `edition2024`) plus Tauri v2 prerequisites (Xcode CLT on macOS; the Linux apt packages are listed in `pi-desktop-package.yml`). macOS is the platform the app is actually run on; Windows/Linux/Intel builds are only packaged by CI.
- Chatting on a Pi thread needs an installed `pi` CLI (on `PATH`, or `PI_DESKTOP_PI_BIN`) and a configured `~/.pi/agent`. The app drives Pi; it does not bundle it.
- Pre-commit (`.husky/pre-commit`) runs `gitleaks` (`brew install gitleaks`) then `lint-staged` inside `apps/vscode`; commits fail if gitleaks is missing.
- Biome, tabs. Root `bun run lint|format|fix` cover `sdk/`, `apps/cli`, `apps/cline-hub`, `apps/examples`. `apps/vscode` has its own `biome.jsonc`.

## The SDK `dist/` rule (most common failure)

`@cline/shared|llms|agents|core|sdk|ui` resolve each other only through compiled `dist/` (their `exports` have no source condition; tsconfig `paths` to `src/` are for typechecking only). After any change under `sdk/packages/`, from the repo root:

```sh
bun run build:sdk
```

before running the desktop, CLI, or any package tests. "Missing `@cline/*` export" / "missing `dist/`" means rebuild, not a source bug. Running processes do not pick up SDK changes; rebuild and restart. The next desktop/CLI Hub connection reuses a compatible running Hub or replaces an incompatible one.

## Pi Desktop (`apps/examples/desktop-app`, package `@cline/code`)

### Run

```sh
# once, from repo root
bun install --frozen-lockfile
bun run build:sdk

cd apps/examples/desktop-app
bun run dev            # native Tauri window ("Pi Dev"); builds sidecar binary + SSH helpers, starts Next.js
bun run dev:headless   # sidecar + Next.js in a browser with a fresh shared approval credential; no native window
bun run dev:web        # Next.js only,  http://localhost:3125
bun run dev:sidecar    # sidecar only,  ws://127.0.0.1:3126/transport
```

Ports 3125/3126 must be free; stop earlier `dev:*` processes first. An installed `Cline.app` / `Pi.app` is unrelated to this checkout. `bun run code` at the repo root is the same as `bun run dev` here. Local packaging: `bun run package:desktop:mac --allow-unsigned-mac` (ad-hoc signed, not notarized) → `dist/desktop/`.

### Verify

```sh
# Vitest suites (sidecar + webview). PI_DESKTOP_PI_BIN must point at a nonexistent path so tests never
# spawn the developer's real `pi`; vitest.setup.ts points PI_CODING_AGENT_DIR at an empty temp dir.
PI_DESKTOP_PI_BIN=/nonexistent-pi-test bun x vitest run sidecar webview scripts/telemetry-define-args.test.ts --config vitest.config.ts

# Focused Pi suites: execution, session files, commands, catalog, picker, slash/tree/scope dialogs, extensions, composer, theme
PI_DESKTOP_PI_BIN=/nonexistent-pi-test bun x vitest run \
  sidecar/pi sidecar/commands-pi-session.test.ts sidecar/pi-model-catalog.test.ts sidecar/commands-pi-model-catalog.test.ts \
  webview/lib/pi-model-selection.test.ts webview/lib/pi-slash-command.test.ts \
  webview/components/views/chat/pi-model-selector.test.tsx webview/components/views/chat/pi-scoped-models-dialog.test.tsx \
  webview/components/views/chat/pi-tree-dialog.test.tsx webview/components/views/settings/pi-extensions-view.test.tsx \
  webview/components/views/chat/chat-input-bar.test.tsx webview/hooks/use-chat-session.test.tsx \
  webview/hooks/chat-session/helpers.test.ts webview/lib/theme.test.ts webview/lib/desktop-window-title.test.ts \
  --config vitest.config.ts

# Single file: same prefix, one path. Bun-only suites (bun:test, not Vitest):
bun test scripts/desktop-startup.test.ts scripts/dmg-background.test.ts scripts/generate-update-manifest.test.ts

bun run typecheck                   # sidecar/scripts TS only
(cd webview && bun x tsc --noEmit)   # webview TS is a separate check
bun run build:web                   # catches Node-only imports leaking into the client bundle; typecheck and Vitest do not
bun run build:sidecar
(cd src-tauri && cargo test --locked && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings)
```

CI-shaped groupings from the inherited `sdk-test.yml`: `bun -F @cline/code test:sidecar`, `test:sidecar-startup`, `test:settings-ui`, `test:chat-ui`.

**Known baseline (macOS):**
- Last full run recorded in the desktop README (`f87141ee2`): Vitest 1568 passed / 3 failed (worktree `/var` vs `/private/var` canonicalization, a timezone-dependent session label, jsdom missing `scrollTo`); webview `tsc` 107 diagnostics; sidecar `typecheck`, `build:web`, `build:sidecar` and Bun script suites passed; Biome still reports inherited findings in untouched files.
- Rust, last run at `434030dc6`: `cargo test` passed; `cargo fmt --check` and two Clippy redundant-closure checks failed.
- At `96c331f75`: full Vitest 1662 passed / the same 3 inherited failures; focused Pi command 389 passed; webview `tsc` 109 (107 + 2 in `pi-tree-dialog.test.tsx`); typecheck, `build:web`, `build:sidecar`, Bun script suites passed.

Compare against this before treating a failure as your regression, and update the README's baseline when you re-verify.

### Architecture

```
src-tauri/src/main.rs   Tauri 2 shell: window, tray, native pickers; spawns the sidecar, restarts it if it exits
        │
webview/                Next.js 16 + React 19; lib/desktop-client.ts ⇄ ws://127.0.0.1:3126/transport
        │
sidecar/                Bun process: server.ts (HTTP+WS), commands.ts (command router), chat-session.ts (chat router)
        ├── Pi threads ──► sidecar/pi/ PiSessionManager ──► one `pi --mode rpc` child per active session (installed Pi)
        └── everything else ──► @cline/core ClineCore (hub mode) → shared Hub daemon → @cline/agents / @cline/llms
```

- Transport envelope: request `{type:"command", id, command, args}`, response `{type:"response", id, ok, result|error}`, event `{type:"event", event:{name, payload}}`. A new backend capability is a new `if (command === "...")` branch in `sidecar/commands.ts`, reached from the webview through `desktop-client.ts`'s `invoke()` / `subscribe()`. Webview feature code never imports `@tauri-apps/api/core` directly.
- Tool approvals and ask-questions are pushed to the webview as events and resolved through in-memory promise maps in the sidecar (both runtimes).
- Webview runtime imports use `@cline/shared/browser`; the bare `@cline/shared` alias resolves to the Node entry and breaks the client bundle.
- At startup the sidecar imports the login-shell `PATH` plus `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY` (only when unset), so Dock-launched Pi processes behave like the terminal (`sdk/packages/core/src/remote/shell-path.ts`; `CLINE_SIDECAR_SKIP_SHELL_PATH=1` disables). Logs go to `~/.cline/data/logs/code.log` (`CLINE_LOG_*`). Cline session data and settings live under `~/.cline/data/` (SQLite + `sessions/<id>/<id>.messages.json`, `settings/providers.json`), shared with the Cline CLI; Pi sessions live in Pi's own `~/.pi/agent/sessions`.
- SSH remote environments are `RemoteEnvironmentService` from `@cline/core`; the desktop owns only the settings UI and bundled-helper lookup.

### Pi execution (`sidecar/pi/`)

- **Routing:** `handleChatSessionCommand` in `chat-session.ts` hands a request to `getPiSessionManager(ctx)` when `config.runtime === "pi"` or the manager owns the session id (a Pi session file), local environment only. On the webview side, `use-chat-session.ts` carries `runtime`.
- **Process:** `pi-rpc-process.ts` is the JSONL RPC client; `pi-session-manager.ts` spawns `pi --mode rpc` (binary from `PI_DESKTOP_PI_BIN` or `PATH`) in the thread workspace with `--session-id` (new) / `--session <file>` (resume), `--model provider/id`, `--thinking <level>` and `--extension <gate>`. Pi events are translated into the **same** transport events the Cline path emits (`chat_text`, `chat_reasoning`, `chat_tool_call_*`, `chat_usage`, `chat_done`, `chat_session_status`, …), so the webview renders both runtimes with one code path; a blocking `send` resolves at Pi's `agent_settled`. Stop sends `abort` (kill after 10 s); idle processes are reaped after 10 min and relaunched on the session file.
- **Queue:** prompts sent while Pi is busy wait in `PiLiveSession.pending` (with images and materialized files), **not** in Pi's follow-up queue (which can only be cleared whole and reports plain text). The next one is dispatched as a new turn on `agent_settled` and announced with `chat_queued_prompt_start` (its queue id + images). `steer_prompt` / `update_pending_prompt` / `remove_pending_prompt` follow Cline's pending-prompt rules (core `local-runtime-host.ts`): stopping the user's own turn keeps the queue, stopping a queued turn discards it, an error holds it until the next enqueue/edit/steer/successful turn. Entries with a `pi:` id are Pi-owned and read-only.
- **Fork / edit:** the `fork` action finds the edited message on the current branch of Pi's live tree (`get_tree`: entry id = transcript id once loaded from disk, else the Nth user message; never `get_fork_messages`, which spans all branches) and calls Pi's `fork`, or `clone` for the Fork button. Pi rebinds its process to the new session, so the live process is re-keyed to the new id. A fork with no assistant message has no file yet (Pi writes it on the first reply) and lives in `unpersistedSessionConfigs`. Refused while busy or queued.
- **Approvals:** Pi has none built in. `pi-desktop-gate-extension.ts` writes a content-addressed `tool_call` hook to `~/.cline/data/pi-desktop/extensions/` that asks via `ctx.ui.confirm("pi-desktop:tool-approval", json)`; the sidecar auto-confirms (default, like the Pi CLI) or shows an approval card when the composer is set to **Ask first**. Other extension dialogs become question cards; `notify` becomes a transcript log row.
- **History:** `pi-session-files.ts` parses Pi's JSONL tree read-only and projects the active branch into `ChatMessage` rows. Never open sessions through Pi's `SessionManager.open()`: it rewrites old versions. Rename appends `session_info` (or `set_session_name` while live); delete removes the file; pinning is desktop-only in `~/.cline/data/pi-desktop/session-metadata.json`.
- **Config changes:** `pi-config-watcher.ts` stat-signatures `settings.json`, `models.json`, `auth.json`, `npm/`, `git/`, `extensions/`; a change marks live processes stale (restart after the current run), clears the slash-command cache and broadcasts `pi_config_changed`, which reloads the picker and slash menu.
- **Slash commands:** `pi-slash-commands.ts` mirrors Pi 0.87.0's builtins. Builtin names win over same-named extension/prompt/skill commands (Pi's own rule); RPC `prompt` would run the extension first, so a known builtin must never go through `prompt`. The webview (`lib/pi-slash-command.ts`) calls `execute_pi_command` before any optimistic chat turn; `handled: false` falls through to the normal prompt path. Builtins with a desktop equivalent return a `uiAction` handled in `webview/app/page.tsx`: `/tree` → `get_pi_tree` / `navigate_pi_tree` + `pi-tree-dialog.tsx`; `/scoped-models` → `get_pi_model_scope` / `set_pi_model_scope` / `cycle_pi_model` + `pi-scoped-models-dialog.tsx`; `/new`, `/model`, `/thinking`, `/settings`, `/resume` open existing desktop controls; `/fork` and `/clone` show guidance pointing at the transcript's Edit / Fork. Terminal-only builtins return guidance and are never sent to the model.
- **Extensions:** `pi-extensions.ts` (`list_pi_extensions`, `set_pi_extension_enabled`, `uninstall_pi_extension_package`) uses Pi's `SettingsManager` / `DefaultPackageManager`, resolving with `"skip"` so listing never installs or updates. Unlike the catalog, this path **writes Pi settings and removes packages**; local extension files can only be disabled. It backs Settings → Extensions ("Installed"); the Cline marketplace route was removed, its services kept.
- **Version skew:** the sidecar bundles `@earendil-works/pi-ai` / `pi-coding-agent` **0.85.1** (catalog, settings, extensions), while execution uses whatever `pi` is installed. Don't assume the bundled SDK describes the running Pi's behavior.
- **Not a sandbox:** Pi loads the user's real extensions, packages, credentials and MCP servers. RPC mode shows no project-trust prompt (project `.pi` resources follow Pi's saved trust and `defaultProjectTrust`); the desktop never passes `--approve`.

### Pi model catalog and selection

- `sidecar/pi-model-catalog.ts` → `listPiModelCatalog()`: reads the Pi agent dir (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`): `auth.json`, `models.json`, `models-store.json`, `settings.json`, through the bundled Pi packages with read-only credential/cache adapters and model networking disabled (no credential refresh, no config writes, no API-key commands, no inference). Applies `enabledModels` through Pi's own `resolveModelScopeWithDiagnostics` (for extension-provided models too, via `resolvePiModelPatterns`); don't reintroduce a desktop glob parser. Credentials never reach the webview. Exposed as `list_pi_model_catalog`; the picker has a refresh control and reloads on `pi_config_changed`.
- `listPiRpcModels()`: providers registered by installed Pi extensions (e.g. Antigravity) are not in the bundled SDK, so the sidecar spawns `pi --mode rpc --no-session --no-tools ...` (`PI_OFFLINE=1`, cwd = tmpdir, 15 s timeout) to get their real model names and thinking-level maps. This executes extension code. If Pi can't be launched, exact authenticated references stay listed with **unknown** thinking levels; never invent capabilities or wildcard entries.
- `webview/lib/pi-model-selection.ts`: model identity is `(providerId, modelId)`; Pi IDs are opaque, so don't apply Cline provider aliases or collapse same-named models across providers. Selection is remembered per provider and thinking level per provider/model pair in `localStorage` (`pi:desktop:model-selection:v1`). Thinking levels follow Pi's order `off … max`; defaults come from Pi's `modelThinkingLevels` / `defaultThinkingLevel` (else `medium`), clamped like the Pi CLI. Pi startup defaults seed the picker only when nothing is saved; a session opened from history seeds it with its recorded model. Picker UI: `webview/components/views/chat/pi-model-selector.tsx`.
- Cline Cloud: `sidecar/feature-flags.ts` `isCloudAgentsAvailable()` / `isCloudAgentsEnabled()` return `false` unconditionally; old opt-ins and `CLINE_CODE_CLOUD_AGENTS` must not re-enable account/login entry points. Legacy account IPC and Cline OAuth login requests are rejected in `commands.ts` before credentials are read or a browser opens. Don't reintroduce onboarding/account views (deleted in step 1).
- Theme (`webview/lib/theme.ts`): default `light`, stored under `pi.desktop.theme.v1` (legacy `cline-hub-theme` still read), OS `prefers-color-scheme` respected when nothing is stored; accent default `coral` (Pi mark). Branding assets: `webview/public/pi-logo-source.png`, `webview/components/pi-logo.tsx`, `src-tauri/icons/` (regenerate via `bun tauri icon`; macOS `.icns` needs the padded variant described in the desktop README).

### Guardrails for further migration steps

- Keep the READMEs and `CHANGELOG.md` honest: state what works, what is disabled, and exact verification commands/results. Automations/Routine/Schedules are inherited Cline Hub surfaces, not Pi features.
- Don't guess unknown Pi extension capabilities. Tests never use personal credentials or the developer's real `~/.pi` / `~/.cline`: `vitest.setup.ts` isolates `PI_CODING_AGENT_DIR`, `PI_DESKTOP_PI_BIN` is deliberately left to the command line so forgetting it fails loudly, and Pi runtime tests drive the scripted fake in `sidecar/pi/test-helpers/fake-pi.ts`. Extend that fake rather than spawning a real `pi`.
- Removing Cline UI does not remove runtime dependencies; say so explicitly when a change only touches the surface.

## Inherited SDK (`sdk/packages`, still required)

```
@cline/shared → @cline/llms → @cline/agents → @cline/core (→ @cline/sdk re-export) → apps
                                                @cline/ui (React/Tailwind primitives used by the desktop webview)
```

- `shared`: contracts, schemas, path/storage helpers, hook engine (entry points `.`, `/browser`, `/node`, `/types`, `/storage`, `/db`, `/automation`, `/remote-config`). `llms`: provider settings, models.dev-backed catalogs, AI-SDK handlers (read `sdk/packages/llms/AGENTS.md` before touching provider routing). `agents`: **stateless** loop, tool orchestration, hooks, streaming. `core`: stateful orchestration, `ClineCore`, sessions, SQLite, config watching, plugins, telemetry, cron, and the **Hub** under `src/hub/` (`client/`, `daemon/`, `discovery/`, `server/`, `runtime-host/`).
- Cross-package imports go through package entrypoints only (Biome `noRestrictedImports` rejects `@cline/x/src/...`). Route changes to the owning package (`sdk/AGENTS.md`, "Change Routing"); prefer direct cleanup over shims and update all call sites; update `sdk/ARCHITECTURE.md` when touching hub/bootstrap/session flows.
- **Hub model:** desktop sidecar, CLI and VS Code are clients of one detached Hub daemon per user, discovered or spawned via `@cline/core`. Sessions, events, approvals, schedules and settings live in the Hub; clients attach/detach without stopping the runtime; session status is reported, never defaulted.
- **Telemetry:** event names only from `CORE_TELEMETRY_EVENTS` in `sdk/packages/core/src/services/telemetry/core-events.ts`, via typed `capture*()` helpers with tests; never raw strings (`.greptile/rules.md`).

Commands (repo root): `bun run types`, `bun run test`, `bun run test:unit`, `bun run check` (biome + build:sdk + CLI build + hub webview + typecheck + check-publish), `bun -F @cline/core test:unit`, `bun -F @cline/llms test`, `bun -F @cline/agents test`, `bun -F @cline/shared test`. Run SDK commands from the root or `sdk/`, not `bun test sdk/...`. Single Vitest file: `cd sdk/packages/core && bunx vitest run src/ClineCore.test.ts --config vitest.config.ts`.

## Other inherited apps (not the focus)

**CLI (`apps/cli`):** `bun run cli [-i] ["prompt"]` from the root runs from source and spawns the Hub daemon itself; needs a provider credential (`cline auth`, `ANTHROPIC_API_KEY`, …). Tests: `cd apps/cli && bun run test:unit | test:e2e | test:e2e:tuistory | typecheck`. Commander.js commands in `src/main.ts`; OpenTUI + React TUI in `src/tui/` (`// @jsxImportSource @opentui/react` per file); `src/runtime/run-interactive.ts` is the only SDK↔TUI bridge. Details in `apps/cli/DEVELOPMENT.md`; headless TUI driving via the `tuistory` skill.

**VS Code extension (`apps/vscode`, package `claude-dev`):** `bun run protos` after any `.proto` change; `bun run dev` (protos + watch); `bun run compile` (there is no `bun run build`); `bun run test:unit` (bun-based), `test:integration` / `test:e2e` (real extension host); `bun run format:fix`. Architecture: `src/extension.ts` → `WebviewProvider` → `Controller` → SDK adapter `src/sdk/SdkController.ts` over `@cline/core`; the React `webview-ui/` talks gRPC-over-postMessage defined in `proto/cline/*.proto` (define RPC → `bun run protos` → handler in `src/core/controller/<domain>/` → generated client call from the webview). Persistent state goes through `StateManager` + `src/shared/storage/state-keys.ts`, never `ExtensionContext` storage; extension-side network calls go through `@/shared/net`; a test file imports `bun:test` or `mocha`, never both. Exclude `out/`, `dist/`, `dist-standalone/`, `src/generated/`, `src/shared/proto/` when grepping. `.github/copilot-instructions.md` predates the SDK migration: its system-prompt variant, `ToolExecutor`, `slash-commands/index.ts` and `providers.json` paths no longer exist.

## Conventions

- Conventional commits with an area scope, as in the log: `feat(desktop): …`, `fix(desktop): …`, `fix(core): …`, `ci(desktop): …`, `docs: …`.
- Avoid provider-specific string matching in provider/config plumbing; use provider metadata, catalog defaults or capability flags. If an exception seems unavoidable, explain why instead of adding `providerId === "..."`.
- Read user-editable config files with `readFileStrippingUtf8Bom` / `readFileSyncStrippingUtf8Bom` from `@cline/shared/node`; don't strip BOMs from files handled by tools or passed to models.
