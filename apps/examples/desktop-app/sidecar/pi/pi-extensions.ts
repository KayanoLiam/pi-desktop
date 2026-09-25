import { basename, dirname, join, relative } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	type ResolvedResource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type PiExtensionItem = {
	id: string;
	name: string;
	path: string;
	source: string;
	scope: "user" | "project";
	kind: "npm" | "git" | "local";
	enabled: boolean;
	/** Removing a package also removes any skills, prompts and themes it supplies. */
	packageSource?: string;
};

export type PiExtensionInventory = {
	workspaceRoot: string;
	extensions: PiExtensionItem[];
};

function sourceKind(source: string): PiExtensionItem["kind"] {
	if (source.startsWith("npm:")) return "npm";
	if (/^(git:|https?:\/\/|ssh:\/\/)/.test(source)) return "git";
	return "local";
}

function extensionId(resource: ResolvedResource): string {
	const { scope, origin, source } = resource.metadata;
	return JSON.stringify([scope, origin, source, resource.path]);
}

function itemFromResource(resource: ResolvedResource): PiExtensionItem {
	const { scope, origin, source } = resource.metadata;
	const packageSource = origin === "package" ? source : undefined;
	return {
		id: extensionId(resource),
		name: basename(resource.path),
		path: resource.path,
		source: packageSource ?? resource.path,
		scope: scope === "project" ? "project" : "user",
		kind: packageSource ? sourceKind(source) : "local",
		enabled: resource.enabled,
		packageSource,
	};
}

function createManagers(workspaceRoot: string, agentDir: string) {
	const settings = SettingsManager.create(workspaceRoot, agentDir);
	const errors = settings.drainErrors();
	if (errors.length) {
		throw new Error(
			`Could not read Pi settings: ${errors.map((error) => error.error.message).join("; ")}`,
		);
	}
	return {
		settings,
		packages: new DefaultPackageManager({
			cwd: workspaceRoot,
			agentDir,
			settingsManager: settings,
		}),
	};
}

async function resolvedExtensions(packages: DefaultPackageManager) {
	// Never install or update packages merely to render the settings screen.
	return (await packages.resolve(async () => "skip")).extensions;
}

function requireResource(resources: ResolvedResource[], id: string) {
	const resource = resources.find((entry) => extensionId(entry) === id);
	if (!resource || resource.metadata.scope === "temporary") {
		throw new Error(
			"Pi extension is no longer available. Refresh the extensions page.",
		);
	}
	return resource;
}

function assertSettingsSaved(settings: SettingsManager): void {
	const errors = settings.drainErrors();
	if (errors.length) {
		throw new Error(
			`Could not save Pi settings: ${errors.map((error) => error.error.message).join("; ")}`,
		);
	}
}

export async function listPiExtensions(
	workspaceRoot: string,
	agentDir = getAgentDir(),
): Promise<PiExtensionInventory> {
	const { packages } = createManagers(workspaceRoot, agentDir);
	const resources = await resolvedExtensions(packages);
	return {
		workspaceRoot,
		extensions: resources
			.filter((resource) => resource.metadata.scope !== "temporary")
			.map(itemFromResource)
			.sort(
				(a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
			),
	};
}

/** Apply the same exact +path/-path override as Pi's /config resource selector. */
export async function setPiExtensionEnabled(
	workspaceRoot: string,
	id: string,
	enabled: boolean,
	agentDir = getAgentDir(),
): Promise<PiExtensionInventory> {
	const { packages, settings } = createManagers(workspaceRoot, agentDir);
	const resource = requireResource(await resolvedExtensions(packages), id);
	if (resource.enabled === enabled)
		return listPiExtensions(workspaceRoot, agentDir);
	const { scope, origin, source, baseDir } = resource.metadata;
	const local = scope === "project";
	const scopedSettings = local
		? settings.getProjectSettings()
		: settings.getGlobalSettings();
	const root =
		baseDir ??
		(origin === "package"
			? dirname(resource.path)
			: local
				? join(workspaceRoot, ".pi")
				: agentDir);
	const pattern = relative(root, resource.path);
	const override = `${enabled ? "+" : "-"}${pattern}`;
	const withoutPreviousOverride = (entries: string[]) =>
		entries.filter((entry) => entry.replace(/^[!+-]/, "") !== pattern);

	if (origin === "package") {
		const configured = [...(scopedSettings.packages ?? [])];
		const index = configured.findIndex(
			(pkg) => (typeof pkg === "string" ? pkg : pkg.source) === source,
		);
		if (index < 0)
			throw new Error(
				"Pi package configuration has changed. Refresh the extensions page.",
			);
		const pkg = configured[index];
		if (!pkg)
			throw new Error(
				"Pi package configuration has changed. Refresh the extensions page.",
			);
		const current = typeof pkg === "string" ? [] : (pkg.extensions ?? []);
		const updated = withoutPreviousOverride(current);
		const hadExactInclude = current.includes(pattern);
		const hasPlainInclude = updated.some((entry) => !/^[!+-]/.test(entry));
		// An empty package filter disables *all* extensions. Adding only +path
		// would default-enable every sibling; start with a plain, selective include.
		// Likewise, keep a plain include as an anchor when removing the last one
		// while other +path overrides remain, so siblings do not spring to life.
		if (enabled && (current.length === 0 || hadExactInclude)) {
			updated.push(pattern);
		} else if (!enabled && hadExactInclude && updated.length === 0) {
			// [] is Pi's explicit "disable all" filter.
		} else {
			if (!enabled && hadExactInclude && !hasPlainInclude) {
				updated.push(pattern);
			}
			updated.push(override);
		}
		configured[index] = {
			...(typeof pkg === "string" ? { source: pkg } : pkg),
			extensions: updated,
		};
		if (local) settings.setProjectPackages(configured);
		else settings.setPackages(configured);
	} else {
		const entries = [
			...withoutPreviousOverride(scopedSettings.extensions ?? []),
			override,
		];
		if (local) settings.setProjectExtensionPaths(entries);
		else settings.setExtensionPaths(entries);
	}
	await settings.flush();
	assertSettingsSaved(settings);
	const inventory = await listPiExtensions(workspaceRoot, agentDir);
	if (
		inventory.extensions.find((item) => item.id === id)?.enabled !== enabled
	) {
		throw new Error(
			"Pi did not apply the extension change. Refresh the extensions page.",
		);
	}
	return inventory;
}

/** Uninstall a configured package with Pi's own package manager; never delete local extension files. */
export async function uninstallPiExtensionPackage(
	workspaceRoot: string,
	id: string,
	agentDir = getAgentDir(),
): Promise<PiExtensionInventory> {
	const { packages, settings } = createManagers(workspaceRoot, agentDir);
	const resource = requireResource(await resolvedExtensions(packages), id);
	const { scope, origin, source } = resource.metadata;
	if (origin !== "package") {
		throw new Error(
			"Local Pi extension files cannot be uninstalled here. Disable the extension instead.",
		);
	}
	const removed = await packages.removeAndPersist(source, {
		local: scope === "project",
	});
	await settings.flush();
	assertSettingsSaved(settings);
	if (!removed)
		throw new Error(
			"Pi package configuration has changed. Refresh the extensions page.",
		);
	const inventory = await listPiExtensions(workspaceRoot, agentDir);
	if (inventory.extensions.some((item) => item.id === id)) {
		throw new Error(
			"Pi did not remove the extension package. Refresh the extensions page.",
		);
	}
	return inventory;
}
