import * as path from "node:path";

import { applyIndex, computeDiff } from "./index-store.ts";
import type { UploadedRecord } from "./index-store.ts";
import { SNAPSHOT_DIR_NAME, snapshotStamp } from "../snapshot/manager.ts";
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
import type { ScanResult, ScanOptions } from "../scan/scanner.ts";
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
	/**
	 * 注入点：默认用 src/scan/scanner.ts 的 scanDir。
	 * 让本模块可以配一个假扫描器做纯逻辑测试（不碰真实磁盘）。
	 */
	scanner?: (opts: ScanOptions) => Promise<ScanResult>;
	/** 注入点：默认用 compileMatcher(getSettings()) */
	matcher?: (relPath: string, isDir?: boolean) => boolean;
}

export interface PlanResult {
	plan: DiffPlan;
	scan: ScanResult;
	remote: RemoteFileEntry[];
}

/** 一次列举结果 + 远端路径口径（带不带 vault 这一层前缀） */
interface RemoteScope {
	/** relPath 已归一到"与本地 relPath 同口径" */
	list: RemoteFileEntry[];
	/** 远端清单里的路径是否带着 vault 名前缀 */
	prefixed: boolean;
	/** vault 名（configDir 的父目录名） */
	prefix: string;
}

/** 与 index-store 一致的路径归一化（对外 relPath 统一 '/'、无前导 './' 或 '/'） */
function toRelKey(rel: string): string {
	return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 本地 relPath → 远端接口用的 relPath */
function scopeKey(scope: RemoteScope, rel: string): string {
	return scope.prefixed ? `${scope.prefix}/${rel}` : rel;
}

/** 远端接口给的 relPath → 本地口径 relPath */
function scopeRel(scope: RemoteScope, key: string): string {
	const rel = toRelKey(key);
	if (!scope.prefixed) return rel;
	return rel.startsWith(`${scope.prefix}/`) ? rel.slice(scope.prefix.length + 1) : rel;
}

export class SyncEngine {
	/** 同一时刻只允许一轮；true 表示正在跑 */
	get running(): boolean {
		return this.isRunning;
	}

	private deps: SyncEngineDeps;
	private isRunning = false;
	private cancelled = false;
	/** 懒加载的默认依赖（注入点给了就不用它们，测试因此完全不碰别人的文件） */
	private scannerMod: typeof import("../scan/scanner.ts") | null = null;
	private excludeMod: typeof import("../scan/exclude.ts") | null = null;

	constructor(deps: SyncEngineDeps) {
		this.deps = deps;
	}

	/** 只算差异，不动远端（供 UI 预览和 dryRun 用） */
	async plan(): Promise<PlanResult> {
		const settings = this.deps.getSettings();
		const { scan, remote } = await this.scanAndList(settings);
		const plan = computeDiff(scan.files, this.deps.indexStore.get(), remote.list, {
			mirrorDelete: settings.mirrorDelete,
			useHash: settings.useHash,
			excludedCount: scan.excluded,
		});
		return { plan, scan, remote: remote.list };
	}

	/**
	 * 跑一轮同步。
	 * 顺序：扫描 → 拉远端清单 → 算差异 → 上传（并发）→ 删除 → 更新索引 → 生成快照。
	 * 单文件失败不中断整轮，收进 result.errors。
	 * dryRun 时只算差异不写任何东西。
	 */
	async run(trigger: TriggerKind, opts?: { dryRun?: boolean }): Promise<SyncRunResult> {
		const dryRun = opts ? opts.dryRun === true : false;
		const nowIso = (): string => new Date().toISOString();
		const result: SyncRunResult = {
			trigger,
			startedAt: nowIso(),
			finishedAt: nowIso(),
			uploaded: 0,
			deleted: 0,
			skipped: 0,
			bytesUploaded: 0,
			errors: [],
			dryRun,
		};

		// 并发保护：返回带错误的结果而不是抛异常 —— 调用方（定时器 / 文件监听）多半是
		// fire-and-forget 的，抛出去只会变成没人接的 rejection。
		if (this.isRunning) {
			result.errors.push({ relPath: "", message: "上一轮同步还在进行中，本次触发已忽略" });
			return result;
		}

		this.isRunning = true;
		this.cancelled = false;
		try {
			const settings = this.deps.getSettings();
			const { scan, remote } = await this.scanAndList(settings);
			if (this.cancelled) {
				result.errors.push({ relPath: "", message: "同步已取消，本轮在扫描后停止" });
				return result;
			}

			const index = this.deps.indexStore.get();
			const plan = computeDiff(scan.files, index, remote.list, {
				mirrorDelete: settings.mirrorDelete,
				useHash: settings.useHash,
				excludedCount: scan.excluded,
			});
			result.skipped = plan.unchanged;
			this.progress("diff", plan.toUpload.length, plan.toUpload.length + plan.toDelete.length);

			if (dryRun) return result;

			// ———— 上传 ————
			const metaByRel = new Map<string, { mtimeMs: number; hash?: string }>();
			for (const f of plan.toUpload) {
				const rel = toRelKey(f.relPath);
				metaByRel.set(rel, { mtimeMs: f.mtimeMs, hash: f.hash });
			}
			const items = plan.toUpload.map((f) => ({
				relPath: scopeKey(remote, toRelKey(f.relPath)),
				absPath: f.absPath,
			}));

			const uploadedRecords: UploadedRecord[] = [];
			if (items.length > 0) {
				this.progress("upload", 0, items.length);
				const batch = await this.deps.client.uploadMany(items, (done, total) =>
					this.progress("upload", done, total),
				);
				for (const ok of batch.ok) {
					const rel = scopeRel(remote, ok.relPath);
					const meta = metaByRel.get(rel);
					const size = typeof ok.size === "number" ? ok.size : 0;
					uploadedRecords.push({
						relPath: rel,
						rev: ok.rev,
						size,
						mtimeMs: meta ? meta.mtimeMs : 0,
						// 注意：只能用本地算出来的 sha256。Dropbox 的 content_hash 是另一套算法，
						// 混进索引会让 hash 模式每轮都判定"变了"而重复上传。
						hash: meta && meta.hash ? meta.hash : undefined,
					});
					result.bytesUploaded += size;
				}
				for (const bad of batch.failed) {
					result.errors.push({ relPath: scopeRel(remote, bad.relPath), message: bad.message });
				}
			}
			result.uploaded = uploadedRecords.length;

			// ———— 删除（镜像模式）————
			const deletedRels: string[] = [];
			for (const rel of plan.toDelete) {
				if (this.cancelled) break;
				try {
					await this.deps.client.deletePath(scopeKey(remote, rel));
					deletedRels.push(rel);
					result.deleted++;
				} catch (e) {
					result.errors.push({ relPath: rel, message: errMessage(e) });
				}
			}

			// ———— 索引 ————
			await this.deps.indexStore.set(applyIndex(index, uploadedRecords, deletedRels, nowIso()));
			this.progress("index", 1, 1);

			// ———— 快照 ————
			await this.maybeSnapshot(settings, scan, trigger, result);
		} catch (e) {
			result.errors.push({ relPath: "", message: errMessage(e) });
		} finally {
			this.isRunning = false;
			result.finishedAt = nowIso();
		}

		return result;
	}

	/** 置取消标志，让正在跑的一轮在下一个检查点停下 */
	cancel(): void {
		this.cancelled = true;
	}

	/* ============================ 内部 ============================ */

	/** 扫描本地 + 列举远端（并统一远端路径口径、剔掉快照保留区） */
	private async scanAndList(settings: PluginSettings): Promise<{ scan: ScanResult; remote: RemoteScope }> {
		const scanner = await this.resolveScanner();
		const matcher = await this.resolveMatcher(settings);
		const maxFileSizeBytes =
			settings.maxFileSizeMB > 0 ? Math.floor(settings.maxFileSizeMB * 1024 * 1024) : Number.MAX_SAFE_INTEGER;

		const scan = await scanner({
			rootDir: this.deps.configDir,
			matcher,
			useHash: settings.useHash,
			maxFileSizeBytes,
			concurrency: Math.max(1, Math.floor(settings.concurrency) || 1),
			onProgress: (scanned) => this.progress("scan", scanned, 0),
		});
		this.progress("scan", scan.files.length, scan.files.length);

		const raw = await this.deps.client.listFolderRecursive();
		const remote = this.normalizeRemote(raw);
		this.progress("list", remote.list.length, remote.list.length);
		return { scan, remote };
	}

	private async resolveScanner(): Promise<(opts: ScanOptions) => Promise<ScanResult>> {
		if (this.deps.scanner) return this.deps.scanner;
		if (!this.scannerMod) this.scannerMod = await import("../scan/scanner.ts");
		return this.scannerMod.scanDir;
	}

	private async resolveMatcher(
		settings: PluginSettings,
	): Promise<(relPath: string, isDir?: boolean) => boolean> {
		if (this.deps.matcher) return this.deps.matcher;
		if (!this.excludeMod) this.excludeMod = await import("../scan/exclude.ts");
		return this.excludeMod.compileMatcher({
			includePatterns: settings.includePatterns,
			excludePatterns: settings.excludePatterns,
		});
	}

	/**
	 * vault 名 = configDir（<vault>/.obsidian）的父目录名。
	 * 用它做兼容：如果 client.baseDir 指向的是备份根目录而不是本 vault 的子目录，
	 * 列举回来的路径就会带着这一层，这里识别出来并在上传/删除时补回去；
	 * 反之（baseDir 已经是 vault 子目录，推荐做法）则原样不动。
	 */
	private remotePrefix(): string {
		return path.basename(path.dirname(path.resolve(this.deps.configDir)));
	}

	private normalizeRemote(raw: RemoteFileEntry[]): RemoteScope {
		const prefix = this.remotePrefix();
		const prefixed =
			raw.length > 0 && prefix !== "" && raw.every((r) => toRelKey(r.relPath).startsWith(`${prefix}/`));
		const reserved = this.reservedSegments();

		const list: RemoteFileEntry[] = [];
		for (const r of raw) {
			let rel = toRelKey(r.relPath);
			if (prefixed) rel = rel.slice(prefix.length + 1);
			if (!rel) continue;
			// 快照目录是保留区：绝不能因为它"本地没有"就被镜像删除掉
			if (rel.split("/").some((seg) => reserved.has(seg))) continue;
			list.push({ ...r, relPath: rel });
		}
		return { list, prefixed, prefix };
	}

	/** 不参与镜像比对、但允许留在远端的目录名（快照区） */
	private reservedSegments(): Set<string> {
		const manager = this.deps.snapshotManager;
		const dir = manager ? manager.subDir : "";
		const base = path.posix.basename(dir || SNAPSHOT_DIR_NAME);
		return new Set(base ? [base] : []);
	}

	private async maybeSnapshot(
		settings: PluginSettings,
		scan: ScanResult,
		trigger: TriggerKind,
		result: SyncRunResult,
	): Promise<void> {
		if (this.cancelled || !settings.snapshotEnabled) return;
		const manager = this.deps.snapshotManager;
		if (!manager) return;
		try {
			let wanted = settings.snapshotMode !== "daily";
			if (!wanted) {
				// daily 模式：今天已经有一份就不再生成（快照名前缀就是本地日期）
				const today = snapshotStamp(new Date()).slice(0, 10);
				const existing = await manager.list();
				wanted = !existing.some((s) => s.name.startsWith(today));
			}
			if (!wanted) return;
			this.progress("snapshot", 0, 1);
			const record = await manager.createAndUpload(scan.files, trigger);
			result.snapshotPath = record.remotePath;
			this.progress("snapshot", 1, 1);
		} catch (e) {
			result.errors.push({ relPath: "", message: `生成快照失败：${errMessage(e)}` });
		}
	}

	private progress(phase: string, done: number, total: number): void {
		const cb = this.deps.onProgress;
		if (!cb) return;
		try {
			cb(phase, done, total);
		} catch {
			// 进度回调（UI）出错不能影响同步本身
		}
	}
}
