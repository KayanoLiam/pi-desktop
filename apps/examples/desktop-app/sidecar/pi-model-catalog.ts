import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import {
	isPiThinkingLevel,
	type PiCatalogModel,
	type PiModelCatalog,
	type PiThinkingLevel,
	piModelKey,
} from "../webview/lib/pi-model-selection";

/** Subset of Pi's Model object needed to describe a picker entry. */
interface PiRpcModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

const PI_RPC_TIMEOUT_MS = 15_000;

/**
 * Ask the user's installed Pi CLI which models it has available. This is the
 * only way to see providers registered by installed extensions (for example
 * Antigravity) with their real names and thinking-level maps: the extension
 * code runs inside Pi, not inside this sidecar. Offline, no session file, no
 * tools, no project-local files. Returns null when Pi is not installed or does
 * not answer in time; callers must then avoid guessing capabilities.
 */
export async function listPiRpcModels(): Promise<PiRpcModel[] | null> {
	const bin = process.env.PI_DESKTOP_PI_BIN?.trim() || "pi";
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (value: PiRpcModel[] | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
				bin,
				[
					"--mode",
					"rpc",
					"--no-session",
					"--no-tools",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					"--no-approve",
				],
				{
					cwd: tmpdir(),
					env: { ...process.env, PI_OFFLINE: "1" },
					stdio: ["pipe", "pipe", "ignore"],
				},
			);
		} catch {
			resolve(null);
			return;
		}
		const timer = setTimeout(() => finish(null), PI_RPC_TIMEOUT_MS);
		child.on("error", () => finish(null));
		child.on("exit", () => finish(null));
		let buffer = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const response = message as {
					type?: string;
					command?: string;
					success?: boolean;
					data?: { models?: unknown };
				};
				if (
					response.type !== "response" ||
					response.command !== "get_available_models"
				)
					continue;
				const models = response.success ? response.data?.models : undefined;
				finish(
					Array.isArray(models)
						? models.filter(
								(model): model is PiRpcModel =>
									!!model &&
									typeof model === "object" &&
									typeof (model as PiRpcModel).provider === "string" &&
									typeof (model as PiRpcModel).id === "string",
							)
						: null,
				);
			}
		});
		child.stdin?.write('{"id":"desktop","type":"get_available_models"}\n');
	});
}

/** Pi's `enabledModels` glob semantics: match "provider/id" or the bare id, case-insensitively. */
function matchesModelPattern(pattern: string, model: PiRpcModel): boolean {
	const glob = pattern.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
	if (/[*?[\]{}]/.test(glob)) {
		const regex = new RegExp(
			`^${glob
				.split("")
				.map((char) =>
					char === "*"
						? ".*"
						: char === "?"
							? "."
							: char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
				)
				.join("")}$`,
			"i",
		);
		return regex.test(`${model.provider}/${model.id}`) || regex.test(model.id);
	}
	const lower = glob.toLowerCase();
	return (
		`${model.provider}/${model.id}`.toLowerCase() === lower ||
		model.id.toLowerCase() === lower
	);
}

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type ModelsStore = NonNullable<CreateModelRuntimeOptions["modelsStore"]>;

async function readObject(path: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(
			(await readFile(path, "utf8")).replace(/^\uFEFF/, ""),
		);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid configuration");
		return value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function listPiModelCatalog(): Promise<PiModelCatalog> {
	try {
		const {
			ModelRuntime,
			getAgentDir,
			readStoredCredential,
			resolveModelScopeWithDiagnostics,
		} = await import("@earendil-works/pi-coding-agent");
		const dir = getAgentDir();
		const authPath = join(dir, "auth.json");
		const [auth, cache, settings] = await Promise.all([
			readObject(authPath),
			readObject(join(dir, "models-store.json")),
			readObject(join(dir, "settings.json")),
		]);
		// Pi's public credential reader does not execute API-key commands. This
		// read-only adapter also prevents OAuth refresh/login from writing auth.
		const credentials: CredentialStore = {
			async read(providerId) {
				return readStoredCredential(providerId, authPath);
			},
			async list() {
				return Object.keys(auth).flatMap((providerId) => {
					const credential = readStoredCredential(providerId, authPath);
					return credential ? [{ providerId, type: credential.type }] : [];
				});
			},
			async modify() {
				throw new Error("Model selection cannot modify Pi credentials");
			},
			async delete() {
				throw new Error("Model selection cannot modify Pi credentials");
			},
		};
		// Restore locally cached catalogs, but never write/create pi's cache.
		const modelsStore: ModelsStore = {
			async read(providerId) {
				return Object.hasOwn(cache, providerId)
					? (cache[providerId] as Awaited<ReturnType<ModelsStore["read"]>>)
					: undefined;
			},
			async write() {},
			async delete() {},
		};
		const runtime = await ModelRuntime.create({
			credentials,
			modelsStore,
			allowModelNetwork: false,
			signal: AbortSignal.timeout(10_000),
		});
		if (runtime.getError()) throw new Error("Invalid Pi model configuration");
		const patterns = settings.enabledModels;
		if (
			patterns !== undefined &&
			(!Array.isArray(patterns) ||
				patterns.some((entry) => typeof entry !== "string"))
		) {
			throw new Error("Invalid enabledModels");
		}
		// Match Pi's model scope rules (including provider-qualified IDs and
		// wildcards). A stale scope must not silently fall back to every model.
		const models =
			Array.isArray(patterns) && patterns.length > 0
				? (
						await resolveModelScopeWithDiagnostics(patterns, runtime)
					).scopedModels.map((entry) => entry.model)
				: runtime.getAvailableSnapshot();
		const grouped = new Map<string, PiModelCatalog["providers"][number]>();
		for (const model of models) {
			let provider = grouped.get(model.provider);
			if (!provider) {
				provider = {
					id: model.provider,
					name: runtime.getProvider(model.provider)?.name ?? model.provider,
					models: [],
				};
				grouped.set(model.provider, provider);
			}
			if (!provider.models.some((entry) => entry.id === model.id)) {
				provider.models.push({
					id: model.id,
					name: model.name,
					// Same rule Pi's /thinking UI uses; xhigh/max need an explicit map.
					thinkingLevels:
						getSupportedThinkingLevels(model).filter(isPiThinkingLevel),
				});
			}
		}
		// Extension providers do not exist in the bundled SDK, so ask the
		// installed Pi for them (only when enabledModels references one). Their
		// names and thinking levels come from the extension's own registration;
		// if Pi cannot be reached, list the exact references without guessing
		// capabilities.
		if (Array.isArray(patterns)) {
			const extensionPatterns = patterns.filter((pattern) => {
				const slash = pattern.indexOf("/");
				if (slash < 1) return false;
				const providerId = pattern.slice(0, slash);
				return (
					!/[*?[\]{}]/.test(providerId) && !runtime.getProvider(providerId)
				);
			});
			const rpcModels =
				extensionPatterns.length > 0 ? await listPiRpcModels() : null;
			const addExtensionModel = (
				providerId: string,
				model: PiCatalogModel,
				name?: string,
			) => {
				let provider = grouped.get(providerId);
				if (!provider) {
					provider = { id: providerId, name: name ?? providerId, models: [] };
					grouped.set(providerId, provider);
				}
				if (!provider.models.some((entry) => entry.id === model.id)) {
					provider.models.push(model);
				}
			};
			for (const pattern of extensionPatterns) {
				const slash = pattern.indexOf("/");
				const providerId = pattern.slice(0, slash);
				if (rpcModels) {
					for (const model of rpcModels) {
						if (model.provider !== providerId) continue;
						if (runtime.getProvider(model.provider)) continue;
						if (!matchesModelPattern(pattern, model)) continue;
						addExtensionModel(providerId, {
							id: model.id,
							name: model.name || model.id,
							thinkingLevels: getSupportedThinkingLevels(
								model as Parameters<typeof getSupportedThinkingLevels>[0],
							).filter(isPiThinkingLevel),
							configuredOnly: true,
						});
					}
					continue;
				}
				// Pi unavailable: keep exact, authenticated references visible so
				// the user sees their configuration, but with unknown capabilities.
				if (/[*?[\]{}]/.test(pattern)) continue;
				if (!Object.hasOwn(auth, providerId)) continue;
				if (!readStoredCredential(providerId, authPath)) continue;
				const modelId = pattern
					.slice(slash + 1)
					.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
				if (!modelId) continue;
				addExtensionModel(providerId, {
					id: modelId,
					name: modelId,
					thinkingLevels: [],
					configuredOnly: true,
				});
			}
		}
		const defaultProvider = settings.defaultProvider;
		const defaultModel = settings.defaultModel;
		const defaultSelection =
			typeof defaultProvider === "string" &&
			typeof defaultModel === "string" &&
			grouped
				.get(defaultProvider)
				?.models.some((model) => model.id === defaultModel)
				? { providerId: defaultProvider, modelId: defaultModel }
				: undefined;
		const defaultThinkingLevel = settings.defaultThinkingLevel;
		const modelThinkingLevels: Record<string, PiThinkingLevel> = {};
		if (
			settings.modelThinkingLevels &&
			typeof settings.modelThinkingLevels === "object" &&
			!Array.isArray(settings.modelThinkingLevels)
		) {
			for (const [key, level] of Object.entries(
				settings.modelThinkingLevels as Record<string, unknown>,
			)) {
				const slash = key.indexOf("/");
				if (slash < 1 || !isPiThinkingLevel(level)) continue;
				const provider = grouped.get(key.slice(0, slash));
				const modelId = key.slice(slash + 1);
				if (provider?.models.some((model) => model.id === modelId)) {
					modelThinkingLevels[piModelKey(provider.id, modelId)] = level;
				}
			}
		}
		return {
			providers: [...grouped.values()],
			...(defaultSelection ? { defaultSelection } : {}),
			...(isPiThinkingLevel(defaultThinkingLevel)
				? { defaultThinkingLevel }
				: {}),
			...(Object.keys(modelThinkingLevels).length > 0
				? { modelThinkingLevels }
				: {}),
		};
	} catch {
		// Neither raw config parse errors nor credential values cross IPC.
		throw new Error(
			"Unable to load configured Pi models. Check auth.json, models.json and settings.json.",
		);
	}
}
