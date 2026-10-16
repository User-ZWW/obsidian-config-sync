/**
 * 无头加载测试：真的 require 打包产物 main.js，真的实例化插件类，真的跑 onload / onunload，
 * 再把设置面板的 display() 在严格替身上跑一遍。
 *
 * 为什么需要它：`npm run build` 成功只说明代码能打包，不能说明插件在 Obsidian 里加载得起来。
 * 这个测试覆盖的正是那一环 —— 打包产物的顶层求值、默认导出是不是插件类、加载期有没有崩、
 * UI 代码有没有调用 Obsidian 里不存在的 API、卸载后有没有留下定时器/文件监听。
 *
 * 前提：先 npm run build（或用 npm run test:load，它会先构建）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const MAIN_JS = path.join(REPO, "main.js");
const STUB_PATH = path.join(HERE, "helpers", "obsidian-stub.cjs");

const require = createRequire(import.meta.url);
const VALID = require("./helpers/obsidian-stub.cjs");

const TMP = path.join(HERE, ".tmp", `load-${process.pid}`);
const VAULT = path.join(TMP, "LoadTestVault");
const CONFIG_DIR = path.join(VAULT, ".obsidian");

let PluginClass;
let stub;

/**
 * 按 CommonJS 编译打包产物 —— 这正是 Obsidian 加载插件的方式。
 *
 * 不能用 require(MAIN_JS)：仓库的 package.json 是 "type": "module"，Node 会因为
 * main.js 的 .js 扩展名把它当 ES 模块解析，于是报 "module is not defined"。
 * Obsidian 不看插件目录里的 package.json，它总是按 CJS 编译，所以用 _compile 才保真。
 */
function loadPluginModule() {
	const source = fs.readFileSync(MAIN_JS, "utf8");
	const mod = new Module(MAIN_JS, null);
	mod.filename = MAIN_JS;
	mod.paths = Module._nodeModulePaths(path.dirname(MAIN_JS));

	const original = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "obsidian") return VALID;
		return original.apply(this, arguments);
	};
	try {
		mod._compile(source, MAIN_JS);
	} finally {
		Module._load = original;
	}
	return mod.exports;
}

/**
 * libuv 资源计数。Windows 上 fs.watch 的资源名是 FSEventWrap（不是 FSWatcher）。
 * 只数文件监听：node:test 自己会创建定时器，用 Timeout 计数做断言不可靠。
 */
function activeResources() {
	const list = process.getActiveResourcesInfo();
	const count = (name) => list.filter((r) => r === name).length;
	return { fsWatcher: count("FSEventWrap") + count("FSWatcher") + count("StatWatcher") };
}

/** 等日志长度稳定 quietMs 毫秒，用来排除"还有同步在飞"的干扰 */
async function waitQuiet(plugin, quietMs, maxMs = 25000) {
	let last = plugin.getLog().length;
	let stableSince = Date.now();
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 200));
		const now = plugin.getLog().length;
		if (now !== last) {
			last = now;
			stableSince = Date.now();
		} else if (Date.now() - stableSince >= quietMs) {
			return;
		}
	}
}

before(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.mkdirSync(path.join(CONFIG_DIR, "plugins", "obsidian-config-sync"), { recursive: true });
	fs.mkdirSync(path.join(CONFIG_DIR, "themes", "t"), { recursive: true });
	fs.writeFileSync(path.join(CONFIG_DIR, "app.json"), '{"promptDelete":false}');
	fs.writeFileSync(path.join(CONFIG_DIR, "themes", "t", "theme.css"), "body{}");
	fs.writeFileSync(path.join(CONFIG_DIR, "snippets.css"), "/* x */");
});

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

test("打包产物能在无头环境加载并正常装配", async (t) => {
	assert.ok(fs.existsSync(MAIN_JS), "没找到 main.js，先跑 npm run build");
	stub = loadPluginModule();

	await t.test("默认导出是一个插件类", () => {
		assert.equal(typeof stub.default, "function");
		assert.ok(stub.default.prototype instanceof VALID.Plugin, "应继承 obsidian 的 Plugin");
	});

	await t.test("打包产物必须是 CommonJS（Obsidian 按 CJS 编译它）", () => {
		const source = fs.readFileSync(MAIN_JS, "utf8");
		assert.ok(
			!/^\s*(import|export)\s/m.test(source),
			"main.js 里出现了 ESM 语法：esbuild 的 format 必须保持 cjs",
		);
		assert.ok(source.includes("module.exports"), "应由 CJS 导出插件类");
	});

	const app = new VALID.App(VAULT);
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));
	PluginClass = stub.default;
	// 防抖默认 60 秒，测试里压到允许的最小值 5 秒，好在合理时间内验证 fs.watch 真的在工作
	VALID.Plugin.__testData = { changeDebounceSec: 5 };
	const plugin = new PluginClass(app, manifest);

	const baseline = activeResources();

	await t.test("onload() 不抛异常，并完成全部装配", async () => {
		await plugin.onload();

		assert.equal(plugin.settingTabs.length, 1, "应注册 1 个设置面板");
		assert.equal(plugin.ribbons.length, 1, "应只注册 1 个 ribbon 图标（不要重复）");
		assert.equal(plugin.statusBarItems.length, 1, "应注册 1 个状态栏项");

		const ids = plugin.commands.map((c) => c.id).sort();
		for (const id of [
			"sync-now",
			"preview-diff",
			"snapshot-now",
			"connect-dropbox",
			"disconnect-dropbox",
			"restore-preview",
			"restore-apply",
			"open-settings",
		]) {
			assert.ok(ids.includes(id), `缺少命令 ${id}，实际有 ${ids.join(",")}`);
		}
		for (const c of plugin.commands) {
			assert.equal(typeof c.callback, "function", `命令 ${c.id} 的 callback 必须是函数`);
			assert.ok(c.name && c.name.length > 0, `命令 ${c.id} 缺 name`);
		}

		assert.equal(plugin.settings.remoteBaseDir, "/Obsidian-Config-Backup", "应加载出默认设置");
		assert.equal(typeof plugin.configDirAbs(), "string");
		assert.equal(plugin.vaultName(), "LoadTestVault");
		assert.match(plugin.configDirAbs(), /LoadTestVault[\\/]\.obsidian$/);
		assert.equal(plugin.getRestoreManager(), null, "没配 Dropbox 时不该给出 RestoreManager");
	});

	await t.test("没配 Dropbox 就点「连接」会给出明确报错，而不是静默失败", async () => {
		await assert.rejects(() => plugin.connectDropbox(), /App key/);
	});

	await t.test("没配凭据时 getClient() 报错信息可读", () => {
		assert.throws(() => plugin.getClient(), /还没连接 Dropbox/);
	});

	await t.test("设置面板 display() 在未连接 Dropbox 的状态下也不崩", () => {
		const tab = plugin.settingTabs[0];
		tab.display();
		assert.ok(true);
	});

	await t.test("设置面板 display() 在已配置凭据的状态下也不崩", async () => {
		plugin.settings.dropbox = {
			...plugin.settings.dropbox,
			appKey: "fake-key",
			accessToken: "fake-access",
			refreshToken: "fake-refresh",
		};
		plugin.getClient(); // 建客户端不该发起网络请求
		plugin.settingTabs[0].display();
		const rm = plugin.getRestoreManager();
		assert.ok(rm, "有凭据时应能给出 RestoreManager");
		// 清干净：否则缓存的假凭据客户端会让后面的用例意外发起真同步
		plugin.settings.dropbox = { ...plugin.settings.dropbox, accessToken: undefined, refreshToken: undefined };
		plugin.client = null;
		plugin._engine = null;
		plugin.restoreManager = null;
	});

	await t.test("状态栏点一下（无凭据）不该产生未捕获异常", async () => {
		const el = plugin.statusBarItems[0];
		const rec = el.__rec;
		assert.ok(rec.handlers.length > 0, "状态栏应注册点击回调");
		// 直接把回调跑一遍；内部自己有 try/catch + Notice，不该往外抛
		for (const h of rec.handlers) await h({ preventDefault() {} });
		const texts = VALID.__registry.map((r) => r.text).filter(Boolean);
		assert.ok(
			texts.some((s) => s.includes("配置备份")),
			`状态栏应显示带「配置备份」的文案，实际有 ${JSON.stringify(texts.slice(0, 5))}`,
		);
	});

	await t.test("监听与定时器真的起来了", async () => {
		assert.equal(plugin.watcher.running, true, ".obsidian 目录监听应在跑");
		assert.notEqual(plugin.scheduler.nextFireAt(), null, "启动后延迟同步的定时器应已排上");
	});

	await t.test("改一个配置文件会走完防抖并真的发起同步（fs.watch 链路是活的）", async () => {
		// 先等日志安静下来，确保没有别的同步在飞（否则会误判成是文件变更触发的）
		await waitQuiet(plugin, 1200);
		const before = plugin.getLog().length;
		const started = Date.now();

		fs.writeFileSync(path.join(CONFIG_DIR, "app.json"), '{"promptDelete":true,"touched":1}');

		// 链路：fs.watch 事件 → 防抖(5s) → onChange → runSync('watch')。
		// 无头环境没配凭据，runSync 会在 getClient() 处失败，main.ts 里 watcher 的
		// .catch 会记一条 error 日志 —— 这就是"事件真的走完了防抖"的证据。
		const deadline = Date.now() + 12000;
		let fired = false;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 250));
			const fresh = plugin.getLog().slice(before);
			if (fresh.some((l) => l.includes("变更触发同步失败") || l.includes("list_folder"))) {
				fired = true;
				break;
			}
		}
		const elapsed = Date.now() - started;

		assert.ok(
			fired,
			`改文件后应触发一轮同步。这期间的全部日志：${JSON.stringify(plugin.getLog().slice(before))}`,
		);
		assert.ok(
			elapsed >= 4500,
			`必须经过 5 秒防抖才发起，实际只用了 ${elapsed}ms —— 说明这轮同步不是被文件变更触发的`,
		);
	});

	await t.test("onunload() 把监听和定时器都收干净", async () => {
		await plugin.onunload();
		await new Promise((r) => setImmediate(r));
		assert.equal(plugin.watcher.running, false, "卸载后目录监听应已停止");
		assert.equal(plugin.scheduler.nextFireAt(), null, "卸载后不该还排着定时触发");
	});
});
