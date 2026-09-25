"use client";

import { SearchCombobox } from "@cline/ui";
import { Box, Database, Lightbulb, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { desktopClient } from "@/lib/desktop-client";
import {
	emptyPiModelSelection,
	isPiThinkingLevel,
	PI_MODEL_SELECTION_STORAGE_KEY,
	PI_THINKING_LEVEL_LABELS,
	type PiModelCatalog,
	type PiThinkingLevel,
	piModelKey,
	readPiModelSelection,
	selectedPiModelId,
	selectedPiThinkingLevel,
	selectPiProvider,
} from "@/lib/pi-model-selection";

/** Event the sidecar broadcasts when `~/.pi/agent` configuration changes. */
export const PI_CONFIG_CHANGED_EVENT = "pi_config_changed";

export type PiModelSelectionValue = {
	providerId: string;
	modelId: string;
	thinkingLevel: PiThinkingLevel | "";
};

type PiModelSelectorProps = {
	/**
	 * The thread's current Pi selection. A session opened from history seeds
	 * the picker with the model it was recorded with (like Pi's own /resume)
	 * instead of the desktop's remembered pair; ignored when its provider is
	 * not in the catalog.
	 */
	value?: PiModelSelectionValue;
	/**
	 * Reports the effective selection: after the catalog loads (so a thread
	 * can start from the remembered pair) and after every user change.
	 */
	onSelectionChange?: (value: PiModelSelectionValue) => void;
	/** Pi cannot switch models while it is streaming. */
	disabled?: boolean;
};

/**
 * Pi provider → model → thinking picker. The choice is remembered in browser
 * storage (see `lib/pi-model-selection.ts`) independently of Cline's model
 * settings and reported to the thread through `onSelectionChange`.
 */
export function PiModelSelector({
	value,
	onSelectionChange,
	disabled = false,
}: PiModelSelectorProps) {
	const [catalog, setCatalog] = useState<PiModelCatalog | null>(null);
	const [selection, setSelection] = useState(emptyPiModelSelection);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const [revision, setRevision] = useState(0);
	const onSelectionChangeRef = useRef(onSelectionChange);
	onSelectionChangeRef.current = onSelectionChange;
	const valueRef = useRef(value);
	valueRef.current = value;
	const lastReportedRef = useRef<string | null>(null);
	const lastExternalSelectionRef = useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads models.json on request.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(false);
		void desktopClient
			.invoke<PiModelCatalog>("list_pi_model_catalog")
			.then((next) => {
				if (cancelled) return;
				let stored = readPiModelSelection();
				const seed = valueRef.current;
				const seeded =
					seed?.providerId &&
					seed.modelId &&
					next.providers.some((provider) => provider.id === seed.providerId)
						? seed
						: undefined;
				if (seeded) {
					stored = {
						...stored,
						providerId: seeded.providerId,
						modelByProvider: {
							...stored.modelByProvider,
							[seeded.providerId]: seeded.modelId,
						},
						thinkingByModel: seeded.thinkingLevel
							? {
									...stored.thinkingByModel,
									[piModelKey(seeded.providerId, seeded.modelId)]:
										seeded.thinkingLevel,
								}
							: stored.thinkingByModel,
					};
				} else if (!stored.providerId && next.defaultSelection) {
					const { providerId, modelId } = next.defaultSelection;
					stored = {
						...stored,
						providerId,
						modelByProvider: {
							...stored.modelByProvider,
							[providerId]: modelId,
						},
					};
				}
				const selected = selectPiProvider(
					stored,
					next.providers,
					stored.providerId,
				);
				// A resumed session's model may no longer be in the catalog; keep
				// it selected rather than silently switching the session to the
				// provider's first model.
				setSelection(
					seeded && selected.providerId === seeded.providerId
						? {
								...selected,
								modelByProvider: {
									...selected.modelByProvider,
									[seeded.providerId]: seeded.modelId,
								},
							}
						: selected,
				);
				setCatalog(next);
				setLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				setCatalog(null);
				setError(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [revision]);

	// Ctrl+P and slash-command changes can update the thread from outside this
	// picker. Only respond when the prop changes, not while its own click is
	// waiting for the parent to catch up (which would revert the user's click).
	const externalProviderId = value?.providerId;
	const externalModelId = value?.modelId;
	const externalThinkingLevel = value?.thinkingLevel;
	useEffect(() => {
		if (!loaded) return;
		const key = JSON.stringify([
			externalProviderId,
			externalModelId,
			externalThinkingLevel,
		]);
		if (lastExternalSelectionRef.current === key) return;
		lastExternalSelectionRef.current = key;
		if (!externalProviderId || !externalModelId) return;
		// Same rule as the initial seed: a provider the catalog does not know
		// would leave the picker empty, so the remembered selection stays.
		if (!catalog?.providers.some((entry) => entry.id === externalProviderId))
			return;
		setSelection((current) => ({
			...current,
			providerId: externalProviderId,
			modelByProvider: {
				...current.modelByProvider,
				[externalProviderId]: externalModelId,
			},
			thinkingByModel: externalThinkingLevel
				? {
						...current.thinkingByModel,
						[piModelKey(externalProviderId, externalModelId)]:
							externalThinkingLevel,
					}
				: current.thinkingByModel,
		}));
	}, [
		loaded,
		catalog,
		externalProviderId,
		externalModelId,
		externalThinkingLevel,
	]);

	// Installing or removing Pi packages/extensions changes the available
	// providers and models; reload without requiring a manual refresh.
	useEffect(() => {
		return desktopClient.subscribe(PI_CONFIG_CHANGED_EVENT, () => {
			setRevision((current) => current + 1);
		});
	}, []);

	useEffect(() => {
		if (!loaded) return;
		try {
			window.localStorage.setItem(
				PI_MODEL_SELECTION_STORAGE_KEY,
				JSON.stringify(selection),
			);
			setSaveFailed(false);
		} catch {
			setSaveFailed(true);
		}
	}, [loaded, selection]);

	const providers = catalog?.providers ?? [];
	const provider = providers.find((entry) => entry.id === selection.providerId);
	const activeProviderId = provider?.id;
	const modelId = selectedPiModelId(selection);
	const model = provider?.models.find((entry) => entry.id === modelId);
	const thinkingLevel = selectedPiThinkingLevel(selection, catalog);
	const thinkingLevels = model?.thinkingLevels ?? [];
	// A model that only accepts "off" has nothing to choose.
	const thinkingSelectable =
		!loading &&
		!error &&
		!disabled &&
		thinkingLevels.length > 1 &&
		thinkingLevel !== "";

	useEffect(() => {
		if (!loaded) return;
		const next: PiModelSelectionValue = {
			providerId: activeProviderId ?? "",
			modelId: activeProviderId ? modelId : "",
			thinkingLevel,
		};
		const key = JSON.stringify(next);
		if (lastReportedRef.current === key) return;
		lastReportedRef.current = key;
		onSelectionChangeRef.current?.(next);
	}, [loaded, activeProviderId, modelId, thinkingLevel]);

	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex min-w-0 flex-wrap items-center gap-0.5">
				<Database
					aria-hidden="true"
					className="ml-2 size-4 shrink-0 text-muted-foreground"
				/>
				<SearchCombobox
					ariaLabel="Pi provider"
					className="max-w-48 max-[560px]:max-w-28"
					disabled={loading || error || disabled}
					emptyText="No Pi providers configured"
					loading={loading}
					onValueChange={(providerId) =>
						setSelection((current) =>
							selectPiProvider(current, providers, providerId),
						)
					}
					options={providers.map((entry) => ({
						value: entry.id,
						label: entry.name,
						description: entry.id,
					}))}
					placeholder="Provider"
					placement="top"
					searchPlaceholder="Search providers..."
					value={provider?.id ?? ""}
				/>
				<span aria-hidden="true" className="mx-2 h-4 w-px bg-border" />
				<Box
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<SearchCombobox
					ariaLabel="Pi model"
					className="max-w-52 max-[560px]:max-w-28"
					disabled={
						loading ||
						error ||
						disabled ||
						!provider ||
						provider.models.length === 0
					}
					emptyText="No models for this provider"
					onValueChange={(id) => {
						if (!provider?.models.some((model) => model.id === id)) return;
						setSelection((current) => ({
							...current,
							modelByProvider: {
								...current.modelByProvider,
								[provider.id]: id,
							},
						}));
					}}
					options={(provider?.models ?? []).map((model) => ({
						value: model.id,
						label: model.name,
						description: model.configuredOnly
							? `${model.id} · From Pi settings (extension)`
							: model.id,
					}))}
					placeholder={provider ? "No models configured" : "Model"}
					placement="top"
					searchPlaceholder="Search this provider's models..."
					value={provider ? modelId : ""}
				/>
				<span aria-hidden="true" className="mx-2 h-4 w-px bg-border" />
				<Lightbulb
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<SearchCombobox
					ariaLabel="Pi thinking level"
					className="max-w-36 max-[560px]:max-w-24"
					disabled={!thinkingSelectable}
					emptyText="No thinking levels"
					onValueChange={(level) => {
						if (!provider || !model || !isPiThinkingLevel(level)) return;
						if (!thinkingLevels.includes(level)) return;
						setSelection((current) => ({
							...current,
							thinkingByModel: {
								...current.thinkingByModel,
								[piModelKey(provider.id, model.id)]: level,
							},
						}));
					}}
					options={thinkingLevels.map((level) => ({
						value: level,
						label: PI_THINKING_LEVEL_LABELS[level],
						description: level,
					}))}
					placeholder={
						model && thinkingLevels.length === 0
							? "Thinking unknown"
							: model && thinkingLevels.length === 1
								? "No thinking"
								: "Thinking"
					}
					placement="top"
					searchPlaceholder="Search thinking levels..."
					value={
						thinkingSelectable || (disabled && thinkingLevel)
							? thinkingLevel
							: ""
					}
				/>
				<button
					aria-label="Refresh Pi models"
					className="rounded-md p-1.5 hover:bg-surface-hover disabled:opacity-50"
					disabled={loading}
					onClick={() => setRevision((current) => current + 1)}
					title="Reload your Pi providers, models and enabledModels settings"
					type="button"
				>
					<RefreshCw className="size-3" />
				</button>
			</div>
			{error ? (
				<p role="alert" className="max-w-72 text-xs text-destructive">
					Could not load Pi configuration. Check auth.json, models.json and
					settings.json, then refresh.
				</p>
			) : null}
			{!loading && !error && providers.length === 0 ? (
				<p className="max-w-96 text-xs text-muted-foreground" role="alert">
					No configured Pi models. Configure a provider in Pi, check
					enabledModels in settings.json, then refresh.
				</p>
			) : null}
			{saveFailed ? (
				<output className="max-w-72 text-xs">
					Selection could not be saved locally.
				</output>
			) : null}
		</div>
	);
}
