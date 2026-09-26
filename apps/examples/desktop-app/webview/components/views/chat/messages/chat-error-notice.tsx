"use client";

import { Check, CircleAlert, Copy } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatErrorSummary } from "@/lib/chat-error";
import { cn } from "@/lib/utils";

/**
 * A failed turn in the transcript (or the chat's error banner): an icon
 * tile, a plain-language title and hint, then the runtime's own error text,
 * kept verbatim and selectable. Same card shape as `ImportedSessionNotice`,
 * tinted with the theme's error role instead of a solid red block.
 */
export function ChatErrorNotice({
	summary,
	detail,
	action,
	copied = false,
	onCopy,
	className,
	role,
}: {
	summary: ChatErrorSummary;
	detail?: string;
	action?: ReactNode;
	copied?: boolean;
	onCopy?: () => void;
	className?: string;
	role?: "alert";
}) {
	const text = detail?.trim();
	return (
		<div
			className={cn(
				"flex w-full min-w-0 items-start gap-3 rounded-xl border border-error-border/40 bg-error-surface/40 px-4 py-3",
				className,
			)}
			data-slot="chat-error-notice"
			role={role}
		>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-error-surface text-error-text">
				<CircleAlert className="size-4" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-h-8 items-center justify-between gap-2">
					<p className="text-sm font-semibold text-foreground">
						{summary.title}
					</p>
					{onCopy && text ? (
						<button
							aria-label={copied ? "Copied error" : "Copy error"}
							className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={onCopy}
							title={copied ? "Copied" : "Copy error"}
							type="button"
						>
							{copied ? (
								<Check className="size-3.5" />
							) : (
								<Copy className="size-3.5" />
							)}
						</button>
					) : null}
				</div>
				{summary.hint ? (
					<p className="-mt-1 text-[13px] leading-5 text-muted-foreground">
						{summary.hint}
					</p>
				) : null}
				{text ? (
					summary.detailStyle === "code" ? (
						<pre className="cline-chat-selectable mt-1 max-h-40 overflow-auto rounded-md bg-background/60 px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-break-word text-muted-foreground">
							{text}
						</pre>
					) : (
						<p className="cline-chat-selectable -mt-1 text-[13px] leading-5 whitespace-pre-wrap wrap-break-word text-muted-foreground">
							{text}
						</p>
					)
				) : null}
				{action ? <div className="mt-1.5 flex gap-2">{action}</div> : null}
			</div>
		</div>
	);
}
