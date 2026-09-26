// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_SECTIONS } from "../settings/sections";
import { EnvironmentSelector } from "./environment-selector";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Element.prototype.scrollIntoView ??= () => {};
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => {};
	Element.prototype.releasePointerCapture ??= () => {};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function openMenu() {
	const trigger = container.querySelector("#environment-selector-btn");
	if (!trigger) throw new Error("Missing environment selector");
	await act(async () => {
		trigger.dispatchEvent(
			new MouseEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				button: 0,
			}),
		);
	});
}

async function select(label: string) {
	const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
		(item) => item.textContent?.includes(label),
	);
	if (!item) throw new Error(`Missing menu item: ${label}`);
	await act(async () => {
		item.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
	});
}

describe("Pi environment menu", () => {
	it("removes Remote settings and SSH choices even when saved hosts exist", async () => {
		expect(SETTINGS_SECTIONS).not.toContain("Remote");
		await act(async () =>
			root.render(
				<EnvironmentSelector
					activeEnvironmentId="local"
					profiles={[{ id: "host", name: "Saved host", host: "example.com" }]}
					onSelectEnvironment={vi.fn()}
				/>,
			),
		);
		await openMenu();
		expect(document.body.textContent).toContain("Local");
		expect(document.body.textContent).toContain("Cloud");
		expect(document.body.textContent).not.toContain("Remote");
		expect(document.body.textContent).not.toContain("Saved host");
		expect(document.querySelector('[aria-label="Add SSH Host"]')).toBeNull();
	});

	it("preserves Cloud selection", async () => {
		const onSelectExecutionTarget = vi.fn();
		await act(async () =>
			root.render(
				<EnvironmentSelector
					activeEnvironmentId="local"
					profiles={[]}
					cloudEnabled
					onSelectEnvironment={vi.fn()}
					onSelectExecutionTarget={onSelectExecutionTarget}
				/>,
			),
		);
		await openMenu();
		await select("Cloud");
		expect(onSelectExecutionTarget).toHaveBeenCalledExactlyOnceWith("cloud");
	});

	it("can switch back from Cloud to Local", async () => {
		const onSelectExecutionTarget = vi.fn();
		const onSelectEnvironment = vi.fn();
		await act(async () =>
			root.render(
				<EnvironmentSelector
					activeEnvironmentId="local"
					profiles={[]}
					cloudEnabled
					executionTarget="cloud"
					onSelectEnvironment={onSelectEnvironment}
					onSelectExecutionTarget={onSelectExecutionTarget}
				/>,
			),
		);
		await openMenu();
		await select("Local");
		expect(onSelectExecutionTarget).toHaveBeenCalledExactlyOnceWith("local");
		expect(onSelectEnvironment).not.toHaveBeenCalled();
	});
});
