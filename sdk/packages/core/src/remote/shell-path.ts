/**
 * Login-shell PATH resolution for the desktop sidecar.
 *
 * When the Tauri app is launched from Finder/the Dock on macOS, it inherits
 * launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) instead of the
 * user's shell PATH. The sidecar — and every process it spawns for the agent
 * (bash tool, MCP servers) — then can't find tools like `gh` that live in
 * /opt/homebrew/bin or other shell-profile-added directories, even though
 * the same task works from the CLI in a terminal.
 *
 * At startup we ask the user's login shell for its PATH and merge it into
 * process.env.PATH, so child processes see the same PATH a terminal would.
 *
 * The same launch path also drops the proxy variables a shell profile
 * exports (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY and their lowercase
 * twins). Agent processes such as the Pi CLI then connect to model APIs
 * directly and fail with "fetch failed" from the Dock while the same request
 * works from a terminal, so those variables are imported alongside PATH —
 * only when the launching environment did not already set them.
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { basename, delimiter } from "node:path";

const PATH_MARKER_START = "__CLINE_SIDECAR_PATH_START__";
const PATH_MARKER_END = "__CLINE_SIDECAR_PATH_END__";
const ENV_MARKER_START = "__CLINE_SIDECAR_ENV_START__";
const ENV_MARKER_END = "__CLINE_SIDECAR_ENV_END__";

/**
 * Variables imported from the login shell besides PATH. Limited to proxy
 * configuration: it is what a GUI launch loses that changes whether network
 * requests from spawned agents succeed, and nothing here is a secret worth
 * keeping out of child processes that would inherit it from a terminal anyway.
 */
export const IMPORTED_SHELL_ENV_VARS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
] as const;

/**
 * Kept well under the Tauri shell's 5s endpoint-readiness poll: this
 * resolution overlaps sidecar startup but is awaited before the server
 * starts, so a pathological shell profile must not eat the whole window.
 */
const SHELL_TIMEOUT_MS = 2_000;

/**
 * The command every shell is asked to run. $PATH expansion happens inside
 * POSIX sh — not the user's shell — so shells with different expansion rules
 * (fish would space-join "$PATH") still produce a colon-delimited value; sh
 * reads the PATH environment variable the login shell exported.
 */
const PRINT_PATH_COMMAND = `/bin/sh -c 'printf "%s%s%s" "${PATH_MARKER_START}" "$PATH" "${PATH_MARKER_END}"; printf "%s" "${ENV_MARKER_START}"; for v in ${IMPORTED_SHELL_ENV_VARS.join(" ")}; do if printenv "$v" >/dev/null 2>&1; then printf "%s=%s\\n" "$v" "$(printenv "$v")"; fi; done; printf "%s" "${ENV_MARKER_END}"'`;

/**
 * Escape hatch: set CLINE_SIDECAR_SKIP_SHELL_PATH=1 to leave PATH untouched
 * (e.g. if a broken shell profile makes resolution misbehave).
 */
const SKIP_ENV_VAR = "CLINE_SIDECAR_SKIP_SHELL_PATH";

export function defaultShellFor(platform: NodeJS.Platform): string {
	return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * The user's configured login shell. The account database is authoritative:
 * a GUI-launched process has no parent shell, so $SHELL may be unset there.
 * userInfo() reads getpwuid(), which on macOS goes through DirectoryServices
 * — the same source `dscl . -read /Users/$USER UserShell` reports — and on
 * Linux resolves via NSS (/etc/passwd et al.). $SHELL and the platform
 * default are fallbacks for environments with no passwd entry.
 */
export function loginShellFor(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string {
	try {
		const shell = userInfo().shell?.trim();
		if (shell) {
			return shell;
		}
	} catch {
		// No passwd entry for the current uid (some containers) — fall through.
	}
	return env.SHELL?.trim() || defaultShellFor(platform);
}

export interface ShellInvocation {
	args: string[];
	/**
	 * argv[0] the shell should see. A leading dash is the historical "you
	 * are a login shell" signal, used where -l can't be passed as a flag.
	 */
	argv0?: string;
}

/**
 * How to invoke a shell so it sources its profiles and runs a command.
 * csh/tcsh accept -l only as the sole flag, so they're marked login via the
 * argv[0] dash convention instead (sources ~/.login on top of the always-read
 * ~/.cshrc or ~/.tcshrc); everything else gets login (-l, ~/.zprofile —
 * Homebrew's shellenv) plus interactive (-i, ~/.zshrc — nvm-style version
 * managers) as separate flags.
 */
export function shellInvocation(
	shell: string,
	command: string,
): ShellInvocation {
	const kind = basename(shell);
	if (kind === "csh" || kind === "tcsh") {
		return { args: ["-c", command], argv0: `-${kind}` };
	}
	return { args: ["-i", "-l", "-c", command] };
}

/**
 * Extract the PATH value printed between the sentinel markers, ignoring any
 * noise a shell profile writes to stdout around it.
 */
export function extractMarkedPath(output: string): string | undefined {
	const start = output.indexOf(PATH_MARKER_START);
	if (start === -1) {
		return undefined;
	}
	const end = output.indexOf(PATH_MARKER_END, start);
	if (end === -1) {
		return undefined;
	}
	const value = output.slice(start + PATH_MARKER_START.length, end).trim();
	return value.length > 0 ? value : undefined;
}

/**
 * Extract the `NAME=value` lines printed between the env markers. Only names
 * from IMPORTED_SHELL_ENV_VARS are kept, so a profile that prints its own
 * `X=Y` noise inside the block cannot inject arbitrary variables.
 */
export function extractMarkedEnv(output: string): Record<string, string> {
	const start = output.indexOf(ENV_MARKER_START);
	if (start === -1) {
		return {};
	}
	const end = output.indexOf(ENV_MARKER_END, start);
	if (end === -1) {
		return {};
	}
	const allowed = new Set<string>(IMPORTED_SHELL_ENV_VARS);
	const result: Record<string, string> = {};
	for (const line of output
		.slice(start + ENV_MARKER_START.length, end)
		.split("\n")) {
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const name = line.slice(0, separator);
		const value = line.slice(separator + 1).trim();
		if (allowed.has(name) && value.length > 0) {
			result[name] = value;
		}
	}
	return result;
}

/**
 * Merge the login shell's PATH with the current one: shell entries first (so
 * profile-managed dirs like /opt/homebrew/bin win), then any current entries
 * the shell PATH doesn't already contain (so explicitly-injected dirs from
 * the launching environment aren't lost). Duplicates are dropped.
 */
export function mergePaths(shellPath: string, currentPath: string): string {
	const entries = [
		...shellPath.split(delimiter),
		...currentPath.split(delimiter),
	]
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return Array.from(new Set(entries)).join(delimiter);
}

export interface LoginShellEnvironment {
	path: string;
	/** Subset of IMPORTED_SHELL_ENV_VARS the login shell exports. */
	env: Record<string, string>;
}

/**
 * Run the user's shell with its profiles sourced and capture its PATH.
 * Resolves to undefined on any failure (missing shell, timeout, profile
 * error) — callers should treat that as "keep the current PATH".
 */
export async function resolveLoginShellPath(
	shell: string,
	timeoutMs = SHELL_TIMEOUT_MS,
): Promise<string | undefined> {
	return (await resolveLoginShellEnvironment(shell, timeoutMs))?.path;
}

/**
 * Like resolveLoginShellPath, but also returns the proxy variables the login
 * shell exports. A shell that cannot produce a PATH yields undefined even if
 * it printed variables: PATH is the signal that the profile actually ran.
 */
export function resolveLoginShellEnvironment(
	shell: string,
	timeoutMs = SHELL_TIMEOUT_MS,
	/** Environment the shell starts from; its profiles layer on top. */
	spawnEnv: NodeJS.ProcessEnv = process.env,
): Promise<LoginShellEnvironment | undefined> {
	return new Promise((resolve) => {
		const invocation = shellInvocation(shell, PRINT_PATH_COMMAND);
		const child = spawn(shell, invocation.args, {
			argv0: invocation.argv0,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "ignore"],
			detached: true,
		});

		let output = "";
		let outputBytes = 0;
		const killShell = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		let settled = false;
		const settle = (value: LoginShellEnvironment | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			child.stdout?.destroy();
			killShell();
			resolve(value);
		};

		const timeout = setTimeout(() => {
			try {
				if (child.pid) {
					process.kill(-child.pid, "SIGKILL");
				}
			} catch {
				child.kill("SIGKILL");
			}
			settle(undefined);
		}, timeoutMs);

		child.stdout?.on("data", (data: Buffer) => {
			if (settled) return;
			outputBytes += data.length;
			if (outputBytes > 64 * 1024) {
				settle(undefined);
				return;
			}
			output += data.toString("utf8");
		});
		child.on("error", () => settle(undefined));
		child.on("close", () => {
			const path = extractMarkedPath(output);
			settle(path ? { path, env: extractMarkedEnv(output) } : undefined);
		});
	});
}

/**
 * Resolve the login shell's PATH and merge it into process.env.PATH. The
 * shell comes from the account database (see loginShellFor); if it can't
 * produce a PATH (exotic shell, broken profile), retry once with the
 * platform default shell before giving up.
 *
 * Proxy variables the shell exports (IMPORTED_SHELL_ENV_VARS) are copied
 * into the environment too, but only where the launching environment left
 * them unset: an explicit value from the launcher always wins.
 *
 * No-op on Windows (the GUI PATH comes from the registry there) and when
 * CLINE_SIDECAR_SKIP_SHELL_PATH is set. Failures are reported via the
 * returned status but never block startup. The result never contains the
 * resolved PATH or variable values, only names, so it is safe to log.
 */
export async function ensureLoginShellPath(options?: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Test seam: overrides passwd/$SHELL discovery of the user's shell. */
	userShell?: string;
	/** Test seam: overrides the platform-default fallback shell. */
	fallbackShell?: string;
}): Promise<
	| {
			status: "applied";
			pathEntries: number;
			shell: string;
			/** Names of the proxy variables imported from the shell. */
			importedEnv: string[];
	  }
	| { status: "skipped"; reason: string }
	| { status: "failed"; shell: string }
> {
	const platform = options?.platform ?? process.platform;
	const env = options?.env ?? process.env;

	if (platform === "win32") {
		return { status: "skipped", reason: "windows" };
	}
	if (env[SKIP_ENV_VAR]?.trim()) {
		return { status: "skipped", reason: SKIP_ENV_VAR };
	}

	const userShell = options?.userShell ?? loginShellFor(platform, env);
	const fallbackShell = options?.fallbackShell ?? defaultShellFor(platform);
	const baseTimeoutMs = options?.timeoutMs ?? SHELL_TIMEOUT_MS;
	// The fallback gets half the budget so the combined worst case stays
	// bounded even when both shells hang (see SHELL_TIMEOUT_MS).
	const attempts: Array<[shell: string, timeoutMs: number]> =
		userShell === fallbackShell
			? [[userShell, baseTimeoutMs]]
			: [
					[userShell, baseTimeoutMs],
					[fallbackShell, baseTimeoutMs / 2],
				];

	for (const [shell, timeoutMs] of attempts) {
		const resolved = await resolveLoginShellEnvironment(shell, timeoutMs, env);
		if (!resolved) {
			continue;
		}
		const merged = mergePaths(resolved.path, env.PATH ?? "");
		env.PATH = merged;
		const importedEnv: string[] = [];
		for (const [name, value] of Object.entries(resolved.env)) {
			if (env[name] === undefined) {
				env[name] = value;
				// Bun exposes proxy variables absent at startup as non-enumerable
				// accessors. Assignment alone leaves them out of { ...process.env }
				// when spawning children. Keep the native getter/setter intact.
				const descriptor = Object.getOwnPropertyDescriptor(env, name);
				if (descriptor?.configurable && !descriptor.enumerable) {
					Object.defineProperty(env, name, { enumerable: true });
				}
				importedEnv.push(name);
			}
		}
		return {
			status: "applied",
			pathEntries: merged.split(delimiter).length,
			shell,
			importedEnv,
		};
	}
	return { status: "failed", shell: userShell };
}
