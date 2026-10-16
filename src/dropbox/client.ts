import type {
	HttpClient,
	RemoteFileEntry,
	DropboxSpaceUsage,
	DropboxAccountInfo,
	DropboxTokens,
	Logger,
} from "../types.ts";

/**
 * Dropbox v2 API 客户端。只依赖注入的 HttpClient，因此可脱离 Obsidian 测试。
 *
 * 端点约定：
 *   元数据类   POST https://api.dropboxapi.com/2/<path>      体为 JSON
 *   内容类     POST https://content.dropboxapi.com/2/<path>  元数据走 Dropbox-API-Arg 头
 *
 * 上传策略：
 *   - 单次上传上限 150MB → 小于等于 CHUNK_SIZE 且小于 150MB 用 files/upload
 *   - 否则用 files/upload_session/start → append_v2 × N → finish
 *   - 每个 chunk 最大 150MB，Dropbox 建议 4~8MB 的整数倍（取 8MB）
 *
 * 错误处理：429 / 5xx / 网络错误指数退避重试（最多 3 次，尊重 Retry-After）。
 * 401 且带 refresh_token 时先刷新一次再重试。
 */
export interface DropboxClientOptions {
	http: HttpClient;
	tokens: DropboxTokens;
	/** 远端根目录，绝对风格，形如 '/Obsidian-Config-Backup'（不含 vault 名） */
	baseDir: string;
	/** 并发上传数 */
	concurrency: number;
	logger?: Logger;
	/** token 刷新后回调，调用方负责持久化 */
	onTokenRefreshed?: (t: DropboxTokens) => void;
}

export class DropboxClient {
	static readonly API_BASE = "https://api.dropboxapi.com/2";
	static readonly CONTENT_BASE = "https://content.dropboxapi.com/2";
	static readonly CHUNK_SIZE = 8 * 1024 * 1024;
	static readonly MAX_SINGLE_UPLOAD = 150 * 1024 * 1024;

	constructor(opts: DropboxClientOptions) {
		throw new Error("not implemented: DropboxClient");
	}

	/** 换 token 后的 baseDir 感知：relPath 为空时返回 baseDir 本身 */
	remotePath(relPath: string): string {
		throw new Error("not implemented: remotePath");
	}

	/** 保证拿得到一个未过期的 accessToken（必要时用 refresh_token 换） */
	async ensureAccessToken(): Promise<string> {
		throw new Error("not implemented: ensureAccessToken");
	}

	async getCurrentAccount(): Promise<DropboxAccountInfo> {
		throw new Error("not implemented: getCurrentAccount");
	}

	async getSpaceUsage(): Promise<DropboxSpaceUsage> {
		throw new Error("not implemented: getSpaceUsage");
	}

	/**
	 * 递归列举 baseDir 下（含子孙）的全部文件。自动翻页。
	 * 目录不存在时返回空数组，不要抛错。
	 */
	async listFolderRecursive(subPath = ""): Promise<RemoteFileEntry[]> {
		throw new Error("not implemented: listFolderRecursive");
	}

	/** 上传本地文件。返回该文件的 rev / size / contentHash */
	async uploadFile(
		relPath: string,
		absPath: string,
	): Promise<{ rev: string; size: number; contentHash?: string }> {
		throw new Error("not implemented: uploadFile");
	}

	/** 上传内存里的字节（快照 zip 之外的场景） */
	async uploadBuffer(
		relPath: string,
		data: Uint8Array,
	): Promise<{ rev: string; size: number; contentHash?: string }> {
		throw new Error("not implemented: uploadBuffer");
	}

	/** 删除远端文件；不存在时静默成功（幂等） */
	async deletePath(relPath: string): Promise<void> {
		throw new Error("not implemented: deletePath");
	}

	/** 确保某个目录存在（Dropbox 上传会自动建父目录，空目录需显式创建） */
	async ensureFolder(relPath: string): Promise<void> {
		throw new Error("not implemented: ensureFolder");
	}

	async downloadFile(relPath: string, destAbsPath: string): Promise<void> {
		throw new Error("not implemented: downloadFile");
	}

	async downloadBuffer(relPath: string): Promise<Uint8Array> {
		throw new Error("not implemented: downloadBuffer");
	}

	/** 按并发上限跑一批上传，逐个回报结果（含失败） */
	async uploadMany(
		items: { relPath: string; absPath: string }[],
		onProgress?: (done: number, total: number, relPath: string) => void,
	): Promise<{ ok: { relPath: string; rev: string; size: number; contentHash?: string }[]; failed: { relPath: string; message: string }[] }> {
		throw new Error("not implemented: uploadMany");
	}
}
