import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachJsonlLineReader,
	type PiRpcEvent,
	PiRpcProcess,
	PiRpcProcessExitedError,
} from "./pi-rpc-process";
import {
	createFakePi,
	textAndToolScenarioEvents,
} from "./test-helpers/fake-pi";

const dirs: string[] = [];
const processes: PiRpcProcess[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-desktop-rpc-"));
	dirs.push(dir);
	return dir;
}

function start(bin: string, args: string[] = ["--mode", "rpc"]): PiRpcProcess {
	const child = new PiRpcProcess({ binary: bin, args, cwd: tmpdir() });
	processes.push(child);
	return child;
}

afterEach(async () => {
	await Promise.all(processes.splice(0).map((child) => child.kill(200)));
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("attachJsonlLineReader", () => {
	it("splits on LF only, strips CR, and keeps U+2028 inside records", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachJsonlLineReader(stream, (line) => lines.push(line));
		const ended = new Promise<void>((resolve) => stream.on("end", resolve));
		stream.write('{"a":"x y"}\r\n{"b":');
		stream.write("1}\n");
		stream.end('{"c":2}');
		await ended;
		expect(lines).toEqual(['{"a":"x y"}', '{"b":1}', '{"c":2}']);
	});
});

describe("PiRpcProcess", () => {
	it("correlates responses by id and streams events", async () => {
		const fake = createFakePi(tempDir(), {
			promptEvents: textAndToolScenarioEvents(),
			startupStdoutNoise: "extension says hi\n",
		});
		const child = start(fake.bin, ["--mode", "rpc", "--session-id", "s1"]);
		const events: PiRpcEvent[] = [];
		child.onEvent((event) => events.push(event));
		const state = await child.request<{ sessionId: string }>({
			type: "get_state",
		});
		expect(state).toMatchObject({ success: true, data: { sessionId: "s1" } });
		const settled = new Promise<void>((resolve) => {
			child.onEvent((event) => {
				if (event.type === "agent_settled") resolve();
			});
		});
		const accepted = await child.request({ type: "prompt", message: "hi" });
		expect(accepted).toEqual({ success: true, data: undefined });
		await settled;
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_update",
			"tool_execution_end",
			"turn_end",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
		const delta = events.find(
			(event) =>
				event.type === "message_update" &&
				(event.assistantMessageEvent as { delta?: string }).delta?.includes(
					" ",
				),
		);
		expect(delta).toBeDefined();
		const received = fake.received();
		expect(received[0]).toMatchObject({
			argv: ["--mode", "rpc", "--session-id", "s1"],
		});
		expect(received.slice(1).map((line) => line.type)).toEqual([
			"get_state",
			"prompt",
		]);
	});

	it("surfaces failed responses without rejecting", async () => {
		const fake = createFakePi(tempDir(), { promptError: "no model selected" });
		const child = start(fake.bin);
		await expect(
			child.request({ type: "prompt", message: "x" }),
		).resolves.toEqual({ success: false, error: "no model selected" });
	});

	it("rejects pending requests with a readable error when Pi exits", async () => {
		const fake = createFakePi(tempDir(), {
			exitOnPrompt: 3,
			promptEvents: [{ __wait__: 5_000 }],
		});
		const child = start(fake.bin);
		// The process dies while the prompt is in flight: the request must fail
		// with the exit details, not hang.
		await expect(
			child.request({ type: "prompt", message: "boom" }),
		).rejects.toBeInstanceOf(PiRpcProcessExitedError);
		const exit = await child.exited;
		expect(exit.code).toBe(3);
		expect(exit.stderr).toContain("fake pi crashed");
		await expect(child.request({ type: "get_state" })).rejects.toThrow(
			/exited with code 3: fake pi crashed/,
		);
		expect(child.alive).toBe(false);
	});

	it("reports a missing Pi executable clearly", async () => {
		const child = start(join(tempDir(), "missing-pi"));
		await expect(child.request({ type: "get_state" })).rejects.toThrow(
			/Pi CLI not found .*missing-pi.*PI_DESKTOP_PI_BIN/,
		);
		expect(child.alive).toBe(false);
	});

	it("times out requests that Pi never answers", async () => {
		const fake = createFakePi(tempDir(), {
			promptEvents: [{ __wait__: 5_000 }],
		});
		const child = start(fake.bin);
		await child.request({ type: "prompt", message: "slow" });
		await expect(
			child.request({ type: "fork", entryId: "x" }, { timeoutMs: 50 }),
		).resolves.toMatchObject({ success: false });
		await expect(
			child.request({ type: "cycle_model" }, { timeoutMs: 10 }).then(
				() => "answered",
				(error: Error) => error.message,
			),
		).resolves.toMatch(/answered|did not answer cycle_model within 10ms/);
	});

	it("kills gracefully by closing stdin, then escalates", async () => {
		const fake = createFakePi(tempDir());
		const child = start(fake.bin);
		await child.request({ type: "get_state" });
		const exit = await child.kill(1_000);
		expect(exit.code).toBe(0);
		expect(child.alive).toBe(false);
	});
});
