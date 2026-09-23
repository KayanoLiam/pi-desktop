import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test double for `pi --mode rpc`: a script that speaks the JSONL protocol
 * and replays a scripted scenario. Tests never spawn the developer's real Pi.
 *
 * Scenario (JSON file next to the script):
 *   - `promptEvents`: events emitted after each accepted `prompt`, in order.
 *     `"{{prompt}}"` inside string values is replaced with the prompt text.
 *     An entry `{ "__wait__": ms }` pauses; `{ "__waitForUi__": true }` waits
 *     for the next `extension_ui_response` before continuing.
 *   - `promptError`: when set, `prompt` is rejected with this message.
 *   - `state`, `models`, `commands`, `messages`: canned `get_*` responses.
 *   - `exitOnPrompt`: exit code to die with when a prompt arrives (before
 *     answering it).
 *   - `startupExitCode` / `startupStderr`: fail at launch instead of serving.
 * Every stdin line is appended to `<bin>.received.jsonl`.
 */
export type FakePiScenario = {
	promptEvents?: unknown[];
	promptError?: string;
	state?: Record<string, unknown>;
	models?: unknown[];
	commands?: unknown[];
	/** When set, `get_commands` fails so discovery fallback can be tested. */
	commandsError?: string;
	messages?: unknown[];
	compactResult?: Record<string, unknown>;
	compactError?: string;
	compactDelayMs?: number;
	stats?: Record<string, unknown>;
	statsError?: string;
	exportPath?: string;
	exportError?: string;
	exitOnPrompt?: number;
	startupExitCode?: number;
	startupStderr?: string;
	/** Print this on stdout before serving (simulates extension noise). */
	startupStdoutNoise?: string;
};

const FAKE_PI_SOURCE = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const scenarioPath = process.env.FAKE_PI_SCENARIO;
const receivedPath = process.env.FAKE_PI_RECEIVED;
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const readScenario = () => {
	try {
		return JSON.parse(readFileSync(scenarioPath, "utf8"));
	} catch {
		return scenario;
	}
};
const args = process.argv.slice(2);
appendFileSync(receivedPath, JSON.stringify({ argv: args, cwd: process.cwd(), env: { PI_OFFLINE: process.env.PI_OFFLINE ?? null } }) + "\n");

if (scenario.startupStderr) process.stderr.write(scenario.startupStderr);
if (typeof scenario.startupExitCode === "number") process.exit(scenario.startupExitCode);
if (scenario.startupStdoutNoise) process.stdout.write(scenario.startupStdoutNoise);

const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionId = (() => {
	const index = args.indexOf("--session-id");
	if (index >= 0) return args[index + 1];
	const sessionIndex = args.indexOf("--session");
	if (sessionIndex >= 0) return "resumed-" + args[sessionIndex + 1].split("/").pop().replace(/\.jsonl$/, "");
	return "fake-session";
})();
const sessionFile = (() => {
	const sessionIndex = args.indexOf("--session");
	if (sessionIndex >= 0) return args[sessionIndex + 1];
	return process.cwd() + "/sessions/" + sessionId + ".jsonl";
})();
let modelArg = null;
{
	const index = args.indexOf("--model");
	if (index >= 0) modelArg = args[index + 1];
}
let thinkingArg = "medium";
{
	const index = args.indexOf("--thinking");
	if (index >= 0) thinkingArg = args[index + 1];
}
const modelFromArg = () => {
	if (!modelArg) return null;
	const slash = modelArg.indexOf("/");
	return { provider: modelArg.slice(0, slash), id: modelArg.slice(slash + 1) };
};
let model = modelFromArg();
let thinkingLevel = thinkingArg;
let streaming = false;
let abortRequested = false;
let uiWaiters = [];
let sessionName;

const substitute = (value, prompt) => {
	if (typeof value === "string") return value.split("{{prompt}}").join(prompt);
	if (Array.isArray(value)) return value.map((item) => substitute(item, prompt));
	if (value && typeof value === "object") {
		const next = {};
		for (const [key, item] of Object.entries(value)) next[key] = substitute(item, prompt);
		return next;
	}
	return value;
};

async function runPrompt(prompt) {
	streaming = true;
	abortRequested = false;
	for (const raw of scenario.promptEvents ?? []) {
		if (abortRequested) break;
		if (raw && typeof raw === "object" && "__wait__" in raw) {
			await sleep(raw.__wait__);
			continue;
		}
		if (raw && typeof raw === "object" && "__waitForUi__" in raw) {
			await new Promise((resolve) => uiWaiters.push(resolve));
			continue;
		}
		out(substitute(raw, prompt));
	}
	if (abortRequested) {
		out({ type: "message_end", message: { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() } });
		out({ type: "agent_end", messages: [], willRetry: false });
	}
	streaming = false;
	out({ type: "agent_settled" });
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		let line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) continue;
		void handle(line);
	}
});
process.stdin.on("end", () => process.exit(0));

async function handle(line) {
	appendFileSync(receivedPath, line + "\n");
	let command;
	try {
		command = JSON.parse(line);
	} catch (error) {
		out({ type: "response", command: "parse", success: false, error: String(error) });
		return;
	}
	const id = command.id;
	switch (command.type) {
		case "extension_ui_response": {
			const waiter = uiWaiters.shift();
			if (waiter) waiter();
			return;
		}
		case "prompt": {
			if (scenario.promptError) {
				out({ id, type: "response", command: "prompt", success: false, error: scenario.promptError });
				return;
			}
			if (streaming && !command.streamingBehavior) {
				out({ id, type: "response", command: "prompt", success: false, error: "Agent is streaming; specify streamingBehavior" });
				return;
			}
			if (typeof scenario.exitOnPrompt === "number") {
				// Die before answering so callers see an in-flight request fail.
				process.stderr.write("fake pi crashed\n");
				process.exit(scenario.exitOnPrompt);
			}
			out({ id, type: "response", command: "prompt", success: true });
			if (streaming) {
				out({ type: "queue_update", steering: command.streamingBehavior === "steer" ? [command.message] : [], followUp: command.streamingBehavior === "followUp" ? [command.message] : [] });
				return;
			}
			void runPrompt(command.message);
			return;
		}
		case "abort": {
			abortRequested = true;
			for (const waiter of uiWaiters.splice(0)) waiter();
			await sleep(5);
			out({ id, type: "response", command: "abort", success: true });
			return;
		}
		case "get_state":
			out({ id, type: "response", command: "get_state", success: true, data: { model: model ? { provider: model.provider, id: model.id, name: model.id } : null, thinkingLevel, isStreaming: streaming, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", sessionFile, sessionId, sessionName, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0, ...(scenario.state ?? {}) } });
			return;
		case "set_model":
			if (command.provider === "missing") {
				out({ id, type: "response", command: "set_model", success: false, error: "Model not found: missing/" + command.modelId });
				return;
			}
			model = { provider: command.provider, id: command.modelId };
			out({ id, type: "response", command: "set_model", success: true, data: { provider: model.provider, id: model.id, name: model.id } });
			return;
		case "set_thinking_level":
			thinkingLevel = command.level;
			out({ id, type: "response", command: "set_thinking_level", success: true });
			return;
		case "get_available_models":
			out({ id, type: "response", command: "get_available_models", success: true, data: { models: scenario.models ?? [] } });
			return;
		case "get_commands": {
			const liveScenario = readScenario();
			if (liveScenario.commandsError) {
				out({ id, type: "response", command: "get_commands", success: false, error: String(liveScenario.commandsError) });
				return;
			}
			out({ id, type: "response", command: "get_commands", success: true, data: { commands: liveScenario.commands ?? scenario.commands ?? [] } });
			return;
		}
		case "compact": {
			const liveScenario = readScenario();
			if (liveScenario.compactError) {
				out({ id, type: "response", command: "compact", success: false, error: String(liveScenario.compactError) });
				return;
			}
			const delay = Number(liveScenario.compactDelayMs ?? 0);
			const started = Date.now();
			while (Date.now() - started < delay) {
				if (abortRequested) {
					out({ type: "compaction_end", reason: "manual", aborted: true, result: null, willRetry: false });
					out({ id, type: "response", command: "compact", success: false, error: "Compaction cancelled" });
					return;
				}
				await sleep(10);
			}
			const result = liveScenario.compactResult ?? {
				summary: "Compacted summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				estimatedTokensAfter: 20,
			};
			out({ type: "compaction_start", reason: "manual" });
			out({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result });
			out({ id, type: "response", command: "compact", success: true, data: result });
			return;
		}
		case "get_session_stats": {
			const liveScenario = readScenario();
			if (liveScenario.statsError) {
				out({ id, type: "response", command: "get_session_stats", success: false, error: String(liveScenario.statsError) });
				return;
			}
			out({ id, type: "response", command: "get_session_stats", success: true, data: liveScenario.stats ?? {
				sessionFile,
				sessionId,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, total: 7 },
				cost: 0.01,
			} });
			return;
		}
		case "export_html": {
			const liveScenario = readScenario();
			if (liveScenario.exportError) {
				out({ id, type: "response", command: "export_html", success: false, error: String(liveScenario.exportError) });
				return;
			}
			const path = command.outputPath || liveScenario.exportPath || (process.cwd() + "/session.html");
			out({ id, type: "response", command: "export_html", success: true, data: { path } });
			return;
		}
		case "get_messages":
			out({ id, type: "response", command: "get_messages", success: true, data: { messages: scenario.messages ?? [] } });
			return;
		case "set_session_name":
			sessionName = command.name;
			out({ id, type: "response", command: "set_session_name", success: true });
			return;
		case "clear_queue":
			out({ id, type: "response", command: "clear_queue", success: true, data: { steering: [], followUp: [] } });
			return;
		default:
			out({ id, type: "response", command: command.type, success: false, error: "unsupported in fake pi: " + command.type });
	}
}
`;

export type FakePi = {
	/** Executable to use as `PI_DESKTOP_PI_BIN`. */
	bin: string;
	scenarioPath: string;
	receivedPath: string;
	/** Every stdin line the fake received (plus the argv record first). */
	received(): Array<Record<string, unknown>>;
	setScenario(scenario: FakePiScenario): void;
};

export function createFakePi(
	dir: string,
	scenario: FakePiScenario = {},
): FakePi {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, "fake-pi.mjs");
	const bin = join(dir, "fake-pi");
	const scenarioPath = join(dir, "scenario.json");
	const receivedPath = join(dir, "received.jsonl");
	writeFileSync(script, FAKE_PI_SOURCE);
	writeFileSync(scenarioPath, JSON.stringify(scenario));
	writeFileSync(receivedPath, "");
	// The wrapper runs the script with whatever runtime executes the tests, so
	// the fake needs neither a global `node` nor a global `bun`.
	writeFileSync(
		bin,
		`#!/bin/sh
FAKE_PI_SCENARIO="${scenarioPath}" FAKE_PI_RECEIVED="${receivedPath}" exec "${process.execPath}" "${script}" "$@"
`,
		{ mode: 0o755 },
	);
	return {
		bin,
		scenarioPath,
		receivedPath,
		received() {
			return readFileSync(receivedPath, "utf8")
				.split("\n")
				.filter((line: string) => line.trim())
				.map((line: string) => JSON.parse(line) as Record<string, unknown>);
		},
		setScenario(next) {
			writeFileSync(scenarioPath, JSON.stringify(next));
		},
	};
}

/** A plain streamed answer with one bash tool call, for reuse across tests. */
export function textAndToolScenarioEvents(): unknown[] {
	const usage = {
		input: 12,
		output: 4,
		cacheRead: 3,
		cacheWrite: 0,
		totalTokens: 19,
		cost: {
			input: 0.001,
			output: 0.002,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.003,
		},
	};
	const assistant = (content: unknown[], stopReason = "stop") => ({
		role: "assistant",
		content,
		api: "fake-api",
		provider: "fake-provider",
		model: "fake-model",
		usage,
		stopReason,
		timestamp: 1_700_000_000_000,
	});
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{
			type: "message_start",
			message: assistant([]),
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Plan it",
			},
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "Hello ",
			},
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "world !",
			},
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 2,
				id: "call_1",
				toolName: "bash",
			},
		},
		{
			type: "message_end",
			message: assistant(
				[
					{ type: "thinking", thinking: "Plan it" },
					{ type: "text", text: "Hello world !" },
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
				"toolUse",
			),
		},
		{
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "ls" },
		},
		{
			type: "tool_execution_update",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { content: [{ type: "text", text: "a\n" }], details: {} },
		},
		{
			type: "tool_execution_update",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: {
				content: [{ type: "text", text: "a\nb\n" }],
				details: {},
			},
		},
		{
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a\nb\n" }], details: {} },
			isError: false,
		},
		{
			type: "turn_end",
			message: assistant([], "toolUse"),
			toolResults: [],
		},
		{ type: "turn_start" },
		{ type: "message_start", message: assistant([]) },
		{
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		},
		{
			type: "message_update",
			usage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Done: {{prompt}}",
			},
		},
		{
			type: "message_end",
			message: assistant([{ type: "text", text: "Done: {{prompt}}" }]),
		},
		{
			type: "turn_end",
			message: assistant([{ type: "text", text: "Done: {{prompt}}" }]),
			toolResults: [],
		},
		{
			type: "agent_end",
			messages: [
				{ role: "user", content: "{{prompt}}", timestamp: 1 },
				assistant([{ type: "text", text: "Done: {{prompt}}" }]),
			],
			willRetry: false,
		},
	];
}
