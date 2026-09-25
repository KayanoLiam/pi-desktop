import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_PI_BUILTIN_COMMANDS } from "../webview/lib/pi-slash-command";
import { handleCommand } from "./commands";
import { createSidecarContext } from "./context";
import { PiSessionFiles } from "./pi/pi-session-files";
import { PiSessionManager } from "./pi/pi-session-manager";
import { PiSessionMetadataStore } from "./pi/pi-session-metadata";
import { PI_BUILTIN_SLASH_COMMANDS } from "./pi/pi-slash-commands";
import { createFakePi, type FakePi } from "./pi/test-helpers/fake-pi";
import type { SidecarContext } from "./types";

/**
 * Command routing for Pi threads: everything a Pi session needs goes through
 * the same desktop commands as Cline sessions and never touches the Hub.
 */

let dir: string;
let agentDir: string;
let ctx: SidecarContext;
let fake: FakePi;
let sent: Array<{ name: string; payload: Record<string, unknown> }>;

function writePiSession(id: string, cwd: string, name?: string): string {
	const project = join(agentDir, "sessions", "--work--");
	mkdirSync(project, { recursive: true });
	const path = join(project, `${id}.jsonl`);
	const lines = [
		{
			type: "session",
			version: 3,
			id,
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd,
		},
		{
			type: "model_change",
			id: "a",
			parentId: null,
			timestamp: "2026-09-01T00:00:01.000Z",
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
		},
		{
			type: "message",
			id: "b",
			parentId: "a",
			timestamp: "2026-09-01T00:00:02.000Z",
			message: { role: "user", content: "Say hi", timestamp: 1 },
		},
		{
			type: "message",
			id: "c",
			parentId: "b",
			timestamp: "2026-09-01T00:00:03.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hi there" }],
				api: "x",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				usage: {
					input: 5,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 7,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.01,
					},
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
		...(name
			? [
					{
						type: "session_info",
						id: "d",
						parentId: "c",
						timestamp: "2026-09-01T00:00:04.000Z",
						name,
					},
				]
			: []),
	];
	writeFileSync(
		path,
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
	return path;
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-desktop-commands-")));
	agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("CLINE_DATA_DIR", join(dir, "cline-data"));
	vi.stubEnv("CLINE_SESSION_DATA_DIR", join(dir, "session-data"));
	ctx = createSidecarContext(dir);
	sent = [];
	ctx.wsClients.add({
		data: { canApproveTools: true },
		send: (raw: string) => {
			sent.push((JSON.parse(raw) as { event: (typeof sent)[number] }).event);
		},
	});
	fake = createFakePi(join(dir, "fake"), {
		promptEvents: [
			{ type: "agent_start" },
			{
				type: "message_update",
				usage: {},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "pong",
				},
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "pong" }],
					api: "x",
					provider: "p",
					model: "m",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: 1,
				},
			},
			{ type: "agent_end", messages: [], willRetry: false },
		],
		commands: [
			{
				name: "review",
				description: "Review",
				source: "extension",
				sourceInfo: {},
			},
		],
	});
	ctx.pi = new PiSessionManager(ctx, {
		files: new PiSessionFiles(() => agentDir),
		metadata: new PiSessionMetadataStore(() =>
			join(dir, "cline-data", "pi-desktop", "session-metadata.json"),
		),
		binary: fake.bin,
		reapIntervalMs: 0,
		gateExtensionPath: () => join(dir, "gate.js"),
	});
});

afterEach(async () => {
	await ctx.pi?.dispose();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("Pi thread command routing", () => {
	it("starts, sends, and reads back a Pi thread through chat_session_command", async () => {
		const started = (await handleCommand(ctx, "chat_session_command", {
			request: {
				action: "start",
				config: {
					runtime: "pi",
					sessionId: "session_1_new",
					environmentId: "local",
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					piThinkingLevel: "medium",
					workspaceRoot: dir,
					cwd: dir,
				},
			},
		})) as { sessionId: string };
		expect(started.sessionId).toBe("session_1_new");
		expect(ctx.liveSessions.has("session_1_new")).toBe(false);
		expect(ctx.runtimeBindings.size).toBe(0);

		const response = (await handleCommand(ctx, "chat_session_command", {
			request: {
				action: "send",
				sessionId: "session_1_new",
				prompt: "ping",
				config: { environmentId: "local" },
			},
		})) as { ok: boolean; result: { text: string; finishReason: string } };
		expect(response).toMatchObject({
			ok: true,
			result: { text: "pong", finishReason: "completed" },
		});
		expect(
			sent
				.filter((event) => event.name === "chat_event")
				.map((event) => event.payload.stream),
		).toEqual(["chat_text", "chat_usage", "chat_done"]);

		// Idle after the turn: nothing counts as running for the process context.
		expect(ctx.pi?.runningCount()).toBe(0);
		expect(ctx.pi?.status("session_1_new")).toBe("idle");
	});

	it("lists, reads, renames, annotates, searches, and deletes Pi sessions from the store", async () => {
		const path = writePiSession("pi-old-1", dir, "Old name");
		const listed = (await handleCommand(ctx, "list_discovered_sessions", {
			limit: 50,
		})) as Array<Record<string, unknown>>;
		const record = listed.find((session) => session.sessionId === "pi-old-1");
		expect(record).toMatchObject({
			source: "pi",
			origin: "local",
			environmentId: "local",
			status: "completed",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			workspaceRoot: dir,
			metadata: { title: "Old name", piSessionFile: path },
		});
		expect(
			await handleCommand(ctx, "get_discovered_session", {
				sessionId: "pi-old-1",
			}),
		).toMatchObject({ sessionId: "pi-old-1", source: "pi" });

		const messages = (await handleCommand(ctx, "read_session_messages", {
			sessionId: "pi-old-1",
		})) as Array<{ role: string; content: string }>;
		expect(messages.map((message) => [message.role, message.content])).toEqual([
			["user", "Say hi"],
			["assistant", "Hi there"],
		]);
		expect(
			await handleCommand(ctx, "read_session_hooks", { sessionId: "pi-old-1" }),
		).toEqual([]);
		expect(
			await handleCommand(ctx, "list_session_agents", {
				sessionId: "pi-old-1",
			}),
		).toEqual([]);

		expect(
			await handleCommand(ctx, "update_chat_session_title", {
				sessionId: "pi-old-1",
				title: "Renamed",
			}),
		).toBe(true);
		expect(
			(
				(await handleCommand(ctx, "get_discovered_session", {
					sessionId: "pi-old-1",
				})) as { metadata: { title: string } }
			).metadata.title,
		).toBe("Renamed");

		expect(
			await handleCommand(ctx, "update_chat_session_metadata", {
				sessionId: "pi-old-1",
				metadata: { pinned: true },
			}),
		).toEqual({ pinned: true });
		expect(
			(
				(await handleCommand(ctx, "get_discovered_session", {
					sessionId: "pi-old-1",
				})) as { metadata: { pinned?: boolean } }
			).metadata.pinned,
		).toBe(true);

		const hits = (await handleCommand(ctx, "search_sessions", {
			query: "hi there",
		})) as Array<Record<string, unknown>>;
		expect(hits).toContainEqual(
			expect.objectContaining({
				sessionId: "pi-old-1",
				source: "pi",
				title: "Renamed",
			}),
		);

		expect(
			await handleCommand(ctx, "delete_chat_session", {
				sessionId: "pi-old-1",
			}),
		).toBe(true);
		expect(
			sent.find((event) => event.name === "session_deleted")?.payload,
		).toMatchObject({ sessionId: "pi-old-1", deleted: true });
		expect(
			(await handleCommand(ctx, "list_discovered_sessions", {
				limit: 50,
			})) as unknown[],
		).toEqual([]);
	});

	it("resumes a stored Pi session through attach and send without a runtime config", async () => {
		writePiSession("pi-old-2", dir);
		const attached = (await handleCommand(ctx, "chat_session_command", {
			request: {
				action: "attach",
				sessionId: "pi-old-2",
				config: { environmentId: "local" },
			},
		})) as Record<string, unknown>;
		expect(attached).toMatchObject({
			sessionId: "pi-old-2",
			status: "completed",
			provider: "openai-codex",
			cwd: dir,
		});
		const response = (await handleCommand(ctx, "chat_session_command", {
			request: {
				action: "send",
				sessionId: "pi-old-2",
				prompt: "again",
				config: { environmentId: "local" },
			},
		})) as { result: { text: string } };
		expect(response.result.text).toBe("pong");
		expect((fake.received()[0].argv as string[]).slice(0, 4)).toEqual([
			"--mode",
			"rpc",
			"--session",
			join(agentDir, "sessions", "--work--", "pi-old-2.jsonl"),
		]);
	});

	it("keeps the frontend and backend builtin guards in sync", () => {
		expect(
			new Set(PI_BUILTIN_SLASH_COMMANDS.map((command) => command.name)),
		).toEqual(new Set(KNOWN_PI_BUILTIN_COMMANDS));
	});

	it("exposes Pi's slash commands per workspace", async () => {
		expect(
			await handleCommand(ctx, "list_pi_commands", { workspaceRoot: dir }),
		).toEqual({
			commands: [
				...PI_BUILTIN_SLASH_COMMANDS,
				{ name: "review", description: "Review", source: "extension" },
			],
		});
	});

	it("executes Pi builtins through execute_pi_command and keeps the send path closed", async () => {
		expect(
			await handleCommand(ctx, "execute_pi_command", { text: "/review" }),
		).toEqual({ handled: false });
		expect(
			await handleCommand(ctx, "execute_pi_command", { text: "/new" }),
		).toMatchObject({ handled: true, uiAction: "new" });
		await expect(
			handleCommand(ctx, "execute_pi_command", { text: "/compact" }),
		).rejects.toThrow(/active Pi session is required/);
		await expect(
			handleCommand(ctx, "execute_pi_command", { text: "   " }),
		).rejects.toThrow(/text is required/);

		const started = (await handleCommand(ctx, "chat_session_command", {
			request: {
				action: "start",
				config: {
					runtime: "pi",
					sessionId: "pi-cmd",
					environmentId: "local",
					provider: "p",
					model: "m",
					workspaceRoot: dir,
					cwd: dir,
				},
			},
		})) as { sessionId: string };
		expect(started.sessionId).toBe("pi-cmd");
		expect(
			await handleCommand(ctx, "execute_pi_command", {
				sessionId: "pi-cmd",
				text: "/compact keep the auth decision",
			}),
		).toMatchObject({
			handled: true,
			refresh: true,
			message: expect.stringContaining("keep the auth decision"),
		});
		for (const builtin of ["/session", "/bug report this issue"]) {
			await expect(
				handleCommand(ctx, "chat_session_command", {
					request: {
						action: "send",
						sessionId: "pi-cmd",
						prompt: builtin,
						config: { runtime: "pi", environmentId: "local" },
					},
				}),
			).rejects.toThrow(/execute_pi_command/);
		}
		expect(fake.received().some((line) => line.type === "prompt")).toBe(false);
		const bug = (await handleCommand(ctx, "execute_pi_command", {
			sessionId: "pi-cmd",
			text: "/bug report this issue",
		})) as { handled: boolean; message: string };
		expect(bug).toMatchObject({
			handled: true,
			message: expect.stringContaining("Nothing was reported or uploaded"),
		});
		const info = (await handleCommand(ctx, "execute_pi_command", {
			sessionId: "pi-cmd",
			text: "/session",
		})) as { handled: boolean; message: string };
		expect(info.handled).toBe(true);
		expect(info.message).toContain("Messages:");
		const reload = (await handleCommand(ctx, "execute_pi_command", {
			text: "/reload",
		})) as { handled: boolean; message: string; uiAction?: string };
		expect(reload.handled).toBe(true);
		expect(reload.uiAction).toBeUndefined();
		expect(reload.message).toMatch(/not available/i);
	});

	it("routes scoped-models and Ctrl+P only for local Pi threads", async () => {
		fake.setScenario({
			models: [
				{ provider: "alpha", id: "a" },
				{ provider: "alpha", id: "b" },
				{ provider: "beta", id: "c" },
			],
		});
		writePiSession("pi-owned", dir);
		const scope = (await handleCommand(ctx, "get_pi_model_scope", {
			sessionId: "pi-owned",
		})) as { models: unknown[]; hasSession: boolean };
		expect(scope).toMatchObject({ hasSession: true });
		expect(scope.models).toHaveLength(3);
		await handleCommand(ctx, "set_pi_model_scope", {
			sessionId: "pi-owned",
			enabled: ["alpha/a", "alpha/b"],
			save: false,
		});
		const cycled = await handleCommand(ctx, "cycle_pi_model", {
			sessionId: "pi-owned",
		});
		expect(cycled).toMatchObject({ providerId: "alpha", modelId: "a" });
		expect(
			await handleCommand(ctx, "cycle_pi_model", {
				sessionId: "pi-owned",
			}),
		).toMatchObject({ providerId: "alpha", modelId: "b" });
		expect(
			fake.received().findLast((entry) => Array.isArray(entry.argv))?.argv,
		).toContain("alpha/a,alpha/b");

		for (const command of [
			"get_pi_model_scope",
			"set_pi_model_scope",
			"cycle_pi_model",
		]) {
			await expect(
				handleCommand(ctx, command, {
					sessionId: "cline-session",
					enabled: ["alpha/a"],
					save: true,
				}),
			).rejects.toThrow(/local Pi session/);
			await expect(
				handleCommand(ctx, command, {
					sessionId: "pi-owned",
					environmentId: "ssh-host",
					enabled: ["alpha/a"],
					save: true,
				}),
			).rejects.toThrow(/local Pi session/);
		}
	});

	it("rejects Pi commands for non-Pi or remote sessions", async () => {
		writePiSession("pi-owned", dir);
		await expect(
			handleCommand(ctx, "execute_pi_command", {
				sessionId: "cline-session",
				text: "/name Wrong owner",
			}),
		).rejects.toThrow(/local Pi session/);
		await expect(
			handleCommand(ctx, "execute_pi_command", {
				sessionId: "pi-owned",
				environmentId: "ssh-host",
				text: "/compact",
			}),
		).rejects.toThrow(/local Pi session/);
		await expect(
			handleCommand(ctx, "execute_pi_command", {
				environmentId: "cloud",
				text: "/new",
			}),
		).rejects.toThrow(/local Pi session/);
		expect(fake.received()).toEqual([]);
	});

	it("keeps remote environments on the Cline runtime", async () => {
		await expect(
			handleCommand(ctx, "chat_session_command", {
				request: {
					action: "start",
					config: {
						runtime: "pi",
						environmentId: "ssh-host",
						provider: "p",
						model: "m",
						workspaceRoot: dir,
					},
				},
			}),
		).rejects.toThrow(/not connected|environment|Hub/i);
		expect(fake.received()).toEqual([]);
	});
});
