import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	deleteMaterializedAttachments,
	materializeUserFiles,
} from "../attachments";
import {
	emitChunk,
	getEnvironmentContext,
	getOwnerContext,
	sendEvent,
	sendEventToClient,
} from "../context";
import {
	type ChatSessionCommandRequest,
	type ExecutePiCommandResult,
	type JsonRecord,
	LOCAL_ENVIRONMENT_ID,
	type PendingAskQuestion,
	type PendingToolApproval,
	type PromptInQueue,
	type SidecarContext,
} from "../types";
import {
	ensurePiDesktopGateExtension,
	parsePiToolApprovalRequest,
} from "./pi-desktop-gate-extension";
import {
	isPiExtensionUiRequest,
	type PiRpcEvent,
	type PiRpcExit,
	PiRpcProcess,
} from "./pi-rpc-process";
import {
	type PiChatMessage,
	PiSessionFiles,
	type PiSessionSummary,
	piToolPresentation,
	piToolResultText,
} from "./pi-session-files";
import { PiSessionMetadataStore } from "./pi-session-metadata";
import {
	desktopUiCommand,
	formatCompactionMessage,
	formatSessionInfo,
	mergeBuiltinCommands,
	PI_JSONL_EXPORT_GUIDANCE,
	piBuiltinCommandName,
	piCommandRemainder,
	piPathArgument,
	unsupportedBuiltinGuidance,
} from "./pi-slash-commands";

/**
 * Runs desktop threads through the user's installed Pi CLI: one
 * `pi --mode rpc` process per active session, Pi's own session files as the
 * source of truth, and Pi's events translated into the same `chat_event`
 * streams, status events, approval and ask-question maps the webview already
 * consumes for Cline sessions.
 */

export type PiSlashCommand = {
	name: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
};

type RunResult = {
	text: string;
	finishReason: "completed" | "aborted" | "error";
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		totalCost: number;
	};
	toolCalls: Array<{
		name: string;
		input?: unknown;
		output?: unknown;
		error?: string;
	}>;
	messages?: unknown[];
};

type ActiveRun = {
	/** The prompt sent while idle; its user message_start must not re-announce it. */
	directPromptPending: boolean;
	aborted: boolean;
	errorMessage?: string;
	lastAssistantText: string;
	usage: RunResult["usage"];
	toolCalls: RunResult["toolCalls"];
	messages?: unknown[];
	resolve: (result: RunResult) => void;
	done: Promise<RunResult>;
};

type PiLiveSession = {
	sessionId: string;
	process: PiRpcProcess;
	cwd: string;
	sessionFile?: string;
	config: JsonRecord;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	busy: boolean;
	/** Manual `/compact` is in flight. Distinct from a model turn so send cannot queue over it. */
	compacting: boolean;
	stale: boolean;
	lastActivityAt: number;
	run: ActiveRun | null;
	queue: { steering: string[]; followUp: string[] };
	queuedPromptCounter: number;
	toolOutputs: Map<string, string>;
	toolNames: Map<string, string>;
	pendingUi: Set<string>;
	unsubscribe: () => void;
};

export type PiSessionManagerOptions = {
	files?: PiSessionFiles;
	metadata?: PiSessionMetadataStore;
	agentDir?: () => string;
	binary?: string;
	env?: () => NodeJS.ProcessEnv;
	idleTtlMs?: number;
	reapIntervalMs?: number;
	startupTimeoutMs?: number;
	/** Manual `/compact` waits longer than the default RPC timeout; it calls the model. */
	compactTimeoutMs?: number;
	gateExtensionPath?: () => string;
};

const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const COMMANDS_CACHE_TTL_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
/** Summarization can outlive the 30s RPC default. A finite timeout still fails closed. */
const DEFAULT_COMPACT_TIMEOUT_MS = 5 * 60_000;
const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

export function getPiSessionManager(ctx: SidecarContext): PiSessionManager {
	const owner = getOwnerContext(ctx);
	if (!owner.pi) {
		owner.pi = new PiSessionManager(owner);
	}
	return owner.pi;
}

export class PiSessionManager {
	readonly files: PiSessionFiles;
	/** Desktop-only annotations (pinned, …) keyed by Pi session id. */
	readonly metadata: PiSessionMetadataStore;
	private readonly ctx: SidecarContext;
	private readonly live = new Map<string, PiLiveSession>();
	private readonly options: PiSessionManagerOptions;
	private readonly commandsCache = new Map<
		string,
		{ at: number; commands: PiSlashCommand[] }
	>();
	private readonly reaper: ReturnType<typeof setInterval> | null;
	private disposed = false;

	constructor(ctx: SidecarContext, options: PiSessionManagerOptions = {}) {
		this.ctx = getEnvironmentContext(
			getOwnerContext(ctx),
			LOCAL_ENVIRONMENT_ID,
		);
		this.options = options;
		this.files =
			options.files ??
			new PiSessionFiles(options.agentDir ?? (() => getAgentDir()));
		this.metadata = options.metadata ?? new PiSessionMetadataStore();
		const reapInterval = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
		this.reaper =
			reapInterval > 0
				? setInterval(() => void this.reapIdle(), reapInterval)
				: null;
		this.reaper?.unref?.();
	}

	// ── Queries ────────────────────────────────────────────────────────────

	/** True for live processes and for sessions Pi has on disk. */
	owns(sessionId: string): boolean {
		return (
			this.live.has(sessionId) || this.files.findById(sessionId) !== undefined
		);
	}

	isLive(sessionId: string): boolean {
		return this.live.has(sessionId);
	}

	status(sessionId: string): "running" | "idle" | undefined {
		const live = this.live.get(sessionId);
		if (!live) return undefined;
		return live.busy ? "running" : "idle";
	}

	runningCount(): number {
		let count = 0;
		for (const live of this.live.values()) if (live.busy) count += 1;
		return count;
	}

	/** Pi sessions as desktop discovery records (merged into the sidebar). */
	listDiscovered(limit = 300): JsonRecord[] {
		return this.files
			.list()
			.slice(0, Math.max(1, limit))
			.map((summary) => this.toDiscoveryRecord(summary));
	}

	getDiscovered(sessionId: string): JsonRecord | undefined {
		const summary = this.files.findById(sessionId);
		return summary ? this.toDiscoveryRecord(summary) : undefined;
	}

	readMessages(sessionId: string): PiChatMessage[] | undefined {
		const summary = this.files.findById(sessionId);
		if (!summary) return undefined;
		try {
			return this.files.readMessages(summary.path);
		} catch {
			return [];
		}
	}

	// ── chat_session_command dispatch ──────────────────────────────────────

	async handle(request: ChatSessionCommandRequest): Promise<unknown> {
		switch (request.action) {
			case "start":
				return this.start(request);
			case "attach":
				return this.attach(request);
			case "send":
				return this.send(request);
			case "abort":
				return this.abort(request);
			case "stop":
				return this.stop(request);
			case "reset":
				return this.reset(request);
			case "pending_prompts":
				return this.pendingPrompts(request);
			default:
				throw new Error(
					`${request.action} is not supported for Pi sessions yet`,
				);
		}
	}

	async start(request: ChatSessionCommandRequest): Promise<unknown> {
		const config = request.config ?? {};
		const requestedSessionId = String(
			config.sessionId ?? config.session_id ?? "",
		).trim();
		const sessionId =
			requestedSessionId || `session_${Date.now()}_${randomUUID().slice(0, 5)}`;
		const existing = this.live.get(sessionId);
		if (existing) {
			existing.config = { ...existing.config, ...config };
			await this.applyModelSelection(existing);
			return this.startResult(existing);
		}
		const summary = this.files.findById(sessionId);
		const live = summary
			? await this.spawn(sessionId, config, { resume: summary })
			: await this.spawn(sessionId, config, { create: true });
		return this.startResult(live);
	}

	async attach(request: ChatSessionCommandRequest): Promise<unknown> {
		const sessionId = request.sessionId?.trim();
		if (!sessionId) throw new Error("sessionId is required");
		const live = this.live.get(sessionId);
		const summary = this.files.findById(sessionId);
		if (!live && !summary) throw new Error(`Pi session ${sessionId} not found`);
		if (live && request.config)
			live.config = { ...live.config, ...request.config };
		const cwd = live?.cwd ?? summary?.cwd ?? "";
		return {
			sessionId,
			environmentId: LOCAL_ENVIRONMENT_ID,
			status: this.status(sessionId) ?? "completed",
			provider: live?.provider ?? summary?.provider ?? "",
			model: live?.model ?? summary?.model ?? "",
			cwd,
			workspaceRoot: cwd,
			prompt: summary?.firstMessage,
			metadata: summary?.name ? { title: summary.name } : undefined,
		};
	}

	async send(request: ChatSessionCommandRequest): Promise<unknown> {
		const sessionId = request.sessionId?.trim();
		if (!sessionId) throw new Error("sessionId is required");
		const prompt = request.prompt?.trim() ?? "";
		const userImages = request.attachments?.userImages ?? [];
		const userFiles = request.attachments?.userFiles ?? [];
		if (!prompt && userImages.length === 0 && userFiles.length === 0) {
			throw new Error("prompt or attachment is required");
		}
		// Known builtins never become a model turn. Interactive Pi runs them
		// before extension/template expansion, so a colliding extension must not
		// win by falling through to RPC `prompt`.
		const builtin = piBuiltinCommandName(prompt);
		if (builtin) {
			throw new Error(
				`Builtin Pi command /${builtin} must be handled via execute_pi_command, not sent as a prompt.`,
			);
		}
		let live = this.live.get(sessionId);
		if (!live) {
			const summary = this.files.findById(sessionId);
			if (!summary) throw new Error(`Pi session ${sessionId} not found`);
			live = await this.spawn(sessionId, request.config ?? {}, {
				resume: summary,
			});
		} else if (request.config) {
			live.config = { ...live.config, ...request.config };
			if (!live.busy) await this.applyModelSelection(live);
		}
		if (live.compacting) {
			throw new Error(
				"Pi is compacting this session. Wait for compaction to finish, then retry.",
			);
		}
		live.lastActivityAt = Date.now();
		const images = userImages.flatMap((image) => {
			const match = IMAGE_DATA_URL.exec(image.trim());
			return match
				? [{ type: "image" as const, data: match[2], mimeType: match[1] }]
				: [];
		});
		const materialized = materializeUserFiles(sessionId, userFiles);
		const message = materialized?.length
			? `${prompt}${prompt ? "\n\n" : ""}Attached files (read them with the read tool):\n${materialized
					.map((path) => `- ${path}`)
					.join("\n")}`
			: prompt;
		const delivery =
			request.delivery ?? (live.busy || live.run ? "queue" : undefined);
		if (delivery === "queue" || delivery === "steer") {
			const accepted = await live.process.request({
				type: "prompt",
				message,
				...(images.length > 0 ? { images } : {}),
				streamingBehavior: delivery === "steer" ? "steer" : "followUp",
			});
			if (!accepted.success) {
				deleteMaterializedAttachments(sessionId, materialized);
				throw new Error(accepted.error);
			}
			return {
				sessionId,
				ok: true,
				queued: true,
				promptsInQueue: this.queueSnapshot(live),
			};
		}
		const run = this.beginRun(live);
		this.ctx.logger?.debug("Sending Pi prompt", {
			sessionId,
			promptLength: message.length,
		});
		let accepted: Awaited<ReturnType<PiRpcProcess["request"]>>;
		try {
			accepted = await live.process.request({
				type: "prompt",
				message,
				...(images.length > 0 ? { images } : {}),
			});
		} catch (error) {
			this.finishRun(live, {
				finishReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			deleteMaterializedAttachments(sessionId, materialized);
			return {
				sessionId,
				ok: true,
				result: {
					finishReason: "error",
					text: error instanceof Error ? error.message : String(error),
				},
			};
		}
		if (!accepted.success) {
			if (/streaming/i.test(accepted.error)) {
				// Lost the race with a run Pi started meanwhile: queue instead.
				this.finishRun(live, { finishReason: "completed", silent: true });
				const queued = await live.process.request({
					type: "prompt",
					message,
					...(images.length > 0 ? { images } : {}),
					streamingBehavior: "followUp",
				});
				if (queued.success) {
					return {
						sessionId,
						ok: true,
						queued: true,
						promptsInQueue: this.queueSnapshot(live),
					};
				}
			}
			this.finishRun(live, {
				finishReason: "error",
				errorMessage: accepted.error,
				silent: true,
			});
			deleteMaterializedAttachments(sessionId, materialized);
			this.log(sessionId, "error", accepted.error);
			return {
				sessionId,
				ok: true,
				result: { finishReason: "error", text: accepted.error },
			};
		}
		const result = await run.done;
		deleteMaterializedAttachments(sessionId, materialized);
		this.ctx.logger?.log("Pi prompt completed", {
			sessionId,
			finishReason: result.finishReason,
			textLength: result.text.length,
		});
		return { sessionId, ok: true, result };
	}

	async abort(request: ChatSessionCommandRequest): Promise<unknown> {
		const sessionId = request.sessionId?.trim();
		if (!sessionId) throw new Error("sessionId is required");
		const live = this.live.get(sessionId);
		if (!live) return { sessionId, ok: true };
		if (live.run) live.run.aborted = true;
		this.cancelPendingUi(live, "Run aborted");
		const answered = await Promise.race([
			live.process.request({ type: "abort" }, { timeoutMs: null }).then(
				() => true,
				() => false,
			),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
		]);
		if (!answered) {
			// Pi is wedged: drop the process; the exit handler settles the run.
			await live.process.kill(1_000);
		}
		return { sessionId, ok: true };
	}

	async stop(request: ChatSessionCommandRequest): Promise<unknown> {
		const sessionId = request.sessionId?.trim();
		if (!sessionId) throw new Error("sessionId is required");
		await this.terminate(sessionId, "Session stopped");
		return { sessionId, ok: true };
	}

	async reset(request: ChatSessionCommandRequest): Promise<unknown> {
		const sessionId = request.sessionId?.trim();
		if (sessionId) await this.terminate(sessionId, "Session reset");
		return { sessionId: request.sessionId, ok: true };
	}

	async pendingPrompts(request: ChatSessionCommandRequest): Promise<unknown> {
		const sessionId = request.sessionId?.trim();
		if (!sessionId) throw new Error("sessionId is required");
		const live = this.live.get(sessionId);
		return {
			sessionId,
			promptsInQueue: live ? this.queueSnapshot(live) : [],
		};
	}

	// ── Session metadata ───────────────────────────────────────────────────

	async setSessionName(sessionId: string, name: string): Promise<boolean> {
		const live = this.live.get(sessionId);
		if (live) {
			const response = await live.process.request({
				type: "set_session_name",
				name,
			});
			if (!response.success) throw new Error(response.error);
			if (live.sessionFile) this.files.summarize(live.sessionFile);
			return true;
		}
		const summary = this.files.findById(sessionId);
		if (!summary) return false;
		this.files.rename(summary.path, name);
		return true;
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		const summary = this.files.findById(sessionId);
		await this.terminate(sessionId, "Session deleted");
		this.metadata.delete(sessionId);
		if (!summary) return false;
		return this.files.delete(summary.path);
	}

	/** Free-text search over titles, prompts and transcript text of Pi sessions. */
	search(query: string, limit: number, workspaceRoot?: string): JsonRecord[] {
		const needle = query.trim().toLowerCase();
		if (!needle) return [];
		const hits: JsonRecord[] = [];
		for (const summary of this.files.list()) {
			if (workspaceRoot && summary.cwd !== workspaceRoot) continue;
			const title = (
				summary.name ??
				summary.firstMessage.split("\n")[0] ??
				""
			).trim();
			const haystack = [
				title,
				summary.firstMessage,
				summary.cwd,
				summary.model ?? "",
				summary.searchText,
			]
				.join("\n")
				.toLowerCase();
			if (!haystack.includes(needle)) continue;
			const snippetSource = summary.searchText;
			const at = snippetSource.indexOf(needle);
			const snippet =
				at >= 0
					? snippetSource
							.slice(Math.max(0, at - 60), at + needle.length + 60)
							.replace(/\s+/g, " ")
							.trim()
					: summary.firstMessage.slice(0, 120);
			hits.push({
				sessionId: summary.id,
				documentId: `${summary.id}:pi`,
				ordinal: -1,
				role: "session",
				title: title || summary.id,
				snippet,
				workspaceRoot: summary.cwd,
				startedAt: new Date(summary.createdAt).toISOString(),
				updatedAt: new Date(summary.modifiedAt).toISOString(),
				environmentId: LOCAL_ENVIRONMENT_ID,
				source: "pi",
			});
			if (hits.length >= limit) break;
		}
		return hits;
	}

	// ── Slash commands from Pi ─────────────────────────────────────────────

	async listCommands(workspaceRoot: string): Promise<PiSlashCommand[]> {
		const key = workspaceRoot.trim();
		const cached = this.commandsCache.get(key);
		if (cached && Date.now() - cached.at < COMMANDS_CACHE_TTL_MS) {
			return cached.commands;
		}
		const live = [...this.live.values()].find((entry) => entry.cwd === key);
		let discovered: PiSlashCommand[] = [];
		let discoveryFailed = false;
		try {
			if (live) {
				const response = await live.process.request<{ commands?: unknown }>(
					{ type: "get_commands" },
					{ timeoutMs: 15_000 },
				);
				if (!response.success) {
					throw new Error(response.error || "get_commands failed");
				}
				discovered = normalizeCommands(response.data?.commands);
			} else {
				discovered = await this.discoverCommands(key);
			}
		} catch (error) {
			discoveryFailed = true;
			this.ctx.logger?.debug("Pi command discovery failed", { error });
			discovered = [];
		}
		// Builtins stay listed when discovery fails, and they replace a colliding
		// extension/template/skill because interactive Pi does the same.
		// A failed discovery is not cached, so the next menu open can retry.
		const commands = mergeBuiltinCommands(discovered);
		if (!discoveryFailed) {
			this.commandsCache.set(key, { at: Date.now(), commands });
		}
		return commands;
	}

	/**
	 * Run one Pi slash command. Unknown text returns `handled: false` so the
	 * existing extension/template/skill pipeline is unchanged. Errors throw.
	 */
	async executeCommand(input: {
		sessionId?: string;
		workspaceRoot?: string;
		text: string;
	}): Promise<ExecutePiCommandResult> {
		const text = input.text?.trim() ?? "";
		if (!text) throw new Error("text is required");
		const name = piBuiltinCommandName(text);
		if (!name) return { handled: false };
		const ui = desktopUiCommand(name, text);
		if (ui) {
			if (name === "fork" && !input.sessionId?.trim()) {
				throw new Error("An active Pi session is required for /fork.");
			}
			return ui;
		}
		const unsupported = unsupportedBuiltinGuidance(name);
		if (unsupported) return unsupported;
		switch (name) {
			case "compact":
				return this.executeCompact(input.sessionId, text);
			case "name":
				return this.executeName(input.sessionId, text);
			case "session":
				return this.executeSessionInfo(input.sessionId);
			case "export":
				return this.executeExport(input.sessionId, input.workspaceRoot, text);
			default:
				return {
					handled: true,
					message: `/${name} is a Pi builtin, but Desktop does not run it. Nothing was changed.`,
				};
		}
	}

	private requireSessionId(
		sessionId: string | undefined,
		command: string,
	): string {
		const id = sessionId?.trim() ?? "";
		if (!id)
			throw new Error(`An active Pi session is required for /${command}.`);
		return id;
	}

	private async ensureLiveSession(sessionId: string): Promise<PiLiveSession> {
		const live = this.live.get(sessionId);
		if (live) return live;
		const summary = this.files.findById(sessionId);
		if (!summary) throw new Error(`Pi session ${sessionId} not found`);
		return this.spawn(sessionId, {}, { resume: summary });
	}

	private assertIdle(live: PiLiveSession, command: string): void {
		if (live.compacting || live.busy || live.run) {
			throw new Error(
				`Pi is busy. Wait until the session is idle, then retry /${command}.`,
			);
		}
	}

	private async executeCompact(
		sessionId: string | undefined,
		text: string,
	): Promise<ExecutePiCommandResult> {
		const id = this.requireSessionId(sessionId, "compact");
		const live = await this.ensureLiveSession(id);
		this.assertIdle(live, "compact");
		const instructions = piCommandRemainder(text, "compact");
		const timeoutMs =
			this.options.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
		live.compacting = true;
		this.setBusy(live, true);
		try {
			const response = await live.process.request<{
				summary?: string;
				tokensBefore?: number;
				estimatedTokensAfter?: number;
			}>(
				{
					type: "compact",
					...(instructions ? { customInstructions: instructions } : {}),
				},
				{ timeoutMs },
			);
			if (!response.success) {
				throw new Error(response.error || "Compaction failed");
			}
			if (live.sessionFile) this.files.summarize(live.sessionFile);
			return {
				handled: true,
				message: formatCompactionMessage(response.data ?? {}, instructions),
				refresh: true,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/compaction cancel(?:l)?ed/i.test(message)) {
				throw new Error("Compaction was cancelled. Nothing was compacted.");
			}
			if (message.includes("did not answer compact")) {
				await this.requestAbort(live);
				// RPC no longer tracks the timed-out response. Do not advertise idle
				// while the old process could still be writing the session summary.
				if (this.live.get(id) === live) {
					await this.terminate(id, "Pi compaction timed out");
				}
				throw new Error(
					`Compaction timed out after ${timeoutMs}ms and was aborted. Wait until the session is idle, then retry /compact.`,
				);
			}
			if (this.live.get(id) !== live) {
				throw new Error(
					"Compaction stopped because the Pi session closed. Nothing was compacted.",
				);
			}
			throw error instanceof Error ? error : new Error(message);
		} finally {
			live.compacting = false;
			if (!live.run) this.setBusy(live, false);
			if (live.stale && this.live.get(id) === live) {
				void this.terminate(id, "Pi configuration changed");
			}
		}
	}

	private async executeName(
		sessionId: string | undefined,
		text: string,
	): Promise<ExecutePiCommandResult> {
		const id = this.requireSessionId(sessionId, "name");
		const name = piCommandRemainder(text, "name");
		if (!name) {
			const current = await this.currentSessionName(id);
			return {
				handled: true,
				message: current
					? `Session name: ${current}`
					: "Usage: /name <name>. This session has no display name.",
			};
		}
		const renamed = await this.setSessionName(id, name);
		if (!renamed) throw new Error(`Pi session ${id} not found`);
		const stored = (await this.currentSessionName(id)) || name;
		const normalized =
			stored !== name ? ` Pi stored it as ${JSON.stringify(stored)}.` : "";
		return {
			handled: true,
			message: `Session name set to ${stored}.${normalized}`,
			refresh: true,
		};
	}

	private async currentSessionName(
		sessionId: string,
	): Promise<string | undefined> {
		const live = this.live.get(sessionId);
		if (live) {
			const state = await live.process.request<{ sessionName?: string }>({
				type: "get_state",
			});
			if (state.success && typeof state.data?.sessionName === "string") {
				const stored = state.data.sessionName.trim();
				if (stored) return stored;
			}
		}
		return this.files.findById(sessionId)?.name;
	}

	private async executeSessionInfo(
		sessionId: string | undefined,
	): Promise<ExecutePiCommandResult> {
		const id = this.requireSessionId(sessionId, "session");
		const live = await this.ensureLiveSession(id);
		const [stats, state] = await Promise.all([
			live.process.request<{
				sessionFile?: string;
				sessionId?: string;
				userMessages?: number;
				assistantMessages?: number;
				toolCalls?: number;
				toolResults?: number;
				totalMessages?: number;
				tokens?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					total?: number;
				};
				cost?: number;
			}>({ type: "get_session_stats" }),
			live.process.request<{ sessionName?: string }>({ type: "get_state" }),
		]);
		if (!stats.success)
			throw new Error(stats.error || "Could not read session stats");
		const sessionName = state.success ? state.data?.sessionName : undefined;
		return {
			handled: true,
			message: formatSessionInfo({
				...stats.data,
				sessionName,
			}),
		};
	}

	private async executeExport(
		sessionId: string | undefined,
		workspaceRoot: string | undefined,
		text: string,
	): Promise<ExecutePiCommandResult> {
		const id = this.requireSessionId(sessionId, "export");
		const outputPath = piPathArgument(text, "export");
		const live = await this.ensureLiveSession(id);
		this.assertIdle(live, "export");
		const cwd =
			live.cwd || workspaceRoot?.trim() || this.ctx.localWorkspaceRoot;
		// Pi normalizes file:// and ~/ paths before writing. Use the same
		// target for the preflight guard, not the literal command argument.
		const target = outputPath
			? resolvePiExportTarget(outputPath, cwd)
			: undefined;
		if (target && live.sessionFile && samePath(target, live.sessionFile)) {
			throw new Error("Refusing to export over the active Pi session file.");
		}
		if (target?.toLowerCase().endsWith(".jsonl")) {
			return { handled: true, message: PI_JSONL_EXPORT_GUIDANCE };
		}
		const response = await live.process.request<{ path?: string }>({
			type: "export_html",
			...(outputPath ? { outputPath } : {}),
		});
		if (!response.success) {
			throw new Error(response.error || "Failed to export session");
		}
		const path = response.data?.path?.trim();
		if (!path) {
			throw new Error("Pi exported the session but did not return a path");
		}
		if (live.sessionFile && samePath(path, live.sessionFile)) {
			throw new Error("Refusing to export over the active Pi session file.");
		}
		return {
			handled: true,
			message: `Exported the session to HTML: ${path}`,
		};
	}

	private async requestAbort(live: PiLiveSession): Promise<void> {
		try {
			await live.process.request({ type: "abort" }, { timeoutMs: 5_000 });
		} catch {
			// The compact timeout is already the user-facing failure.
		}
	}

	/** Pi configuration changed: restart idle processes now, busy ones after their run or compaction. */
	markStale(): void {
		this.commandsCache.clear();
		for (const live of this.live.values()) {
			if (live.busy || live.run) {
				live.stale = true;
			} else {
				void this.terminate(live.sessionId, "Pi configuration changed");
			}
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.reaper) clearInterval(this.reaper);
		await Promise.all(
			[...this.live.keys()].map((sessionId) =>
				this.terminate(sessionId, "Desktop shutting down"),
			),
		);
	}

	// ── Internals ──────────────────────────────────────────────────────────

	private toDiscoveryRecord(summary: PiSessionSummary): JsonRecord {
		const status = this.status(summary.id) ?? "completed";
		return {
			sessionId: summary.id,
			environmentId: LOCAL_ENVIRONMENT_ID,
			origin: "local",
			source: "pi",
			status,
			provider: summary.provider ?? "",
			model: summary.model ?? "",
			cwd: summary.cwd,
			workspaceRoot: summary.cwd,
			prompt: summary.firstMessage,
			startedAt: new Date(summary.createdAt).toISOString(),
			lastActivityAt: new Date(summary.modifiedAt).toISOString(),
			...(status === "completed"
				? { endedAt: new Date(summary.modifiedAt).toISOString() }
				: {}),
			metadata: {
				...(this.metadata.get(summary.id) ?? {}),
				title:
					summary.name ?? summary.firstMessage.split("\n")[0]?.slice(0, 70),
				piSessionFile: summary.path,
				piThinkingLevel: summary.thinkingLevel,
			},
			usage: {
				inputTokens: summary.usage.inputTokens,
				outputTokens: summary.usage.outputTokens,
				totalCostUsd: summary.usage.totalCostUsd,
			},
		};
	}

	private startResult(live: PiLiveSession): JsonRecord {
		return {
			sessionId: live.sessionId,
			cwd: live.cwd,
			workspaceRoot: live.cwd,
			environmentId: LOCAL_ENVIRONMENT_ID,
		};
	}

	private resolveWorkspace(config: JsonRecord): string {
		const candidate =
			(typeof config.cwd === "string" && config.cwd.trim()) ||
			(typeof config.workspaceRoot === "string" &&
				config.workspaceRoot.trim()) ||
			this.ctx.localWorkspaceRoot;
		return candidate;
	}

	private async spawn(
		sessionId: string,
		config: JsonRecord,
		mode: { create: true } | { resume: PiSessionSummary },
	): Promise<PiLiveSession> {
		if (this.disposed) throw new Error("Desktop is shutting down");
		const resume = "resume" in mode ? mode.resume : undefined;
		const cwd =
			resume?.cwd && existsSync(resume.cwd)
				? resume.cwd
				: this.resolveWorkspace(config);
		const provider =
			typeof config.provider === "string" ? config.provider.trim() : "";
		const model = typeof config.model === "string" ? config.model.trim() : "";
		const thinking =
			typeof config.piThinkingLevel === "string"
				? config.piThinkingLevel.trim()
				: "";
		const args = ["--mode", "rpc"];
		if (resume) args.push("--session", resume.path);
		else args.push("--session-id", sessionId);
		// A resumed session keeps its recorded model unless the thread picked a
		// different one; that switch happens after startup through set_model so
		// Pi records the change in the session file.
		if (!resume && provider && model)
			args.push("--model", `${provider}/${model}`);
		if (!resume && thinking) args.push("--thinking", thinking);
		const gate = (
			this.options.gateExtensionPath ?? ensurePiDesktopGateExtension
		)();
		args.push("--extension", gate);
		const process_ = new PiRpcProcess({
			args,
			cwd,
			binary: this.options.binary,
			env: { ...(this.options.env?.() ?? process.env), PI_DESKTOP: "1" },
		});
		const live: PiLiveSession = {
			sessionId,
			process: process_,
			cwd,
			sessionFile: resume?.path,
			config,
			busy: false,
			compacting: false,
			stale: false,
			lastActivityAt: Date.now(),
			run: null,
			queue: { steering: [], followUp: [] },
			queuedPromptCounter: 0,
			toolOutputs: new Map(),
			toolNames: new Map(),
			pendingUi: new Set(),
			unsubscribe: () => {},
		};
		const unsubscribeEvents = process_.onEvent((event) =>
			this.handleEvent(live, event),
		);
		const unsubscribeExit = process_.onExit((exit) =>
			this.handleExit(live, exit),
		);
		live.unsubscribe = () => {
			unsubscribeEvents();
			unsubscribeExit();
		};
		this.live.set(sessionId, live);
		this.ctx.logger?.log("Starting Pi session", {
			sessionId,
			cwd,
			resume: Boolean(resume),
			provider,
			model,
		});
		try {
			const state = await process_.request<{
				sessionFile?: string;
				sessionId?: string;
				model?: { provider?: string; id?: string } | null;
				thinkingLevel?: string;
			}>(
				{ type: "get_state" },
				{
					timeoutMs:
						this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
				},
			);
			if (!state.success) throw new Error(state.error);
			live.sessionFile = state.data?.sessionFile ?? live.sessionFile;
			live.provider = state.data?.model?.provider;
			live.model = state.data?.model?.id;
			live.thinkingLevel = state.data?.thinkingLevel;
			if (live.sessionFile) this.files.remember(sessionId, live.sessionFile);
			if (resume) await this.applyModelSelection(live);
		} catch (error) {
			this.live.delete(sessionId);
			live.unsubscribe();
			await process_.kill(500);
			throw error instanceof Error ? error : new Error(String(error));
		}
		return live;
	}

	/** Bring Pi's model/thinking in line with the thread config (idle sessions only). */
	private async applyModelSelection(live: PiLiveSession): Promise<void> {
		if (live.busy || live.run) return;
		const provider =
			typeof live.config.provider === "string"
				? live.config.provider.trim()
				: "";
		const model =
			typeof live.config.model === "string" ? live.config.model.trim() : "";
		if (
			provider &&
			model &&
			(provider !== live.provider || model !== live.model)
		) {
			const response = await live.process.request<{
				provider?: string;
				id?: string;
			}>({
				type: "set_model",
				provider,
				modelId: model,
			});
			if (!response.success) throw new Error(response.error);
			live.provider = response.data?.provider ?? provider;
			live.model = response.data?.id ?? model;
		}
		const thinking =
			typeof live.config.piThinkingLevel === "string"
				? live.config.piThinkingLevel.trim()
				: "";
		if (thinking && thinking !== live.thinkingLevel) {
			const response = await live.process.request({
				type: "set_thinking_level",
				level: thinking as never,
			});
			if (response.success) live.thinkingLevel = thinking;
		}
	}

	private beginRun(live: PiLiveSession): ActiveRun {
		let resolve!: (result: RunResult) => void;
		const done = new Promise<RunResult>((r) => {
			resolve = r;
		});
		const run: ActiveRun = {
			directPromptPending: true,
			aborted: false,
			lastAssistantText: "",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
			},
			toolCalls: [],
			resolve,
			done,
		};
		live.run = run;
		this.setBusy(live, true);
		return run;
	}

	private finishRun(
		live: PiLiveSession,
		outcome: {
			finishReason: RunResult["finishReason"];
			errorMessage?: string;
			silent?: boolean;
		},
	): void {
		const run = live.run;
		live.run = null;
		live.toolOutputs.clear();
		live.toolNames.clear();
		const text = run?.lastAssistantText ?? "";
		const result: RunResult = {
			text:
				outcome.finishReason === "error"
					? (outcome.errorMessage ?? text)
					: text,
			finishReason: outcome.finishReason,
			usage: run?.usage ?? {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
			},
			toolCalls: run?.toolCalls ?? [],
			messages: run?.messages,
		};
		if (!outcome.silent) {
			emitChunk(
				this.ctx,
				live.sessionId,
				"chat_done",
				JSON.stringify({
					reason: outcome.finishReason,
					text: outcome.errorMessage ?? "",
					usage: result.usage,
				}),
			);
		}
		this.setBusy(live, false);
		if (!outcome.silent) {
			sendEvent(this.ctx, "chat_session_ended", {
				sessionId: live.sessionId,
				reason: outcome.finishReason,
			});
		}
		run?.resolve(result);
		if (live.stale && this.live.get(live.sessionId) === live) {
			void this.terminate(live.sessionId, "Pi configuration changed");
		}
	}

	private setBusy(live: PiLiveSession, busy: boolean): void {
		if (live.busy === busy) return;
		live.busy = busy;
		live.lastActivityAt = Date.now();
		sendEvent(this.ctx, "chat_session_status", {
			sessionId: live.sessionId,
			status: busy ? "running" : "idle",
		});
	}

	private queueSnapshot(live: PiLiveSession): PromptInQueue[] {
		return [
			...live.queue.steering.map((prompt, index) => ({
				id: `steer:${index}`,
				prompt,
				steer: true,
			})),
			...live.queue.followUp.map((prompt, index) => ({
				id: `followUp:${index}`,
				prompt,
				steer: false,
			})),
		];
	}

	private log(
		sessionId: string,
		level: "info" | "warn" | "error",
		message: string,
		metadata?: JsonRecord,
	): void {
		emitChunk(
			this.ctx,
			sessionId,
			"chat_core_log",
			JSON.stringify({ level, message, ...(metadata ? { metadata } : {}) }),
		);
	}

	private handleEvent(live: PiLiveSession, event: PiRpcEvent): void {
		live.lastActivityAt = Date.now();
		const sessionId = live.sessionId;
		if (isPiExtensionUiRequest(event)) {
			this.handleUiRequest(live, event);
			return;
		}
		switch (event.type) {
			case "agent_start": {
				if (!live.run) {
					// A run Pi started on its own (queued follow-up after we
					// returned, or an extension command): keep status honest.
					this.setBusy(live, true);
				}
				return;
			}
			case "message_start": {
				const message = event.message as JsonRecord | undefined;
				if (message?.role !== "user") return;
				if (live.run?.directPromptPending) {
					live.run.directPromptPending = false;
					return;
				}
				live.queuedPromptCounter += 1;
				this.setBusy(live, true);
				emitChunk(
					this.ctx,
					sessionId,
					"chat_queued_prompt_start",
					JSON.stringify({
						promptId: `pi_${sessionId}_${live.queuedPromptCounter}`,
						prompt: textOfContent(message.content),
						attachmentCount: 0,
					}),
				);
				return;
			}
			case "message_update": {
				const delta = event.assistantMessageEvent as JsonRecord | undefined;
				if (!delta) return;
				if (delta.type === "text_delta" && typeof delta.delta === "string") {
					emitChunk(this.ctx, sessionId, "chat_text", delta.delta);
				} else if (
					delta.type === "thinking_delta" &&
					typeof delta.delta === "string"
				) {
					emitChunk(
						this.ctx,
						sessionId,
						"chat_reasoning",
						JSON.stringify({ text: delta.delta }),
					);
				}
				return;
			}
			case "message_end": {
				const message = event.message as JsonRecord | undefined;
				if (message?.role !== "assistant") return;
				const text = textOfContent(message.content);
				if (live.run && text.trim()) live.run.lastAssistantText = text;
				const usage = message.usage as JsonRecord | undefined;
				if (usage) {
					const cost = usage.cost as JsonRecord | undefined;
					const totalCost =
						typeof cost?.total === "number" ? cost.total : undefined;
					emitChunk(
						this.ctx,
						sessionId,
						"chat_usage",
						JSON.stringify({
							inputTokens: usage.input,
							outputTokens: usage.output,
							cacheReadTokens: usage.cacheRead,
							cacheWriteTokens: usage.cacheWrite,
							cost: totalCost,
						}),
					);
					if (live.run) {
						if (typeof usage.input === "number")
							live.run.usage.inputTokens = usage.input;
						if (typeof usage.output === "number") {
							live.run.usage.outputTokens = usage.output;
						}
						if (typeof usage.cacheRead === "number") {
							live.run.usage.cacheReadTokens = usage.cacheRead;
						}
						if (typeof totalCost === "number")
							live.run.usage.totalCost += totalCost;
					}
				}
				if (message.stopReason === "aborted" && live.run)
					live.run.aborted = true;
				if (message.stopReason === "error") {
					const errorMessage =
						typeof message.errorMessage === "string" &&
						message.errorMessage.trim()
							? message.errorMessage.trim()
							: "Pi reported an error";
					if (live.run) live.run.errorMessage = errorMessage;
					this.log(sessionId, "error", errorMessage);
				}
				return;
			}
			case "tool_execution_start": {
				const toolCallId = String(event.toolCallId ?? "");
				const rawName = String(event.toolName ?? "tool");
				const presented = piToolPresentation(rawName, event.args);
				live.toolOutputs.set(toolCallId, "");
				live.toolNames.set(toolCallId, presented.toolName);
				live.run?.toolCalls.push({
					name: presented.toolName,
					input: presented.input,
				});
				emitChunk(
					this.ctx,
					sessionId,
					"chat_tool_call_start",
					JSON.stringify({
						toolCallId,
						toolName: presented.toolName,
						input: presented.input,
					}),
				);
				return;
			}
			case "tool_execution_update": {
				const toolCallId = String(event.toolCallId ?? "");
				const text = piToolResultText(event.partialResult);
				const previous = live.toolOutputs.get(toolCallId) ?? "";
				const chunk = text.startsWith(previous)
					? text.slice(previous.length)
					: text;
				live.toolOutputs.set(toolCallId, text);
				if (!chunk) return;
				emitChunk(
					this.ctx,
					sessionId,
					"chat_tool_call_update",
					JSON.stringify({
						toolCallId,
						toolName:
							live.toolNames.get(toolCallId) ??
							String(event.toolName ?? "tool"),
						update: { stream: "stdout", chunk },
					}),
				);
				return;
			}
			case "tool_execution_end": {
				const toolCallId = String(event.toolCallId ?? "");
				const toolName =
					live.toolNames.get(toolCallId) ??
					piToolPresentation(String(event.toolName ?? "tool"), undefined)
						.toolName;
				const output = piToolResultText(event.result);
				const isError = event.isError === true;
				live.toolOutputs.delete(toolCallId);
				live.toolNames.delete(toolCallId);
				const call = live.run?.toolCalls.findLast(
					(entry) =>
						entry.name === toolName &&
						entry.output === undefined &&
						entry.error === undefined,
				);
				if (call) {
					if (isError) call.error = output || "Tool failed";
					else call.output = output;
				}
				emitChunk(
					this.ctx,
					sessionId,
					"chat_tool_call_end",
					JSON.stringify({
						toolCallId,
						toolName,
						output,
						...(isError ? { error: output || "Tool failed" } : {}),
					}),
				);
				return;
			}
			case "agent_end": {
				if (live.run && Array.isArray(event.messages)) {
					live.run.messages = event.messages as unknown[];
				}
				if (event.willRetry === true) {
					this.log(sessionId, "warn", "Pi is retrying the request");
				}
				return;
			}
			case "agent_settled": {
				const run = live.run;
				if (!run) {
					this.setBusy(live, false);
					sendEvent(this.ctx, "chat_session_ended", {
						sessionId,
						reason: "completed",
					});
					if (live.stale && this.live.get(sessionId) === live) {
						void this.terminate(sessionId, "Pi configuration changed");
					}
					return;
				}
				this.finishRun(live, {
					finishReason: run.aborted
						? "aborted"
						: run.errorMessage
							? "error"
							: "completed",
					errorMessage: run.errorMessage,
				});
				return;
			}
			case "queue_update": {
				live.queue = {
					steering: Array.isArray(event.steering)
						? (event.steering as string[])
						: [],
					followUp: Array.isArray(event.followUp)
						? (event.followUp as string[])
						: [],
				};
				sendEvent(this.ctx, "prompts_in_queue_state", {
					sessionId,
					items: this.queueSnapshot(live),
				});
				return;
			}
			case "compaction_start":
				this.log(sessionId, "info", "Compacting conversation context", {
					reason: event.reason,
				});
				return;
			case "compaction_end": {
				const errorMessage =
					typeof event.errorMessage === "string" ? event.errorMessage : "";
				if (errorMessage)
					this.log(sessionId, "error", `Compaction failed: ${errorMessage}`);
				else if (event.aborted === true)
					this.log(sessionId, "info", "Compaction aborted");
				else this.log(sessionId, "info", "Conversation context compacted");
				return;
			}
			case "auto_retry_start":
				this.log(
					sessionId,
					"warn",
					`Retrying after a transient error (attempt ${String(event.attempt)} of ${String(event.maxAttempts)}): ${String(event.errorMessage ?? "")}`,
				);
				return;
			case "auto_retry_end":
				if (event.success === false) {
					const finalError =
						typeof event.finalError === "string" ? event.finalError : "";
					if (live.run)
						live.run.errorMessage = finalError || live.run.errorMessage;
					this.log(sessionId, "error", finalError || "Retries exhausted");
				}
				return;
			case "extension_error":
				this.log(
					sessionId,
					"error",
					`Extension error (${String(event.extensionPath ?? "unknown")}, ${String(event.event ?? "event")}): ${String(event.error ?? "")}`,
				);
				return;
			default:
				return;
		}
	}

	private handleUiRequest(
		live: PiLiveSession,
		request: PiRpcEvent & { id: string; method: string },
	): void {
		const sessionId = live.sessionId;
		const respond = (response: Record<string, unknown>) => {
			live.pendingUi.delete(request.id);
			live.process.respondExtensionUi({
				type: "extension_ui_response",
				id: request.id,
				...response,
			} as never);
		};
		const approval = parsePiToolApprovalRequest({
			method: request.method,
			title: typeof request.title === "string" ? request.title : undefined,
			message:
				typeof request.message === "string" ? request.message : undefined,
		});
		if (approval) {
			if (live.config.autoApproveTools !== false) {
				respond({ confirmed: true });
				return;
			}
			const owner = [...this.ctx.wsClients].find(
				(client) => client.data?.canApproveTools === true,
			);
			if (!owner) {
				respond({ confirmed: false });
				this.log(
					sessionId,
					"warn",
					`Tool ${approval.toolName} rejected: no desktop approval surface is connected`,
				);
				return;
			}
			const presented = piToolPresentation(approval.toolName, approval.input);
			const requestId = randomUUID();
			live.pendingUi.add(request.id);
			const pending: PendingToolApproval = {
				item: {
					requestId,
					sessionId,
					createdAt: new Date().toISOString(),
					toolCallId: approval.toolCallId || request.id,
					toolName: presented.toolName,
					input: presented.input,
				},
				owner,
				resolve: (result) => {
					if (!live.pendingUi.has(request.id)) return;
					respond({ confirmed: result.approved });
				},
			};
			this.ctx.pendingApprovals.set(requestId, pending);
			const items = [...this.ctx.pendingApprovals.values()]
				.filter(
					(entry) =>
						entry.owner === owner && entry.item.sessionId === sessionId,
				)
				.map((entry) => entry.item);
			sendEventToClient(this.ctx, owner, "tool_approval_state", {
				sessionId,
				items,
			});
			return;
		}
		switch (request.method) {
			case "select":
			case "input":
			case "editor":
			case "confirm": {
				const options =
					request.method === "select" && Array.isArray(request.options)
						? (request.options as unknown[]).filter(
								(option): option is string => typeof option === "string",
							)
						: request.method === "confirm"
							? ["Yes", "No"]
							: [];
				const title = typeof request.title === "string" ? request.title : "";
				const detail =
					request.method === "confirm" && typeof request.message === "string"
						? request.message
						: request.method === "input" &&
								typeof request.placeholder === "string"
							? request.placeholder
							: request.method === "editor" &&
									typeof request.prefill === "string"
								? request.prefill
								: "";
				const requestId = randomUUID();
				live.pendingUi.add(request.id);
				const finish = () => {
					this.ctx.pendingQuestions.delete(requestId);
					if (pending.timeoutId) clearTimeout(pending.timeoutId);
				};
				const pending: PendingAskQuestion = {
					item: {
						requestId,
						sessionId,
						createdAt: new Date().toISOString(),
						question: detail ? `${title}\n\n${detail}` : title,
						options,
						context: {
							agentId: "pi-extension",
							conversationId: sessionId,
							iteration: 0,
						},
					},
					resolve: (answer) => {
						finish();
						if (!live.pendingUi.has(request.id)) return;
						if (request.method === "confirm") {
							respond({ confirmed: /^y(es)?$/i.test(answer.trim()) });
						} else {
							respond({ value: answer });
						}
					},
					reject: () => {
						finish();
						if (!live.pendingUi.has(request.id)) return;
						respond({ cancelled: true });
					},
				};
				const timeout =
					typeof request.timeout === "number" ? request.timeout : undefined;
				if (timeout && timeout > 0) {
					pending.timeoutId = setTimeout(() => {
						// Pi resolves the dialog itself on timeout; just drop our copy.
						this.ctx.pendingQuestions.delete(requestId);
						live.pendingUi.delete(request.id);
						sendEvent(this.ctx, "ask_question_cancelled", {
							requestId,
							reason: "timeout",
						});
					}, timeout);
				}
				this.ctx.pendingQuestions.set(requestId, pending);
				sendEvent(this.ctx, "ask_question_requested", pending.item);
				return;
			}
			case "notify": {
				const notifyType = request.notifyType;
				this.log(
					sessionId,
					notifyType === "error"
						? "error"
						: notifyType === "warning"
							? "warn"
							: "info",
					typeof request.message === "string" ? request.message : "",
				);
				return;
			}
			default:
				this.ctx.logger?.debug("Ignoring Pi extension UI request", {
					sessionId,
					method: request.method,
				});
		}
	}

	private cancelPendingUi(live: PiLiveSession, reason: string): void {
		for (const [requestId, pending] of this.ctx.pendingApprovals) {
			if (pending.item.sessionId !== live.sessionId) continue;
			this.ctx.pendingApprovals.delete(requestId);
			void pending.resolve({ approved: false, reason });
		}
		for (const [requestId, pending] of this.ctx.pendingQuestions) {
			if (pending.item.sessionId !== live.sessionId) continue;
			this.ctx.pendingQuestions.delete(requestId);
			if (pending.timeoutId) clearTimeout(pending.timeoutId);
			pending.reject(new Error(reason));
		}
		live.pendingUi.clear();
	}

	private handleExit(live: PiLiveSession, exit: PiRpcExit): void {
		if (this.live.get(live.sessionId) !== live) return;
		this.live.delete(live.sessionId);
		live.unsubscribe();
		this.cancelPendingUi(live, "Pi process exited");
		if (live.run) {
			const message =
				exit.stderr.trim().split("\n").slice(-3).join("\n").trim() ||
				`Pi exited unexpectedly (${exit.signal ?? `code ${exit.code ?? "unknown"}`})`;
			this.log(live.sessionId, "error", message);
			this.finishRun(live, { finishReason: "error", errorMessage: message });
		} else if (live.busy) {
			this.setBusy(live, false);
		}
	}

	private async terminate(sessionId: string, reason: string): Promise<void> {
		const live = this.live.get(sessionId);
		if (!live) return;
		this.live.delete(sessionId);
		live.unsubscribe();
		this.cancelPendingUi(live, reason);
		if (live.run) {
			live.run.aborted = true;
			this.finishRun(live, { finishReason: "aborted" });
		} else if (live.busy) {
			this.setBusy(live, false);
		}
		await live.process.kill(1_500);
	}

	private async reapIdle(): Promise<void> {
		const ttl = this.options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		const now = Date.now();
		for (const live of this.live.values()) {
			if (live.busy || live.run || live.pendingUi.size > 0) continue;
			if (now - live.lastActivityAt >= ttl) {
				await this.terminate(live.sessionId, "Idle");
			}
		}
	}

	private async discoverCommands(
		workspaceRoot: string,
	): Promise<PiSlashCommand[]> {
		const cwd =
			workspaceRoot && existsSync(workspaceRoot)
				? workspaceRoot
				: this.ctx.localWorkspaceRoot;
		let child: PiRpcProcess;
		try {
			child = new PiRpcProcess({
				args: ["--mode", "rpc", "--no-session", "--no-tools"],
				cwd,
				binary: this.options.binary,
				env: {
					...(this.options.env?.() ?? process.env),
					PI_OFFLINE: "1",
					PI_DESKTOP: "1",
				},
			});
		} catch (error) {
			throw error instanceof Error ? error : new Error(String(error));
		}
		try {
			const response = await child.request<{ commands?: unknown }>(
				{ type: "get_commands" },
				{ timeoutMs: DISCOVERY_TIMEOUT_MS },
			);
			if (!response.success) {
				throw new Error(response.error || "get_commands failed");
			}
			return normalizeCommands(response.data?.commands);
		} finally {
			void child.kill(500);
		}
	}
}

function resolvePiExportTarget(outputPath: string, cwd: string): string {
	let path = outputPath;
	if (path === "~") {
		path = homedir();
	} else if (
		path.startsWith("~/") ||
		(process.platform === "win32" && path.startsWith("~\\"))
	) {
		path = resolve(homedir(), path.slice(2));
	}
	if (path.startsWith("file://")) path = fileURLToPath(path);
	return resolve(cwd, path);
}

function samePath(left: string, right: string): boolean {
	const resolvedLeft = resolve(left);
	const resolvedRight = resolve(right);
	if (resolvedLeft === resolvedRight) return true;
	try {
		if (existsSync(resolvedLeft) && existsSync(resolvedRight)) {
			return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
		}
	} catch {
		return false;
	}
	return false;
}

function normalizeCommands(raw: unknown): PiSlashCommand[] {
	if (!Array.isArray(raw)) return [];
	const out: PiSlashCommand[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const record = item as JsonRecord;
		const rawName = typeof record.name === "string" ? record.name.trim() : "";
		const name = rawName.replace(/^\//, "");
		const source = record.source;
		if (!name || seen.has(name)) continue;
		if (
			source !== "builtin" &&
			source !== "extension" &&
			source !== "prompt" &&
			source !== "skill"
		)
			continue;
		seen.add(name);
		out.push({
			name,
			description:
				typeof record.description === "string" && record.description.trim()
					? record.description.trim()
					: undefined,
			source,
		});
	}
	return out;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const record = block as JsonRecord | null;
			return record?.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.filter(Boolean)
		.join("\n");
}
