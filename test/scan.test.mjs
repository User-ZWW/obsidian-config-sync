/**
 * 扫描层测试（Phase 2 Agent B）：排除规则匹配器 + 递归扫描 + sha256。
 *
 * 全部用真实临时目录 fixture（test/.tmp/scan-<随机>/）驱动，测试结束清理。
 * 运行：node --test --test-reporter=spec test/scan.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileMatcher, matchesPattern, ancestorPaths } from "../src/scan/exclude.ts";
import { scanDir, sha256File, toRelPath } from "../src/scan/scanner.ts";
import { DEFAULT_EXCLUDES } from "../src/config/defaults.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));

let tmpRoot = "";
/** 扫描 fixture 的根目录 */
const rootDir = () => path.join(tmpRoot, "root");

/** fixture 内容表；key = 相对 root 的 '/' 路径 */
const FIXTURE_FILES = {
	".git/config": "gitconfig",
	".git/objects/pack/x.pack": "PACKDATA",
	"icons/big.svg": "<svg/>",
	"icons/nested/deep.svg": "<svg-deep/>",
	"plugins/插件备份 1/data.json": '{"a":1}',
	"plugins/插件备份 2/x.bin": "BINARY",
	"plugins/foo/插件备份 9/y.json": '{"nested-backup":true}',
	"plugins/foo/main.js": "console.log(1)",
	"plugins/foo/data.json": '{"b":2}',
	"plugins/foo/sub/deep.json": '{"c":3}',
	"plugins/obsidian-git/config.json": '{"git":1}',
	"plugins/obsidian-git/state.txt": "state",
	"snippets/a.css": "body{}",
	"snippets/中文名.css": "p{}",
	"snippets/deep/nested.css": "div{}",
	"workspace.json": '{"ws":1}',
	"workspace-mobile.json": '{"ws":2}',
	"graph.json": "{}",
	"appearance.json": '{"theme":"dark"}',
	"a/workspace.json": '{"nested":true}',
	"notes/.DS_Store": "DS",
	"notes/keep.md": "# hi",
	"draft.tmp": "tmpdata",
};

/** 用 DEFAULT_EXCLUDES 扫描后的期望结果（含 big.bin，不含 draft.tmp 等） */
const EXPECTED_SYNCED = [
	"appearance.json",
	"big.bin",
	"notes/keep.md",
	"plugins/foo/data.json",
	"plugins/foo/main.js",
	"plugins/foo/sub/deep.json",
	"plugins/obsidian-git/state.txt",
	"snippets/a.css",
	"snippets/deep/nested.css",
	"snippets/中文名.css",
];

const BIG_SIZE = 4096;

before(async () => {
	await mkdir(path.join(testDir, ".tmp"), { recursive: true });
	tmpRoot = await mkdtemp(path.join(testDir, ".tmp", "scan-"));
	for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
		const abs = path.join(rootDir(), ...rel.split("/"));
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
	await writeFile(path.join(rootDir(), "big.bin"), Buffer.alloc(BIG_SIZE, 7));
});

after(async () => {
	if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

/** 结果索引成 map，方便按路径断言 */
function byPath(res) {
	const m = new Map();
	for (const f of res.files) m.set(f.relPath, f);
	return m;
}

/* ============================ exclude.ts ============================ */

test("matchesPattern：'*' 不跨 '/'，'**' 跨层级，'?' 单字符，结尾 '/' 只匹配目录", () => {
	// 无 '/' 的模式：匹配任意层级的同名条目
	assert.equal(matchesPattern("a.json", "*.json"), true);
	assert.equal(matchesPattern("x/y/a.json", "*.json"), true);
	// 有 '/' 的模式：从根锚定，且 '*' 不跨 '/'
	assert.equal(matchesPattern("x/y.json", "x/*.json"), true);
	assert.equal(matchesPattern("x/y/z.json", "x/*.json"), false);
	assert.equal(matchesPattern("y.json", "x/*.json"), false);
	// '**' 匹配任意层级（含零层）
	assert.equal(matchesPattern("z.tmp", "**/*.tmp"), true);
	assert.equal(matchesPattern("x/y/z.tmp", "**/*.tmp"), true);
	assert.equal(matchesPattern("a/b/c", "a/**/c"), true);
	assert.equal(matchesPattern("a/c", "a/**/c"), true);
	assert.equal(matchesPattern("a/x/y/c", "a/**/c"), true);
	assert.equal(matchesPattern("a/b/c", "a/**"), true);
	assert.equal(matchesPattern("a", "a/**"), false);
	// '?' 恰好一个字符
	assert.equal(matchesPattern("ab.json", "a?.json"), true);
	assert.equal(matchesPattern("abc.json", "a?.json"), false);
	assert.equal(matchesPattern("a.json", "a?.json"), false);
	// 结尾 '/' 只匹配目录
	assert.equal(matchesPattern("icons", "icons/", true), true);
	assert.equal(matchesPattern("icons", "icons/", false), false);
	assert.equal(matchesPattern("x/y", "x/", false), false);
	// 正则特殊字符当字面量
	assert.equal(matchesPattern("a.b", "a.b"), true);
	assert.equal(matchesPattern("axb", "a.b"), false);
	assert.equal(matchesPattern("a+b", "a+b"), true);
	assert.equal(matchesPattern("aab", "a+b"), false);
	// 不支持的 '!' 取反当字面量处理
	assert.equal(matchesPattern("!foo", "!foo"), true);
	assert.equal(matchesPattern("foo", "!foo"), false);
	// 前导 '/' 表示锚定到根
	assert.equal(matchesPattern("x/icons", "/icons", false), false);
	assert.equal(matchesPattern("icons", "/icons", false), true);
});

test("compileMatcher：白名单空 = 全通过；白名单非空时只放行命中项（含目录）", () => {
	const all = compileMatcher({ includePatterns: [], excludePatterns: [] });
	assert.equal(all("anything/x.txt"), true);
	assert.equal(all("deep/a/b/c.bin"), true);

	const onlySnippets = compileMatcher({ includePatterns: ["snippets/"], excludePatterns: [] });
	assert.equal(onlySnippets("snippets/a.css"), true);
	assert.equal(onlySnippets("snippets/deep/nested.css"), true);
	assert.equal(onlySnippets("snippets", true), true);
	assert.equal(onlySnippets("plugins/foo.js"), false);
	assert.equal(onlySnippets("appearance.json"), false);
});

test("compileMatcher：目录被排除时其子项一并排除，且不误伤同类文件", () => {
	const m = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	// 三个体积大户
	assert.equal(m("icons", true), false);
	assert.equal(m("icons/big.svg"), false);
	assert.equal(m("icons/nested/deep.svg"), false);
	assert.equal(m(".git/config"), false);
	assert.equal(m(".git/objects/pack/x.pack"), false);
	assert.equal(m("plugins/插件备份 1/data.json"), false);
	assert.equal(m("plugins/foo/插件备份 9/y.json"), false);
	// 会话态
	assert.equal(m("workspace.json"), false);
	assert.equal(m("workspace-mobile.json"), false);
	assert.equal(m("a/workspace.json"), false);
	assert.equal(m("graph.json"), false);
	// 插件运行时数据 + 杂项
	assert.equal(m("plugins/obsidian-git/config.json"), false);
	assert.equal(m("notes/.DS_Store"), false);
	assert.equal(m("draft.tmp"), false);
	// 不该误伤
	assert.equal(m("plugins/foo/data.json"), true);
	assert.equal(m("plugins/foo/main.js"), true);
	assert.equal(m("plugins/obsidian-git/state.txt"), true);
	assert.equal(m("appearance.json"), true);
	assert.equal(m("snippets/中文名.css"), true);
	assert.equal(m("snippets/deep/nested.css"), true);
});

test("compileMatcher：先白名单后黑名单", () => {
	const m = compileMatcher({ includePatterns: ["**/*.json"], excludePatterns: ["**/secret*.json"] });
	assert.equal(m("plugins/foo/data.json"), true);
	assert.equal(m("a/b/c.json"), true);
	assert.equal(m("secret1.json"), false);
	assert.equal(m("x/secret-x.json"), false);
	assert.equal(m("plugins/foo/main.js"), false);
});

test("ancestorPaths 返回自身与所有祖先", () => {
	assert.deepEqual(ancestorPaths("a/b/c"), ["a", "a/b", "a/b/c"]);
	assert.deepEqual(ancestorPaths("a"), ["a"]);
	assert.deepEqual(ancestorPaths(""), []);
	assert.deepEqual(ancestorPaths("/a//b"), ["a", "a/b"]);
});

/* ============================ scanner.ts ============================ */

test("scanDir：按 DEFAULT_EXCLUDES 排除、计算 sha256、按 relPath 排序", async () => {
	const matcher = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	const res = await scanDir({
		rootDir: rootDir(),
		matcher,
		useHash: true,
		maxFileSizeBytes: 10 * 1024 * 1024,
		concurrency: 4,
	});

	const m = byPath(res);
	assert.equal(res.files.length, EXPECTED_SYNCED.length);
	assert.deepEqual([...m.keys()].sort(), [...EXPECTED_SYNCED].sort());

	// 排序：应等于自身排序后的副本
	const rels = res.files.map((f) => f.relPath);
	assert.deepEqual(rels, [...rels].sort());

	// 被排除的路径确实不在结果里
	const mustBeGone = [
		"icons/big.svg",
		"icons/nested/deep.svg",
		".git/config",
		"workspace.json",
		"workspace-mobile.json",
		"graph.json",
		"a/workspace.json",
		"notes/.DS_Store",
		"draft.tmp",
		"plugins/插件备份 1/data.json",
		"plugins/foo/插件备份 9/y.json",
		"plugins/obsidian-git/config.json",
	];
	for (const p of mustBeGone) assert.equal(m.has(p), false, `${p} 不该被同步`);

	// 每条记录的字段
	for (const f of res.files) {
		assert.equal(f.relPath.includes("\\"), false, `relPath 必须用 '/'：${f.relPath}`);
		assert.equal(path.isAbsolute(f.absPath), true);
		assert.equal(f.absPath, path.join(rootDir(), ...f.relPath.split("/")));
		assert.match(f.hash, /^[0-9a-f]{64}$/, `hash 形态不对：${f.relPath}`);
		assert.equal(typeof f.size, "number");
		assert.equal(typeof f.mtimeMs, "number");
	}

	// 已知内容的 sha256（与独立计算的哈希比对）
	const a = m.get("snippets/a.css");
	assert.equal(a.hash, createHash("sha256").update("body{}", "utf8").digest("hex"));
	assert.equal(a.size, Buffer.byteLength("body{}", "utf8"));
	assert.equal(m.get("big.bin").size, BIG_SIZE);

	// 计数：5 个被剪枝的目录 + 7 个被排除的文件
	// 剪枝目录 = .git, icons, plugins/插件备份 1, plugins/插件备份 2, plugins/foo/插件备份 9
	// 排除文件 = workspace.json, workspace-mobile.json, graph.json, a/workspace.json,
	//            notes/.DS_Store, draft.tmp, plugins/obsidian-git/config.json
	assert.equal(res.excluded, 12);
	assert.equal(res.skippedBig, 0);
	assert.equal(res.unreadable, 0);

	// totalBytes = 各文件 size 之和
	const sum = res.files.reduce((acc, f) => acc + f.size, 0);
	assert.equal(res.totalBytes, sum);
	assert.ok(res.durationMs >= 0);
});

test("scanDir：两次扫描结果顺序一致（可复现）", async () => {
	const matcher = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	const opts = { rootDir: rootDir(), matcher, useHash: true, maxFileSizeBytes: 1024 * 1024, concurrency: 2 };
	const a = await scanDir(opts);
	const b = await scanDir(opts);
	assert.deepEqual(
		a.files.map((f) => [f.relPath, f.hash]),
		b.files.map((f) => [f.relPath, f.hash]),
	);
});

test("scanDir：超过 maxFileSizeBytes 的文件计入 skippedBig 且不进入结果", async () => {
	const matcher = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	const res = await scanDir({
		rootDir: rootDir(),
		matcher,
		useHash: false,
		maxFileSizeBytes: 100,
		concurrency: 3,
	});
	const m = byPath(res);
	assert.equal(res.skippedBig, 1);
	assert.equal(m.has("big.bin"), false);
	assert.equal(res.files.length, EXPECTED_SYNCED.length - 1);
	// useHash=false 时不应写 hash 字段
	for (const f of res.files) {
		assert.equal("hash" in f, false, `useHash=false 不该有 hash：${f.relPath}`);
	}
});

test("scanDir：onProgress 逐条上报且序号单调递增", async () => {
	const seen = [];
	const matcher = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	const res = await scanDir({
		rootDir: rootDir(),
		matcher,
		useHash: false,
		maxFileSizeBytes: 10 * 1024 * 1024,
		concurrency: 2,
		onProgress: (scanned, relPath) => seen.push([scanned, relPath]),
	});
	assert.equal(seen.length, res.files.length + res.skippedBig);
	for (let i = 0; i < seen.length; i++) assert.equal(seen[i][0], i + 1);
	// 上报的路径集合应与结果一致
	assert.deepEqual(
		seen.map((s) => s[1]).sort(),
		res.files.map((f) => f.relPath).sort(),
	);
});

test("scanDir：跳过 junction / 符号链接，不越界、不死循环", async (t) => {
	const outside = path.join(tmpRoot, "outside");
	await mkdir(outside, { recursive: true });
	await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

	// Windows 上 'junction' 不需要管理员权限；POSIX 上该参数被忽略，等价普通目录链接
	try {
		await symlink(outside, path.join(rootDir(), "linked-dir"), "junction");
		// 自指向根目录的链接：跟随就会无限递归
		await symlink(rootDir(), path.join(rootDir(), "loop"), "junction");
	} catch (err) {
		t.skip(`当前环境不允许创建目录链接，跳过：${err.code ?? err.message}`);
		return;
	}

	const matcher = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	const res = await scanDir({
		rootDir: rootDir(),
		matcher,
		useHash: true,
		maxFileSizeBytes: 10 * 1024 * 1024,
		concurrency: 2,
	});
	const m = byPath(res);
	assert.equal(m.has("linked-dir"), false);
	assert.equal(m.has("linked-dir/secret.txt"), false, "不该跟随目录链接越界");
	assert.equal(m.has("loop"), false, "不该跟随自指向链接");
	for (const f of res.files) assert.equal(f.relPath.startsWith("loop/"), false, "死循环未终止");
	// 普通文件仍照常同步
	assert.equal(m.has("appearance.json"), true);

	// 文件级符号链接：Windows 非管理员可能建不了，能建就一起验
	try {
		await symlink(path.join(outside, "secret.txt"), path.join(rootDir(), "linked.txt"), "file");
	} catch {
		return; // 建不了就只验目录链接
	}
	const res2 = await scanDir({
		rootDir: rootDir(),
		matcher,
		useHash: false,
		maxFileSizeBytes: 10 * 1024 * 1024,
		concurrency: 2,
	});
	assert.equal(byPath(res2).has("linked.txt"), false, "不该同步文件链接");
});

test("scanDir：rootDir 不存在时返回空结果而不抛错", async () => {
	const res = await scanDir({
		rootDir: path.join(tmpRoot, "no-such-dir"),
		matcher: () => true,
		useHash: true,
		maxFileSizeBytes: 10 * 1024 * 1024,
		concurrency: 2,
	});
	assert.deepEqual(res.files, []);
	assert.equal(res.totalBytes, 0);
	assert.equal(res.excluded, 0);
});

/* ============================ 工具函数 ============================ */

test("toRelPath 生成 '/' 分隔、无前导 '/' 的相对路径", () => {
	assert.equal(toRelPath(rootDir(), path.join(rootDir(), "a", "b.txt")), "a/b.txt");
	assert.equal(toRelPath(rootDir(), path.join(rootDir(), "中文 目录", "x.cfg")), "中文 目录/x.cfg");
	assert.equal(toRelPath(rootDir(), rootDir()), "");
	const rel = toRelPath(rootDir(), path.join(rootDir(), "snippets", "deep", "nested.css"));
	assert.equal(rel.includes("\\"), false);
	assert.equal(rel, "snippets/deep/nested.css");
});

test("sha256File 与 node:crypto 独立计算一致", async () => {
	const p = path.join(rootDir(), "big.bin");
	const expected = createHash("sha256").update(Buffer.alloc(BIG_SIZE, 7)).digest("hex");
	assert.equal(await sha256File(p), expected);
	// 与扫描结果里的哈希一致
	const res = await scanDir({
		rootDir: rootDir(),
		matcher: compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES }),
		useHash: true,
		maxFileSizeBytes: 10 * 1024 * 1024,
		concurrency: 2,
	});
	assert.equal(byPath(res).get("big.bin").hash, expected);
});
