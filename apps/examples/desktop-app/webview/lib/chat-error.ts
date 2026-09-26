import type { ChatMessage } from "@/lib/chat-schema";

/** How a chat error reads in the transcript: a short title, an optional
 * plain-language hint, and whether the raw error text is prose or code. */
export type ChatErrorSummary = {
	title: string;
	hint?: string;
	detailStyle: "prose" | "code";
};

/** An HTTP status at the start of the message (`429 Too Many Requests`,
 * `Error: 503 {...}`) or after `status` / `code` / `HTTP`, so numbers such as
 * a token limit never read as a status. */
function httpStatus(codes: string): RegExp {
	return new RegExp(
		`(?:^(?:\\w*Error:\\s*)?|\\b(?:status(?: code)?|code|HTTP(?:/\\d(?:\\.\\d)?)?)\\W{0,3})(?:${codes})\\b`,
		"i",
	);
}

// Matched against the raw error text from the runtime (Pi's `errorMessage`,
// Cline's run failure). These are transport- and HTTP-level wordings shared
// by providers, not per-provider strings; anything unmatched keeps the
// generic title and shows the raw text as-is.
const ERROR_KINDS: Array<{
	patterns: RegExp[];
	title: string;
	hint: string;
}> = [
	{
		patterns: [
			/context[ _-]?(?:length|window)|maximum context|prompt is too long|input is too long|too many tokens/i,
		],
		title: "Context window exceeded",
		hint: "The conversation no longer fits in the model's context. Compact it or start a new session.",
	},
	{
		patterns: [
			httpStatus("429"),
			/rate[ _-]?limit|too many requests|quota exceeded|resource[ _]exhausted/i,
		],
		title: "Rate limited",
		hint: "The provider is limiting requests. Wait a moment, then try again.",
	},
	{
		patterns: [
			httpStatus("401|403"),
			/unauthori[sz]ed|forbidden|invalid (?:x-)?api[ _-]?key|authentication (?:failed|error)/i,
		],
		title: "Authentication failed",
		hint: "The provider rejected the credentials. Check them, then try again.",
	},
	{
		patterns: [
			httpStatus("500|502|503|504|529"),
			/overloaded|service unavailable|bad gateway|gateway timeout|internal server error/i,
		],
		title: "Provider unavailable",
		hint: "The model provider returned a server error. Try again in a moment.",
	},
	{
		// Node's fetch reports a stream cut mid-response as a bare "terminated".
		patterns: [
			/^(?:TypeError:\s*)?terminated\.?$|fetch failed|socket hang up|other side closed|premature close|network error|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b/i,
		],
		title: "Connection interrupted",
		hint: "The connection to the model provider closed before the reply finished.",
	},
	{
		patterns: [/\btimed? ?out\b|\btimeout\b/i],
		title: "Request timed out",
		hint: "The model provider took too long to respond. Try again.",
	},
];

/** Raw text that reads better in a monospace block than as a sentence:
 * a bare token (`terminated`), multi-line output, JSON, or a long dump. */
function looksLikeCode(text: string): boolean {
	return (
		/^\S+$/.test(text) ||
		text.includes("\n") ||
		/[{}[\]]/.test(text) ||
		text.length > 320
	);
}

export function describeChatError(
	content: string,
	meta?: ChatMessage["meta"],
): ChatErrorSummary {
	const text = content.trim();
	const detailStyle = looksLikeCode(text) ? "code" : "prose";
	// Credential failures already carry a sentence saying what to fix, plus
	// the fix button; a hint would repeat it.
	if (meta?.reason === "credentials") {
		return { title: "Credentials needed", detailStyle };
	}
	const kind = ERROR_KINDS.find((entry) =>
		entry.patterns.some((pattern) => pattern.test(text)),
	);
	if (kind) {
		return { title: kind.title, hint: kind.hint, detailStyle: "code" };
	}
	return { title: "Something went wrong", detailStyle };
}
