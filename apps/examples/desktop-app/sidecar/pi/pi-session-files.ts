import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type {
	CompactionEntry,
	FileEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionHeader,
	SessionInfoEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import type { JsonRecord } from "../types";

/**
 * Read-only access to Pi's session store (`<agentDir>/sessions/`).
 *
 * Files are parsed directly instead of through Pi's `SessionManager.open()`,
 * which migrates old session versions by rewriting the file. Browsing history
 * in the desktop must never modify the user's Pi data; the only writes here
 * are the append-only `session_info` rename and explicit deletion, both of
 * which mirror what Pi itself does.
 */

export type PiSessionSummary = {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	createdAt: number;
	modifiedAt: number;
	firstMessage: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	messageCount: number;
	usage: { inputTokens: number; outputTokens: number; totalCostUsd: number };
	/** Lowercased text of user and assistant messages, for search. */
	searchText: string;
};

export type PiChatMessage = {
	id: string;
	sessionId: string;
	role: "user" | "assistant" | "tool" | "system" | "status" | "error";
	content: string;
	images?: Array<{ id: string; mediaType: string; data: string }>;
	reasoning?: string;
	createdAt: number;
	meta?: JsonRecord;
};

const IMAGE_MEDIA_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

export function piSessionsDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

/** Pi's exported parser is not re-exported from the CLI bundle; keep ours aligned with it. */
export function parsePiSessionFile(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			if (
				entry &&
				typeof entry === "object" &&
				typeof entry.type === "string"
			) {
				entries.push(entry);
			}
		} catch {
			// Skip malformed lines, like Pi does.
		}
	}
	return entries;
}

function readHeader(entries: FileEntry[]): SessionHeader | undefined {
	return entries.find(
		(entry): entry is SessionHeader => entry.type === "session",
	);
}

/**
 * Entries on the active branch: walk from the leaf (the last entry with an
 * id, exactly like Pi's `_buildIndex`) to the root through `parentId`.
 */
export function activeBranch(entries: FileEntry[]): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	let leaf: SessionEntry | undefined;
	for (const entry of entries) {
		if (entry.type === "session") continue;
		const item = entry as SessionEntry;
		if (typeof item.id !== "string") continue;
		byId.set(item.id, item);
		leaf = item;
	}
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = leaf;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const record = block as JsonRecord;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.filter(Boolean)
		.join("\n");
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function summarizeFile(
	path: string,
	entries: FileEntry[],
): PiSessionSummary | null {
	const header = readHeader(entries);
	if (!header || typeof header.id !== "string") return null;
	let name: string | undefined;
	let firstMessage = "";
	let provider: string | undefined;
	let model: string | undefined;
	let thinkingLevel: string | undefined;
	let messageCount = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let totalCostUsd = 0;
	let lastActivity = parseTimestamp(header.timestamp) ?? 0;
	const searchParts: string[] = [];
	for (const entry of activeBranch(entries)) {
		const entryTime = parseTimestamp(entry.timestamp);
		if (entryTime !== undefined && entryTime > lastActivity) {
			lastActivity = entryTime;
		}
		switch (entry.type) {
			case "session_info":
				name = (entry as SessionInfoEntry).name?.trim() || undefined;
				break;
			case "model_change": {
				const change = entry as ModelChangeEntry;
				provider = change.provider;
				model = change.modelId;
				break;
			}
			case "thinking_level_change":
				thinkingLevel = (entry as ThinkingLevelChangeEntry).thinkingLevel;
				break;
			case "message": {
				const message = (entry as SessionMessageEntry)
					.message as unknown as JsonRecord;
				const role = message.role;
				if (role === "user" || role === "assistant") {
					messageCount += 1;
					const text = textOfContent(message.content);
					if (text) searchParts.push(text.toLowerCase());
					if (role === "user" && !firstMessage) firstMessage = text;
				}
				if (role === "assistant") {
					if (typeof message.provider === "string") provider = message.provider;
					if (typeof message.model === "string") model = message.model;
					const usage = message.usage as JsonRecord | undefined;
					if (usage) {
						if (typeof usage.input === "number") inputTokens += usage.input;
						if (typeof usage.output === "number") outputTokens += usage.output;
						const cost = usage.cost as JsonRecord | undefined;
						if (cost && typeof cost.total === "number")
							totalCostUsd += cost.total;
					}
				}
				break;
			}
			case "compaction": {
				const usage = (entry as CompactionEntry).usage;
				if (usage) {
					inputTokens += usage.input;
					outputTokens += usage.output;
					totalCostUsd += usage.cost?.total ?? 0;
				}
				break;
			}
			default:
				break;
		}
	}
	return {
		id: header.id,
		path,
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		name,
		createdAt: parseTimestamp(header.timestamp) ?? 0,
		modifiedAt: lastActivity,
		firstMessage,
		provider,
		model,
		thinkingLevel,
		messageCount,
		usage: { inputTokens, outputTokens, totalCostUsd },
		searchText: searchParts.join("\n"),
	};
}

type CacheEntry = {
	mtimeMs: number;
	size: number;
	summary: PiSessionSummary | null;
};

export class PiSessionFiles {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly byId = new Map<string, string>();

	constructor(private readonly agentDir: () => string) {}

	get sessionsDir(): string {
		return piSessionsDir(this.agentDir());
	}

	/** All Pi sessions across projects, newest activity first. Empty when Pi has no sessions. */
	list(): PiSessionSummary[] {
		const root = this.sessionsDir;
		if (!existsSync(root)) return [];
		const files: string[] = [];
		let projectDirs: string[] = [];
		try {
			projectDirs = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(root, entry.name));
		} catch {
			return [];
		}
		for (const dir of projectDirs) {
			try {
				for (const file of readdirSync(dir)) {
					if (file.endsWith(".jsonl")) files.push(join(dir, file));
				}
			} catch {
				// Unreadable project dir; skip it.
			}
		}
		const seen = new Set(files);
		for (const cached of [...this.cache.keys()]) {
			if (!seen.has(cached)) this.evict(cached);
		}
		const summaries: PiSessionSummary[] = [];
		for (const file of files) {
			const summary = this.summarize(file);
			if (summary) summaries.push(summary);
		}
		summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
		return summaries;
	}

	/** Look a session up by Pi id without rescanning when it is already known. */
	findById(sessionId: string): PiSessionSummary | undefined {
		const knownPath = this.byId.get(sessionId);
		if (knownPath) {
			const summary = this.summarize(knownPath);
			if (summary?.id === sessionId) return summary;
		}
		return this.list().find((summary) => summary.id === sessionId);
	}

	summarize(path: string): PiSessionSummary | null {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(path);
		} catch {
			this.evict(path);
			return null;
		}
		const cached = this.cache.get(path);
		if (
			cached &&
			cached.mtimeMs === stat.mtimeMs &&
			cached.size === stat.size
		) {
			return cached.summary;
		}
		let summary: PiSessionSummary | null = null;
		try {
			summary = summarizeFile(
				path,
				parsePiSessionFile(readFileSync(path, "utf8")),
			);
		} catch {
			summary = null;
		}
		this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
		if (summary) this.byId.set(summary.id, path);
		return summary;
	}

	/** Remember a file Pi just created, so `findById` works before the next scan. */
	remember(sessionId: string, path: string): void {
		this.byId.set(sessionId, path);
	}

	readMessages(path: string): PiChatMessage[] {
		const entries = parsePiSessionFile(readFileSync(path, "utf8"));
		const header = readHeader(entries);
		const sessionId = header?.id ?? "";
		return projectPiSessionMessages(sessionId, activeBranch(entries));
	}

	/** Append-only rename, the same entry Pi writes for `/name`. */
	rename(path: string, name: string): void {
		const entries = parsePiSessionFile(readFileSync(path, "utf8"));
		const branch = activeBranch(entries);
		const leaf = branch.at(-1);
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: uniqueEntryId(entries),
			parentId: leaf?.id ?? null,
			timestamp: new Date().toISOString(),
			name: name.trim() || undefined,
		};
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
		this.evict(path);
	}

	delete(path: string): boolean {
		if (!path.startsWith(this.sessionsDir)) return false;
		if (!existsSync(path)) return false;
		rmSync(path, { force: true });
		this.evict(path);
		return true;
	}

	private evict(path: string): void {
		const cached = this.cache.get(path);
		if (cached?.summary) this.byId.delete(cached.summary.id);
		this.cache.delete(path);
	}
}

function uniqueEntryId(entries: FileEntry[]): string {
	const taken = new Set(
		entries.flatMap((entry) =>
			entry.type !== "session" && typeof (entry as SessionEntry).id === "string"
				? [(entry as SessionEntry).id]
				: [],
		),
	);
	for (;;) {
		const candidate = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
		if (!taken.has(candidate)) return candidate;
	}
}

// ---------------------------------------------------------------------------
// Projection to the desktop chat transcript shape
// ---------------------------------------------------------------------------

/**
 * Normalize a Pi tool call into the `{ toolName, input }` shape the shared
 * `@cline/ui` tool summary understands, so Pi's built-in tools get the same
 * file/diff/command presentation as Cline's. Unknown tools pass through.
 */
export function piToolPresentation(
	toolName: string,
	input: unknown,
): { toolName: string; input: unknown } {
	const record =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as JsonRecord)
			: undefined;
	switch (toolName) {
		case "bash":
		case "powershell":
			return {
				toolName: "run_commands",
				input: {
					command: typeof record?.command === "string" ? record.command : "",
				},
			};
		case "edit":
			return {
				toolName: "editor",
				input: {
					path: record?.path,
					old_text: record?.oldText,
					new_text: record?.newText,
				},
			};
		case "write":
			return {
				toolName: "editor",
				input: { path: record?.path, new_text: record?.content },
			};
		case "read":
			return {
				toolName: "read_files",
				input: { files: [{ path: record?.path }] },
			};
		case "grep":
			return {
				toolName: "search_codebase",
				input: {
					queries: typeof record?.pattern === "string" ? [record.pattern] : [],
					path: record?.path,
				},
			};
		default:
			return { toolName, input };
	}
}

/** Text of a Pi tool result, plus the edit tool's display diff when present. */
export function piToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const record = result as JsonRecord;
	const parts: string[] = [];
	const text = textOfContent(record.content);
	if (text) parts.push(text);
	const details = record.details as JsonRecord | undefined;
	if (details && typeof details.diff === "string" && details.diff.trim()) {
		parts.push(details.diff);
	}
	return parts.join("\n");
}

export function buildPiToolPayload(options: {
	toolName: string;
	input: unknown;
	result: unknown;
	isError: boolean;
}): string {
	const presentation = piToolPresentation(options.toolName, options.input);
	return JSON.stringify({
		toolName: presentation.toolName,
		input: presentation.input,
		result: options.result,
		isError: options.isError,
	});
}

export function projectPiSessionMessages(
	sessionId: string,
	branch: SessionEntry[],
): PiChatMessage[] {
	const out: PiChatMessage[] = [];
	// Tool rows waiting for their toolResult, keyed by tool call id.
	const pendingTools = new Map<string, PiChatMessage>();
	let provider: string | undefined;
	let model: string | undefined;
	let lastCreatedAt = 0;
	const nextCreatedAt = (raw: number | undefined) => {
		const base = raw ?? lastCreatedAt + 1;
		lastCreatedAt = Math.max(base, lastCreatedAt + 1);
		return lastCreatedAt;
	};
	for (const entry of branch) {
		const entryTime = parseTimestamp(entry.timestamp);
		switch (entry.type) {
			case "model_change":
				provider = (entry as ModelChangeEntry).provider;
				model = (entry as ModelChangeEntry).modelId;
				break;
			case "compaction":
				out.push({
					id: `${entry.id}_compaction`,
					sessionId,
					role: "status",
					content: "Context compacted",
					createdAt: nextCreatedAt(entryTime),
					meta: { messageKind: "pi_compaction" },
				});
				break;
			case "branch_summary":
				out.push({
					id: `${entry.id}_branch`,
					sessionId,
					role: "status",
					content: "Returned from another branch",
					createdAt: nextCreatedAt(entryTime),
					meta: { messageKind: "pi_branch_summary" },
				});
				break;
			case "custom_message": {
				const custom = entry as {
					display?: boolean;
					content?: unknown;
					customType?: string;
				};
				if (!custom.display) break;
				const text = textOfContent(custom.content);
				if (!text.trim()) break;
				out.push({
					id: `${entry.id}_custom`,
					sessionId,
					role: "system",
					content: text,
					createdAt: nextCreatedAt(entryTime),
					meta: {
						messageKind: "pi_extension_message",
						reason: custom.customType,
					},
				});
				break;
			}
			case "message": {
				const message = (entry as SessionMessageEntry)
					.message as unknown as JsonRecord;
				const createdAt = nextCreatedAt(
					parseTimestamp(message.timestamp) ?? entryTime,
				);
				projectMessage(entry.id, message, createdAt);
				break;
			}
			default:
				break;
		}
	}
	return out;

	function projectMessage(
		entryId: string,
		message: JsonRecord,
		createdAt: number,
	) {
		switch (message.role) {
			case "user": {
				const text = textOfContent(message.content);
				const images = Array.isArray(message.content)
					? message.content.flatMap((block, index) => {
							const record = block as JsonRecord;
							if (
								record?.type === "image" &&
								typeof record.data === "string" &&
								typeof record.mimeType === "string" &&
								IMAGE_MEDIA_TYPES.has(record.mimeType)
							) {
								return [
									{
										id: `${entryId}_image_${index}`,
										mediaType: record.mimeType,
										data: record.data,
									},
								];
							}
							return [];
						})
					: [];
				if (!text.trim() && images.length === 0) return;
				out.push({
					id: entryId,
					sessionId,
					role: "user",
					content: text,
					...(images.length > 0 ? { images } : {}),
					createdAt,
				});
				return;
			}
			case "assistant": {
				if (typeof message.provider === "string") provider = message.provider;
				if (typeof message.model === "string") model = message.model;
				const blocks = Array.isArray(message.content)
					? (message.content as JsonRecord[])
					: [];
				const textParts: string[] = [];
				const thinkingParts: string[] = [];
				const toolCalls: JsonRecord[] = [];
				for (const block of blocks) {
					if (!block || typeof block !== "object") continue;
					if (block.type === "text" && typeof block.text === "string") {
						textParts.push(block.text);
					} else if (
						block.type === "thinking" &&
						typeof block.thinking === "string"
					) {
						thinkingParts.push(block.thinking);
					} else if (block.type === "toolCall") {
						toolCalls.push(block);
					}
				}
				const usage = message.usage as JsonRecord | undefined;
				const cost = usage?.cost as JsonRecord | undefined;
				const meta: JsonRecord = {};
				if (typeof usage?.input === "number") meta.inputTokens = usage.input;
				if (typeof usage?.output === "number") meta.outputTokens = usage.output;
				if (typeof usage?.cacheRead === "number") {
					meta.cacheReadTokens = usage.cacheRead;
				}
				if (typeof cost?.total === "number") meta.totalCost = cost.total;
				if (provider) meta.providerId = provider;
				if (model) meta.modelId = model;
				const text = textParts.join("\n").trim();
				const reasoning = thinkingParts.join("\n").trim();
				if (text || reasoning) {
					out.push({
						id: entryId,
						sessionId,
						role: "assistant",
						content: text,
						...(reasoning ? { reasoning } : {}),
						createdAt,
						...(Object.keys(meta).length > 0 ? { meta } : {}),
					});
				}
				if (
					message.stopReason === "error" &&
					typeof message.errorMessage === "string"
				) {
					out.push({
						id: `${entryId}_error`,
						sessionId,
						role: "error",
						content: message.errorMessage,
						createdAt: nextCreatedAt(undefined),
					});
				}
				for (const [index, call] of toolCalls.entries()) {
					const toolName = typeof call.name === "string" ? call.name : "tool";
					const toolCallId = typeof call.id === "string" ? call.id : "";
					const row: PiChatMessage = {
						id: `${entryId}_tool_${index}`,
						sessionId,
						role: "tool",
						content: buildPiToolPayload({
							toolName,
							input: call.arguments,
							result: null,
							isError: false,
						}),
						createdAt: nextCreatedAt(undefined),
						meta: {
							toolName: piToolPresentation(toolName, call.arguments).toolName,
							toolCallId,
							hookEventName: "history_tool_use",
						},
					};
					out.push(row);
					if (toolCallId) pendingTools.set(toolCallId, row);
				}
				return;
			}
			case "toolResult": {
				const toolCallId =
					typeof message.toolCallId === "string" ? message.toolCallId : "";
				const row = pendingTools.get(toolCallId);
				const toolName =
					typeof message.toolName === "string" ? message.toolName : "tool";
				const isError = message.isError === true;
				const resultText = piToolResultText(message);
				if (row) {
					pendingTools.delete(toolCallId);
					const payload = JSON.parse(row.content) as JsonRecord;
					row.content = JSON.stringify({
						...payload,
						result: resultText,
						isError,
					});
					row.meta = {
						...(row.meta ?? {}),
						hookEventName: "tool_call_end",
					};
					return;
				}
				out.push({
					id: `${entryId}_result`,
					sessionId,
					role: "tool",
					content: buildPiToolPayload({
						toolName,
						input: undefined,
						result: resultText,
						isError,
					}),
					createdAt,
					meta: {
						toolName: piToolPresentation(toolName, undefined).toolName,
						toolCallId,
						hookEventName: "tool_call_end",
					},
				});
				return;
			}
			case "bashExecution": {
				const command =
					typeof message.command === "string" ? message.command : "";
				const output = typeof message.output === "string" ? message.output : "";
				out.push({
					id: `${entryId}_bash`,
					sessionId,
					role: "tool",
					content: JSON.stringify({
						toolName: "run_commands",
						input: { command },
						result: output,
						isError:
							typeof message.exitCode === "number" && message.exitCode !== 0,
					}),
					createdAt,
					meta: {
						toolName: "run_commands",
						hookEventName: "tool_call_end",
						messageKind: "pi_bash_execution",
					},
				});
				return;
			}
			case "custom": {
				const custom = message as {
					display?: boolean;
					content?: unknown;
					customType?: unknown;
				};
				if (!custom.display) return;
				const text = textOfContent(custom.content);
				if (!text.trim()) return;
				out.push({
					id: `${entryId}_custom`,
					sessionId,
					role: "system",
					content: text,
					createdAt,
					meta: {
						messageKind: "pi_extension_message",
						reason:
							typeof custom.customType === "string"
								? custom.customType
								: undefined,
					},
				});
				return;
			}
			case "compactionSummary":
				out.push({
					id: `${entryId}_compaction`,
					sessionId,
					role: "status",
					content: "Context compacted",
					createdAt,
					meta: { messageKind: "pi_compaction" },
				});
				return;
			case "branchSummary":
				out.push({
					id: `${entryId}_branch`,
					sessionId,
					role: "status",
					content: "Returned from another branch",
					createdAt,
					meta: { messageKind: "pi_branch_summary" },
				});
				return;
			default:
				return;
		}
	}
}
