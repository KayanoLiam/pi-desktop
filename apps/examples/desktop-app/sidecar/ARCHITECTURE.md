# Sidecar Architecture — @cline/code

## Overview

The sidecar is a Bun process that adapts the desktop UI and native operations to
two execution runtimes: the user's installed **Pi CLI** (new local threads) and
the inherited shared **Cline Hub** (existing Cline sessions, SSH environments).

It imports `@cline/core`, discovers or starts the canonical shared Hub, registers
as a Hub client, and serves the Next.js frontend over HTTP + WebSocket. The
sidecar does not own a private agent runtime Hub.

## Directory Structure

```
sidecar/
├── index.ts              # Entry point: starts HTTP+WS server
├── server.ts             # Bun HTTP server + WebSocket handlers
├── context.ts            # SidecarContext type and factory
├── client-context.ts     # Desktop client/account identity for shared telemetry
├── commands.ts           # Command router
├── chat-session.ts       # Chat session router (Pi threads → pi/, else shared Hub / cloud)
├── pi/                   # Pi execution runtime
│   ├── pi-rpc-process.ts          # `pi --mode rpc` JSONL client (spawn, request ids, events)
│   ├── pi-session-manager.ts      # One Pi process per active thread; Pi events → desktop events
│   ├── pi-session-files.ts        # Read-only ~/.pi/agent/sessions parsing + transcript projection
│   ├── pi-session-metadata.ts     # Desktop-only annotations (pinned) for Pi sessions
│   ├── pi-desktop-gate-extension.ts # Generated tool_call hook that routes approvals to the desktop
│   └── pi-config-watcher.ts       # Follows Pi CLI installs/settings edits → pi_config_changed
├── cloud-sessions.ts     # Cloud session REST client + Hub-proxy manager
├── cline-auth.ts         # Refresh-aware Cline auth token resolution
├── desktop-settings.ts   # Desktop-owned settings (cloud sessions opt-in)
├── feature-flags.ts      # Cloud sessions gate (env override + settings toggle)
├── session-data/         # Shared discovery, messages, artifacts, search helpers
├── paths.ts              # Path resolution
├── types.ts              # Shared types
└── ARCHITECTURE.md       # This file
```

## Transport Protocol (unchanged)

```
Request:  { "type": "command", "id": string, "command": string, "args"?: object }
Response: { "type": "response", "id": string, "ok": boolean, "result"?: unknown, "error"?: string }
Event:    { "type": "event", "event": { "name": string, "payload": unknown } }
```

## Key Design Decisions

### 0. Pi Threads — One `pi --mode rpc` Process per Session

`handleChatSessionCommand` routes a request to `PiSessionManager` when the
config says `runtime: "pi"` or the session id belongs to a Pi session on disk
(local environment only). The manager spawns the installed `pi`
(`PI_DESKTOP_PI_BIN` or `PATH`) with `--session-id <id>` (new) or
`--session <file>` (resume), `--model provider/id --thinking level`, and
`--extension <gate>`; the working directory is the thread workspace. Pi loads
the user's real extensions, packages and credentials, so this is not a sandbox.

Pi events are translated into the same transport the webview already consumes
for Cline sessions (`chat_text`, `chat_reasoning`, `chat_tool_call_*`,
`chat_usage`, `chat_done`, `chat_queued_prompt_start`, `chat_session_status`,
`chat_session_ended`, `prompts_in_queue_state`). A blocking `send` resolves at
`agent_settled` with the same result shape as the Cline path.

Tool approvals: Pi has no built-in approval, so the sidecar writes a small
`tool_call` hook extension (`~/.cline/data/pi-desktop/extensions/`) that asks
through `ctx.ui.confirm("pi-desktop:tool-approval", <json>)`. In RPC mode that
arrives as `extension_ui_request`; the sidecar auto-confirms when the thread
auto-approves (default) or registers a pending approval in `ctx.pendingApprovals`
and answers with `extension_ui_response` once the webview responds. Other
extension dialogs (`select`/`input`/`editor`/`confirm`) become
`ask_question_requested` items; `notify` becomes a `chat_core_log` entry.

Session history comes from Pi's own files: `pi-session-files.ts` parses the
JSONL tree read-only (never through `SessionManager.open()`, which rewrites old
versions), projects the active branch into `ChatMessage` rows, appends
`session_info` for renames, and deletes files on request. Idle processes are
reaped after 10 minutes and recreated transparently on the next send.

`pi-config-watcher.ts` compares a stat signature of `settings.json`,
`models.json`, `auth.json`, `npm/`, `git/` and `extensions/`; on change it marks
live processes stale (restart after their run or compaction), clears the slash-command cache,
and broadcasts `pi_config_changed` so the webview reloads its catalog.

### 1. Chat Sessions — Shared Hub Client

`ClineCore` uses Hub mode without an explicit endpoint. Core therefore reuses
the same compatible Hub discovered by the CLI or starts the canonical detached
Hub when the desktop is the first client:

```typescript
const sessionManager = await ClineCore.create({
  clientName: "cline-code",
  backendMode: "hub",
  hub: {
    strategy: "require-hub",
    workspaceRoot,
    cwd: workspaceRoot,
    clientType: "code-sidecar",
    displayName: "Cline Desktop sidecar",
  },
  capabilities: {
    requestToolApproval: async (request) => {
      // Push approval request to frontend via WebSocket event
      broadcastEvent("tool_approval_state", { sessionId: request.sessionId, items: [request] });
      // Wait for frontend response
      return await waitForApprovalResponse(request.sessionId, request.toolCallId);
    },
  },
});

// Start session
const { sessionId } = await sessionManager.start({
  config: coreSessionConfig,
  prompt: "...",
});

// Send follow-up
await sessionManager.send({ sessionId, prompt: "..." });

// Subscribe to streaming events
sessionManager.subscribe((event) => {
  // Forward to WebSocket clients as chat_text, chat_reasoning, etc.
  broadcastEvent("chat_event", event);
});
```

The compiled sidecar also recognizes Core's Hub-daemon launch mode. This lets
the desktop start the same detached Hub when no CLI process has started it yet.
Startup discovery and locking ensure concurrent clients converge on one Hub.

Every create, restart, fork, and restore also attaches the serializable Desktop
`ExtensionContext.client` and current `ExtensionContext.user`. Core forwards
that context across the Hub transport and scopes the daemon-owned telemetry
service to the originating surface. This keeps lifecycle events centralized in
Core while reporting Desktop dimensions (`cline_type: "desktop"`, `platform:
"Cline Desktop"`, and the Desktop app version) and the current account and
organization. The shared Hub telemetry singleton is never mutated per session,
so concurrent CLI and Desktop tasks retain their own attribution.

### 2. Tool Approval — Client-Owned Promise Resolution

The shared Hub routes approval requests back to the client that created the
session. Desktop approvals use in-memory promise maps while the webview is
online:

```typescript
const pendingApprovals = new Map<string, {
  resolve: (result: ToolApprovalResult) => void | Promise<void>;
  request: ToolApprovalRequest;
}>();

// When core requests approval → store promise, push to frontend
// When frontend responds → resolve promise
```

Cloud sessions route approvals the same way, but the resolver forwards the
response to the sandbox Hub (`approval.respond`), which is why `resolve` may
be async.

### 3. Provider Management — Direct ProviderSettingsManager

```typescript
import { ProviderSettingsManager, listLocalProviders, ... } from "@cline/core";
const manager = new ProviderSettingsManager();
```

### 4. Session Storage — Direct SqliteSessionStore

```typescript
import { SqliteSessionStore, resolveSessionBackend } from "@cline/core";
const store = new SqliteSessionStore();
```

### 5. Routine Schedules — Direct Hub Commands

Routine operations use the same connected Hub client as chat session
observation. They never start a second in-process Hub:

```typescript
await ctx.hubClient.command("schedule.list", { limit: 200 });
```

### 6. Native Commands

- `pick_workspace_directory` — Uses macOS `osascript` / Linux `zenity` for directory picker
- `open_mcp_settings_file` — Uses `open` / `xdg-open` to open files

### 7. Frontend Connection

The frontend `desktop-client.ts` connects directly to the sidecar WebSocket:
- Discovers endpoint from `window.__SIDECAR_WS_ENDPOINT__` or defaults to `ws://127.0.0.1:3126/transport`
- No Tauri dependency needed
- Same `invoke()` / `subscribe()` API

## Command Map

The model picker first uses `list_provider_catalog`, which reads the bundled and
registered models without network access. It then calls `list_provider_models`
for the active provider, both on mount and when the provider changes. All built-in
providers backed by the shared catalog refresh from the live feed (including
OpenCode); concurrent requests share one fetch and reuse its ten-minute cache.
Endpoint-owned lists such as Baseten, Hicap, Poolside, LiteLLM, Ollama, and LM Studio use their existing
discovery endpoints instead. Catalog and public endpoint requests time out after
five seconds, and the initial picker remains usable while a refresh is pending.
The sidecar omits bundled `knownModels` from the discovery config so they cannot
override live metadata; explicitly registered model overrides retain precedence.

Supported commands:

| Command | Implementation |
|---------|---------------|
| `chat_session_command` | Pi threads → `PiSessionManager`; else shared Hub through `ClineCore`; cloud sessions route to `CloudSessionManager` |
| `list_pi_model_catalog` | `listPiModelCatalog()` (Pi config + installed-Pi RPC discovery) |
| `list_pi_commands` | `PiSessionManager.listCommands()` (`get_commands` from the live or a discovery Pi process, plus bare builtin names; builtins win name collisions and remain if discovery fails) |
| `execute_pi_command` | `PiSessionManager.executeCommand()` — known Pi builtins (`/compact`, `/name`, `/session`, `/export` HTML, desktop uiActions). Unknown/extension/prompt/skill text returns `handled: false`. Terminal-only builtins return guidance and are not sent to the model. |
| `list_provider_catalog` | `ProviderSettingsManager` + `listLocalProviders` |
| `list_provider_models` | `getLocalProviderModels` |
| `save_voice_input_settings` | validates and persists the selected transcription provider/model |
| `create_streaming_transcription_session` | mints a short-lived, transcription-bound browser token without exposing provider credentials |
| `transcribe_audio` | configured voice input selection + provider credentials |
| `save_provider_settings` | `saveLocalProviderSettings` |
| `add_provider` | `addLocalProvider` |
| `run_provider_oauth_login` | `loginLocalProvider` |
| `list_chat_sessions` | `SqliteSessionStore` + file discovery, merged with cloud sessions |
| `list_discovered_sessions` | Merged discovery (Pi session files + local + cloud) |
| `read_session_messages` | Pi sessions from `~/.pi/agent/sessions`; else session data readers; cloud sessions read through the sandbox Hub |
| `read_session_hooks` | Session data readers |
| `delete_chat_session` | Pi sessions delete the `.jsonl`; else `SqliteSessionStore.delete` + file cleanup; cloud sessions also delete the sandbox |
| `update_chat_session_title` | Pi sessions append `session_info` (or `set_session_name` when live); else `resolveSessionBackend().updateSession`; cloud sessions PATCH the cloud API |
| `get_feature_flags` | `isCloudAgentsEnabled()` (env override + settings toggle) |
| `get_desktop_settings` | `readDesktopSettings()` |
| `set_cloud_sessions_enabled` | `setCloudSessionsEnabled()` + `feature_flags_changed` broadcast |
| `list_cloud_repositories` | `CloudSessionManager.listRepositories()` (GitHub integration) |
| `list_cloud_branches` | `CloudSessionManager.listBranches()` (paginated) |
| `list_mcp_servers` | Direct file I/O |
| `authorize_mcp_server_oauth` | Explicit Connect action → cancellable `authorizeMcpServerOAuth` + system browser |
| `cancel_mcp_server_oauth` | Cancel the pending MCP OAuth callback wait |
| `upsert_mcp_server` | Direct file I/O |
| `delete_mcp_server` | Direct file I/O |
| `get_git_branch` | async `execFile("git", ...)` |
| `list_git_branches` | async `execFile("git", ...)` |
| `checkout_git_branch` | async `execFile("git", ...)` |
| `create_git_worktree` | async `execFile("git", ...)` → `~/.cline/worktrees/<id>/<repo>` |
| `search_workspace_files` | `getFileIndex` |
| `get_process_context` | In-memory context |
| `poll_tool_approvals` | In-memory pending map |
| `respond_tool_approval` | In-memory promise resolution |
| `poll_ask_questions` | In-memory pending map |
| `respond_ask_question` | In-memory promise resolution |
| `list_routine_schedules` | shared Hub schedule commands |
| `list_user_instruction_configs` | Direct core API |
| `pick_workspace_directory` | OS native dialog |
| `open_mcp_settings_file` | OS `open` command |

## Dev Workflow

```bash
bun run dev:headless  # Start sidecar and Next.js with a fresh shared approval credential
bun run dev:sidecar   # Start only the sidecar (no browser approval surface)
bun run dev:web       # Start only Next.js (no authenticated approval connection)
bun run dev           # Both concurrently
```
