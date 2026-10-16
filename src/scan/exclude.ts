/**
 * 同步范围匹配器：实现 gitignore 的一个子集。
 *
 * 支持的语法（不支持的语法一律当字面量处理，不要悄悄放宽）：
 *   `*`    匹配单段内的任意字符（不跨 '/'）
 *   `**`   匹配任意层级（含零层）
 *   `?`    匹配单个字符
 *   结尾 `/` 只匹配目录（调用方需传 isDir）
 *   无 '/' 的模式匹配任意层级下的同名条目（gitignore 风格），例如 `workspace.json`
 *   有 '/' 的模式从根开始锚定，例如 `plugins/插件备份*`
 *
 * 不支持 `!` 取反。
 */

export interface MatcherOptions {
	includePatterns: string[];
	excludePatterns: string[];
}

/**
 * 返回 shouldSync(relPath) —— true = 纳入同步。
 * relPath 用 '/' 分隔、无前导 './'。
 *
 * 规则：先看 includePatterns（空数组 = 全通过）；
 *      命中的再被 excludePatterns 否决。
 *      目录被排除时，其子项也应被排除（调用方可以直接对每个 relPath 调用，
 *      实现需保证 'icons/' 能排除 'icons/foo.svg'）。
 */
export function compileMatcher(opts: MatcherOptions): (relPath: string, isDir?: boolean) => boolean {
	throw new Error("not implemented: compileMatcher");
}

/** 单个模式匹配判定（供测试与 UI 预览用） */
export function matchesPattern(relPath: string, pattern: string, isDir = false): boolean {
	throw new Error("not implemented: matchesPattern");
}

/**
 * 给定一个 relPath，返回它以及所有祖先目录，例如
 * 'a/b/c' → ['a', 'a/b', 'a/b/c']
 */
export function ancestorPaths(relPath: string): string[] {
	const parts = relPath.split("/").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join("/"));
	return out;
}
