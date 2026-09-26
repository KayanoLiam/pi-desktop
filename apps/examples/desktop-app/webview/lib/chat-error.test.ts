import { describe, expect, it } from "vitest";
import { describeChatError } from "./chat-error";

describe("describeChatError", () => {
	it("explains a stream cut mid-reply and keeps the raw text as code", () => {
		expect(describeChatError("terminated")).toEqual({
			title: "Connection interrupted",
			hint: "The connection to the model provider closed before the reply finished.",
			detailStyle: "code",
		});
		expect(describeChatError("TypeError: fetch failed").title).toBe(
			"Connection interrupted",
		);
		expect(describeChatError("read ECONNRESET").title).toBe(
			"Connection interrupted",
		);
	});

	it("only reads a bare 'terminated' as a dropped connection", () => {
		expect(
			describeChatError("The Pi process terminated unexpectedly (code 1).")
				.title,
		).toBe("Something went wrong");
	});

	it("recognises HTTP statuses at the start or after status/code", () => {
		expect(describeChatError("429 Too Many Requests").title).toBe(
			"Rate limited",
		);
		expect(describeChatError('Error: 503 {"error":"busy"}').title).toBe(
			"Provider unavailable",
		);
		expect(describeChatError("Request failed with status code 401").title).toBe(
			"Authentication failed",
		);
		expect(
			describeChatError(
				'529 {"type":"error","error":{"type":"overloaded_error"}}',
			).title,
		).toBe("Provider unavailable");
	});

	it("does not read other numbers as HTTP statuses", () => {
		expect(
			describeChatError("max_tokens must be at most 500 for this model").title,
		).toBe("Something went wrong");
	});

	it("names context-window failures before their HTTP status", () => {
		expect(
			describeChatError(
				"400 prompt is too long: 210000 tokens > 200000 maximum",
			).title,
		).toBe("Context window exceeded");
	});

	it("keeps unknown sentences as prose under a generic title", () => {
		expect(describeChatError("Pi exited before replying.")).toEqual({
			title: "Something went wrong",
			detailStyle: "prose",
		});
		expect(describeChatError("line one\nline two").detailStyle).toBe("code");
	});

	it("gives credential failures a title but no hint, since their text says what to fix", () => {
		expect(
			describeChatError(
				"The run failed: cline requires re-authentication. Check your model connection in Settings → API Providers, then try again.",
				{ reason: "credentials", providerId: "cline" },
			),
		).toEqual({ title: "Credentials needed", detailStyle: "prose" });
	});
});
