import type { Logger } from "./types.ts";
import type { DropboxClient } from "./dropbox/client.ts";
import type { SnapshotRecord } from "./snapshot/manager.ts";

export interface RestorePlan {
	/** 远端有、本地没有或内容不同 → 要写回的文件 */
	toWrite: { relPath: string; size: number }[];
	/** 本地有、远端没有 → 要被删除的文件（默认不动，除非 includeDelete） */
	toDelete: string[];
	/** 两侧相对路径与大小都一致，跳过 */
	unchanged: number;
	/** 计划来源说明，显示在确认弹窗里 */
	sourceLabel: string;
	/** 预计下载字节数 */
	bytesToDownload: number;
	/** 被排除规则挡掉、不参与还原的远端条目数 */
	skippedByRules: number;
}

export interface RestoreDeps {
	client: DropboxClient;
	/** 本地 .obsidian 绝对路径 */
	configDir: string;
	/** 留底目录绝对路径；还原前把当前 configDir 打成 zip 放这里 */
	safetyDir: string;
	/** 与同步一致的匹配器，保证还原只碰同步范围内的文件 */
	matcher: (relPath: string, isDir?: boolean) => boolean;
	logger?: Logger;
	onProgress?: (phase: string, done: number, total: number) => void;
}

export interface RestoreResult {
	written: number;
	deleted: number;
	/** 留底 zip 的绝对路径 */
	safetyZip: string;
	errors: { relPath: string; message: string }[];
}

/**
 * 防呆还原：
 *   1. preview() 只读，生成 RestorePlan
 *   2. apply() 必须先创建留底 zip（当前整个 .obsidian），再逐个下载写入
 *   3. 默认不删本地独有文件；includeDelete=true 才删
 *   4. apply 必须接受一个 confirm 回调，返回 false 就整体放弃（不改任何文件）
 */
export class RestoreManager {
	constructor(deps: RestoreDeps) {
		throw new Error("not implemented: RestoreManager");
	}

	async preview(source: { kind: "mirror" } | { kind: "snapshot"; snapshot: SnapshotRecord }): Promise<RestorePlan> {
		throw new Error("not implemented: preview");
	}

	async apply(
		plan: RestorePlan,
		opts: { includeDelete?: boolean; confirm: (plan: RestorePlan) => Promise<boolean> },
	): Promise<RestoreResult> {
		throw new Error("not implemented: apply");
	}
}
