import { Buffer } from "node:buffer";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
	HttpClient,
	HttpRequest,
	HttpResponse,
	RemoteFileEntry,
	DropboxSpaceUsage,
	DropboxAccountInfo,
	DropboxTokens,
	Logger,
} from "../types.ts";
import { refreshAccessToken } from "./oauth.ts";

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
	/**
	 * 【追加，可选】覆盖 API 基地址。默认用 DropboxClient.API_BASE。
	 * 仅用于测试（本地 mock 服务）或指向自建网关；生产不要传。
	 */
	apiBase?: string;
	/** 【追加，可选】覆盖内容端点基地址。默认用 DropboxClient.CONTENT_BASE。 */
	contentBase?: string;
}

/** Dropbox 返回的非 2xx 响应统一抛这个，方便上层按 status / error_summary 分支 */
export class DropboxApiError extends Error {
	readonly status: number;
	/** Dropbox 的 error_summary，形如 "path/not_found/.." */
	readonly summary: string;
	/** 响应体原文（截断过），便于排查 */
	readonly body: string;

	constructor(status: number, summary: string, body: string) {
		super(`Dropbox API 错误（HTTP ${status}）：${summary || body || "未知错误"}`);
		this.name = "DropboxApiError";
		this.status = status;
		this.summary = summary;
		this.body = body;
	}
}

/** 值得重试的状态码 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** 总尝试次数（首次 + 2 次重试） */
const MAX_ATTEMPTS = 3;
/** access_token 提前 60 秒视为过期，避免边界上踩 401 */
const TOKEN_SKEW_MS = 60_000;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;
const MAX_ERROR_BODY = 2_000;

export interface UploadedFileInfo {
	rev: string;
	size: number;
	contentHash?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return typeof e === "string" ? e : String(e);
}

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string {
	return typeof v === "string" ? v : "";
}
function asNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 远端根目录规范化：'' 或 '/' 表示 Dropbox 根，其余统一成 '/a/b' 形式（无尾斜杠） */
function normalizeRemoteDir(dir: string): string {
	let d = (dir ?? "").trim().replace(/\\/g, "/");
	if (d === "" || d === "/") return "";
	if (!d.startsWith("/")) d = "/" + d;
	d = d.replace(/\/{2,}/g, "/").replace(/\/+$/g, "");
	return d;
}

/** 相对路径规范化：去掉前导 './'、前导 '/'、尾斜杠与首尾空白，折叠重复斜杠，统一 '/' */
function normalizeRel(relPath: string): string {
	return (relPath ?? "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/g, "");
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

/** 响应体文本：arraybuffer 响应（下载）的错误体只能从二进制解出来 */
function responseText(res: HttpResponse): string {
	if (typeof res.text === "string") return res.text;
	if (res.arrayBuffer) {
		try {
			return new TextDecoder().decode(res.arrayBuffer);
		} catch {
			return "";
		}
	}
	return "";
}

/** 尽量从响应里抠出 Dropbox 的 error_summary */
function errorSummary(res: HttpResponse): string {
	const direct = asRecord(res.json).error_summary;
	if (typeof direct === "string") return direct;
	const raw = responseText(res);
	if (raw) {
		try {
			const parsed = asRecord(JSON.parse(raw));
			if (typeof parsed.error_summary === "string") return parsed.error_summary;
		} catch {
			// 不是 JSON，直接用原文
		}
	}
	return raw.slice(0, 300);
}

/** Retry-After 优先，其次指数退避 */
function backoffFor(res: HttpResponse | undefined, attempt: number): number {
	const ra = res ? headerValue(res.headers ?? {}, "retry-after") : undefined;
	if (ra) {
		const secs = Number(ra);
		if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
		const when = Date.parse(ra);
		if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 60_000);
	}
	return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * 把 JSON 参数塞进 HTTP 头（Dropbox-API-Arg）。
 * 头值必须是 ASCII：node 的 http 模块遇到中文字符会直接抛 ERR_INVALID_CHAR，
 * 所以这里把非 ASCII 字符转成 JSON 的 \uXXXX 转义 —— 语义完全等价（服务端照样按 JSON 解析），
 * 但字节全是 ASCII。中文路径全靠这一步才能过。
 */
function headerJson(arg: unknown): string {
	return JSON.stringify(arg ?? {}).replace(
		/[\u0080-\uffff]/g,
		(c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
	);
}

function mapFileMetadata(v: unknown): UploadedFileInfo {
	const r = asRecord(v);
	return {
		rev: asString(r.rev),
		size: asNumber(r.size),
		contentHash: typeof r.content_hash === "string" ? r.content_hash : undefined,
	};
}

export class DropboxClient {
	static readonly API_BASE = "https://api.dropboxapi.com/2";
	static readonly CONTENT_BASE = "https://content.dropboxapi.com/2";
	static readonly CHUNK_SIZE = 8 * 1024 * 1024;
	static readonly MAX_SINGLE_UPLOAD = 150 * 1024 * 1024;

	private http: HttpClient;
	private tokens: DropboxTokens;
	private baseDir: string;
	private concurrency: number;
	private logger: Logger | undefined;
	private onTokenRefreshed: ((t: DropboxTokens) => void) | undefined;
	private apiBase: string;
	private contentBase: string;
	/** 单飞：并发调用只触发一次刷新 */
	private refreshInFlight: Promise<string> | null;

	constructor(opts: DropboxClientOptions) {
		this.http = opts.http;
		this.tokens = opts.tokens;
		this.baseDir = normalizeRemoteDir(opts.baseDir);
		this.concurrency = Math.max(1, Math.floor(opts.concurrency || 1));
		this.logger = opts.logger;
		this.onTokenRefreshed = opts.onTokenRefreshed;
		this.apiBase = (opts.apiBase ?? DropboxClient.API_BASE).replace(/\/+$/g, "");
		this.contentBase = (opts.contentBase ?? DropboxClient.CONTENT_BASE).replace(/\/+$/g, "");
		this.refreshInFlight = null;
	}

	/** 换 token 后的 baseDir 感知：relPath 为空时返回 baseDir 本身 */
	remotePath(relPath: string): string {
		const rel = normalizeRel(relPath);
		if (!rel) return this.baseDir;
		return this.baseDir === "" ? "/" + rel : this.baseDir + "/" + rel;
	}

	/** 远端完整路径 → 相对 baseDir 的 relPath（'/' 分隔，无前导 '/'） */
	private relFromRemote(fullPath: string): string {
		const full = (fullPath ?? "").replace(/\\/g, "/");
		if (this.baseDir === "") return full.replace(/^\/+/, "");
		if (full === this.baseDir) return "";
		if (full.startsWith(this.baseDir + "/")) return full.slice(this.baseDir.length + 1);
		return full.replace(/^\/+/, "");
	}

	/** 用 refresh_token 换新 access_token（并发安全） */
	private async refreshNow(): Promise<string> {
		if (!this.refreshInFlight) {
			this.refreshInFlight = (async () => {
				const rt = this.tokens.refreshToken;
				if (!rt) throw new Error("缺少 refresh_token，无法刷新 Dropbox access_token");
				const { accessToken, expiresIn } = await refreshAccessToken(this.http, {
					appKey: this.tokens.appKey,
					refreshToken: rt,
				});
				this.tokens.accessToken = accessToken;
				this.tokens.expiresAt = Date.now() + expiresIn * 1000;
				this.logger?.debug("Dropbox access_token 已刷新");
				try {
					this.onTokenRefreshed?.(this.tokens);
				} catch (e) {
					this.logger?.warn("onTokenRefreshed 回调失败", e);
				}
				return accessToken;
			})().finally(() => {
				this.refreshInFlight = null;
			});
		}
		return await this.refreshInFlight;
	}

	/** 保证拿得到一个未过期的 accessToken（必要时用 refresh_token 换） */
	async ensureAccessToken(): Promise<string> {
		const t = this.tokens;
		if (
			t.accessToken &&
			(t.expiresAt === undefined || t.expiresAt - TOKEN_SKEW_MS > Date.now())
		) {
			return t.accessToken;
		}
		if (t.refreshToken && t.appKey) return await this.refreshNow();
		// 过期但没法刷新：先用着，让服务端 401 给出明确信息
		if (t.accessToken) return t.accessToken;
		throw new Error("尚未授权 Dropbox：请在插件设置里完成 OAuth 授权");
	}

	/** 统一的请求出口：加 Bearer、401 刷新一次、429/5xx/网络错误退避重试 */
	private async send(req: HttpRequest, label: string): Promise<HttpResponse> {
		let attempt = 0;
		let refreshed = false;
		for (;;) {
			const token = await this.ensureAccessToken();
			const headers: Record<string, string> = { ...(req.headers ?? {}) };
			headers["Authorization"] = `Bearer ${token}`;

			let res: HttpResponse;
			try {
				res = await this.http.request({ ...req, headers });
			} catch (e) {
				attempt += 1;
				if (attempt >= MAX_ATTEMPTS) {
					throw new Error(`${label} 网络请求失败（已重试 ${MAX_ATTEMPTS} 次）：${errorMessage(e)}`);
				}
				const wait = backoffFor(undefined, attempt);
				this.logger?.warn(`${label} 网络错误，${wait}ms 后重试：${errorMessage(e)}`);
				await sleep(wait);
				continue;
			}

			if (res.status >= 200 && res.status < 300) return res;

			if (res.status === 401 && this.tokens.refreshToken && this.tokens.appKey && !refreshed) {
				refreshed = true;
				this.logger?.debug(`${label} 收到 401，刷新 token 后原样重试`);
				await this.refreshNow();
				continue;
			}

			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
				attempt += 1;
				const wait = backoffFor(res, attempt);
				this.logger?.warn(`${label} 返回 HTTP ${res.status}，${wait}ms 后重试（第 ${attempt} 次）`);
				await sleep(wait);
				continue;
			}

			throw new DropboxApiError(res.status, errorSummary(res), responseText(res).slice(0, MAX_ERROR_BODY));
		}
	}

	private async postJson(endpoint: string, body: unknown, label: string): Promise<unknown> {
		const res = await this.send(
			{
				url: `${this.apiBase}${endpoint}`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body ?? null),
				responseType: "json",
			},
			label,
		);
		return res.json;
	}

	private async postContent(
		endpoint: string,
		arg: unknown,
		body: Uint8Array | null,
		responseType: "json" | "arraybuffer",
		label: string,
	): Promise<HttpResponse> {
		return await this.send(
			{
				url: `${this.contentBase}${endpoint}`,
				method: "POST",
				headers: {
					"Content-Type": "application/octet-stream",
					"Dropbox-API-Arg": headerJson(arg),
				},
				body,
				responseType,
			},
			label,
		);
	}

	async getCurrentAccount(): Promise<DropboxAccountInfo> {
		const r = asRecord(await this.postJson("/users/get_current_account", null, "get_current_account"));
		return {
			accountId: asString(r.account_id),
			name: asString(asRecord(r.name).display_name) || asString(r.name),
			email: asString(r.email),
		};
	}

	async getSpaceUsage(): Promise<DropboxSpaceUsage> {
		const r = asRecord(await this.postJson("/users/get_space_usage", null, "get_space_usage"));
		return {
			used: asNumber(r.used),
			allocated: asNumber(asRecord(r.allocation).allocated),
		};
	}

	/**
	 * 递归列举 baseDir 下（含子孙）的全部文件。自动翻页。
	 * 目录不存在时返回空数组，不要抛错。
	 */
	async listFolderRecursive(subPath = ""): Promise<RemoteFileEntry[]> {
		const out: RemoteFileEntry[] = [];
		let r: Record<string, unknown>;
		try {
			r = asRecord(
				await this.postJson(
					"/files/list_folder",
					{
						path: this.remotePath(subPath),
						recursive: true,
						include_deleted: false,
						include_mounted_folders: true,
						limit: 2000,
					},
					"list_folder",
				),
			);
		} catch (e) {
			// 远端目录还不存在：视为空目录
			if (e instanceof DropboxApiError && e.status === 409 && /not_found/.test(e.summary)) {
				return [];
			}
			throw e;
		}

		for (;;) {
			const entries = Array.isArray(r.entries) ? r.entries : [];
			for (const raw of entries) {
				const e = asRecord(raw);
				if (asString(e[".tag"]) !== "file") continue;
				out.push({
					relPath: this.relFromRemote(asString(e.path_display) || asString(e.path_lower)),
					size: asNumber(e.size),
					rev: asString(e.rev),
					serverModified: asString(e.server_modified),
					contentHash: typeof e.content_hash === "string" ? e.content_hash : undefined,
				});
			}
			if (!r.has_more) break;
			const cursor = asString(r.cursor);
			if (!cursor) break;
			r = asRecord(
				await this.postJson("/files/list_folder/continue", { cursor }, "list_folder/continue"),
			);
		}
		return out;
	}

	/** 单次上传（≤ CHUNK_SIZE） */
	private async uploadSingle(relPath: string, data: Uint8Array): Promise<UploadedFileInfo> {
		const res = await this.postContent(
			"/files/upload",
			{
				path: this.remotePath(relPath),
				mode: "overwrite",
				autorename: false,
				mute: true,
				strict_conflict: false,
			},
			data,
			"json",
			`upload ${relPath}`,
		);
		return mapFileMetadata(res.json);
	}

	/**
	 * 分块上传：start → append_v2 × N → finish。
	 * read(offset, len) 需要精确返回该区间的字节；返回空表示提前 EOF（抛错）。
	 */
	private async uploadViaSession(
		relPath: string,
		size: number,
		read: (offset: number, len: number) => Promise<Uint8Array>,
	): Promise<UploadedFileInfo> {
		const commit = {
			path: this.remotePath(relPath),
			mode: "overwrite",
			autorename: false,
			mute: true,
			strict_conflict: false,
		};
		let offset = 0;
		let sessionId: string | null = null;

		while (offset < size) {
			const len = Math.min(DropboxClient.CHUNK_SIZE, size - offset);
			const chunk = await read(offset, len);
			if (chunk.byteLength === 0) {
				throw new Error(`读取 ${relPath} 时提前 EOF（offset=${offset}/${size}）`);
			}
			const isLast = offset + chunk.byteLength >= size;

			if (sessionId === null) {
				const started = asRecord(
					await this.postContent(
						"/files/upload_session/start",
						{ close: false },
						chunk,
						"json",
						`upload_session/start ${relPath}`,
					).then((res) => res.json),
				);
				sessionId = asString(started.session_id);
				if (!sessionId) throw new Error("upload_session/start 没有返回 session_id");
			} else if (isLast) {
				const done = await this.postContent(
					"/files/upload_session/finish",
					{ cursor: { session_id: sessionId, offset }, commit },
					chunk,
					"json",
					`upload_session/finish ${relPath}`,
				);
				return mapFileMetadata(done.json);
			} else {
				await this.postContent(
					"/files/upload_session/append_v2",
					{ cursor: { session_id: sessionId, offset }, close: false },
					chunk,
					"json",
					`upload_session/append_v2 ${relPath}`,
				);
			}
			offset += chunk.byteLength;
		}

		if (sessionId === null) throw new Error(`上传 ${relPath} 时未能建立上传会话`);
		// 防御性收尾：正常路径下最后一段一定会在循环里 finish 掉，走不到这里
		const done = await this.postContent(
			"/files/upload_session/finish",
			{ cursor: { session_id: sessionId, offset }, commit },
			new Uint8Array(0),
			"json",
			`upload_session/finish ${relPath}`,
		);
		return mapFileMetadata(done.json);
	}

	/** 上传本地文件。返回该文件的 rev / size / contentHash */
	async uploadFile(relPath: string, absPath: string): Promise<UploadedFileInfo> {
		const st = await stat(absPath);
		const size = st.size;

		if (size <= DropboxClient.CHUNK_SIZE && size <= DropboxClient.MAX_SINGLE_UPLOAD) {
			const data = await readFile(absPath);
			return await this.uploadSingle(
				relPath,
				new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			);
		}

		const fh = await open(absPath, "r");
		try {
			return await this.uploadViaSession(relPath, size, async (offset, len) => {
				const buf = Buffer.allocUnsafe(len);
				let read = 0;
				while (read < len) {
					const { bytesRead } = await fh.read(buf, read, len - read, offset + read);
					if (bytesRead <= 0) break;
					read += bytesRead;
				}
				return new Uint8Array(buf.buffer, buf.byteOffset, read);
			});
		} finally {
			await fh.close();
		}
	}

	/** 上传内存里的字节（快照 zip 之外的场景） */
	async uploadBuffer(relPath: string, data: Uint8Array): Promise<UploadedFileInfo> {
		const size = data.byteLength;
		if (size <= DropboxClient.CHUNK_SIZE && size <= DropboxClient.MAX_SINGLE_UPLOAD) {
			return await this.uploadSingle(relPath, data);
		}
		return await this.uploadViaSession(relPath, size, async (offset, len) =>
			data.subarray(offset, Math.min(offset + len, size)),
		);
	}

	/** 删除远端文件；不存在时静默成功（幂等） */
	async deletePath(relPath: string): Promise<void> {
		try {
			await this.postJson("/files/delete_v2", { path: this.remotePath(relPath) }, `delete ${relPath}`);
		} catch (e) {
			if (e instanceof DropboxApiError && e.status === 409 && /not_found/.test(e.summary)) return;
			throw e;
		}
	}

	/** 确保某个目录存在（Dropbox 上传会自动建父目录，空目录需显式创建） */
	async ensureFolder(relPath: string): Promise<void> {
		const p = this.remotePath(relPath);
		if (!p) return;
		try {
			await this.postJson(
				"/files/create_folder_v2",
				{ path: p, autorename: false },
				`create_folder ${relPath}`,
			);
			return;
		} catch (e) {
			if (!(e instanceof DropboxApiError) || e.status !== 409) throw e;
			if (/conflict/.test(e.summary)) return; // 已经存在
			// 父目录不存在（真实 Dropbox 会回 path/not_found）：往下走 mkdir -p
			if (!/not_found/.test(e.summary)) throw e;
		}
		// 逐级补齐缺失的父目录；每一级都可能已经存在，所以冲突一律忽略
		let acc = "";
		for (const seg of p.split("/").filter(Boolean)) {
			acc += "/" + seg;
			try {
				await this.postJson(
					"/files/create_folder_v2",
					{ path: acc, autorename: false },
					`create_folder ${acc}`,
				);
			} catch (e) {
				if (e instanceof DropboxApiError && e.status === 409 && /conflict/.test(e.summary)) {
					continue;
				}
				throw e;
			}
		}
	}

	async downloadBuffer(relPath: string): Promise<Uint8Array> {
		const res = await this.postContent(
			"/files/download",
			{ path: this.remotePath(relPath) },
			null,
			"arraybuffer",
			`download ${relPath}`,
		);
		if (!res.arrayBuffer) throw new Error(`下载 ${relPath} 失败：响应里没有二进制内容`);
		return new Uint8Array(res.arrayBuffer);
	}

	async downloadFile(relPath: string, destAbsPath: string): Promise<void> {
		const data = await this.downloadBuffer(relPath);
		await mkdir(path.dirname(destAbsPath), { recursive: true });
		await writeFile(destAbsPath, data);
	}

	/** 按并发上限跑一批上传，逐个回报结果（含失败） */
	async uploadMany(
		items: { relPath: string; absPath: string }[],
		onProgress?: (done: number, total: number, relPath: string) => void,
	): Promise<{
		ok: { relPath: string; rev: string; size: number; contentHash?: string }[];
		failed: { relPath: string; message: string }[];
	}> {
		const total = items.length;
		const slots: (
			| { kind: "ok"; value: { relPath: string; rev: string; size: number; contentHash?: string } }
			| { kind: "failed"; value: { relPath: string; message: string } }
			| undefined
		)[] = new Array(total);
		let next = 0;
		let done = 0;

		const worker = async (): Promise<void> => {
			for (;;) {
				const i = next;
				next += 1;
				if (i >= total) return;
				const item = items[i];
				try {
					const info = await this.uploadFile(item.relPath, item.absPath);
					slots[i] = {
						kind: "ok",
						value: {
							relPath: item.relPath,
							rev: info.rev,
							size: info.size,
							contentHash: info.contentHash,
						},
					};
				} catch (e) {
					slots[i] = { kind: "failed", value: { relPath: item.relPath, message: errorMessage(e) } };
				}
				done += 1;
				try {
					onProgress?.(done, total, item.relPath);
				} catch (e) {
					this.logger?.warn("uploadMany onProgress 回调失败", e);
				}
			}
		};

		const workers = Math.min(this.concurrency, Math.max(total, 1));
		await Promise.all(Array.from({ length: workers }, () => worker()));

		const ok: { relPath: string; rev: string; size: number; contentHash?: string }[] = [];
		const failed: { relPath: string; message: string }[] = [];
		for (const slot of slots) {
			if (!slot) continue;
			if (slot.kind === "ok") ok.push(slot.value);
			else failed.push(slot.value);
		}
		return { ok, failed };
	}
}
