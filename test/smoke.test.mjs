/**
 * Phase 1 冒烟测试：确认 node 能直接跑 .ts 源码、默认设置符合实测结论。
 * 运行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS, DEFAULT_EXCLUDES } from "../src/config/defaults.ts";
import { mergeSettings, SettingsStore } from "../src/settings.ts";

test("默认排除规则覆盖三个体积大户", () => {
	for (const p of [".git/", "icons/", "plugins/插件备份*/"]) {
		assert.ok(DEFAULT_EXCLUDES.includes(p), `DEFAULT_EXCLUDES 缺少 ${p}`);
	}
});

test("默认远端根目录是绝对路径风格", () => {
	assert.match(DEFAULT_SETTINGS.remoteBaseDir, /^\//);
});

test("mergeSettings 深合并且数组整体替换", async () => {
	const merged = mergeSettings({ dropbox: { appKey: "abc" }, excludePatterns: ["only-this/"] });
	assert.equal(merged.dropbox.appKey, "abc");
	assert.equal(merged.dropbox.appSecret, "");
	assert.deepEqual(merged.excludePatterns, ["only-this/"]);
	assert.equal(merged.snapshotKeep, DEFAULT_SETTINGS.snapshotKeep);
});

test("SettingsStore 能 load / save / update，且不会污染 DEFAULT_SETTINGS", async () => {
	let stored = null;
	const store = new SettingsStore({
		async loadData() {
			return stored;
		},
		async saveData(d) {
			stored = JSON.parse(JSON.stringify(d));
		},
	});
	await store.load();
	await store.update({ intervalMinutes: 120 });
	assert.equal(stored.intervalMinutes, 120);
	assert.equal(DEFAULT_SETTINGS.intervalMinutes, 0, "DEFAULT_SETTINGS 被写脏了");
	const again = new SettingsStore({
		async loadData() {
			return stored;
		},
		async saveData() {},
	});
	const s2 = await again.load();
	assert.equal(s2.intervalMinutes, 120);
	assert.equal(s2.remoteBaseDir, "/Obsidian-Config-Backup");
});
