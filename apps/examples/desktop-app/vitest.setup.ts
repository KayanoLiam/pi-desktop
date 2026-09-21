import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read or write the developer's real Pi configuration
// (`~/.pi/agent`): every context-level test can now reach the Pi session
// store through command routing. Point Pi at an empty temp dir unless a test
// (or the command line) chose one explicitly. `PI_DESKTOP_PI_BIN` is left to
// the command line so a forgotten override still fails loudly rather than
// spawning the real `pi`.
if (!process.env.PI_CODING_AGENT_DIR?.trim()) {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(
		join(tmpdir(), "pi-desktop-test-agent-"),
	);
}
