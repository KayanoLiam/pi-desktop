import type { ChatMessage } from "@/lib/chat-schema";

export type PiTreeNode = {
	entry: {
		id: string;
		parentId: string | null;
		type: string;
		message?: { role?: string; content?: unknown; toolName?: string };
		content?: unknown;
		summary?: string;
		timestamp?: string;
	};
	children: PiTreeNode[];
	label?: string;
};

export type PiTreeSnapshot = { tree: PiTreeNode[]; leafId: string | null };
export type PiTreeNavigation = {
	leafId: string | null;
	editorText?: string;
	messages: ChatMessage[];
};

export type PiTreeRow = {
	id: string;
	depth: number;
	title: string;
	preview: string;
	reedit: boolean;
	hasImages: boolean;
};

function contentPreview(value: unknown): string {
	const text =
		typeof value === "string"
			? value
			: Array.isArray(value)
				? value
						.filter((block) => block && block.type === "text")
						.map((block) => String(block.text ?? ""))
						.join(" ")
				: "";
	return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

/** Preserve Pi's tree order while keeping deeply branched sessions safe to render. */
export function flattenPiTree(tree: PiTreeNode[]): PiTreeRow[] {
	const rows: PiTreeRow[] = [];
	const pending = tree.map((node) => ({ node, depth: 0 })).reverse();
	while (pending.length) {
		const item = pending.pop();
		if (!item) continue;
		const { node, depth } = item;
		const { entry } = node;
		const role = entry.message?.role;
		const reedit =
			(entry.type === "message" && role === "user") ||
			entry.type === "custom_message";
		const content =
			entry.type === "message" ? entry.message?.content : entry.content;
		rows.push({
			id: entry.id,
			depth,
			title:
				node.label ||
				(entry.type === "message"
					? role === "toolResult"
						? `Tool result${entry.message?.toolName ? `: ${entry.message.toolName}` : ""}`
						: role === "user"
							? "You"
							: role === "assistant"
								? "Assistant"
								: "Message"
					: entry.type === "branch_summary"
						? "Branch summary"
						: entry.type.replace(/_/g, " ")),
			preview: contentPreview(content) || contentPreview(entry.summary),
			reedit,
			hasImages:
				Array.isArray(content) &&
				content.some((block) => block && block.type === "image"),
		});
		for (let index = node.children.length - 1; index >= 0; index--) {
			pending.push({ node: node.children[index], depth: depth + 1 });
		}
	}
	return rows;
}
