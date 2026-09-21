import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import type { JsonRecord } from "../types";

/**
 * Desktop-only annotations for Pi sessions (pinned flag, custom title
 * overrides, …). Pi's session files stay untouched; the desktop keeps its own
 * small map beside its other settings.
 */
export function piSessionMetadataPath(): string {
	return join(resolveClineDataDir(), "pi-desktop", "session-metadata.json");
}

export class PiSessionMetadataStore {
	private cache: Record<string, JsonRecord> | null = null;

	constructor(private readonly path: () => string = piSessionMetadataPath) {}

	get(sessionId: string): JsonRecord | undefined {
		return this.readAll()[sessionId];
	}

	/** Merge a patch; `null` values delete keys. Returns the merged metadata. */
	patch(sessionId: string, patch: JsonRecord): JsonRecord {
		const all = this.readAll();
		const merged: JsonRecord = { ...(all[sessionId] ?? {}) };
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete merged[key];
			else merged[key] = value;
		}
		if (Object.keys(merged).length === 0) delete all[sessionId];
		else all[sessionId] = merged;
		this.writeAll(all);
		return merged;
	}

	delete(sessionId: string): void {
		const all = this.readAll();
		if (!(sessionId in all)) return;
		delete all[sessionId];
		this.writeAll(all);
	}

	private readAll(): Record<string, JsonRecord> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.path(), "utf8")) as unknown;
			this.cache =
				parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, JsonRecord>)
					: {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private writeAll(all: Record<string, JsonRecord>): void {
		this.cache = all;
		const file = this.path();
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
		renameSync(temp, file);
	}
}
