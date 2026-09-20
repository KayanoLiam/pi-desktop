import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSettingsManager } from "@cline/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCommand } from "./commands";
import { createSidecarContext } from "./context";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("./oauth-login", () => ({
	runCancellableProviderOAuthLogin: login,
	cancelProviderOAuthLogin: vi.fn(),
}));
let dataDir: string;
beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-no-account-"));
	vi.stubEnv("CLINE_DATA_DIR", dataDir);
	login.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dataDir, { recursive: true, force: true });
});

describe("account-free Pi desktop", () => {
	it.each([
		"fetchMe",
		"fetchBalance",
		"switchAccount",
		"fetchUsage",
	])("rejects the legacy account operation %s without resolving tokens", async (operation) => {
		const ctx = createSidecarContext("/workspace");
		const readSettings = vi.spyOn(
			ProviderSettingsManager.prototype,
			"getProviderSettings",
		);
		await expect(
			handleCommand(ctx, "cline_account", {
				operation,
			}),
		).rejects.toThrow("Cline accounts are not supported");
		expect(readSettings).not.toHaveBeenCalled();
	});

	it.each([
		"cline",
		"CLINE",
		" cline ",
	])("blocks %s OAuth before starting a browser or changing credentials", async (provider) => {
		const save = vi.spyOn(
			ProviderSettingsManager.prototype,
			"saveProviderSettings",
		);
		await expect(
			handleCommand(
				createSidecarContext("/workspace"),
				"run_provider_oauth_login",
				{ provider },
			),
		).rejects.toThrow("Cline accounts are not supported");
		expect(login).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps third-party provider OAuth independent of Cline accounts", async () => {
		login.mockResolvedValue({ providerId: "openai-codex" });
		await expect(
			handleCommand(
				createSidecarContext("/workspace"),
				"run_provider_oauth_login",
				{ provider: "openai-codex" },
			),
		).resolves.toEqual({ providerId: "openai-codex" });
		expect(login).toHaveBeenCalledOnce();
	});

	it("does not offer Cline billing providers in settings", async () => {
		const catalog = (await handleCommand(
			createSidecarContext("/workspace"),
			"list_provider_catalog",
			{},
		)) as { providers: { id: string }[] };
		expect(catalog.providers.map((provider) => provider.id)).not.toContain(
			"cline",
		);
		expect(catalog.providers.map((provider) => provider.id)).not.toContain(
			"cline-pass",
		);
		expect(catalog.providers.length).toBeGreaterThan(0);
	});
});
