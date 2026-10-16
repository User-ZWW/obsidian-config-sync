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
 *
 * 大小写：按 gitignore 默认行为**区分大小写**（与本项目 DEFAULT_EXCLUDES 的字面量一致）。
 */

export interface MatcherOptions {
	includePatterns: string[];
	excludePatterns: string[];
}

/** 单条模式编译后的形态 */
interface CompiledPattern {
	/** 原始（已 trim）模式，便于调试 */
	source: string;
	/** 结尾带 '/'，只匹配目录 */
	dirOnly: boolean;
	/** 对完整 relPath 做整串匹配的正则 */
	regex: RegExp;
}

/** 转义正则里有特殊含义的字符（'*' / '?' 已单独处理，不会走到这里） */
function escapeRegexChar(c: string): string {
	return /[.*+?^${}()|[\]\\]/.test(c) ? "\\" + c : c;
}

/**
 * 把一条已归一化（无前导 '/'、无结尾 '/'、非空）的模式编译成正则源码。
 * anchored=true 表示从根锚定；false 表示按 basename 在任意层级匹配。
 */
function patternToRegexSource(pattern: string, anchored: boolean): string {
	const n = pattern.length;
	let src = anchored ? "" : "(?:.*/)?";
	let i = 0;
	while (i < n) {
		const c = pattern[i];
		if (c === "/") {
			src += "/";
			i++;
			continue;
		}
		// 只有"整段就是 **"时才具备跨层级语义（前后是 '/' 或字符串边界）
		if (c === "*" && pattern[i + 1] === "*" && (i === 0 || pattern[i - 1] === "/")) {
			const afterIsBoundary = i + 2 >= n || pattern[i + 2] === "/";
			if (afterIsBoundary) {
				const atStart = i === 0;
				const atEnd = i + 2 >= n;
				if (atStart && atEnd) {
					// 模式就是 "**"：匹配任意内容
					src += ".*";
					i += 2;
					continue;
				}
				if (atStart) {
					// "**/" 前缀：零个或多个前导目录段（如 **/.DS_Store、**/*.tmp）
					src += "(?:[^/]+/)*";
					i += 3; // 吃掉 "**/"
					continue;
				}
				if (atEnd) {
					// "a/**"：a 目录下的任意内容（含更深层级）
					src += ".*";
					i += 2;
					continue;
				}
				// 中间 "**/"：零个或多个中间目录段（如 a/**/b）
				src += "(?:[^/]+/)*";
				i += 3;
				continue;
			}
			// 段内出现 '**'（如 a**b）退化成普通 '*' —— 不跨 '/'
		}
		if (c === "*") {
			src += "[^/]*";
			i++;
			continue;
		}
		if (c === "?") {
			src += "[^/]";
			i++;
			continue;
		}
		src += escapeRegexChar(c);
		i++;
	}
	return src;
}

/** 编译单条模式；空模式 / 纯注释返回 null（调用方跳过） */
function compilePattern(raw: string): CompiledPattern | null {
	let p = typeof raw === "string" ? raw.trim() : "";
	if (p === "") return null;
	let dirOnly = false;
	// 结尾一个或多个 '/' => 只匹配目录
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.replace(/\/+$/, "");
	}
	if (p === "") return null;
	// 去掉结尾 '/' 之后仍含 '/'（或原本以 '/' 开头）=> 从根锚定
	const anchored = p.includes("/");
	// 去掉前导 '/'（gitignore 里前导 '/' 也表示锚定，此处锚定已由上面判定）
	p = p.replace(/^\/+/, "");
	if (p === "") return null;
	return {
		source: raw,
		dirOnly,
		regex: new RegExp("^" + patternToRegexSource(p, anchored) + "$"),
	};
}

/** 把 relPath 归一化成 '/' 分隔、无前导 '/'、无结尾 '/' 的形态 */
function normalizeRelPath(relPath: string): string {
	let p = String(relPath ?? "").replace(/\\/g, "/");
	p = p.replace(/^\.\//, "");
	p = p.replace(/\/+/g, "/");
	p = p.replace(/^\/+/, "");
	p = p.replace(/\/+$/, "");
	return p;
}

/** 用编译结果判定单个路径 */
function testCompiled(cp: CompiledPattern, relPath: string, isDir: boolean): boolean {
	if (relPath === "") return false;
	if (cp.dirOnly && !isDir) return false;
	return cp.regex.test(relPath);
}

/**
 * 路径（或其任一祖先目录）是否被模式集合命中。
 * 祖先目录命中时，其下所有子项都视为命中（gitignore 的目录剪枝语义）。
 */
function coveredBy(patterns: CompiledPattern[], relPath: string, isDir: boolean): boolean {
	for (const cp of patterns) {
		if (testCompiled(cp, relPath, isDir)) return true;
	}
	const ancestors = ancestorPaths(relPath);
	// 最后一项就是自身，已单独判定过；这里只遍历父目录（必为目录）
	for (let i = 0; i < ancestors.length - 1; i++) {
		for (const cp of patterns) {
			if (testCompiled(cp, ancestors[i], true)) return true;
		}
	}
	return false;
}

/**
 * 返回 shouldSync(relPath) —— true = 纳入同步。
 * relPath 用 '/' 分隔、无前导 './'。
 *
 * 规则：先看 includePatterns（空数组 = 全通过）；
 *      命中的再被 excludePatterns 否决。
 *      目录被排除时，其子项也应被排除（调用方可以直接对每个 relPath 调用，
 *      实现需保证 'icons/' 能排除 'icons/foo.svg'）。
 *
 * 约定：relPath 为空字符串（根目录本身）一律返回 false。
 */
export function compileMatcher(opts: MatcherOptions): (relPath: string, isDir?: boolean) => boolean {
	const includes: CompiledPattern[] = [];
	for (const raw of opts.includePatterns ?? []) {
		const cp = compilePattern(raw);
		if (cp) includes.push(cp);
	}
	const excludes: CompiledPattern[] = [];
	for (const raw of opts.excludePatterns ?? []) {
		const cp = compilePattern(raw);
		if (cp) excludes.push(cp);
	}
	return (relPath: string, isDir = false): boolean => {
		const p = normalizeRelPath(relPath);
		if (p === "") return false;
		// 白名单非空时必须命中（自身或某个被白名单命中的祖先目录）
		if (includes.length > 0 && !coveredBy(includes, p, isDir)) return false;
		// 黑名单命中即否决
		if (excludes.length > 0 && coveredBy(excludes, p, isDir)) return false;
		return true;
	};
}

/**
 * 单个模式匹配判定（供测试与 UI 预览用）。
 *
 * 语义：只拿 relPath 本身（不考虑其祖先目录）去匹配单条 pattern。
 * 目录剪枝（祖先命中）由 compileMatcher 负责，不在这里做。
 */
export function matchesPattern(relPath: string, pattern: string, isDir = false): boolean {
	const cp = compilePattern(pattern);
	if (!cp) return false;
	return testCompiled(cp, normalizeRelPath(relPath), isDir);
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
