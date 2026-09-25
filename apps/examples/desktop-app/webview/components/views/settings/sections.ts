/**
 * Settings navigation constants, split from settings-view.tsx so the sidebar
 * (always mounted) can reference section names without pulling the entire
 * settings module graph — providers, MCP, marketplace, schedules — into the
 * initial chat bundle. The heavy views load on demand via next/dynamic.
 */

const ALL_SETTINGS_SECTIONS = [
	"General",
	"API Providers",
	"Voice",
	"Channels",
	"Schedules",
	"Import",
	"Remote",
] as const;

// The Extensions group shows the installed Pi extensions. Pi packages can be
// browsed via the external link on that page; the old in-app marketplace is
// not a Pi extension source.
const ALL_CUSTOMIZATION_SECTIONS = ["Customize"] as const;

export const CUSTOMIZATION_SECTION_LABELS: Record<
	(typeof ALL_CUSTOMIZATION_SECTIONS)[number],
	string
> = {
	Customize: "Installed",
};

export type SettingsSection =
	| (typeof ALL_SETTINGS_SECTIONS)[number]
	| (typeof ALL_CUSTOMIZATION_SECTIONS)[number];

// Temporarily hidden from the sidebar. The views and routes still exist —
// remove a section from this set to surface it again.
const HIDDEN_SECTIONS: ReadonlySet<SettingsSection> = new Set(["Channels"]);

export const SETTINGS_SECTIONS = ALL_SETTINGS_SECTIONS.filter(
	(section) => !HIDDEN_SECTIONS.has(section),
);

export const CUSTOMIZATION_SECTIONS = ALL_CUSTOMIZATION_SECTIONS.filter(
	(section) => !HIDDEN_SECTIONS.has(section),
);
