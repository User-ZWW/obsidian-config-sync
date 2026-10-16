#!/usr/bin/env node
/**
 * 把构建产物装进 vault 的插件目录。
 *
 * 用法：
 *   node scripts/deploy.mjs                       # 用下面的默认 vault
 *   node scripts/deploy.mjs "D:\\path\\to\\vault"   # 指定 vault 根目录
 *   VAULT_ROOT=... node scripts/deploy.mjs
 *
 * 只拷 main.js / manifest.json / styles.css，不拷源码和 node_modules。
 * 部署后需要在 Obsidian 设置 → 第三方插件里手动启用（或用 BRAT 的方式重启）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const PLUGIN_ID = "obsidian-config-sync";

const DEFAULT_VAULT = "C:\\Users\\User-ZWW\\Downloads\\MyVault";
const vaultRoot = process.argv[2] || process.env.VAULT_ROOT || DEFAULT_VAULT;

const manifest = JSON.parse(readFileSync(join(projectRoot, "manifest.json"), "utf8"));
if (manifest.id !== PLUGIN_ID) {
	throw new Error(`manifest.id (${manifest.id}) 与部署目录名 (${PLUGIN_ID}) 不一致`);
}

const target = join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID);
mkdirSync(target, { recursive: true });

const files = ["main.js", "manifest.json", "styles.css"];
const copied = [];
for (const f of files) {
	const src = join(projectRoot, f);
	if (!existsSync(src)) {
		if (f === "main.js") throw new Error("没找到 main.js，先跑 npm run build");
		continue;
	}
	copyFileSync(src, join(target, f));
	copied.push(`${f} (${(statSync(src).size / 1024).toFixed(1)} KB)`);
}

console.log(`已部署到 ${target}`);
for (const c of copied) console.log("  " + c);
console.log("下一步：Obsidian → 设置 → 第三方插件 → 启用「" + manifest.name + "」");
