import type {
	PluginSettings,
	SyncIndex,
	SyncRunResult,
	TriggerKind,
	DiffPlan,
	RemoteFileEntry,
	Logger,
} from "../types.ts";
import type { DropboxClient } from "../dropbox/client.ts";
import type { ScanResult } from "../scan/scanner.ts";
import type { SnapshotManager } from "../snapshot/manager.ts";

export interface SyncEngineDeps {
	client: DropboxClient;
	/** 索引的读写由外部提供（持久化在 data.json） */
	indexStore: {
		get(): SyncIndex;
		set(index: SyncIndex): Promise<void>;
	};
	getSettings(): PluginSettings;
	/** 本地 .obsidian 绝对路径 */
	configDir: string;
	logger: Logger;
	/** 传了才在每轮成功后生成快照 */
	snapshotManager?: SnapshotManager;
	/** 本轮进度回调，UI 用 */
	onProgress?: (phase: string, done: number, total: number) => void;
}

export interface PlanResult {
	plan: DiffPlan;
	scan: ScanResult;
	remote: RemoteFileEntry[];
}

export class SyncEngine {
	/** 同一时刻只允许一轮；true 表示正在跑 */
	readonly running: boolean;

	constructor(deps: SyncEngineDeps) {
		throw new Error("not implemented: SyncEngine");
	}

	/** 只算差异，不动远端（供 UI 预览和 dryRun 用） */
	async plan(): Promise<PlanResult> {
		throw new Error("not implemented: plan");
	}

	/**
	 * 跑一轮同步。
	 * 顺序：扫描 → 拉远端清单 → 算差异 → 上传（并发）→ 删除 → 更新索引 → 生成快照。
	 * 单文件失败不中断整轮，收进 result.errors。
	 * dryRun 时只算差异不写任何东西。
	 */
	async run(trigger: TriggerKind, opts?: { dryRun?: boolean }): Promise<SyncRunResult> {
		throw new Error("not implemented: run");
	}

	/** 置取消标志，让正在跑的一轮在下一个检查点停下 */
	cancel(): void {
		throw new Error("not implemented: cancel");
	}
}
