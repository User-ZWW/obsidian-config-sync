/**
 * 递归扫描层：把一个目录树（通常是 vault 的 .obsidian）扫成待同步文件清单。
 *
 * 设计要点：
 *   - 只依赖 node 内置模块，不 import "obsidian"，可用 node --test 直接跑。
 *   - 排除规则由外部注入的 matcher 决定（见 scan/exclude.ts 的 compileMatcher）。
 *   - 符号链接 / junction 一律跳过，避免死循环与越界同步。
 *   - 任何单条目的读取失败都只跳过该条目，不让整轮扫描失败。
 */

import type { LocalFileEntry } from "../types.ts";
import type { Dirent, Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export interface ScanOptions {
	/** 要扫描的根目录绝对路径，例如 …\\<vault>\\.obsidian */
	rootDir: string;
	/** 由 compileMatcher 产生；返回 false 的文件不进入结果（但要计入 excluded） */
	matcher: (relPath: string, isDir?: boolean) => boolean;
	/** true 时对每个文件算 sha256（慢）；false 时只用 size+mtimeMs */
	useHash: boolean;
	/** 超过此字节数的文件跳过并计入 skippedBig */
	maxFileSizeBytes: number;
	/** 并发哈希的并发数 */
	concurrency: number;
	/** 进度回调 */
	onProgress?: (scanned: number, relPath: string) => void;
}

export interface ScanResult {
	files: LocalFileEntry[];
	/** 被规则排除的条目数（文件 + 目录；被剪枝的目录整棵子树只计 1 条） */
	excluded: number;
	/** 因超过 maxFileSizeBytes 被跳过的文件数 */
	skippedBig: number;
	totalBytes: number;
	/** 扫描耗时（毫秒） */
	durationMs: number;
	/**
	 * ★ 追加字段（Phase 2 Agent B）：因 lstat / 读取 / 哈希失败而无法获得完整信息的条目数。
	 *   可选，避免影响其他模块构造的字面量。正常扫描为 0。
	 */
	unreadable?: number;
}

/** 按 relPath 升序（UTF-16 code unit，跨平台可复现） */
function compareRelPath(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * 递归扫描 rootDir，产出参与同步的文件清单。
 *
 * 要求：
 *   - 跳过符号链接与 junction，避免死循环
 *   - 跳过无法读取的条目并继续（不要整轮失败）
 *   - relPath 用 '/' 分隔
 *   - 结果按 relPath 升序排序（稳定性：让差异计划可复现）
 */
export async function scanDir(opts: ScanOptions): Promise<ScanResult> {
	const startedAt = Date.now();
	const rootDir = path.resolve(opts.rootDir);
	const maxBytes =
		typeof opts.maxFileSizeBytes === "number" && Number.isFinite(opts.maxFileSizeBytes)
			? opts.maxFileSizeBytes
			: Number.POSITIVE_INFINITY;

	const files: LocalFileEntry[] = [];
	let excluded = 0;
	let skippedBig = 0;
	let unreadable = 0;
	let scanned = 0;

	const reportProgress = (relPath: string): void => {
		scanned++;
		if (opts.onProgress) opts.onProgress(scanned, relPath);
	};

	const walk = async (absDir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fsp.readdir(absDir, { withFileTypes: true });
		} catch {
			// 目录读不了（权限 / 竞争删除）——跳过整棵子树，不中断本轮
			return;
		}
		for (const ent of entries) {
			const absPath = path.join(absDir, ent.name);
			const relPath = toRelPath(rootDir, absPath);
			let st: Stats;
			try {
				st = await fsp.lstat(absPath);
			} catch {
				// 条目在扫描过程中消失 / 无权限
				unreadable++;
				continue;
			}
			if (st.isSymbolicLink()) {
				// 跳过符号链接与 junction（Windows 上 junction 也报为 symlink）
				continue;
			}
			if (st.isDirectory()) {
				if (!opts.matcher(relPath, true)) {
					// 目录被排除：整棵子树剪枝，只计 1 条（不再深入枚举内部文件）
					excluded++;
					continue;
				}
				await walk(absPath);
				continue;
			}
			if (!st.isFile()) {
				// 其他类型（socket / fifo / 设备文件等）不参与同步
				continue;
			}
			if (!opts.matcher(relPath, false)) {
				excluded++;
				continue;
			}
			if (st.size > maxBytes) {
				skippedBig++;
				reportProgress(relPath);
				continue;
			}
			files.push({
				relPath,
				absPath,
				size: st.size,
				mtimeMs: st.mtimeMs,
			});
			reportProgress(relPath);
		}
	};

	await walk(rootDir);
	files.sort((a, b) => compareRelPath(a.relPath, b.relPath));

	const resultFiles = opts.useHash ? await hashFiles(files, opts.concurrency, () => unreadable++) : files;

	let totalBytes = 0;
	for (const f of resultFiles) totalBytes += f.size;

	return {
		files: resultFiles,
		excluded,
		skippedBig,
		totalBytes,
		durationMs: Date.now() - startedAt,
		unreadable,
	};
}

/**
 * 并发为文件列表计算 sha256；读取失败的文件被剔除（并调用 onDrop 计数）。
 * 保持输入顺序（按已排好序的 relPath），便于 diff 可复现。
 */
async function hashFiles(
	entries: LocalFileEntry[],
	concurrency: number,
	onDrop: () => void,
): Promise<LocalFileEntry[]> {
	if (entries.length === 0) return entries;
	const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, entries.length));
	const hashes: (string | null)[] = new Array(entries.length).fill(null);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= entries.length) return;
			try {
				hashes[i] = await sha256File(entries[i].absPath);
			} catch {
				hashes[i] = null;
			}
		}
	};
	await Promise.all(Array.from({ length: limit }, () => worker()));

	const out: LocalFileEntry[] = [];
	for (let i = 0; i < entries.length; i++) {
		const h = hashes[i];
		if (h === null) {
			onDrop();
			continue;
		}
		entries[i].hash = h;
		out.push(entries[i]);
	}
	return out;
}

/** 算 sha256 十六进制小写 */
export async function sha256File(absPath: string): Promise<string> {
	const hash = createHash("sha256");
	const rs = createReadStream(absPath);
	// 流式读取，避免把大文件整体读进内存
	for await (const chunk of rs) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

/** 把绝对路径转成相对 rootDir 的 '/' 分隔相对路径 */
export function toRelPath(rootDir: string, absPath: string): string {
	const rel = path.relative(rootDir, absPath);
	// 跨平台：Windows 的 path.sep 是 '\'，对外统一成 '/'
	return rel.split(path.sep).join("/");
}
