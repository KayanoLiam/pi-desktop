// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, setTitle, getName } = vi.hoisted(() => ({
	invoke: vi.fn(),
	setTitle: vi.fn(async () => undefined),
	getName: vi.fn(async () => "Pi"),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke },
	isTauriAvailable: () => window.__TAURI_INTERNALS__ !== undefined,
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ setTitle }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getName }));

async function importFresh() {
	vi.resetModules();
	return await import("./desktop-window-title");
}

beforeEach(() => {
	invoke.mockReset();
	setTitle.mockClear();
	getName.mockReset();
	getName.mockResolvedValue("Pi");
	// biome-ignore lint/suspicious/noExplicitAny: test-only global shim for the Tauri bridge marker
	delete (window as any).__TAURI_INTERNALS__;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("desktop window title", () => {
	it("builds a versioned title, falling back to the base title without a version", async () => {
		const { buildDesktopWindowTitle, DEFAULT_DESKTOP_WINDOW_TITLE } =
			await importFresh();
		expect(buildDesktopWindowTitle("1.2.3")).toBe(
			`${DEFAULT_DESKTOP_WINDOW_TITLE} v1.2.3`,
		);
		expect(buildDesktopWindowTitle("  1.2.3  ")).toBe(
			`${DEFAULT_DESKTOP_WINDOW_TITLE} v1.2.3`,
		);
		expect(buildDesktopWindowTitle(undefined)).toBe(
			DEFAULT_DESKTOP_WINDOW_TITLE,
		);
		expect(buildDesktopWindowTitle("")).toBe(DEFAULT_DESKTOP_WINDOW_TITLE);
	});

	it("titles beta builds with the beta product name", async () => {
		const { buildDesktopWindowTitle } = await importFresh();
		expect(buildDesktopWindowTitle("0.0.14-beta.1")).toBe(
			"Pi Beta v0.0.14-beta.1",
		);
	});

	it("prefers the bundle's configured product name over the version guess", async () => {
		const { buildDesktopWindowTitle } = await importFresh();
		expect(buildDesktopWindowTitle("0.1.0-beta.1", "Pi")).toBe(
			"Pi v0.1.0-beta.1",
		);
		expect(buildDesktopWindowTitle("0.1.0-beta.1", "Pi Desktop")).toBe(
			"Pi Desktop v0.1.0-beta.1",
		);
		expect(buildDesktopWindowTitle("0.1.0-beta.1", "  ")).toBe(
			"Pi Beta v0.1.0-beta.1",
		);
		expect(buildDesktopWindowTitle(undefined, "Pi Desktop")).toBe("Pi Desktop");
	});

	it("does nothing outside the Tauri shell", async () => {
		const { syncDesktopWindowTitle } = await importFresh();
		await syncDesktopWindowTitle();
		expect(invoke).not.toHaveBeenCalled();
		expect(setTitle).not.toHaveBeenCalled();
	});

	it("sets the native window title once the sidecar reports a version", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only global shim for the Tauri bridge marker
		(window as any).__TAURI_INTERNALS__ = {};
		invoke.mockResolvedValue({
			workspaceRoot: "",
			cwd: "",
			appVersion: "1.2.3",
		});

		const { syncDesktopWindowTitle, DEFAULT_DESKTOP_WINDOW_TITLE } =
			await importFresh();
		await syncDesktopWindowTitle();

		expect(invoke).toHaveBeenCalledWith("get_process_context");
		expect(setTitle).toHaveBeenCalledWith(
			`${DEFAULT_DESKTOP_WINDOW_TITLE} v1.2.3`,
		);
	});

	it("titles the window with the Tauri app name, or the version guess without one", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only global shim for the Tauri bridge marker
		(window as any).__TAURI_INTERNALS__ = {};
		invoke.mockResolvedValue({
			workspaceRoot: "",
			cwd: "",
			appVersion: "0.1.0-beta.1",
		});
		getName.mockResolvedValue("Pi Desktop");

		const { syncDesktopWindowTitle } = await importFresh();
		await syncDesktopWindowTitle();
		expect(setTitle).toHaveBeenLastCalledWith("Pi Desktop v0.1.0-beta.1");

		getName.mockRejectedValue(new Error("app name unavailable"));
		await syncDesktopWindowTitle();
		expect(setTitle).toHaveBeenLastCalledWith("Pi Beta v0.1.0-beta.1");
	});

	it("leaves the title alone when the version is missing or the sidecar call fails", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only global shim for the Tauri bridge marker
		(window as any).__TAURI_INTERNALS__ = {};
		invoke.mockResolvedValue({ workspaceRoot: "", cwd: "" });

		const { syncDesktopWindowTitle } = await importFresh();
		await syncDesktopWindowTitle();
		expect(setTitle).not.toHaveBeenCalled();

		invoke.mockRejectedValue(
			new Error("Desktop backend transport unavailable"),
		);
		await syncDesktopWindowTitle();
		expect(setTitle).not.toHaveBeenCalled();
	});
});
