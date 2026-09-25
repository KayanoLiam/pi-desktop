import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeBranch,
	PiSessionFiles,
	parsePiSessionFile,
	piToolPresentation,
	projectPiSessionMessages,
} from "./pi-session-files";

let agentDir: string;
let files: PiSessionFiles;

const usage = (input: number, output: number, total: number) => ({
	input,
	output,
	cacheRead: 2,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function jsonl(lines: unknown[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** A v3 session with a tool call, a compaction, a rename, and an abandoned branch. */
function sampleSession(id = "session_1700000000000_abcde", cwd = "/work/repo") {
	return jsonl([
		{
			type: "session",
			version: 3,
			id,
			timestamp: "2026-09-01T10:00:00.000Z",
			cwd,
		},
		{
			type: "model_change",
			id: "e1",
			parentId: null,
			timestamp: "2026-09-01T10:00:01.000Z",
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
		},
		{
			type: "thinking_level_change",
			id: "e2",
			parentId: "e1",
			timestamp: "2026-09-01T10:00:01.500Z",
			thinkingLevel: "high",
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-09-01T10:00:02.000Z",
			message: {
				role: "user",
				content: "List files",
				timestamp: 1756720802000,
			},
		},
		{
			type: "message",
			id: "e4",
			parentId: "e3",
			timestamp: "2026-09-01T10:00:03.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I should run ls" },
					{ type: "text", text: "Running ls." },
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
				api: "openai-responses",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				usage: usage(100, 20, 0.01),
				stopReason: "toolUse",
				timestamp: 1756720803000,
			},
		},
		{
			type: "message",
			id: "e5",
			parentId: "e4",
			timestamp: "2026-09-01T10:00:04.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "README.md\nsrc\n" }],
				isError: false,
				timestamp: 1756720804000,
			},
		},
		{
			type: "message",
			id: "e6",
			parentId: "e5",
			timestamp: "2026-09-01T10:00:05.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_2",
						name: "edit",
						arguments: { path: "src/a.ts", oldText: "a", newText: "b" },
					},
				],
				api: "openai-responses",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				usage: usage(50, 10, 0.02),
				stopReason: "toolUse",
				timestamp: 1756720805000,
			},
		},
		{
			type: "message",
			id: "e7",
			parentId: "e6",
			timestamp: "2026-09-01T10:00:06.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "edit",
				content: [{ type: "text", text: "Edited" }],
				details: { diff: "-1: a\n+1: b", patch: "" },
				isError: false,
				timestamp: 1756720806000,
			},
		},
		{
			type: "message",
			id: "e8",
			parentId: "e7",
			timestamp: "2026-09-01T10:00:07.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Two files." }],
				api: "openai-responses",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				usage: usage(30, 5, 0.005),
				stopReason: "stop",
				timestamp: 1756720807000,
			},
		},
		// Abandoned branch: a second answer forked from e3 that is not the leaf.
		{
			type: "message",
			id: "x1",
			parentId: "e3",
			timestamp: "2026-09-01T10:00:08.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ABANDONED" }],
				api: "x",
				provider: "p",
				model: "m",
				usage: usage(1, 1, 1),
				stopReason: "stop",
				timestamp: 1,
			},
		},
		{
			type: "compaction",
			id: "e9",
			parentId: "e8",
			timestamp: "2026-09-01T10:00:09.000Z",
			summary: "Listed files",
			firstKeptEntryId: "e8",
			tokensBefore: 500,
		},
		{
			type: "session_info",
			id: "e10",
			parentId: "e9",
			timestamp: "2026-09-01T10:00:10.000Z",
			name: "Repo tour",
		},
		{
			type: "message",
			id: "e11",
			parentId: "e10",
			timestamp: "2026-09-01T10:00:11.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "Thanks" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
				timestamp: 1756720811000,
			},
		},
	]);
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-desktop-sessions-"));
	files = new PiSessionFiles(() => agentDir);
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function writeSession(project: string, file: string, content: string): string {
	const dir = join(agentDir, "sessions", project);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, content);
	return path;
}

describe("activeBranch", () => {
	it("projects a selected live leaf instead of the file tip, including the root", () => {
		const entries = parsePiSessionFile(sampleSession());
		expect(activeBranch(entries, "x1").map((entry) => entry.id)).toEqual([
			"e1",
			"e2",
			"e3",
			"x1",
		]);
		expect(activeBranch(entries, "e2").map((entry) => entry.id)).toEqual([
			"e1",
			"e2",
		]);
		expect(activeBranch(entries, null)).toEqual([]);
		const path = writeSession("--work-repo--", "tree.jsonl", sampleSession());
		expect(
			files.readMessages(path, "x1").map((message) => message.content),
		).toContain("ABANDONED");
		expect(files.readMessages(path, null)).toEqual([]);
	});

	it("walks from the last entry to the root and skips abandoned branches", () => {
		const entries = parsePiSessionFile(sampleSession());
		const ids = activeBranch(entries).map((entry) => entry.id);
		expect(ids).toEqual([
			"e1",
			"e2",
			"e3",
			"e4",
			"e5",
			"e6",
			"e7",
			"e8",
			"e9",
			"e10",
			"e11",
		]);
	});
});

describe("PiSessionFiles.list", () => {
	it("summarizes every project session without touching the files", () => {
		const path = writeSession(
			"--work-repo--",
			"2026-09-01T10-00-00-000Z_session_1700000000000_abcde.jsonl",
			sampleSession(),
		);
		writeSession(
			"--work-other--",
			"2026-08-01T00-00-00-000Z_older.jsonl",
			jsonl([
				{
					type: "session",
					version: 3,
					id: "older",
					timestamp: "2026-08-01T00:00:00.000Z",
					cwd: "/work/other",
				},
				{
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "2026-08-01T00:00:01.000Z",
					message: { role: "user", content: "Hi", timestamp: 1 },
				},
			]),
		);
		writeSession("--work-broken--", "broken.jsonl", "not json\n");
		const before = readFileSync(path, "utf8");
		const listed = files.list();
		expect(listed.map((session) => session.id)).toEqual([
			"session_1700000000000_abcde",
			"older",
		]);
		expect(listed[0]).toMatchObject({
			path,
			cwd: "/work/repo",
			name: "Repo tour",
			firstMessage: "List files",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			thinkingLevel: "high",
			messageCount: 5,
		});
		expect(listed[0].usage.inputTokens).toBe(180);
		expect(listed[0].usage.outputTokens).toBe(35);
		expect(listed[0].usage.totalCostUsd).toBeCloseTo(0.035, 10);
		expect(listed[0].searchText).toContain("two files.");
		expect(listed[0].searchText).not.toContain("abandoned");
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(files.findById("older")?.cwd).toBe("/work/other");
		expect(files.findById("nope")).toBeUndefined();
	});

	it("returns nothing when Pi has no session directory", () => {
		expect(files.list()).toEqual([]);
	});
});

describe("projectPiSessionMessages", () => {
	it("projects the active branch into the desktop transcript shape", () => {
		const entries = parsePiSessionFile(sampleSession());
		const messages = projectPiSessionMessages(
			"session_1700000000000_abcde",
			activeBranch(entries),
		);
		expect(messages.map((message) => [message.role, message.id])).toEqual([
			["user", "e3"],
			["assistant", "e4"],
			["tool", "e4_tool_0"],
			["tool", "e6_tool_0"],
			["assistant", "e8"],
			["status", "e9_compaction"],
			["user", "e11"],
		]);
		expect(messages[1]).toMatchObject({
			content: "Running ls.",
			reasoning: "I should run ls",
			meta: {
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 2,
				totalCost: 0.01,
				providerId: "openai-codex",
				modelId: "gpt-5.6-luna",
			},
		});
		expect(JSON.parse(messages[2].content)).toEqual({
			toolName: "run_commands",
			input: { command: "ls" },
			result: "README.md\nsrc\n",
			isError: false,
		});
		expect(messages[2].meta).toMatchObject({
			toolName: "run_commands",
			toolCallId: "call_1",
			hookEventName: "tool_call_end",
		});
		expect(JSON.parse(messages[3].content)).toEqual({
			toolName: "editor",
			input: { path: "src/a.ts", old_text: "a", new_text: "b" },
			result: "Edited\n-1: a\n+1: b",
			isError: false,
		});
		expect(messages[6]).toMatchObject({
			content: "Thanks",
			images: [{ id: "e11_image_1", mediaType: "image/png", data: "aGk=" }],
		});
		// Chronological ids stay strictly increasing for stable sorting.
		for (let index = 1; index < messages.length; index += 1) {
			expect(messages[index].createdAt).toBeGreaterThan(
				messages[index - 1].createdAt,
			);
		}
	});

	it("keeps unmatched tool results, bash executions, errors and extension messages visible", () => {
		const entries = parsePiSessionFile(
			jsonl([
				{
					type: "session",
					version: 3,
					id: "s",
					timestamp: "2026-09-01T10:00:00.000Z",
					cwd: "/w",
				},
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-09-01T10:00:01.000Z",
					message: {
						role: "toolResult",
						toolCallId: "orphan",
						toolName: "write",
						content: [{ type: "text", text: "no such call" }],
						isError: true,
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-09-01T10:00:02.000Z",
					message: {
						role: "bashExecution",
						command: "pwd",
						output: "/w\n",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "m3",
					parentId: "m2",
					timestamp: "2026-09-01T10:00:03.000Z",
					message: {
						role: "assistant",
						content: [],
						api: "x",
						provider: "p",
						model: "m",
						usage: usage(0, 0, 0),
						stopReason: "error",
						errorMessage: "401 unauthorized",
						timestamp: 3,
					},
				},
				{
					type: "custom_message",
					id: "m4",
					parentId: "m3",
					timestamp: "2026-09-01T10:00:04.000Z",
					customType: "my-ext",
					content: "Injected note",
					display: true,
				},
				{
					type: "custom_message",
					id: "m5",
					parentId: "m4",
					timestamp: "2026-09-01T10:00:05.000Z",
					customType: "my-ext",
					content: "Hidden",
					display: false,
				},
			]),
		);
		const messages = projectPiSessionMessages("s", activeBranch(entries));
		expect(
			messages.map((message) => [message.role, message.content.slice(0, 20)]),
		).toEqual([
			["tool", '{"toolName":"editor"'],
			["tool", '{"toolName":"run_com'],
			["error", "401 unauthorized"],
			["system", "Injected note"],
		]);
		expect(JSON.parse(messages[0].content)).toMatchObject({
			result: "no such call",
			isError: true,
		});
	});
});

describe("piToolPresentation", () => {
	it("maps Pi built-ins to the shared summary shapes and passes extension tools through", () => {
		expect(piToolPresentation("read", { path: "a.ts", offset: 1 })).toEqual({
			toolName: "read_files",
			input: { files: [{ path: "a.ts" }] },
		});
		expect(piToolPresentation("write", { path: "a.ts", content: "x" })).toEqual(
			{ toolName: "editor", input: { path: "a.ts", new_text: "x" } },
		);
		expect(
			piToolPresentation("grep", { pattern: "TODO", path: "src" }),
		).toEqual({
			toolName: "search_codebase",
			input: { queries: ["TODO"], path: "src" },
		});
		expect(piToolPresentation("my_ext_tool", { any: 1 })).toEqual({
			toolName: "my_ext_tool",
			input: { any: 1 },
		});
	});
});

describe("rename and delete", () => {
	it("renames by appending a session_info entry to the leaf", () => {
		const path = writeSession("--work-repo--", "s.jsonl", sampleSession());
		files.rename(path, "  New name ");
		const entries = parsePiSessionFile(readFileSync(path, "utf8"));
		const last = entries.at(-1) as {
			type: string;
			parentId: string;
			name?: string;
		};
		expect(last).toMatchObject({
			type: "session_info",
			parentId: "e11",
			name: "New name",
		});
		expect(files.summarize(path)?.name).toBe("New name");
		expect(files.readMessages(path).map((message) => message.id)).toContain(
			"e11",
		);
	});

	it("deletes only files inside Pi's session directory", () => {
		const path = writeSession("--work-repo--", "s.jsonl", sampleSession());
		const outside = join(agentDir, "settings.json");
		writeFileSync(outside, "{}");
		expect(files.delete(outside)).toBe(false);
		expect(files.delete(path)).toBe(true);
		expect(files.list()).toEqual([]);
		expect(files.delete(path)).toBe(false);
	});
});
