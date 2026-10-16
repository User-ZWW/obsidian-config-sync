/**
 * Phase 3 端到端集成测试：把**真实**的 DropboxClient + HttpClient + 扫描器 + yazl/yauzl 打包解包
 * + SyncEngine + SnapshotManager + RestoreManager 全部串起来跑，只把 Dropbox 服务端换成
 * 本地保真 mock（test/helpers/mock-dropbox-server.mjs）。
 *
 * 与各子 agent 的单元测试的区别：这里跑的是**默认注入实现**（真实 fs 扫描、真实 zip 打包解包、
 * 真实 HTTP socket），任何一处接口对不上都会在这里炸，而不是等到 Obsidian 里。
 *
 * 覆盖：中文/空格文件名、>8MB 文件走分块上传会话、分页翻页、排除规则、索引判重、
 * 镜像删除、dryRun 零写入、快照生成与轮转、从镜像还原、从快照 zip 还原。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { startMockDropbox } from "./helpers/mock-dropbox-server.mjs";
import { createNodeHttpClient } from "../src/http/node.ts";
import { DropboxClient } from "../src/dropbox/client.ts";
import { compileMatcher } from "../src/scan/exclude.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { emptyIndex } from "../src/sync/index-store.ts";
import { SnapshotManager } from "../src/snapshot/manager.ts";
import { RestoreManager } from "../src/restore.ts";
import { listZipEntries } from "../src/snapshot/zip.ts";
import { RingLogger } from "../src/logger.ts";
import { DEFAULT_SETTINGS, DEFAULT_EXCLUDES } from "../src/config/defaults.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp", `e2e-${process.pid}-${Date.now()}`);
const VAULT = path.join(TMP, "TestVault");
const CONFIG_DIR = path.join(VAULT, ".obsidian");
const VAULT_NAME = path.basename(VAULT);
const REMOTE_ROOT = `/Obsidian-Config-Backup/${VAULT_NAME}`;
const SAFETY_DIR = path.join(TMP, "safety");

/** 期望参与同步的文件（8 个）；注意中文名、带空格的目录名、以及一个 9MB 大文件 */
const INCLUDED = [
	"app.json",
	"community-plugins.json",
	"hotkeys.json",
	"themes/mytheme/theme.css",
	"snippets/中文 样式.css",
	"plugins/dataview/main.js",
	"plugins/dataview/manifest.json",
	"plugins/大插件/blob.bin",
];

/** 期望被排除的文件 */
const EXCLUDED = [
	"icons/大图标.svg",
	".git/config",
	"workspace.json",
	"graph.json",
	"plugins/插件备份2026-9-29/junk.js",
];

/** 第三轮会刻意删掉 hotkeys.json，之后的远端状态就是这份清单 */
const SURVIVING = INCLUDED.filter((rel) => rel !== "hotkeys.json");

/** 模拟 main.ts 的 matcher：用户规则 + 插件自身运行时文件 */
function makeMatcher() {
	const base = compileMatcher({ includePatterns: [], excludePatterns: DEFAULT_EXCLUDES });
	return (rel, isDir) => {
		if (rel === "sync-index.json" || rel.endsWith("/sync-index.json")) return false;
		return base(rel, isDir);
	};
}

function w(rel, content) {
	const abs = path.join(CONFIG_DIR, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
}

let mock;
let client;
let settings;
let index;
let logger;
let snapshotManager;
let engine;

function buildEngine() {
	engine = new SyncEngine({
		client,
		indexStore: {
			get: () => index,
			set: async (next) => {
				index = next;
			},
		},
		getSettings: () => settings,
		configDir: CONFIG_DIR,
		logger,
		snapshotManager,
		matcher: makeMatcher(),
	});
}

before(async () => {
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.mkdirSync(CONFIG_DIR, { recursive: true });

	w("app.json", '{"promptDelete":false}');
	w("community-plugins.json", '["dataview"]');
	w("hotkeys.json", '{"open-settings":[]}');
	w("themes/mytheme/theme.css", "body { color: red; }");
	w("snippets/中文 样式.css", "/* 中文片段 */ .x { color: blue; }");
	w("plugins/dataview/main.js", "module.exports = {};");
	w("plugins/dataview/manifest.json", '{"id":"dataview"}');
	// 9MB > CHUNK_SIZE(8MB) → 必须走 upload_session 分块路径
	const big = Buffer.alloc(9 * 1024 * 1024);
	for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
	w("plugins/大插件/blob.bin", big);
	w("plugins/obsidian-config-sync/sync-index.json", '{"version":1,"entries":{}}');

	for (const rel of EXCLUDED) w(rel, "should never be uploaded");

	logger = new RingLogger({ level: "quiet" });
	mock = await startMockDropbox();
	client = new DropboxClient({
		http: createNodeHttpClient(),
		tokens: { appKey: "mock-app-key", accessToken: "mock-access-token" },
		baseDir: REMOTE_ROOT,
		concurrency: 4,
		logger,
		apiBase: `${mock.baseUrl}/2`,
		contentBase: `${mock.baseUrl}/2`,
	});

	settings = structuredClone(DEFAULT_SETTINGS);
	settings.snapshotEnabled = true;
	settings.snapshotMode = "every-run";
	settings.snapshotKeep = 2;
	settings.concurrency = 4;
	settings.logLevel = "quiet";

	index = emptyIndex();
	snapshotManager = new SnapshotManager({
		client,
		localRootDir: CONFIG_DIR,
		tmpDir: path.join(os.tmpdir(), "obsidian-config-sync-e2e"),
		keep: 2,
		logger,
	});
	buildEngine();
});

after(async () => {
	await mock?.stop();
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.rmSync(path.join(os.tmpdir(), "obsidian-config-sync-e2e"), { recursive: true, force: true });
});

test("端到端：镜像同步 + 快照 + 还原", async (t) => {
	await t.test("账户与配额接口（POST body 为 null）", async () => {
		const acct = await client.getCurrentAccount();
		assert.equal(acct.email, "mock@example.com");
		const usage = await client.getSpaceUsage();
		assert.equal(usage.allocated, 18 * 1024 * 1024 * 1024);
		assert.equal(usage.used, 0);
	});

	await t.test("第一轮：上传全部纳入范围的文件，字节完全一致", async () => {
		const result = await engine.run("manual");

		assert.equal(result.errors.length, 0, `不该有错误：${JSON.stringify(result.errors)}`);
		assert.equal(result.uploaded, INCLUDED.length, `应上传 ${INCLUDED.length} 个，实际 ${result.uploaded}`);
		assert.equal(result.dryRun, false);

		for (const rel of INCLUDED) {
			const remote = mock.read(`${REMOTE_ROOT}/${rel}`);
			assert.ok(remote, `远端缺少 ${rel}`);
			assert.deepEqual(remote, fs.readFileSync(path.join(CONFIG_DIR, ...rel.split("/"))), `${rel} 字节不一致`);
		}

		// 中文名 + 空格必须原样落到远端（Dropbox-API-Arg 转义正确才会走到这里）
		assert.ok(mock.paths().includes(`${REMOTE_ROOT}/snippets/中文 样式.css`));
		assert.ok(mock.paths().includes(`${REMOTE_ROOT}/plugins/大插件/blob.bin`));
	});

	await t.test("排除规则生效：icons / .git / workspace / 插件备份* 一个都没上传", async () => {
		for (const rel of EXCLUDED) {
			assert.equal(mock.read(`${REMOTE_ROOT}/${rel}`), null, `${rel} 不该被上传`);
		}
		assert.equal(mock.read(`${REMOTE_ROOT}/sync-index.json`), null, "索引文件不该被上传（会自触发死循环）");
	});

	await t.test("9MB 文件真的走了分块上传会话（不是单次 upload）", () => {
		assert.ok(
			mock.requests.some((r) => r.route === "/files/upload_session/start"),
			"应调用 upload_session/start",
		);
		assert.ok(
			mock.requests.some((r) => r.route === "/files/upload_session/finish"),
			"应调用 upload_session/finish",
		);
		assert.equal(
			mock.requests.some((r) => r.route === "/files/upload" && (r.path ?? "").endsWith("blob.bin")),
			false,
			"9MB 文件不该走单次 upload",
		);
	});

	await t.test("第一轮生成了快照 zip，条目与未压缩大小都对", async () => {
		const snaps = mock.paths().filter((p) => p.startsWith(`${REMOTE_ROOT}/_snapshots/`));
		assert.equal(snaps.length, 1, `应生成 1 个快照，实际 ${JSON.stringify(snaps)}`);

		const zipPath = path.join(TMP, "snapshot-check.zip");
		fs.writeFileSync(zipPath, mock.read(snaps[0]));
		const entries = await listZipEntries(zipPath);
		const byRel = new Map(entries.map((e) => [e.relPath, e.size]));
		for (const rel of INCLUDED) {
			assert.ok(byRel.has(rel), `快照里缺少 ${rel}`);
			assert.equal(
				byRel.get(rel),
				fs.statSync(path.join(CONFIG_DIR, ...rel.split("/"))).size,
				`快照里 ${rel} 的未压缩大小不对`,
			);
		}
	});

	await t.test("第二轮无变化：上传 0、删除 0（索引判重生效）", async () => {
		const result = await engine.run("manual");
		assert.equal(result.uploaded, 0);
		assert.equal(result.deleted, 0);
		assert.equal(result.errors.length, 0);
		// 这时远端已有 8 个文件 + 快照，而 mock 每页只回 3 条 → 必须翻过页
		assert.ok(
			mock.requests.some((r) => r.route === "/files/list_folder/continue"),
			"每页 3 条时应走 list_folder/continue 翻页",
		);
	});

	await t.test("第三轮：改一个 + 删一个，镜像同步把远端也改成一样", async () => {
		w("app.json", '{"promptDelete":true,"changed":1}');
		fs.rmSync(path.join(CONFIG_DIR, "hotkeys.json"));

		const result = await engine.run("manual");
		assert.equal(result.uploaded, 1, `应上传 1 个，实际 ${result.uploaded}`);
		assert.equal(result.deleted, 1, `应删除 1 个，实际 ${result.deleted}`);
		assert.equal(result.errors.length, 0);

		assert.deepEqual(
			mock.read(`${REMOTE_ROOT}/app.json`),
			fs.readFileSync(path.join(CONFIG_DIR, "app.json")),
			"远端 app.json 应是新内容",
		);
		assert.equal(mock.read(`${REMOTE_ROOT}/hotkeys.json`), null, "远端 hotkeys.json 应已被删除");
	});

	await t.test("dryRun 只算差异、一个字节都不写", async () => {
		w("community-plugins.json", '["dataview","config-sync"]');
		const plan = await engine.plan();
		assert.ok(plan.plan.toUpload.length >= 1, "预览应看到待上传");
		assert.ok(
			plan.plan.toUpload.some((f) => f.relPath === "community-plugins.json"),
			"预览应包含被改动的文件",
		);

		const before = mock.read(`${REMOTE_ROOT}/community-plugins.json`);
		const result = await engine.run("manual", { dryRun: true });
		assert.equal(result.dryRun, true);
		assert.deepEqual(mock.read(`${REMOTE_ROOT}/community-plugins.json`), before, "dryRun 不该改动远端");

		await engine.run("manual");
		assert.deepEqual(
			mock.read(`${REMOTE_ROOT}/community-plugins.json`),
			fs.readFileSync(path.join(CONFIG_DIR, "community-plugins.json")),
			"真跑之后远端才更新",
		);
	});

	await t.test("从镜像目录还原到空目录：默认注入实现（真 zip 留底 + 真下载）", async () => {
		const target = path.join(TMP, "restore-mirror", ".obsidian");
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "marker.txt"), "restore me away");

		const rm = new RestoreManager({
			client,
			configDir: target,
			safetyDir: SAFETY_DIR,
			matcher: makeMatcher(),
			logger,
		});

		const plan = await rm.preview({ kind: "mirror" });
		assert.equal(plan.toWrite.length, SURVIVING.length, `应写回 ${SURVIVING.length} 个`);
		assert.ok(
			plan.toWrite.every((f) => !f.relPath.startsWith("_snapshots")),
			"快照 zip 绝不能参与还原",
		);
		assert.ok(plan.skippedByRules >= 1, "远端那些快照 zip 应被规则挡掉并计数");
		assert.ok(plan.toDelete.includes("marker.txt"), "本地多余文件应被识别出来");
		assert.ok(plan.bytesToDownload > 9 * 1024 * 1024, "下载量应包含那个 9MB 文件");

		const res = await rm.apply(plan, { confirm: async () => true });
		assert.equal(res.errors.length, 0, `不该有错误：${JSON.stringify(res.errors)}`);
		assert.equal(res.written, SURVIVING.length);
		assert.equal(res.deleted, 0, "没开 includeDelete 就不该删本地文件");
		assert.ok(fs.existsSync(path.join(target, "marker.txt")), "默认不删本地多余文件");

		for (const rel of SURVIVING) {
			assert.deepEqual(
				fs.readFileSync(path.join(target, ...rel.split("/"))),
				fs.readFileSync(path.join(CONFIG_DIR, ...rel.split("/"))),
				`${rel} 还原后内容不一致`,
			);
		}
		assert.equal(fs.existsSync(path.join(target, "_snapshots")), false, "不该把 _snapshots 目录建出来");

		// 留底 zip 必须真的落盘、非空、且是个能打开的 zip
		assert.ok(res.safetyZip && fs.existsSync(res.safetyZip), "留底 zip 应存在");
		assert.ok(fs.statSync(res.safetyZip).size > 0, "留底 zip 不该是空的");
		const safetyEntries = await listZipEntries(res.safetyZip);
		assert.ok(
			safetyEntries.some((e) => e.relPath === "marker.txt"),
			"留底 zip 应包含还原前的本地文件",
		);
	});

	await t.test("从快照 zip 还原：默认注入实现（真下载 + 真解压）", async () => {
		// 现造一个快照，让"快照里应该有什么"由当下扫描结果决定，不依赖前面几轮的时序
		const fresh = await engine.plan();
		const expected = fresh.scan.files.map((f) => f.relPath).sort();
		await snapshotManager.createAndUpload(fresh.scan.files, "snap-restore");
		const snaps = await snapshotManager.list();
		const snap = snaps.find((s) => s.name.includes("snap-restore"));
		assert.ok(snap, `应能找到刚生成的快照，实际有 ${JSON.stringify(snaps.map((s) => s.name))}`);

		const target = path.join(TMP, "restore-snap", ".obsidian");
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "marker.txt"), "x");

		const rm = new RestoreManager({
			client,
			configDir: target,
			safetyDir: SAFETY_DIR,
			matcher: makeMatcher(),
			logger,
		});

		const plan = await rm.preview({ kind: "snapshot", snapshot: snap });
		assert.deepEqual(
			plan.toWrite.map((f) => f.relPath).sort(),
			expected,
			"快照里的文件应与当前扫描结果一致",
		);
		assert.ok(plan.sourceLabel.includes(snap.name), "计划来源应写明快照名");

		const res = await rm.apply(plan, { confirm: async () => true });
		assert.equal(res.errors.length, 0, `不该有错误：${JSON.stringify(res.errors)}`);
		assert.equal(res.written, expected.length);
		assert.deepEqual(
			fs.readFileSync(path.join(target, "themes", "mytheme", "theme.css")),
			fs.readFileSync(path.join(CONFIG_DIR, "themes", "mytheme", "theme.css")),
		);
		assert.deepEqual(
			fs.readFileSync(path.join(target, "snippets", "中文 样式.css")),
			fs.readFileSync(path.join(CONFIG_DIR, "snippets", "中文 样式.css")),
			"中文名文件应能正确解压回写",
		);
		assert.equal(fs.existsSync(path.join(target, "_snapshots")), false);
	});

	await t.test("快照轮转：保留最近 N 份", async () => {
		// 快照名是秒级时间戳，同一秒内生成的会互相覆盖，所以隔开一秒再生成
		const plan = await engine.plan();
		await snapshotManager.createAndUpload(plan.scan.files, "rot-1");
		await new Promise((r) => setTimeout(r, 1100));
		await snapshotManager.createAndUpload(plan.scan.files, "rot-2");

		const listed = await snapshotManager.list();
		assert.equal(listed.length, settings.snapshotKeep, `应只保留 ${settings.snapshotKeep} 份，实际 ${listed.length}`);

		const remoteZips = mock.paths().filter((p) => p.startsWith(`${REMOTE_ROOT}/_snapshots/`));
		assert.equal(remoteZips.length, settings.snapshotKeep, `远端应只剩 ${settings.snapshotKeep} 个 zip`);

		// 留下的必须正好是 list() 报出来的那几份
		assert.deepEqual(
			remoteZips.map((p) => path.posix.basename(p)).sort(),
			listed.map((s) => s.name).sort(),
		);
		// 最新的那份名字里应带 rot-2，最老的 rot-1 已被轮转掉
		assert.ok(listed.some((s) => s.name.includes("rot-2")), "最新快照应留下");
	});

	await t.test("取消还原：不改任何东西，也不留底", async () => {
		const target = path.join(TMP, "restore-cancel", ".obsidian");
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "keep.txt"), "untouched");

		const rm = new RestoreManager({
			client,
			configDir: target,
			safetyDir: SAFETY_DIR,
			matcher: makeMatcher(),
			logger,
		});
		const plan = await rm.preview({ kind: "mirror" });
		const res = await rm.apply(plan, { confirm: async () => false });

		assert.equal(res.cancelled, true);
		assert.equal(res.written, 0);
		assert.equal(res.safetyZip, "");
		assert.deepEqual(fs.readdirSync(target), ["keep.txt"], "目标目录不该被动过");
	});
});
