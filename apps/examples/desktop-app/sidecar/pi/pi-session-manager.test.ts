import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSidecarContext } from "../context";
import type { SidecarContext, SidecarWebSocketClient } from "../types";
import { PI_DESKTOP_APPROVAL_TITLE } from "./pi-desktop-gate-extension";
import { PiSessionFiles } from "./pi-session-files";
import { PiSessionManager } from "./pi-session-manager";
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

function createManager(scenario: Parameters<typeof createFakePi>[1] = {}) {
	fake = createFakePi(join(dir, "fake"), scenario);
	manager = new PiSessionManager(ctx, {
		files: new PiSessionFiles(() => agentDir),
		binary: fake.bin,
		reapIntervalMs: 0,
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

	it("queues prompts sent while a turn runs and announces them when Pi starts them", async () => {
		createManager({
			promptEvents: [
				{ type: "agent_start" },
				// Pi echoes the direct prompt's own user message first; only the
				// queued follow-up that starts later is news to the webview.
				{
					type: "message_start",
					message: { role: "user", content: "{{prompt}}", timestamp: 1 },
				},
				{ __wait__: 150 },
				{
					type: "message_start",
					message: { role: "user", content: "later", timestamp: 2 },
				},
				{ type: "agent_end", messages: [], willRetry: false },
			],
		});
		await manager.handle({
			action: "start",
			config: {
				runtime: "pi",
				sessionId: "s-queue",
				provider: "p",
				model: "m",
				cwd: dir,
			},
		});
		const first = manager.handle({
			action: "send",
			sessionId: "s-queue",
			prompt: "first",
		});
		await waitFor(() => events("chat_session_status").length === 1);
		const queued = (await manager.handle({
			action: "send",
			sessionId: "s-queue",
			prompt: "later",
		})) as { queued: boolean; promptsInQueue: unknown[] };
		expect(queued.queued).toBe(true);
		await first;
		const followUp = fake
			.received()
			.find((line) => line.type === "prompt" && line.message === "later");
		expect(followUp).toMatchObject({ streamingBehavior: "followUp" });
		expect(chunkJson("chat_queued_prompt_start")).toEqual([
			{ promptId: "pi_s-queue_1", prompt: "later", attachmentCount: 0 },
		]);
		expect(events("prompts_in_queue_state").at(-1)).toMatchObject({
			items: [{ id: "followUp:0", prompt: "later", steer: false }],
		});
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
});

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
