// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiTreeDialog } from "./pi-tree-dialog";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke: invokeMock },
}));

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

const tree = [
	{
		entry: {
			id: "a",
			type: "message",
			parentId: null,
			message: { role: "user", content: "First question" },
		},
		children: [
			{
				entry: {
					id: "b",
					type: "message",
					parentId: "a",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "First answer" }],
					},
				},
				children: [],
			},
			{
				entry: {
					id: "c",
					type: "message",
					parentId: "a",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Second answer" }],
					},
				},
				children: [],
			},
		],
	},
];

async function renderDialog(
	options: {
		sessionId?: string;
		onBeforeNavigate?: () => boolean;
		onNavigated?: ReturnType<typeof vi.fn>;
		onOpenChange?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const onNavigated = options.onNavigated ?? vi.fn();
	const onOpenChange = options.onOpenChange ?? vi.fn();
	await act(async () => {
		root.render(
			<PiTreeDialog
				onBeforeNavigate={options.onBeforeNavigate}
				onNavigated={onNavigated}
				onOpenChange={onOpenChange}
				open
				sessionId={options.sessionId}
			/>,
		);
	});
	return { onNavigated, onOpenChange };
}

async function select(label: string) {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>('button[role="treeitem"]'),
	].find((element) => element.textContent?.includes(label));
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
		await Promise.resolve();
	});
}

describe("PiTreeDialog", () => {
	it("explains why an empty thread has no tree without calling Pi", async () => {
		await renderDialog();
		expect(document.body.textContent).toContain("Start a Pi session");
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it("shows sibling branches and replaces the transcript only after a successful navigation", async () => {
		invokeMock.mockImplementation(async (command: string) => {
			if (command === "get_pi_tree") return { tree, leafId: "c" };
			if (command === "navigate_pi_tree")
				return { leafId: "b", messages: [{ id: "message-b" }] };
			throw new Error(command);
		});
		const { onNavigated, onOpenChange } = await renderDialog({
			sessionId: "pi-1",
		});
		expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
		expect(
			document.querySelector('[aria-current="location"]')?.textContent,
		).toContain("Second answer");
		await select("First answer");
		expect(invokeMock).toHaveBeenCalledWith("navigate_pi_tree", {
			sessionId: "pi-1",
			targetId: "b",
		});
		expect(onNavigated).toHaveBeenCalledWith("pi-1", {
			leafId: "b",
			messages: [{ id: "message-b" }],
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("preserves a draft when navigation is declined and shows Pi failures", async () => {
		invokeMock.mockImplementation(async (command: string) => {
			if (command === "get_pi_tree") return { tree, leafId: "c" };
			throw new Error("Pi is busy");
		});
		const onBeforeNavigate = vi
			.fn()
			.mockReturnValueOnce(false)
			.mockReturnValue(true);
		const { onNavigated, onOpenChange } = await renderDialog({
			sessionId: "pi-1",
			onBeforeNavigate,
		});
		await select("First question");
		expect(onBeforeNavigate).toHaveBeenCalledOnce();
		expect(invokeMock).not.toHaveBeenCalledWith(
			"navigate_pi_tree",
			expect.anything(),
		);
		await select("First answer");
		expect(onNavigated).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Pi is busy",
		);
	});
});
