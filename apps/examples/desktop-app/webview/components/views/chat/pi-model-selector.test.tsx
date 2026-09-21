// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_SELECTION_STORAGE_KEY } from "@/lib/model-selection";
import {
	PI_MODEL_SELECTION_STORAGE_KEY,
	type PiModelCatalog,
} from "@/lib/pi-model-selection";
import { PiModelSelector } from "./pi-model-selector";

const { invoke, subscribe } = vi.hoisted(() => ({
	invoke: vi.fn(),
	subscribe: vi.fn(
		(_eventName: string, _handler: (payload: unknown) => void) => () =>
			undefined,
	),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke, subscribe },
}));

const catalog: PiModelCatalog = {
	providers: [
		{
			id: "alpha",
			name: "Alpha",
			models: [
				{ id: "shared", name: "Shared", thinkingLevels: ["off"] },
				{
					id: "alpha-only",
					name: "Alpha only",
					thinkingLevels: ["off", "low", "medium", "high"],
				},
			],
		},
		{
			id: "beta",
			name: "Beta",
			models: [
				{ id: "shared", name: "Shared", thinkingLevels: ["low", "high"] },
				{ id: "beta-only", name: "Beta only", thinkingLevels: ["off"] },
			],
		},
		{ id: "empty", name: "Empty", models: [] },
	],
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	if (typeof window.localStorage.clear !== "function") {
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: window.sessionStorage,
		});
	}
	window.localStorage.clear();
	HTMLElement.prototype.scrollIntoView = vi.fn();
	invoke.mockReset().mockResolvedValue(catalog);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

type Picker = "Pi provider" | "Pi model" | "Pi thinking level";

function trigger(label: Picker): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(
		`button[aria-label^="${label}:"]`,
	);
	if (!button) throw new Error(`Missing ${label}`);
	return button;
}

async function choose(label: Picker, text: string) {
	await act(async () => trigger(label).click());
	const option = Array.from(
		container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
	).find((button) => button.textContent?.startsWith(text));
	if (!option) throw new Error(`Missing option ${text}`);
	await act(async () => option.click());
}

async function render(props: Parameters<typeof PiModelSelector>[0] = {}) {
	await act(async () => root.render(<PiModelSelector {...props} />));
}

async function refresh() {
	await act(async () =>
		container
			.querySelector<HTMLButtonElement>('[aria-label="Refresh Pi models"]')
			?.click(),
	);
}

describe("Pi model selector", () => {
	it("requires a provider first, filters models, and remembers each provider independently", async () => {
		window.localStorage.setItem(
			MODEL_SELECTION_STORAGE_KEY,
			"unchanged-cline-selection",
		);
		await render();
		expect(trigger("Pi model").disabled).toBe(true);
		await choose("Pi provider", "Alpha");
		await choose("Pi model", "Alpha only");
		await choose("Pi provider", "Beta");
		expect(trigger("Pi model").textContent).toContain("Shared");
		await act(async () => trigger("Pi model").click());
		expect(
			container.querySelector('[role="listbox"]')?.textContent,
		).not.toContain("Alpha only");
		await act(async () => trigger("Pi model").click());
		await choose("Pi model", "Beta only");
		await choose("Pi provider", "Alpha");
		expect(trigger("Pi model").textContent).toContain("Alpha only");
		expect(
			JSON.parse(
				window.localStorage.getItem(PI_MODEL_SELECTION_STORAGE_KEY) ?? "{}",
			),
		).toEqual({
			version: 1,
			providerId: "alpha",
			modelByProvider: { alpha: "alpha-only", beta: "beta-only" },
			thinkingByModel: {},
		});
		expect(window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY)).toBe(
			"unchanged-cline-selection",
		);
		expect(invoke).toHaveBeenCalledExactlyOnceWith("list_pi_model_catalog");
	});

	it("offers the selected model's thinking levels and remembers them per model", async () => {
		invoke.mockResolvedValue({
			...catalog,
			defaultThinkingLevel: "high",
			modelThinkingLevels: { "beta/shared": "low" },
		});
		await render();
		expect(trigger("Pi thinking level").disabled).toBe(true);
		await choose("Pi provider", "Alpha");
		// "shared" is not a reasoning model: nothing to choose.
		expect(trigger("Pi thinking level").disabled).toBe(true);
		expect(trigger("Pi thinking level").textContent).toContain("No thinking");
		await choose("Pi model", "Alpha only");
		expect(trigger("Pi thinking level").disabled).toBe(false);
		expect(trigger("Pi thinking level").textContent).toContain("High");
		await act(async () => trigger("Pi thinking level").click());
		const listbox = container.querySelector('[role="listbox"]');
		expect(listbox?.textContent).toContain("Medium");
		expect(listbox?.textContent).not.toContain("Extra high");
		await act(async () => trigger("Pi thinking level").click());
		await choose("Pi thinking level", "Low");
		await choose("Pi provider", "Beta");
		expect(trigger("Pi model").textContent).toContain("Shared");
		expect(trigger("Pi thinking level").textContent).toContain("Low");
		await choose("Pi thinking level", "High");
		await choose("Pi provider", "Alpha");
		expect(trigger("Pi thinking level").textContent).toContain("Low");
		expect(
			JSON.parse(
				window.localStorage.getItem(PI_MODEL_SELECTION_STORAGE_KEY) ?? "{}",
			).thinkingByModel,
		).toEqual({ "alpha/alpha-only": "low", "beta/shared": "high" });
	});

	it("disables the thinking picker when Pi could not report a model's levels", async () => {
		invoke.mockResolvedValue({
			providers: [
				{
					id: "ext",
					name: "Extension",
					models: [
						{
							id: "mystery",
							name: "Mystery",
							thinkingLevels: [],
							configuredOnly: true,
						},
					],
				},
			],
		});
		await render();
		await choose("Pi provider", "Extension");
		expect(trigger("Pi model").textContent).toContain("Mystery");
		expect(trigger("Pi thinking level").disabled).toBe(true);
		expect(trigger("Pi thinking level").textContent).toContain(
			"Thinking unknown",
		);
	});

	it("restores the exact provider/model pair when models have the same ID", async () => {
		window.localStorage.setItem(
			PI_MODEL_SELECTION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				providerId: "beta",
				modelByProvider: { alpha: "shared", beta: "shared" },
			}),
		);
		await render();
		expect(trigger("Pi provider").textContent).toContain("Beta");
		expect(trigger("Pi model").textContent).toContain("Shared");
	});

	it("clears stale models for empty or removed providers on refresh", async () => {
		await render();
		await choose("Pi provider", "Alpha");
		await choose("Pi provider", "Empty");
		expect(trigger("Pi model").disabled).toBe(true);
		expect(trigger("Pi model").textContent).not.toContain("Shared");
		invoke.mockResolvedValueOnce({ providers: [] });
		await refresh();
		expect(trigger("Pi provider").textContent).toContain("Provider");
		expect(trigger("Pi model").disabled).toBe(true);
	});

	it("disables selection during load and allows retry after an error", async () => {
		let rejectLoad: (error: Error) => void = () => {};
		invoke.mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectLoad = reject;
			}),
		);
		await render();
		expect(trigger("Pi provider").disabled).toBe(true);
		await act(async () => rejectLoad(new Error("private-config-fragment")));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Could not load Pi configuration",
		);
		expect(container.textContent).not.toContain("private-config-fragment");
		await refresh();
		expect(trigger("Pi provider").disabled).toBe(false);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("uses Pi's default pair only when no desktop selection has been saved", async () => {
		invoke.mockResolvedValue({
			...catalog,
			defaultSelection: { providerId: "beta", modelId: "beta-only" },
		});
		await render();
		expect(trigger("Pi provider").textContent).toContain("Beta");
		expect(trigger("Pi model").textContent).toContain("Beta only");
		await choose("Pi provider", "Alpha");
		await refresh();
		expect(trigger("Pi provider").textContent).toContain("Alpha");
	});

	it("explains an empty Pi configuration instead of showing builtin providers", async () => {
		invoke.mockResolvedValue({ providers: [] });
		await render();
		expect(container.textContent).toContain("No configured Pi models");
		expect(trigger("Pi model").disabled).toBe(true);
	});

	it("reports the effective selection to the thread and reloads on Pi config changes", async () => {
		const onSelectionChange = vi.fn();
		invoke.mockResolvedValue({
			...catalog,
			defaultSelection: { providerId: "alpha", modelId: "alpha-only" },
			defaultThinkingLevel: "high",
		});
		await render({ onSelectionChange });
		expect(onSelectionChange).toHaveBeenLastCalledWith({
			providerId: "alpha",
			modelId: "alpha-only",
			thinkingLevel: "high",
		});
		await choose("Pi thinking level", "Low");
		expect(onSelectionChange).toHaveBeenLastCalledWith({
			providerId: "alpha",
			modelId: "alpha-only",
			thinkingLevel: "low",
		});
		await choose("Pi provider", "Beta");
		expect(onSelectionChange).toHaveBeenLastCalledWith({
			providerId: "beta",
			modelId: "shared",
			thinkingLevel: "high",
		});
		expect(subscribe).toHaveBeenCalledWith(
			"pi_config_changed",
			expect.any(Function),
		);
		// A Pi install/remove broadcast reloads the catalog without a click.
		invoke.mockResolvedValueOnce({ providers: [] });
		await act(async () => {
			subscribe.mock.calls.at(-1)?.[1]({});
		});
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("No configured Pi models");
	});

	it("seeds a resumed session's recorded model and keeps it when the catalog lacks it", async () => {
		window.localStorage.setItem(
			PI_MODEL_SELECTION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				providerId: "alpha",
				modelByProvider: { alpha: "alpha-only" },
				thinkingByModel: {},
			}),
		);
		const onSelectionChange = vi.fn();
		await render({
			onSelectionChange,
			value: { providerId: "beta", modelId: "retired", thinkingLevel: "low" },
		});
		expect(trigger("Pi provider").textContent).toContain("Beta");
		expect(onSelectionChange).toHaveBeenLastCalledWith({
			providerId: "beta",
			modelId: "retired",
			thinkingLevel: "",
		});
		// A provider the catalog does not know falls back to the remembered pair.
		await act(async () => root.unmount());
		window.localStorage.setItem(
			PI_MODEL_SELECTION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				providerId: "alpha",
				modelByProvider: { alpha: "alpha-only" },
				thinkingByModel: {},
			}),
		);
		root = createRoot(container);
		await render({
			onSelectionChange,
			value: { providerId: "gone", modelId: "x", thinkingLevel: "" },
		});
		expect(onSelectionChange).toHaveBeenLastCalledWith({
			providerId: "alpha",
			modelId: "alpha-only",
			thinkingLevel: "medium",
		});
	});

	it("freezes the picker while Pi is streaming", async () => {
		await render({ disabled: true });
		expect(trigger("Pi provider").disabled).toBe(true);
		expect(trigger("Pi model").disabled).toBe(true);
		expect(trigger("Pi thinking level").disabled).toBe(true);
	});

	it("still allows selection when browser storage is unavailable", async () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		await render();
		await choose("Pi provider", "Beta");
		expect(trigger("Pi model").textContent).toContain("Shared");
		expect(container.textContent).toContain(
			"Selection could not be saved locally",
		);
	});
});
