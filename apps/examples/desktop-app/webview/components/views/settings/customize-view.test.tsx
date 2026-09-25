// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CustomizeView } from "./customize-view";

const { openExternalUrl } = vi.hoisted(() => ({
	openExternalUrl: vi.fn(),
}));
vi.mock("@/lib/desktop-client", () => ({ openExternalUrl }));
vi.mock("./pi-extensions-view", () => ({
	PiExtensionsView: () => <p>Real Pi extension inventory</p>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.clearAllMocks();
});

it("shows only Pi extensions and a Pi packages link, not Cline inventory or marketplace", async () => {
	await act(async () => root.render(<CustomizeView />));
	expect(container.textContent).toContain("Pi extensions");
	expect(container.textContent).toContain("Real Pi extension inventory");
	expect(container.textContent).not.toContain("Cline");
	expect(container.textContent).not.toContain("Connectors");
	expect(container.textContent).not.toContain("Marketplace");
	const packages = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Pi packages"),
	);
	if (!packages) throw new Error("Missing Pi packages link");
	await act(async () => packages.click());
	expect(openExternalUrl).toHaveBeenCalledWith("https://pi.dev/packages");
});
