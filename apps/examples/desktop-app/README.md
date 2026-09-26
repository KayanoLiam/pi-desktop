# Pi Desktop — Development Guide

The native **Pi** app: a Tauri shell, Bun sidecar, and Next.js webview.
Start with the [project README](../../../README.md) for the screenshot, current
features, prerequisites, and migration roadmap.

> **Pi runs the chat.** New local threads execute through the installed `pi`
> CLI in RPC mode (see "Pi execution" below). Existing Cline sessions and SSH
> environments retain their legacy execution paths. The workspace packages and
> release infrastructure have not been fully migrated.

## Run the desktop app

Complete the [root setup steps](../../../README.md#run-locally), including
`bun install --frozen-lockfile` and `bun run build:sdk`, before running:

```sh
cd apps/examples/desktop-app
bun run dev
```

This opens a **native Tauri window**. Next.js runs internally to serve its
webview during development; it is not a requirement to use a browser. Stop any
previous `dev:headless` / `dev:web` process first so port 3125 is free. The first
launch builds Rust, the sidecar, and SSH helpers and may download build tools.

`bun run dev:headless` is only a browser/sidecar debugging mode; it does **not**
open the desktop App. An installed `/Applications/Pi.app` (or `Cline.app`) is also separate
from this source checkout and will not pick up these changes.

## No Cline account required

The desktop opens directly to the workspace and model picker. Cline onboarding,
account profile/billing screens, login requests, and Cline billing providers
have been removed from this desktop. Legacy account IPC and Cline OAuth login
requests are rejected before credentials are read or a browser is opened.
Cline Cloud is disabled, including old opt-ins and environment overrides, because
it depends on that account system. Existing credential files and history are
not deleted. Third-party provider authentication is separate from Cline login.
Configure Pi providers in Pi itself (`pi auth …`); the desktop has no Pi login
flow of its own.

## Pi execution

New **local** threads run through the user's installed Pi. `sidecar/pi/` owns
this path; `sidecar/ARCHITECTURE.md` describes the design. In short:

- `chat_session_command` requests carrying `runtime: "pi"` (or a session id that
  exists in `~/.pi/agent/sessions`) are routed to `PiSessionManager` instead of
  the Cline Hub. The manager spawns `pi --mode rpc` from the thread workspace
  with `--session-id <id>` (new) or `--session <file>` (resume), the picked
  `--model provider/id` and `--thinking level`, and `--extension <gate>`.
- The binary is `PI_DESKTOP_PI_BIN` or `pi` on `PATH` (the login-shell `PATH`
  the sidecar imports at startup). A missing executable fails the send with a
  clear error rather than hanging.
- Pi's events are translated into the transport the webview already renders:
  `chat_text`, `chat_reasoning`, `chat_tool_call_start|update|end`,
  `chat_usage`, `chat_done`, `chat_queued_prompt_start`, `chat_session_status`,
  `chat_session_ended`, `prompts_in_queue_state`. A blocking `send` resolves at
  Pi's `agent_settled` with the same result shape the Cline path returns, so
  `use-chat-session.ts` carries `runtime` and, for Pi slash input, calls
  `execute_pi_command` before any optimistic chat turn.
- Pi has no built-in tool approval. The sidecar writes a small `tool_call`
  hook extension to `~/.cline/data/pi-desktop/extensions/` (content-addressed)
  and loads it into every Pi process. It asks through `ctx.ui.confirm` with a
  marker title; the sidecar answers immediately when the thread auto-approves
  (default, matching the Pi CLI) or shows the approval card when the composer's
  shield is set to **Ask first**. Rejected calls are blocked with a reason that
  Pi sends back to the model.
- Other extension dialogs (`select`, `input`, `editor`, `confirm`) become
  question cards; `notify` becomes a transcript log entry; `setStatus`,
  `setWidget`, `setTitle` and `set_editor_text` are ignored.
- **Stop** sends Pi's `abort`; if Pi does not answer within ten seconds the
  process is killed. Idle processes are reaped after ten minutes and relaunched
  on the session file when needed.
- Prompts sent while a turn runs wait in a queue the sidecar holds (see
  "Queued prompts" below), not in Pi's own follow-up queue.
- Pi session history is read directly from the JSONL files (never through
  Pi's `SessionManager.open()`, which rewrites old versions). The active branch
  is projected into the transcript shape: tool calls pair with their results,
  `edit` diffs render as rich diffs, compactions show as status rows. Rename
  appends a `session_info` entry (or uses `set_session_name` while live);
  delete removes the file. Pinning is stored desktop-side in
  `~/.cline/data/pi-desktop/session-metadata.json`.
- Slash commands come from Pi (`get_commands`): extension commands, prompt
  templates and skills, per workspace, cached for five minutes. Builtin names
  stay listed if that discovery fails. A stat
  signature of `settings.json`, `models.json`, `auth.json`, `npm/`, `git/` and
  `extensions/` is checked on file events and every five seconds; a change
  marks live Pi processes stale (restarted after their current run), clears
  the command cache and broadcasts `pi_config_changed`, which reloads the
  picker and the slash menu.

**Execution runs your installed Pi with your extensions, packages and
credentials.** RPC mode shows no project-trust prompt; project-local `.pi`
resources follow Pi's saved trust decisions and `defaultProjectTrust`, and the
desktop never passes `--approve`. None of this is a sandbox.

Pi slash commands (webview, against installed Pi 0.87.0): submitting text
that starts with `/` on a Pi thread calls `execute_pi_command` before a chat
turn or attachment clear. Pi matches builtin names before extension commands
and hides colliding extension names from autocomplete; the menu follows that,
so an extension named `compact` does not replace `/compact`. A handled command
is not sent to the model. `refresh: true` reloads the open transcript and asks
the sidebar to refresh metadata; it does not start a desktop chat turn.
`/compact` is that path (Pi may still call a model inside its own compact RPC).
`/name` updates the session title, `/session` shows statistics, `/copy` copies
the last Pi response, and `/export` writes HTML when Pi can export; JSONL export
is not available. `/model <model>` switches to a uniquely matching model (an
ambiguous match points to the picker) and `/thinking <level>` sets the level.
Without arguments, `/new`, `/model`, `/thinking`, `/settings`, and `/resume`
open the new-thread action, the model and thinking pickers, desktop Settings,
and session search; they do not require a live Pi process and are not Pi's
full TUI pickers. `/tree` and `/scoped-models` open the dialogs described
below. `/fork` and `/clone` show guidance that points at the transcript's
**Edit** and **Fork** actions (Pi's message picker is not available). Other
builtins such as `/share`, `/import`, and `/reload` show guidance instead of
running or uploading anything. Extension, skill, and prompt commands that the endpoint reports as
unhandled still follow the normal prompt path. A transport error keeps the
draft and attachments. A handled command clears only the command text.

### Queued prompts

Prompts sent while Pi is busy stay in the sidecar with their images and
attached files, and the next one is sent as a new turn once Pi settles. Pi's own
follow-up queue is not used for them: Pi can only clear that queue as a whole
and reports it as plain text, so single items could not be edited or removed
and their images would be lost. The queue actions follow Cline's pending
prompts:

- **Edit** replaces the text and keeps images and files. **Remove** also deletes
  the prompt's materialized attachments.
- **Steer** (or Enter on an empty composer for the first item) hands a prompt to
  Pi's steering queue while it runs, or sends it at once when Pi is idle.
- Stopping your own turn keeps the queue, and it continues once the stop
  settles. Stopping a queued turn clears the rest, so Stop always halts the
  session. A failed turn holds the queue until the next prompt, edit, steer, or
  successful turn.
- Entries already in Pi's own queue (a steered prompt, or follow-ups an
  extension queued) are shown but read-only. If the Pi process exits, queued
  prompts are dropped with a notice in the transcript.

### Edit and fork

**Edit** on one of your earlier messages forks the session before it with Pi's
`fork` and opens the new session with the edited text as a draft, like Cline and
Pi's `/fork`; the original session is not changed. **Fork** copies the whole
session with Pi's `clone`. Both are refused while Pi is busy or queued prompts
wait.

The message is located on the current branch of Pi's live tree: by its
transcript id (Pi's entry id once the session is loaded from disk), otherwise by
its turn number, since a just-sent message only has an optimistic id. Pi's
`get_fork_messages` cannot be used for this because it lists every branch. Pi
rebinds its process to the new session, so the live process moves to the new
id and the original thread relaunches from its file on the next send. A fork
from before the first message has no file until Pi's first reply; until then the
sidecar keeps its config like any new session. Pi records the new session's
`parentSession`, but the sidebar does not show that link yet.

### Session tree (`/tree`)

`/tree` opens a dialog with the thread's full Pi session tree, read from the
live Pi process (`get_tree`, including an unsaved leaf). It requires an idle,
local Pi thread. RPC exposes `get_tree` but no navigation request, so the gate
extension also registers an internal `__pi_desktop_tree_jump` command that
calls Pi's own `navigateTree`; no prompt reaches a model. The sidecar refuses
to navigate if that command is not registered in the running process (an
unknown slash command would otherwise be sent to the model as a prompt) and
checks that Pi actually moved to the expected leaf.

Choosing one of your earlier messages works like Pi's re-edit: the leaf moves
to just before it and its text returns to the composer, so sending it starts a
new branch. The desktop asks before replacing a current draft or attachments,
and warns that images from the original message cannot be restored.

### Model cycling (`/scoped-models`, Ctrl+P)

**Ctrl+P** in the composer of a live Pi thread calls Pi's `cycle_model`, the
same scoped cycle as the terminal, not a desktop approximation. `/scoped-models`
opens **Model Configuration** to choose which models the cycle uses; the current
model does not change, and selecting none or all of them means unrestricted.

- **Apply to session** affects only that thread. RPC cannot change scoped models
  in a running process, so the sidecar restarts the thread's Pi process with
  `--models` on the same session file; the transcript is kept.
- **Save to Pi settings** writes `enabledModels` through Pi's `SettingsManager`.
  This is a Pi configuration write, unlike the read-only model catalog. Without
  an open session it is the only option.

### Pi extensions (Settings → Extensions)

**Extensions → Installed** lists the extensions Pi resolves for the desktop's
local workspace, from the global Pi agent directory and the project's `.pi`,
grouped into npm packages, git packages, and local extensions. The sidecar
(`sidecar/pi/pi-extensions.ts`) uses Pi's `SettingsManager` and
`DefaultPackageManager`; resolving skips missing packages, so viewing the page
never installs or updates anything. "Enabled" means configured to load in a new
Pi process.

- The toggle writes the same exact `+path` / `-path` override as Pi's `/config`
  resource selector, in the resource's own scope.
- **Uninstall** (npm and git packages only, after confirmation) removes the
  package from the global or project Pi configuration, which also removes every
  skill, prompt, and theme it supplies. Local extension files can only be
  disabled, and are not deleted.
- Changes are refused while a desktop Pi thread is running. Afterwards idle
  desktop Pi processes are stopped and relaunch with the new configuration on
  the next send, so finish an unsent `/tree` re-edit first. The page links to
  [pi.dev/packages](https://pi.dev/packages) for browsing. The inherited Cline marketplace route was removed from Settings;
  the Cline inventory data and services are left in place.

Not supported for Pi threads yet: file checkpoints and SSH remote environments
(they stay on the Cline runtime).

## Pi model selection

New **local** threads offer Pi's provider → model → thinking picker. Select
a provider, then one of its models, then a thinking level. Models are identified
by **provider ID + model ID**; choices are remembered separately per provider in
browser storage, independently of Cline's model settings. Thinking levels are
the ones the model accepts (Pi's `reasoning` / `thinkingLevelMap` rules); the
default comes from Pi's `modelThinkingLevels` or `defaultThinkingLevel` in
`settings.json`, else `medium`, clamped like the Pi CLI does at startup. The
level is remembered per provider/model pair.

The catalog reads the user's Pi agent directory (`~/.pi/agent`, or
`$PI_CODING_AGENT_DIR`): `auth.json`, `models.json`, cached `models-store.json`,
and `settings.json`. It lists configured/available providers rather than the
whole built-in catalog, and applies `enabledModels` through Pi's own scope
resolver (`resolveModelScopeWithDiagnostics`: provider-qualified and bare IDs,
globs, fuzzy matches, thinking suffixes) rather than a desktop re-implementation. Saved Pi startup defaults are used only when the
desktop has no remembered selection; a session opened from history seeds the
picker with the model it was recorded with. The picker reloads on
`pi_config_changed`; **Refresh Pi models** forces a reload.

The built-in catalog path uses read-only credential/cache adapters with model
networking disabled: no credential refresh, config/cache writes, API-key command
execution, or inference requests. Credentials are not included in the catalog
sent to the webview.

Providers registered by installed Pi extensions (for example Antigravity) are
not part of the bundled SDK. When `enabledModels` references one, the sidecar
asks the installed `pi` CLI for its available models and takes the extension's
real model names and thinking-level maps from there. Set `PI_DESKTOP_PI_BIN` to
point at a specific Pi binary.

**Extension discovery executes installed extension code.** Pi is launched in RPC
mode with `PI_OFFLINE=1`, no session, no tools, and no project context files, but
these settings are not a sandbox. They cannot guarantee that extension code
will avoid network access, filesystem writes, or other side effects. Only use
trusted extensions; the built-in read-only guarantees do not cover them.

If Pi cannot be launched, exact authenticated references are still listed with
**unknown** thinking levels rather than guessed ones. Listed credentials are
not a guarantee that a request would succeed.

The sidebar, welcome screen, window title, and app/Dock icons use the supplied
Pi logo and Pi branding (the Settings → App icon variants are the Pi mark
on light, paper, dark, and coral backgrounds).
Both light and dark themes remain available, including existing saved dark
preferences and OS theme detection. The light layout follows the reference;
there is no forced theme reset.

Existing local Cline sessions and SSH environments keep their previous
execution paths; Cline account and cloud login flows are no longer available.

## Dev Commands

From `apps/examples/desktop-app/`:

- `bun run dev:headless` - Next.js UI (`http://localhost:3125`) and sidecar backend with a fresh shared approval credential
- `bun run dev:web` - Next.js UI only (approval-gated tools require `dev:headless` or the native app)
- `bun run dev:sidecar` - sidecar backend only (approval-gated tools require `dev:headless` or the native app)
- `bun run dev` - Tauri desktop dev
- `bun run build:web` - build production web assets only (includes the shared UI build)
- `bun run build` - build web assets and the sidecar binary
- `bun run build:sidecar` - build the Bun sidecar bundle
- `bun run build:sidecar:bin` - compile the Bun sidecar into a local binary
- `bun run build:binary` - build desktop binary
- `bun run package:desktop` - package the current OS desktop app into `dist/desktop/`
- `bun run typecheck` - sidecar/dev TypeScript check (not the webview check)

### Verification

After building the SDK from the repository root, run these from this directory:

```sh
# Pi execution, session files, command routing, catalog, picker, slash commands,
# tree and scoped-model dialogs, extensions page, composer, chat hook, theme
PI_DESKTOP_PI_BIN=/nonexistent-pi-test bun x vitest run \
  sidecar/pi \
  sidecar/commands-pi-session.test.ts \
  sidecar/pi-model-catalog.test.ts \
  sidecar/commands-pi-model-catalog.test.ts \
  webview/lib/pi-model-selection.test.ts \
  webview/lib/pi-slash-command.test.ts \
  webview/components/views/chat/pi-model-selector.test.tsx \
  webview/components/views/chat/pi-scoped-models-dialog.test.tsx \
  webview/components/views/chat/pi-tree-dialog.test.tsx \
  webview/components/views/settings/pi-extensions-view.test.tsx \
  webview/components/views/chat/chat-input-bar.test.tsx \
  webview/hooks/use-chat-session.test.tsx \
  webview/hooks/chat-session/helpers.test.ts \
  webview/lib/theme.test.ts webview/lib/desktop-window-title.test.ts \
  --config vitest.config.ts

# Keep Vitest and Bun-only suites in their respective runners
PI_DESKTOP_PI_BIN=/nonexistent-pi-test bun x vitest run \
  sidecar webview scripts/telemetry-define-args.test.ts --config vitest.config.ts
bun test scripts/desktop-startup.test.ts scripts/dmg-background.test.ts \
  scripts/generate-update-manifest.test.ts

bun run typecheck
(cd webview && bun x tsc --noEmit)
bun run build:web
bun run build:sidecar

(cd src-tauri && cargo test --locked)
(cd src-tauri && cargo fmt --check)
(cd src-tauri && cargo clippy --locked --all-targets -- -D warnings)
```

The nonexistent Pi executable prevents fallback to a developer's real Pi
installation, and `vitest.setup.ts` points `PI_CODING_AGENT_DIR` at an empty
temporary directory so no suite reads a real `~/.pi/agent`. Pi runtime tests
drive a scripted fake `pi` (`sidecar/pi/test-helpers/fake-pi.ts`) that speaks
the JSONL protocol. Do not use personal credentials for test fixtures.

**Known baseline (macOS, commit `f87141ee2`, when Pi execution landed):** the
full Vitest run had 1568 passing and 3 failing tests, the same three inherited
failures as before: worktree path canonicalization (`/var` vs `/private/var`),
a timezone-dependent session label, and jsdom's missing `scrollTo`. Webview
TypeScript reported 107 diagnostics (unchanged; none in the files touched by
the Pi work). Sidecar `typecheck`, `build:web`, `build:sidecar` and the Bun
script suites passed. Biome still reports the inherited findings in untouched
files. Rust checks were not re-run in this step. These are local results, not
passing desktop GitHub CI.

**Latest run (macOS, commit `96c331f75`, queue and fork work):** full Vitest
1662 passing and the same 3 inherited failures; the focused Pi command above
389 passing; `test:sidecar` 1185 passing plus the worktree failure,
`test:chat-ui` 143 and `test:settings-ui` 59 passing; the Bun script suites
16 passing. Sidecar `typecheck`, `build:web` and `build:sidecar` passed.
Webview TypeScript reported 109 diagnostics: the 107 above plus 2 in
`pi-tree-dialog.test.tsx` from the `/tree` commit, none from this work. Rust
checks were not re-run (no Rust changes).

### Checking webview changes

Run `bun run build:web` from this directory when changing webview imports or shared browser APIs. Type checking and Vitest do not check the production browser bundle: a valid TypeScript import can still pull Node-only modules into a client chunk. Use `@cline/shared/browser` for runtime imports in the webview; the bare `@cline/shared` source alias points to the Node entry point.

## Inherited integrations

The remaining sections document the existing desktop infrastructure, including
legacy Cline runtime features. They are retained for development reference and
are not a claim that these features execute through Pi. See the
[root migration notes](../../../README.md#architecture-and-migration).

## Pull Requests

The composer shows the current branch's GitHub pull request, merge status,
changed-line totals, and CI checks. Click the PR number to open it in your
browser, or expand CI to inspect individual checks and their logs. Status
refreshes every 30 seconds while visible, when the app regains focus, and
when you click refresh.

This requires GitHub CLI (`gh`) installed and authenticated with `gh auth login`,
and a GitHub.com `origin` remote (HTTPS or SSH). The row is hidden for the
default branch, detached HEAD, and unsupported repositories. If the branch
has no PR, **Create PR** opens GitHub's comparison form; push your commits
before submitting the form. The app does not push commits or submit PRs itself.

Missing or unauthenticated GitHub CLI also hides the row. Availability checks
are shared across workspaces and cached for five minutes, so unavailable CLI
installs do not spawn a failing process on every poll or window focus. After
installing or signing into `gh`, the feature becomes available on the first
refresh after the cache expires (or after restarting the desktop backend).
Initial lookup failures stay hidden. Errors after a successful status load
can be dismissed and remain dismissed through retries until a load succeeds.

### Pull request telemetry

These events use the desktop telemetry service and respect telemetry opt-out:

| Event | Trigger |
| --- | --- |
| `desktop.pull_request.shown` | First visible PR/create row per mounted workspace and branch |
| `desktop.pull_request.open_clicked` | Click the PR link |
| `desktop.pull_request.create_clicked` | Click Create PR (intent only, not PR submission) |
| `desktop.pull_request.checks_expanded` | Open the CI popover |
| `desktop.pull_request.check_clicked` | Click a check's details link |
| `desktop.pull_request.refresh_clicked` | Click manual refresh |

Each event contains only `prState`, `ciState`, and `mergeTone` categories.
The sidecar validates these values and strips extra fields. Repository/branch
names, paths, PR numbers/titles, check names, and URLs are not included.
Automatic polling does not emit additional impressions. Telemetry delivery
does not block interactions, and failures do not interrupt the feature.

## App Icons

`src-tauri/app-icon.png` (1024x1024, edge-to-edge) is the source for
`bun tauri icon`, which generates the Windows `.ico` and Linux PNGs in
`src-tauri/icons/`. macOS is the exception: Dock icons are expected to have a
transparent margin, with the artwork filling 824 of the 1024 canvas, so the
committed `icons/icon.icns` is built from a padded copy of the source, and the
selectable runtime icons in `icons/app/macos/` are padded copies of the
Windows ones in `icons/app/`. To regenerate the macOS icon after changing the
artwork:

```bash
cd src-tauri
magick app-icon.png -resize 824x824 -background none -gravity center -extent 1024x1024 /tmp/app-icon-macos.png
bun tauri icon /tmp/app-icon-macos.png -o /tmp/icons-macos && cp /tmp/icons-macos/icon.icns icons/icon.icns
```

## Customizing the macOS Install Window

> **Not a Pi release workflow yet:** the bundle identifiers are Pi's
> (`io.github.kayanoliam.pi-desktop`, plus `.dev` / `.beta` / `.nightly`) and
> the updater endpoints are empty, so a packaged build never polls Cline's
> feed, but the updater `pubkey`, the `desktop-publish` workflow, and the
> `publish-desktop` skill are still Cline's. Produce Pi builds with local
> packaging (below) or the manual `pi-desktop-package` workflow (see
> "Shareable Desktop Packages"); don't tag releases from the inherited
> workflow.

The drag-to-Applications window is configured by `bundle.macOS.dmg` in
[`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json). Its artwork comes
from the PNG sources in [`src-tauri/dmg/`](./src-tauri/dmg/); the
`background.gen.tiff` Finder actually renders is a gitignored build artifact
regenerated from them on every build.

1. The current source artwork is `640x400`. Export `background.png` at 1x and
   `background@2x.png` at 2x.
2. Currently the app icons are centered at `(140, 200)` and
   the Applications folder centered at `(500, 200)`. If updating artwork, update `appPosition`
   and `applicationFolderPosition` to reposition the app icons.
3. Build with `bun run build:binary`. Before compiling, the build validates
   both PNG dimensions, combines them with `tiffutil` into the Retina-aware
   `src-tauri/dmg/background.gen.tiff`, and verifies the TIFF contains the
   expected 1x and 2x representations. Run `bun run dmg:background` to do just
   that step, e.g. to sanity-check new artwork without a full build. The DMG
   is written beneath `src-tauri/target/release/bundle/dmg/`.

Run `bun run test:dmg-background` for the cross-platform checks covering the
committed PNG dimensions and TIFF validation logic.

The configured `640x432` Finder window is intentionally 32 points taller than
the `640x400` background. That extra height matches the Finder chrome in the
currently verified packaged layout; re-check it after material macOS or Finder
changes. The project deliberately uses a multi-resolution TIFF even though
Tauri's documented background formats are PNG, JPG, and GIF: Finder renders
both the 1x and 2x representations from a single background file. Re-check the
packaged DMG after upgrading Tauri in case its background validation changes.


## Login Shell PATH Resolution

Apps launched from Finder/the Dock inherit launchd's minimal `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), not the one your shell profiles build, so
agent-run commands would miss Homebrew-installed tools like `gh` even though
they work fine from a terminal. At startup the sidecar asks the user's login
shell — read from the account database via `getpwuid`, falling back to
`$SHELL` — for its `PATH` and merges it into `process.env.PATH`, which every
agent-spawned child (run_commands, MCP servers, Pi processes) inherits. The
same probe also imports the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY` and their lowercase forms), filling in only ones the
launcher left unset, so Dock-launched Pi reaches model APIs the way it does from
a terminal; the sidecar log names the imported variables, never their values.
Nothing else is imported, deliberately; other login-environment variables
(`SSH_AUTH_SOCK`, API keys, `JAVA_HOME`-style tool roots) are not pulled in. Set
`CLINE_SIDECAR_SKIP_SHELL_PATH=1` to disable. Implementation and details:
[`core shell-path.ts`](../../../sdk/packages/core/src/remote/shell-path.ts).

## SSH Remote Environments (legacy Cline infrastructure)

> **Not a native Pi feature.** The Pi desktop no longer exposes the Remote
> settings page or SSH host selection, and does not load saved SSH profiles.
> The shared Cline SDK and legacy backend infrastructure remain unchanged for
> other clients. The following describes that inherited infrastructure, not
> an available Pi desktop workflow.

Open **Settings → Remote** to add and test an SSH host. Saving or testing a
profile does not activate it. From the welcome chat, open the environment
selector beside the workspace picker and choose the saved host; that selection
starts the SSH connection at the remote user's home directory. Choose **Add
project…** from the normal workspace selector to browse that machine and select
a project, or choose **Local** in the environment selector to disconnect. Recent
and last-used workspaces are remembered separately for each SSH host and for
the local machine.

SSH config aliases are supported. Leave **Port** blank to use the alias's SSH
configuration (including its configured port), or enter a port to override it.
The desktop keeps its webview and native integration local; only the
authenticated Cline Hub protocol is forwarded through SSH. Agent tools,
workspace discovery, Git metadata, and session persistence therefore run on the
SSH host, while approvals and live session events return to the desktop.

The shared `@cline/core` `RemoteEnvironmentService` owns this feature; other
clients can use the same service and `ClineCore` remote backend (see `sdk/DOC.md`).
Desktop owns the settings UI and packaged helper resource lookup.

The service stores host metadata at
`~/.cline/data/settings/remote-environments.json` with mode `0600`. It stores an
identity-file path, never private-key contents. On first connect it uploads a
content-addressed, branch-matched, self-contained Hub helper under
`~/.cline/remote/`, binds the Hub to remote loopback, and forwards it to a
random local loopback port. Linux x64 and arm64 helpers are bundled by
`bun run build:sidecar:bin`; 32-bit Raspberry Pi operating systems are not
supported. macOS SSH targets need a locally built helper passed through
`CLINE_REMOTE_HELPER_BINARY` until the bundled helpers are codesigned for
notarization. The helper includes its own runtime. It is copied once per matching desktop build and cached, with no
`apt`, `npm`, root access,
global CLI install, or public Hub port. Disconnecting stops the desktop-owned
remote Hub but leaves the helper cached for a faster reconnect. The helper
imports the remote login-shell `PATH`, so user-installed Git, GitHub CLI, and
MCP executables remain visible.

Each service instance uses its own discovery record, so an existing Cline CLI/Hub on the
same account is neither replaced nor stopped. Both Hub processes can coexist
while the desktop is connected; this isolation keeps the remote helper separate from the default CLI Hub.

The desktop currently leaves file attachments and opening a remote file in a local
editor disabled. Text, images, file mentions/search, Git branch operations,
session history, and remote agent tools are supported. The current desktop
provider access/API token is sent through the authenticated tunnel for the
session; reusable OAuth refresh credentials are not copied into remote provider
settings.

For a real SSH acceptance run, `scripts/verify-ssh-poc.ts` accepts
`CLINE_SSH_TEST_HOST`, `CLINE_SSH_TEST_USER`, `CLINE_SSH_TEST_KEY`,
`CLINE_SSH_TEST_WORKSPACE`, and `CLINE_SSH_TEST_HELPER`. It starts a remote
connection at the SSH user's home, starts an agent session in the test
workspace with the selected desktop provider, asks the agent to read
`REMOTE_MARKER.txt`, then verifies the session appears in remote history and
that its messages can be read back.

## Web Visual System

The framework-neutral color, typography, radius, and navigation contract lives
in the internal [`@cline/ui`](../../../sdk/packages/ui/README.md) workspace
package. Other Cline web surfaces can take only its tokens or opt into the
Tailwind adapter and shared base styles without depending on the desktop
runtime. See [`webview/styles/README.md`](./webview/styles/README.md) for the
desktop integration notes.

## Releases & Auto-Updates

> **Inherited Cline process, not used for Pi.** Pi builds ship with empty
> updater endpoints and do not auto-update; the updater `pubkey` below is
> still Cline's. Pi test installers come from the manual `pi-desktop-package`
> workflow or local packaging (next section). The rest of this section
> describes Cline's release flow.

Releases are built, signed, notarized, and published by the `desktop-publish`
GitHub workflow as a single universal macOS DMG — one download that runs
natively on both Apple Silicon and Intel (macOS picks the matching slice at
launch, so users never choose an architecture). The step-by-step flow (version
bumps, changelog, tag, repo secrets) lives in the `publish-desktop` skill
(`.cline/skills/publish-desktop/SKILL.md`).

Installed apps auto-update via the Tauri updater: they poll the rolling
`desktop-latest` release's `latest.json` on launch and every 2 hours, install
updates in the background, and prompt for a restart. Two things must never be
lost: the `desktop-latest` release/tag (its feed URL is baked into shipped
apps) and the updater private key (`TAURI_SIGNING_PRIVATE_KEY` — without it,
shipped apps can't verify new updates).

There is also a beta channel ("Cline Beta", a separate app that installs
side by side with stable) cut from the `desktop-experimental` branch and
served by the rolling `desktop-beta` release — the same never-delete rule
applies to it. The experimental-branch process and beta release flow live in
[`EXPERIMENTAL.md`](./EXPERIMENTAL.md).

## Shareable Desktop Packages (manual fallback)

Tauri desktop bundles are OS-specific, so build each package on the target OS:

- macOS: `bun run package:desktop:mac`
- Windows: `bun run package:desktop:windows`
- Linux: `bun run package:desktop:linux`

To build on all platforms without local machines, run the
[`pi-desktop-package`](../../../.github/workflows/pi-desktop-package.yml)
workflow manually (`workflow_dispatch`). It builds SDK exports, then packages
macOS arm64 and x64 (`--allow-unsigned-mac`, ad-hoc signed DMG and zip),
Windows (`bunx tauri build --bundles nsis`; Tauri's WiX/MSI bundler rejects the
`0.1.0-beta.1` version) and Linux (`--bundles deb,rpm`; AppImage fails on the
runner). On Windows it seeds Bun's cache with the version-matched Linux
runtimes from Bun's official release ZIPs, because Bun's own cross-compile
extraction for the bundled SSH helpers fails there. On Linux the product name
is **Pi Desktop** (`src-tauri/tauri.linux.conf.json`), so the deb package is
`pi-desktop` rather than `pi`, which Ubuntu already uses for an unrelated
package; the job fails otherwise, and artifact names use `Pi-Desktop`.
Installers are uploaded as
workflow artifacts (30-day retention). The workflow only checks that each
installer exists: it does not sign, notarize, run tests or the app, publish a
release, or update any updater feed.

The macOS package script refuses to create a shareable package unless Developer ID signing and notarization credentials are configured. This prevents the common Gatekeeper failure where a downloaded unsigned build appears damaged on a teammate's Mac.

Set either `APPLE_CERTIFICATE` or `APPLE_SIGNING_IDENTITY`, plus one notarization credential set before packaging macOS:

- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- `APPLE_API_KEY` or `APPLE_API_KEY_PATH`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`

Without those credentials, use `bun run package:desktop:mac --allow-unsigned-mac`. Tauri then ad-hoc signs the bundle (`APPLE_SIGNING_IDENTITY=-`) so both the `.app` zip and the DMG under `dist/desktop/` (named `*-local-unsigned.*`) carry a signature, but nothing is notarized: on another Mac, Gatekeeper still blocks the download until the user chooses **Open Anyway** under System Settings → Privacy & Security, or runs `xattr -dr com.apple.quarantine "/Applications/Pi.app"`. Say so in the release notes.

### macOS signing & notarization, step by step

One-time keychain setup:

1. Get the **Developer ID Application** identity from your team admin. A `.cer` alone is not enough — you need the private key. If the admin generated the CSR, have them export the identity from Keychain Access as a `.p12` and import it:
   `security import BeeCertificates.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -T /usr/bin/security`
2. If `security find-identity -v -p codesigning` still reports `0 valid identities`, the Apple intermediate CA is missing. Install it:
   `curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && security import DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db`
3. Re-run `security find-identity -v -p codesigning` — it should now list `Developer ID Application: <Team Name> (<TEAMID>)`. That exact quoted string is your `APPLE_SIGNING_IDENTITY`.
4. Get an **App Store Connect API key** from the admin: the `AuthKey_<KEYID>.p8` file, the Key ID, and the Issuer ID (a UUID from App Store Connect → Users and Access → Integrations). This is used for notarization only — nothing is published.

Per-build:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Team Name> (<TEAMID>)"
export APPLE_API_KEY="<KEYID>"           # Tauri reads APPLE_API_KEY (the Key ID); APPLE_API_KEY_ID alone silently skips notarization
export APPLE_API_KEY_PATH="/path/to/AuthKey_<KEYID>.p8"
export APPLE_API_ISSUER="<issuer UUID>"
bun run package:desktop:mac
```

The first signing run pops a keychain dialog — enter your macOS login password and click **Always Allow**. Notarization uploads the app to Apple's automated malware scan (typically 2–10 minutes) and staples the ticket. Artifacts land in `dist/desktop/`; share the `.dmg`. The DMG name takes its version from `src-tauri/tauri.conf.json`, the zip name from `package.json` — bump both.

Do not remove `src-tauri/entitlements.plist` or the `bundle.macOS.entitlements` reference in `tauri.conf.json`: notarization requires the hardened runtime, which breaks the Bun-compiled sidecar (`SharedArrayBuffer is not defined`, surfacing in-app as "desktop backend endpoint not ready") unless the JIT entitlements are present.

## Runtime Overview

Startup flow:

1. Tauri starts a persistent local desktop backend and keeps only native window/file-picker/open-path responsibilities.
2. The desktop backend starts the Bun sidecar, which discovers or starts the
   canonical shared Cline Hub and exposes one websocket transport (`/transport`)
   for desktop commands, queries, and pushed events.
3. The React app uses `lib/desktop-client.ts` and no longer imports `@tauri-apps/api/core` directly in feature code.
4. Tool approval updates are pushed from the backend instead of polled from the UI.
5. Session process context resolves `workspaceRoot` from git root and uses that same path as default `cwd` for chat runtime and git operations unless explicitly overridden.

Desktop transport envelope:

- Request: `{ "type": "command", "id": string, "command": string, "args"?: object }`
- Response: `{ "type": "response", "id": string, "ok": boolean, "result"?: unknown, "error"?: string }`
- Event: `{ "type": "event", "event": { "name": string, "payload": unknown } }`

## Settings: Routine

- The Settings sidebar includes a `Routine` view for hub-backed automations.
- `Routine` lists all RPC schedules and shows status (`enabled`, `nextRunAt`, active execution).
- From the UI you can open a create form and add, pause/resume, trigger-now, and delete schedules.
- The view is wired to the same scheduler APIs used by `cline schedule` through Tauri commands and `scripts/routine-schedules.ts`.

## Key Files

- [`src-tauri/src/main.rs`](./src-tauri/src/main.rs) - Tauri shell lifecycle, backend launch, and native-only commands
- [`sidecar/index.ts`](./sidecar/index.ts) - persistent Bun sidecar and Hub-daemon entry dispatch
- [`sidecar/chat-session.ts`](./sidecar/chat-session.ts) - chat session router (Pi threads → `sidecar/pi/`, else shared Hub)
- [`sidecar/pi/pi-session-manager.ts`](./sidecar/pi/pi-session-manager.ts) - Pi RPC processes, event translation, approvals
- [`sidecar/pi/pi-session-files.ts`](./sidecar/pi/pi-session-files.ts) - read-only Pi session history
- [`sidecar/pi/pi-slash-commands.ts`](./sidecar/pi/pi-slash-commands.ts) - Pi builtin slash commands, desktop UI actions, guidance
- [`sidecar/pi/pi-extensions.ts`](./sidecar/pi/pi-extensions.ts) - installed Pi extensions: list, enable/disable, uninstall
- [`sidecar/pi/pi-desktop-gate-extension.ts`](./sidecar/pi/pi-desktop-gate-extension.ts) - generated tool-approval gate and tree-navigation command
- [`webview/lib/desktop-client.ts`](./webview/lib/desktop-client.ts) - typed desktop websocket client
- [`webview/hooks/use-chat-session.ts`](./webview/hooks/use-chat-session.ts) - UI chat session state + backend subscriptions
- [`webview/lib/chat-schema.ts`](./webview/lib/chat-schema.ts) - chat message schema used by the UI
- [`webview/components/views/settings/routine-view.tsx`](./webview/components/views/settings/routine-view.tsx) - Routine schedules UI

## Data + Storage

- Session artifacts are written under `~/.cline/data/sessions/<sessionId>/` (or `CLINE_SESSION_DATA_DIR`).
- Canonical replay/export artifact: `<sessionId>.messages.json`.
- `<sessionId>.messages.json` is expected to contain ordered messages plus assistant `modelInfo` and `metrics` (including cache token fields when provided by the model runtime).
- `<sessionId>.hooks.jsonl` is observability/debug telemetry and should not be required for normal history replay/export flows.
- Full v1 schema for the persisted messages file, including failure/retry semantics and golden fixtures, is documented in [`packages/core/docs/messages-contract-v1.md`](../../../sdk/packages/core/docs/messages-contract-v1.md).

## Sidecar observability

The desktop sidecar sends SDK telemetry through the same configured OpenTelemetry
pipeline used by the CLI and writes structured runtime logs to
`~/.cline/data/logs/code.log` by default. Telemetry continues to honor the global
opt-out setting exposed in the desktop settings UI. The sidecar truncates stale
logs and rotates the active file before it exceeds 50 MiB.

Logging can be configured with the same environment variables as the CLI:

- `CLINE_LOG_ENABLED=0` disables file logging.
- `CLINE_LOG_LEVEL` sets the Pino level (for example, `debug` or `warn`).
- `CLINE_LOG_PATH` overrides the log destination.
- `CLINE_LOG_NAME` overrides the logger name.

In a development webview, sidecar voice-input diagnostics are also streamed to
the webview console as `[desktop:voice-input]` entries. Production builds can
enable the same console stream with `NEXT_PUBLIC_CLINE_DEBUG_LOGS=1` at build
time, or at runtime from DevTools with
`localStorage.setItem("cline.debugLogs", "1")` followed by a reload. Diagnostic
events include the selected provider/model and sanitized endpoint, but never
credentials, request headers, recorded audio, or transcript contents.

## Troubleshooting

- If live updates stall, verify the desktop backend websocket is connected and `chat_event` messages are arriving.
- Tauri restarts the desktop backend if the sidecar process exits and kills it on app teardown.
- Chat sends now preflight provider credentials. If a provider that requires API-key auth is selected without a key, the UI blocks the turn with a clear error message instead of starting a hanging session.
- If a turn completes with `finishReason=error` before any assistant content is produced, the UI now adds an explicit error chat message so failed turns are visible in the transcript.
- If package changes are not reflected, rebuild SDK packages (`bun run build:sdk`).
  The next desktop or CLI Hub connection will reuse a compatible running Hub or
  replace an incompatible one through the shared discovery path.
- Provider settings updates are patch-style: only fields you edit are changed. Unset fields are preserved instead of being cleared.
- Speech input requires an enabled provider whose models.dev metadata identifies
  a dedicated `audio`-to-`text` model, or the built-in ElevenLabs provider with
  its Scribe v2 model. Choose the voice input provider and model explicitly under
  **Settings → Models → Voice input**. That selection is stored separately from
  the chat model as `modes.voiceInput` in
  `~/.cline/data/settings/providers.json`; provider credentials remain in their
  existing provider entry and never enter the webview. ElevenLabs uses its native
  `/v1/speech-to-text` API. Text-to-speech models with `output: ["audio"]` are
  not used for microphone transcription.
- Streaming transcription models, such as Vercel AI Gateway's
  `openai/gpt-realtime-whisper`, update the composer while the user speaks.
  The sidecar mints a short-lived transcription token; the long-lived gateway
  credential is never sent to the webview. Batch models such as
  `openai/whisper-1` continue to transcribe after recording stops.

SSH requires an already-trusted host key. Before first connection, verify the server fingerprint through a trusted channel and enroll it with your SSH client. Unknown or changed keys are rejected.
