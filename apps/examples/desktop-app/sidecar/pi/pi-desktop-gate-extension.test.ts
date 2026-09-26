import { describe, expect, it, vi } from "vitest";
import { PI_DESKTOP_GATE_EXTENSION_SOURCE } from "./pi-desktop-gate-extension";

describe("Pi desktop navigation extension", () => {
	it("registers tree navigation without intercepting tool calls", async () => {
		const { default: register } = await import(
			`data:text/javascript;base64,${Buffer.from(PI_DESKTOP_GATE_EXTENSION_SOURCE).toString("base64")}`
		);
		const on = vi.fn();
		const registerCommand = vi.fn();
		register({ on, registerCommand });
		expect(on).not.toHaveBeenCalled();
		expect(registerCommand).toHaveBeenCalledExactlyOnceWith(
			"__pi_desktop_tree_jump",
			expect.objectContaining({ handler: expect.any(Function) }),
		);
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		await registerCommand.mock.calls[0][1].handler("node_123", {
			mode: "rpc",
			isIdle: () => true,
			navigateTree,
		});
		expect(navigateTree).toHaveBeenCalledExactlyOnceWith("node_123");
	});
});
