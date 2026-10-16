import type { SyncIndex, LocalFileEntry, RemoteFileEntry, DiffPlan } from "../types.ts";

/** 索引格式版本；结构变了要 +1 并写迁移 */
export const INDEX_VERSION = 1;

export function emptyIndex(): SyncIndex {
	return { version: INDEX_VERSION, lastSyncAt: null, entries: {} };
}

/** 磁盘数据 → SyncIndex；损坏/版本不符时返回空索引而不是抛错 */
export function parseIndex(raw: unknown): SyncIndex {
	throw new Error("not implemented: parseIndex");
}

export interface DiffOptions {
	/** 远端存在、本地已无的文件是否删除（镜像模式） */
	mirrorDelete: boolean;
	/** 是否用 hash 判等（否则 size+mtimeMs） */
	useHash: boolean;
}

/**
 * 计算要上传/要删除的清单。
 *
 * 判定逻辑（用索引而不是每次拉全量内容做比较）：
 *   - 本地文件在索引里且 size 与 mtimeMs 都没变 → 跳过（快速模式）
 *   - useHash 时：本地 hash 与索引 hash 相同 → 跳过，即使 mtime 变了
 *   - 其余 → 上传
 *   - 索引里有、本地已无的 relPath：mirrorDelete 时进 toDelete（同时要保证它在远端确实存在）
 *   - 远端有、索引里没有的文件：视为"史前遗留"，mirrorDelete 时也进 toDelete
 *     （否则远端会永久留垃圾）—— 但要把索引里的删除目标与远端实际存在做交集
 */
export function computeDiff(
	local: LocalFileEntry[],
	index: SyncIndex,
	remote: RemoteFileEntry[],
	opts: DiffOptions,
): DiffPlan {
	throw new Error("not implemented: computeDiff");
}

export interface UploadedRecord {
	relPath: string;
	rev: string;
	size: number;
	mtimeMs: number;
	hash?: string;
}

/** 用本轮结果生成新索引（纯函数，不改原对象） */
export function applyIndex(
	index: SyncIndex,
	uploaded: UploadedRecord[],
	deleted: string[],
	nowIso: string,
): SyncIndex {
	throw new Error("not implemented: applyIndex");
}
