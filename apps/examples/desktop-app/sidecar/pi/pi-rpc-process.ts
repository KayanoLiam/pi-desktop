import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";

/**
 * Minimal client for `pi --mode rpc` (stdin/stdout JSONL).
 *
 * Framing follows Pi's docs/rpc.md: records are split on `\n` only, a trailing
 * `\r` is stripped, and Node `readline` is deliberately not used because it
 * also splits on U+2028/U+2029, which are valid inside JSON strings.
 *
 * The process is the user's installed Pi CLI (`PI_DESKTOP_PI_BIN` or `pi` on
 * `PATH`), so it loads the user's real extensions, packages and credentials.
 * Nothing here is a sandbox for that extension code.
 */

export type PiRpcEvent = Record<string, unknown> & { type: string };

export type PiRpcSuccess<T = unknown> = {
	success: true;
	data: T;
};

export type PiRpcFailure = { success: false; error: string };

export type PiRpcResult<T = unknown> = PiRpcSuccess<T> | PiRpcFailure;

export type PiRpcExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Last few KiB of stderr, for diagnostics. */
	stderr: string;
};

export type PiRpcProcessOptions = {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Overrides `PI_DESKTOP_PI_BIN` / `pi`; tests point this at a fake script. */
	binary?: string;
};

const STDERR_TAIL_LIMIT = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function resolvePiBinary(explicit?: string): string {
	return explicit?.trim() || process.env.PI_DESKTOP_PI_BIN?.trim() || "pi";
}

export class PiRpcProcessExitedError extends Error {
	readonly exit: PiRpcExit;
	constructor(message: string, exit: PiRpcExit) {
		super(message);
		this.name = "PiRpcProcessExitedError";
		this.exit = exit;
	}
}

type PendingRequest = {
	command: string;
	resolve: (value: PiRpcResult) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
};

type Listener = (event: PiRpcEvent) => void;

export class PiRpcProcess {
	readonly pid: number | undefined;
	readonly exited: Promise<PiRpcExit>;
	private readonly child: ChildProcess;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<Listener>();
	private readonly exitListeners = new Set<(exit: PiRpcExit) => void>();
	private requestCounter = 0;
	private stderrTail = "";
	private exit: PiRpcExit | null = null;
	private spawnError: Error | null = null;

	constructor(options: PiRpcProcessOptions) {
		const binary = resolvePiBinary(options.binary);
		this.child = spawn(binary, options.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.pid = this.child.pid;
		this.exited = new Promise<PiRpcExit>((resolve) => {
			let settled = false;
			const settle = (exit: PiRpcExit) => {
				if (settled) return;
				settled = true;
				this.exit = exit;
				this.rejectPending(
					new PiRpcProcessExitedError(
						describeExit(binary, exit, this.spawnError),
						exit,
					),
				);
				for (const listener of this.exitListeners) {
					try {
						listener(exit);
					} catch {
						// Listener failures must not break exit bookkeeping.
					}
				}
				resolve(exit);
			};
			this.child.once("error", (error) => {
				this.spawnError = error;
				// `exit` is not emitted for spawn failures (ENOENT); settle here.
				settle({ code: null, signal: null, stderr: this.stderrTail });
			});
			this.child.once("exit", (code, signal) => {
				settle({ code, signal, stderr: this.stderrTail });
			});
		});
		this.child.stdin?.on("error", () => {
			// EPIPE after the process died; the exit path reports the failure.
		});
		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
		});
		if (this.child.stdout) {
			attachJsonlLineReader(this.child.stdout, (line) => this.handleLine(line));
		}
	}

	get alive(): boolean {
		return this.exit === null && !this.spawnError;
	}

	get exitInfo(): PiRpcExit | null {
		return this.exit;
	}

	get stderr(): string {
		return this.stderrTail;
	}

	onEvent(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onExit(listener: (exit: PiRpcExit) => void): () => void {
		if (this.exit) {
			listener(this.exit);
			return () => {};
		}
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/**
	 * Send a command and wait for its correlated response. `timeoutMs: null`
	 * waits indefinitely (for `abort`, which returns only once Pi is idle).
	 */
	request<T = unknown>(
		command: RpcCommand,
		options: { timeoutMs?: number | null } = {},
	): Promise<PiRpcResult<T>> {
		if (!this.alive) {
			return Promise.reject(
				new PiRpcProcessExitedError(
					describeExit(
						"pi",
						this.exit ?? { code: null, signal: null, stderr: this.stderrTail },
						this.spawnError,
					),
					this.exit ?? { code: null, signal: null, stderr: this.stderrTail },
				),
			);
		}
		const id = `desktop_${++this.requestCounter}`;
		const timeoutMs =
			options.timeoutMs === undefined
				? DEFAULT_REQUEST_TIMEOUT_MS
				: options.timeoutMs;
		return new Promise<PiRpcResult<T>>((resolve, reject) => {
			const pending: PendingRequest = {
				command: command.type,
				resolve: (value) => resolve(value as PiRpcResult<T>),
				reject,
			};
			if (timeoutMs !== null) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(
						new Error(
							`Pi did not answer ${command.type} within ${timeoutMs}ms`,
						),
					);
				}, timeoutMs);
			}
			this.pending.set(id, pending);
			if (!this.writeLine({ ...command, id })) {
				this.pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				reject(new Error(`Pi stdin is closed; cannot send ${command.type}`));
			}
		});
	}

	/** Answer a dialog-style `extension_ui_request`. */
	respondExtensionUi(response: RpcExtensionUIResponse): boolean {
		return this.writeLine(response);
	}

	/** Ask Pi to exit by closing stdin; escalate to SIGTERM/SIGKILL on a timer. */
	async kill(graceMs = 2_000): Promise<PiRpcExit> {
		if (this.exit) return this.exit;
		try {
			this.child.stdin?.end();
		} catch {
			// Already closed.
		}
		const exited = await Promise.race([
			this.exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), graceMs)),
		]);
		if (exited) return exited;
		try {
			this.child.kill("SIGTERM");
		} catch {
			// Process may already be gone.
		}
		const terminated = await Promise.race([
			this.exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), graceMs)),
		]);
		if (terminated) return terminated;
		try {
			this.child.kill("SIGKILL");
		} catch {
			// Process may already be gone.
		}
		return await this.exited;
	}

	private writeLine(value: unknown): boolean {
		const stdin = this.child.stdin;
		if (!stdin || stdin.destroyed || !this.alive) return false;
		try {
			stdin.write(`${JSON.stringify(value)}\n`);
			return true;
		} catch {
			return false;
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Pi extensions may print to stdout; ignore non-JSON lines.
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const message = parsed as Record<string, unknown>;
		if (message.type === "response") {
			const response = message as unknown as RpcResponse;
			const id = typeof response.id === "string" ? response.id : "";
			// Pi echoes the request id. An id-less response (older builds, an
			// extension answering on Pi's behalf) settles the oldest pending
			// request for the same command instead of hanging it.
			const matchedId =
				id ||
				[...this.pending.entries()].find(
					([, entry]) => entry.command === response.command,
				)?.[0] ||
				"";
			const pending = matchedId ? this.pending.get(matchedId) : undefined;
			if (!pending) return;
			this.pending.delete(matchedId);
			if (pending.timer) clearTimeout(pending.timer);
			if (response.success) {
				pending.resolve({
					success: true,
					data: (response as { data?: unknown }).data,
				});
			} else {
				pending.resolve({
					success: false,
					error:
						typeof response.error === "string"
							? response.error
							: `Pi rejected ${pending.command}`,
				});
			}
			return;
		}
		if (typeof message.type !== "string") return;
		for (const listener of this.listeners) {
			try {
				listener(message as PiRpcEvent);
			} catch {
				// One listener failing must not stop event delivery.
			}
		}
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}

export function isPiExtensionUiRequest(
	event: PiRpcEvent,
): event is PiRpcEvent & RpcExtensionUIRequest {
	return (
		event.type === "extension_ui_request" &&
		typeof event.id === "string" &&
		typeof event.method === "string"
	);
}

function describeExit(
	binary: string,
	exit: PiRpcExit,
	spawnError: Error | null,
): string {
	if (spawnError) {
		const code = (spawnError as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return `Pi CLI not found (${binary}). Install pi or set PI_DESKTOP_PI_BIN to the executable.`;
		}
		return `Could not start Pi CLI (${binary}): ${spawnError.message}`;
	}
	const stderr = exit.stderr.trim().split("\n").slice(-3).join("\n").trim();
	const how =
		exit.signal !== null
			? `was terminated by ${exit.signal}`
			: `exited with code ${exit.code ?? "unknown"}`;
	return stderr ? `Pi ${how}: ${stderr}` : `Pi ${how}`;
}

/**
 * LF-only JSONL reader (mirrors Pi's own `attachJsonlLineReader`). Exported
 * for tests and for one-shot discovery processes.
 */
export function attachJsonlLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const emit = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};
	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			emit(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emit(buffer);
			buffer = "";
		}
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
