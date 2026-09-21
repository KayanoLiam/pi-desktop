import {
	existsSync,
	type FSWatcher,
	readdirSync,
	statSync,
	watch,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { broadcastEvent } from "../context";
import type { SidecarContext } from "../types";
import { getPiSessionManager } from "./pi-session-manager";

/**
 * Keeps the desktop in sync with changes made through the Pi CLI: installing
 * or removing packages (`pi install …`), editing `settings.json`, adding an
 * extension file. On a change the sidecar drops its cached command list,
 * restarts idle Pi processes so they load the new configuration, and tells
 * the webview to reload the model catalog and slash commands.
 *
 * Detection compares a cheap stat signature of the relevant files, checked
 * when `fs.watch` reports activity and on a slow poll. `fs.watch` alone is not
 * trusted: on macOS it coalesces events and may report unrelated files.
 */

export const PI_CONFIG_CHANGED_EVENT = "pi_config_changed";

const DEBOUNCE_MS = 750;
const POLL_INTERVAL_MS = 5_000;

const CONFIG_FILES = [
	"settings.json",
	"models.json",
	"auth.json",
	join("npm", "package.json"),
	join("npm", "package-lock.json"),
];

const CONFIG_DIRS = ["extensions", "git", join("npm", "node_modules")];

/** Paths whose activity is worth a signature check. */
export function piConfigWatchTargets(agentDir: string): string[] {
	return [agentDir, ...CONFIG_DIRS.map((dir) => join(agentDir, dir))];
}

/** Stable string describing the state of Pi's configuration inputs. */
export function computePiConfigSignature(agentDir: string): string {
	const parts: string[] = [];
	for (const file of CONFIG_FILES) {
		const path = join(agentDir, file);
		try {
			const stat = statSync(path);
			parts.push(`${file}:${stat.size}:${stat.mtimeMs}`);
		} catch {
			parts.push(`${file}:-`);
		}
	}
	for (const dir of CONFIG_DIRS) {
		const path = join(agentDir, dir);
		try {
			const entries = readdirSync(path).sort();
			parts.push(`${dir}:${entries.join(",")}`);
			for (const entry of entries) {
				try {
					const stat = statSync(join(path, entry));
					parts.push(`${dir}/${entry}:${stat.mtimeMs}`);
				} catch {
					// Entry vanished between readdir and stat.
				}
			}
		} catch {
			parts.push(`${dir}:-`);
		}
	}
	return parts.join("\n");
}

export type PiConfigWatcher = {
	/** Re-check now, bypassing the debounce (tests, manual refresh). */
	check(): boolean;
	dispose(): void;
};

export function startPiConfigWatcher(
	ctx: SidecarContext,
	options: {
		agentDir?: string;
		debounceMs?: number;
		pollIntervalMs?: number;
	} = {},
): PiConfigWatcher {
	const agentDir = options.agentDir ?? getAgentDir();
	const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const watchers: FSWatcher[] = [];
	let signature = computePiConfigSignature(agentDir);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const check = (): boolean => {
		if (disposed) return false;
		const next = computePiConfigSignature(agentDir);
		if (next === signature) return false;
		signature = next;
		ctx.logger?.log("Pi configuration changed; refreshing desktop state");
		try {
			getPiSessionManager(ctx).markStale();
		} catch (error) {
			ctx.logger?.error?.("Pi session refresh failed", { error });
		}
		broadcastEvent(ctx, PI_CONFIG_CHANGED_EVENT, { at: Date.now() });
		return true;
	};
	const schedule = () => {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			check();
		}, debounceMs);
	};

	for (const target of piConfigWatchTargets(agentDir)) {
		if (!existsSync(target)) continue;
		try {
			const watcher = watch(target, { persistent: false }, () => schedule());
			watcher.on("error", () => {
				// A vanished directory stops its watcher; polling still covers it.
			});
			watchers.push(watcher);
		} catch (error) {
			ctx.logger?.debug("Could not watch Pi configuration path", {
				target,
				error,
			});
		}
	}
	const poll =
		pollIntervalMs > 0 ? setInterval(() => check(), pollIntervalMs) : null;
	poll?.unref?.();

	return {
		check: () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			return check();
		},
		dispose: () => {
			disposed = true;
			if (timer) clearTimeout(timer);
			if (poll) clearInterval(poll);
			for (const watcher of watchers) {
				try {
					watcher.close();
				} catch {
					// Already closed.
				}
			}
		},
	};
}
