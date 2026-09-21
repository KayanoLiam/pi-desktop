import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSidecarContext } from "../context";
import type { SidecarContext } from "../types";
import {
	type PiConfigWatcher,
	startPiConfigWatcher,
} from "./pi-config-watcher";
import { PiSessionManager } from "./pi-session-manager";

let dir: string;
let ctx: SidecarContext;
let watcher: PiConfigWatcher | undefined;
const events: Array<{ name: string; payload: unknown }> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-desktop-watch-"));
	mkdirSync(join(dir, "npm"), { recursive: true });
	writeFileSync(join(dir, "settings.json"), "{}");
	ctx = createSidecarContext(dir);
	events.length = 0;
	ctx.wsClients.add({
		data: { canApproveTools: true },
		send: (raw: string) => {
			events.push(
				(JSON.parse(raw) as { event: { name: string; payload: unknown } })
					.event,
			);
		},
	});
});

afterEach(async () => {
	watcher?.dispose();
	await ctx.pi?.dispose();
	rmSync(dir, { recursive: true, force: true });
});

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 4_000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("startPiConfigWatcher", () => {
	it("broadcasts pi_config_changed and marks Pi sessions stale when settings change", async () => {
		const manager = new PiSessionManager(ctx, {
			agentDir: () => dir,
			reapIntervalMs: 0,
			binary: join(dir, "missing-pi"),
		});
		ctx.pi = manager;
		const markStale = vi.spyOn(manager, "markStale");
		watcher = startPiConfigWatcher(ctx, {
			agentDir: dir,
			debounceMs: 30,
			pollIntervalMs: 40,
		});
		writeFileSync(join(dir, "settings.json"), '{"packages":["npm:pi-foo"]}');
		await waitFor(() =>
			events.some((event) => event.name === "pi_config_changed"),
		);
		expect(markStale).toHaveBeenCalledTimes(1);
		// Unchanged configuration never re-fires, even when checked again.
		expect(watcher.check()).toBe(false);
		expect(
			events.filter((event) => event.name === "pi_config_changed"),
		).toHaveLength(1);
	});

	it("ignores unrelated files in the agent dir but reacts to package installs", async () => {
		watcher = startPiConfigWatcher(ctx, {
			agentDir: dir,
			debounceMs: 30,
			pollIntervalMs: 40,
		});
		writeFileSync(join(dir, "pi-debug.log"), "noise");
		mkdirSync(join(dir, "sessions", "--x--"), { recursive: true });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(watcher.check()).toBe(false);
		expect(
			events.filter((event) => event.name === "pi_config_changed"),
		).toHaveLength(0);
		writeFileSync(join(dir, "npm", "package.json"), '{"dependencies":{}}');
		await waitFor(() =>
			events.some((event) => event.name === "pi_config_changed"),
		);
	});

	it("stops notifying after dispose", async () => {
		watcher = startPiConfigWatcher(ctx, {
			agentDir: dir,
			debounceMs: 30,
			pollIntervalMs: 40,
		});
		watcher.dispose();
		writeFileSync(join(dir, "settings.json"), '{"theme":"light"}');
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(watcher.check()).toBe(false);
		expect(
			events.filter((event) => event.name === "pi_config_changed"),
		).toHaveLength(0);
	});
});
