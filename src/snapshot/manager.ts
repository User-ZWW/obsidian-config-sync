import type { LocalFileEntry, Logger } from "../types.ts";
import type { DropboxClient } from "../dropbox/client.ts";

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

export class SnapshotManager {
	constructor(opts: SnapshotManagerOptions) {
		throw new Error("not implemented: SnapshotManager");
	}

	/** 打包 → 上传 → 轮转旧快照。返回新快照记录 */
	async createAndUpload(files: LocalFileEntry[], label: string): Promise<SnapshotRecord> {
		throw new Error("not implemented: createAndUpload");
	}

	/** 按名字倒序（最新在前） */
	async list(): Promise<SnapshotRecord[]> {
		throw new Error("not implemented: list");
	}

	/** 只保留最近 keep 份，返回被删除的快照名 */
	async rotate(): Promise<string[]> {
		throw new Error("not implemented: rotate");
	}

	async download(snapshot: SnapshotRecord, destZipPath: string): Promise<void> {
		throw new Error("not implemented: download");
	}
}
