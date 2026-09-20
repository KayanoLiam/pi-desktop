import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPiModelCatalog } from "./pi-model-catalog";

let agentDir: string;
const fetchMock = vi.fn(() => {
	throw new Error("Picker must stay offline");
});
function write(file: string, value: unknown) {
	writeFileSync(join(agentDir, file), JSON.stringify(value));
}
/** Executable that mimics `pi --mode rpc` answering get_available_models. */
function fakePi(models: unknown[]): string {
	const bin = join(agentDir, "fake-pi");
	writeFileSync(
		bin,
		`#!/bin/sh
touch "$0.ran"
echo '{"type":"extension_ui_request","id":"x"}'
echo '${JSON.stringify({
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models },
		})}'
cat >/dev/null
`,
		{ mode: 0o755 },
	);
	return bin;
}
function customProviders() {
	write("models.json", {
		providers: {
			"test-alpha": {
				baseUrl: "https://alpha.invalid/v1",
				api: "openai-completions",
				apiKey: `!touch '${join(agentDir, "key-command-ran")}'`,
				headers: { "X-Secret": "private-header" },
				models: [
					{ id: "shared-id", name: "Alpha model" },
					{
						id: "alpha-only",
						name: "Alpha only",
						reasoning: true,
						// xhigh/max only appear when mapped; null hides a level.
						thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
					},
				],
			},
			"test-beta": {
				baseUrl: "https://beta.invalid/v1",
				api: "openai-completions",
				apiKey: "private-key",
				models: [{ id: "shared-id", name: "Beta model" }],
			},
		},
	});
}
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "desktop-pi-catalog-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	for (const key of Object.keys(process.env)) {
		if (
			/API_KEY|API_TOKEN|ACCESS_TOKEN|AWS_PROFILE|AWS_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS/.test(
				key,
			)
		)
			vi.stubEnv(key, "");
	}
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockClear();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("configured Pi model catalog", () => {
	it("does not expose unauthenticated builtin providers or create credential files", async () => {
		const result = await listPiModelCatalog();
		expect(result.providers.map((provider) => provider.id)).not.toContain(
			"anthropic",
		);
		expect(result.providers.map((provider) => provider.id)).not.toContain(
			"openai-codex",
		);
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(existsSync(join(agentDir, "models-store.json"))).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("shows configured custom providers and keeps duplicate model IDs scoped", async () => {
		customProviders();
		const result = await listPiModelCatalog();
		expect(
			result.providers.find((provider) => provider.id === "test-alpha")?.models,
		).toContainEqual({
			id: "shared-id",
			name: "Alpha model",
			thinkingLevels: ["off"],
		});
		expect(
			result.providers.find((provider) => provider.id === "test-beta")?.models,
		).toEqual([
			{ id: "shared-id", name: "Beta model", thinkingLevels: ["off"] },
		]);
		expect(JSON.stringify(result)).not.toMatch(
			/private-header|private-key|key-command-ran|baseUrl/,
		);
		expect(existsSync(join(agentDir, "key-command-ran"))).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("honors enabledModels including provider wildcards and startup defaults", async () => {
		customProviders();
		write("settings.json", {
			enabledModels: ["test-alpha/alpha-*"],
			defaultProvider: "test-alpha",
			defaultModel: "alpha-only",
			defaultThinkingLevel: "high",
			modelThinkingLevels: {
				"test-alpha/alpha-only": "low",
				"test-alpha/shared-id": "medium",
				"test-beta/shared-id": "medium",
				"test-alpha/alpha-only:bad": "not-a-level",
			},
		});
		expect(await listPiModelCatalog()).toEqual({
			providers: [
				{
					id: "test-alpha",
					name: "test-alpha",
					models: [
						{
							id: "alpha-only",
							name: "Alpha only",
							thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
						},
					],
				},
			],
			defaultSelection: { providerId: "test-alpha", modelId: "alpha-only" },
			defaultThinkingLevel: "high",
			// Only levels for models in the catalog are forwarded.
			modelThinkingLevels: { "test-alpha/alpha-only": "low" },
		});
		write("settings.json", { defaultThinkingLevel: "not-a-level" });
		expect(await listPiModelCatalog()).not.toHaveProperty(
			"defaultThinkingLevel",
		);
		write("settings.json", { enabledModels: ["test-alpha/deleted"] });
		expect((await listPiModelCatalog()).providers).toEqual([]);
	});
	it("reads stored OAuth configuration without refreshing or changing it", async () => {
		write("auth.json", {
			"openai-codex": {
				type: "oauth",
				access: "private-access",
				refresh: "private-refresh",
				expires: Date.now() + 600_000,
			},
		});
		const before = readFileSync(join(agentDir, "auth.json"), "utf8");
		const result = await listPiModelCatalog();
		expect(
			result.providers.find((provider) => provider.id === "openai-codex")
				?.models.length,
		).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toMatch(
			/private-access|private-refresh/,
		);
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe(before);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("asks the installed Pi for extension providers and uses their real thinking levels", async () => {
		const bin = fakePi([
			{
				provider: "my-extension",
				id: "custom-model",
				name: "Custom (Extension)",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: null,
					max: null,
				},
			},
			{
				provider: "my-extension",
				id: "plain-model",
				name: "Plain",
				reasoning: false,
			},
			{
				provider: "my-extension",
				id: "unlisted",
				name: "Unlisted",
				reasoning: true,
			},
			// Builtin providers never come from RPC; the SDK catalog owns them.
			{ provider: "anthropic", id: "rpc-only", name: "RPC", reasoning: true },
		]);
		vi.stubEnv("PI_DESKTOP_PI_BIN", bin);
		write("settings.json", {
			enabledModels: [
				"my-extension/custom-model:high",
				"my-extension/plain-*",
				"not-configured/model",
			],
		});
		expect((await listPiModelCatalog()).providers).toEqual([
			{
				id: "my-extension",
				name: "my-extension",
				models: [
					{
						id: "custom-model",
						name: "Custom (Extension)",
						thinkingLevels: ["low", "medium", "high"],
						configuredOnly: true,
					},
					{
						id: "plain-model",
						name: "Plain",
						thinkingLevels: ["off"],
						configuredOnly: true,
					},
				],
			},
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("lists exact authenticated extension references with unknown capabilities when Pi is unavailable", async () => {
		vi.stubEnv("PI_DESKTOP_PI_BIN", join(agentDir, "missing-pi"));
		write("auth.json", {
			"my-extension": {
				type: "oauth",
				access: "private",
				refresh: "private",
				expires: Date.now() + 600_000,
			},
		});
		write("settings.json", {
			enabledModels: [
				"my-extension/custom-model:high",
				"my-extension/*",
				"not-configured/model",
			],
		});
		expect((await listPiModelCatalog()).providers).toEqual([
			{
				id: "my-extension",
				name: "my-extension",
				models: [
					{
						id: "custom-model",
						name: "custom-model",
						thinkingLevels: [],
						configuredOnly: true,
					},
				],
			},
		]);
	});
	it("does not launch Pi when enabledModels only names bundled providers", async () => {
		const bin = fakePi([]);
		vi.stubEnv("PI_DESKTOP_PI_BIN", bin);
		customProviders();
		write("settings.json", { enabledModels: ["test-alpha/*"] });
		await listPiModelCatalog();
		expect(existsSync(`${bin}.ran`)).toBe(false);
	});
	it("reloads changed configuration without a stale catalog", async () => {
		customProviders();
		expect(
			(await listPiModelCatalog()).providers.some(
				(provider) => provider.id === "test-alpha",
			),
		).toBe(true);
		write("models.json", { providers: {} });
		expect(
			(await listPiModelCatalog()).providers.some(
				(provider) => provider.id === "test-alpha",
			),
		).toBe(false);
	});
	it.each([
		"auth.json",
		"models.json",
		"settings.json",
	])("sanitizes invalid %s errors", async (file) => {
		writeFileSync(join(agentDir, file), '{"key":"secret-fragment",');
		await expect(listPiModelCatalog()).rejects.toThrow(
			"Check auth.json, models.json and settings.json",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
