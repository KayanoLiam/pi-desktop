<p align="center">
  <img src="apps/examples/desktop-app/webview/public/pi-logo-source.png" width="80" alt="Pi Desktop logo" />
</p>

<h1 align="center">Pi Desktop</h1>

<p align="center">
  A native desktop home for Pi Agent.<br />
  Your Pi configuration. Your models. A workspace of your own.
</p>

<p align="center">
  <a href="#run-locally">Run locally</a> ·
  <a href="apps/examples/desktop-app/README.md">Development guide</a> ·
  <a href="https://github.com/KayanoLiam/pi-desktop/issues">Issues</a>
</p>

![Pi Agent running in a native macOS window, with a local workspace and provider, model, and thinking selectors.](docs/images/pi-desktop.png)

> **Early preview — model selection, not chat execution yet.**
> The native app and Pi model picker work today. Sending is deliberately disabled
> for new local Pi threads until the Pi execution runtime is connected.
> This is an independent desktop project, currently being migrated from Cline.

## What works today

- **A native window.** Tauri 2 wraps a Next.js interface and a Bun backend. The app opens as **Pi Agent**, not a browser tab.
- **Your configured Pi models.** Browse providers and models from your local Pi configuration, filtered by `enabledModels`, rather than an unfiltered built-in catalog.
- **Selections that stay with you.** Each provider remembers its model; each provider/model pair remembers its thinking level. Pi startup defaults seed the picker when no desktop selection is saved.
- **Model-aware thinking controls.** Available levels come from model capabilities. Unknown extension capabilities are not guessed.
- **Light and dark themes.** Saved preferences and system appearance are respected, with a coral accent and the Pi mark throughout the app.
- **A local-first entry screen.** Choose a workspace and see its branch without Cline onboarding or an account sign-in. Cline Cloud is disabled.

The screenshot shows the current native macOS interface, including its selection-preview notice. Sidebar entries such as **Automations** and **Extensions** are inherited UI surfaces, not a claim that Pi execution or extension management is fully integrated.

## Run locally

### Requirements

- **Bun 1.3.13** and **Node.js 22 or newer**. Use Bun for dependency installation and scripts.
- A current stable **Rust** toolchain. The dependency graph requires Rust 1.85 or newer; the complete minimum-version matrix has not been verified.
- The [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), including Xcode Command Line Tools on macOS.
- An existing Pi configuration to populate the picker. An installed `pi` CLI is also needed to discover metadata registered by Pi extensions.

```sh
cd ~/Desktop
git clone https://github.com/KayanoLiam/pi-desktop.git
cd pi-desktop

bun install --frozen-lockfile
bun run build:sdk

cd apps/examples/desktop-app
bun run dev
```

This launches the **native Tauri app**. Its development webview uses port `3125`; the sidecar uses `3126`. Stop conflicting desktop/headless development processes first. The first launch builds native dependencies, the sidecar, and SSH helpers, and may download build tools.

For browser-only debugging, use `bun run dev:headless` from the app directory. It does **not** open a native window. An older installed Cline app does not reflect this checkout.

macOS is the currently exercised native development platform. Inherited Windows/Linux packaging scripts are not a verified Pi Desktop release matrix. Use the source workflow above; signing, updater endpoints, and standalone distribution still need migration.

## Bring your Pi configuration

The catalog reads `~/.pi/agent`, or the directory selected by `PI_CODING_AGENT_DIR`:

| File | Used for |
| --- | --- |
| `auth.json` | Locally configured provider credentials and availability |
| `models.json` | Custom providers and models |
| `models-store.json` | Cached provider model metadata |
| `settings.json` | `enabledModels`, startup defaults, and thinking preferences |

Configure providers in Pi, then use the picker’s refresh control to reload. Model identity always includes **both provider ID and model ID**, so identical model names from different providers do not share a selection. A listed credential does not prove that a future model request will succeed.

### Extension discovery and trust

The built-in catalog path uses read-only credential/cache adapters with model networking disabled. It does not request inference, refresh credentials, or execute API-key commands, and credentials are not included in the catalog sent to the webview.

When `enabledModels` references a provider absent from the bundled SDK, the sidecar may launch the installed `pi` CLI in RPC mode to discover that provider’s real models and thinking levels. Set `PI_DESKTOP_PI_BIN` if the executable is not on `PATH` or you want to select a particular installation.

**This discovery loads installed Pi extensions.** Pi is launched with `PI_OFFLINE=1`, no session, no tools, and no project context files, but these options are **not a sandbox** for extension code. Do not treat extension discovery as a guarantee of zero network access or filesystem writes. Use only extensions you trust.

If Pi is unavailable, exact authenticated extension references can remain visible with unknown thinking capabilities; wildcard entries are not invented.

## Architecture and migration

```text
Tauri native shell
        │
Next.js / React webview
        │  local transport
Bun sidecar
        ├── Pi configuration and model catalog
        ├── Installed Pi RPC for extension model discovery
        └── Inherited Cline runtime and workspace services
```

The goal is a standalone Pi desktop app. **This checkout is not standalone yet:** it retains the Cline monorepo and directly depends on `@cline/core`, `@cline/llms`, `@cline/shared`, and `@cline/ui`. Copying only the desktop directory will not produce a buildable project.

| Path | Purpose |
| --- | --- |
| [`apps/examples/desktop-app/`](apps/examples/desktop-app/) | Native app, webview, sidecar, and desktop development guide |
| [`sdk/packages/`](sdk/packages/) | Shared workspace dependencies still required by the desktop |
| [`docs/images/`](docs/images/) | Screenshots used by this README |
| Other `apps/` directories | Retained upstream projects; not the focus of Pi Desktop |

Existing Cline sessions and SSH environments retain their legacy execution paths. Removing Cline account screens does not remove those runtime dependencies. Bundle identifiers and updater configuration also still contain Cline values; they must be migrated before distributing an independent release.

### Next milestones

- Connect local threads to Pi execution, streaming, tools, approvals, and cancellation.
- Bring Pi session history and extension workflows into the desktop.
- Replace or extract the remaining Cline workspace/runtime dependencies.
- Migrate application identifiers, updates, signing, and release automation.
- Resolve inherited test/type/lint failures and establish desktop CI across supported platforms.

## Development

See the [desktop development guide](apps/examples/desktop-app/README.md) for commands, verification notes, native assets, and inherited runtime details. After SDK changes, rebuild with `bun run build:sdk` before testing or restarting the desktop: workspace packages resolve compiled `dist/` output.

The current baseline is **not all green**. A successful web build is not a passing webview typecheck, and inherited GitHub workflows are not evidence of Pi Desktop compatibility. Please include exact commands and results when reporting a bug or contributing a change.

## Acknowledgments and license

Pi Desktop builds on the [Cline](https://github.com/cline/cline) desktop architecture and the Pi coding-agent packages. Existing upstream code and copyright notices are retained.

This repository is licensed under [Apache 2.0](LICENSE). Original Cline code © 2026 Cline Bot Inc. Dependencies remain under their respective licenses.
