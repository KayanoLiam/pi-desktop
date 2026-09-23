import type { ExecutePiCommandResult, PiCommandUiAction } from "../types";

/**
 * Bare command names from Pi 0.87.0 `BUILTIN_SLASH_COMMANDS`.
 * Pi 0.85.1 shipped in the monorepo does not have `/bug`, but Desktop runs
 * the installed Pi binary; keep the newer builtin protected on both paths.
 *
 * Interactive submit checks these before prompt expansion, and autocomplete
 * drops extension commands whose registered name collides with one. Builtins
 * therefore win over a same-named extension, prompt template, or skill.
 * RPC `prompt` would run the extension first; Desktop must not use that path
 * for a known builtin or the command falls through to the model.
 */
export type PiBuiltinSlashCommand = {
	name: string;
	description: string;
	source: "builtin";
};

export const PI_BUILTIN_SLASH_COMMANDS: PiBuiltinSlashCommand[] = [
	{
		name: "compact",
		description:
			"Manually compact the session context. Optional instructions follow the command.",
		source: "builtin",
	},
	{
		name: "name",
		description: "Set or show the session display name",
		source: "builtin",
	},
	{
		name: "session",
		description: "Show session info and stats",
		source: "builtin",
	},
	{
		name: "export",
		description: "Export the session to an HTML file",
		source: "builtin",
	},
	{
		name: "new",
		description: "Start a new session",
		source: "builtin",
	},
	{
		name: "model",
		description: "Select a model",
		source: "builtin",
	},
	{
		name: "settings",
		description: "Open settings",
		source: "builtin",
	},
	{
		name: "resume",
		description: "Resume a previous session",
		source: "builtin",
	},
	{
		name: "fork",
		description: "Fork this session from an earlier message",
		source: "builtin",
	},
	{
		name: "reload",
		description:
			"Reload extensions and context files (not available through Desktop RPC)",
		source: "builtin",
	},
	{
		name: "import",
		description: "Import a JSONL session (not available in Desktop)",
		source: "builtin",
	},
	{
		name: "tree",
		description: "Navigate the session tree (terminal only)",
		source: "builtin",
	},
	{
		name: "clone",
		description: "Duplicate the current session (not available in Desktop)",
		source: "builtin",
	},
	{
		name: "thinking",
		description: "Set thinking level (use the desktop thinking control)",
		source: "builtin",
	},
	{
		name: "scoped-models",
		description: "Enable or disable models for cycling (terminal only)",
		source: "builtin",
	},
	{
		name: "share",
		description: "Share the session as a gist (not available in Desktop)",
		source: "builtin",
	},
	{
		name: "bug",
		description: "Report a bug (not available in Desktop)",
		source: "builtin",
	},
	{
		name: "copy",
		description: "Copy the last agent message (not available in Desktop)",
		source: "builtin",
	},
	{
		name: "changelog",
		description: "Show changelog entries (terminal only)",
		source: "builtin",
	},
	{
		name: "hotkeys",
		description: "Show keyboard shortcuts (terminal only)",
		source: "builtin",
	},
	{
		name: "trust",
		description: "Save a project trust decision (terminal only)",
		source: "builtin",
	},
	{
		name: "login",
		description:
			"Configure provider authentication (use desktop provider settings)",
		source: "builtin",
	},
	{
		name: "logout",
		description:
			"Remove provider authentication (use desktop provider settings)",
		source: "builtin",
	},
	{
		name: "quit",
		description: "Quit Pi (does not close Desktop)",
		source: "builtin",
	},
];

const PI_BUILTIN_NAMES = new Set(
	PI_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

/**
 * Commands whose terminal behavior has a native desktop control.
 * `/thinking` is intentionally absent: the frozen uiAction union has no
 * thinking value, and the composer already exposes that picker.
 */
const DESKTOP_UI_ACTIONS: Record<
	string,
	{ uiAction: PiCommandUiAction; message: string }
> = {
	new: {
		uiAction: "new",
		message: "Starting a new session.",
	},
	model: {
		uiAction: "model",
		message: "Open the model picker to switch models.",
	},
	settings: {
		uiAction: "settings",
		message: "Open settings.",
	},
	resume: {
		uiAction: "resume",
		message: "Open the session list to resume a previous session.",
	},
	fork: {
		uiAction: "fork",
		message:
			"Pi's message picker is not available in Desktop. This session was not forked.",
	},
};

/**
 * Honest guidance for builtins Pi exposes only in the terminal, or that RPC
 * mode cannot perform. These must stay handled so they never reach the model.
 */
const UNSUPPORTED_BUILTIN_GUIDANCE: Record<string, string> = {
	reload:
		"/reload is not available through Pi's RPC mode. Desktop did not reload keybindings, extensions, skills, prompts, themes, or context files. Restart the Pi session, or run pi in a terminal and use /reload.",
	import:
		"/import is not available in Desktop. Pi's terminal command replaces the current session from a JSONL file after confirmation, and that operation is not a session RPC command. Nothing was imported.",
	tree: "/tree is a terminal session-tree selector. Desktop does not open that view, and this command was not run.",
	clone:
		"/clone is not available in Desktop. Nothing was duplicated. Pi's terminal clone and fork pickers are not available for Pi threads here.",
	thinking:
		"/thinking was not applied. Use the Pi thinking level control in the composer.",
	"scoped-models":
		"/scoped-models is a terminal model-cycling selector. Desktop did not change that list.",
	share:
		"/share uploads the session as a secret GitHub gist. Desktop does not share or upload sessions. Nothing was shared.",
	bug: "/bug is not available in Desktop. Nothing was reported or uploaded. Use Pi in a terminal to report a bug.",
	copy: "/copy writes to the terminal clipboard, which Desktop does not control. Nothing was copied. Select the last agent message in the transcript to copy it.",
	changelog:
		"/changelog shows Pi's terminal changelog. Desktop does not open that view.",
	hotkeys:
		"/hotkeys lists Pi's terminal shortcuts. Desktop uses its own keybindings and does not show that list.",
	trust:
		"/trust saves a terminal project-trust decision. Desktop did not change Pi's trust store.",
	login:
		"/login changes provider authentication in the terminal. Desktop did not change credentials. Use the desktop provider settings.",
	logout:
		"/logout removes provider authentication in the terminal. Desktop did not change credentials. Use the desktop provider settings.",
	quit: "/quit exits the terminal Pi process. Desktop did not close.",
};

export const PI_JSONL_EXPORT_GUIDANCE =
	"JSONL export is not available through Pi's session RPC (only HTML export is). Nothing was written. Use /export or /export path.html, or run pi in a terminal for /export path.jsonl.";

export function piBuiltinCommandName(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const token = trimmed.split(/\s+/, 1)[0] ?? "";
	const name = token.slice(1);
	return PI_BUILTIN_NAMES.has(name) ? name : undefined;
}

/** Text after `/command`, matching Pi's `/compact` and `/name` remainder rules. */
export function piCommandRemainder(text: string, command: string): string {
	const prefix = `/${command}`;
	const trimmed = text.trim();
	if (!trimmed.startsWith(`${prefix} `)) return "";
	return trimmed.slice(prefix.length).trim();
}

/**
 * First path argument, including a quoted path. Mirrors Pi's
 * `getPathCommandArgument` so `/export "my file.html"` does not split on spaces.
 */
export function piPathArgument(
	text: string,
	command: string,
): string | undefined {
	const args = piCommandRemainder(text, command);
	if (!args) return undefined;
	const quote = args[0];
	if (quote === '"' || quote === "'") {
		const end = args.indexOf(quote, 1);
		if (end > 1) return args.slice(1, end);
		return undefined;
	}
	const space = args.search(/\s/);
	return space < 0 ? args : args.slice(0, space);
}

export function mergeBuiltinCommands<
	T extends { name: string; source: string },
>(discovered: T[]): Array<PiBuiltinSlashCommand | T> {
	const dynamic = discovered.filter(
		(command) => !PI_BUILTIN_NAMES.has(command.name),
	);
	return [...PI_BUILTIN_SLASH_COMMANDS, ...dynamic];
}

export function desktopUiCommand(
	name: string,
	text: string,
): ExecutePiCommandResult | undefined {
	const action = DESKTOP_UI_ACTIONS[name];
	if (!action) return undefined;
	const extra = piCommandRemainder(text, name);
	if (name === "model" && extra) {
		return {
			handled: true,
			uiAction: action.uiAction,
			message: `${action.message} Requested ${extra}, but Desktop does not apply a /model argument directly.`,
		};
	}
	if (extra && name !== "model") {
		return {
			handled: true,
			uiAction: action.uiAction,
			message: `${action.message} Extra text after /${name} was ignored.`,
		};
	}
	return { handled: true, message: action.message, uiAction: action.uiAction };
}

export function unsupportedBuiltinGuidance(
	name: string,
): ExecutePiCommandResult | undefined {
	const message = UNSUPPORTED_BUILTIN_GUIDANCE[name];
	if (!message) return undefined;
	return { handled: true, message };
}

export function formatCompactionMessage(
	result: {
		summary?: unknown;
		tokensBefore?: unknown;
		estimatedTokensAfter?: unknown;
	},
	instructions?: string,
): string {
	const before =
		typeof result.tokensBefore === "number" ? result.tokensBefore : undefined;
	const after =
		typeof result.estimatedTokensAfter === "number"
			? result.estimatedTokensAfter
			: undefined;
	const summary =
		typeof result.summary === "string" ? result.summary.trim() : "";
	const range =
		before !== undefined && after !== undefined
			? ` Context estimate: ${before.toLocaleString()} → ${after.toLocaleString()} tokens.`
			: before !== undefined
				? ` Tokens before: ${before.toLocaleString()}.`
				: "";
	const note = instructions ? ` Instructions: ${instructions}` : "";
	const preview = summary
		? ` Summary: ${summary.slice(0, 240)}${summary.length > 240 ? "…" : ""}`
		: "";
	return `Compacted the session.${range}${note}${preview}`;
}

export function formatSessionInfo(stats: {
	sessionFile?: unknown;
	sessionId?: unknown;
	sessionName?: unknown;
	userMessages?: unknown;
	assistantMessages?: unknown;
	toolCalls?: unknown;
	toolResults?: unknown;
	totalMessages?: unknown;
	tokens?: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		total?: unknown;
	};
	cost?: unknown;
}): string {
	const number = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	const tokens = stats.tokens ?? {};
	const lines = ["Session info"];
	if (typeof stats.sessionName === "string" && stats.sessionName.trim()) {
		lines.push(`Name: ${stats.sessionName.trim()}`);
	}
	lines.push(
		`File: ${typeof stats.sessionFile === "string" && stats.sessionFile ? stats.sessionFile : "in memory"}`,
	);
	lines.push(
		`ID: ${typeof stats.sessionId === "string" && stats.sessionId ? stats.sessionId : "unknown"}`,
	);
	lines.push(
		`Messages: ${number(stats.totalMessages)} total, ${number(stats.userMessages)} user, ${number(stats.assistantMessages)} assistant, ${number(stats.toolCalls)} tool calls, ${number(stats.toolResults)} tool results`,
	);
	lines.push(
		`Tokens: ${number(tokens.total)} total, ${number(tokens.input)} input, ${number(tokens.output)} output, ${number(tokens.cacheRead)} cache read, ${number(tokens.cacheWrite)} cache write`,
	);
	lines.push(`Cost: $${number(stats.cost).toFixed(3)}`);
	return lines.join("\n");
}
