import * as fs from "node:fs";
import * as path from "node:path";

import { createZipFromFiles } from "./zip.ts";
import type { LocalFileEntry, Logger, RemoteFileEntry } from "../types.ts";
import type { DropboxClient } from "../dropbox/client.ts";

/** 快照所在的远端子目录名（保留区，不参与镜像比对） */
export const SNAPSHOT_DIR_NAME = "_snapshots";

export interface SnapshotRecord {
	/** 形如 2026-10-16T21-30-00.zip */
	name: string;
	/** 相对 baseDir 的路径，形如 MyVault/_snapshots/… */
	remotePath: string;
	createdAt: string;
	size: number;
}

export interface SnapshotManagerOptions {
	client: DropboxClient;
	/** 本地 .obsidian 绝对路径 */
	localRootDir: string;
	/** 临时目录（放本地 zip 中间产物），用完自己清理 */
	tmpDir: string;
	/** 远端快照子目录名，默认 '_snapshots' */
	subDir?: string;
	/** 保留最近几份 */
	keep: number;
	logger?: Logger;
}

/**
 * 快照文件名的时间戳部分（本地时间，秒精度，可字典序排序）。
 * 之所以用本地时间：文件名是给用户看的（"今天 21:30 那份"），
 * 而机器可读的时间另存在 SnapshotRecord.createdAt 里。
 */
export function snapshotStamp(d: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
		`T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
	);
}

/** 把 label 收敛成文件名安全的一小段（中文会被滤掉，不影响可读性） */
function safeLabel(label: string): string {
	if (!label) return "";
	return label.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 24);
}

function normalizeSubDir(subDir: string): string {
	const clean = subDir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	return clean === "." ? "" : clean;
}

export class SnapshotManager {
	readonly localRootDir: string;
	readonly tmpDir: string;
	/** 远端快照子目录（已归一化，可能为空 = 直接放在 baseDir 下） */
	readonly subDir: string;
	readonly keep: number;

	private client: DropboxClient;
	private logger?: Logger;

	constructor(opts: SnapshotManagerOptions) {
		this.client = opts.client;
		this.localRootDir = opts.localRootDir;
		this.tmpDir = opts.tmpDir;
		this.subDir = normalizeSubDir(opts.subDir ?? SNAPSHOT_DIR_NAME);
		// 至少留 1 份：轮转如果允许删光，刚生成的那份会立刻被自己删掉
		const keep = Math.floor(opts.keep);
		this.keep = Number.isFinite(keep) && keep >= 1 ? keep : 1;
		this.logger = opts.logger;
	}

	/** 打包 → 上传 → 轮转旧快照。返回新快照记录 */
	async createAndUpload(files: LocalFileEntry[], label: string): Promise<SnapshotRecord> {
		const suffix = safeLabel(label);
		const name = `${snapshotStamp(new Date())}${suffix ? `-${suffix}` : ""}.zip`;
		const remotePath = this.remotePathOf(name);

		await fs.promises.mkdir(this.tmpDir, { recursive: true });
		const localZip = path.join(this.tmpDir, name);

		try {
			const zipped = await createZipFromFiles(this.localRootDir, files, localZip);
			const uploaded = await this.client.uploadFile(remotePath, localZip);
			if (this.logger) {
				this.logger.info(`快照已上传 ${remotePath}（${zipped.entries} 个文件，${uploaded.size} 字节）`);
			}
			const record: SnapshotRecord = {
				name,
				remotePath,
				createdAt: new Date().toISOString(),
				size: typeof uploaded.size === "number" ? uploaded.size : zipped.bytes,
			};
			await this.rotate();
			return record;
		} finally {
			// 本地中间产物无论成败都不留
			await fs.promises.rm(localZip, { force: true }).catch(() => undefined);
		}
	}

	/** 按名字倒序（最新在前） */
	async list(): Promise<SnapshotRecord[]> {
		let entries: RemoteFileEntry[];
		try {
			entries = await this.client.listFolderRecursive(this.subDir);
		} catch (e) {
			if (this.logger) this.logger.warn("列举快照失败", e instanceof Error ? e.message : String(e));
			return [];
		}

		const out: SnapshotRecord[] = [];
		for (const entry of entries) {
			const name = this.nameOf(entry.relPath);
			if (!name) continue;
			out.push({
				name,
				remotePath: this.remotePathOf(name),
				createdAt: entry.serverModified || "",
				size: entry.size,
			});
		}
		// 名字前缀就是时间戳（定宽），字典序 = 时间序
		out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
		return out;
	}

	/** 只保留最近 keep 份，返回被删除的快照名 */
	async rotate(): Promise<string[]> {
		const all = await this.list();
		const doomed = all.slice(this.keep);
		const removed: string[] = [];
		for (const snapshot of doomed) {
			try {
				await this.client.deletePath(snapshot.remotePath);
				removed.push(snapshot.name);
			} catch (e) {
				if (this.logger) {
					this.logger.warn(`删除旧快照失败：${snapshot.name}`, e instanceof Error ? e.message : String(e));
				}
			}
		}
		if (removed.length && this.logger) this.logger.info(`快照轮转：清理了 ${removed.length} 份旧快照`);
		return removed;
	}

	async download(snapshot: SnapshotRecord, destZipPath: string): Promise<void> {
		await fs.promises.mkdir(path.dirname(destZipPath), { recursive: true });
		await this.client.downloadFile(snapshot.remotePath, destZipPath);
	}

	/** 快照在远端 baseDir 下的路径 */
	remotePathOf(name: string): string {
		return this.subDir ? `${this.subDir}/${name}` : name;
	}

	/**
	 * 从远端列举结果里提取快照文件名。
	 * 兼容两种列举口径：路径相对 baseDir（带 subDir 前缀）或相对 subDir（不带前缀）；
	 * 落在更深层目录里的东西不算快照。
	 */
	private nameOf(relPath: string): string | null {
		let rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
		if (this.subDir && rel.startsWith(`${this.subDir}/`)) rel = rel.slice(this.subDir.length + 1);
		if (!rel || rel.includes("/")) return null;
		if (!rel.toLowerCase().endsWith(".zip")) return null;
		if (rel.startsWith(".")) return null;
		return rel;
	}
}
