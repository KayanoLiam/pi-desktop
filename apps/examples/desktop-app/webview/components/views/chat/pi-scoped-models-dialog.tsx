"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { desktopClient } from "@/lib/desktop-client";

export type PiModelScope = {
	models: Array<{ provider: string; id: string; name: string }>;
	/** Null means every model is available for cycling. */
	enabled: string[] | null;
	hasSession: boolean;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sessionId?: string;
	workspaceRoot?: string;
};

/** The desktop equivalent of Pi's session-only /scoped-models selector. */
export function PiScopedModelsDialog({
	open,
	onOpenChange,
	sessionId,
	workspaceRoot,
}: Props) {
	const [scope, setScope] = useState<PiModelScope | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setScope(null);
		setSelected(new Set());
		setError("");
		setQuery("");
		void desktopClient
			.invoke<PiModelScope>("get_pi_model_scope", {
				sessionId,
				workspaceRoot,
			})
			.then((next) => {
				if (cancelled) return;
				setScope(next);
				setSelected(
					new Set(
						next.enabled ??
							next.models.map((model) => `${model.provider}/${model.id}`),
					),
				);
			})
			.catch((cause) => {
				if (!cancelled)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionId, workspaceRoot]);

	const filtered = useMemo(() => {
		const text = query.trim().toLowerCase();
		return (scope?.models ?? []).filter((model) =>
			`${model.provider}/${model.id} ${model.name}`
				.toLowerCase()
				.includes(text),
		);
	}, [scope, query]);

	async function apply(save: boolean) {
		if (!scope || saving) return;
		setSaving(true);
		setError("");
		try {
			await desktopClient.invoke("set_pi_model_scope", {
				sessionId,
				workspaceRoot,
				enabled: [...selected],
				save,
			});
			onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog onOpenChange={(next) => !saving && onOpenChange(next)} open={open}>
			<DialogContent className="flex max-h-[min(85vh,760px)] flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Model Configuration</DialogTitle>
					<DialogDescription>
						Choose which Pi models are available for cycling. The current model
						is not changed.
					</DialogDescription>
				</DialogHeader>
				{scope ? (
					<>
						<div className="flex items-center gap-2">
							<input
								aria-label="Search Pi models"
								className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search models or providers"
								value={query}
							/>
							<Button
								onClick={() =>
									setSelected(
										new Set(
											scope.models.map(
												(model) => `${model.provider}/${model.id}`,
											),
										),
									)
								}
								size="sm"
								type="button"
								variant="outline"
							>
								All
							</Button>
							<Button
								onClick={() => setSelected(new Set())}
								size="sm"
								type="button"
								variant="outline"
							>
								Clear
							</Button>
						</div>
						<fieldset
							aria-label="Available Pi models"
							className="min-h-0 flex-1 overflow-y-auto rounded-md border p-2"
						>
							{filtered.map((model) => {
								const key = `${model.provider}/${model.id}`;
								return (
									<label
										className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-muted"
										key={key}
									>
										<input
											checked={selected.has(key)}
											onChange={() =>
												setSelected((current) => {
													const next = new Set(current);
													if (next.has(key)) next.delete(key);
													else next.add(key);
													return next;
												})
											}
											type="checkbox"
										/>
										<span className="min-w-0 truncate text-sm">
											{model.name}{" "}
											<span className="text-muted-foreground">
												[{model.provider}/{model.id}]
											</span>
										</span>
									</label>
								);
							})}
							{filtered.length === 0 ? (
								<p className="p-3 text-sm text-muted-foreground">
									No matching models.
								</p>
							) : null}
						</fieldset>
						<p className="text-xs text-muted-foreground">
							{selected.size === 0 || selected.size === scope.models.length
								? "All models will be available for cycling."
								: `${selected.size}/${scope.models.length} models enabled for cycling.`}
						</p>
					</>
				) : !error ? (
					<p className="text-sm text-muted-foreground">
						Loading available Pi models…
					</p>
				) : null}
				{error ? (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="outline"
					>
						Cancel
					</Button>
					{scope?.hasSession ? (
						<Button
							disabled={!scope.models.length || saving}
							onClick={() => void apply(false)}
							type="button"
							variant="outline"
						>
							Apply to session
						</Button>
					) : null}
					<Button
						disabled={!scope?.models.length || saving}
						onClick={() => void apply(true)}
						type="button"
					>
						{saving ? "Saving…" : "Save to Pi settings"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
