/**
 * Pi slash-command seam for the desktop webview.
 *
 * Installed Pi 0.87.0 (`@earendil-works/pi-coding-agent`) matches builtin
 * slash commands in the interactive submit handler before extension commands,
 * and hides colliding extension names from autocomplete. This module follows
 * that precedence and routes supported pickers through native Desktop controls.
 */

export const PI_SESSION_REFRESH_EVENT = "cline:pi-session-refresh";

export const PI_COMMAND_UI_ACTIONS = [
	"new",
	"model",
	"scoped-models",
	"tree",
	"thinking",
	"settings",
	"resume",
	"fork",
] as const;

export type PiCommandUiAction = (typeof PI_COMMAND_UI_ACTIONS)[number];

export type PiSlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export type PiSlashCommandInfo = {
	name: string;
	description?: string;
	source: PiSlashCommandSource;
};

export type PiSlashCommandRow = {
	name: string;
	description?: string;
};

/**
 * Names from Pi 0.87.0 `BUILTIN_SLASH_COMMANDS`. A submit of one of these must
 * not be sent to the model. `/llama` is not in that array.
 */
export const KNOWN_PI_BUILTIN_COMMANDS = [
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"bug",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

const KNOWN_PI_BUILTIN_NAMES = new Set<string>(KNOWN_PI_BUILTIN_COMMANDS);

/**
 * Discoverability fallback when `list_pi_commands` fails. Only commands the
 * desktop can actually run or route to an existing control. Unsupported
 * builtins such as clone stay out of this list; they appear only if discovery
 * returns them, and execution then shows guidance.
 */
export const PI_SLASH_COMMAND_FALLBACK: PiSlashCommandRow[] = [
	{ name: "compact", description: "Manually compact conversation context" },
	{ name: "name", description: "Set the session display name" },
	{ name: "new", description: "Start a new session" },
	{ name: "model", description: "Open the model picker" },
	{ name: "scoped-models", description: "Configure Pi model cycling" },
	{ name: "tree", description: "Browse the Pi session tree" },
	{ name: "thinking", description: "Set a Pi thinking level" },
	{ name: "settings", description: "Open desktop settings" },
	{ name: "resume", description: "Search and open a previous session" },
];

const PI_SLASH_SOURCE_LABELS: Record<PiSlashCommandSource, string> = {
	builtin: "Builtin command",
	extension: "Extension command",
	prompt: "Prompt template",
	skill: "Skill",
};

export type ExecutePiCommandRequest = {
	text: string;
	sessionId?: string;
	workspaceRoot?: string;
};

export type ExecutePiCommandResponse =
	| { handled: false }
	| {
			handled: true;
			message: string;
			uiAction?: PiCommandUiAction;
			selection?: {
				providerId: string;
				modelId: string;
				thinkingLevel: string;
			};
			clipboardText?: string;
			refresh: boolean;
	  };

export type PiCommandHandled = {
	message: string;
	uiAction?: PiCommandUiAction;
	selection?: { providerId: string; modelId: string; thinkingLevel: string };
	clipboardText?: string;
	refresh: boolean;
	preserveAttachments: true;
	sessionTitle?: string;
};

const UI_ACTIONS = new Set<string>(PI_COMMAND_UI_ACTIONS);

/** Bare command token. Strips a leading slash and argument placeholders. */
export function barePiCommandName(name: string): string {
	const trimmed = name.trim().replace(/^\/+/, "");
	const token = trimmed.split(/\s+/, 1)[0] ?? "";
	return token.replace(/[<>[\]]/g, "");
}

export function piSlashCommandName(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return "";
	return barePiCommandName(trimmed.slice(1));
}

export function isPiSlashInput(text: string): boolean {
	return piSlashCommandName(text).length > 0;
}

export function isKnownPiBuiltin(name: string): boolean {
	return KNOWN_PI_BUILTIN_NAMES.has(name);
}

export function shouldDeferComposerSideEffects(
	piRuntime: boolean,
	prompt: string,
): boolean {
	return piRuntime && isPiSlashInput(prompt);
}

export function buildExecutePiCommandRequest(options: {
	text: string;
	sessionId?: string | null;
	workspaceRoot?: string | null;
}): ExecutePiCommandRequest {
	const sessionId = options.sessionId?.trim();
	const workspaceRoot = options.workspaceRoot?.trim();
	return {
		text: options.text.trim(),
		...(sessionId ? { sessionId } : {}),
		...(workspaceRoot ? { workspaceRoot } : {}),
	};
}

export function parseExecutePiCommandResponse(
	value: unknown,
): ExecutePiCommandResponse {
	if (!value || typeof value !== "object") {
		throw new Error("Pi command returned an unrecognized response.");
	}
	const record = value as Record<string, unknown>;
	if (record.handled === false) return { handled: false };
	if (record.handled !== true) {
		throw new Error("Pi command returned an unrecognized response.");
	}
	const message =
		typeof record.message === "string" && record.message.trim()
			? record.message.trim()
			: "Pi command finished.";
	const uiAction =
		typeof record.uiAction === "string" && UI_ACTIONS.has(record.uiAction)
			? (record.uiAction as PiCommandUiAction)
			: undefined;
	const rawSelection = record.selection as Record<string, unknown> | undefined;
	const selection =
		rawSelection &&
		typeof rawSelection.providerId === "string" &&
		typeof rawSelection.modelId === "string" &&
		typeof rawSelection.thinkingLevel === "string"
			? {
					providerId: rawSelection.providerId,
					modelId: rawSelection.modelId,
					thinkingLevel: rawSelection.thinkingLevel,
				}
			: undefined;
	return {
		handled: true,
		message,
		...(uiAction ? { uiAction } : {}),
		...(selection ? { selection } : {}),
		...(typeof record.clipboardText === "string"
			? { clipboardText: record.clipboardText }
			: {}),
		refresh: record.refresh === true,
	};
}

export function unhandledBuiltinGuidance(name: string): string {
	return `/${name} is a built-in Pi command. Pi Desktop did not run it, so it was not sent to the model.`;
}

export function piCommandInFlightMessage(): string {
	return "A Pi command is already running. Wait for it to finish before sending.";
}

export function buildPiSlashCommands(response: {
	commands?: PiSlashCommandInfo[];
}): PiSlashCommandRow[] {
	const commands = Array.isArray(response.commands) ? response.commands : [];
	const seen = new Set<string>();
	return commands.flatMap((command) => {
		const name = barePiCommandName(command.name ?? "");
		if (!name || seen.has(name)) return [];
		if (isKnownPiBuiltin(name) && command.source !== "builtin") return [];
		seen.add(name);
		const kind = PI_SLASH_SOURCE_LABELS[command.source] ?? "Command";
		return [
			{
				name,
				description: command.description
					? `${command.description} · ${kind}`
					: kind,
			},
		];
	});
}

/**
 * Fallback builtins stay visible when discovery omits them. A fetched builtin
 * replaces the fallback row. A colliding extension, prompt, or skill does not:
 * Pi 0.87.0 lets the builtin win in autocomplete.
 */
export function mergePiSlashCommands(response: {
	commands?: PiSlashCommandInfo[];
}): PiSlashCommandRow[] {
	const fetched = buildPiSlashCommands(response);
	const fetchedNames = new Set(fetched.map((command) => command.name));
	const fallback = PI_SLASH_COMMAND_FALLBACK.filter(
		(command) => !fetchedNames.has(command.name),
	);
	const seen = new Set<string>();
	const merged: PiSlashCommandRow[] = [];
	for (const command of [...fallback, ...fetched]) {
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		merged.push(command);
	}
	return merged;
}

export function readDiscoveredSessionTitle(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const metadata = (value as { metadata?: unknown }).metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const title = (metadata as { title?: unknown }).title;
	return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/**
 * Routes a backend uiAction to an existing desktop control.
 * `fork` has no safe Pi equivalent (the desktop fork control is disabled for
 * Pi threads and is not Pi's message picker), so it stays guidance-only.
 */
export function routePiCommandUiAction(
	action: PiCommandUiAction | undefined,
	handlers: {
		onNew?: () => void;
		onModel?: () => void;
		onScopedModels?: () => void;
		onTree?: () => void;
		onThinking?: () => void;
		onSettings?: () => void;
		onResume?: () => void;
	},
): "routed" | "guidance" | "none" {
	if (!action) return "none";
	if (action === "fork") return "guidance";
	const handler =
		action === "new"
			? handlers.onNew
			: action === "model"
				? handlers.onModel
				: action === "scoped-models"
					? handlers.onScopedModels
					: action === "tree"
						? handlers.onTree
						: action === "thinking"
							? handlers.onThinking
							: action === "settings"
								? handlers.onSettings
								: handlers.onResume;
	if (!handler) return "guidance";
	handler();
	return "routed";
}
