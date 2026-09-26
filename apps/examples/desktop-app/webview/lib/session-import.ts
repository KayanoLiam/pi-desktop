/** Legacy imported-session metadata readers. Kept so existing Cline history
 * can still be displayed; Pi desktop no longer scans or imports other tools.
 */

export type SessionImportTool = "claude-code" | "codex" | "opencode";

export const SESSION_IMPORT_TOOL_ORDER: SessionImportTool[] = [
	"claude-code",
	"codex",
	"opencode",
];

export const SESSION_IMPORT_TOOL_LABELS: Record<SessionImportTool, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "opencode",
};

/**
 * The external tool a session was imported from, read off the
 * `metadata.importedFrom` marker the core import service writes. Forks
 * inherit the source session's metadata, so a fork of an imported session
 * reports the same tool: its history is still the foreign transcript.
 */
export function readImportedFromTool(
	metadata: Record<string, unknown> | null | undefined,
): SessionImportTool | undefined {
	const value = metadata?.importedFrom;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return asSessionImportTool((value as { tool?: unknown }).tool);
}

function asSessionImportTool(value: unknown): SessionImportTool | undefined {
	return typeof value === "string" &&
		(SESSION_IMPORT_TOOL_ORDER as string[]).includes(value)
		? (value as SessionImportTool)
		: undefined;
}

export type ImportedHistorySummaryActivity =
	| { phase: "started"; label: string }
	| { phase: "finished" };

/**
 * Reads the compaction status notice core emits while it summarizes an
 * imported session's history on the first resumed turn (core tags those
 * notices with `importedFrom`). The label stands in for the generic
 * "Thinking..." indicator while the summary runs; `finished` clears it.
 * Other notices return undefined.
 */
export function readImportedHistorySummaryActivity(
	metadata: unknown,
): ImportedHistorySummaryActivity | undefined {
	if (!metadata || typeof metadata !== "object") return undefined;
	const record = metadata as Record<string, unknown>;
	const tool = asSessionImportTool(record.importedFrom);
	if (!tool) return undefined;
	switch (record.phase) {
		case "started":
			return {
				phase: "started",
				label: `Summarizing the imported ${SESSION_IMPORT_TOOL_LABELS[tool]} history...`,
			};
		case "completed":
		case "skipped":
			return { phase: "finished" };
		default:
			return undefined;
	}
}
