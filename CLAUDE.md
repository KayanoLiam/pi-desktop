# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is a fork of the **Cline** monorepo (`origin` → cline/cline) being turned into **Pi Desktop**: a native desktop app for the Pi coding agent, built by reworking Cline's Tauri desktop example. Branch `pi-desktop`, remote `pi-desktop` → KayanoLiam/pi-desktop. The root `README.md` describes the Pi Desktop project; almost everything else in the tree is inherited Cline code.

**Where the migration stands (see the two most recent commits and both READMEs):**

- Step 1 is done, `434030dc6 feat(desktop): migrate desktop example to Pi Agent (step 1: model selection)`: new local threads pick a Pi provider → model → thinking level from the user's real Pi configuration; Cline login/onboarding/account/cloud were removed; Pi Agent branding and a light-by-default theme were applied. `6b5334541 docs: introduce Pi Desktop` rewrote the READMEs around this.
- **Nothing executes through Pi yet.** Sending is deliberately disabled for new local Pi threads (`piSelectionOnly` in the composer). Existing Cline sessions and SSH remote environments still run through the inherited Cline runtime (`@cline/core` Hub).
- Next milestones, in README order: connect local threads to Pi execution (streaming, tools, approvals, cancellation); bring Pi session history and extension workflows in; replace or extract the remaining Cline workspace/runtime dependencies; migrate identifiers, updater, signing and release automation; resolve inherited test/type/lint failures and set up desktop CI.
- The desktop still depends on `@cline/core`, `@cline/llms`, `@cline/shared`, `@cline/ui` from `sdk/packages/`. Copying only the desktop directory does not build. `apps/cli`, `apps/vscode`, `apps/cline-hub` and the other `apps/examples/*` are retained upstream projects, not the focus.
- `src-tauri/tauri.conf.json` still carries Cline's bundle identifier (`bot.cline.app`) and Cline's updater endpoint; `tauri.dev.conf.json` uses `bot.cline.app.dev`. Do not publish or tag releases from this branch until those are migrated. Inherited GitHub workflows and `publish-*` skills are not evidence of Pi Desktop compatibility.
- The baseline is **not all green** (see "Known baseline"). When you report results, give the exact command and its outcome. A passing web build is not a passing webview typecheck.

Deeper references: `apps/examples/desktop-app/README.md` and `sidecar/ARCHITECTURE.md` (desktop), `sdk/AGENTS.md` + `sdk/ARCHITECTURE.md` (SDK boundaries and Hub flows), root `AGENTS.md` (cloud-VM setup notes), `apps/cli/DEVELOPMENT.md`, `.clinerules/*.md` (VS Code extension tribal knowledge).

## Toolchain

- **Bun 1.3.13** for install, scripts and `bunx`; **Node ≥ 22** is the runtime. Never `npm`/`yarn`/`pnpm`/`npx`/`ts-node`. One root `bun.lock` for the whole workspace. Node-runtime references in build scripts (`platform: "node"`, `node:` imports, `TARGET_NODE_VERSION`) are intentional; don't rewrite them to Bun (`.clinerules/bun-and-node.md`).
- Desktop native build: stable **Rust ≥ 1.85** (crate graph needs `edition2024`) plus Tauri v2 prerequisites (Xcode CLT on macOS). macOS is the only exercised native platform so far.
- To populate the picker you need an existing Pi configuration (`~/.pi/agent`) and, for extension-provided models, an installed `pi` CLI.
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
bun run dev            # native Tauri window ("Pi Agent Dev"); builds sidecar binary + SSH helpers, starts Next.js
bun run dev:headless   # sidecar + Next.js in a browser with a fresh shared approval credential; no native window
bun run dev:web        # Next.js only,  http://localhost:3125
bun run dev:sidecar    # sidecar only,  ws://127.0.0.1:3126/transport
```

Ports 3125/3126 must be free; stop earlier `dev:*` processes first. An installed `Cline.app` / `Pi Agent.app` is unrelated to this checkout. `bun run code` at the repo root is the same as `bun run dev` here.

### Verify

```sh
# Vitest suites (sidecar + webview). PI_DESKTOP_PI_BIN must point at a nonexistent path so tests never
# spawn the developer's real `pi`; fixtures bring their own temp Pi config and fake RPC executable.
PI_DESKTOP_PI_BIN=/nonexistent-pi-test bun x vitest run sidecar webview scripts/telemetry-define-args.test.ts --config vitest.config.ts

# Focused Pi catalog / selection / picker / theme tests
PI_DESKTOP_PI_BIN=/nonexistent-pi-test bun x vitest run \
  sidecar/pi-model-catalog.test.ts sidecar/commands-pi-model-catalog.test.ts \
  webview/lib/pi-model-selection.test.ts webview/components/views/chat/pi-model-selector.test.tsx \
  webview/lib/theme.test.ts --config vitest.config.ts

# Bun-only suites (bun:test, not Vitest)
bun test scripts/desktop-startup.test.ts scripts/dmg-background.test.ts scripts/generate-update-manifest.test.ts

bun run typecheck                   # sidecar/scripts TS only
(cd webview && bun x tsc --noEmit)   # webview TS is a separate check
bun run build:web                   # catches Node-only imports leaking into the client bundle; typecheck and Vitest do not
bun run build:sidecar
(cd src-tauri && cargo test --locked && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings)
```

CI-shaped groupings from the inherited `sdk-test.yml`: `bun -F @cline/code test:sidecar`, `test:sidecar-startup`, `test:settings-ui`, `test:chat-ui`.

**Known baseline (commit 434030dc6, macOS):** full Vitest run 1527 passed / 3 failed (worktree `/var` vs `/private/var` canonicalization, a timezone-dependent session label, jsdom missing `scrollTo`); webview `tsc` 107 diagnostics; Biome one notification-copy line-wrap error and two warnings; `cargo fmt` and two Clippy redundant-closure checks failed. Focused Pi tests, Bun script tests, Rust tests and the SDK/web/sidecar builds passed. Compare against this before treating a failure as your regression, and update the README's baseline when you re-verify.

### Architecture

```
src-tauri/src/main.rs   Tauri 2 shell: window, tray, native pickers; spawns the sidecar, restarts it if it exits
        │
webview/                Next.js 16 + React 19; lib/desktop-client.ts ⇄ ws://127.0.0.1:3126/transport
        │
sidecar/                Bun process: server.ts (HTTP+WS), commands.ts (command router), chat-session.ts
        │
@cline/core  ClineCore in hub mode → shared Hub daemon → @cline/agents / @cline/llms   (inherited Cline runtime)
```

- Transport envelope: request `{type:"command", id, command, args}`, response `{type:"response", id, ok, result|error}`, event `{type:"event", event:{name, payload}}`. A new backend capability is a new `command` case in `sidecar/commands.ts`, reached from the webview through `desktop-client.ts`'s `invoke()` / `subscribe()`. Webview feature code never imports `@tauri-apps/api/core` directly.
- Tool approvals and ask-questions are pushed to the webview as events and resolved through in-memory promise maps in the sidecar.
- Webview runtime imports use `@cline/shared/browser`; the bare `@cline/shared` alias resolves to the Node entry and breaks the client bundle.
- Sidecar imports the login-shell `PATH` at startup (`CLINE_SIDECAR_SKIP_SHELL_PATH=1` disables) and logs to `~/.cline/data/logs/code.log` (`CLINE_LOG_*`). Session data and settings live under `~/.cline/data/` (SQLite + `sessions/<id>/<id>.messages.json`, `settings/providers.json`), shared with the Cline CLI.
- SSH remote environments are `RemoteEnvironmentService` from `@cline/core`; the desktop owns only the settings UI and bundled-helper lookup.

### Pi integration (what exists after step 1)

- `sidecar/pi-model-catalog.ts` → `listPiModelCatalog()`: reads the Pi agent dir (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`): `auth.json`, `models.json`, `models-store.json`, `settings.json`, through `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` with read-only credential/cache adapters and model networking disabled (no credential refresh, no config writes, no API-key commands, no inference). Applies `enabledModels` with Pi's `provider/id` or bare-id, case-insensitive glob rules. Credentials never reach the webview. Exposed as the `list_pi_model_catalog` command; the picker has a refresh control.
- `listPiRpcModels()`: providers registered by installed Pi extensions (e.g. Antigravity) are not in the bundled SDK, so the sidecar spawns `pi --mode rpc --no-session --no-tools ...` (binary from `PI_DESKTOP_PI_BIN` or `PATH`, `PI_OFFLINE=1`, cwd = tmpdir, 15 s timeout) to get their real model names and thinking-level maps. This executes extension code and is **not a sandbox**. If Pi can't be launched, exact authenticated references stay listed with **unknown** thinking levels; never invent capabilities or wildcard entries.
- `webview/lib/pi-model-selection.ts`: model identity is `(providerId, modelId)`; Pi IDs are opaque, so don't apply Cline provider aliases or collapse same-named models across providers. Selection is remembered per provider and thinking level per provider/model pair in `localStorage` (`pi:desktop:model-selection:v1`). Thinking levels follow Pi's order `off … max`; defaults come from Pi's `modelThinkingLevels` / `defaultThinkingLevel` (else `medium`) and are clamped like the Pi CLI, and Pi startup defaults seed the picker only when nothing is saved.
- `webview/components/views/chat/pi-model-selector.tsx` is the picker; `chat-input-bar.tsx` receives `piSelectionOnly` and must never submit those drafts to the Cline runtime.
- Cline Cloud: `sidecar/feature-flags.ts` `isCloudAgentsAvailable()` / `isCloudAgentsEnabled()` return `false` unconditionally; old opt-ins and `CLINE_CODE_CLOUD_AGENTS` must not re-enable account/login entry points. Legacy account IPC and Cline OAuth login requests are rejected in `commands.ts` before credentials are read or a browser opens. Don't reintroduce onboarding/account views (deleted in step 1).
- Theme (`webview/lib/theme.ts`): default `light`, stored under `pi.desktop.theme.v1` (legacy `cline-hub-theme` still read), OS `prefers-color-scheme` respected when nothing is stored; accent default `coral` (Pi mark). Branding assets: `webview/public/pi-logo-source.png`, `webview/components/pi-logo.tsx`, `src-tauri/icons/` (regenerate via `bun tauri icon`; macOS `.icns` needs the padded variant described in the desktop README).

### Guardrails for further migration steps

- Keep the READMEs honest: state what works, what is disabled, and exact verification commands/results. Sidebar entries like Automations/Extensions are inherited surfaces, not Pi features.
- Don't guess unknown Pi extension capabilities, and don't use personal credentials or the developer's real `~/.pi` / `~/.cline` in tests; fixtures create temp dirs and fake executables.
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

- Conventional commits with an area scope, as in the log: `feat(desktop): …`, `fix(cli): …`, `fix(core): …`, `docs: …`.
- Avoid provider-specific string matching in provider/config plumbing; use provider metadata, catalog defaults or capability flags. If an exception seems unavoidable, explain why instead of adding `providerId === "..."`.
- Read user-editable config files with `readFileStrippingUtf8Bom` / `readFileSyncStrippingUtf8Bom` from `@cline/shared/node`; don't strip BOMs from files handled by tools or passed to models.
