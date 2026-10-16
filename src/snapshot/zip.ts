import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import * as yazl from "yazl";
import * as yauzl from "yauzl";

import type { LocalFileEntry } from "../types.ts";

/**
 * 把 absPath 换算成 zip 内部条目名。
 *
 * 优先用调用方给的 relPath（保证与索引/远端路径完全一致），
 * 但它必须落在 rootDir 之内 —— 否则宁可抛错，也不要写出一个能"逃出去"的条目名。
 */
function toEntryName(rootDir: string, absPath: string, relPath: string): string {
	const candidates: string[] = [];
	const given = relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
	if (given) candidates.push(given);
	candidates.push(path.relative(rootDir, absPath).split(path.sep).join("/"));
	for (const rel of candidates) {
		if (!rel) continue;
		if (path.posix.isAbsolute(rel)) continue;
		if (rel === ".." || rel.startsWith("../")) continue;
		return rel;
	}
	throw new Error(`文件不在 rootDir 之下，无法放进 zip：${absPath}`);
}

/**
 * 用 yazl 生成 zip。流式写盘，不把整个包读进内存。
 * 路径用 '/'，保持与 relPath 一致。
 */
export async function createZipFromFiles(
	rootDir: string,
	files: LocalFileEntry[],
	outZipPath: string,
	opts?: { onProgress?: (done: number, total: number) => void },
): Promise<{ bytes: number; entries: number }> {
	const onProgress = opts ? opts.onProgress : undefined;
	const total = files.length;

	await fs.promises.mkdir(path.dirname(outZipPath), { recursive: true });

	const zip = new yazl.ZipFile();
	let entries = 0;
	for (const f of files) {
		const absPath = path.isAbsolute(f.absPath) ? f.absPath : path.join(rootDir, f.absPath);
		let size: number;
		let mtimeMs: number;
		try {
			const st = await fs.promises.stat(absPath);
			if (!st.isFile()) continue;
			size = st.size;
			mtimeMs = st.mtimeMs;
		} catch {
			continue; // 扫描之后文件被删/被换走了：跳过，不能整包失败
		}
		const name = toEntryName(rootDir, absPath, f.relPath);
		// 大小以磁盘现状为准：yazl 用它预计算头部，给错数字会产出坏包
		zip.addFile(absPath, name, { mtime: new Date(f.mtimeMs || mtimeMs), size });
		entries++;
		if (onProgress) onProgress(entries, total);
	}

	// 大 vault（>4GB 或条目数超 65535）需要 zip64，直接强制开启，避免中途才报错
	zip.end({ forceZip64Format: true });
	await pipeline(zip.outputStream, fs.createWriteStream(outZipPath));

	const st = await fs.promises.stat(outZipPath);
	return { bytes: st.size, entries };
}

/**
 * 目录条目判断。yauzl 的 Entry 并没有 isDirectory() 方法
 * （shims.d.ts 里那个声明是错的，但我们不能改它），目录条目只能靠名字结尾的 '/' 认。
 */
function isDirEntry(entry: yauzl.Entry): boolean {
	return entry.fileName.endsWith("/") || entry.fileName.endsWith("\\");
}

/** 校验过的条目路径：反斜杠转 '/'、去前导 '/'、去盘符、去尾部 '/' */
function normalizeEntryName(name: string): string {
	return name
		.replace(/\\/g, "/")
		.replace(/^[A-Za-z]:\//, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
			if (err || !zipfile) reject(err || new Error(`无法打开 zip：${zipPath}`));
			else resolve(zipfile);
		});
	});
}

/**
 * 逐条目驱动的公共骨架：调用方拿到 entry 后必须同步返回 Promise，
 * 骨架等它 settle 之后再 readEntry()，从而把 lazyEntries 变成顺序异步流程。
 */
function walkZip(
	zip: yauzl.ZipFile,
	handle: (entry: yauzl.Entry, zip: yauzl.ZipFile) => Promise<void>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (e: Error): void => {
			if (settled) return;
			settled = true;
			reject(e);
		};
		zip.on("entry", (entry) => {
			void (async () => {
				try {
					await handle(entry, zip);
					zip.readEntry();
				} catch (e) {
					fail(e instanceof Error ? e : new Error(String(e)));
				}
			})();
		});
		zip.on("end", () => {
			if (settled) return;
			settled = true;
			resolve();
		});
		zip.on("error", fail);
		zip.readEntry();
	});
}

/** 用 yauzl 列出 zip 内条目（不解压） */
export async function listZipEntries(zipPath: string): Promise<{ relPath: string; size: number }[]> {
	const zip = await openZip(zipPath);
	const out: { relPath: string; size: number }[] = [];
	try {
		await walkZip(zip, async (entry) => {
			if (isDirEntry(entry)) return;
			const rel = normalizeEntryName(entry.fileName);
			if (!rel) return;
			out.push({ relPath: rel, size: entry.uncompressedSize });
		});
	} finally {
		zip.close();
	}
	return out;
}

function writeEntryToDisk(zip: yauzl.ZipFile, entry: yauzl.Entry, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err || !stream) {
				reject(err || new Error(`无法读取 zip 条目：${entry.fileName}`));
				return;
			}
			const out = fs.createWriteStream(dest);
			let done = false;
			const fail = (e: Error): void => {
				if (done) return;
				done = true;
				stream.destroy();
				out.destroy();
				reject(e);
			};
			stream.on("error", fail);
			out.on("error", fail);
			out.on("close", () => {
				if (done) return;
				done = true;
				resolve();
			});
			stream.pipe(out);
		});
	});
}

/**
 * 把 zip 条目名解析成 destDir 内的绝对路径；越界（zip slip）时抛错。
 *
 * 单独导出是为了能直接对恶意条目名做单元测试：yauzl 自己会把 "../" 与绝对路径
 * 挡在 open 阶段，走完整流程反而测不到这一层，而这一层必须存在（换 zip 库、
 * 或库的默认校验变了，它就是最后一道闸）。
 */
export function safeExtractPath(destDir: string, entryName: string): string {
	const root = path.resolve(destDir);
	const rel = normalizeEntryName(entryName);
	const dest = path.resolve(root, rel);
	if (dest !== root && !dest.startsWith(root + path.sep)) {
		throw new Error(`zip slip 被拦截：条目 "${entryName}" 会写到 ${dest}`);
	}
	return dest;
}

/**
 * 解压到 destDir。filter 返回 false 的条目跳过。
 * 必须防 zip slip：条目路径规范化后不得逃出 destDir。
 */
export async function extractZipTo(
	zipPath: string,
	destDir: string,
	filter?: (relPath: string) => boolean,
): Promise<{ entries: number }> {
	const root = path.resolve(destDir);
	await fs.promises.mkdir(root, { recursive: true });

	const zip = await openZip(zipPath);
	let entries = 0;
	try {
		await walkZip(zip, async (entry) => {
			const rel = normalizeEntryName(entry.fileName);
			if (!rel) return; // 根目录条目
			// 安全检查放在 filter 之前：再怎么说也是恶意条目，不能被 filter 漏过去
			const dest = safeExtractPath(root, entry.fileName);
			if (filter && !filter(rel)) return;
			if (isDirEntry(entry)) {
				await fs.promises.mkdir(dest, { recursive: true });
				entries++;
				return;
			}
			await fs.promises.mkdir(path.dirname(dest), { recursive: true });
			await writeEntryToDisk(zip, entry, dest);
			entries++;
		});
	} finally {
		zip.close();
	}
	return { entries };
}
