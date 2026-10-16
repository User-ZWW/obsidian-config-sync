import type { LocalFileEntry } from "../types.ts";

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
	/** 被规则排除的条目数（文件 + 目录） */
	excluded: number;
	/** 因超过 maxFileSizeBytes 被跳过的文件数 */
	skippedBig: number;
	totalBytes: number;
	/** 扫描耗时（毫秒） */
	durationMs: number;
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
	throw new Error("not implemented: scanDir");
}

/** 算 sha256 十六进制小写 */
export async function sha256File(absPath: string): Promise<string> {
	throw new Error("not implemented: sha256File");
}

/** 把绝对路径转成相对 rootDir 的 '/' 分隔相对路径 */
export function toRelPath(rootDir: string, absPath: string): string {
	throw new Error("not implemented: toRelPath");
}
