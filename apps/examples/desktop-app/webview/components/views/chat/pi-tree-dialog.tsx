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
import {
	flattenPiTree,
	type PiTreeNavigation,
	type PiTreeRow,
	type PiTreeSnapshot,
} from "@/lib/pi-tree";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sessionId?: string;
	onBeforeNavigate?: (row: PiTreeRow) => boolean;
	onNavigated: (sessionId: string, result: PiTreeNavigation) => void;
};

/** Browse the full Pi tree and navigate the existing session, without a model turn. */
export function PiTreeDialog({
	open,
	onOpenChange,
	sessionId,
	onBeforeNavigate,
	onNavigated,
}: Props) {
	const [snapshot, setSnapshot] = useState<PiTreeSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [navigating, setNavigating] = useState(false);
	const [error, setError] = useState("");
	const rows = useMemo(() => flattenPiTree(snapshot?.tree ?? []), [snapshot]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setSnapshot(null);
		setError("");
		if (!sessionId) return;
		setLoading(true);
		void desktopClient
			.invoke<PiTreeSnapshot>("get_pi_tree", { sessionId })
			.then((tree) => {
				if (!cancelled) setSnapshot(tree);
			})
			.catch((cause) => {
				if (!cancelled)
					setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionId]);

	async function navigate(row: PiTreeRow) {
		if (!sessionId || navigating || onBeforeNavigate?.(row) === false) return;
		setNavigating(true);
		setError("");
		try {
			const result = await desktopClient.invoke<PiTreeNavigation>(
				"navigate_pi_tree",
				{ sessionId, targetId: row.id },
			);
			onNavigated(sessionId, result);
			onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setNavigating(false);
		}
	}

	return (
		<Dialog
			onOpenChange={(next) => !navigating && onOpenChange(next)}
			open={open}
		>
			<DialogContent className="flex max-h-[min(85vh,760px)] flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Session Tree</DialogTitle>
					<DialogDescription>
						Choose an entry to continue from that point. Selecting a user
						message moves to its parent and restores its text in the composer.
						Other branches remain in Pi's session file.
					</DialogDescription>
				</DialogHeader>
				{!sessionId ? (
					<p className="text-sm text-muted-foreground">
						Start a Pi session to browse its tree.
					</p>
				) : loading ? (
					<p className="text-sm text-muted-foreground">Loading session tree…</p>
				) : snapshot ? (
					<>
						{rows.length > 0 ? (
							<div
								aria-label="Pi session tree"
								className="min-h-0 overflow-y-auto rounded-md border p-2"
								role="tree"
							>
								{rows.map((row) => (
									<button
										aria-current={
											snapshot.leafId === row.id ? "location" : undefined
										}
										aria-label={`${row.title}: ${row.preview || row.id}${snapshot.leafId === row.id ? ", current" : ""}`}
										className="flex w-full min-w-0 items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
										disabled={navigating}
										key={row.id}
										onClick={() => void navigate(row)}
										role="treeitem"
										type="button"
									>
										<span
											aria-hidden="true"
											className="shrink-0 text-muted-foreground"
											style={{
												paddingLeft: `${Math.min(row.depth, 15) * 14}px`,
											}}
										>
											{snapshot.leafId === row.id ? "●" : "└"}
										</span>
										<span className="min-w-0">
											<strong className="font-medium">{row.title}</strong>
											{row.reedit ? (
												<span className="ml-2 text-xs text-muted-foreground">
													Re-edit
												</span>
											) : null}
											{row.preview ? (
												<span className="ml-2 break-words text-muted-foreground">
													{row.preview}
												</span>
											) : null}
										</span>
									</button>
								))}
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								This session has no entries yet.
							</p>
						)}
						<p className="text-xs text-muted-foreground">
							A branch selection is kept in memory until the next message is
							sent; closing the Pi process before then restores the file's last
							branch. Images in older user messages cannot be restored to the
							composer.
						</p>
					</>
				) : null}
				{error ? (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						disabled={navigating}
						onClick={() => onOpenChange(false)}
						type="button"
						variant="outline"
					>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
