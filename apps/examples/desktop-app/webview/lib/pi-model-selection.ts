// Pi IDs are opaque. Do not apply Cline's provider aliases or collapse models
// across providers: (providerId, modelId) is the model's identity.

/** Pi's thinking levels in ascending order, matching the Pi CLI's `/thinking`. */
export const PI_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** Pi's startup thinking level when settings.json does not set one. */
export const PI_DEFAULT_THINKING_LEVEL: PiThinkingLevel = "medium";

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return (
		typeof value === "string" &&
		(PI_THINKING_LEVELS as readonly string[]).includes(value)
	);
}

export interface PiCatalogModel {
	id: string;
	name: string;
	/**
	 * Thinking levels this model accepts, in Pi's order. Non-reasoning models
	 * only accept "off"; empty when the capabilities are unknown (an extension
	 * provider the installed Pi could not be asked about).
	 */
	thinkingLevels: PiThinkingLevel[];
	/** Registered by an installed Pi extension rather than the bundled SDK. */
	configuredOnly?: boolean;
}

export interface PiCatalogProvider {
	id: string;
	name: string;
	models: PiCatalogModel[];
}

export interface PiModelCatalog {
	providers: PiCatalogProvider[];
	defaultSelection?: { providerId: string; modelId: string };
	/** `defaultThinkingLevel` from Pi's settings.json. */
	defaultThinkingLevel?: PiThinkingLevel;
	/** `modelThinkingLevels` from Pi's settings.json, keyed by "provider/model". */
	modelThinkingLevels?: Record<string, PiThinkingLevel>;
}

export interface PiModelSelection {
	version: 1;
	providerId: string;
	modelByProvider: Record<string, string>;
	/** Thinking level chosen in the desktop, keyed by "provider/model". */
	thinkingByModel: Record<string, PiThinkingLevel>;
}

export const PI_MODEL_SELECTION_STORAGE_KEY = "pi:desktop:model-selection:v1";

export function piModelKey(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

/** Before a Pi session starts, cycle the saved scope in Pi's selection order. */
export function orderedPiCyclingModels<
	T extends { provider: string; id: string },
>(models: readonly T[], enabled: string[] | null): T[] {
	if (!enabled?.length) return [...models];
	const byId = new Map(
		models.map((model) => [piModelKey(model.provider, model.id), model]),
	);
	return enabled.flatMap((key) => {
		const model = byId.get(key);
		return model ? [model] : [];
	});
}

export function emptyPiModelSelection(): PiModelSelection {
	return {
		version: 1,
		providerId: "",
		modelByProvider: {},
		thinkingByModel: {},
	};
}

export function parsePiModelSelection(raw: string | null): PiModelSelection {
	try {
		const value: unknown = JSON.parse(raw ?? "null");
		if (!value || typeof value !== "object") return emptyPiModelSelection();
		const data = value as Partial<PiModelSelection>;
		if (
			data.version !== 1 ||
			typeof data.providerId !== "string" ||
			!data.modelByProvider ||
			typeof data.modelByProvider !== "object" ||
			Array.isArray(data.modelByProvider)
		) {
			return emptyPiModelSelection();
		}
		const thinkingByModel =
			data.thinkingByModel &&
			typeof data.thinkingByModel === "object" &&
			!Array.isArray(data.thinkingByModel)
				? Object.fromEntries(
						Object.entries(data.thinkingByModel).filter(
							(entry): entry is [string, PiThinkingLevel] =>
								isPiThinkingLevel(entry[1]),
						),
					)
				: {};
		return {
			version: 1,
			providerId: data.providerId,
			modelByProvider: Object.fromEntries(
				Object.entries(data.modelByProvider).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			),
			thinkingByModel,
		};
	} catch {
		return emptyPiModelSelection();
	}
}

export function readPiModelSelection(): PiModelSelection {
	try {
		return parsePiModelSelection(
			window.localStorage.getItem(PI_MODEL_SELECTION_STORAGE_KEY),
		);
	} catch {
		return emptyPiModelSelection();
	}
}

export function selectedPiModelId(selection: PiModelSelection): string {
	return Object.hasOwn(selection.modelByProvider, selection.providerId)
		? selection.modelByProvider[selection.providerId]
		: "";
}

/** Atomically switch both IDs, restoring only this provider's remembered model. */
export function selectPiProvider(
	selection: PiModelSelection,
	providers: PiCatalogProvider[],
	providerId: string,
): PiModelSelection {
	const provider = providers.find((entry) => entry.id === providerId);
	if (!provider) return { ...selection, providerId: "" };
	const remembered = Object.hasOwn(selection.modelByProvider, providerId)
		? selection.modelByProvider[providerId]
		: "";
	const modelId = provider.models.some((model) => model.id === remembered)
		? remembered
		: (provider.models[0]?.id ?? "");
	return {
		...selection,
		providerId,
		modelByProvider: { ...selection.modelByProvider, [providerId]: modelId },
	};
}

/**
 * Same clamping Pi applies at startup: keep a supported level, otherwise the
 * nearest higher supported level, otherwise the nearest lower one.
 */
export function clampPiThinkingLevel(
	levels: readonly PiThinkingLevel[],
	level: PiThinkingLevel,
): PiThinkingLevel {
	if (levels.includes(level)) return level;
	const index = PI_THINKING_LEVELS.indexOf(level);
	for (let i = index + 1; i < PI_THINKING_LEVELS.length; i++) {
		if (levels.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i];
	}
	for (let i = index - 1; i >= 0; i--) {
		if (levels.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i];
	}
	return levels[0] ?? "off";
}

/**
 * The thinking level to show for the selected model: the desktop's remembered
 * choice, else Pi's per-model startup level, else Pi's default level, clamped
 * to what the model supports. Empty when no model is selected.
 */
export function selectedPiThinkingLevel(
	selection: PiModelSelection,
	catalog: PiModelCatalog | null,
): PiThinkingLevel | "" {
	const modelId = selectedPiModelId(selection);
	const model = catalog?.providers
		.find((provider) => provider.id === selection.providerId)
		?.models.find((entry) => entry.id === modelId);
	if (!model) return "";
	const key = piModelKey(selection.providerId, model.id);
	// Unknown capabilities: never offer a level Pi might reject.
	const levels = model.thinkingLevels ?? [];
	if (levels.length === 0) return "";
	const requested =
		selection.thinkingByModel[key] ??
		catalog?.modelThinkingLevels?.[key] ??
		catalog?.defaultThinkingLevel ??
		PI_DEFAULT_THINKING_LEVEL;
	return clampPiThinkingLevel(levels as PiThinkingLevel[], requested);
}
