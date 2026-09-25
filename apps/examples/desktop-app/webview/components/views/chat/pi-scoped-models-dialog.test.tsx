// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PiModelScope,
	PiScopedModelsDialog,
} from "./pi-scoped-models-dialog";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke: invokeMock },
}));

const models = [
	{ provider: "alpha", id: "a", name: "Alpha A" },
	{ provider: "alpha", id: "b", name: "Alpha B" },
	{ provider: "beta", id: "c", name: "Beta C" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	invokeMock.mockReset();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

async function clickButton(text: string) {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((candidate) => candidate.textContent?.includes(text));
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
		await Promise.resolve();
	});
}

async function renderDialog(
	scope: PiModelScope,
	sessionId: string | undefined,
	onOpenChange = vi.fn(),
) {
	invokeMock.mockImplementation(async (command: string) => {
		if (command === "get_pi_model_scope") return scope;
		if (command === "set_pi_model_scope") return { enabled: scope.enabled };
		throw new Error(`Unexpected command: ${command}`);
	});
	await act(async () => {
		root.render(
			<PiScopedModelsDialog
				onOpenChange={onOpenChange}
				open
				sessionId={sessionId}
				workspaceRoot="/work"
			/>,
		);
	});
	await vi.waitFor(() => {
		expect(
			document.querySelectorAll('fieldset input[type="checkbox"]'),
		).toHaveLength(models.length);
	});
	return onOpenChange;
}

describe("PiScopedModelsDialog", () => {
	it("applies a filtered selection only to the active session", async () => {
		const onOpenChange = await renderDialog(
			{ models, enabled: ["alpha/a", "alpha/b"], hasSession: true },
			"pi-thread",
		);
		expect(invokeMock).toHaveBeenCalledWith("get_pi_model_scope", {
			sessionId: "pi-thread",
			workspaceRoot: "/work",
		});
		const checkboxes = [
			...document.querySelectorAll<HTMLInputElement>(
				'fieldset input[type="checkbox"]',
			),
		];
		expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([
			true,
			true,
			false,
		]);
		await act(async () => checkboxes[2]?.click());
		await act(async () => checkboxes[1]?.click());
		await clickButton("Apply to session");
		expect(invokeMock).toHaveBeenCalledWith("set_pi_model_scope", {
			sessionId: "pi-thread",
			workspaceRoot: "/work",
			enabled: ["alpha/a", "beta/c"],
			save: false,
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("saves an unrestricted selection without requiring a session", async () => {
		await renderDialog(
			{ models, enabled: ["alpha/a"], hasSession: false },
			undefined,
		);
		expect(document.body.textContent).not.toContain("Apply to session");
		await clickButton("Clear");
		await clickButton("Save to Pi settings");
		expect(invokeMock).toHaveBeenCalledWith("set_pi_model_scope", {
			sessionId: undefined,
			workspaceRoot: "/work",
			enabled: [],
			save: true,
		});
	});

	it("keeps the selector open when saving fails", async () => {
		const onOpenChange = await renderDialog(
			{ models, enabled: null, hasSession: true },
			"pi-thread",
		);
		invokeMock.mockRejectedValueOnce(new Error("Could not save Pi models"));
		// First call was already made during loading; reject the next save call.
		await clickButton("Save to Pi settings");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Could not save Pi models",
		);
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});
