#!/usr/bin/env node
/**
 * 真 Dropbox 冒烟测试。★ 只打沙盒目录，绝不碰线上备份路径。
 *
 * 用法：
 *   DROPBOX_APP_KEY=xxx DROPBOX_REFRESH_TOKEN=yyy NODE_USE_ENV_PROXY=1 node scripts/smoke-dropbox.mjs
 *
 * 关于 NODE_USE_ENV_PROXY：Node 的 node:http 不读 http_proxy/https_proxy 环境变量，
 * 挂了系统代理的机器上直连 Dropbox 会 ETIMEDOUT。本脚本因此用内置 fetch 版的
 * HttpClient（scripts/fetch-http-client.mjs），它需要这个开关才走代理。
 * 插件本身没这个问题：Obsidian 的 requestUrl 走 Electron 网络栈，自带系统代理。
 *
 * 可选环境变量：
 *   SMOKE_BASE   远端根，默认 /Obsidian-Config-Backup
 *   SMOKE_KEEP   设成 1 表示跑完不删沙盒目录（默认会删）
 *
 * 它验证的是真实网络 + 真实 Dropbox 服务端语义：
 *   token 刷新 → 配额/账户 → 中文名上传 → >8MB 走分块会话 → 递归列举（翻页）
 *   → 下载并逐字节比对 → 幂等删除 → 清理沙盒
 *
 * 凭据只从环境变量读，脚本里没有任何秘密，可以安全入库。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFetchHttpClient } from "./fetch-http-client.mjs";
import { refreshAccessToken } from "../src/dropbox/oauth.ts";
import { DropboxClient } from "../src/dropbox/client.ts";
import { RingLogger } from "../src/logger.ts";

const appKey = process.env.DROPBOX_APP_KEY;
const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
if (!appKey || !refreshToken) {
	console.error("缺少 DROPBOX_APP_KEY / DROPBOX_REFRESH_TOKEN 环境变量。");
	console.error("提示：也可以临时借用已配置好的同步插件里的公开客户端凭据（PKCE 刷新不需要 secret）。");
	process.exit(2);
}

const SMOKE_BASE = process.env.SMOKE_BASE || "/Obsidian-Config-Backup";
const KEEP = process.env.SMOKE_KEEP === "1";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const SANDBOX = `${SMOKE_BASE}/_selftest-${stamp}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dropbox-smoke-"));
const logger = new RingLogger({ level: "info", console: true });

let checks = 0;
function ok(cond, label, detail = "") {
	checks += 1;
	if (cond) {
		console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ""}`);
		return;
	}
	console.error(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
	throw new Error(`冒烟测试失败：${label}`);
}

async function buildClient() {
	const http = createFetchHttpClient();
	const refreshed = await refreshAccessToken(http, { appKey, refreshToken });
	ok(
		typeof refreshed.accessToken === "string" && refreshed.accessToken.length > 100,
		"refresh_token 换到了 access_token",
		`${refreshed.accessToken.length} 字符，${refreshed.expiresIn}s 有效`,
	);
	return new DropboxClient({
		http,
		tokens: { appKey, refreshToken, accessToken: refreshed.accessToken },
		baseDir: SANDBOX,
		concurrency: 3,
		logger,
	});
}

async function main(client) {
	console.log(`沙盒目录：${SANDBOX}`);

	const acct = await client.getCurrentAccount();
	ok(Boolean(acct.email), "get_current_account（POST body=null）", `${acct.name} <${acct.email}>`);

	const usage = await client.getSpaceUsage();
	ok(
		usage.allocated > 0 && usage.used >= 0,
		"get_space_usage",
		`已用 ${(usage.used / 2 ** 30).toFixed(2)} GiB / 总 ${(usage.allocated / 2 ** 30).toFixed(2)} GiB`,
	);

	// 1) 中文名 + 空格 —— 不转义 Dropbox-API-Arg 就会在这里炸
	const textName = "中文 测试-配置.json";
	const textLocal = path.join(TMP, "cn.json");
	const textBody = Buffer.from(JSON.stringify({ 中文: "值", n: 1 }), "utf8");
	fs.writeFileSync(textLocal, textBody);
	const up1 = await client.uploadFile(textName, textLocal);
	ok(up1.size === textBody.length, "上传中文名文件", `${textName} ${up1.size}B rev=${up1.rev}`);

	// 2) >8MB 必须走 upload_session
	const bigName = "大文件.bin";
	const bigLocal = path.join(TMP, "big.bin");
	const bigBody = Buffer.concat([Buffer.from("SMOKE-HEAD"), crypto.randomBytes(9 * 1024 * 1024)]);
	fs.writeFileSync(bigLocal, bigBody);
	const up2 = await client.uploadFile(bigName, bigLocal);
	ok(up2.size === bigBody.length, "分块上传 9MB 文件", `${up2.size} 字节`);

	// 3) 递归列举（远端条目超过一页时会自动翻页）
	const listed = await client.listFolderRecursive();
	const byRel = new Map(listed.map((e) => [e.relPath, e]));
	ok(listed.length === 2, "递归列举返回 2 个文件", JSON.stringify([...byRel.keys()]));
	ok(byRel.get(textName)?.size === textBody.length, "远端中文名文件大小正确");
	ok(byRel.get(bigName)?.size === bigBody.length, "远端大文件大小正确");

	// 4) 下载并逐字节比对（含中文名路径）
	const dlLocal = path.join(TMP, "dl.json");
	await client.downloadFile(textName, dlLocal);
	ok(fs.readFileSync(dlLocal).equals(textBody), "下载中文名文件后逐字节一致");

	const dlBuf = await client.downloadBuffer(bigName);
	ok(Buffer.from(dlBuf).equals(bigBody), "下载 9MB 文件后逐字节一致");

	// 5) 幂等删除：删两次，第二次必须静默成功
	await client.deletePath(textName);
	await client.deletePath(textName);
	const afterDelete = await client.listFolderRecursive();
	ok(
		afterDelete.length === 1 && afterDelete[0].relPath === bigName,
		"删除后列举只剩 1 个，且重复删除不报错",
	);

	ok(true, "冒烟测试全部通过", `${checks} 项检查`);
}

async function cleanup(client) {
	if (KEEP) {
		console.log(`SMOKE_KEEP=1，保留沙盒目录：${SANDBOX}`);
		return;
	}
	try {
		const rest = await client.listFolderRecursive();
		for (const e of rest) await client.deletePath(e.relPath);
		await client.deletePath(""); // 沙盒根目录本身
		const left = await client.listFolderRecursive();
		console.log(
			left.length === 0
				? `沙盒目录已清理干净（${SANDBOX}）`
				: `⚠️ 沙盒里还剩 ${left.length} 个文件：${JSON.stringify(left.map((e) => e.relPath))}`,
		);
	} catch (e) {
		console.error(`⚠️ 清理沙盒目录失败，请手动删除 ${SANDBOX}：${e instanceof Error ? e.message : e}`);
	}
}

const client = await buildClient();
let failed = false;
try {
	await main(client);
} catch (e) {
	failed = true;
	console.error(`冒烟测试中断：${e instanceof Error ? e.stack || e.message : e}`);
} finally {
	await cleanup(client);
	fs.rmSync(TMP, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(`\n全部通过：${checks} 项检查`);
