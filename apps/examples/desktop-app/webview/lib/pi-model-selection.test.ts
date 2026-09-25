import { describe, expect, it } from "vitest";
import {
	clampPiThinkingLevel,
	emptyPiModelSelection,
	orderedPiCyclingModels,
	type PiCatalogProvider,
	type PiModelSelection,
	parsePiModelSelection,
	selectedPiModelId,
	selectedPiThinkingLevel,
	selectPiProvider,
} from "./pi-model-selection";

it("cycles a pre-session Pi selection in saved scope order, or all if unrestricted", () => {
	const models = [
		{ provider: "alpha", id: "a" },
		{ provider: "alpha", id: "b" },
		{ provider: "beta", id: "c" },
	];
	expect(orderedPiCyclingModels(models, ["beta/c", "alpha/a"])).toEqual([
		models[2],
		models[0],
	]);
	expect(orderedPiCyclingModels(models, null)).toEqual(models);
	expect(orderedPiCyclingModels(models, [])).toEqual(models);
});

const providers: PiCatalogProvider[] = [
	{
		id: "alpha",
		name: "Alpha",
		models: [
			{ id: "shared", name: "Shared", thinkingLevels: ["off"] },
			{
				id: "alpha-only",
				name: "Only Alpha",
				thinkingLevels: ["off", "low", "medium", "high"],
			},
		],
	},
	{
		id: "beta",
		name: "Beta",
		models: [
			{ id: "shared", name: "Shared", thinkingLevels: ["low", "high"] },
			{ id: "beta-only", name: "Only Beta", thinkingLevels: ["off"] },
		],
	},
	{ id: "empty", name: "Empty", models: [] },
];

function selection(
	providerId: string,
	modelByProvider: Record<string, string>,
	thinkingByModel: PiModelSelection["thinkingByModel"] = {},
): PiModelSelection {
	return { version: 1, providerId, modelByProvider, thinkingByModel };
}

describe("Pi model selection", () => {
	it("remembers a separate model for every provider, even with identical IDs", () => {
		const start = selection("alpha", { alpha: "alpha-only", beta: "shared" });
		const beta = selectPiProvider(start, providers, "beta");
		expect(beta.providerId).toBe("beta");
		expect(selectedPiModelId(beta)).toBe("shared");
		const alpha = selectPiProvider(beta, providers, "alpha");
		expect(selectedPiModelId(alpha)).toBe("alpha-only");
		expect(alpha.modelByProvider.beta).toBe("shared");
	});

	it("replaces a removed model with one belonging to the selected provider", () => {
		const start = selection("alpha", { alpha: "removed" });
		expect(selectedPiModelId(selectPiProvider(start, providers, "alpha"))).toBe(
			"shared",
		);
		expect(selectedPiModelId(selectPiProvider(start, providers, "empty"))).toBe(
			"",
		);
		const removed = selectPiProvider(start, providers, "removed");
		expect(removed.providerId).toBe("");
		expect(selectedPiModelId(removed)).toBe("");
	});

	it("does not choose a provider before the user does", () => {
		expect(selectPiProvider(emptyPiModelSelection(), providers, "")).toEqual(
			emptyPiModelSelection(),
		);
	});

	it.each([
		null,
		"{",
		"[]",
		'{"version":2}',
		'{"version":1,"providerId":"a","modelByProvider":[]}',
	])("handles invalid storage: %s", (raw) => {
		expect(parsePiModelSelection(raw)).toEqual(emptyPiModelSelection());
	});

	it("round-trips opaque IDs and ignores invalid model entries", () => {
		const stored = parsePiModelSelection(
			'{"version":1,"providerId":"__proto__","modelByProvider":{"__proto__":"org/model:v1","Other.ID":"same-id","invalid":12},"thinkingByModel":{"a/b":"high","a/c":"loud","a/d":3}}',
		);
		expect(selectedPiModelId(stored)).toBe("org/model:v1");
		expect(stored.modelByProvider).not.toHaveProperty("invalid");
		expect(stored.thinkingByModel).toEqual({ "a/b": "high" });
		expect(parsePiModelSelection(JSON.stringify(stored))).toEqual(stored);
	});

	it("accepts selections saved before thinking levels existed", () => {
		expect(
			parsePiModelSelection(
				'{"version":1,"providerId":"alpha","modelByProvider":{"alpha":"shared"}}',
			),
		).toEqual(selection("alpha", { alpha: "shared" }));
	});

	it("clamps a thinking level to the nearest supported one, preferring higher", () => {
		const levels = ["off", "low", "high"] as const;
		expect(clampPiThinkingLevel(levels, "low")).toBe("low");
		expect(clampPiThinkingLevel(levels, "medium")).toBe("high");
		expect(clampPiThinkingLevel(levels, "max")).toBe("high");
		expect(clampPiThinkingLevel(["off"], "xhigh")).toBe("off");
		expect(clampPiThinkingLevel([], "xhigh")).toBe("off");
	});

	it("derives the thinking level from the desktop choice, then Pi settings, then Pi's default", () => {
		const catalog = { providers };
		expect(
			selectedPiThinkingLevel(
				selection("alpha", { alpha: "alpha-only" }),
				catalog,
			),
		).toBe("medium");
		expect(
			selectedPiThinkingLevel(selection("alpha", { alpha: "alpha-only" }), {
				providers,
				defaultThinkingLevel: "high",
			}),
		).toBe("high");
		expect(
			selectedPiThinkingLevel(selection("alpha", { alpha: "alpha-only" }), {
				providers,
				defaultThinkingLevel: "high",
				modelThinkingLevels: { "alpha/alpha-only": "low" },
			}),
		).toBe("low");
		expect(
			selectedPiThinkingLevel(
				selection(
					"alpha",
					{ alpha: "alpha-only" },
					{ "alpha/alpha-only": "high", "beta/shared": "high" },
				),
				{ providers, modelThinkingLevels: { "alpha/alpha-only": "low" } },
			),
		).toBe("high");
	});

	it("keeps thinking levels per provider/model pair and clamps unsupported ones", () => {
		const remembered = {
			"alpha/shared": "high",
			"beta/shared": "max",
		} as const;
		expect(
			selectedPiThinkingLevel(
				selection("alpha", { alpha: "shared" }, { ...remembered }),
				{ providers },
			),
		).toBe("off");
		expect(
			selectedPiThinkingLevel(
				selection("beta", { beta: "shared" }, { ...remembered }),
				{ providers },
			),
		).toBe("high");
		expect(
			selectedPiThinkingLevel(selection("beta", { beta: "shared" }), {
				providers,
			}),
		).toBe("high");
		expect(selectedPiThinkingLevel(selection("", {}), { providers })).toBe("");
		expect(
			selectedPiThinkingLevel(selection("empty", { empty: "" }), { providers }),
		).toBe("");
	});
});
