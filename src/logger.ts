import type { Logger } from "./types.ts";

export interface LogEntry {
	time: string;
	level: "debug" | "info" | "warn" | "error";
	msg: string;
}

export interface RingLoggerOptions {
	/** 内存里保留多少行，默认 500 */
	max?: number;
	level?: "quiet" | "info" | "debug";
	/** 每写一行额外调一次（设置面板用它刷新） */
	sink?: (line: string) => void;
	/** 同时打到 console */
	console?: boolean;
}

/**
 * 内存环形日志。设置面板能直接显示最近 N 行；同时可选转发到 console。
 * 不依赖 obsidian，可在 node 测试里用。
 */
export class RingLogger implements Logger {
	private lines: string[] = [];
	private max: number;
	level: "quiet" | "info" | "debug";
	private sink?: (line: string) => void;
	private useConsole: boolean;

	constructor(opts: RingLoggerOptions = {}) {
		this.max = opts.max ?? 500;
		this.level = opts.level ?? "info";
		this.sink = opts.sink;
		this.useConsole = opts.console ?? false;
	}

	private push(level: LogEntry["level"], msg: string, args: unknown[]): void {
		if (this.level === "quiet" && level !== "error") return;
		if (this.level === "info" && level === "debug") return;
		const time = new Date().toISOString();
		const extra = args.length
			? " " + args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ")
			: "";
		const line = `[${time}] ${level.toUpperCase()} ${msg}${extra}`;
		this.lines.push(line);
		if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
		if (this.sink) {
			try {
				this.sink(line);
			} catch {
				/* sink 出错不能影响主流程 */
			}
		}
		if (this.useConsole) {
			// eslint-disable-next-line no-console
			console[level === "debug" ? "log" : level](line);
		}
	}

	debug(msg: string, ...args: unknown[]): void {
		this.push("debug", msg, args);
	}
	info(msg: string, ...args: unknown[]): void {
		this.push("info", msg, args);
	}
	warn(msg: string, ...args: unknown[]): void {
		this.push("warn", msg, args);
	}
	error(msg: string, ...args: unknown[]): void {
		this.push("error", msg, args);
	}

	getLines(): string[] {
		return [...this.lines];
	}
	clear(): void {
		this.lines = [];
	}
	setLevel(level: "quiet" | "info" | "debug"): void {
		this.level = level;
	}
}

function safeStringify(v: unknown): string {
	if (v instanceof Error) return `${v.name}: ${v.message}`;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
