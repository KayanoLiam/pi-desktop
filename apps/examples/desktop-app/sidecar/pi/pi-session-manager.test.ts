import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSidecarContext } from "../context";
import type { SidecarContext, SidecarWebSocketClient } from "../types";
import { PI_DESKTOP_APPROVAL_TITLE } from "./pi-desktop-gate-extension";
import { PiSessionFiles } from "./pi-session-files";
import { PiSessionManager } from "./pi-session-manager";
import { PI_BUILTIN_SLASH_COMMANDS } from "./pi-slash-commands";
import {
	createFakePi,
	type FakePi,
	textAndToolScenarioEvents,
} from "./test-helpers/fake-pi";

type Sent = { name: string; payload: Record<string, unknown> };

let dir: string;
let agentDir: string;
let ctx: SidecarContext;
let manager: PiSessionManager;
let fake: FakePi;
let sent: Sent[];
let approver: SidecarWebSocketClient;

function chunks(stream?: string): Array<Record<string, unknown>> {
	return sent
		.filter((event) => event.name === "chat_event")
		.map((event) => event.payload)
		.filter((payload) => !stream || payload.stream === stream);
}

function chunkJson(stream: string): Array<Record<string, unknown>> {
	return chunks(stream).map((payload) => JSON.parse(String(payload.chunk)));
}

function events(name: string): Array<Record<string, unknown>> {
	return sent
		.filter((event) => event.name === name)
		.map((event) => event.payload);
}

type QueueResult = {
	queued: boolean;
	promptsInQueue: Array<Record<string, unknown>>;
};

const IMAGE = "data:image/png;base64,AAAA";

function receivedPrompts(): Array<Record<string, unknown>> {
	return fake.received().filter((line) => line.type === "prompt");
}

function queueItems(): Array<Record<string, unknown>> {
	return (events("prompts_in_queue_state").at(-1)?.items ?? []) as Array<
		Record<string, unknown>
	>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startSession(sessionId: string): Promise<void> {
	await manager.handle({
		action: "start",
		config: {
			runtime: "pi",
			sessionId,
			provider: "p",
			model: "m",
			cwd: dir,
		},
	});
}

/** A turn that stays busy for `ticks` × 25 ms and stops early when aborted. */
function slowTurnEvents(
	options: { ticks?: number; stopReason?: string; errorMessage?: string } = {},
): unknown[] {
	return [
		{ type: "agent_start" },
		{
			type: "message_start",
			message: { role: "user", content: "{{prompt}}", timestamp: 1 },
		},
		...Array.from({ length: options.ticks ?? 8 }, () => ({ __wait__: 25 })),
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done: {{prompt}}" }],
				api: "x",
				provider: "p",
				model: "m",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: options.stopReason ?? "stop",
				...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
				timestamp: 1,
			},
		},
		{ type: "agent_end", messages: [], willRetry: false },
	];
}

const FORK_ENTRIES = [
	{
		type: "message",
		id: "a",
		parentId: null,
		timestamp: "2026-09-01T00:00:01.000Z",
		message: { role: "user", content: "Question one", timestamp: 1 },
	},
	{
		type: "message",
		id: "b",
		parentId: "a",
		timestamp: "2026-09-01T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Answer one" }],
			timestamp: 2,
		},
	},
	{
		type: "message",
		id: "c",
		parentId: "b",
		timestamp: "2026-09-01T00:00:03.000Z",
		message: { role: "user", content: "Question two", timestamp: 3 },
	},
	{
		type: "message",
		id: "d",
		parentId: "c",
		timestamp: "2026-09-01T00:00:04.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Answer two" }],
			timestamp: 4,
		},
	},
];

/** Pi's live tree for FORK_ENTRIES plus a second branch (e, f) off "b". */
const FORK_TREE = [
	{
		entry: {
			id: "a",
			parentId: null,
			type: "message",
			message: { role: "user", content: "Question one" },
		},
		children: [
			{
				entry: {
					id: "b",
					parentId: "a",
					type: "message",
					message: { role: "assistant" },
				},
				children: [
					{
						entry: {
							id: "c",
							parentId: "b",
							type: "message",
							message: { role: "user", content: "Question two" },
						},
						children: [
							{
								entry: {
									id: "d",
									parentId: "c",
									type: "message",
									message: { role: "assistant" },
								},
								children: [],
							},
						],
					},
					{
						entry: {
							id: "e",
							parentId: "b",
							type: "message",
							message: {
								role: "user",
								content: [{ type: "text", text: "Question two, again" }],
							},
						},
						children: [
							{
								entry: {
									id: "f",
									parentId: "e",
									type: "message",
									message: { role: "assistant" },
								},
								children: [],
							},
						],
					},
				],
			},
		],
	},
];

function writeForkSession(sessionId: string): string {
	const project = join(agentDir, "sessions", "--fork--");
	mkdirSync(project, { recursive: true });
	const path = join(project, `${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		cwd: dir,
		timestamp: "2026-09-01T00:00:00.000Z",
	};
	writeFileSync(
		path,
		`${[header, ...FORK_ENTRIES].map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
	return path;
}

function launches(): Array<Record<string, unknown>> {
	return fake.received().filter((line) => Array.isArray(line.argv));
}

function createManager(
	scenario: Parameters<typeof createFakePi>[1] = {},
	options: { compactTimeoutMs?: number } = {},
) {
	fake = createFakePi(join(dir, "fake"), scenario);
	manager = new PiSessionManager(ctx, {
		files: new PiSessionFiles(() => agentDir),
		agentDir: () => agentDir,
		binary: fake.bin,
		reapIntervalMs: 0,
		compactTimeoutMs: options.compactTimeoutMs,
		gateExtensionPath: () => join(dir, "gate.js"),
		env: () => ({
			...process.env,
			CLINE_SESSION_DATA_DIR: join(dir, "session-data"),
		}),
	});
	ctx.pi = manager;
	return manager;
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-desktop-manager-")));
	agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.CLINE_SESSION_DATA_DIR = join(dir, "session-data");
	ctx = createSidecarContext(dir);
	sent = [];
	approver = {
		data: { canApproveTools: true },
		send: (raw: string) => {
			const parsed = JSON.parse(raw) as { event: Sent };
			sent.push(parsed.event);
		},
	};
	ctx.wsClients.add(approver);
});

afterEach(async () => {
	await manager?.dispose();
	delete process.env.CLINE_SESSION_DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

describe("PiSessionManager", () => {
	it("navigates Pi's live tree, projects the selected branch, and restores user text", async () => {
		const sessionId = "tree-session";
		const project = join(agentDir, "sessions", "--tree--");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, `${sessionId}.jsonl`),
			`${[
				{
					type: "session",
					version: 3,
					id: sessionId,
					cwd: dir,
					timestamp: "2026-09-01T00:00:00.000Z",
				},
				{
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "2026-09-01T00:00:01.000Z",
					message: { role: "user", content: "Original question", timestamp: 1 },
				},
				{
					type: "message",
					id: "b",
					parentId: "a",
					timestamp: "2026-09-01T00:00:02.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "First answer" }],
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "c",
					parentId: "a",
					timestamp: "2026-09-01T00:00:03.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Second answer" }],
						timestamp: 3,
					},
				},
			]
				.map((line) => JSON.stringify(line))
				.join("\n")}\n`,
		);
		const tree = [
			{
				entry: {
					id: "a",
					parentId: null,
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "Original " },
							{ type: "text", text: "question" },
						],
					},
				},
				children: [
					{
						entry: {
							id: "b",
							parentId: "a",
							type: "message",
							message: { role: "assistant" },
						},
						children: [],
					},
					{
						entry: {
							id: "c",
							parentId: "a",
							type: "message",
							message: { role: "assistant" },
						},
						children: [],
					},
				],
			},
		];
		createManager({ tree, treeLeafId: "c" });
		expect(await manager.getTree(sessionId)).toMatchObject({
			leafId: "c",
			tree,
		});
		expect(manager.readMessages(sessionId)?.at(-1)?.content).toBe(
			"Second answer",
		);
		const first = await manager.navigateTree(sessionId, "b");
		expect(first).toMatchObject({ leafId: "b" });
		expect(first.messages.at(-1)?.content).toBe("First answer");
		expect(manager.readMessages(sessionId)?.at(-1)?.content).toBe(
			"First answer",
		);
		const reedit = await manager.navigateTree(sessionId, "a");
		expect(reedit).toMatchObject({
			leafId: null,
			editorText: "Original question",
			messages: [],
		});
		expect(manager.readMessages(sessionId)).toEqual([]);
		await expect(manager.navigateTree(sessionId, "missing")).rejects.toThrow(
			/no longer exists/,
		);
		expect(
			fake.received().filter((line) => line.type === "prompt"),
		).toHaveLength(2);
	});

	it("never sends a tree jump as a model prompt when the gate extension is missing", async () => {
		createManager({
			tree: [
				{
					entry: { id: "a", parentId: null, type: "model_change" },
					children: [
						{
							entry: { id: "b", parentId: "a", type: "model_change" },
							children: [],
						},
					],
				},
			],
			treeLeafId: "b",
			treeCommandMissing: true,
		});
		await startPi(manager, "missing-tree-gate");
		await expect(
			manager.navigateTree("missing-tree-gate", "a"),
		).rejects.toThrow(/tree navigation is unavailable/);
		expect((await manager.getTree("missing-tree-gate")).leafId).toBe("b");
		expect(
			fake.received().filter((line) => line.type === "prompt"),
		).toHaveLength(0);
	});

	it("rejects a cancelled tree switch instead of claiming success", async () => {
		createManager({
			tree: [
				{
					entry: { id: "a", parentId: null, type: "model_change" },
					children: [
						{
							entry: { id: "b", parentId: "a", type: "model_change" },
							children: [],
						},
					],
				},
			],
			treeLeafId: "b",
			treeNavigationCancelled: true,
		});
		await startPi(manager, "cancelled-tree");
		await expect(manager.navigateTree("cancelled-tree", "a")).rejects.toThrow(
			/cancelled/,
		);
		expect((await manager.getTree("cancelled-tree")).leafId).toBe("b");
	});

	it("rejects tree navigation while a Pi turn is active", async () => {
		createManager({
			tree: [
				{
					entry: { id: "a", parentId: null, type: "model_change" },
					children: [
						{
							entry: { id: "b", parentId: "a", type: "model_change" },
							children: [],
						},
					],
				},
			],
			treeLeafId: "b",
			promptEvents: [{ __waitForUi__: true }],
		});
		await startPi(manager, "busy-tree");
		const pending = manager.handle({
			action: "send",
			sessionId: "busy-tree",
			prompt: "hello",
		});
		await waitFor(() => manager.status("busy-tree") === "running");
		expect((await manager.getTree("busy-tree")).leafId).toBe("b");
		await expect(manager.navigateTree("busy-tree", "a")).rejects.toThrow(
			/busy/i,
		);
		expect(
			fake.received().filter((line) => line.type === "prompt"),
		).toHaveLength(1);
		await manager.handle({ action: "abort", sessionId: "busy-tree" });
		await pending;
	});

	it("does not re-edit a user node when its leaf is already selected", async () => {
		createManager({
			tree: [
				{
					entry: {
						id: "a",
						parentId: null,
						type: "message",
						message: { role: "user", content: "hello" },
					},
					children: [],
				},
			],
			treeLeafId: "a",
		});
		await startPi(manager, "same-tree");
		expect(await manager.navigateTree("same-tree", "a")).toMatchObject({
			leafId: "a",
			messages: [],
		});
		expect(
			fake.received().filter((line) => line.type === "prompt"),
		).toHaveLength(0);
	});

	it("keeps the internal tree command out of discovery and user prompts", async () => {
		createManager({
			commands: [{ name: "__pi_desktop_tree_jump", source: "extension" }],
		});
		expect(
			(await manager.listCommands(dir)).some(
				(command) => command.name === "__pi_desktop_tree_jump",
			),
		).toBe(false);
		await startPi(manager, "reserved-tree");
		await expect(
			manager.executeCommand({
				sessionId: "reserved-tree",
				text: "/__pi_desktop_tree_jump a",
			}),
		).rejects.toThrow(/Use \/tree/);
		await expect(
			manager.handle({
				action: "send",
				sessionId: "reserved-tree",
				prompt: "/__pi_desktop_tree_jump a",
			}),
		).rejects.toThrow(/Use \/tree/);
		expect(
			fake.received().filter((line) => line.type === "prompt"),
		).toHaveLength(0);
	});

	it("starts a new session with the selected model and streams a full turn", async () => {
		createManager({ promptEvents: textAndToolScenarioEvents() });
		const started = (await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "session_1_abc",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				piThinkingLevel: "high",
				workspaceRoot: dir,
				cwd: dir,
			},
		})) as { sessionId: string; cwd: string };
		expect(started).toMatchObject({
			sessionId: "session_1_abc",
			cwd: dir,
			environmentId: "local",
		});
		const argv = fake.received()[0].argv as string[];
		expect(argv).toEqual([
			"--mode",
			"rpc",
			"--session-id",
			"session_1_abc",
			"--model",
			"openai-codex/gpt-5.6-luna",
			"--thinking",
			"high",
			"--extension",
			join(dir, "gate.js"),
		]);
		expect(fake.received()[0].cwd).toBe(dir);
		expect(manager.status("session_1_abc")).toBe("idle");

		const response = (await manager.handle({
			action: "send",
			sessionId: "session_1_abc",
			prompt: "hello pi",
		})) as { ok: boolean; result: Record<string, unknown> };
		expect(response.ok).toBe(true);
		expect(response.result).toMatchObject({
			finishReason: "completed",
			text: "Done: hello pi",
			usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3 },
			toolCalls: [
				{ name: "run_commands", input: { command: "ls" }, output: "a\nb\n" },
			],
		});
		expect((response.result.messages as unknown[]).length).toBe(2);
		expect(response.result.usage).toMatchObject({
			totalCost: expect.any(Number),
		});

		// The fixture puts U+2028 inside a delta to prove LF-only framing survives.
		expect(chunks("chat_text").map((c) => c.chunk)).toEqual([
			"Hello ",
			"world\u2028!",
			"Done: hello pi",
		]);
		expect(chunkJson("chat_reasoning")).toEqual([{ text: "Plan it" }]);
		expect(chunkJson("chat_tool_call_start")).toEqual([
			{
				toolCallId: "call_1",
				toolName: "run_commands",
				input: { command: "ls" },
			},
		]);
		expect(chunkJson("chat_tool_call_update").map((c) => c.update)).toEqual([
			{ stream: "stdout", chunk: "a\n" },
			{ stream: "stdout", chunk: "b\n" },
		]);
		expect(chunkJson("chat_tool_call_end")).toEqual([
			{ toolCallId: "call_1", toolName: "run_commands", output: "a\nb\n" },
		]);
		expect(chunkJson("chat_usage")).toHaveLength(2);
		expect(chunkJson("chat_done")).toEqual([
			{ reason: "completed", text: "", usage: response.result.usage },
		]);
		// The direct prompt's own user message must not be re-announced.
		expect(chunks("chat_queued_prompt_start")).toEqual([]);
		expect(events("chat_session_status").map((e) => e.status)).toEqual([
			"running",
			"idle",
		]);
		expect(events("chat_session_ended")).toEqual([
			{
				environmentId: "local",
				sessionId: "session_1_abc",
				reason: "completed",
			},
		]);
		// Every chunk carries the session id and the local environment.
		for (const chunk of chunks()) {
			expect(chunk).toMatchObject({
				sessionId: "session_1_abc",
				environmentId: "local",
			});
		}
	});

	it("auto-approves gate prompts by default and asks the desktop when the thread opts in", async () => {
		const gateRequest = {
			type: "extension_ui_request",
			id: "ui-1",
			method: "confirm",
			title: PI_DESKTOP_APPROVAL_TITLE,
			message: JSON.stringify({
				toolCallId: "call_9",
				toolName: "write",
				input: { path: "a.txt", content: "x" },
			}),
		};
		createManager({
			promptEvents: [
				{ type: "agent_start" },
				gateRequest,
				{ __waitForUi__: true },
				{ type: "agent_end", messages: [], willRetry: false },
			],
		});
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-auto",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		await manager.handle({
			action: "send",
			sessionId: "s-auto",
			prompt: "write it",
		});
		const autoResponses = fake
			.received()
			.filter((line) => line.type === "extension_ui_response");
		expect(autoResponses).toEqual([
			{ type: "extension_ui_response", id: "ui-1", confirmed: true },
		]);
		expect(events("tool_approval_state")).toEqual([]);

		// Opt into approvals: the request reaches the desktop card and is rejected.
		const pending = manager.handle({
			action: "send",
			sessionId: "s-auto",
			prompt: "write again",
			config: { autoApproveTools: false },
		});
		await waitFor(() => events("tool_approval_state").length > 0);
		const state = events("tool_approval_state").at(-1) as {
			items: Array<Record<string, unknown>>;
		};
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({
			sessionId: "s-auto",
			toolCallId: "call_9",
			toolName: "editor",
			input: { path: "a.txt", new_text: "x" },
		});
		const requestId = state.items[0].requestId as string;
		const approval = ctx.pendingApprovals.get(requestId);
		expect(approval?.owner).toBe(approver);
		await approval?.resolve({ approved: false, reason: "no" });
		ctx.pendingApprovals.delete(requestId);
		await pending;
		const responses = fake
			.received()
			.filter((line) => line.type === "extension_ui_response");
		expect(responses.at(-1)).toEqual({
			type: "extension_ui_response",
			id: "ui-1",
			confirmed: false,
		});
	});

	it("turns extension select/input dialogs into desktop questions", async () => {
		createManager({
			promptEvents: [
				{ type: "agent_start" },
				{
					type: "extension_ui_request",
					id: "ui-select",
					method: "select",
					title: "Pick one",
					options: ["A", "B"],
				},
				{ __waitForUi__: true },
				{
					type: "extension_ui_request",
					id: "ui-input",
					method: "input",
					title: "Name?",
					placeholder: "type",
				},
				{ __waitForUi__: true },
				{
					type: "extension_ui_request",
					id: "ui-notify",
					method: "notify",
					message: "heads up",
					notifyType: "warning",
				},
				{ type: "agent_end", messages: [], willRetry: false },
			],
		});
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-ask",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		const pending = manager.handle({
			action: "send",
			sessionId: "s-ask",
			prompt: "ask me",
		});
		await waitFor(() => events("ask_question_requested").length === 1);
		const first = events("ask_question_requested")[0] as {
			requestId: string;
			question: string;
			options: string[];
		};
		expect(first).toMatchObject({
			sessionId: "s-ask",
			question: "Pick one",
			options: ["A", "B"],
		});
		ctx.pendingQuestions.get(first.requestId)?.resolve("B");
		await waitFor(() => events("ask_question_requested").length === 2);
		const second = events("ask_question_requested")[1] as {
			requestId: string;
			question: string;
			options: string[];
		};
		expect(second).toMatchObject({ question: "Name?\n\ntype", options: [] });
		ctx.pendingQuestions.get(second.requestId)?.resolve("Kayano");
		await pending;
		const responses = fake
			.received()
			.filter((line) => line.type === "extension_ui_response");
		expect(responses).toEqual([
			{ type: "extension_ui_response", id: "ui-select", value: "B" },
			{ type: "extension_ui_response", id: "ui-input", value: "Kayano" },
		]);
		expect(chunkJson("chat_core_log")).toContainEqual({
			level: "warn",
			message: "heads up",
		});
		expect(ctx.pendingQuestions.size).toBe(0);
	});

	it("aborts a running turn and reports it as cancelled", async () => {
		createManager({
			promptEvents: [
				{ type: "agent_start" },
				{
					type: "message_update",
					usage: {},
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "partial",
					},
				},
				{ __wait__: 5_000 },
			],
		});
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-abort",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		const pending = manager.handle({
			action: "send",
			sessionId: "s-abort",
			prompt: "long",
		});
		await waitFor(() => chunks("chat_text").length === 1);
		await manager.handle({ action: "abort", sessionId: "s-abort" });
		const response = (await pending) as { result: { finishReason: string } };
		expect(response.result.finishReason).toBe("aborted");
		expect(chunkJson("chat_done").at(-1)).toMatchObject({ reason: "aborted" });
		expect(manager.status("s-abort")).toBe("idle");
	});

	it("holds prompts sent during a turn and sends them in order once Pi settles", async () => {
		// A long first turn, so it is still running when the queue is checked
		// even on a loaded machine.
		createManager({ promptEvents: slowTurnEvents({ ticks: 20 }) });
		await startSession("s-queue");
		const first = manager.handle({
			action: "send",
			sessionId: "s-queue",
			prompt: "first",
		});
		// "running" is set as the prompt is written; wait until the fake has
		// actually read it before checking what Pi received.
		await waitFor(
			() =>
				manager.status("s-queue") === "running" &&
				receivedPrompts().length === 1,
		);
		const second = (await manager.handle({
			action: "send",
			sessionId: "s-queue",
			prompt: "second",
			attachments: { userImages: [IMAGE] },
		})) as QueueResult;
		expect(second.queued).toBe(true);
		expect(second.promptsInQueue).toEqual([
			{
				id: expect.stringMatching(/^pi_q_/),
				prompt: "second",
				steer: false,
				attachmentCount: 1,
				userImages: [IMAGE],
			},
		]);
		await manager.handle({
			action: "send",
			sessionId: "s-queue",
			prompt: "third",
		});
		// Nothing reaches Pi's own follow-up queue while the first turn runs.
		expect(manager.status("s-queue")).toBe("running");
		expect(receivedPrompts().map((line) => line.message)).toEqual(["first"]);
		await first;
		await waitFor(() => chunkJson("chat_done").length === 3);
		const prompts = receivedPrompts();
		expect(prompts.map((line) => line.message)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(prompts.map((line) => line.streamingBehavior)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(prompts[1]?.images).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		// Announced once each, with the queue id and images the webview shows.
		expect(chunkJson("chat_queued_prompt_start")).toEqual([
			{
				promptId: second.promptsInQueue[0]?.id,
				prompt: "second",
				attachmentCount: 1,
				userImages: [IMAGE],
			},
			{
				promptId: expect.stringMatching(/^pi_q_/),
				prompt: "third",
				attachmentCount: 0,
			},
		]);
		expect(events("prompts_in_queue_state").at(-1)).toMatchObject({
			sessionId: "s-queue",
			items: [],
		});
		await waitFor(() => manager.status("s-queue") === "idle");
	});

	it("edits and removes queued prompts and deletes removed attachments", async () => {
		createManager({ promptEvents: slowTurnEvents() });
		await startSession("s-edit");
		const first = manager.handle({
			action: "send",
			sessionId: "s-edit",
			prompt: "first",
		});
		await waitFor(() => manager.status("s-edit") === "running");
		const draft = (await manager.handle({
			action: "send",
			sessionId: "s-edit",
			prompt: "draft",
			attachments: { userImages: [IMAGE] },
		})) as QueueResult;
		const dropped = (await manager.handle({
			action: "send",
			sessionId: "s-edit",
			prompt: "drop me",
			attachments: { userFiles: [{ name: "notes.txt", content: "secret" }] },
		})) as QueueResult;
		const draftId = String(draft.promptsInQueue[0]?.id);
		const droppedId = String(dropped.promptsInQueue[1]?.id);
		const attachmentDir = join(
			dir,
			"session-data",
			"s-edit",
			"user-attachments",
		);
		expect(readdirSync(attachmentDir)).toHaveLength(1);

		expect(
			await manager.handle({
				action: "update_pending_prompt",
				sessionId: "s-edit",
				promptId: draftId,
				prompt: "edited",
			}),
		).toMatchObject({
			updated: true,
			promptsInQueue: [
				{ id: draftId, prompt: "edited", userImages: [IMAGE] },
				{ id: droppedId, prompt: "drop me" },
			],
		});
		await expect(
			manager.handle({
				action: "update_pending_prompt",
				sessionId: "s-edit",
				promptId: draftId,
				prompt: "/compact",
			}),
		).rejects.toThrow(/execute_pi_command/);
		await expect(
			manager.handle({
				action: "remove_pending_prompt",
				sessionId: "s-edit",
				promptId: "pi:followUp:0",
			}),
		).rejects.toThrow(/already handed to Pi/);
		expect(
			await manager.handle({
				action: "remove_pending_prompt",
				sessionId: "s-edit",
				promptId: droppedId,
			}),
		).toMatchObject({
			removed: true,
			prompt: { id: droppedId, prompt: "drop me", attachmentCount: 1 },
			promptsInQueue: [{ id: draftId }],
		});
		expect(readdirSync(attachmentDir)).toEqual([]);

		await first;
		await waitFor(() => chunkJson("chat_done").length === 2);
		expect(receivedPrompts().map((line) => line.message)).toEqual([
			"first",
			"edited",
		]);
		expect(receivedPrompts()[1]?.images).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});

	it("steers a queued prompt into the running turn exactly once", async () => {
		createManager({ promptEvents: slowTurnEvents() });
		await startSession("s-steer");
		const first = manager.handle({
			action: "send",
			sessionId: "s-steer",
			prompt: "first",
		});
		await waitFor(() => manager.status("s-steer") === "running");
		const queued = (await manager.handle({
			action: "send",
			sessionId: "s-steer",
			prompt: "now please",
		})) as QueueResult;
		expect(
			await manager.handle({
				action: "steer_prompt",
				sessionId: "s-steer",
				promptId: String(queued.promptsInQueue[0]?.id),
			}),
		).toMatchObject({ updated: true });
		expect(receivedPrompts().at(-1)).toMatchObject({
			message: "now please",
			streamingBehavior: "steer",
		});
		// Pi now owns it and reports it through its own queue: read-only here.
		await waitFor(() =>
			queueItems().some((item) => item.id === "pi:steer:0" && item.steer),
		);
		await first;
		await sleep(100);
		expect(
			receivedPrompts().filter((line) => line.message === "now please"),
		).toHaveLength(1);
	});

	it("keeps the queue when the user's turn is stopped and drops it when a queued turn is stopped", async () => {
		createManager({ promptEvents: slowTurnEvents({ ticks: 200 }) });
		await startSession("s-stop");
		const first = manager.handle({
			action: "send",
			sessionId: "s-stop",
			prompt: "first",
		});
		await waitFor(() => manager.status("s-stop") === "running");
		await manager.handle({ action: "send", sessionId: "s-stop", prompt: "q1" });
		await manager.handle({ action: "send", sessionId: "s-stop", prompt: "q2" });

		await manager.handle({ action: "abort", sessionId: "s-stop" });
		expect(
			((await first) as { result: { finishReason: string } }).result
				.finishReason,
		).toBe("aborted");
		// Stopping the user's own turn lets the queue continue.
		await waitFor(() =>
			receivedPrompts().some((line) => line.message === "q1"),
		);
		expect(chunkJson("chat_queued_prompt_start")).toMatchObject([
			{ prompt: "q1" },
		]);

		// Stopping the queued turn cancels the queued work itself.
		await manager.handle({ action: "abort", sessionId: "s-stop" });
		await waitFor(() => chunkJson("chat_done").length === 2);
		expect(chunkJson("chat_done").at(-1)).toMatchObject({ reason: "aborted" });
		expect(queueItems()).toEqual([]);
		await sleep(100);
		expect(receivedPrompts().map((line) => line.message)).toEqual([
			"first",
			"q1",
		]);
		expect(manager.status("s-stop")).toBe("idle");
	});

	it("holds the queue after a failed turn until the user steers or edits it", async () => {
		createManager({
			promptEvents: slowTurnEvents({
				stopReason: "error",
				errorMessage: "provider down",
			}),
		});
		await startSession("s-hold");
		const first = manager.handle({
			action: "send",
			sessionId: "s-hold",
			prompt: "first",
		});
		await waitFor(() => manager.status("s-hold") === "running");
		await manager.handle({ action: "send", sessionId: "s-hold", prompt: "q1" });
		const q2 = (await manager.handle({
			action: "send",
			sessionId: "s-hold",
			prompt: "q2",
		})) as QueueResult;
		expect(
			((await first) as { result: { finishReason: string } }).result
				.finishReason,
		).toBe("error");
		await sleep(100);
		expect(receivedPrompts().map((line) => line.message)).toEqual(["first"]);
		expect(manager.status("s-hold")).toBe("idle");

		// Steering while idle starts the first queued prompt now; it fails too,
		// so the rest stays held.
		expect(
			await manager.handle({ action: "steer_prompt", sessionId: "s-hold" }),
		).toMatchObject({ updated: true });
		await waitFor(() => chunkJson("chat_done").length === 2);
		await sleep(100);
		expect(receivedPrompts().map((line) => line.message)).toEqual([
			"first",
			"q1",
		]);

		// Editing the held queue releases it.
		await manager.handle({
			action: "update_pending_prompt",
			sessionId: "s-hold",
			promptId: String(q2.promptsInQueue[1]?.id),
			prompt: "q2 again",
		});
		await waitFor(() =>
			receivedPrompts().some((line) => line.message === "q2 again"),
		);
	});

	it("drops queued prompts with a notice when Pi exits", async () => {
		createManager({ promptEvents: slowTurnEvents({ ticks: 200 }) });
		await startSession("s-exit");
		const first = manager.handle({
			action: "send",
			sessionId: "s-exit",
			prompt: "first",
		});
		await waitFor(() => manager.status("s-exit") === "running");
		await manager.handle({
			action: "send",
			sessionId: "s-exit",
			prompt: "lost",
			attachments: { userFiles: [{ name: "a.txt", content: "x" }] },
		});
		await manager.handle({ action: "stop", sessionId: "s-exit" });
		await first;
		expect(queueItems()).toEqual([]);
		expect(
			readdirSync(join(dir, "session-data", "s-exit", "user-attachments")),
		).toEqual([]);
		expect(manager.isLive("s-exit")).toBe(false);
	});

	it("forks before an edited message into a new Pi session and moves the live process", async () => {
		const path = writeForkSession("fork-src");
		createManager({
			tree: FORK_TREE,
			treeLeafId: "d",
			forkFileEntries: FORK_ENTRIES.slice(0, 2),
		});
		const result = await manager.handle({
			action: "fork",
			sessionId: "fork-src",
			forkBeforeRunCount: 2,
			forkMessageId: "c",
		});
		expect(fake.received().find((line) => line.type === "fork")).toMatchObject({
			entryId: "c",
		});
		expect(result).toMatchObject({
			sessionId: "fork-1",
			forkedFromSessionId: "fork-src",
			messages: [
				{ role: "user", content: "Question one" },
				{ role: "assistant", content: "Answer one" },
			],
		});
		expect(manager.isLive("fork-1")).toBe(true);
		expect(manager.isLive("fork-src")).toBe(false);
		expect(manager.owns("fork-src")).toBe(true);
		// The original thread relaunches from its own file on the next send.
		await manager.handle({
			action: "send",
			sessionId: "fork-src",
			prompt: "still here",
		});
		expect(launches().at(-1)?.argv).toEqual(
			expect.arrayContaining(["--session", path]),
		);
	});

	it("finds a just-sent message by its turn on the current branch", async () => {
		writeForkSession("fork-branch");
		// Pi's leaf is on the second branch (as after /tree), and the webview
		// only has an optimistic id for the message it just sent.
		createManager({ tree: FORK_TREE, treeLeafId: "f" });
		await manager.handle({
			action: "fork",
			sessionId: "fork-branch",
			forkBeforeRunCount: 2,
			forkMessageId: "user_optimistic_1",
		});
		expect(fake.received().find((line) => line.type === "fork")).toMatchObject({
			entryId: "e",
		});
		await expect(
			manager.handle({
				action: "fork",
				sessionId: "fork-1",
				forkBeforeRunCount: 5,
			}),
		).rejects.toThrow(/not on the current Pi branch/);
	});

	it("keeps a fork of the first message usable before Pi writes its file", async () => {
		writeForkSession("fork-first");
		createManager({ tree: FORK_TREE, treeLeafId: "d" });
		const result = await manager.handle({
			action: "fork",
			sessionId: "fork-first",
			forkBeforeRunCount: 1,
			forkMessageId: "a",
		});
		expect(result).toMatchObject({ sessionId: "fork-1", messages: [] });
		await manager.handle({ action: "stop", sessionId: "fork-1" });
		expect(manager.owns("fork-1")).toBe(true);
		expect(
			await manager.handle({ action: "attach", sessionId: "fork-1" }),
		).toMatchObject({ sessionId: "fork-1", status: "idle" });
		await manager.handle({
			action: "send",
			sessionId: "fork-1",
			prompt: "a better first question",
		});
		expect(launches().at(-1)?.argv).toEqual(
			expect.arrayContaining(["--session-id", "fork-1"]),
		);
	});

	it("copies the whole session with Pi's clone, but never while Pi is busy", async () => {
		writeForkSession("fork-copy");
		createManager({
			tree: FORK_TREE,
			treeLeafId: "d",
			promptEvents: slowTurnEvents(),
		});
		const running = manager.handle({
			action: "send",
			sessionId: "fork-copy",
			prompt: "work",
		});
		await waitFor(() => manager.status("fork-copy") === "running");
		await expect(
			manager.handle({ action: "fork", sessionId: "fork-copy" }),
		).rejects.toThrow(/Wait for Pi to finish/);
		await running;
		expect(
			await manager.handle({ action: "fork", sessionId: "fork-copy" }),
		).toMatchObject({ sessionId: "fork-1", forkedFromSessionId: "fork-copy" });
		expect(fake.received().some((line) => line.type === "clone")).toBe(true);
		expect(fake.received().some((line) => line.type === "fork")).toBe(false);
	});

	it("refuses to fork while queued messages wait, and reports a cancelled fork", async () => {
		writeForkSession("fork-held");
		createManager({
			tree: FORK_TREE,
			treeLeafId: "d",
			forkCancelled: true,
			promptEvents: slowTurnEvents({
				stopReason: "error",
				errorMessage: "provider down",
			}),
		});
		const first = manager.handle({
			action: "send",
			sessionId: "fork-held",
			prompt: "fails",
		});
		await waitFor(() => manager.status("fork-held") === "running");
		const queued = (await manager.handle({
			action: "send",
			sessionId: "fork-held",
			prompt: "waits",
		})) as QueueResult;
		await first;
		await expect(
			manager.handle({
				action: "fork",
				sessionId: "fork-held",
				forkBeforeRunCount: 1,
			}),
		).rejects.toThrow(/queued messages/);
		await manager.handle({
			action: "remove_pending_prompt",
			sessionId: "fork-held",
			promptId: String(queued.promptsInQueue[0]?.id),
		});
		await expect(
			manager.handle({
				action: "fork",
				sessionId: "fork-held",
				forkBeforeRunCount: 1,
			}),
		).rejects.toThrow(/cancelled the fork/);
		expect(manager.isLive("fork-held")).toBe(true);
	});

	it("hands the prompt back when Pi rejects it before acceptance", async () => {
		createManager({ promptError: "No model selected" });
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-reject",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		const response = (await manager.handle({
			action: "send",
			sessionId: "s-reject",
			prompt: "x",
		})) as { result: Record<string, unknown> };
		expect(response.result).toEqual({
			finishReason: "error",
			text: "No model selected",
		});
		expect(response.result.messages).toBeUndefined();
		expect(chunkJson("chat_core_log")).toContainEqual({
			level: "error",
			message: "No model selected",
		});
		expect(manager.status("s-reject")).toBe("idle");
	});

	it("fails the turn with stderr when Pi dies mid-run", async () => {
		createManager({ exitOnPrompt: 2 });
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-crash",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		const response = (await manager.handle({
			action: "send",
			sessionId: "s-crash",
			prompt: "boom",
		})) as { result: { finishReason: string; text: string } };
		expect(response.result.finishReason).toBe("error");
		expect(response.result.text).toContain("fake pi crashed");
		expect(chunkJson("chat_done").at(-1)).toMatchObject({ reason: "error" });
		expect(manager.isLive("s-crash")).toBe(false);
	});

	it("reports a missing Pi executable when starting", async () => {
		createManager();
		rmSync(fake.bin);
		await expect(
			manager.handle({
				action: "start",
				config: {
					runtime: "pi",
					sessionId: "s-missing",
					provider: "p",
					model: "m",
					cwd: dir,
				},
			}),
		).rejects.toThrow(/Pi CLI not found/);
		expect(manager.isLive("s-missing")).toBe(false);
	});

	it("resumes a session from Pi's file store and applies a different model", async () => {
		const sessionsDir = join(agentDir, "sessions", "--work--");
		mkdirSync(sessionsDir, { recursive: true });
		const path = join(sessionsDir, "old.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "old-1", timestamp: "2026-09-01T00:00:00.000Z", cwd: dir })}\n${JSON.stringify({ type: "model_change", id: "a", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", provider: "p", modelId: "m" })}\n${JSON.stringify({ type: "message", id: "b", parentId: "a", timestamp: "2026-09-01T00:00:02.000Z", message: { role: "user", content: "Earlier", timestamp: 1 } })}\n`,
		);
		createManager({
			promptEvents: [{ type: "agent_end", messages: [], willRetry: false }],
		});
		expect(manager.owns("old-1")).toBe(true);
		const attached = (await manager.handle({
			action: "attach",
			sessionId: "old-1",
		})) as Record<string, unknown>;
		expect(attached).toMatchObject({
			sessionId: "old-1",
			status: "completed",
			provider: "p",
			model: "m",
			cwd: dir,
		});
		expect(manager.isLive("old-1")).toBe(false);
		expect(manager.readMessages("old-1")?.map((m) => m.content)).toEqual([
			"Earlier",
		]);

		await manager.handle({
			action: "send",
			sessionId: "old-1",
			prompt: "continue",
			config: {
				runtime: "pi",
				provider: "other",
				model: "m2",
				piThinkingLevel: "low",
			},
		});
		const argv = fake.received()[0].argv as string[];
		expect(argv.slice(0, 4)).toEqual(["--mode", "rpc", "--session", path]);
		expect(argv).not.toContain("--model");
		const commands = fake
			.received()
			.slice(1)
			.map((line) => line.type);
		expect(commands).toEqual([
			"get_state",
			"set_model",
			"set_thinking_level",
			"prompt",
		]);
		expect(
			fake.received().find((line) => line.type === "set_model"),
		).toMatchObject({ provider: "other", modelId: "m2" });
		expect(manager.listDiscovered()[0]).toMatchObject({
			sessionId: "old-1",
			source: "pi",
			status: "idle",
			model: "m",
		});
	});

	it("lists slash commands from a discovery process and restarts idle sessions when Pi config changes", async () => {
		createManager({
			commands: [
				{
					name: "review",
					description: "Review code",
					source: "extension",
					sourceInfo: {},
				},
				{ name: "skill:brave", source: "skill", sourceInfo: {} },
				{ name: "bad", source: "other" },
			],
		});
		expect(await manager.listCommands(dir)).toEqual([
			...PI_BUILTIN_SLASH_COMMANDS,
			{ name: "review", description: "Review code", source: "extension" },
			{ name: "skill:brave", description: undefined, source: "skill" },
		]);
		const discovery = fake.received()[0];
		expect(discovery.argv).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--no-tools",
		]);
		expect(discovery.env).toEqual({ PI_OFFLINE: "1" });
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-stale",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		expect(manager.isLive("s-stale")).toBe(true);
		manager.markStale();
		await waitFor(() => !manager.isLive("s-stale"));
		expect(manager.isLive("s-stale")).toBe(false);
	});

	it("keeps bare builtins when discovery fails and lets builtins win name collisions", async () => {
		createManager({ commandsError: "discovery down" });
		const fallback = await manager.listCommands(dir);
		expect(fallback.map((command) => command.name)).toEqual(
			PI_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
		);
		expect(fallback.every((command) => !command.name.startsWith("/"))).toBe(
			true,
		);
		expect(fallback.find((command) => command.name === "compact")).toEqual(
			expect.objectContaining({ source: "builtin" }),
		);
		fake.setScenario({
			commands: [
				{
					name: "review",
					description: "Review code",
					source: "extension",
					sourceInfo: {},
				},
			],
		});
		expect(
			(await manager.listCommands(dir)).some(
				(command) =>
					command.name === "review" && command.source === "extension",
			),
		).toBe(true);

		await manager.dispose();
		createManager({
			commands: [
				{
					name: "compact",
					description: "extension compact",
					source: "extension",
					sourceInfo: {},
				},
				{
					name: "bug",
					description: "extension bug",
					source: "extension",
					sourceInfo: {},
				},
				{
					name: "/review",
					description: "slashed",
					source: "extension",
					sourceInfo: {},
				},
				{ name: "compact:2", source: "extension", sourceInfo: {} },
				{ name: "skill:compact", source: "skill", sourceInfo: {} },
			],
		});
		const listed = await manager.listCommands(dir);
		for (const name of ["compact", "bug"]) {
			expect(listed.find((command) => command.name === name)?.source).toBe(
				"builtin",
			);
			expect(
				listed.some(
					(command) => command.name === name && command.source === "extension",
				),
			).toBe(false);
		}
		expect(listed.map((command) => command.name)).toEqual(
			expect.arrayContaining(["review", "compact:2", "skill:compact"]),
		);
	});

	it("configures scoped models for a session and saves them for new sessions", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a", name: "Alpha A" },
				{ provider: "alpha", id: "b", name: "Alpha B" },
				{ provider: "beta", id: "c", name: "Beta C" },
			],
		});
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				enabledModels: ["alpha/*"],
				defaultModel: "preserved",
			}),
		);
		await startPi(manager, "s-scope");
		const sessionsDir = join(agentDir, "sessions", "--work--");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(
			join(sessionsDir, "s-scope.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "s-scope", cwd: dir, timestamp: new Date().toISOString() })}\n`,
		);
		expect(
			await manager.executeCommand({
				sessionId: "s-scope",
				text: "/scoped-models",
			}),
		).toMatchObject({
			uiAction: "scoped-models",
		});
		const scope = await manager.listModelScope({ sessionId: "s-scope" });
		expect(scope).toMatchObject({
			enabled: ["alpha/a", "alpha/b"],
			hasSession: true,
		});
		await expect(
			manager.setModelScope({
				sessionId: "s-scope",
				enabled: ["alpha/unknown"],
				save: false,
			}),
		).rejects.toThrow(/selection has changed/);
		await manager.setModelScope({
			sessionId: "s-scope",
			enabled: ["beta/c"],
			save: false,
		});
		expect(manager.isLive("s-scope")).toBe(false);
		expect(
			JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
				.enabledModels,
		).toEqual(["alpha/*"]);
		await startPi(manager, "s-scope");
		expect(
			fake.received().findLast((record) => Array.isArray(record.argv))?.argv,
		).toContain("beta/c");
		expect(
			(await manager.listModelScope({ sessionId: "s-scope" })).enabled,
		).toEqual(["beta/c"]);
		await manager.setModelScope({
			sessionId: "s-scope",
			enabled: ["alpha/a"],
			save: true,
		});
		expect(
			JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
		).toMatchObject({
			enabledModels: ["alpha/a"],
			defaultModel: "preserved",
		});
		await manager.setModelScope({
			sessionId: "s-scope",
			enabled: [],
			save: true,
		});
		expect(
			JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
				.enabledModels,
		).toBeUndefined();
	});

	it("restarts a scoped Pi session before its first turn has written a file", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
				{ provider: "alpha", id: "c" },
			],
		});
		await startPi(manager, "s-new-scope");
		expect(manager.files.findById("s-new-scope")).toBeUndefined();
		await manager.setModelScope({
			sessionId: "s-new-scope",
			enabled: ["alpha/a", "alpha/b"],
			save: false,
		});
		expect(manager.isLive("s-new-scope")).toBe(false);
		expect(
			await manager.listModelScope({ sessionId: "s-new-scope" }),
		).toMatchObject({
			hasSession: true,
			enabled: ["alpha/a", "alpha/b"],
		});
		const cycled = await manager.cycleModel("s-new-scope");
		expect(cycled?.providerId).toBe("alpha");
		expect(manager.isLive("s-new-scope")).toBe(true);
		expect(
			fake.received().findLast((record) => Array.isArray(record.argv))?.argv,
		).toEqual(expect.arrayContaining(["--models", "alpha/a,alpha/b"]));
		await manager.stop({ action: "stop", sessionId: "s-new-scope" });
		expect(manager.files.findById("s-new-scope")).toBeUndefined();
		const next = await manager.cycleModel("s-new-scope");
		expect(next?.modelId).toBe("b");
		expect(
			fake.received().findLast((record) => Array.isArray(record.argv))?.argv,
		).toEqual(
			expect.arrayContaining([
				"--model",
				"alpha/a",
				"--models",
				"alpha/a,alpha/b",
			]),
		);
	});

	it("sends the first prompt after scoping an empty Pi session", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
			],
		});
		await startPi(manager, "s-empty-send");
		await manager.setModelScope({
			sessionId: "s-empty-send",
			enabled: ["alpha/a"],
			save: false,
		});
		expect(
			await manager.attach({ action: "attach", sessionId: "s-empty-send" }),
		).toMatchObject({
			status: "idle",
			provider: "p",
			model: "m",
			cwd: dir,
		});
		await manager.send({
			action: "send",
			sessionId: "s-empty-send",
			prompt: "hello pi",
		});
		expect(rpcTypes()).toContain("prompt");
		expect(
			fake.received().findLast((record) => Array.isArray(record.argv))?.argv,
		).toEqual(
			expect.arrayContaining(["--model", "p/m", "--models", "alpha/a"]),
		);
	});

	it("retains the configuration when restarting an empty scoped Pi session", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
			],
		});
		await startPi(manager, "s-empty-start");
		await manager.setModelScope({
			sessionId: "s-empty-start",
			enabled: ["alpha/b"],
			save: false,
		});
		await manager.start({
			action: "start",
			config: { sessionId: "s-empty-start" },
		});
		expect(manager.isLive("s-empty-start")).toBe(true);
		expect(
			fake.received().findLast((record) => Array.isArray(record.argv))?.argv,
		).toEqual(
			expect.arrayContaining(["--model", "p/m", "--models", "alpha/b"]),
		);
	});

	it("forgets session-only scoped models when the session is deleted", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
			],
		});
		await startPi(manager, "s-delete-scope");
		await manager.setModelScope({
			sessionId: "s-delete-scope",
			enabled: ["alpha/a"],
			save: false,
		});
		await manager.deleteSession("s-delete-scope");
		expect(manager.owns("s-delete-scope")).toBe(false);
		await startPi(manager, "s-delete-scope");
		const lastArgv = fake.received().findLast((entry) => entry.argv)?.argv;
		expect(lastArgv).not.toContain("--models");
	});

	it("shows Pi's resolved configured model scope in cycling order", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
				{ provider: "beta", id: "c" },
			],
		});
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ enabledModels: ["beta/c", "alpha/[ab]:high"] }),
		);
		await startPi(manager, "s-pattern-scope");
		expect(
			(await manager.listModelScope({ sessionId: "s-pattern-scope" })).enabled,
		).toEqual(["beta/c", "alpha/a", "alpha/b"]);
	});

	it("does not restart a busy Pi session to change its scoped models", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
			],
			promptEvents: [{ __waitForUi__: true }],
		});
		await startPi(manager, "s-scope-busy");
		const pending = manager.handle({
			action: "send",
			sessionId: "s-scope-busy",
			prompt: "hello",
		});
		await waitFor(() => manager.status("s-scope-busy") === "running");
		await expect(
			manager.setModelScope({
				sessionId: "s-scope-busy",
				enabled: ["alpha/a"],
				save: false,
			}),
		).rejects.toThrow(/busy/i);
		expect(manager.isLive("s-scope-busy")).toBe(true);
		await manager.handle({ action: "abort", sessionId: "s-scope-busy" });
		await pending;
	});

	it("cycles Pi models using the RPC command and keeps the session selection", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
			],
		});
		await startPi(manager, "s-cycle");
		expect(await manager.cycleModel("s-cycle")).toMatchObject({
			providerId: "alpha",
			modelId: "a",
		});
		expect(await manager.cycleModel("s-cycle")).toMatchObject({
			providerId: "alpha",
			modelId: "b",
		});
		expect(rpcTypes().filter((type) => type === "cycle_model")).toHaveLength(2);
		expect(manager.isLive("s-cycle")).toBe(true);
	});

	it("offers the Pi scope selector before a session exists and refuses session-only writes", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "beta", id: "b" },
			],
		});
		expect(await manager.listModelScope({ workspaceRoot: dir })).toMatchObject({
			hasSession: false,
			enabled: null,
		});
		await expect(
			manager.setModelScope({
				workspaceRoot: dir,
				enabled: ["alpha/a"],
				save: false,
			}),
		).rejects.toThrow(/Start a Pi session/);
		await manager.setModelScope({
			workspaceRoot: dir,
			enabled: ["alpha/a"],
			save: true,
		});
		expect(
			(await manager.listModelScope({ workspaceRoot: dir })).enabled,
		).toEqual(["alpha/a"]);
	});

	it("runs /model provider/model and /thinking level through Pi rather than ignoring arguments", async () => {
		createManager({
			models: [
				{ provider: "p", id: "m" },
				{ provider: "alpha", id: "a" },
			],
		});
		await startPi(manager, "s-selection");
		expect(
			await manager.executeCommand({
				sessionId: "s-selection",
				text: "/model alpha/a",
			}),
		).toMatchObject({
			selection: { providerId: "alpha", modelId: "a" },
		});
		expect(
			await manager.executeCommand({
				sessionId: "s-selection",
				text: "/thinking high",
			}),
		).toMatchObject({
			selection: { providerId: "alpha", modelId: "a", thinkingLevel: "high" },
		});
		expect(rpcTypes()).toContain("set_model");
		expect(rpcTypes()).toContain("set_thinking_level");
		expect(
			await manager.executeCommand({
				sessionId: "s-selection",
				text: "/model unknown/x",
			}),
		).toMatchObject({
			uiAction: "model",
			message: expect.stringContaining("Could not uniquely match"),
		});
		await expect(
			manager.executeCommand({
				sessionId: "s-selection",
				text: "/thinking impossible",
			}),
		).rejects.toThrow(/Use \/thinking/);
		expect(
			await manager.executeCommand({ text: "/thinking low" }),
		).toMatchObject({
			selection: { thinkingLevel: "low" },
		});
		expect(await manager.executeCommand({ text: "/thinking" })).toMatchObject({
			uiAction: "thinking",
		});
	});

	it("reports Pi's effective thinking level after /model changes it", async () => {
		createManager({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
			],
			modelThinkingLevels: { "alpha/b": "low" },
		});
		await startPi(manager, "s-model-thinking");
		await manager.executeCommand({
			sessionId: "s-model-thinking",
			text: "/thinking high",
		});
		expect(
			await manager.executeCommand({
				sessionId: "s-model-thinking",
				text: "/model alpha/b",
			}),
		).toMatchObject({
			selection: { providerId: "alpha", modelId: "b", thinkingLevel: "low" },
		});
		expect(rpcTypes()).toEqual(
			expect.arrayContaining(["set_model", "get_state"]),
		);
		await startPi(manager, "s-model-thinking");
		expect(
			rpcTypes().filter((type) => type === "set_thinking_level"),
		).toHaveLength(1);
	});

	it("returns the last Pi assistant text for /copy without sending it to the model", async () => {
		createManager({ lastAssistantText: "Pi's final answer" });
		await startPi(manager, "s-copy");
		expect(
			await manager.executeCommand({ sessionId: "s-copy", text: "/copy" }),
		).toMatchObject({
			clipboardText: "Pi's final answer",
		});
		expect(rpcTypes()).toContain("get_last_assistant_text");
		expect(rpcTypes()).not.toContain("prompt");
	});

	it("compacts an idle session with custom instructions and does not invent a user turn", async () => {
		createManager();
		await startPi(manager, "s-compact");
		const result = await manager.executeCommand({
			sessionId: "s-compact",
			text: "/compact focus on auth and tests",
		});
		expect(result).toEqual({
			handled: true,
			refresh: true,
			message: expect.stringContaining("Compacted the session."),
		});
		expect(result).toEqual({
			handled: true,
			refresh: true,
			message: expect.stringContaining("focus on auth and tests"),
		});
		expect(rpcTypes()).toContain("compact");
		expect(rpcTypes()).not.toContain("prompt");
		expect(
			fake.received().find((line) => line.type === "compact"),
		).toMatchObject({
			type: "compact",
			customInstructions: "focus on auth and tests",
		});
		expect(chunks("chat_queued_prompt_start")).toEqual([]);
		expect(chunks("chat_done")).toEqual([]);
		expect(events("chat_session_ended")).toEqual([]);
		expect(manager.status("s-compact")).toBe("idle");
	});

	it("rejects compaction while busy and when Pi reports an error", async () => {
		createManager({
			promptEvents: [{ __waitForUi__: true }],
			compactError: "Nothing to compact (session too small)",
		});
		await startPi(manager, "s-busy");
		const pending = manager.handle({
			action: "send",
			sessionId: "s-busy",
			prompt: "hello",
		});
		await waitFor(() => manager.status("s-busy") === "running");
		await expect(
			manager.executeCommand({ sessionId: "s-busy", text: "/compact" }),
		).rejects.toThrow(/busy/i);
		expect(rpcTypes()).not.toContain("compact");
		await manager.handle({ action: "abort", sessionId: "s-busy" });
		await pending;

		await expect(
			manager.executeCommand({ sessionId: "s-busy", text: "/compact" }),
		).rejects.toThrow("Nothing to compact (session too small)");
		expect(manager.status("s-busy")).toBe("idle");
		expect(chunks("chat_queued_prompt_start")).toEqual([]);
	});

	it("aborts a compaction that exceeds the RPC timeout", async () => {
		createManager({ compactDelayMs: 500 }, { compactTimeoutMs: 40 });
		await startPi(manager, "s-timeout");
		await expect(
			manager.executeCommand({ sessionId: "s-timeout", text: "/compact" }),
		).rejects.toThrow(/Compaction timed out after 40ms/);
		expect(rpcTypes()).toContain("abort");
		expect(manager.isLive("s-timeout")).toBe(false);
		expect(manager.status("s-timeout")).toBeUndefined();
		await expect(
			manager.handle({
				action: "send",
				sessionId: "s-timeout",
				prompt: "/compact later",
			}),
		).rejects.toThrow(/execute_pi_command/);
	});

	it("terminates a stale process after compaction rather than on the next turn", async () => {
		createManager({ compactDelayMs: 120 });
		await startPi(manager, "s-stale-compact");
		const pending = manager.executeCommand({
			sessionId: "s-stale-compact",
			text: "/compact",
		});
		await waitFor(() => rpcTypes().includes("compact"));
		manager.markStale();
		expect(manager.isLive("s-stale-compact")).toBe(true);
		await expect(pending).resolves.toMatchObject({
			handled: true,
			refresh: true,
		});
		await waitFor(() => !manager.isLive("s-stale-compact"));
	});

	it("reports cancellations and stopped compactions clearly", async () => {
		createManager({ compactDelayMs: 500 });
		await startPi(manager, "s-cancel-compact");
		const pending = manager.executeCommand({
			sessionId: "s-cancel-compact",
			text: "/compact",
		});
		const cancelled = expect(pending).rejects.toThrow(
			/Compaction was cancelled/,
		);
		await waitFor(() => rpcTypes().includes("compact"));
		await manager.handle({ action: "abort", sessionId: "s-cancel-compact" });
		await cancelled;
		expect(manager.status("s-cancel-compact")).toBe("idle");

		await manager.dispose();
		createManager({ compactDelayMs: 500 });
		await startPi(manager, "s-stop-compact");
		const stopped = manager.executeCommand({
			sessionId: "s-stop-compact",
			text: "/compact",
		});
		const stopError = expect(stopped).rejects.toThrow(/Pi session closed/);
		await waitFor(() => rpcTypes().includes("compact"));
		await manager.handle({ action: "stop", sessionId: "s-stop-compact" });
		await stopError;
	});

	it("sets and shows a session name, reports stats, and exports HTML without overwriting the session", async () => {
		createManager();
		await startPi(manager, "s-meta");
		expect(
			await manager.executeCommand({ sessionId: "s-meta", text: "/name" }),
		).toEqual({
			handled: true,
			message: "Usage: /name <name>. This session has no display name.",
		});
		expect(
			await manager.executeCommand({
				sessionId: "s-meta",
				text: "/name Auth refactor",
			}),
		).toEqual({
			handled: true,
			refresh: true,
			message: "Session name set to Auth refactor.",
		});
		const info = await manager.executeCommand({
			sessionId: "s-meta",
			text: "/session",
		});
		expect(info).toMatchObject({ handled: true });
		if (!info.handled) throw new Error("session command was not handled");
		expect(info.message).toContain("Name: Auth refactor");
		expect(info.message).toContain("Messages: 2 total");
		expect(info.message).toContain("Tokens: 7 total");
		expect("refresh" in info).toBe(false);

		const exported = await manager.executeCommand({
			sessionId: "s-meta",
			text: '/export "out file.html"',
		});
		expect(exported).toEqual({
			handled: true,
			message: "Exported the session to HTML: out file.html",
		});
		expect(
			fake.received().find((line) => line.type === "export_html"),
		).toMatchObject({ outputPath: "out file.html" });

		const liveFile = `${dir}/sessions/s-meta.jsonl`;
		for (const path of [liveFile, pathToFileURL(liveFile).href]) {
			await expect(
				manager.executeCommand({
					sessionId: "s-meta",
					text: `/export ${path}`,
				}),
			).rejects.toThrow(/active Pi session file/);
		}
		expect(
			await manager.executeCommand({
				sessionId: "s-meta",
				text: "/export notes.jsonl",
			}),
		).toMatchObject({
			handled: true,
			message: expect.stringContaining("Nothing was written"),
		});
		expect(
			fake.received().filter((line) => line.type === "export_html"),
		).toHaveLength(1);
	});

	it("normalizes tilde paths before guarding the active session export", async () => {
		const homeSession = join(homedir(), "sessions", "s-home.jsonl");
		createManager({ state: { sessionFile: homeSession } });
		await startPi(manager, "s-home");
		await expect(
			manager.executeCommand({
				sessionId: "s-home",
				text: "/export ~/sessions/s-home.jsonl",
			}),
		).rejects.toThrow(/active Pi session file/);
		expect(rpcTypes()).not.toContain("export_html");
	});

	it("dispatches desktop controls, leaves extensions alone, and does not claim unsupported commands", async () => {
		createManager({
			commands: [
				{ name: "review", description: "Review", source: "extension" },
				{ name: "compact", description: "ext", source: "extension" },
			],
		});
		expect(await manager.executeCommand({ text: "/review the diff" })).toEqual({
			handled: false,
		});
		expect(await manager.executeCommand({ text: "/compact:2" })).toEqual({
			handled: false,
		});
		expect(await manager.executeCommand({ text: "/new" })).toEqual({
			handled: true,
			uiAction: "new",
			message: "Starting a new session.",
		});
		expect(await manager.executeCommand({ text: "/model" })).toMatchObject({
			handled: true,
			uiAction: "model",
		});
		expect(await manager.executeCommand({ text: "/settings" })).toMatchObject({
			uiAction: "settings",
		});
		expect(await manager.executeCommand({ text: "/resume" })).toMatchObject({
			uiAction: "resume",
		});
		await expect(manager.executeCommand({ text: "/fork" })).rejects.toThrow(
			/active Pi session is required/,
		);
		expect(
			await manager.executeCommand({ sessionId: "s-1", text: "/fork" }),
		).toMatchObject({
			handled: true,
			uiAction: "fork",
			message: expect.stringContaining("not forked"),
		});
		expect(await manager.executeCommand({ text: "/clone" })).toMatchObject({
			handled: true,
			message: expect.stringContaining("Nothing was duplicated"),
		});
		const reload = await manager.executeCommand({ text: "/reload" });
		expect(reload).toMatchObject({ handled: true });
		if (!reload.handled) throw new Error("reload was not handled");
		expect(reload.message).toMatch(/not available/i);
		expect(reload.message).not.toMatch(/reloaded/i);
		expect("uiAction" in reload).toBe(false);
		const imported = await manager.executeCommand({ text: "/import a.jsonl" });
		if (!imported.handled) throw new Error("import was not handled");
		expect(imported.message).toMatch(/Nothing was imported/);
		const shared = await manager.executeCommand({ text: "/share" });
		if (!shared.handled) throw new Error("share was not handled");
		expect(shared.message).toMatch(/does not share or upload/);
		expect(rpcTypes()).not.toContain("prompt");
	});
});

async function startPi(target: PiSessionManager, sessionId: string) {
	await target.handle({
		action: "start",
		config: {
			runtime: "pi",
			sessionId,
			provider: "p",
			model: "m",
			cwd: dir,
			workspaceRoot: dir,
		},
	});
}

function rpcTypes(): string[] {
	return fake
		.received()
		.map((line) => line.type)
		.filter((type): type is string => typeof type === "string");
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
