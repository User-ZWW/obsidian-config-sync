import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { LocalFileEntry, Logger } from "./types.ts";
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
	/**
	 * 【追加】结构化来源。原契约只留了 sourceLabel（给人看的字符串），
	 * apply() 拿不到来源就无法判断「该逐个下载还是该解压快照 zip」，故追加此字段。
	 * 缺失时 apply() 按镜像还原处理（向后兼容旧计划 / 手工构造的计划）。
	 */
	source?: RestoreSource;
	/**
	 * 【追加】给确认弹窗显示的警告文本（例如「来源里一个文件都没有，而本地有 300 个」）。
	 * 只做提示，不影响 toWrite / toDelete 的判定。可能为空数组。
	 */
	warnings?: string[];
}

/** 【追加】还原来源的结构化描述（见 RestorePlan.source） */
export type RestoreSource =
	| { kind: "mirror" }
	| { kind: "snapshot"; snapshot: SnapshotRecord; zipPath?: string };

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
	/** 注入点：默认用 src/snapshot/zip.ts 的 createZipFromFiles */
	zipCurrent?: (outZipPath: string) => Promise<{ bytes: number; entries: number }>;
	/** 注入点：默认用 src/snapshot/zip.ts 的 extractZipTo / listZipEntries */
	listZip?: (zipPath: string) => Promise<{ relPath: string; size: number }[]>;
	extractZip?: (
		zipPath: string,
		destDir: string,
		filter?: (relPath: string) => boolean,
	) => Promise<{ entries: number }>;
}

export interface RestoreResult {
	written: number;
	deleted: number;
	/** 留底 zip 的绝对路径 */
	safetyZip: string;
	errors: { relPath: string; message: string }[];
	/**
	 * 【追加】true = 用户在确认弹窗点了「取消」，什么都没改（written/deleted 必为 0、safetyZip 为 ""）。
	 * 用返回值而不是抛异常来表示取消，是因为「取消」不是错误，UI 侧要能平静地区分两种结局。
	 */
	cancelled?: boolean;
}

/* 【追加】onProgress 的 phase 取值（用户可见文案，顺序：留底 → 还原 → 删除） */
export const RESTORE_PHASE_BACKUP = "留底";
export const RESTORE_PHASE_WRITE = "还原";
export const RESTORE_PHASE_DELETE = "删除";

/** 与 SnapshotManager 的默认 subDir 保持一致；快照压缩包不是配置内容，绝不参与还原 */
const SNAPSHOT_DIR_NAME = "_snapshots";

/** Windows 文件名里非法的字符（用于校验远端/zip 内的条目名） */
const ILLEGAL_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * 防呆还原：
 *   1. preview() 只读，生成 RestorePlan
 *   2. apply() 必须先创建留底 zip（当前整个 .obsidian），再逐个下载写入
 *   3. 默认不删本地独有文件；includeDelete=true 才删
 *   4. apply 必须接受一个 confirm 回调，返回 false 就整体放弃（不改任何文件）
 *
 * 实现上额外落实的防呆（方向都是「宁可什么都不做」）：
 *   - confirm 缺失 → 直接抛错，不做任何事（不允许调用方绕开确认）
 *   - 留底 zip 必须真的落盘且非空，否则整轮中止，一个文件都不碰
 *   - 留底为空却还要删文件 → 中止（删了就没得救了）
 *   - 写入/删除前再跑一遍 matcher 与路径校验，拦住越出 configDir 的相对路径、盘符路径
 *   - 来源里一个文件都没有而本地有文件 → 写进 warnings，让确认弹窗显式提示
 *
 * 已知限制（README 里如实写明，不美化）：镜像预览只比较「相对路径 + 字节大小」。
 * Dropbox 的 content_hash 不是 SHA-256，无法和本地 sha256 对比；为了预览不下载 344MB，
 * 也就无法发现「同名同大小但内容被本地改过」的文件 —— 这种文件会被判为 unchanged。
 */
export class RestoreManager {
	private deps: RestoreDeps;
	/** 快照 zip 的本地中转目录，懒建，用完 dispose() 清掉 */
	private tmpRoot: string | null = null;

	constructor(deps: RestoreDeps) {
		this.deps = deps;
	}

	async preview(source: { kind: "mirror" } | { kind: "snapshot"; snapshot: SnapshotRecord }): Promise<RestorePlan> {
		const local = await this.listLocalFiles();
		if (source.kind === "mirror") {
			const remote = await this.deps.client.listFolderRecursive();
			return this.buildPlan(
				local,
				remote.map((r) => ({ relPath: r.relPath, size: r.size })),
				"镜像目录（Dropbox 上的当前状态）",
				{ kind: "mirror" },
			);
		}
		const zipPath = await this.ensureSnapshotZip(source.snapshot);
		const entries = await this.listZipEntries(zipPath);
		return this.buildPlan(local, entries, `快照 ${source.snapshot.name}`, {
			kind: "snapshot",
			snapshot: source.snapshot,
			zipPath,
		});
	}

	async apply(
		plan: RestorePlan,
		opts: { includeDelete?: boolean; confirm: (plan: RestorePlan) => Promise<boolean> },
	): Promise<RestoreResult> {
		if (typeof opts?.confirm !== "function") {
			throw new Error("apply 必须提供 confirm 回调：防呆还原不允许跳过确认。");
		}
		const includeDelete = opts.includeDelete === true;
		const logger = this.deps.logger;
		const root = path.resolve(this.deps.configDir);

		// 落盘前的二次校验：计划可能是旧的，也可能是别处手工构造的，一律重跑规则与路径校验
		const writes: { relPath: string; absPath: string; size: number }[] = [];
		for (const item of plan.toWrite ?? []) {
			const rel = normalizeRelPath(item?.relPath);
			if (rel === null || !this.deps.matcher(rel, false)) continue;
			writes.push({ relPath: rel, absPath: path.join(root, ...rel.split("/")), size: item.size });
		}
		const deletes: string[] = [];
		if (includeDelete) {
			for (const raw of plan.toDelete ?? []) {
				const rel = normalizeRelPath(raw);
				if (rel === null || !this.deps.matcher(rel, false)) continue;
				deletes.push(rel);
			}
		}

		// ① 先问人。取消 = 什么都不改，也就没必要留底。
		const approved = await opts.confirm(plan);
		if (!approved) {
			await this.dispose();
			logger?.info("还原：用户取消，未改动任何文件");
			return { written: 0, deleted: 0, safetyZip: "", errors: [], cancelled: true };
		}

		const errors: { relPath: string; message: string }[] = [];
		const willChange = writes.length > 0 || deletes.length > 0;

		// ② 再留底。留底失败 = 抛错，且此时一个字节都没改。
		let safetyZip = "";
		if (willChange) safetyZip = await this.createSafetyZip(deletes.length);

		// ③ 写回
		let written = 0;
		if (writes.length > 0) {
			const source = plan.source;
			if (source && source.kind === "snapshot") {
				written = await this.writeFromSnapshot(source, writes, errors);
			} else {
				written = await this.writeFromRemote(writes, errors);
			}
		}

		// ④ 删（只在显式要求时）
		let deleted = 0;
		if (deletes.length > 0) deleted = await this.deleteLocal(deletes, errors);

		await this.dispose();
		logger?.info(
			`还原结束：写入 ${written}、删除 ${deleted}、失败 ${errors.length}、留底 ${safetyZip || "（无改动，未留底）"}`,
		);
		return { written, deleted, safetyZip, errors };
	}

	/** 【追加】清掉还原中间产物（快照 zip 的本地副本）。apply() 结束时会自动调用 */
	async dispose(): Promise<void> {
		const dir = this.tmpRoot;
		this.tmpRoot = null;
		if (!dir) return;
		try {
			await fsp.rm(dir, { recursive: true, force: true });
		} catch {
			/* 清理失败不该影响还原结果 */
		}
	}

	/* ============================ 内部：预览 ============================ */

	/**
	 * 把「来源条目 + 本地现状」压成计划。镜像与快照共用这条路径，
	 * 保证两种来源的判定口径完全一致（同相对路径同大小 = unchanged）。
	 */
	private buildPlan(
		local: Map<string, LocalFileEntry>,
		sourceEntries: { relPath: string; size: number }[],
		sourceLabel: string,
		source: RestoreSource,
	): RestorePlan {
		const logger = this.deps.logger;
		const toWrite: { relPath: string; size: number }[] = [];
		const sourceSeen = new Set<string>();
		let unchanged = 0;
		let skippedByRules = 0;
		let skippedSnapshotArchives = 0;
		let bytesToDownload = 0;

		for (const raw of sourceEntries) {
			const rel = normalizeRelPath(raw?.relPath);
			if (rel === null) {
				skippedByRules++;
				continue;
			}
			if (isSnapshotArchivePath(rel)) {
				// 快照 zip 是备份产物不是配置内容：误还原等于把几百 MB 的包塞回 .obsidian
				skippedSnapshotArchives++;
				skippedByRules++;
				continue;
			}
			if (!this.deps.matcher(rel, false)) {
				skippedByRules++;
				continue;
			}
			if (sourceSeen.has(rel)) continue; // 同一路径重复出现（zip 允许重复条目）只算一次
			sourceSeen.add(rel);
			const size = Number.isFinite(raw.size) && raw.size >= 0 ? raw.size : 0;
			const localFile = local.get(rel);
			if (localFile && localFile.size === size) {
				unchanged++;
				continue;
			}
			toWrite.push({ relPath: rel, size });
			bytesToDownload += size;
		}

		const toDelete: string[] = [];
		for (const rel of local.keys()) {
			if (!sourceSeen.has(rel)) toDelete.push(rel);
		}
		// 排序让计划可复现（也方便用户逐条核对）
		toWrite.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
		toDelete.sort();

		const warnings: string[] = [];
		if (sourceSeen.size === 0 && local.size > 0) {
			warnings.push(
				`来源里没有任何处于同步范围的文件，而本地有 ${local.size} 个。请先确认远端目录（含 vault 子目录）与授权是否正确，不要盲目继续。`,
			);
		}
		if (toDelete.length > 0) {
			warnings.push(
				`本地有 ${toDelete.length} 个文件在来源中不存在：默认不会动它们，只有勾选「同时删除本地多余文件」才会删。`,
			);
		}
		if (skippedSnapshotArchives > 0) {
			logger?.debug(`还原预览：跳过 ${skippedSnapshotArchives} 个快照压缩包条目`);
		}
		if (skippedByRules > 0) {
			logger?.debug(`还原预览：${skippedByRules} 个来源条目被同步规则排除`);
		}

		return { toWrite, toDelete, unchanged, sourceLabel, bytesToDownload, skippedByRules, source, warnings };
	}

	/* ============================ 内部：留底 ============================ */

	/**
	 * 还原前留底：把「当前 configDir 的全部同步范围内文件」打成一个带时间戳的 zip。
	 * 严格失败：zipCurrent 抛错、zip 没落盘、zip 为空却还要删文件 —— 三种情况一律抛错，
	 * 保证调用方是在「一个文件都没改」的状态下收到异常。
	 *
	 * 对注入点的要求：zipCurrent 必须真的把 zip 写到 outZipPath（返回值不能是编的），
	 * 否则本模块会拒绝继续 —— 这是留底这道防呆线的判定依据。
	 */
	private async createSafetyZip(plannedDeletes: number): Promise<string> {
		const dir = this.resolveSafetyDir();
		await fsp.mkdir(dir, { recursive: true });
		const outZipPath = path.join(dir, buildSafetyZipName(new Date()));
		const zipCurrent = this.deps.zipCurrent ?? ((p: string) => this.defaultZipCurrent(p));

		this.deps.onProgress?.(RESTORE_PHASE_BACKUP, 0, 1);
		let res: { bytes: number; entries: number };
		try {
			res = await zipCurrent(outZipPath);
		} catch (e) {
			throw new Error(`留底 zip 创建失败，已中止还原（未改动任何文件）：${errMsg(e)}`);
		}

		const st = await fsp.stat(outZipPath).catch(() => null);
		if (!st || !st.isFile() || st.size <= 0) {
			throw new Error(`留底 zip 没有真正落盘（${outZipPath}），已中止还原（未改动任何文件）`);
		}
		if (res.entries <= 0 && plannedDeletes > 0) {
			throw new Error(
				`留底 zip 是空的（0 个条目）却要删除 ${plannedDeletes} 个文件，已中止还原（未改动任何文件）`,
			);
		}
		this.deps.onProgress?.(RESTORE_PHASE_BACKUP, 1, 1);
		this.deps.logger?.info(`还原：已留底 → ${outZipPath}（${res.entries} 个条目 / ${res.bytes} 字节）`);
		return outZipPath;
	}

	/** 留底目录：设置为空时退回 vault 根下的 .obsidian-safety-snapshots（与 DEFAULT_EXCLUDES 的约定一致） */
	private resolveSafetyDir(): string {
		const raw = (this.deps.safetyDir ?? "").trim();
		if (raw) return path.resolve(raw);
		return path.join(path.resolve(path.dirname(this.deps.configDir)), ".obsidian-safety-snapshots");
	}

	private async defaultZipCurrent(outZipPath: string): Promise<{ bytes: number; entries: number }> {
		const files = [...(await this.listLocalFiles()).values()];
		const zip = await zipModule();
		return zip.createZipFromFiles(this.deps.configDir, files, outZipPath);
	}

	/* ============================ 内部：写入 / 删除 ============================ */

	/** 镜像来源：逐个下载写回。单个文件失败不中断整轮，计入 errors。 */
	private async writeFromRemote(
		items: { relPath: string; absPath: string; size: number }[],
		errors: { relPath: string; message: string }[],
	): Promise<number> {
		let written = 0;
		const total = items.length;
		this.deps.onProgress?.(RESTORE_PHASE_WRITE, 0, total);
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			try {
				await fsp.mkdir(path.dirname(item.absPath), { recursive: true });
				await this.deps.client.downloadFile(item.relPath, item.absPath);
				written++;
				const st = await fsp.stat(item.absPath).catch(() => null);
				if (st && st.size !== item.size) {
					this.deps.logger?.debug(
						`还原：${item.relPath} 下载后大小 ${st.size} 与计划 ${item.size} 不同（远端在此期间变过？）`,
					);
				}
			} catch (e) {
				errors.push({ relPath: item.relPath, message: errMsg(e) });
				this.deps.logger?.warn(`还原失败 ${item.relPath}：${errMsg(e)}`);
			}
			this.deps.onProgress?.(RESTORE_PHASE_WRITE, i + 1, total);
		}
		return written;
	}

	/** 快照来源：下载一次快照 zip，然后按计划白名单解压 */
	private async writeFromSnapshot(
		source: { kind: "snapshot"; snapshot: SnapshotRecord; zipPath?: string },
		items: { relPath: string; absPath: string; size: number }[],
		errors: { relPath: string; message: string }[],
	): Promise<number> {
		const wanted = new Set(items.map((i) => i.relPath));
		let zipPath: string;
		try {
			zipPath = await this.ensureSnapshotZip(source.snapshot, source.zipPath);
		} catch (e) {
			errors.push({ relPath: source.snapshot.remotePath, message: `快照下载失败：${errMsg(e)}` });
			return 0;
		}

		const extract = this.deps.extractZip ?? (await zipModule()).extractZipTo;
		this.deps.onProgress?.(RESTORE_PHASE_WRITE, 0, wanted.size);
		try {
			const res = await extract(zipPath, path.resolve(this.deps.configDir), (rel: string) => {
				const norm = normalizeRelPath(rel);
				return norm !== null && wanted.has(norm) && this.deps.matcher(norm, false);
			});
			this.deps.onProgress?.(RESTORE_PHASE_WRITE, wanted.size, wanted.size);
			return res?.entries ?? 0;
		} catch (e) {
			errors.push({ relPath: source.snapshot.name, message: `快照解压失败：${errMsg(e)}` });
			return 0;
		}
	}

	private async deleteLocal(rels: string[], errors: { relPath: string; message: string }[]): Promise<number> {
		const root = path.resolve(this.deps.configDir);
		let deleted = 0;
		this.deps.onProgress?.(RESTORE_PHASE_DELETE, 0, rels.length);
		for (let i = 0; i < rels.length; i++) {
			const rel = rels[i];
			try {
				const abs = path.join(root, ...rel.split("/"));
				const back = path.relative(root, abs);
				if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
					throw new Error("目标越出配置目录");
				}
				await fsp.rm(abs, { force: true });
				deleted++;
			} catch (e) {
				errors.push({ relPath: rel, message: errMsg(e) });
			}
			this.deps.onProgress?.(RESTORE_PHASE_DELETE, i + 1, rels.length);
		}
		return deleted;
	}

	/* ============================ 内部：本地扫描 / 快照 zip ============================ */

	/**
	 * 列出 configDir 下所有「通过 matcher」的文件（relPath → 条目）。
	 * 直接走 fs，不复用 src/scan/scanner.ts：还原只需要路径与大小，不要 hash、不要 excluded 统计，
	 * 而且这里必须能脱离其他模块单测。
	 * 跳过符号链接与 junction（避免死循环）；单个条目读不动就跳过，不整轮失败。
	 */
	private async listLocalFiles(): Promise<Map<string, LocalFileEntry>> {
		const out = new Map<string, LocalFileEntry>();
		const root = path.resolve(this.deps.configDir);
		const rootStat = await fsp.stat(root).catch(() => null);
		if (!rootStat || !rootStat.isDirectory()) return out;

		const walk = async (absDir: string): Promise<void> => {
			let dirents;
			try {
				dirents = await fsp.readdir(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const d of dirents) {
				const abs = path.join(absDir, d.name);
				if (d.isSymbolicLink()) continue;
				if (d.isDirectory()) {
					await walk(abs);
					continue;
				}
				if (!d.isFile()) continue;
				const rel = toRelPath(root, abs);
				if (!this.deps.matcher(rel, false)) continue;
				const st = await fsp.stat(abs).catch(() => null);
				if (!st || !st.isFile()) continue;
				out.set(rel, { relPath: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs });
			}
		};
		await walk(root);
		return out;
	}

	private async ensureSnapshotZip(snapshot: SnapshotRecord, existingZipPath?: string): Promise<string> {
		if (existingZipPath) {
			const usable = await fsp.access(existingZipPath, fs.constants.R_OK).then(
				() => true,
				() => false,
			);
			if (usable) return existingZipPath;
		}
		const dir = await this.ensureTmpDir();
		const dest = path.join(dir, safeFileName(snapshot.name || "snapshot.zip"));
		this.deps.logger?.info(`还原：下载快照 ${snapshot.remotePath} → ${dest}`);
		await this.deps.client.downloadFile(snapshot.remotePath, dest);
		const st = await fsp.stat(dest).catch(() => null);
		if (!st || !st.isFile() || st.size <= 0) {
			throw new Error(`快照下载结果为空：${snapshot.remotePath}`);
		}
		return dest;
	}

	private async listZipEntries(zipPath: string): Promise<{ relPath: string; size: number }[]> {
		const listZip = this.deps.listZip ?? (await zipModule()).listZipEntries;
		return listZip(zipPath);
	}

	private async ensureTmpDir(): Promise<string> {
		if (!this.tmpRoot) {
			this.tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "obsidian-config-restore-"));
		}
		return this.tmpRoot;
	}
}

/* ============================ 追加的导出工具函数 ============================ */

/**
 * 【追加】把来源（Dropbox / zip 内部）的路径规范成对外统一的 relPath：
 * '/' 分隔、无前导 '/'、无 './'、无 '..'、无盘符。
 * 非法时返回 null，调用方必须跳过该条目（防路径穿越、防写到 configDir 之外）。
 */
export function normalizeRelPath(raw: string): string | null {
	if (typeof raw !== "string") return null;
	const s = raw.replace(/\\/g, "/").trim();
	if (s === "") return null;
	if (s.startsWith("/")) return null; // 绝对路径
	if (/^[A-Za-z]:/.test(s)) return null; // 盘符
	const out: string[] = [];
	for (const seg of s.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") return null; // 不许上跳
		if (ILLEGAL_NAME_CHARS.test(seg)) return null; // Windows 上根本建不出来
		out.push(seg);
	}
	if (out.length === 0) return null;
	return out.join("/");
}

/**
 * 【追加】留底 zip 的文件名，例如 obsidian-config-safety-2026-10-16T21-30-00-123.zip。
 * 带毫秒是为了「同一秒内跑两次还原」不会互相覆盖掉留底。
 */
export function buildSafetyZipName(d: Date): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	const stamp =
		`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
		`T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
	return `obsidian-config-safety-${stamp}.zip`;
}

/* ============================ 内部小工具 ============================ */

function isSnapshotArchivePath(rel: string): boolean {
	return rel.split("/").includes(SNAPSHOT_DIR_NAME);
}

function toRelPath(rootDir: string, absPath: string): string {
	return path.relative(rootDir, absPath).split(path.sep).join("/");
}

function safeFileName(name: string): string {
	const base = path.basename(name.replace(/\\/g, "/")).replace(ILLEGAL_NAME_CHARS, "_");
	return base === "" || base === "." || base === ".." ? "snapshot.zip" : base;
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

/** 默认实现的 zip 模块懒加载：测试全部走注入点，正常路径也不会多付出加载成本 */
async function zipModule(): Promise<typeof import("./snapshot/zip.ts")> {
	return import("./snapshot/zip.ts");
}
