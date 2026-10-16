/**
 * 同步核心的测试：index-store / snapshot(zip + manager) / sync(engine)。
 *
 * 规则：
 *   - 完全不碰真 Dropbox：client 都是本地假对象（duck typing），远端就是一个 Map，
 *     可选地把上传的文件真拷进一个"假远端目录"，好让 yauzl 事后校验真实字节。
 *   - 只用自己的临时目录 test/.tmp/sync/，跑完删掉。
 *   - 扫描器/匹配器用 SyncEngineDeps 预留的注入点，不依赖 src/scan/**（那是别的 agent 的文件）。
 *
 * 运行：node --test --test-reporter=spec test/sync.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

import { emptyIndex, parseIndex, computeDiff, applyIndex, INDEX_VERSION } from "../src/sync/index-store.ts";
import { createZipFromFiles, listZipEntries, extractZipTo, safeExtractPath } from "../src/snapshot/zip.ts";
import { SnapshotManager, SNAPSHOT_DIR_NAME, snapshotStamp } from "../src/snapshot/manager.ts";
import { SyncEngine } from "../src/sync/engine.ts";

/* ============================ 公共脚手架 ============================ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp", "sync");

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

let seq = 0;
async function tempDir(tag) {
	const dir = path.join(TMP, `${tag}-${++seq}`);
	await fsp.mkdir(dir, { recursive: true });
	return dir;
}

/** 在 root 下按 {relPath: 内容} 建出真实文件，返回 LocalFileEntry[]（relPath 用 '/'） */
async function writeTree(root, spec) {
	const out = [];
	for (const [rel, content] of Object.entries(spec)) {
		const abs = path.join(root, ...rel.split("/"));
		await fsp.mkdir(path.dirname(abs), { recursive: true });
		await fsp.writeFile(abs, content);
		const st = await fsp.stat(abs);
		out.push({ relPath: rel, absPath: abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
	}
	return out;
}

before(async () => {
	await fsp.rm(TMP, { recursive: true, force: true });
	await fsp.mkdir(TMP, { recursive: true });
});

after(async () => {
	await fsp.rm(TMP, { recursive: true, force: true });
});

/* ============================ index-store ============================ */

test("parseIndex：损坏或版本不符的数据一律退化成空索引，不抛错", () => {
	const bads = [
		null,
		undefined,
		42,
		"nope",
		[],
		{},
		{ version: 999, entries: {} },
		{ version: INDEX_VERSION, entries: "x" },
		{ version: INDEX_VERSION, entries: { a: null }, lastSyncAt: 5 },
	];
	for (const bad of bads) {
		assert.deepEqual(parseIndex(bad), emptyIndex(), `输入 ${JSON.stringify(bad)} 应退化成空索引`);
	}
});

test("parseIndex：保留合法条目、丢掉字段残缺的、并归一化路径分隔符", () => {
	const idx = parseIndex({
		version: INDEX_VERSION,
		lastSyncAt: "2026-10-16T00:00:00.000Z",
		entries: {
			"a/b.json": { size: 10, mtimeMs: 1, rev: "r1", uploadedAt: "t1" },
			"c\\d.json": { size: 2, mtimeMs: 3, rev: "r2", uploadedAt: "t2", hash: "h2" },
			"bad-size": { size: "10", mtimeMs: 1, rev: "r", uploadedAt: "t" },
			"bad-rev": { size: 1, mtimeMs: 1, uploadedAt: "t" },
			"bad-time": { size: 1, mtimeMs: 1, rev: "r" },
			"": { size: 1, mtimeMs: 1, rev: "r", uploadedAt: "t" },
		},
	});
	assert.equal(idx.version, INDEX_VERSION);
	assert.equal(idx.lastSyncAt, "2026-10-16T00:00:00.000Z");
	assert.deepEqual(Object.keys(idx.entries).sort(), ["a/b.json", "c/d.json"]);
	assert.deepEqual(idx.entries["a/b.json"], { size: 10, mtimeMs: 1, rev: "r1", uploadedAt: "t1" });
	assert.equal(idx.entries["c/d.json"].hash, "h2");
});

test("parseIndex：lastSyncAt 非字符串时归成 null", () => {
	assert.equal(parseIndex({ version: INDEX_VERSION, lastSyncAt: 123, entries: {} }).lastSyncAt, null);
});

const local = (rel, size, mtimeMs, hash) => ({ relPath: rel, absPath: `C:/vault/.obsidian/${rel}`, size, mtimeMs, hash });
const remote = (rel, size = 1) => ({ relPath: rel, size, rev: `rev-${rel}`, serverModified: "2026-01-01T00:00:00.000Z" });

test("computeDiff 快速模式：size+mtime 没变的跳过，改动的与新增的上传", () => {
	const files = [local("a.json", 10, 1000), local("b.json", 20, 2000), local("c.json", 30, 3000), local("d.json", 40, 4000)];
	const index = parseIndex({
		version: INDEX_VERSION,
		lastSyncAt: "x",
		entries: {
			"a.json": { size: 10, mtimeMs: 1000, rev: "r", uploadedAt: "x" }, // 完全没变
			"b.json": { size: 20, mtimeMs: 1999, rev: "r", uploadedAt: "x" }, // mtime 变了
			"d.json": { size: 41, mtimeMs: 4000, rev: "r", uploadedAt: "x" }, // size 变了
		},
	});
	const plan = computeDiff(files, index, [], { mirrorDelete: true, useHash: false });
	assert.deepEqual(plan.toUpload.map((f) => f.relPath), ["b.json", "c.json", "d.json"]);
	assert.equal(plan.unchanged, 1);
	assert.deepEqual(plan.toDelete, []);
	assert.equal(plan.excluded, 0);
});

test("computeDiff hash 模式：hash 相同即使 size/mtime 变了也跳过；hash 不同即使 size/mtime 没变也上传", () => {
	const files = [local("same.json", 11, 5000, "abc"), local("touched.json", 12, 6000, "def"), local("noHash.json", 13, 7000)];
	const index = parseIndex({
		version: INDEX_VERSION,
		lastSyncAt: null,
		entries: {
			"same.json": { size: 10, mtimeMs: 1, rev: "r", uploadedAt: "x", hash: "abc" },
			"touched.json": { size: 12, mtimeMs: 6000, rev: "r", uploadedAt: "x", hash: "xyz" },
			"noHash.json": { size: 13, mtimeMs: 7000, rev: "r", uploadedAt: "x" },
		},
	});
	const plan = computeDiff(files, index, [], { mirrorDelete: false, useHash: true });
	assert.deepEqual(plan.toUpload.map((f) => f.relPath), ["touched.json"]);
	assert.equal(plan.unchanged, 2, "hash 相同 / 缺 hash 退回 size+mtime 的都应算未变");
});

test("computeDiff 镜像删除：本地已删的与远端史前遗留都进 toDelete，且远端必须真的存在", () => {
	const files = [local("keep.json", 1, 1)];
	const index = parseIndex({
		version: INDEX_VERSION,
		lastSyncAt: null,
		entries: {
			"keep.json": { size: 1, mtimeMs: 1, rev: "r", uploadedAt: "x" },
			"gone.json": { size: 1, mtimeMs: 1, rev: "r", uploadedAt: "x" },
			"ghost.json": { size: 1, mtimeMs: 1, rev: "r", uploadedAt: "x" }, // 索引有、本地无、远端也无
		},
	});
	const remotes = [remote("keep.json"), remote("gone.json"), remote("ancient.json")];

	const plan = computeDiff(files, index, remotes, { mirrorDelete: true, useHash: false });
	assert.deepEqual(plan.toDelete, ["ancient.json", "gone.json"]);
	assert.ok(!plan.toDelete.includes("keep.json"), "本地还在、只是要覆盖上传的文件绝不能被删");
	assert.ok(!plan.toDelete.includes("ghost.json"), "远端不存在的东西不该出现在删除清单里");

	const off = computeDiff(files, index, remotes, { mirrorDelete: false, useHash: false });
	assert.deepEqual(off.toDelete, []);
});

test("computeDiff 透传扫描阶段的 excluded 计数", () => {
	assert.equal(computeDiff([], emptyIndex(), [], { mirrorDelete: false, useHash: false, excludedCount: 42 }).excluded, 42);
	assert.equal(computeDiff([], emptyIndex(), [], { mirrorDelete: false, useHash: false }).excluded, 0);
});

test("applyIndex 是纯函数：写入新条目、移除已删除项、推进 lastSyncAt", () => {
	const index = parseIndex({
		version: INDEX_VERSION,
		lastSyncAt: "2026-01-01T00:00:00.000Z",
		entries: {
			"a.json": { size: 1, mtimeMs: 1, rev: "old", uploadedAt: "2026-01-01T00:00:00.000Z", hash: "h1" },
			"gone.json": { size: 2, mtimeMs: 2, rev: "r2", uploadedAt: "2026-01-01T00:00:00.000Z" },
		},
	});
	const snapshotBefore = JSON.stringify(index);

	const next = applyIndex(
		index,
		[{ relPath: "b.json", rev: "rb", size: 3, mtimeMs: 30, hash: "hb" }],
		["gone.json"],
		"2026-10-16T10:00:00.000Z",
	);

	assert.equal(JSON.stringify(index), snapshotBefore, "原索引被改脏了");
	assert.equal(next.version, INDEX_VERSION);
	assert.equal(next.lastSyncAt, "2026-10-16T10:00:00.000Z");
	assert.deepEqual(Object.keys(next.entries).sort(), ["a.json", "b.json"]);
	assert.deepEqual(next.entries["b.json"], {
		size: 3,
		mtimeMs: 30,
		rev: "rb",
		uploadedAt: "2026-10-16T10:00:00.000Z",
		hash: "hb",
	});

	// 没带 hash 的上传记录不能继承旧 hash（否则 hash 模式会误判为没变）
	const next2 = applyIndex(index, [{ relPath: "a.json", rev: "r9", size: 9, mtimeMs: 9 }], [], "T");
	assert.equal(next2.entries["a.json"].hash, undefined);
	assert.equal(next2.entries["a.json"].rev, "r9");
	// 未受影响的条目原样保留
	assert.equal(next2.entries["gone.json"].rev, "r2");
});

/* ============================ snapshot/zip ============================ */

test("createZipFromFiles：产出的 zip 能被 listZipEntries 原样读回（'/' 分隔、含中文与子目录）", async () => {
	const root = await tempDir("zip-root");
	const files = await writeTree(root, {
		"app.json": "{}",
		"plugins/chinese-插件/main.js": "console.log('hi')",
		"plugins/chinese-插件/data.json": JSON.stringify({ a: 1 }),
		"snippets/中文片段.css": ".x{color:red}",
	});
	const out = path.join(await tempDir("zip-out"), "pack.zip");
	const progress = [];

	const res = await createZipFromFiles(root, files, out, { onProgress: (d, t) => progress.push([d, t]) });

	assert.equal(res.entries, 4);
	assert.equal(res.bytes, (await fsp.stat(out)).size);
	assert.ok(res.bytes > 0);
	assert.equal(progress.length, 4, "每个文件都该回调一次进度");
	assert.deepEqual(progress.at(-1), [4, 4]);

	const listed = await listZipEntries(out);
	assert.deepEqual(
		listed.map((e) => e.relPath).sort(),
		["app.json", "plugins/chinese-插件/data.json", "plugins/chinese-插件/main.js", "snippets/中文片段.css"],
	);
	const byRel = new Map(listed.map((e) => [e.relPath, e.size]));
	assert.equal(byRel.get("app.json"), 2);
	assert.equal(byRel.get("plugins/chinese-插件/main.js"), "console.log('hi')".length);
});

test("extractZipTo：还原后内容逐字节一致，filter 能按条目过滤", async () => {
	const root = await tempDir("zip-src");
	const files = await writeTree(root, {
		"a.json": "aaa",
		"deep/nested/中文.json": "内容",
		"big.bin": "x".repeat(200000),
	});
	const zipPath = path.join(await tempDir("zip-pack"), "p.zip");
	await createZipFromFiles(root, files, zipPath);

	const destAll = await tempDir("zip-dest-all");
	const r1 = await extractZipTo(zipPath, destAll);
	assert.equal(r1.entries, 3);
	assert.equal(await fsp.readFile(path.join(destAll, "a.json"), "utf8"), "aaa");
	assert.equal(await fsp.readFile(path.join(destAll, "deep", "nested", "中文.json"), "utf8"), "内容");
	assert.equal((await fsp.stat(path.join(destAll, "big.bin"))).size, 200000);

	const destFiltered = await tempDir("zip-dest-filtered");
	const r2 = await extractZipTo(zipPath, destFiltered, (rel) => rel.endsWith(".json") && !rel.includes("/"));
	assert.equal(r2.entries, 1);
	assert.deepEqual((await fsp.readdir(destFiltered)).sort(), ["a.json"]);
});

/**
 * 手搓一个最小 zip（stored、无压缩）。yazl 会拒绝 "../" 这种条目名，
 * 所以"恶意 zip"只能自己拼字节：这正是要测的场景。
 */
function buildRawZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, "utf8");
		const data = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content);
		const crc = zlib.crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8
		local.writeUInt16LE(0, 8); // stored
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		chunks.push(local, nameBuf, data);

		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0x0800, 8);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(data.length, 20);
		cd.writeUInt32LE(data.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(cd, nameBuf);

		offset += local.length + nameBuf.length + data.length;
	}
	const cdBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, cdBuf, eocd]);
}

test("safeExtractPath：任何会逃出 destDir 的条目名都被拦下", () => {
	const dest = path.join(TMP, "guard", "dest");
	assert.equal(safeExtractPath(dest, "a/b.txt"), path.join(dest, "a", "b.txt"));
	assert.equal(safeExtractPath(dest, "a\\b.txt"), path.join(dest, "a", "b.txt"), "反斜杠要当分隔符");
	assert.equal(safeExtractPath(dest, "C:/Windows/x.txt"), path.join(dest, "Windows", "x.txt"), "盘符剥掉、收进来");
	assert.equal(safeExtractPath(dest, "/etc/passwd"), path.join(dest, "etc", "passwd"), "前导 '/' 剥掉、收进来");
	assert.equal(safeExtractPath(dest, "./a.txt"), path.join(dest, "a.txt"));

	for (const evil of ["../x.txt", "..\\x.txt", "a/../../x.txt", "a\\..\\..\\x.txt", "..", "../"]) {
		assert.throws(() => safeExtractPath(dest, evil), /zip slip/, `${evil} 应该被拦下`);
	}
});

test("extractZipTo：恶意 zip 一律不落盘到 destDir 之外", async () => {
	const stage = await tempDir("slip");
	const zipPath = path.join(stage, "evil.zip");
	// yauzl 会在 open 阶段就拒绝 "../"（它自己会做条目名校验），这里断言的是最终可观测结果：
	// 报错 + 外面绝不出现新文件。即使换个不做校验的库，safeExtractPath 那一层也兜得住。
	await fsp.writeFile(
		zipPath,
		buildRawZip([
			{ name: "../escaped.txt", content: "pwned" },
			{ name: "..\\escaped2.txt", content: "pwned" },
			{ name: "inside.txt", content: "ok" },
		]),
	);

	const dest = path.join(stage, "dest");
	await assert.rejects(() => extractZipTo(zipPath, dest));
	assert.ok(!fs.existsSync(path.join(stage, "escaped.txt")), "逃逸文件被写出来了");
	assert.ok(!fs.existsSync(path.join(stage, "escaped2.txt")), "逃逸文件被写出来了");
	assert.ok(!fs.existsSync(path.join(path.dirname(stage), "escaped.txt")));
});

test("extractZipTo：带盘符/前导斜杠的条目不逃逸（要么拦下、要么收进 destDir）", async () => {
	const stage = await tempDir("slip-abs");
	const zipPath = path.join(stage, "abs.zip");
	await fsp.writeFile(
		zipPath,
		buildRawZip([
			{ name: "C:/Windows/evil.txt", content: "x" },
			{ name: "/etc/passwd", content: "y" },
		]),
	);
	const dest = path.join(stage, "dest");
	let threw = false;
	try {
		await extractZipTo(zipPath, dest);
	} catch {
		threw = true;
	}
	// 关键安全性：绝对不能写到 destDir 之外
	assert.ok(!fs.existsSync(path.join(stage, "Windows", "evil.txt")));
	assert.ok(!fs.existsSync(path.join(stage, "etc", "passwd")));
	if (!threw) {
		assert.ok(
			fs.existsSync(path.join(dest, "Windows", "evil.txt")),
			"没抛错就必须是把绝对路径当成相对路径收进了 destDir",
		);
		assert.ok(fs.existsSync(path.join(dest, "etc", "passwd")));
	}
});

test("listZipEntries：手搓 zip 也能读，路径被归一化", async () => {
	const stage = await tempDir("raw-zip");
	const zipPath = path.join(stage, "raw.zip");
	await fsp.writeFile(zipPath, buildRawZip([{ name: "a\\b.txt", content: "hi" }]));
	assert.deepEqual(await listZipEntries(zipPath), [{ relPath: "a/b.txt", size: 2 }]);
});

test("createZipFromFiles：跳过扫描后已消失的文件与非普通文件，而不是整包失败", async () => {
	const root = await tempDir("zip-vanish");
	const files = await writeTree(root, { "存在.json": "1" });
	// 扫描之后被删掉的文件
	files.push({ relPath: "已删除.json", absPath: path.join(root, "已删除.json"), size: 5, mtimeMs: 1 });
	// 指向目录的条目（或者被换成了目录/设备文件）：stat 得到但不是普通文件
	files.push({ relPath: "其实是个目录", absPath: root, size: 0, mtimeMs: 1 });

	const out = path.join(await tempDir("zip-vanish-out"), "p.zip");
	const res = await createZipFromFiles(root, files, out);
	assert.equal(res.entries, 1);
	assert.deepEqual((await listZipEntries(out)).map((e) => e.relPath), ["存在.json"]);
});

test("createZipFromFiles：拒绝打包 rootDir 之外的文件（防目录遍历）", async () => {
	const root = await tempDir("zip-escape-root");
	const outside = await tempDir("zip-escape-outside");
	const files = await writeTree(outside, { "secret.txt": "s" });
	files[0].relPath = "../secret.txt";

	const out = path.join(await tempDir("zip-escape-out"), "p.zip");
	await assert.rejects(() => createZipFromFiles(root, files, out), /不在 rootDir 之下/);
});

test("空文件列表也能生成合法的空 zip", async () => {
	const root = await tempDir("zip-empty-root");
	const out = path.join(await tempDir("zip-empty"), "empty.zip");
	const res = await createZipFromFiles(root, [], out);
	assert.equal(res.entries, 0);
	assert.ok(res.bytes > 0);
	assert.deepEqual(await listZipEntries(out), []);
});

/* ============================ snapshot/manager ============================ */

/**
 * 假 DropboxClient：远端就是一个 Map；给了 mirrorDir 就把上传的文件真拷过去，
 * 这样测试可以事后用 yauzl 校验真的字节。
 */
function makeClient(opts = {}) {
	const remoteMap = new Map();
	const calls = { list: 0, uploadMany: [], uploadFile: [], deletePath: [], downloadFile: [] };
	let revSeq = 0;

	const seedEntries = opts.seedEntries || [];
	for (const e of seedEntries) remoteMap.set(e.relPath, { ...e });
	for (const name of opts.seed || []) {
		remoteMap.set(`${SNAPSHOT_DIR_NAME}/${name}`, {
			relPath: `${SNAPSHOT_DIR_NAME}/${name}`,
			size: 1,
			rev: `rev-seed-${name}`,
			serverModified: "2026-10-16T09:00:00Z",
		});
	}

	const client = {
		async listFolderRecursive() {
			calls.list++;
			return [...remoteMap.values()].map((e) => ({ ...e }));
		},
		async uploadFile(relPath, absPath) {
			const buf = await fsp.readFile(absPath);
			if (opts.mirrorDir) {
				const dst = path.join(opts.mirrorDir, ...relPath.split("/"));
				await fsp.mkdir(path.dirname(dst), { recursive: true });
				await fsp.writeFile(dst, buf);
			}
			const rev = `rev-${++revSeq}`;
			const contentHash = `ch-${buf.length}`;
			remoteMap.set(relPath, {
				relPath,
				size: buf.length,
				rev,
				serverModified: new Date().toISOString(),
				contentHash,
			});
			calls.uploadFile.push({ relPath, absPath, bytes: buf.length });
			return { rev, size: buf.length, contentHash };
		},
		async uploadMany(items, onProgress) {
			calls.uploadMany.push(items.map((i) => i.relPath));
			const ok = [];
			const failed = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (opts.failRel && item.relPath.endsWith(opts.failRel)) {
					failed.push({ relPath: item.relPath, message: "模拟上传失败" });
				} else {
					const r = await client.uploadFile(item.relPath, item.absPath);
					ok.push({ relPath: item.relPath, rev: r.rev, size: r.size, contentHash: r.contentHash });
				}
				if (onProgress) onProgress(i + 1, items.length, item.relPath);
			}
			return { ok, failed };
		},
		async deletePath(relPath) {
			calls.deletePath.push(relPath);
			remoteMap.delete(relPath);
		},
		async downloadFile(relPath, destAbsPath) {
			calls.downloadFile.push(relPath);
			await fsp.mkdir(path.dirname(destAbsPath), { recursive: true });
			if (opts.mirrorDir) {
				const src = path.join(opts.mirrorDir, ...relPath.split("/"));
				if (fs.existsSync(src)) {
					await fsp.copyFile(src, destAbsPath);
					return;
				}
			}
			await fsp.writeFile(destAbsPath, Buffer.from(`zip-bytes:${relPath}`));
		},
	};
	return { client, calls, remote: remoteMap };
}

test("snapshotStamp：定宽、可字典序排序的本地时间戳", () => {
	assert.equal(snapshotStamp(new Date(2026, 0, 5, 9, 8, 7)), "2026-01-05T09-08-07");
	const oct = snapshotStamp(new Date(2026, 9, 16, 21, 30, 0));
	assert.equal(oct, "2026-10-16T21-30-00");
	assert.ok(snapshotStamp(new Date(2026, 10, 1, 0, 0, 0)) > oct, "跨月也必须能按名字排序");
});

test("SnapshotManager 构造：subDir 归一化、keep 夹到至少 1", () => {
	const { client } = makeClient();
	const mgr = new SnapshotManager({
		client,
		localRootDir: "C:/vault/.obsidian",
		tmpDir: "C:/tmp",
		subDir: "/MyVault/_snapshots/",
		keep: 0,
	});
	assert.equal(mgr.subDir, "MyVault/_snapshots");
	assert.equal(mgr.keep, 1, "keep=0 会让刚生成的快照立刻被自己删掉，必须夹到 1");
	assert.equal(mgr.remotePathOf("a.zip"), "MyVault/_snapshots/a.zip");
	assert.equal(new SnapshotManager({ client, localRootDir: "x", tmpDir: "y", keep: 3 }).subDir, SNAPSHOT_DIR_NAME);
});

test("createAndUpload：打包→上传到 <subDir>/<时间戳>.zip→清理本地临时文件", async () => {
	const root = await tempDir("snap-root");
	const files = await writeTree(root, { "app.json": "{}", "plugins/x/main.js": "module.exports={};" });
	const mirrorDir = await tempDir("snap-mirror");
	const tmpParent = await tempDir("snap-tmp-parent");
	const tmpDir = path.join(tmpParent, "scratch");
	const { client, calls, remote } = makeClient({ mirrorDir });
	const mgr = new SnapshotManager({
		client,
		localRootDir: root,
		tmpDir,
		keep: 7,
		logger: silentLogger,
	});

	const rec = await mgr.createAndUpload(files, "manual");

	assert.match(rec.name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-manual\.zip$/);
	assert.equal(rec.remotePath, `${SNAPSHOT_DIR_NAME}/${rec.name}`);
	assert.ok(rec.createdAt);
	assert.equal(rec.size, remote.get(rec.remotePath).size);
	assert.equal(remote.size, 1, "只该上传一个文件");

	// 上传的确实是本地打包出来的那个 zip
	assert.equal(calls.uploadFile.length, 1);
	assert.equal(calls.uploadFile[0].relPath, rec.remotePath);
	assert.equal(calls.uploadFile[0].absPath, path.join(tmpDir, rec.name));

	// 事后用 yauzl 打开"远端"那份，条目必须与本地一致
	const zipOnRemote = path.join(mirrorDir, ...rec.remotePath.split("/"));
	assert.deepEqual(
		(await listZipEntries(zipOnRemote)).map((e) => e.relPath).sort(),
		["app.json", "plugins/x/main.js"],
	);

	// 本地中间产物不残留
	assert.deepEqual(await fsp.readdir(tmpDir), []);
	assert.equal(remote.size, 1);
});

test("rotate：只保留最近 keep 份，按名字倒序判定新旧，返回被删的名字", async () => {
	const names = [
		"2026-10-14T09-00-00.zip",
		"2026-10-15T09-00-00.zip",
		"2026-10-16T09-00-00.zip",
		"2026-10-16T10-00-00.zip",
		"2026-10-16T11-00-00.zip",
	];
	const { client, calls, remote } = makeClient({ seed: names });
	const mgr = new SnapshotManager({ client, localRootDir: "x", tmpDir: "y", keep: 2 });

	const all = await mgr.list();
	assert.deepEqual(all.map((s) => s.name), [...names].reverse(), "必须最新在前");
	assert.deepEqual(all[0].remotePath, `${SNAPSHOT_DIR_NAME}/2026-10-16T11-00-00.zip`);
	assert.equal(all[0].createdAt, "2026-10-16T09:00:00Z");

	const removed = await mgr.rotate();
	assert.deepEqual(removed, [
		"2026-10-16T09-00-00.zip",
		"2026-10-15T09-00-00.zip",
		"2026-10-14T09-00-00.zip",
	]);
	assert.equal(calls.deletePath.length, 3);
	assert.equal(remote.size, 2);
	assert.deepEqual(
		[...remote.keys()].sort(),
		[`${SNAPSHOT_DIR_NAME}/2026-10-16T10-00-00.zip`, `${SNAPSHOT_DIR_NAME}/2026-10-16T11-00-00.zip`].sort(),
	);

	// 已经只剩 keep 份，再轮转不该删任何东西
	assert.deepEqual(await mgr.rotate(), []);
});

test("list：兼容两种远端路径口径（带/不带 subDir 前缀），并过滤非 zip、深层与隐藏文件", async () => {
	const { client } = makeClient({
		seedEntries: [
			{ relPath: `${SNAPSHOT_DIR_NAME}/2026-10-16T09-00-00.zip`, size: 10, rev: "r1", serverModified: "2026-10-16T09:00:00Z" },
			{ relPath: `${SNAPSHOT_DIR_NAME}/notes.txt`, size: 1, rev: "r2", serverModified: "t" },
			{ relPath: `${SNAPSHOT_DIR_NAME}/deep/x.zip`, size: 1, rev: "r3", serverModified: "t" },
			{ relPath: `${SNAPSHOT_DIR_NAME}/.DS_Store`, size: 1, rev: "r4", serverModified: "t" },
			{ relPath: "2026-10-16T10-00-00.zip", size: 20, rev: "r5", serverModified: "2026-10-16T10:00:00Z" },
		],
	});
	const mgr = new SnapshotManager({ client, localRootDir: "x", tmpDir: "y", keep: 5 });

	const list = await mgr.list();
	assert.deepEqual(list.map((s) => s.name), ["2026-10-16T10-00-00.zip", "2026-10-16T09-00-00.zip"]);
	assert.equal(list[0].remotePath, `${SNAPSHOT_DIR_NAME}/2026-10-16T10-00-00.zip`);
	assert.equal(list[1].createdAt, "2026-10-16T09:00:00Z");
});

test("list：列举远端出错时返回空数组而不是抛错", async () => {
	const client = {
		async listFolderRecursive() {
			throw new Error("网络断了");
		},
	};
	const mgr = new SnapshotManager({ client, localRootDir: "x", tmpDir: "y", keep: 3, logger: silentLogger });
	assert.deepEqual(await mgr.list(), []);
});

test("download：转发到 client.downloadFile，并保证目标目录已建好", async () => {
	const { client, calls } = makeClient({ seed: ["2026-10-16T09-00-00.zip"] });
	const mgr = new SnapshotManager({ client, localRootDir: "x", tmpDir: "y", keep: 5 });
	const [rec] = await mgr.list();

	const dest = path.join(await tempDir("snap-dl"), "nested", "out.zip");
	await mgr.download(rec, dest);

	assert.deepEqual(calls.downloadFile, [rec.remotePath]);
	assert.ok(fs.existsSync(dest));
	assert.ok((await fsp.stat(dest)).size > 0);
});

/* ============================ sync/engine ============================ */

function makeSettings(over = {}) {
	return {
		dropbox: { appKey: "k" },
		remoteBaseDir: "/Obsidian-Config-Backup",
		redirectPort: 53682,
		authMode: "callback",
		includePatterns: [],
		excludePatterns: [],
		mirrorDelete: true,
		useHash: false,
		concurrency: 3,
		maxFileSizeMB: 150,
		syncOnChange: true,
		changeDebounceSec: 60,
		intervalMinutes: 0,
		startupDelaySec: 45,
		snapshotEnabled: false,
		snapshotMode: "every-run",
		snapshotKeep: 7,
		safetyDir: "",
		confirmBeforeRestore: true,
		logLevel: "info",
		...over,
	};
}

/** 假扫描器：直接把给定的文件清单交回去（引擎测试不碰真实扫描逻辑） */
function fakeScanner(files, extra = {}) {
	return async () => ({
		files: files.map((f) => ({ ...f })),
		excluded: extra.excluded || 0,
		skippedBig: extra.skippedBig || 0,
		totalBytes: files.reduce((s, f) => s + f.size, 0),
		durationMs: 1,
	});
}

async function engineFixture(opts = {}) {
	const vaultDir = await tempDir("vault");
	const configDir = path.join(vaultDir, ".obsidian");
	const spec = opts.spec || { "app.json": "{}", "plugins/x/main.js": "module.exports={};" };
	const files = await writeTree(configDir, spec);
	const { client, calls, remote } = makeClient(opts.client || {});
	const settings = makeSettings(opts.settings || {});

	let index = opts.index || emptyIndex();
	const savedCalls = [];
	const engine = new SyncEngine({
		client,
		indexStore: {
			get: () => index,
			set: async (next) => {
				savedCalls.push(next);
				index = next;
			},
		},
		getSettings: () => settings,
		configDir,
		logger: silentLogger,
		scanner: opts.scanner || fakeScanner(files, { excluded: opts.excluded }),
		matcher: opts.matcher || (() => true),
		snapshotManager: opts.snapshotManager,
		onProgress: opts.onProgress,
	});

	return {
		vaultDir,
		configDir,
		files,
		client,
		calls,
		remote,
		settings,
		engine,
		savedCalls,
		getIndex: () => index,
		setIndex: (next) => {
			index = next;
		},
	};
}

test("engine.plan：算差异、excluded 取自扫描结果、且不写远端/索引", async () => {
	const fx = await engineFixture({ excluded: 7 });
	fx.remote.set("史前遗留.json", {
		relPath: "史前遗留.json",
		size: 1,
		rev: "r0",
		serverModified: "2026-01-01T00:00:00.000Z",
	});

	const { plan, scan, remote: listed } = await fx.engine.plan();

	assert.equal(plan.excluded, 7);
	assert.equal(plan.unchanged, 0);
	assert.deepEqual(plan.toUpload.map((f) => f.relPath).sort(), ["app.json", "plugins/x/main.js"]);
	assert.deepEqual(plan.toDelete, ["史前遗留.json"]);
	assert.equal(scan.files.length, 2);
	assert.deepEqual(listed.map((r) => r.relPath), ["史前遗留.json"]);
	assert.deepEqual(fx.calls.uploadMany, []);
	assert.deepEqual(fx.calls.deletePath, []);
	assert.deepEqual(fx.savedCalls, []);
	assert.equal(fx.engine.running, false);
});

test("engine.run dryRun：只算差异，不上传、不删除、不写索引、不生成快照", async () => {
	let snapshots = 0;
	const fx = await engineFixture({
		settings: { snapshotEnabled: true, snapshotMode: "every-run" },
		snapshotManager: {
			subDir: SNAPSHOT_DIR_NAME,
			list: async () => [],
			createAndUpload: async () => {
				snapshots++;
				throw new Error("dryRun 不该生成快照");
			},
		},
	});
	fx.remote.set("史前遗留.json", { relPath: "史前遗留.json", size: 1, rev: "r0", serverModified: "t" });

	const res = await fx.engine.run("manual", { dryRun: true });

	assert.equal(res.dryRun, true);
	assert.equal(res.trigger, "manual");
	assert.equal(res.uploaded, 0);
	assert.equal(res.deleted, 0);
	assert.equal(res.skipped, 0);
	assert.equal(res.bytesUploaded, 0);
	assert.equal(res.snapshotPath, undefined);
	assert.deepEqual(res.errors, []);
	assert.deepEqual(fx.calls.uploadMany, []);
	assert.deepEqual(fx.calls.deletePath, []);
	assert.equal(fx.savedCalls.length, 0);
	assert.equal(snapshots, 0);
});

test("engine.run 正常路径：上传新增、删除遗留、写索引、统计正确；第二轮全跳过", async () => {
	const fx = await engineFixture();
	fx.remote.set("旧配置/遗留.json", { relPath: "旧配置/遗留.json", size: 3, rev: "r-old", serverModified: "t" });

	const res = await fx.engine.run("manual");

	assert.equal(res.trigger, "manual");
	assert.equal(res.dryRun, false);
	assert.equal(res.uploaded, 2);
	assert.equal(res.deleted, 1);
	assert.equal(res.skipped, 0);
	assert.equal(res.bytesUploaded, 2 + "module.exports={};".length);
	assert.deepEqual(res.errors, []);
	assert.ok(res.startedAt <= res.finishedAt);
	assert.deepEqual([...fx.calls.uploadMany[0]].sort(), ["app.json", "plugins/x/main.js"]);
	assert.deepEqual(fx.calls.deletePath, ["旧配置/遗留.json"]);

	assert.equal(fx.savedCalls.length, 1, "成功一轮应恰好写一次索引");
	const index = fx.getIndex();
	assert.equal(index.version, INDEX_VERSION);
	assert.ok(index.lastSyncAt);
	assert.deepEqual(Object.keys(index.entries).sort(), ["app.json", "plugins/x/main.js"]);
	assert.equal(index.entries["app.json"].size, 2);
	assert.equal(index.entries["app.json"].rev, fx.remote.get("app.json").rev);
	assert.equal(index.entries["plugins/x/main.js"].hash, undefined, "快速模式下不该凭空造 hash");

	const res2 = await fx.engine.run("interval");
	assert.equal(res2.uploaded, 0);
	assert.equal(res2.deleted, 0);
	assert.equal(res2.skipped, 2);
	assert.deepEqual(res2.errors, []);
	assert.deepEqual(fx.calls.deletePath, ["旧配置/遗留.json"]);
});

test("engine.run 单文件失败不中断整轮：失败进 errors 且不进索引", async () => {
	const fx = await engineFixture({ client: { failRel: "plugins/x/main.js" } });

	const res = await fx.engine.run("manual");

	assert.equal(res.uploaded, 1);
	assert.equal(res.deleted, 0);
	assert.equal(res.errors.length, 1);
	assert.equal(res.errors[0].relPath, "plugins/x/main.js");
	assert.match(res.errors[0].message, /模拟上传失败/);
	assert.deepEqual(Object.keys(fx.getIndex().entries), ["app.json"]);
});

test("engine 同一时刻只允许一轮：并发触发被忽略且不碰远端", async () => {
	const fx = await engineFixture();

	const first = fx.engine.run("manual");
	assert.equal(fx.engine.running, true, "run() 一开始就该把 running 置起来");

	const second = await fx.engine.run("interval");
	assert.equal(second.uploaded, 0);
	assert.equal(second.errors.length, 1);
	assert.match(second.errors[0].message, /进行中/);

	await first;
	assert.equal(fx.engine.running, false);
	assert.equal(fx.calls.uploadMany.length, 1, "只该跑一轮");
	assert.deepEqual([...fx.calls.uploadMany[0]].sort(), ["app.json", "plugins/x/main.js"]);
});

test("engine.cancel：扫描之后被取消则不上传、不删、不写索引", async () => {
	const vaultDir = await tempDir("cancel-vault");
	const configDir = path.join(vaultDir, ".obsidian");
	const files = await writeTree(configDir, { "app.json": "{}" });
	const { client, calls } = makeClient();
	const saved = [];

	let engine;
	let firstScan = true;
	const scanner = async () => {
		if (firstScan) {
			firstScan = false;
			engine.cancel();
		}
		return { files, excluded: 0, skippedBig: 0, totalBytes: 2, durationMs: 0 };
	};
	engine = new SyncEngine({
		client,
		indexStore: {
			get: () => emptyIndex(),
			set: async (next) => {
				saved.push(next);
			},
		},
		getSettings: () => makeSettings(),
		configDir,
		logger: silentLogger,
		scanner,
		matcher: () => true,
	});

	const res = await engine.run("manual");

	assert.equal(res.uploaded, 0);
	assert.equal(res.deleted, 0);
	assert.deepEqual(calls.uploadMany, []);
	assert.deepEqual(calls.deletePath, []);
	assert.equal(saved.length, 0, "取消了就不该写索引");
	assert.equal(res.errors.length, 1);
	assert.match(res.errors[0].message, /取消/);
	assert.equal(engine.running, false);

	// 取消标志只对当前这一轮有效
	assert.equal(res.errors.length, 1);
	const again = await engine.run("manual");
	assert.equal(again.uploaded, 1);
	assert.deepEqual(again.errors, []);
});

test("engine.run 快照：every-run 每轮生成；daily 当天已有就跳过、当天没有才生成", async () => {
	const created = [];
	const fakeManager = (names) => ({
		subDir: SNAPSHOT_DIR_NAME,
		async list() {
			return names.map((n) => ({ name: n, remotePath: `${SNAPSHOT_DIR_NAME}/${n}`, createdAt: "t", size: 1 }));
		},
		async createAndUpload(files, label) {
			created.push({ count: files.length, label });
			return { name: "new.zip", remotePath: `${SNAPSHOT_DIR_NAME}/new.zip`, createdAt: "t", size: 1 };
		},
		async rotate() {
			return [];
		},
		async download() {},
	});

	const every = await engineFixture({
		settings: { snapshotEnabled: true, snapshotMode: "every-run" },
		snapshotManager: fakeManager([]),
	});
	const r1 = await every.engine.run("manual");
	assert.equal(created.length, 1);
	assert.deepEqual(created[0], { count: 2, label: "manual" });
	assert.equal(r1.snapshotPath, `${SNAPSHOT_DIR_NAME}/new.zip`);

	created.length = 0;
	const today = snapshotStamp(new Date()).slice(0, 10);
	const dailyHit = await engineFixture({
		settings: { snapshotEnabled: true, snapshotMode: "daily" },
		snapshotManager: fakeManager([`${today}T08-00-00.zip`]),
	});
	const r2 = await dailyHit.engine.run("interval");
	assert.equal(created.length, 0, "当天已有快照，daily 不该再生成");
	assert.equal(r2.snapshotPath, undefined);

	const dailyMiss = await engineFixture({
		settings: { snapshotEnabled: true, snapshotMode: "daily" },
		snapshotManager: fakeManager(["1999-01-01T08-00-00.zip"]),
	});
	const r3 = await dailyMiss.engine.run("startup");
	assert.equal(created.length, 1);
	assert.equal(created[0].label, "startup");
	assert.equal(r3.snapshotPath, `${SNAPSHOT_DIR_NAME}/new.zip`);

	// 关掉快照开关则一次都不生成
	created.length = 0;
	const off = await engineFixture({
		settings: { snapshotEnabled: false, snapshotMode: "every-run" },
		snapshotManager: fakeManager([]),
	});
	await off.engine.run("manual");
	assert.equal(created.length, 0);
});

test("engine.run 快照失败只记 errors，不影响本轮同步结果", async () => {
	const fx = await engineFixture({
		settings: { snapshotEnabled: true, snapshotMode: "every-run" },
		snapshotManager: {
			subDir: SNAPSHOT_DIR_NAME,
			list: async () => [],
			createAndUpload: async () => {
				throw new Error("磁盘满了");
			},
		},
	});

	const res = await fx.engine.run("manual");

	assert.equal(res.uploaded, 2);
	assert.equal(res.snapshotPath, undefined);
	assert.equal(res.errors.length, 1);
	assert.match(res.errors[0].message, /生成快照失败.*磁盘满了/);
});

test("engine 不会把远端 _snapshots 目录当成待删除文件", async () => {
	const fx = await engineFixture();
	fx.remote.set(`${SNAPSHOT_DIR_NAME}/2026-10-16T09-00-00.zip`, {
		relPath: `${SNAPSHOT_DIR_NAME}/2026-10-16T09-00-00.zip`,
		size: 99,
		rev: "r-snap",
		serverModified: "t",
	});

	const res = await fx.engine.run("manual");
	assert.equal(res.deleted, 0);
	assert.deepEqual(fx.calls.deletePath, []);

	const { remote: listed, plan } = await fx.engine.plan();
	assert.ok(!listed.some((r) => r.relPath.includes(SNAPSHOT_DIR_NAME)), "快照区对镜像比对不可见");
	assert.ok(!plan.toDelete.includes(`${SNAPSHOT_DIR_NAME}/2026-10-16T09-00-00.zip`));
});

test("engine 通过 onProgress 依次汇报 scan/list/diff/upload/index", async () => {
	const phases = [];
	const fx = await engineFixture({ onProgress: (p) => phases.push(p) });
	await fx.engine.run("manual");
	assert.deepEqual([...new Set(phases)], ["scan", "list", "diff", "upload", "index"]);
});

test("engine 兼容远端路径带 vault 名前缀的口径：比对、上传、删除都带上前缀", async () => {
	const fx = await engineFixture();
	const prefix = path.basename(fx.vaultDir);
	fx.remote.set(`${prefix}/旧文件.json`, {
		relPath: `${prefix}/旧文件.json`,
		size: 1,
		rev: "r-old",
		serverModified: "t",
	});
	fx.setIndex(
		parseIndex({
			version: INDEX_VERSION,
			lastSyncAt: null,
			entries: {
				"app.json": { size: 2, mtimeMs: fx.files[0].mtimeMs, rev: "r-app", uploadedAt: "t" },
			},
		}),
	);

	const res = await fx.engine.run("manual");

	assert.deepEqual(res.errors, []);
	assert.equal(res.uploaded, 1, "app.json 的 mtime/size 没变，应该跳过");
	assert.equal(res.skipped, 1);
	assert.deepEqual(fx.calls.uploadMany[0], [`${prefix}/plugins/x/main.js`]);
	assert.deepEqual(fx.calls.deletePath, [`${prefix}/旧文件.json`]);
	assert.deepEqual(Object.keys(fx.getIndex().entries).sort(), ["app.json", "plugins/x/main.js"]);
});

test("engine useHash：hash 相同即跳过，索引里存本地 sha256 而不是 Dropbox content_hash", async () => {
	const vaultDir = await tempDir("hash-vault");
	const configDir = path.join(vaultDir, ".obsidian");
	const files = await writeTree(configDir, { "app.json": "{}", "plugins/x/main.js": "module.exports={};" });
	for (const f of files) f.hash = `sha-${f.relPath}`;

	const { client, calls, remote } = makeClient();
	let index = parseIndex({
		version: INDEX_VERSION,
		lastSyncAt: null,
		entries: {
			// mtime 故意写成一个不可能相等的值：hash 一样就必须跳过
			"app.json": { size: 2, mtimeMs: 1, rev: "r-app", uploadedAt: "t", hash: "sha-app.json" },
		},
	});
	remote.set("app.json", { relPath: "app.json", size: 2, rev: "r-app", serverModified: "t" });

	const engine = new SyncEngine({
		client,
		indexStore: {
			get: () => index,
			set: async (next) => {
				index = next;
			},
		},
		getSettings: () => makeSettings({ useHash: true }),
		configDir,
		logger: silentLogger,
		scanner: fakeScanner(files),
		matcher: () => true,
	});

	const res = await engine.run("manual");

	assert.equal(res.uploaded, 1);
	assert.equal(res.skipped, 1);
	assert.deepEqual(calls.uploadMany[0], ["plugins/x/main.js"]);
	assert.equal(index.entries["app.json"].hash, "sha-app.json", "未变的条目应原样保留");
	assert.equal(index.entries["plugins/x/main.js"].hash, "sha-plugins/x/main.js");
	assert.notEqual(index.entries["plugins/x/main.js"].hash, remote.get("plugins/x/main.js").contentHash);
});
