/**
 * 递归监听 .obsidian 目录。
 *
 * 为什么不用 app.vault.on('modify')：Obsidian 的 vault 事件只覆盖 notes 与附件，
 * .obsidian 里的配置/插件文件改动不会触发 vault 事件，所以必须用 node 的 fs.watch。
 * Windows 上 fs.watch(dir, { recursive: true }) 支持递归，底层是 ReadDirectoryChangesW。
 */
export interface WatchOptions {
	rootDir: string;
	/** 过滤：返回 false 的路径不计入待同步集合 */
	isRelevant: (relPath: string, isDir: boolean) => boolean;
	/** 静默多少毫秒后触发一次 onChange（把期间所有事件合并） */
	debounceMs: number;
	onChange: (relPaths: string[]) => void;
	onError?: (err: Error) => void;
}

export class ConfigWatcher {
	readonly running: boolean;

	constructor(opts: WatchOptions) {
		throw new Error("not implemented: ConfigWatcher");
	}

	start(): void {
		throw new Error("not implemented: start");
	}

	stop(): void {
		throw new Error("not implemented: stop");
	}

	/** 目前被记为"有改动待同步"的路径数（UI 显示用） */
	pendingCount(): number {
		throw new Error("not implemented: pendingCount");
	}
}
