import { describe, expect, it, vi } from "vitest";
import {
	buildExecutePiCommandRequest,
	isKnownPiBuiltin,
	isPiSlashInput,
	mergePiSlashCommands,
	PI_SLASH_COMMAND_FALLBACK,
	parseExecutePiCommandResponse,
	piSlashCommandName,
	routePiCommandUiAction,
	shouldDeferComposerSideEffects,
	unhandledBuiltinGuidance,
} from "./pi-slash-command";

describe("pi slash command helpers", () => {
	it("uses bare command names and treats only a leading slash as slash input", () => {
		expect(piSlashCommandName("  /name My Session  ")).toBe("name");
		expect(piSlashCommandName("/compact focus on tests")).toBe("compact");
		expect(piSlashCommandName("hello /compact")).toBe("");
		expect(isPiSlashInput("/model")).toBe(true);
		expect(isPiSlashInput("/")).toBe(false);
		expect(shouldDeferComposerSideEffects(true, "/compact")).toBe(true);
		expect(shouldDeferComposerSideEffects(false, "/compact")).toBe(false);
		expect(shouldDeferComposerSideEffects(true, "hello")).toBe(false);
	});

	it("keeps a discovery fallback of real desktop paths only", () => {
		expect(PI_SLASH_COMMAND_FALLBACK.map((command) => command.name)).toEqual([
			"compact",
			"name",
			"new",
			"model",
			"settings",
			"resume",
		]);
		expect(
			PI_SLASH_COMMAND_FALLBACK.some((command) => command.name.includes("<")),
		).toBe(false);
		expect(
			PI_SLASH_COMMAND_FALLBACK.some((command) =>
				["clone", "tree", "fork"].includes(command.name),
			),
		).toBe(false);
		expect(isKnownPiBuiltin("compact")).toBe(true);
		expect(isKnownPiBuiltin("clone")).toBe(true);
		expect(isKnownPiBuiltin("review")).toBe(false);
	});

	it("lets builtins win over a colliding extension and keeps bare names", () => {
		const rows = mergePiSlashCommands({
			commands: [
				{
					name: "name <name>",
					description: "Rename",
					source: "builtin",
				},
				{
					name: "compact",
					description: "Extension compact",
					source: "extension",
				},
				{ name: "review", description: "Review code", source: "extension" },
			],
		});
		expect(rows.find((row) => row.name === "name")?.description).toContain(
			"Rename",
		);
		expect(rows.find((row) => row.name === "name <name>")).toBeUndefined();
		expect(rows.find((row) => row.name === "compact")?.description).toBe(
			"Manually compact conversation context",
		);
		expect(rows.find((row) => row.name === "review")?.description).toContain(
			"Extension command",
		);
		expect(rows.some((row) => row.name === "clone")).toBe(false);
	});

	it("falls back to desktop builtins when discovery returns nothing", () => {
		expect(
			mergePiSlashCommands({ commands: [] }).map((row) => row.name),
		).toEqual(PI_SLASH_COMMAND_FALLBACK.map((row) => row.name));
	});

	it("builds the transport request without empty optional fields", () => {
		expect(
			buildExecutePiCommandRequest({
				text: "  /compact focus  ",
				sessionId: "  ",
				workspaceRoot: "/repo",
			}),
		).toEqual({ text: "/compact focus", workspaceRoot: "/repo" });
		expect(
			buildExecutePiCommandRequest({
				text: "/new",
				sessionId: "ses-1",
				workspaceRoot: "",
			}),
		).toEqual({ text: "/new", sessionId: "ses-1" });
	});

	it("parses the frozen execute response and rejects garbage", () => {
		expect(parseExecutePiCommandResponse({ handled: false })).toEqual({
			handled: false,
		});
		expect(
			parseExecutePiCommandResponse({
				handled: true,
				message: " Compacted. ",
				uiAction: "fork",
				refresh: true,
				extra: "ignored",
			}),
		).toEqual({
			handled: true,
			message: "Compacted.",
			uiAction: "fork",
			refresh: true,
		});
		expect(
			parseExecutePiCommandResponse({
				handled: true,
				message: "Open settings.",
				uiAction: "not-a-control",
				refresh: "yes",
			}),
		).toEqual({
			handled: true,
			message: "Open settings.",
			refresh: false,
		});
		expect(() => parseExecutePiCommandResponse([])).toThrow(
			/unrecognized response/,
		);
		expect(unhandledBuiltinGuidance("compact")).toContain(
			"not sent to the model",
		);
	});

	it("routes safe ui actions and leaves fork as guidance", () => {
		const onNew = vi.fn();
		const onModel = vi.fn();
		const onSettings = vi.fn();
		const onResume = vi.fn();
		const handlers = { onNew, onModel, onSettings, onResume };
		expect(routePiCommandUiAction("new", handlers)).toBe("routed");
		expect(routePiCommandUiAction("model", handlers)).toBe("routed");
		expect(routePiCommandUiAction("settings", handlers)).toBe("routed");
		expect(routePiCommandUiAction("resume", handlers)).toBe("routed");
		expect(routePiCommandUiAction("fork", handlers)).toBe("guidance");
		expect(routePiCommandUiAction(undefined, handlers)).toBe("none");
		expect(onNew).toHaveBeenCalledOnce();
		expect(onModel).toHaveBeenCalledOnce();
		expect(onSettings).toHaveBeenCalledOnce();
		expect(onResume).toHaveBeenCalledOnce();
	});
});
