import type { LocalFileEntry } from "../types.ts";

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
	throw new Error("not implemented: createZipFromFiles");
}

/** 用 yauzl 列出 zip 内条目（不解压） */
export async function listZipEntries(zipPath: string): Promise<{ relPath: string; size: number }[]> {
	throw new Error("not implemented: listZipEntries");
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
	throw new Error("not implemented: extractZipTo");
}
