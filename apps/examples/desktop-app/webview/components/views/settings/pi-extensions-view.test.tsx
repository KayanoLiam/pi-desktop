// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiExtensionsView } from "./pi-extensions-view";

const { invoke, subscribe } = vi.hoisted(() => ({
	invoke: vi.fn(),
	subscribe: vi.fn(),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke, subscribe },
}));

const first = {
	id: "one",
	name: "one.ts",
	path: "/agent/npm/one/extensions/one.ts",
	source: "npm:one",
	packageSource: "npm:one",
	scope: "user",
	kind: "npm",
	enabled: true,
};
const second = {
	id: "two",
	name: "two.ts",
	path: "/workspace/.pi/extensions/two.ts",
	source: "/workspace/.pi/extensions/two.ts",
	scope: "project",
	kind: "local",
	enabled: false,
};
const inventory = { workspaceRoot: "/workspace", extensions: [first, second] };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	invoke.mockReset();
	invoke.mockResolvedValue(inventory);
	subscribe.mockReset();
	subscribe.mockReturnValue(vi.fn());
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function renderView() {
	await act(async () => root.render(<PiExtensionsView />));
}

function clickButton(name: string) {
	const button = [...document.querySelectorAll("button")].find(
		(element) =>
			element.getAttribute("aria-label") === name ||
			element.textContent?.trim() === name,
	);
	if (!button) throw new Error(`Missing button: ${name}`);
	button.click();
}

describe("Pi extensions view", () => {
	it("shows source category, scope, configured state and only offers package uninstall", async () => {
		await renderView();
		expect(invoke).toHaveBeenCalledWith("list_pi_extensions");
		expect(container.textContent).toContain("npm packages");
		expect(container.textContent).toContain("Local extensions");
		expect(container.textContent).toContain("npm:one");
		expect(container.textContent).toContain("Global");
		expect(container.textContent).toContain("Project");
		expect(container.textContent).toContain("Enabled");
		expect(container.textContent).toContain("Disabled");
		expect(
			container.querySelectorAll('button[aria-label^="Uninstall package for"]'),
		).toHaveLength(1);
		expect(subscribe).toHaveBeenCalledWith(
			"pi_config_changed",
			expect.any(Function),
		);
	});

	it("only updates configured state after Pi confirms a change, not on a failed request", async () => {
		await renderView();
		invoke.mockRejectedValueOnce(new Error("Pi is busy"));
		await act(async () => clickButton("Disable one / one.ts"));
		expect(invoke).toHaveBeenCalledWith("set_pi_extension_enabled", {
			id: "one",
			enabled: false,
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"Pi is busy",
		);
		expect(
			container.querySelector('button[aria-label="Disable one / one.ts"]'),
		).toBeTruthy();
		invoke.mockResolvedValueOnce({
			...inventory,
			extensions: [{ ...first, enabled: false }, second],
		});
		await act(async () => clickButton("Disable one / one.ts"));
		expect(
			container.querySelector('button[aria-label="Enable one / one.ts"]'),
		).toBeTruthy();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it("keeps controls disabled while a change is pending and prevents duplicate requests", async () => {
		await renderView();
		let resolveChange: (value: unknown) => void = () => {};
		invoke.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveChange = resolve;
			}),
		);
		await act(async () => clickButton("Disable one / one.ts"));
		const button = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Disable one / one.ts"]',
		);
		expect(button?.disabled).toBe(true);
		await act(async () => button?.click());
		expect(invoke).toHaveBeenCalledTimes(2);
		await act(async () =>
			resolveChange({
				...inventory,
				extensions: [{ ...first, enabled: false }, second],
			}),
		);
		expect(
			container.querySelector('button[aria-label="Enable one / one.ts"]'),
		).toBeTruthy();
	});

	it("confirms removing the entire package and leaves local-only extension non-uninstallable", async () => {
		await renderView();
		await act(async () => clickButton("Uninstall package for one / one.ts"));
		expect(document.body.textContent).toContain(
			"also removes every other extension, skill, prompt, or theme",
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		invoke.mockResolvedValueOnce({ ...inventory, extensions: [second] });
		await act(async () => clickButton("Uninstall package"));
		expect(invoke).toHaveBeenCalledWith("uninstall_pi_extension_package", {
			id: "one",
		});
		expect(container.textContent).not.toContain("npm:one");
		expect(container.textContent).toContain("two.ts");
	});

	it("cancels package removal without calling the uninstall command", async () => {
		await renderView();
		await act(async () => clickButton("Uninstall package for one / one.ts"));
		await act(async () => clickButton("Cancel"));
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("one.ts");
	});

	it("shows the backend error when the inventory is unavailable", async () => {
		invoke.mockRejectedValueOnce(new Error("Could not read Pi settings"));
		await renderView();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"Could not read Pi settings",
		);
		expect(
			container.querySelector(
				'button[aria-label="Uninstall package for one / one.ts"]',
			),
		).toBeNull();
	});
});
