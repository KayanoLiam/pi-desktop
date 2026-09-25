import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listPiExtensions,
	setPiExtensionEnabled,
	uninstallPiExtensionPackage,
} from "./pi-extensions";

let root: string;
let cwd: string;
let agentDir: string;
let packageDir: string;

function writeJson(path: string, value: unknown) {
	writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function extensionNamed(name: string) {
	const item = (await listPiExtensions(cwd, agentDir)).extensions.find(
		(entry) => entry.name === name,
	);
	if (!item) throw new Error(`Missing test Pi extension: ${name}`);
	return item;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-extensions-"));
	cwd = join(root, "workspace");
	agentDir = join(root, "agent");
	packageDir = join(root, "my-package");
	for (const dir of [
		cwd,
		agentDir,
		packageDir,
		join(packageDir, "extensions"),
		join(agentDir, "extensions"),
		join(cwd, ".pi", "extensions"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(
		join(agentDir, "extensions", "global.ts"),
		"export default () => {};\n",
	);
	writeFileSync(
		join(cwd, ".pi", "extensions", "project.ts"),
		"export default () => {};\n",
	);
	writeFileSync(
		join(packageDir, "extensions", "one.ts"),
		"export default () => {};\n",
	);
	writeFileSync(
		join(packageDir, "extensions", "two.ts"),
		"export default () => {};\n",
	);
	writeJson(join(agentDir, "settings.json"), { packages: [packageDir] });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Pi extension inventory", () => {
	it("lists Pi package and auto-discovered extensions with their real scope and source", async () => {
		const inventory = await listPiExtensions(cwd, agentDir);
		expect(inventory.workspaceRoot).toBe(cwd);
		expect(inventory.extensions).toHaveLength(4);
		expect(
			inventory.extensions.find((item) => item.name === "one.ts"),
		).toMatchObject({
			source: packageDir,
			kind: "local",
			scope: "user",
			enabled: true,
			packageSource: packageDir,
		});
		expect(
			inventory.extensions.find((item) => item.name === "project.ts"),
		).toMatchObject({
			kind: "local",
			scope: "project",
			enabled: true,
		});
		expect(
			inventory.extensions.find((item) => item.name === "global.ts")
				?.packageSource,
		).toBeUndefined();
	});

	it("categorizes configured npm and Git packages without installing missing sources", async () => {
		const npmDir = join(agentDir, "npm", "node_modules", "pi-test-ext");
		const gitDir = join(agentDir, "git", "github.com", "demo", "pi-test-ext");
		for (const dir of [npmDir, gitDir]) {
			mkdirSync(join(dir, "extensions"), { recursive: true });
			writeFileSync(
				join(dir, "extensions", "entry.ts"),
				"export default () => {};\n",
			);
		}
		writeJson(join(npmDir, "package.json"), {
			name: "pi-test-ext",
			version: "1.0.0",
		});
		writeJson(join(agentDir, "settings.json"), {
			packages: [
				"npm:pi-test-ext@1.0.0",
				"git:github.com/demo/pi-test-ext",
				"npm:not-present",
			],
		});
		const inventory = await listPiExtensions(cwd, agentDir);
		expect(
			inventory.extensions.find(
				(item) => item.source === "npm:pi-test-ext@1.0.0",
			),
		).toMatchObject({
			kind: "npm",
			enabled: true,
		});
		expect(
			inventory.extensions.find(
				(item) => item.source === "git:github.com/demo/pi-test-ext",
			),
		).toMatchObject({
			kind: "git",
			enabled: true,
		});
		expect(
			inventory.extensions.some((item) => item.source === "npm:not-present"),
		).toBe(false);
	});

	it("disables one package resource without uninstalling the package or its sibling", async () => {
		const item = await extensionNamed("one.ts");
		const disabled = await setPiExtensionEnabled(cwd, item.id, false, agentDir);
		expect(
			disabled.extensions.find((entry) => entry.id === item.id)?.enabled,
		).toBe(false);
		expect(
			disabled.extensions.find((entry) => entry.name === "two.ts")?.enabled,
		).toBe(true);
		expect(readJson(join(agentDir, "settings.json")).packages).toEqual([
			{ source: packageDir, extensions: ["-extensions/one.ts"] },
		]);
		const restored = await setPiExtensionEnabled(cwd, item.id, true, agentDir);
		expect(
			restored.extensions.find((entry) => entry.id === item.id)?.enabled,
		).toBe(true);
		expect(readJson(join(agentDir, "settings.json")).packages).toEqual([
			{ source: packageDir, extensions: ["+extensions/one.ts"] },
		]);
	});

	it("restores a package extension disabled by Pi's empty extensions filter", async () => {
		writeJson(join(agentDir, "settings.json"), {
			packages: [
				{ source: packageDir, extensions: [], skills: ["skills/review.md"] },
			],
		});
		const item = await extensionNamed("one.ts");
		expect(item.enabled).toBe(false);
		const updated = await setPiExtensionEnabled(cwd, item.id, true, agentDir);
		expect(
			updated.extensions.find((entry) => entry.id === item.id)?.enabled,
		).toBe(true);
		expect(
			updated.extensions.find((entry) => entry.name === "two.ts")?.enabled,
		).toBe(false);
		expect(readJson(join(agentDir, "settings.json")).packages).toEqual([
			{
				source: packageDir,
				extensions: ["extensions/one.ts"],
				skills: ["skills/review.md"],
			},
		]);
		const disabled = await setPiExtensionEnabled(cwd, item.id, false, agentDir);
		expect(
			disabled.extensions.find((entry) => entry.id === item.id)?.enabled,
		).toBe(false);
		expect(
			disabled.extensions.find((entry) => entry.name === "two.ts")?.enabled,
		).toBe(false);
		expect(readJson(join(agentDir, "settings.json")).packages).toEqual([
			{ source: packageDir, extensions: [], skills: ["skills/review.md"] },
		]);
	});

	it("keeps other extensions disabled when removing the last selective include", async () => {
		writeFileSync(
			join(packageDir, "extensions", "three.ts"),
			"export default () => {};\n",
		);
		writeJson(join(agentDir, "settings.json"), {
			packages: [{ source: packageDir, extensions: [] }],
		});
		const one = await extensionNamed("one.ts");
		const two = await extensionNamed("two.ts");
		await setPiExtensionEnabled(cwd, one.id, true, agentDir);
		await setPiExtensionEnabled(cwd, two.id, true, agentDir);
		const inventory = await setPiExtensionEnabled(cwd, one.id, false, agentDir);
		expect(
			inventory.extensions.find((entry) => entry.id === one.id)?.enabled,
		).toBe(false);
		expect(
			inventory.extensions.find((entry) => entry.id === two.id)?.enabled,
		).toBe(true);
		expect(
			inventory.extensions.find((entry) => entry.name === "three.ts")?.enabled,
		).toBe(false);
	});

	it("updates project-scoped package settings without touching the global installation", async () => {
		writeJson(join(agentDir, "settings.json"), { packages: [] });
		writeJson(join(cwd, ".pi", "settings.json"), { packages: [packageDir] });
		const item = await extensionNamed("one.ts");
		expect(item.scope).toBe("project");
		const updated = await setPiExtensionEnabled(cwd, item.id, false, agentDir);
		expect(
			updated.extensions.find((entry) => entry.id === item.id)?.enabled,
		).toBe(false);
		expect(readJson(join(cwd, ".pi", "settings.json")).packages).toEqual([
			{ source: packageDir, extensions: ["-extensions/one.ts"] },
		]);
		expect(readJson(join(agentDir, "settings.json")).packages).toEqual([]);
	});

	it("toggles a project auto-discovered extension in project settings without deleting its file", async () => {
		const item = await extensionNamed("project.ts");
		const disabled = await setPiExtensionEnabled(cwd, item.id, false, agentDir);
		expect(
			disabled.extensions.find((entry) => entry.id === item.id)?.enabled,
		).toBe(false);
		expect(readJson(join(cwd, ".pi", "settings.json")).extensions).toEqual([
			"-extensions/project.ts",
		]);
		expect(readFileSync(item.path, "utf8")).toContain("export default");
	});

	it("uninstalls only the selected configured package and preserves local files", async () => {
		const item = await extensionNamed("one.ts");
		const inventory = await uninstallPiExtensionPackage(cwd, item.id, agentDir);
		expect(inventory.extensions.map((entry) => entry.name)).toEqual([
			"global.ts",
			"project.ts",
		]);
		expect(readJson(join(agentDir, "settings.json")).packages).toEqual([]);
		expect(readFileSync(item.path, "utf8")).toContain("export default");
		await expect(
			uninstallPiExtensionPackage(cwd, item.id, agentDir),
		).rejects.toThrow("no longer available");
	});

	it("does not delete auto-discovered extensions or accept forged IDs", async () => {
		const item = await extensionNamed("global.ts");
		await expect(
			uninstallPiExtensionPackage(cwd, item.id, agentDir),
		).rejects.toThrow("cannot be uninstalled");
		await expect(
			setPiExtensionEnabled(cwd, "made-up-id", false, agentDir),
		).rejects.toThrow("no longer available");
		expect(readFileSync(item.path, "utf8")).toContain("export default");
	});

	it("refuses mutation if Pi settings cannot be loaded", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{ invalid json");
		await expect(listPiExtensions(cwd, agentDir)).rejects.toThrow(
			"Could not read Pi settings",
		);
		await expect(
			setPiExtensionEnabled(cwd, "anything", false, agentDir),
		).rejects.toThrow("Could not read Pi settings");
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(
			"{ invalid json",
		);
	});
});
