/**
 * src/restore.ts 的真实测试（防呆还原）。
 *
 * 运行：node --test --test-reporter=spec test/restore.test.mjs
 *
 * 依赖策略（遵守 AGENTS.md 的并行开发约定）：
 *   - 绝不 import 其他 agent 还在写的模块（scanner / exclude / zip / manager 都不碰）
 *   - DropboxClient 用自造 fake（.mjs 里不需要类型断言）
 *   - zipCurrent / listZip / extractZip 三个注入点全部用测试自造实现
 *   - 临时文件只写 test/.tmp/restore-*，每个用例自己删自己的目录（不动别人的 test/.tmp/ 内容）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import yauzl from "yauzl";

import {
	RestoreManager,
	normalizeRelPath,
	buildSafetyZipName,
	RESTORE_PHASE_BACKUP,
	RESTORE_PHASE_WRITE,
	RESTORE_PHASE_DELETE,
} from "../src/restore.ts";

const TMP_ROOT = path.join(import.meta.dirname, ".tmp");
let seq = 0;

/** 每个用例一个独立沙盒：<test/.tmp>/restore-<n>/ .obsidian + 留底目录，用完自动删 */
async function sandbox(t, { local = {}, safetyDirRel = "safety" } = {}) {
	const dir = path.join(TMP_ROOT, `restore-${++seq}-${Math.random().toString(36).slice(2, 8)}`);
	const configDir = path.join(dir, ".obsidian");
	await fsp.mkdir(configDir, { recursive: true });
	for (const [rel, content] of Object.entries(local)) {
		const abs = path.join(configDir, ...rel.split("/"));
		await fsp.mkdir(path.dirname(abs), { recursive: true });
		await fsp.writeFile(abs, content);
	}
	const safetyDir = safetyDirRel === null ? "" : path.join(dir, safetyDirRel);
	t.after(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});
	return { dir, configDir, safetyDir };
}

/** 假的 DropboxClient：只实现还原真正会调到的两个方法，并记录调用 */
function makeClient(remote = [], onDownload) {
	const calls = { list: 0, downloads: [] };
	const client = {
		async listFolderRecursive() {
			calls.list++;
			return remote;
		},
		async downloadFile(relPath, destAbsPath) {
			calls.downloads.push(relPath);
			if (onDownload) return onDownload(relPath, destAbsPath);
			await fsp.mkdir(path.dirname(destAbsPath), { recursive: true });
			await fsp.writeFile(destAbsPath, `DOWNLOADED:${relPath}`);
		},
	};
	return { client, calls };
}

/** 简易 matcher：excluded 里的路径（或以其为目录前缀）一律不参与 */
function makeMatcher(excluded = []) {
	return (rel) => {
		if (typeof rel !== "string" || rel.startsWith("/") || rel.includes("..")) return false;
		return !excluded.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : p + "/"));
	};
}

/** 会真的写盘的 zipCurrent 假实现（还原要求留底必须落盘，否则中止） */
function makeZipCurrent(events, { content = "FAKE-ZIP-BYTES", entries = 3, throwError = false, skipWrite = false } = {}) {
	return async (outZipPath) => {
		events.push({ type: "zip", path: outZipPath });
		if (throwError) throw new Error("磁盘满了（测试模拟）");
		if (!skipWrite) {
			await fsp.mkdir(path.dirname(outZipPath), { recursive: true });
			await fsp.writeFile(outZipPath, content);
		}
		return { bytes: content.length, entries };
	};
}

function harness(deps) {
	return new RestoreManager({
		client: deps.client,
		configDir: deps.configDir,
		safetyDir: deps.safetyDir,
		matcher: deps.matcher,
		logger: deps.logger,
		onProgress: deps.onProgress,
		zipCurrent: deps.zipCurrent,
		listZip: deps.listZip,
		extractZip: deps.extractZip,
	});
}

async function listFilesRecursive(root) {
	const out = [];
	const walk = async (d) => {
		for (const e of await fsp.readdir(d, { withFileTypes: true })) {
			const abs = path.join(d, e.name);
			if (e.isDirectory()) await walk(abs);
			else out.push(path.relative(root, abs).split(path.sep).join("/"));
		}
	};
	await walk(root);
	return out.sort();
}

/* ========================================================================== */
/* 1. preview：镜像来源的差异分类                                              */
/* ========================================================================== */

test("preview(mirror) 按「路径 + 大小」正确分类 toWrite / unchanged / toDelete", async (t) => {
	const sb = await sandbox(t, {
		local: {
			"app.json": "x".repeat(100),
			"plugins/a/main.js": "x".repeat(300),
			"local-only.md": "本地独有",
		},
	});
	const { client } = makeClient([
		{ relPath: "app.json", size: 100, rev: "r1", serverModified: "2026-10-16T00:00:00Z" },
		{ relPath: "plugins/a/main.js", size: 999, rev: "r2", serverModified: "2026-10-16T00:00:00Z" },
		{ relPath: "themes/x.css", size: 5, rev: "r3", serverModified: "2026-10-16T00:00:00Z" },
	]);
	const mgr = harness({ client, configDir: sb.configDir, safetyDir: sb.safetyDir, matcher: makeMatcher() });

	const plan = await mgr.preview({ kind: "mirror" });

	assert.deepEqual(
		plan.toWrite.map((f) => f.relPath),
		["plugins/a/main.js", "themes/x.css"],
		"远端有而本地缺 / 大小不同 → 必须写回，且按 relPath 升序",
	);
	assert.equal(plan.toWrite[0].size, 999);
	assert.equal(plan.unchanged, 1, "app.json 两侧同大小 → unchanged");
	assert.deepEqual(plan.toDelete, ["local-only.md"], "本地独有文件进入 toDelete（但默认不删）");
	assert.equal(plan.bytesToDownload, 1004);
	assert.equal(plan.skippedByRules, 0);
	assert.equal(plan.source.kind, "mirror", "计划必须带上结构化来源");
	assert.match(plan.sourceLabel, /镜像/);
	assert.equal(plan.warnings.length, 1, "toDelete 非空时要给确认弹窗一条警告");
	assert.match(plan.warnings[0], /不会动它们/);
	assert.deepEqual(await listFilesRecursive(sb.configDir), ["app.json", "local-only.md", "plugins/a/main.js"]);
});

test("preview 把规则外条目、非法路径、快照压缩包都排除在计划之外", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x".repeat(10) } });
	const { client } = makeClient([
		{ relPath: "app.json", size: 10 },
		{ relPath: "icons/big.svg", size: 50 },
		{ relPath: "plugins/x/插件备份2024/a.js", size: 60 },
		{ relPath: "_snapshots/2026-10-16T21-30-00.zip", size: 70 },
		{ relPath: "../evil.txt", size: 80 },
		{ relPath: "/absolute.txt", size: 90 },
		{ relPath: "C:/win.txt", size: 91 },
		{ relPath: "bad:name.txt", size: 92 },
	]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(["icons/", "plugins/x/插件备份2024/"]),
	});

	const plan = await mgr.preview({ kind: "mirror" });

	assert.deepEqual(plan.toWrite, [], "除了 app.json 之外一个都进不来");
	assert.equal(plan.unchanged, 1);
	assert.equal(
		plan.skippedByRules,
		7,
		"2 个规则排除 + 1 个快照包 + 4 个非法路径，全部计入 skippedByRules",
	);
	assert.deepEqual(plan.toDelete, []);
});

test("规则空、本地空时 preview 不炸也不给警告", async (t) => {
	const sb = await sandbox(t, { local: {} });
	const { client } = makeClient([]);
	const mgr = harness({ client, configDir: sb.configDir, safetyDir: sb.safetyDir, matcher: makeMatcher() });
	const plan = await mgr.preview({ kind: "mirror" });
	assert.equal(plan.toWrite.length, 0);
	assert.equal(plan.toDelete.length, 0);
	assert.equal(plan.unchanged, 0);
	assert.deepEqual(plan.warnings, [], "两侧都空 → 不需要警告");
});

test("来源为空而本地有文件 → 给出「别盲目继续」的警告", async (t) => {
	const sb = await sandbox(t, { local: { "a.json": "x", "b/c.json": "yy" } });
	const { client } = makeClient([]);
	const mgr = harness({ client, configDir: sb.configDir, safetyDir: sb.safetyDir, matcher: makeMatcher() });
	const plan = await mgr.preview({ kind: "mirror" });
	assert.equal(plan.warnings.length, 2, "一条说「来源是空的」，一条说「不会自动删」");
	assert.match(plan.warnings[0], /没有任何处于同步范围的文件/);
	assert.match(plan.warnings[1], /2 个文件在来源中不存在/);
	assert.deepEqual(plan.toDelete, ["a.json", "b/c.json"]);
});

/* ========================================================================== */
/* 2. apply：确认 → 留底 → 写入 → 删除 的顺序与防呆                             */
/* ========================================================================== */

test("apply：先确认、再留底、后写入；默认不动本地独有文件", async (t) => {
	const sb = await sandbox(t, {
		local: { "app.json": "x".repeat(3), "local-only.md": "本地独有" },
	});
	const { client, calls } = makeClient([{ relPath: "app.json", size: 100 }]);
	const events = [];
	const phases = [];
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent(events),
		onProgress: (phase) => phases.push(phase),
	});

	const plan = await mgr.preview({ kind: "mirror" });
	assert.equal(plan.toWrite.length, 1);

	let confirmSawPlan = null;
	const res = await mgr.apply(plan, {
		confirm: async (p) => {
			confirmSawPlan = p;
			events.push({ type: "confirm" });
			return true;
		},
	});

	assert.equal(confirmSawPlan, plan, "confirm 必须拿到同一个计划对象");
	assert.deepEqual(
		events.map((e) => e.type),
		["confirm", "zip"],
		"顺序必须是 确认 → 留底（留底不能早于用户确认）",
	);
	assert.equal(res.written, 1);
	assert.equal(res.deleted, 0, "默认不删");
	assert.deepEqual(res.errors, []);
	assert.equal(res.cancelled, undefined);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "DOWNLOADED:app.json");
	assert.equal(await fsp.readFile(path.join(sb.configDir, "local-only.md"), "utf8"), "本地独有");
	assert.deepEqual(calls.downloads, ["app.json"], "unchanged 的文件不该被下载");
	assert.ok(res.safetyZip.startsWith(sb.safetyDir), "留底 zip 必须放在 safetyDir 里");
	assert.match(path.basename(res.safetyZip), /^obsidian-config-safety-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.zip$/);
	assert.ok((await fsp.stat(res.safetyZip)).size > 0);
	assert.deepEqual(
		phases,
		[RESTORE_PHASE_BACKUP, RESTORE_PHASE_BACKUP, RESTORE_PHASE_WRITE, RESTORE_PHASE_WRITE],
		"进度阶段顺序：留底(0/1,1/1) → 还原(0/1,1/1)",
	);
});

test("apply：includeDelete=true 才删本地独有文件，并把删除记进进度", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x", "orphan/a.md": "多余" } });
	const { client } = makeClient([{ relPath: "app.json", size: 4 }]);
	const phases = [];
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([]),
		onProgress: (phase) => phases.push(phase),
	});
	const plan = await mgr.preview({ kind: "mirror" });
	assert.deepEqual(plan.toDelete, ["orphan/a.md"]);

	const res = await mgr.apply(plan, { includeDelete: true, confirm: async () => true });

	assert.equal(res.written, 1);
	assert.equal(res.deleted, 1);
	assert.equal(fs.existsSync(path.join(sb.configDir, "orphan", "a.md")), false);
	assert.ok(phases.includes(RESTORE_PHASE_DELETE), "删除阶段也要报进度");
});

test("apply：confirm 返回 false → 一个字节都不改，也不留底", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "原内容", "local-only.md": "本地独有" } });
	const { client, calls } = makeClient([{ relPath: "app.json", size: 999 }]);
	const events = [];
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent(events),
	});
	const plan = await mgr.preview({ kind: "mirror" });

	const res = await mgr.apply(plan, { includeDelete: true, confirm: async () => false });

	assert.equal(res.cancelled, true);
	assert.equal(res.written, 0);
	assert.equal(res.deleted, 0);
	assert.equal(res.safetyZip, "");
	assert.deepEqual(res.errors, []);
	assert.deepEqual(calls.downloads, [], "取消后不许下载");
	assert.equal(events.filter((e) => e.type === "zip").length, 0, "取消后不许留底");
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "原内容");
	assert.equal(fs.existsSync(path.join(sb.configDir, "local-only.md")), true);
});

test("apply：没给 confirm 回调 → 直接抛错且什么都不做（防呆线不可绕过）", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "原内容" } });
	const { client, calls } = makeClient([{ relPath: "app.json", size: 999 }]);
	const mgr = harness({ client, configDir: sb.configDir, safetyDir: sb.safetyDir, matcher: makeMatcher() });
	const plan = await mgr.preview({ kind: "mirror" });

	await assert.rejects(() => mgr.apply(plan, {}), /confirm/);
	await assert.rejects(() => mgr.apply(plan, { confirm: null }), /confirm/);
	assert.deepEqual(calls.downloads, []);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "原内容");
});

test("apply：留底抛错 → 整轮中止，本地文件原样保留", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "原内容" } });
	const { client, calls } = makeClient([{ relPath: "app.json", size: 999 }]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([], { throwError: true }),
	});
	const plan = await mgr.preview({ kind: "mirror" });

	await assert.rejects(() => mgr.apply(plan, { confirm: async () => true }), /留底 zip 创建失败.*未改动任何文件/s);
	assert.deepEqual(calls.downloads, []);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "原内容");
});

test("apply：留底声称成功但没落盘 → 中止，不信返回值", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "原内容" } });
	const { client, calls } = makeClient([{ relPath: "app.json", size: 999 }]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([], { skipWrite: true }),
	});
	const plan = await mgr.preview({ kind: "mirror" });

	await assert.rejects(() => mgr.apply(plan, { confirm: async () => true }), /没有真正落盘/);
	assert.deepEqual(calls.downloads, []);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "原内容");
});

test("apply：留底为空却要删文件 → 中止（删了就没得救）", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x", "orphan.md": "多余" } });
	const { client, calls } = makeClient([{ relPath: "app.json", size: 4 }]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([], { entries: 0 }),
	});
	const plan = await mgr.preview({ kind: "mirror" });

	await assert.rejects(
		() => mgr.apply(plan, { includeDelete: true, confirm: async () => true }),
		/留底 zip 是空的（0 个条目）却要删除 1 个文件/,
	);
	assert.deepEqual(calls.downloads, []);
	assert.equal(fs.existsSync(path.join(sb.configDir, "orphan.md")), true);
});

test("apply：留底 zip 里装的是「还原前」的内容（真 yazl 包 + yauzl 读回）", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "旧配置", "plugins/p/main.js": "旧插件代码" } });
	const { client } = makeClient([
		{ relPath: "app.json", size: 12 },
		{ relPath: "plugins/p/main.js", size: 30 },
	]);

	// 注入一个用真 yazl 打包的 zipCurrent：内容 = 当前 configDir 下所有文件
	const zipCurrent = async (outZipPath) => {
		const files = await listFilesRecursive(sb.configDir);
		const zip = new yazl.ZipFile();
		for (const rel of files) zip.addFile(path.join(sb.configDir, ...rel.split("/")), rel);
		zip.end();
		await pipeline(zip.outputStream, fs.createWriteStream(outZipPath));
		return { bytes: (await fsp.stat(outZipPath)).size, entries: files.length };
	};
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent,
	});
	const plan = await mgr.preview({ kind: "mirror" });
	const res = await mgr.apply(plan, { confirm: async () => true });

	const names = await new Promise((resolve, reject) => {
		const out = [];
		yauzl.open(res.safetyZip, { lazyEntries: true }, (err, zip) => {
			if (err) return reject(err);
			zip.on("entry", (e) => {
				out.push(e.fileName);
				zip.readEntry();
			});
			zip.on("end", () => resolve(out.sort()));
			zip.on("error", reject);
			zip.readEntry();
		});
	});
	assert.deepEqual(names, ["app.json", "plugins/p/main.js"], "留底必须覆盖改动前的全部文件");
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "DOWNLOADED:app.json");
});

/* ========================================================================== */
/* 3. apply：路径安全                                                          */
/* ========================================================================== */

test("apply：拒写越出 configDir 的路径（.. / 绝对路径 / 盘符）", async (t) => {
	const sb = await sandbox(t, { local: {} });
	await fsp.writeFile(path.join(sb.dir, "外层文件.txt"), "外层");
	const { client, calls } = makeClient([]);
	const mgr = harness({ client, configDir: sb.configDir, safetyDir: sb.safetyDir, matcher: makeMatcher() });

	const plan = {
		toWrite: [
			{ relPath: "../evil.txt", size: 1 },
			{ relPath: "..\\evil2.txt", size: 1 },
			{ relPath: "/evil3.txt", size: 1 },
			{ relPath: "C:/evil4.txt", size: 1 },
			{ relPath: "bad:name.txt", size: 1 },
			{ relPath: "ok.txt", size: 12 },
		],
		toDelete: [],
		unchanged: 0,
		sourceLabel: "手工计划",
		bytesToDownload: 17,
		skippedByRules: 0,
		source: { kind: "mirror" },
	};

	const res = await mgr.apply(plan, { confirm: async () => true });

	assert.deepEqual(calls.downloads, ["ok.txt"], "只有合法路径被下载");
	assert.equal(res.written, 1);
	assert.equal(fs.existsSync(path.join(sb.dir, "evil.txt")), false);
	assert.equal(fs.existsSync(path.join(sb.dir, "evil2.txt")), false);
	assert.equal(fs.existsSync(path.join(sb.dir, "evil3.txt")), false);
	assert.equal(fs.existsSync(path.join(sb.configDir, "ok.txt")), true);
});

test("apply：matcher 之外的路径即使写在计划里也不会被碰", async (t) => {
	const sb = await sandbox(t, { local: { "icons/keep.svg": "本地图标" } });
	const { client, calls } = makeClient([]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(["icons/"]),
		zipCurrent: makeZipCurrent([]),
	});
	const plan = {
		toWrite: [{ relPath: "icons/big.svg", size: 9 }],
		toDelete: ["icons/keep.svg"],
		unchanged: 0,
		sourceLabel: "手工计划",
		bytesToDownload: 9,
		skippedByRules: 0,
		source: { kind: "mirror" },
	};

	const res = await mgr.apply(plan, { includeDelete: true, confirm: async () => true });

	assert.equal(res.written, 0);
	assert.equal(res.deleted, 0);
	assert.deepEqual(calls.downloads, []);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "icons", "keep.svg"), "utf8"), "本地图标");
});

test("apply：toDelete 里的恶意路径不会删到 configDir 之外", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x" } });
	await fsp.writeFile(path.join(sb.dir, "外层文件.txt"), "外层");
	const { client } = makeClient([{ relPath: "app.json", size: 1 }]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([]),
	});
	const plan = await mgr.preview({ kind: "mirror" });
	plan.toDelete = ["../外层文件.txt", "..\\外层文件.txt", "app.json"];

	const res = await mgr.apply(plan, { includeDelete: true, confirm: async () => true });

	assert.equal(res.deleted, 1, "只有合法条目被删");
	assert.equal(fs.existsSync(path.join(sb.dir, "外层文件.txt")), true, "外层文件必须还在");
	assert.equal(fs.existsSync(path.join(sb.configDir, "app.json")), false);
});

/* ========================================================================== */
/* 4. apply：单文件失败不中断整轮                                               */
/* ========================================================================== */

test("apply：某个文件下载失败 → 其余照常写入，失败进 errors", async (t) => {
	const sb = await sandbox(t, { local: {} });
	const { client, calls } = makeClient([], async (relPath, destAbsPath) => {
		if (relPath === "bad.json") throw new Error("HTTP 503");
		await fsp.mkdir(path.dirname(destAbsPath), { recursive: true });
		await fsp.writeFile(destAbsPath, `ok:${relPath}`);
	});
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([]),
	});
	const plan = {
		toWrite: [
			{ relPath: "a.json", size: 3 },
			{ relPath: "bad.json", size: 3 },
			{ relPath: "b/c.json", size: 3 },
		],
		toDelete: [],
		unchanged: 0,
		sourceLabel: "手工计划",
		bytesToDownload: 9,
		skippedByRules: 0,
		source: { kind: "mirror" },
	};

	const res = await mgr.apply(plan, { confirm: async () => true });

	assert.equal(res.written, 2);
	assert.equal(res.errors.length, 1);
	assert.equal(res.errors[0].relPath, "bad.json");
	assert.match(res.errors[0].message, /503/);
	assert.deepEqual(calls.downloads, ["a.json", "bad.json", "b/c.json"]);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "b", "c.json"), "utf8"), "ok:b/c.json");
});

/* ========================================================================== */
/* 5. 快照来源                                                                */
/* ========================================================================== */

test("preview(snapshot)：下载一次 zip、列条目后复用，计划带上快照来源", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x" } });
	const snapshot = {
		name: "2026-10-16T21-30-00.zip",
		remotePath: "vault/_snapshots/2026-10-16T21-30-00.zip",
		createdAt: "2026-10-16T21:30:00Z",
		size: 1234,
	};
	const { client, calls } = makeClient([], async (_rel, dest) => {
		await fsp.mkdir(path.dirname(dest), { recursive: true });
		await fsp.writeFile(dest, "FAKE-SNAPSHOT-ZIP");
	});
	const listed = [];
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(["icons/"]),
		listZip: async (zipPath) => {
			listed.push(zipPath);
			assert.equal(fs.existsSync(zipPath), true, "listZip 拿到的必须是已下载的真实文件");
			return [
				{ relPath: "app.json", size: 5 },
				{ relPath: "./snippets/x.css", size: 9 },
				{ relPath: "icons/big.svg", size: 7 },
				{ relPath: "_snapshots/older.zip", size: 99 },
			];
		},
	});

	const plan = await mgr.preview({ kind: "snapshot", snapshot });

	assert.deepEqual(calls.downloads, [snapshot.remotePath]);
	assert.deepEqual(listed, [plan.source.zipPath]);
	assert.equal(plan.source.kind, "snapshot");
	assert.equal(plan.source.snapshot, snapshot);
	assert.match(plan.sourceLabel, /2026-10-16T21-30-00\.zip/);
	assert.deepEqual(
		plan.toWrite.map((f) => f.relPath),
		["app.json", "snippets/x.css"],
		"./ 前缀被规范化；规则外的 icons/ 与 _snapshots/ 不进计划",
	);
	assert.equal(plan.skippedByRules, 2);
	assert.equal(plan.bytesToDownload, 14);
	assert.ok(plan.source.zipPath.startsWith(os.tmpdir()), "快照 zip 的本地副本落在系统临时目录");
});

test("apply(snapshot)：按计划白名单解压，只放行计划内的文件；结束清理临时 zip", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "旧" } });
	const snapshot = {
		name: "2026-10-16T21-30-00.zip",
		remotePath: "vault/_snapshots/2026-10-16T21-30-00.zip",
		createdAt: "2026-10-16T21:30:00Z",
		size: 1234,
	};
	const { client } = makeClient([], async (_rel, dest) => {
		await fsp.mkdir(path.dirname(dest), { recursive: true });
		await fsp.writeFile(dest, "FAKE-SNAPSHOT-ZIP");
	});
	const captured = {};
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(["icons/"]),
		zipCurrent: makeZipCurrent([]),
		listZip: async () => [
			{ relPath: "app.json", size: 5 },
			{ relPath: "snippets/x.css", size: 9 },
		],
		extractZip: async (zipPath, destDir, filter) => {
			captured.zipPath = zipPath;
			captured.destDir = destDir;
			captured.filter = filter;
			let n = 0;
			for (const rel of ["app.json", "snippets/x.css", "icons/big.svg", "other.md", "../evil.txt"]) {
				if (!filter(rel)) continue;
				const abs = path.join(destDir, ...rel.split("/"));
				await fsp.mkdir(path.dirname(abs), { recursive: true });
				await fsp.writeFile(abs, `FROM-SNAPSHOT:${rel}`);
				n++;
			}
			return { entries: n };
		},
	});

	const plan = await mgr.preview({ kind: "snapshot", snapshot });
	const res = await mgr.apply(plan, { confirm: async () => true });

	assert.equal(captured.destDir, sb.configDir);
	assert.equal(captured.filter("app.json"), true);
	assert.equal(captured.filter("./snippets/x.css"), true, "filter 要能吃下 ./ 前缀的条目名");
	assert.equal(captured.filter("icons/big.svg"), false, "规则外不放行");
	assert.equal(captured.filter("other.md"), false, "计划外不放行");
	assert.equal(captured.filter("../evil.txt"), false, "非法路径不放行");
	assert.equal(res.written, 2);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "snippets", "x.css"), "utf8"), "FROM-SNAPSHOT:snippets/x.css");
	assert.equal(fs.existsSync(path.join(sb.configDir, "icons", "big.svg")), false);
	assert.equal(
		fs.existsSync(path.dirname(captured.zipPath)),
		false,
		"apply 结束必须清掉快照 zip 的临时目录",
	);
});

test("apply(snapshot)：本地副本没了会重新下载；下载失败 → 记 error、不写文件、留底仍在", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "旧" } });
	const snapshot = {
		name: "2026-10-16T21-30-00.zip",
		remotePath: "vault/_snapshots/2026-10-16T21-30-00.zip",
		createdAt: "2026-10-16T21:30:00Z",
		size: 1234,
	};
	let failDownloads = false;
	const { client, calls } = makeClient([], async (_rel, dest) => {
		if (failDownloads) throw new Error("网络不可达");
		await fsp.mkdir(path.dirname(dest), { recursive: true });
		await fsp.writeFile(dest, "FAKE-SNAPSHOT-ZIP");
	});
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([]),
		listZip: async () => [{ relPath: "app.json", size: 5 }],
		extractZip: async () => {
			throw new Error("不该走到这里");
		},
	});

	const plan = await mgr.preview({ kind: "snapshot", snapshot });
	assert.equal(calls.downloads.length, 1);

	// 模拟「临时副本被系统清理掉了 / 拿的是隔夜的旧计划」→ apply 必须重新下载
	await mgr.dispose();
	failDownloads = true;

	const res = await mgr.apply(plan, { confirm: async () => true });

	assert.equal(calls.downloads.length, 2, "本地副本不存在 → 重新下载一次");
	assert.equal(res.written, 0);
	assert.equal(res.errors.length, 1);
	assert.equal(res.errors[0].relPath, snapshot.remotePath);
	assert.match(res.errors[0].message, /快照下载失败/);
	assert.ok(res.safetyZip !== "", "写回失败也要留下留底（它在写之前就生成了）");
	assert.equal(fs.existsSync(res.safetyZip), true);
	assert.equal(await fsp.readFile(path.join(sb.configDir, "app.json"), "utf8"), "旧");
});

/* ========================================================================== */
/* 6. 留底目录 / 纯函数                                                        */
/* ========================================================================== */

test("safetyDir 为空时，留底落到 vault 根下的 .obsidian-safety-snapshots", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x" }, safetyDirRel: null });
	assert.equal(sb.safetyDir, "");
	const { client } = makeClient([{ relPath: "app.json", size: 5 }]);
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent([]),
	});
	const plan = await mgr.preview({ kind: "mirror" });
	const res = await mgr.apply(plan, { confirm: async () => true });

	assert.equal(path.dirname(res.safetyZip), path.join(sb.dir, ".obsidian-safety-snapshots"));
	assert.equal(fs.existsSync(res.safetyZip), true);
});

test("无改动时不留底（省掉一次 344MB 打包）", async (t) => {
	const sb = await sandbox(t, { local: { "app.json": "x".repeat(7) } });
	const { client, calls } = makeClient([{ relPath: "app.json", size: 7 }]);
	const events = [];
	const mgr = harness({
		client,
		configDir: sb.configDir,
		safetyDir: sb.safetyDir,
		matcher: makeMatcher(),
		zipCurrent: makeZipCurrent(events),
	});
	const plan = await mgr.preview({ kind: "mirror" });
	assert.equal(plan.unchanged, 1);

	const res = await mgr.apply(plan, { confirm: async () => true });
	assert.equal(res.written, 0);
	assert.equal(res.safetyZip, "");
	assert.equal(events.length, 0, "没有任何改动 → 不该留底");
	assert.deepEqual(calls.downloads, []);
});

test("normalizeRelPath：规范化与拒绝非法路径", () => {
	assert.equal(normalizeRelPath("a/b/c.txt"), "a/b/c.txt");
	assert.equal(normalizeRelPath("./a/b.txt"), "a/b.txt");
	assert.equal(normalizeRelPath("a\\b.txt"), "a/b.txt");
	assert.equal(normalizeRelPath("a//b.txt"), "a/b.txt");
	assert.equal(normalizeRelPath("a/b/"), "a/b");
	assert.equal(normalizeRelPath("目录/中文 名.md"), "目录/中文 名.md");
	assert.equal(normalizeRelPath("../a.txt"), null);
	assert.equal(normalizeRelPath("a/../../b.txt"), null);
	assert.equal(normalizeRelPath("/etc/passwd"), null);
	assert.equal(normalizeRelPath("C:/Windows/x.txt"), null);
	assert.equal(normalizeRelPath("bad:name.txt"), null);
	assert.equal(normalizeRelPath("a?b.txt"), null);
	assert.equal(normalizeRelPath(""), null);
	assert.equal(normalizeRelPath("   "), null);
	assert.equal(normalizeRelPath("./"), null);
	assert.equal(normalizeRelPath(null), null);
});

test("buildSafetyZipName：本地时间戳 + 毫秒，同秒两次不重名", () => {
	const a = buildSafetyZipName(new Date(2026, 9, 16, 21, 30, 0, 123));
	const b = buildSafetyZipName(new Date(2026, 9, 16, 21, 30, 0, 456));
	assert.equal(a, "obsidian-config-safety-2026-10-16T21-30-00-123.zip");
	assert.equal(b, "obsidian-config-safety-2026-10-16T21-30-00-456.zip");
	assert.notEqual(a, b);
});

after(async () => {
	// 只清自己用例留下的沙盒目录（test/.tmp 可能还躺着别人的东西）
	try {
		for (const e of await fsp.readdir(TMP_ROOT)) {
			if (e.startsWith("restore-")) await fsp.rm(path.join(TMP_ROOT, e), { recursive: true, force: true });
		}
	} catch {
		/* 目录本来就不存在 */
	}
});
