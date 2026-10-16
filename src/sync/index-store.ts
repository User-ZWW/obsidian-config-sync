import type { SyncIndex, LocalFileEntry, RemoteFileEntry, DiffPlan, IndexEntry } from "../types.ts";

/** 索引格式版本；结构变了要 +1 并写迁移 */
export const INDEX_VERSION = 1;

export function emptyIndex(): SyncIndex {
	return { version: INDEX_VERSION, lastSyncAt: null, entries: {} };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 统一 relPath 口径：反斜杠转 '/'，去掉前导 './' 与 '/'。
 * 索引是长期躺在用户 data.json 里的东西，可能被手工改过或用旧版本写过，
 * 所以每个入口都过一遍归一化。
 */
function normalizeRel(rel: string): string {
	return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** 磁盘数据 → SyncIndex；损坏/版本不符时返回空索引而不是抛错 */
export function parseIndex(raw: unknown): SyncIndex {
	if (!isPlainObject(raw)) return emptyIndex();
	if (raw.version !== INDEX_VERSION) return emptyIndex();

	const rawEntries = raw.entries;
	const entries: Record<string, IndexEntry> = {};
	if (isPlainObject(rawEntries)) {
		for (const [key, value] of Object.entries(rawEntries)) {
			const rel = normalizeRel(key);
			if (!rel) continue;
			if (!isPlainObject(value)) continue;
			const size = value.size;
			const mtimeMs = value.mtimeMs;
			const rev = value.rev;
			const uploadedAt = value.uploadedAt;
			if (typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;
			if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) continue;
			if (typeof rev !== "string") continue;
			if (typeof uploadedAt !== "string") continue;
			const entry: IndexEntry = { size, mtimeMs, rev, uploadedAt };
			if (typeof value.hash === "string" && value.hash) entry.hash = value.hash;
			entries[rel] = entry;
		}
	}

	return {
		version: INDEX_VERSION,
		lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
		entries,
	};
}

export interface DiffOptions {
	/** 远端存在、本地已无的文件是否删除（镜像模式） */
	mirrorDelete: boolean;
	/** 是否用 hash 判等（否则 size+mtimeMs） */
	useHash: boolean;
	/**
	 * ★ 追加字段：扫描阶段被规则排除的条目数。
	 * computeDiff 只拿得到"通过规则的文件"，看不到被排除的那些，
	 * 所以 excluded 计数只能由调用方（SyncEngine）从 ScanResult 透传进来；不传时为 0。
	 */
	excludedCount?: number;
}

/**
 * 单个文件是否无需重新上传。
 *
 * hash 模式只在**两侧都有 hash** 时才作准：此时 mtime 变了但内容没变能跳过，
 * 反过来 size/mtime 没变但内容被换掉也能识别出来。
 * 缺 hash 就退回 size+mtime 判等 —— 宁可多传一次，也不要漏传。
 */
function isUnchanged(idx: IndexEntry, file: LocalFileEntry, useHash: boolean): boolean {
	if (useHash && typeof file.hash === "string" && typeof idx.hash === "string") {
		return file.hash === idx.hash;
	}
	return idx.size === file.size && idx.mtimeMs === file.mtimeMs;
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
	const indexEntries = index && index.entries ? index.entries : {};

	const localRels = new Set<string>();
	for (const f of local) localRels.add(normalizeRel(f.relPath));

	const remoteRels = new Set<string>();
	for (const r of remote) remoteRels.add(normalizeRel(r.relPath));

	const toUpload: LocalFileEntry[] = [];
	let unchanged = 0;
	for (const f of local) {
		const rel = normalizeRel(f.relPath);
		const idx = indexEntries[rel];
		if (idx && isUnchanged(idx, f, opts.useHash)) {
			unchanged++;
			continue;
		}
		toUpload.push(f);
	}

	const toDelete: string[] = [];
	if (opts.mirrorDelete) {
		const candidates = new Set<string>();
		// 情况一：索引里记过、本地已经没了
		for (const key of Object.keys(indexEntries)) {
			const rel = normalizeRel(key);
			if (rel && !localRels.has(rel)) candidates.add(rel);
		}
		// 情况二：远端有、索引里没有（史前遗留，或别的工具塞进来的）
		for (const r of remote) {
			const rel = normalizeRel(r.relPath);
			if (!rel) continue;
			if (localRels.has(rel)) continue; // 本地还在 → 本轮是覆盖上传，绝不能删
			if (indexEntries[rel]) continue; // 索引里有 → 已由情况一覆盖
			candidates.add(rel);
		}
		// 只有远端真的存在才敢删（索引可能比远端新，例如上一轮删完远端就空了）
		for (const rel of [...candidates].sort()) {
			if (remoteRels.has(rel)) toDelete.push(rel);
		}
	}

	const excluded = opts.excludedCount;
	return {
		toUpload,
		toDelete,
		unchanged,
		excluded: typeof excluded === "number" && excluded > 0 ? excluded : 0,
	};
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
	const entries: Record<string, IndexEntry> = {};
	const old = index && index.entries ? index.entries : {};
	for (const [key, value] of Object.entries(old)) {
		entries[key] = { ...value }; // 逐项浅拷贝：新索引与原索引不共享任何可变对象
	}

	for (const rec of uploaded) {
		const rel = normalizeRel(rec.relPath);
		if (!rel) continue;
		const entry: IndexEntry = {
			size: rec.size,
			mtimeMs: rec.mtimeMs,
			rev: rec.rev,
			uploadedAt: nowIso,
		};
		if (typeof rec.hash === "string" && rec.hash) entry.hash = rec.hash;
		entries[rel] = entry;
	}

	for (const key of deleted) {
		const rel = normalizeRel(key);
		if (rel) delete entries[rel];
	}

	return { version: INDEX_VERSION, lastSyncAt: nowIso, entries };
}
