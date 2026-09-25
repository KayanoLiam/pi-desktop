"use client";

import { RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopClient } from "@/lib/desktop-client";
import type {
	PiExtensionInventory,
	PiExtensionItem,
} from "../../../../sidecar/pi/pi-extensions";
import { PageEmptyState } from "../page-layout";

function extensionLabel(item: PiExtensionItem): string {
	if (!item.packageSource) return item.name;
	const source = item.packageSource;
	const packageName = source.startsWith("npm:")
		? source.slice(4).replace(/@[^/@]+$/, "")
		: source
				.replace(/@[^/]*$/, "")
				.split("/")
				.at(-1) || source;
	return `${packageName} / ${item.name}`;
}

const GROUPS: {
	kind: PiExtensionItem["kind"];
	title: string;
	detail: string;
}[] = [
	{
		kind: "npm",
		title: "npm packages",
		detail: "Managed by Pi's package manager",
	},
	{
		kind: "git",
		title: "Git packages",
		detail: "Managed by Pi's package manager",
	},
	{
		kind: "local",
		title: "Local extensions",
		detail: "Files and local packages",
	},
];

export function PiExtensionsView() {
	const [inventory, setInventory] = useState<PiExtensionInventory | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [uninstallTarget, setUninstallTarget] =
		useState<PiExtensionItem | null>(null);
	const requestId = useRef(0);
	const pendingRef = useRef(false);

	const refresh = useCallback(async () => {
		if (pendingRef.current) return;
		const current = ++requestId.current;
		setLoading(true);
		try {
			const result =
				await desktopClient.invoke<PiExtensionInventory>("list_pi_extensions");
			if (requestId.current !== current) return;
			setInventory(result);
			setError(null);
		} catch (cause) {
			if (requestId.current !== current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestId.current === current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const unsubscribe = desktopClient.subscribe("pi_config_changed", () => {
			void refresh();
		});
		return () => {
			++requestId.current;
			unsubscribe();
		};
	}, [refresh]);

	const change = async (
		item: PiExtensionItem,
		action: "toggle" | "uninstall",
	) => {
		if (pendingRef.current) return;
		pendingRef.current = true;
		// Ignore an older inventory read that might finish after this mutation.
		const current = ++requestId.current;
		setLoading(false);
		setPendingId(item.id);
		setError(null);
		try {
			const result = await desktopClient.invoke<PiExtensionInventory>(
				action === "toggle"
					? "set_pi_extension_enabled"
					: "uninstall_pi_extension_package",
				action === "toggle"
					? { id: item.id, enabled: !item.enabled }
					: { id: item.id },
			);
			if (requestId.current === current) setInventory(result);
		} catch (cause) {
			if (requestId.current === current) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		} finally {
			pendingRef.current = false;
			if (requestId.current === current) setPendingId(null);
		}
	};

	const groups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return GROUPS.map((group) => ({
			...group,
			items: (inventory?.extensions ?? []).filter(
				(item) =>
					item.kind === group.kind &&
					(!needle ||
						[item.name, item.path, item.source, item.scope].some((value) =>
							value.toLowerCase().includes(needle),
						)),
			),
		})).filter((group) => group.items.length);
	}, [inventory, query]);

	return (
		<section aria-label="Pi extensions" className="space-y-5">
			<div className="space-y-2 text-sm text-muted-foreground">
				<p>
					Pi extensions configured for this desktop's local workspace
					{inventory ? ":" : "."}
					{inventory ? (
						<span className="block break-all font-mono text-xs">
							{inventory.workspaceRoot}
						</span>
					) : null}
				</p>
				<p>
					Settings for the global Pi agent and this project's .pi directory are
					shown below. Enabled means configured to load in a new Pi process, not
					necessarily loaded in an already-running external Pi process. Changes
					restart idle Desktop Pi sessions; finish any unsaved /tree branch edit
					first.
				</p>
			</div>
			<div className="flex items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<Search
						aria-hidden="true"
						className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						aria-label="Search Pi extensions"
						className="pl-9"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search Pi extensions"
						value={query}
					/>
				</div>
				<Button
					aria-label="Refresh Pi extensions"
					disabled={loading || !!pendingId}
					onClick={() => void refresh()}
					size="icon"
					type="button"
					variant="outline"
				>
					<RefreshCw className="size-4" />
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			) : null}
			{loading && !inventory ? (
				<output className="text-sm text-muted-foreground">
					Loading Pi extensions…
				</output>
			) : null}
			{inventory && groups.length === 0 ? (
				<PageEmptyState>
					{query
						? "No Pi extensions match your search."
						: "No Pi extensions found in the current workspace or global Pi configuration."}
				</PageEmptyState>
			) : null}
			{groups.map((group) => (
				<div className="space-y-3" key={group.kind}>
					<div className="flex items-baseline gap-2">
						<h2 className="text-base font-semibold">
							{group.title}{" "}
							<span className="text-muted-foreground">
								{group.items.length}
							</span>
						</h2>
						<span className="text-xs text-muted-foreground">
							{group.detail}
						</span>
					</div>
					{group.items.map((item) => (
						<div
							className="rounded-lg border border-border bg-card p-4"
							key={item.id}
						>
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="min-w-0 flex-1 space-y-2">
									<div className="flex flex-wrap items-center gap-2">
										<strong className="break-all text-sm">
											{extensionLabel(item)}
										</strong>
										<Badge variant="outline">
											{item.scope === "project" ? "Project" : "Global"}
										</Badge>
										<Badge variant={item.enabled ? "secondary" : "muted"}>
											{item.enabled ? "Enabled" : "Disabled"}
										</Badge>
									</div>
									<p className="break-all text-xs text-muted-foreground">
										Source: <span className="font-mono">{item.source}</span>
									</p>
									<p className="break-all text-xs text-muted-foreground">
										Path: <span className="font-mono">{item.path}</span>
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<Button
										aria-label={`${item.enabled ? "Disable" : "Enable"} ${extensionLabel(item)}`}
										disabled={!!pendingId || loading}
										onClick={() => void change(item, "toggle")}
										size="sm"
										type="button"
										variant="outline"
									>
										{item.enabled ? "Disable" : "Enable"}
									</Button>
									{item.packageSource ? (
										<Button
											aria-label={`Uninstall package for ${extensionLabel(item)}`}
											disabled={!!pendingId || loading}
											onClick={() => setUninstallTarget(item)}
											size="sm"
											type="button"
											variant="outline"
										>
											<Trash2 className="size-4" /> Uninstall
										</Button>
									) : null}
								</div>
							</div>
						</div>
					))}
				</div>
			))}
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) setUninstallTarget(null);
				}}
				open={!!uninstallTarget}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Uninstall Pi package?</AlertDialogTitle>
						<AlertDialogDescription>
							Remove {uninstallTarget?.packageSource} from{" "}
							{uninstallTarget?.scope === "project" ? "project" : "global"} Pi
							configuration. This also removes every other extension, skill,
							prompt, or theme supplied by this package. Local files are not
							deleted.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction asChild>
							<Button
								onClick={() => {
									if (uninstallTarget)
										void change(uninstallTarget, "uninstall");
								}}
								type="button"
								variant="destructive"
							>
								Uninstall package
							</Button>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
