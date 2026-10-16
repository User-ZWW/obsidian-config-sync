/**
 * 递归监听 .obsidian 目录。
 *
 * 为什么不用 app.vault.on('modify')：Obsidian 的 vault 事件只覆盖 notes 与附件，
 * .obsidian 里的配置/插件文件改动不会触发 vault 事件，所以必须用 node 的 fs.watch。
 * Windows 上 fs.watch(dir, { recursive: true }) 支持递归，底层是 ReadDirectoryChangesW。
 */
import { statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, sep } from "node:path";

export interface WatchOptions {
	rootDir: string;
	/** 过滤：返回 false 的路径不计入待同步集合 */
	isRelevant: (relPath: string, isDir: boolean) => boolean;
	/** 静默多少毫秒后触发一次 onChange（把期间所有事件合并） */
	debounceMs: number;
	onChange: (relPaths: string[]) => void;
	onError?: (err: Error) => void;
}

/** 让定时器 / watcher 不阻止 node 进程退出（浏览器环境没有 unref，忽略即可）。 */
function unrefIfPossible(handle: unknown): void {
	if (handle === null || typeof handle !== "object") return;
	const maybe = handle as { unref?: unknown };
	if (typeof maybe.unref === "function") (maybe.unref as () => void).call(handle);
}

/**
 * fs.watch 给的是平台相关分隔符的相对路径，统一成 '/' 分隔、无前导 './' 或 '/'。
 * 例：'plugins\\测试\\data.json' → 'plugins/测试/data.json'。
 */
function toPosixRelPath(raw: string): string {
	let p = raw.split(sep).join("/");
	if (sep !== "/") p = p.split("\\").join("/");
	return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

export class ConfigWatcher {
	private readonly opts: WatchOptions;
	private watcher: FSWatcher | null = null;
	private readonly pending = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: WatchOptions) {
		this.opts = opts;
	}

	/**
	 * 是否正在监听。桩里声明为 `readonly running: boolean`，这里用 getter 实现，
	 * 对外语义完全一致（只读布尔），但 start/stop 能更新它。
	 */
	get running(): boolean {
		return this.watcher !== null;
	}

	start(): void {
		if (this.watcher !== null) return; // 幂等
		let watcher: FSWatcher;
		try {
			watcher = watch(this.opts.rootDir, { recursive: true, persistent: true }, (_event, filename) => {
				this.handleEvent(filename);
			});
		} catch (err) {
			// 目录不存在 / 无权限：不进入 running 状态，把错误交给调用方决定怎么提示
			this.reportError(err);
			return;
		}
		watcher.on("error", (err: Error) => {
			this.reportError(err);
			this.stop();
		});
		unrefIfPossible(watcher);
		this.watcher = watcher;
	}

	stop(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending.clear();
		const watcher = this.watcher;
		this.watcher = null;
		if (watcher !== null) {
			try {
				watcher.close();
			} catch {
				/* 已经关掉了 */
			}
		}
	}

	/** 目前被记为"有改动待同步"的路径数（UI 显示用） */
	pendingCount(): number {
		return this.pending.size;
	}

	private handleEvent(filename: string | Buffer | null): void {
		if (this.watcher === null || filename === null) return;
		const raw = typeof filename === "string" ? filename : filename.toString("utf8");
		const relPath = toPosixRelPath(raw);
		if (relPath === "") return;
		if (!this.isRelevant(relPath)) return;
		this.pending.add(relPath);
		this.scheduleFlush();
	}

	private isRelevant(relPath: string): boolean {
		let isDir = false;
		try {
			const stats = statSync(join(this.opts.rootDir, relPath), { throwIfNoEntry: false });
			isDir = stats !== undefined && stats.isDirectory();
		} catch {
			// 事件之后文件可能已被删掉 / 读不到：按"不是目录"处理
			isDir = false;
		}
		try {
			return this.opts.isRelevant(relPath, isDir) === true;
		} catch (err) {
			this.reportError(err);
			return false;
		}
	}

	private scheduleFlush(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, Math.max(0, this.opts.debounceMs));
		unrefIfPossible(this.timer);
	}

	private flush(): void {
		if (this.pending.size === 0) return;
		const changed = [...this.pending].sort();
		this.pending.clear();
		try {
			this.opts.onChange(changed);
		} catch (err) {
			this.reportError(err);
		}
	}

	private reportError(err: unknown): void {
		if (!this.opts.onError) return;
		const error = err instanceof Error ? err : new Error(String(err));
		try {
			this.opts.onError(error);
		} catch {
			/* onError 自己抛错就吞掉，别把监听也带崩 */
		}
	}
}
