/**
 * Agent D 的真实测试：ConfigWatcher（fs.watch 递归 + 防抖 + 过滤）、
 * Scheduler（启动延迟 + 定时间隔 + update/stop）、以及 src/ui/format.ts 的全部纯函数。
 *
 * 运行：cd "D:/projects/obsidian-config-sync" && node --test --test-reporter=spec test/watch.test.mjs
 *
 * 临时目录写在 test/.tmp/ 下，每个用例自己的子目录，afterEach 清理。
 */
import { afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigWatcher } from "../src/watch/watcher.ts";
import { Scheduler } from "../src/scheduler.ts";
import {
	formatBytes,
	formatClock,
	formatClockMinutes,
	formatCount,
	formatDuration,
	formatInterval,
	formatIsoClock,
	formatPercent,
	formatProgress,
	formatRelativeTime,
	formatScopeSummary,
	formatSpaceUsage,
	formatSyncSummary,
	formatTrigger,
	truncate,
	truncateMiddle,
} from "../src/ui/format.ts";
import { DEFAULT_SETTINGS } from "../src/config/defaults.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(HERE, ".tmp");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立，返回最终是否成立（避免测试永久挂住）。 */
async function waitUntil(predicate, timeoutMs, stepMs = 20) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(stepMs);
	}
	return predicate();
}

/* ============================ ConfigWatcher ============================ */

describe("ConfigWatcher", () => {
	let rootDir = "";
	/** @type {ConfigWatcher | null} */
	let watcher = null;

	before(() => {
		mkdirSync(TMP_ROOT, { recursive: true });
	});

	afterEach(() => {
		if (watcher) watcher.stop();
		watcher = null;
		if (rootDir) rmSync(rootDir, { recursive: true, force: true });
		rootDir = "";
	});

	function makeRoot() {
		rootDir = mkdtempSync(join(TMP_ROOT, "watch-"));
		return rootDir;
	}

	function makeWatcher(overrides = {}) {
		watcher = new ConfigWatcher({
			rootDir,
			isRelevant: () => true,
			debounceMs: 60,
			onChange: () => {},
			...overrides,
		});
		return watcher;
	}

	test("start() 进入监听、stop() 退出，重复调用幂等", () => {
		makeRoot();
		const w = makeWatcher();
		assert.equal(w.running, false, "构造后不应处于监听状态");

		w.start();
		assert.equal(w.running, true, "start() 后 running 应为 true");

		w.start(); // 幂等：第二次不该又开一个 watcher
		assert.equal(w.running, true);

		w.stop();
		assert.equal(w.running, false, "stop() 后 running 应为 false");

		w.stop(); // 幂等
		assert.equal(w.running, false);
	});

	test("目录不存在时 start() 把错误交给 onError，且不进入监听", () => {
		makeRoot();
		const errors = [];
		const w = new ConfigWatcher({
			rootDir: join(rootDir, "this-dir-does-not-exist"),
			isRelevant: () => true,
			debounceMs: 10,
			onChange: () => {},
			onError: (err) => errors.push(err),
		});
		watcher = w;

		w.start();

		assert.equal(errors.length, 1, `期望恰好一次 onError，实际 ${errors.length}`);
		assert.ok(errors[0] instanceof Error, "onError 应收到 Error");
		assert.equal(w.running, false, "启动失败不应处于监听状态");
		assert.equal(w.pendingCount(), 0);
	});

	test("文件改动经防抖触发一次 onChange，relPath 统一 '/' 分隔且无前导斜杠", async () => {
		makeRoot();
		// 目录先建好，再开始监听：不依赖「新目录自动纳入递归监听」这个平台细节
		mkdirSync(join(rootDir, "plugins", "测试插件"), { recursive: true });

		const calls = [];
		const w = makeWatcher({ debounceMs: 80, onChange: (paths) => calls.push(paths) });
		w.start();
		await sleep(150);

		writeFileSync(join(rootDir, "plugins", "测试插件", "data.json"), '{"a":1}');

		assert.ok(await waitUntil(() => calls.length > 0, 4000), "4 秒内没有收到 onChange");
		const seen = calls.flat();
		assert.ok(seen.includes("plugins/测试插件/data.json"), `未捕获目标文件：${JSON.stringify(seen)}`);
		for (const p of seen) {
			assert.ok(!p.includes("\\"), `relPath 含反斜杠：${p}`);
			assert.ok(!p.startsWith("/"), `relPath 有前导斜杠：${p}`);
		}
	});

	test("pendingCount 在防抖窗口内反映待同步路径数，flush 后清零", async () => {
		makeRoot();
		const calls = [];
		const w = makeWatcher({ debounceMs: 250, onChange: (paths) => calls.push(paths) });
		w.start();
		await sleep(120);

		assert.equal(w.pendingCount(), 0, "一开始没有待同步路径");

		writeFileSync(join(rootDir, "community-plugins.json"), "[]");

		assert.ok(await waitUntil(() => w.pendingCount() > 0, 3000), "事件没有被记进 pending");
		assert.ok(w.pendingCount() >= 1);
		assert.ok(await waitUntil(() => calls.length > 0, 3000), "防抖结束后没有触发 onChange");
		assert.equal(w.pendingCount(), 0, "触发后 pending 应该被清空");
	});

	test("防抖窗口内的多处改动合并成一次回调", async () => {
		makeRoot();
		const calls = [];
		const w = makeWatcher({ debounceMs: 400, onChange: (paths) => calls.push(paths) });
		w.start();
		await sleep(150);

		writeFileSync(join(rootDir, "a.txt"), "a");
		writeFileSync(join(rootDir, "b.txt"), "b");
		writeFileSync(join(rootDir, "c.txt"), "c");

		assert.ok(await waitUntil(() => calls.length > 0, 4000), "没有触发回调");
		await sleep(500); // 再等一个完整防抖窗口，确认没有第二次
		assert.equal(calls.length, 1, `期望合并为 1 次，实际 ${calls.length} 次：${JSON.stringify(calls)}`);
		assert.deepEqual(calls[0], ["a.txt", "b.txt", "c.txt"]);
	});

	test("isRelevant 返回 false 的改动不会触发同步", async () => {
		makeRoot();
		mkdirSync(join(rootDir, "keep"), { recursive: true });
		mkdirSync(join(rootDir, "drop"), { recursive: true });

		const calls = [];
		const w = makeWatcher({
			debounceMs: 60,
			isRelevant: (relPath) => relPath.startsWith("keep/"),
			onChange: (paths) => calls.push(paths),
		});
		w.start();
		await sleep(150);

		// 先证明监听本身是活的
		writeFileSync(join(rootDir, "keep", "ok.txt"), "ok");
		assert.ok(await waitUntil(() => calls.length > 0, 4000), "监听没有生效");
		const seen = calls.length;

		writeFileSync(join(rootDir, "drop", "no.txt"), "no");
		await sleep(500);

		assert.equal(calls.length, seen, `被过滤的路径仍然触发了回调：${JSON.stringify(calls)}`);
		assert.equal(w.pendingCount(), 0);
	});

	test("stop() 之后不再回调", async () => {
		makeRoot();
		const calls = [];
		const w = makeWatcher({ debounceMs: 60, onChange: (paths) => calls.push(paths) });
		w.start();
		await sleep(150);

		writeFileSync(join(rootDir, "first.txt"), "1");
		assert.ok(await waitUntil(() => calls.length > 0, 4000), "第一次改动没有触发");
		w.stop();

		const seen = calls.length;
		writeFileSync(join(rootDir, "second.txt"), "2");
		await sleep(400);
		assert.equal(calls.length, seen, `stop() 之后仍然回调：${JSON.stringify(calls)}`);
	});
});

/* ============================ Scheduler ============================ */

describe("Scheduler", () => {
	/** @type {Scheduler[]} */
	const live = [];

	afterEach(() => {
		for (const s of live.splice(0)) s.stop();
	});

	function makeScheduler(opts) {
		const s = new Scheduler(opts);
		live.push(s);
		return s;
	}

	test("start() 先触发一次 startup，再按 intervalMs 周期触发 interval", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0, intervalMs: 40, onTick: (r) => ticks.push(r) });

		s.start();
		assert.equal(ticks.length, 0, "start() 内不应同步回调");
		assert.notEqual(s.nextFireAt(), null, "start() 后应有待触发时间");

		assert.ok(
			await waitUntil(() => ticks.filter((t) => t === "interval").length >= 2, 3000),
			`interval 触发次数不足：${JSON.stringify(ticks)}`,
		);
		assert.equal(ticks.filter((t) => t === "startup").length, 1, "startup 只应触发一次");
		assert.equal(ticks[0], "startup", "startup 应该最先触发");

		s.stop();
		assert.equal(s.nextFireAt(), null, "stop() 后 nextFireAt 应为 null");
	});

	test("intervalMinutes = 0 且没有 intervalMs 时只触发 startup", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0, onTick: (r) => ticks.push(r) });

		s.start();
		assert.ok(await waitUntil(() => ticks.length > 0, 2000), "startup 没有触发");
		await sleep(200);
		assert.deepEqual(ticks, ["startup"], `不该有周期触发：${JSON.stringify(ticks)}`);
		assert.equal(s.nextFireAt(), null, "没有待触发任务时 nextFireAt 应为 null");
	});

	test("startupDelaySec 生效：延迟之内不触发，nextFireAt 指向延迟时刻", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0.2, onTick: (r) => ticks.push(r) });

		s.start();
		await sleep(80);
		assert.equal(ticks.length, 0, `延迟未到就触发了：${JSON.stringify(ticks)}`);

		const next = s.nextFireAt();
		assert.notEqual(next, null);
		assert.ok(next > Date.now() - 10 && next <= Date.now() + 260, `nextFireAt 不合理：${next}`);

		assert.ok(await waitUntil(() => ticks.length > 0, 2000), "延迟到点后没有触发");
		assert.deepEqual(ticks, ["startup"]);
		assert.equal(s.nextFireAt(), null, "startup 跑完后没有周期任务，nextFireAt 应为 null");
	});

	test("stop() 之后不再触发", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0, intervalMs: 30, onTick: (r) => ticks.push(r) });

		s.start();
		assert.ok(await waitUntil(() => ticks.includes("interval"), 2000), "没有等到 interval");
		s.stop();

		const seen = ticks.length;
		await sleep(200);
		assert.equal(ticks.length, seen, `stop() 之后仍有触发：${JSON.stringify(ticks)}`);
	});

	test("update() 调整周期立即生效", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0, intervalMs: 30, onTick: (r) => ticks.push(r) });

		s.start();
		assert.ok(await waitUntil(() => ticks.filter((t) => t === "interval").length >= 2, 2000), "没有等到周期触发");

		s.update({ intervalMs: 400 });
		await sleep(120); // 让可能已排队的旧 tick 落地
		const settled = ticks.length;
		await sleep(220); // 合计仍小于新周期 400ms
		assert.equal(ticks.length, settled, `调大周期后仍被触发：${JSON.stringify(ticks)}`);

		s.update({ intervalMs: 20 });
		assert.ok(await waitUntil(() => ticks.length > settled, 2000), "调小周期后没有触发");
	});

	test("update({ intervalMs: 0 }) 关闭周期触发", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0, intervalMs: 30, onTick: (r) => ticks.push(r) });

		s.start();
		assert.ok(await waitUntil(() => ticks.includes("interval"), 2000), "没有等到周期触发");
		s.update({ intervalMs: 0 });

		await sleep(60);
		const seen = ticks.length;
		await sleep(180);
		assert.equal(ticks.length, seen, `关闭后仍触发：${JSON.stringify(ticks)}`);
		assert.equal(s.nextFireAt(), null);
	});

	test("update() 不会重跑启动同步（且保留没显式传的注入值）", async () => {
		const ticks = [];
		const s = makeScheduler({
			intervalMinutes: 0,
			startupDelaySec: 0.05,
			intervalMs: 10_000,
			onTick: (r) => ticks.push(r),
		});

		s.start();
		assert.ok(await waitUntil(() => ticks.includes("startup"), 2000), "startup 没有触发");
		s.update({ intervalMinutes: 30 });

		await sleep(150);
		assert.deepEqual(ticks, ["startup"], `update() 不该重跑 startup、也不该用 intervalMinutes 覆盖注入的 intervalMs：${JSON.stringify(ticks)}`);
	});

	test("未 start() 时 update() 不会开始计时", async () => {
		const ticks = [];
		const s = makeScheduler({ intervalMinutes: 0, startupDelaySec: 0, intervalMs: 20, onTick: (r) => ticks.push(r) });

		s.update({ intervalMinutes: 5 });
		await sleep(120);
		assert.deepEqual(ticks, [], `未 start() 不该触发：${JSON.stringify(ticks)}`);
		assert.equal(s.nextFireAt(), null);
	});
});

/* ============================ ui/format ============================ */

describe("ui/format", () => {
	test("formatBytes：0 / 负数 / NaN / 各量级", () => {
		assert.equal(formatBytes(0), "0 B");
		assert.equal(formatBytes(-1), "0 B");
		assert.equal(formatBytes(Number.NaN), "0 B");
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(1023), "1023 B");
		assert.equal(formatBytes(1024), "1.0 KB");
		assert.equal(formatBytes(1024 * 1024), "1.0 MB");
		assert.equal(formatBytes(344 * 1024 * 1024), "344.0 MB");
		assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
	});

	test("formatDuration：毫秒 / 秒 / 分 / 时", () => {
		assert.equal(formatDuration(0), "0 ms");
		assert.equal(formatDuration(450), "450 ms");
		assert.equal(formatDuration(1500), "1.5 秒");
		assert.equal(formatDuration(59_400), "59.4 秒");
		assert.equal(formatDuration(60_000), "1 分钟");
		assert.equal(formatDuration(65_000), "1 分 5 秒");
		assert.equal(formatDuration(3_600_000), "1 小时");
		assert.equal(formatDuration(3_900_000), "1 小时 5 分");
	});

	test("formatClock / formatClockMinutes / formatIsoClock 用本地时区", () => {
		const ts = new Date(2026, 9, 16, 21, 30, 5).getTime();
		assert.equal(formatClock(ts), "2026-10-16 21:30:05");
		assert.equal(formatClockMinutes(ts), "2026-10-16 21:30");
		assert.equal(formatIsoClock(new Date(ts).toISOString()), "2026-10-16 21:30");
		assert.equal(formatIsoClock(null), "—");
		assert.equal(formatIsoClock(undefined), "—");
		assert.equal(formatIsoClock("not-a-date"), "—");
		assert.equal(formatClock(Number.NaN), "—");
	});

	test("formatRelativeTime 各档位", () => {
		const now = new Date(2026, 9, 16, 21, 30, 0).getTime();
		const ago = (ms) => new Date(now - ms).toISOString();

		assert.equal(formatRelativeTime(null, now), "从未");
		assert.equal(formatRelativeTime("bad-input", now), "从未");
		assert.equal(formatRelativeTime(ago(-5_000), now), "刚刚", "时间戳在未来（时钟漂移）也算刚刚");
		assert.equal(formatRelativeTime(ago(3_000), now), "刚刚");
		assert.equal(formatRelativeTime(ago(30_000), now), "30 秒前");
		assert.equal(formatRelativeTime(ago(5 * 60_000), now), "5 分钟前");
		assert.equal(formatRelativeTime(ago(3 * 3_600_000), now), "3 小时前");
		assert.equal(formatRelativeTime(ago(2 * 86_400_000), now), "2 天前");
		assert.equal(formatRelativeTime(ago(30 * 86_400_000), now), "2026-09-16 21:30");
	});

	test("formatCount / formatPercent / formatProgress", () => {
		assert.equal(formatCount(0), "0");
		assert.equal(formatCount(999), "999");
		assert.equal(formatCount(1234), "1,234");
		assert.equal(formatCount(1234567), "1,234,567");
		assert.equal(formatPercent(0, 0), "0%");
		assert.equal(formatPercent(1, 3), "33%");
		assert.equal(formatPercent(5, 2), "100%", "超过总量要夹到 100%");
		assert.equal(formatPercent(-1, 4), "0%");
		assert.equal(formatProgress("上传", 3, 10), "上传 3/10（30%）");
		assert.equal(formatProgress("扫描", 0, 0), "扫描");
	});

	test("formatTrigger / formatInterval", () => {
		assert.equal(formatTrigger("manual"), "手动");
		assert.equal(formatTrigger("interval"), "定时");
		assert.equal(formatTrigger("watch"), "文件变更");
		assert.equal(formatTrigger("startup"), "启动");
		assert.equal(formatInterval(0), "关闭");
		assert.equal(formatInterval(-5), "关闭");
		assert.equal(formatInterval(45), "45 分钟");
		assert.equal(formatInterval(60), "1 小时");
		assert.equal(formatInterval(90), "1 小时 30 分");
	});

	test("formatSpaceUsage / formatScopeSummary", () => {
		assert.equal(formatSpaceUsage(2 * 1024 ** 3, 8 * 1024 ** 3), "2.0 GB / 8.0 GB（已用 25%）");
		assert.equal(formatSpaceUsage(1024, 0), "1.0 KB", "配额未知时只给已用量");

		assert.equal(
			formatScopeSummary({ ...DEFAULT_SETTINGS, includePatterns: [], excludePatterns: ["a", "b"] }),
			"白名单为空（全部纳入），黑名单 2 条",
		);
		assert.equal(
			formatScopeSummary({ ...DEFAULT_SETTINGS, includePatterns: ["plugins/**"], excludePatterns: [] }),
			"白名单 1 条，黑名单 0 条",
		);
	});

	test("formatSyncSummary 汇总一轮结果", () => {
		const base = {
			trigger: "manual",
			startedAt: "2026-10-16T13:30:00.000Z",
			finishedAt: "2026-10-16T13:30:05.200Z",
			uploaded: 12,
			deleted: 2,
			skipped: 340,
			bytesUploaded: 3_400_000,
			errors: [],
			dryRun: false,
		};

		assert.equal(formatSyncSummary(base), "手动 · 上传 12（3.2 MB） · 删除 2 · 跳过 340 · 用时 5.2 秒");

		assert.equal(
			formatSyncSummary({
				...base,
				trigger: "watch",
				dryRun: true,
				uploaded: 0,
				deleted: 0,
				skipped: 0,
				bytesUploaded: 0,
				snapshotPath: "vault/_snapshots/2026-10-16T13-30-00.zip",
			}),
			"文件变更 · 预演 · 上传 0 · 跳过 0 · 已生成快照 · 用时 5.2 秒",
		);

		assert.equal(
			formatSyncSummary({ ...base, errors: [{ relPath: "a.json", message: "boom" }] }),
			"手动 · 上传 12（3.2 MB） · 删除 2 · 跳过 340 · 失败 1 · 用时 5.2 秒",
		);
	});

	test("truncate / truncateMiddle", () => {
		assert.equal(truncate("abc", 5), "abc");
		assert.equal(truncate("abc", 3), "abc");
		assert.equal(truncate("abcdef", 4), "abc…");
		assert.equal(truncate("abc", 1), "a");
		assert.equal(truncate("abc", 0), "");

		assert.equal(truncateMiddle("abcdef", 10), "abcdef");
		assert.equal(truncateMiddle("abcdefghij", 7), "abc…hij");
		assert.equal(truncateMiddle("abcdefghij", 2), "a…");
		assert.equal(truncateMiddle("abc", 0), "");
	});
});
