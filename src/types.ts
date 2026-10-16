/**
 * 全项目共享类型契约。
 *
 * ★ 并行开发时的冻结契约：任何 agent 都不得修改本文件中已存在的签名或字段名。
 *   需要新增能力时只能"追加"，并在返回摘要里明确说明追加了什么。
 *   原因：其他 agent 正在并行按这里的签名写实现，改动既有签名会导致互相编译不过。
 */

/* ============================ 本地 / 远端条目 ============================ */

/** 一条本地文件记录 */
export interface LocalFileEntry {
	/** 相对 configDir 的路径，统一用 '/' 分隔，无前导 './'，无前导 '/' */
	relPath: string;
	/** 绝对路径（Windows 反斜杠形式，由 path.join 产生） */
	absPath: string;
	size: number;
	/** 毫秒时间戳 */
	mtimeMs: number;
	/** 精确模式下的 sha256 十六进制小写；快速模式下为 undefined */
	hash?: string;
}

/** 远端（Dropbox）一条文件记录 */
export interface RemoteFileEntry {
	/** 相对远端根目录（即 baseDir）的路径，'/' 分隔，无前导 '/' */
	relPath: string;
	size: number;
	rev: string;
	/** Dropbox server_modified，ISO 字符串 */
	serverModified: string;
	/** Dropbox content_hash（与 sha256 不同，仅供变更判断，不可当 sha256 用） */
	contentHash?: string;
}

/* ============================ 同步索引 ============================ */

/** 上一次成功上传后记录的一行 */
export interface IndexEntry {
	size: number;
	mtimeMs: number;
	hash?: string;
	/** 上传成功后 Dropbox 返回的 rev */
	rev: string;
	/** ISO 时间 */
	uploadedAt: string;
}

/** 本地同步索引，持久化在插件 data.json 里 */
export interface SyncIndex {
	version: number;
	/** ISO 时间；从未同步过则为 null */
	lastSyncAt: string | null;
	/** key = relPath */
	entries: Record<string, IndexEntry>;
}

/** 一次同步的差异计划 */
export interface DiffPlan {
	toUpload: LocalFileEntry[];
	/** 远端存在、本地已无（镜像删除模式才非空） */
	toDelete: string[];
	/** 数量：完全没变的文件 */
	unchanged: number;
	/** 数量：被规则排除、不参与同步的文件 */
	excluded: number;
}

export type TriggerKind = "manual" | "interval" | "watch" | "startup";

export interface SyncError {
	relPath: string;
	message: string;
}

export interface SyncRunResult {
	trigger: TriggerKind;
	/** ISO 时间 */
	startedAt: string;
	finishedAt: string;
	uploaded: number;
	deleted: number;
	/** 数量：判定无变化而跳过的文件 */
	skipped: number;
	bytesUploaded: number;
	errors: SyncError[];
	/** 本次生成的快照在远端的路径（若生成） */
	snapshotPath?: string;
	dryRun: boolean;
}

/* ============================ HTTP 抽象 ============================ */

/**
 * HTTP 抽象层：核心逻辑只依赖这个接口，生产环境注入 Obsidian 的 requestUrl
 * 实现（绕 CORS），测试环境注入 node 实现。这样核心逻辑可以脱离 Obsidian 测试。
 */
export interface HttpRequest {
	url: string;
	method: "GET" | "POST";
	headers?: Record<string, string>;
	/** JSON 字符串或二进制体；GET 时必须为空 */
	body?: string | ArrayBuffer | Uint8Array | null;
	responseType?: "json" | "arraybuffer" | "text";
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	/** responseType === 'json' 时有效 */
	json?: unknown;
	/** responseType === 'arraybuffer' 时有效 */
	arrayBuffer?: ArrayBuffer;
	/** responseType === 'text' 时有效 */
	text?: string;
}

export interface HttpClient {
	request(req: HttpRequest): Promise<HttpResponse>;
}

/* ============================ Dropbox ============================ */

/** Dropbox 认证凭据（持久化在 data.json 里） */
export interface DropboxTokens {
	/** App Console 里的 App key */
	appKey: string;
	/** App secret 留空 —— 我们用 PKCE，不需要 secret */
	appSecret?: string;
	accessToken?: string;
	refreshToken?: string;
	/** 毫秒时间戳，accessToken 的过期时刻 */
	expiresAt?: number;
	accountId?: string;
	accountName?: string;
	email?: string;
}

export interface DropboxSpaceUsage {
	used: number;
	allocated: number;
}

export interface DropboxAccountInfo {
	accountId: string;
	name: string;
	email: string;
}

/* ============================ 日志 ============================ */

export interface Logger {
	debug(msg: string, ...args: unknown[]): void;
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
}

/* ============================ 设置 ============================ */

export interface PluginSettings {
	/** Dropbox 凭据与远端位置 */
	dropbox: DropboxTokens;
	/** 远端根目录，绝对路径风格，形如 '/Obsidian-Config-Backup' */
	remoteBaseDir: string;
	/** 本地回调模式监听的端口 */
	redirectPort: number;
	/** callback = 本地 http 回调；manual = 不传 redirect_uri，手动粘贴授权码 */
	authMode: "callback" | "manual";

	/** 同步范围：includePatterns 为白名单（空 = 全部），excludePatterns 为黑名单 */
	includePatterns: string[];
	excludePatterns: string[];

	/** 镜像行为 */
	mirrorDelete: boolean;
	useHash: boolean;
	concurrency: number;
	/** 单文件大小上限，超过则跳过；单位 MB */
	maxFileSizeMB: number;

	/** 触发 */
	syncOnChange: boolean;
	changeDebounceSec: number;
	/** 0 = 关闭定时同步 */
	intervalMinutes: number;
	startupDelaySec: number;

	/** 快照 */
	snapshotEnabled: boolean;
	snapshotMode: "every-run" | "daily";
	snapshotKeep: number;

	/** 还原：还原前安全留底目录（绝对路径，留空则用默认值） */
	safetyDir: string;
	/** 还原是否需要二次确认弹窗 */
	confirmBeforeRestore: boolean;

	logLevel: "quiet" | "info" | "debug";
	/** 上次同步结果摘要，供状态栏显示 */
	lastResultSummary?: string;
}
