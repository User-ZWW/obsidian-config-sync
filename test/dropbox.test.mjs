/**
 * Dropbox 客户端层真实测试（src/http/node.ts、src/http/obsidian.ts 的 node 对应物、
 * src/dropbox/oauth.ts、src/dropbox/client.ts）。
 *
 * 不 mock 传输层：本地起真实的 mock Dropbox HTTP 服务（真 socket），
 * 用 createNodeHttpClient 真发请求，覆盖 json/text/arraybuffer、分块上传、
 * 翻页列举、幂等删除、并发上传、429/5xx 退避重试、401 刷新重试、OAuth PKCE 全流程。
 *
 * 运行：node --test --test-reporter=spec test/dropbox.test.mjs
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeHttpClient } from "../src/http/node.ts";
import { DropboxClient, DropboxApiError } from "../src/dropbox/client.ts";
import {
	DROPBOX_AUTHORIZE_URL,
	DROPBOX_TOKEN_URL,
	buildAuthorizeUrl,
	createPkcePair,
	exchangeCodeForTokens,
	refreshAccessToken,
	startLocalCallbackServer,
} from "../src/dropbox/oauth.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(HERE, ".tmp", "dropbox");
const CHUNK = DropboxClient.CHUNK_SIZE;
const JSON_HEADERS = { "Content-Type": "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Dropbox 官方 content_hash 算法：按 4MiB 分块，取每块 sha256 后再 sha256 */
function dropboxContentHash(buf) {
	const BLOCK = 4 * 1024 * 1024;
	const blocks = Math.max(1, Math.ceil(buf.length / BLOCK));
	const outer = crypto.createHash("sha256");
	for (let i = 0; i < blocks; i++) {
		const block = buf.subarray(i * BLOCK, Math.min((i + 1) * BLOCK, buf.length));
		outer.update(crypto.createHash("sha256").update(block).digest());
	}
	return outer.digest("hex");
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("error", reject);
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});
}

/* ======================================================================
 * mock Dropbox 服务
 * ==================================================================== */
class MockDropbox {
	constructor() {
		/** remotePath -> { data, rev, serverModified, contentHash } */
		this.files = new Map();
		this.dirs = new Set();
		this.sessions = new Map(); // sessionId -> { chunks: Buffer[], size }
		this.cursors = new Map(); // cursor -> 剩余条目
		this.pageSize = 1000;
		this.seq = 0;
		this.sessionSeq = 0;
		this.tokenSeq = 0;
		this.currentToken = "at-1";
		this.refreshToken = "rt-1";
		this.counts = new Map();
		this.pathUploadCounts = new Map();
		this.sessionCalls = [];
		this.tokenForms = [];
		this.authRejects = 0;
		this.inFlightUploads = 0;
		this.maxInFlightUploads = 0;
		this.uploadDelayMs = 0;
		/** path -> { status, times, summary, retryAfter } */
		this.failures = new Map();
		this.server = http.createServer((req, res) => {
			this.handle(req, res).catch((err) => {
				try {
					res.writeHead(500, JSON_HEADERS);
					res.end(JSON.stringify({ error_summary: "mock_internal_error/" + String(err?.message ?? err) }));
				} catch {
					/* 响应已经发出去过了 */
				}
			});
		});
	}

	async listen() {
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", resolve);
		});
		const addr = this.server.address();
		this.baseUrl = `http://127.0.0.1:${addr.port}`;
		return this.baseUrl;
	}

	async close() {
		await new Promise((resolve) => {
			this.server.closeAllConnections?.();
			this.server.close(resolve);
		});
	}

	/* ---------- 内部工具 ---------- */

	count(key) {
		this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
	}
	requestCount(key) {
		return this.counts.get(key) ?? 0;
	}

	sendJson(res, status, obj, extraHeaders = {}) {
		const s = Buffer.from(JSON.stringify(obj), "utf8");
		res.writeHead(status, {
			...JSON_HEADERS,
			"Content-Length": String(s.length),
			...extraHeaders,
		});
		res.end(s);
	}

	notFound(res) {
		return this.sendJson(res, 409, { error_summary: "path/not_found/.." });
	}

	argOf(req) {
		const raw = req.headers["dropbox-api-arg"] ?? "{}";
		return JSON.parse(raw);
	}

	maybeFail(p) {
		const rule = this.failures.get(p);
		if (!rule || rule.times <= 0) return null;
		if (rule.times !== Infinity) rule.times -= 1;
		return rule;
	}

	failResponse(res, rule) {
		const extra = {};
		if (rule.retryAfter !== undefined) extra["Retry-After"] = String(rule.retryAfter);
		return this.sendJson(res, rule.status, { error_summary: rule.summary }, extra);
	}

	putFile(remotePath, buf) {
		const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
		this.seq += 1;
		const rec = {
			data,
			rev: "015" + String(this.seq).padStart(9, "0"),
			serverModified: new Date(Date.now() - this.seq * 1000).toISOString(),
			contentHash: dropboxContentHash(data),
		};
		this.files.set(remotePath, rec);
		return rec;
	}

	seed(remotePath, buf) {
		return this.putFile(remotePath, buf);
	}

	metadata(remotePath, rec) {
		return {
			".tag": "file",
			name: remotePath.slice(remotePath.lastIndexOf("/") + 1),
			id: "id:" + sha256(Buffer.from(remotePath)).slice(0, 16),
			path_display: remotePath,
			path_lower: remotePath.toLowerCase(),
			client_modified: rec.serverModified,
			server_modified: rec.serverModified,
			rev: rec.rev,
			size: rec.data.length,
			content_hash: rec.contentHash,
		};
	}

	hasChildren(p) {
		const prefix = p + "/";
		for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
		for (const d of this.dirs) if (d.startsWith(prefix)) return true;
		return false;
	}

	listEntries(p) {
		const prefix = p === "" || p === "/" ? "/" : p + "/";
		const out = [];
		for (const [fp, rec] of this.files) {
			if (fp === p || !fp.startsWith(prefix)) continue;
			out.push(this.metadata(fp, rec));
		}
		for (const d of this.dirs) {
			if (d === p || !d.startsWith(prefix)) continue;
			out.push({
				".tag": "folder",
				name: d.slice(d.lastIndexOf("/") + 1),
				id: "id:dir:" + sha256(Buffer.from(d)).slice(0, 16),
				path_display: d,
				path_lower: d.toLowerCase(),
			});
		}
		out.sort((a, b) => (a.path_display < b.path_display ? -1 : 1));
		return out;
	}

	/** 上传类端点统一计并发，用于验证客户端的并发上限 */
	async withUploadSlot(res, fn) {
		this.inFlightUploads += 1;
		this.maxInFlightUploads = Math.max(this.maxInFlightUploads, this.inFlightUploads);
		try {
			if (this.uploadDelayMs > 0) await sleep(this.uploadDelayMs);
			return await fn();
		} finally {
			this.inFlightUploads -= 1;
		}
	}

	/* ---------- 路由 ---------- */

	async handle(req, res) {
		const body = await readBody(req);
		const url = new URL(req.url, "http://127.0.0.1");
		const endpoint = url.pathname;

		if (endpoint === "/oauth2/token") return this.handleToken(req, res, body);
		if (!endpoint.startsWith("/2/")) {
			return this.sendJson(res, 404, { error_summary: "unknown_endpoint/" + endpoint });
		}

		const api = endpoint.slice(2); // 保留前导 /，例如 /users/get_current_account
		this.count(api);

		const auth = String(req.headers.authorization ?? "");
		const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
		if (token !== this.currentToken) {
			this.authRejects += 1;
			return this.sendJson(res, 401, {
				error_summary: "invalid_access_token/..",
				error: { ".tag": "invalid_access_token" },
			});
		}

		switch (api) {
			case "/users/get_current_account": {
				this.lastAccountBody = body.toString("utf8");
				return this.sendJson(res, 200, {
					account_id: "dbid:AAA_mock",
					name: { display_name: "Test User" },
					email: "test@example.com",
					email_verified: true,
				});
			}
			case "/users/get_space_usage": {
				this.lastSpaceBody = body.toString("utf8");
				return this.sendJson(res, 200, {
					used: 6860300288,
					allocation: { ".tag": "individual", allocated: 19327352832 },
				});
			}
			case "/files/list_folder": {
				const arg = JSON.parse(body.toString("utf8"));
				const p = arg.path ?? "";
				const fail = this.maybeFail(p);
				if (fail) return this.failResponse(res, fail);
				if (p !== "" && !this.dirs.has(p) && !this.hasChildren(p)) return this.notFound(res);
				const all = this.listEntries(p);
				const page = all.slice(0, this.pageSize);
				const rest = all.slice(this.pageSize);
				let cursor = null;
				if (rest.length > 0) {
					cursor = "cur-" + ++this.seq;
					this.cursors.set(cursor, rest);
				}
				return this.sendJson(res, 200, { entries: page, cursor, has_more: rest.length > 0 });
			}
			case "/files/list_folder/continue": {
				const arg = JSON.parse(body.toString("utf8"));
				const rest = this.cursors.get(arg.cursor);
				if (!rest) return this.sendJson(res, 409, { error_summary: "reset/.." });
				this.cursors.delete(arg.cursor);
				const page = rest.slice(0, this.pageSize);
				const more = rest.slice(this.pageSize);
				let cursor = null;
				if (more.length > 0) {
					cursor = "cur-" + ++this.seq;
					this.cursors.set(cursor, more);
				}
				return this.sendJson(res, 200, { entries: page, cursor, has_more: more.length > 0 });
			}
			case "/files/upload": {
				return await this.withUploadSlot(res, () => {
					const arg = this.argOf(req);
					this.pathUploadCounts.set(arg.path, (this.pathUploadCounts.get(arg.path) ?? 0) + 1);
					const fail = this.maybeFail(arg.path);
					if (fail) return this.failResponse(res, fail);
					const rec = this.putFile(arg.path, body);
					return this.sendJson(res, 200, this.metadata(arg.path, rec));
				});
			}
			case "/files/upload_session/start": {
				return await this.withUploadSlot(res, () => {
					this.sessionSeq += 1;
					const id = "sess-" + this.sessionSeq;
					this.sessions.set(id, { chunks: [body], size: body.length });
					this.sessionCalls.push({ op: "start", sessionId: id, offset: 0, bytes: body.length });
					return this.sendJson(res, 200, { session_id: id });
				});
			}
			case "/files/upload_session/append_v2": {
				return await this.withUploadSlot(res, () => {
					const arg = this.argOf(req);
					const sess = this.sessions.get(arg.cursor.session_id);
					if (!sess) return this.sendJson(res, 409, { error_summary: "not_found/.." });
					if (arg.cursor.offset !== sess.size) {
						return this.sendJson(res, 409, {
							error_summary: `incorrect_offset/..（收到 ${arg.cursor.offset}，期望 ${sess.size}）`,
						});
					}
					this.sessionCalls.push({
						op: "append",
						sessionId: arg.cursor.session_id,
						offset: arg.cursor.offset,
						bytes: body.length,
					});
					sess.chunks.push(body);
					sess.size += body.length;
					return this.sendJson(res, 200, null);
				});
			}
			case "/files/upload_session/finish": {
				return await this.withUploadSlot(res, () => {
					const arg = this.argOf(req);
					const sess = this.sessions.get(arg.cursor.session_id);
					if (!sess) return this.sendJson(res, 409, { error_summary: "not_found/.." });
					if (arg.cursor.offset !== sess.size) {
						return this.sendJson(res, 409, {
							error_summary: `incorrect_offset/..（收到 ${arg.cursor.offset}，期望 ${sess.size}）`,
						});
					}
					this.sessionCalls.push({
						op: "finish",
						sessionId: arg.cursor.session_id,
						offset: arg.cursor.offset,
						bytes: body.length,
					});
					const fail = this.maybeFail(arg.commit.path);
					if (fail) return this.failResponse(res, fail);
					sess.chunks.push(body);
					this.sessions.delete(arg.cursor.session_id);
					const rec = this.putFile(arg.commit.path, Buffer.concat(sess.chunks));
					return this.sendJson(res, 200, this.metadata(arg.commit.path, rec));
				});
			}
			case "/files/delete_v2": {
				const arg = JSON.parse(body.toString("utf8"));
				const fail = this.maybeFail(arg.path);
				if (fail) return this.failResponse(res, fail);
				const rec = this.files.get(arg.path);
				if (!rec) return this.notFound(res);
				this.files.delete(arg.path);
				return this.sendJson(res, 200, { metadata: this.metadata(arg.path, rec) });
			}
			case "/files/create_folder_v2": {
				const arg = JSON.parse(body.toString("utf8"));
				const fail = this.maybeFail(arg.path);
				if (fail) return this.failResponse(res, fail);
				if (this.dirs.has(arg.path)) {
					return this.sendJson(res, 409, { error_summary: "path/conflict/folder/.." });
				}
				// 真实 Dropbox 要求父目录已存在，否则回 path/not_found
				const parent = arg.path.slice(0, arg.path.lastIndexOf("/"));
				if (parent !== "" && !this.dirs.has(parent)) {
					return this.sendJson(res, 409, { error_summary: "path/not_found/.." });
				}
				this.dirs.add(arg.path);
				return this.sendJson(res, 200, {
					metadata: { ".tag": "folder", name: arg.path.slice(arg.path.lastIndexOf("/") + 1), path_display: arg.path, path_lower: arg.path.toLowerCase() },
				});
			}
			case "/files/download": {
				const arg = this.argOf(req);
				const fail = this.maybeFail(arg.path);
				if (fail) return this.failResponse(res, fail);
				const rec = this.files.get(arg.path);
				if (!rec) return this.notFound(res);
				res.writeHead(200, {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(rec.data.length),
					"Dropbox-API-Result": JSON.stringify(this.metadata(arg.path, rec)),
				});
				res.end(rec.data);
				return undefined;
			}
			default:
				return this.sendJson(res, 404, { error_summary: "unsupported_endpoint/" + api });
		}
	}

	async handleToken(req, res, body) {
		const form = new URLSearchParams(body.toString("utf8"));
		const rec = Object.fromEntries(form.entries());
		rec.__headers = { contentType: req.headers["content-type"] };
		this.tokenForms.push(rec);

		const grant = form.get("grant_type");
		if (grant === "authorization_code") {
			if (form.get("code") !== "good-code") {
				return this.sendJson(res, 400, {
					error: "invalid_grant",
					error_description: "code has expired or been revoked",
				});
			}
			this.tokenSeq += 1;
			this.currentToken = "at-" + (10 + this.tokenSeq);
			this.refreshToken = "rt-" + (100 + this.tokenSeq);
			return this.sendJson(res, 200, {
				access_token: this.currentToken,
				refresh_token: this.refreshToken,
				expires_in: 14400,
				token_type: "bearer",
				uid: "123456789",
				account_id: "dbid:AAA_mock",
			});
		}
		if (grant === "refresh_token") {
			if (form.get("refresh_token") !== this.refreshToken) {
				return this.sendJson(res, 400, {
					error: "invalid_grant",
					error_description: "refresh token is invalid or revoked",
				});
			}
			this.tokenSeq += 1;
			this.currentToken = "at-" + (10 + this.tokenSeq);
			return this.sendJson(res, 200, {
				access_token: this.currentToken,
				token_type: "bearer",
				expires_in: 14400,
			});
		}
		return this.sendJson(res, 400, { error: "unsupported_grant_type" });
	}
}

/* ======================================================================
 * 给 node HttpClient 做语义测试用的最小回显服务
 * ==================================================================== */
async function startEchoServer() {
	const seen = [];
	const server = http.createServer(async (req, res) => {
		const body = await readBody(req);
		seen.push({ method: req.method, url: req.url, headers: req.headers, body });
		const u = new URL(req.url, "http://127.0.0.1");
		switch (u.pathname) {
			case "/echo": {
				const payload = Buffer.from(
					JSON.stringify({
						method: req.method,
						bodyBase64: body.toString("base64"),
						bodyLength: body.length,
						customHeader: req.headers["x-custom"] ?? null,
						contentLength: req.headers["content-length"] ?? null,
					}),
					"utf8",
				);
				res.writeHead(200, { ...JSON_HEADERS, "Content-Length": String(payload.length) });
				return res.end(payload);
			}
			case "/json":
				return res.end(JSON.stringify({ a: 1, b: [1, 2, 3], nested: { ok: true } }));
			case "/text": {
				const payload = Buffer.from("你好，世界", "utf8");
				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(payload.length) });
				return res.end(payload);
			}
			case "/bytes": {
				const n = Number(u.searchParams.get("n") ?? "1000");
				const payload = Buffer.alloc(n);
				for (let i = 0; i < n; i++) payload[i] = i % 251;
				res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(n) });
				return res.end(payload);
			}
			case "/badjson": {
				const payload = Buffer.from("not json at all", "utf8");
				res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(payload.length) });
				return res.end(payload);
			}
			case "/notfound": {
				const payload = Buffer.from(
					JSON.stringify({ error_summary: "path/not_found/..", error: { ".tag": "path" } }),
					"utf8",
				);
				res.writeHead(404, { ...JSON_HEADERS, "Content-Length": String(payload.length) });
				return res.end(payload);
			}
			case "/teapot": {
				res.writeHead(418, { ...JSON_HEADERS, "Retry-After": "1.5" });
				return res.end(JSON.stringify({ error_summary: "teapot/.." }));
			}
			default:
				res.writeHead(404, JSON_HEADERS);
				return res.end(JSON.stringify({ error_summary: "unknown/.." }));
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const addr = server.address();
	return {
		url: `http://127.0.0.1:${addr.port}`,
		seen,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			}),
	};
}

/* ======================================================================
 * 全局夹具
 * ==================================================================== */
/** @type {MockDropbox} */
let mock;
let nodeHttpClient;
/** 给 DropboxClient 用的 HttpClient：把 token 端点改写到本地 mock（否则会打到真 Dropbox） */
let clientHttp;
const clientTokenUrls = [];

before(async () => {
	mock = new MockDropbox();
	await mock.listen();
	nodeHttpClient = createNodeHttpClient();
	clientHttp = makeRewritingHttp(clientTokenUrls);
	await fsp.mkdir(TMP_DIR, { recursive: true });
});

after(async () => {
	await mock.close();
	await fsp.rm(TMP_DIR, { recursive: true, force: true });
});

function newClient(opts = {}) {
	const tokens = opts.tokens ?? {
		appKey: "app-key",
		accessToken: mock.currentToken,
		refreshToken: mock.refreshToken,
	};
	return new DropboxClient({
		http: clientHttp,
		baseDir: "/Obsidian-Config-Backup",
		concurrency: 3,
		apiBase: `${mock.baseUrl}/2`,
		contentBase: `${mock.baseUrl}/2`,
		...opts,
		tokens,
	});
}

/* ======================================================================
 * 1. node HttpClient 语义
 * ==================================================================== */
test("node HttpClient：json / text / arraybuffer 三种 responseType 语义正确", async () => {
	const echo = await startEchoServer();
	try {
		const j = await createNodeHttpClient().request({
			url: `${echo.url}/json`,
			method: "GET",
			responseType: "json",
		});
		assert.equal(j.status, 200);
		assert.deepEqual(j.json, { a: 1, b: [1, 2, 3], nested: { ok: true } });
		assert.equal(typeof j.headers.date, "string", "响应头应是小写键的普通对象");
		assert.equal(j.arrayBuffer, undefined, "json 响应不该填 arrayBuffer");

		const t = await createNodeHttpClient().request({
			url: `${echo.url}/text`,
			method: "GET",
			responseType: "text",
		});
		assert.equal(t.text, "你好，世界");
		assert.equal(t.json, undefined, "text 响应不该顺手做 JSON 解析");

		const n = 4096;
		const b = await createNodeHttpClient().request({
			url: `${echo.url}/bytes?n=${n}`,
			method: "GET",
			responseType: "arraybuffer",
		});
		assert.ok(b.arrayBuffer instanceof ArrayBuffer, "arrayBuffer 应是真正的 ArrayBuffer");
		assert.equal(b.arrayBuffer.byteLength, n);
		const expected = Buffer.alloc(n);
		for (let i = 0; i < n; i++) expected[i] = i % 251;
		assert.equal(sha256(Buffer.from(b.arrayBuffer)), sha256(expected));
		assert.equal(b.text, undefined, "arraybuffer 响应不该填 text");
	} finally {
		await echo.close();
	}
});

test("node HttpClient：4xx/5xx 不抛异常，正文与 Retry-After 都能拿到", async () => {
	const echo = await startEchoServer();
	try {
		const c = createNodeHttpClient();
		const nf = await c.request({ url: `${echo.url}/notfound`, method: "GET", responseType: "json" });
		assert.equal(nf.status, 404);
		assert.equal(nf.json.error_summary, "path/not_found/..");

		const tp = await c.request({ url: `${echo.url}/teapot`, method: "GET", responseType: "json" });
		assert.equal(tp.status, 418);
		assert.equal(tp.headers["retry-after"], "1.5", "响应头键应是小写且原样保留");
	} finally {
		await echo.close();
	}
});

test("node HttpClient：POST 的二进制体与自定义头原样送达，Content-Length 正确", async () => {
	const echo = await startEchoServer();
	try {
		const payload = crypto.randomBytes(4096);
		const res = await createNodeHttpClient().request({
			url: `${echo.url}/echo`,
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "X-Custom": "custom-value-1" },
			body: new Uint8Array(payload),
			responseType: "json",
		});
		assert.equal(res.status, 200);
		assert.equal(res.json.method, "POST");
		assert.equal(res.json.bodyBase64, payload.toString("base64"));
		assert.equal(res.json.bodyLength, 4096);
		assert.equal(res.json.customHeader, "custom-value-1", "自定义头必须原样送达");
		assert.equal(res.json.contentLength, "4096");

		const s = await createNodeHttpClient().request({
			url: `${echo.url}/echo`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hello: "世界" }),
			responseType: "json",
		});
		assert.equal(res.json.bodyLength, 4096);
		assert.equal(Buffer.from(s.json.bodyBase64, "base64").toString("utf8"), JSON.stringify({ hello: "世界" }));
	} finally {
		await echo.close();
	}
});

test("node HttpClient：非 JSON 正文降级为 text，不抛错", async () => {
	const echo = await startEchoServer();
	try {
		const res = await createNodeHttpClient().request({
			url: `${echo.url}/badjson`,
			method: "GET",
			responseType: "json",
		});
		assert.equal(res.status, 200);
		assert.equal(res.json, undefined);
		assert.equal(res.text, "not json at all");
	} finally {
		await echo.close();
	}
});

test("node HttpClient：连不上的端口会 reject（而不是抛 4xx 那种返回）", async () => {
	// 抢占一个端口再立刻释放，得到一个几乎肯定没人监听的端口号
	const probe = http.createServer();
	await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const deadPort = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));

	await assert.rejects(
		createNodeHttpClient().request({
			url: `http://127.0.0.1:${deadPort}/x`,
			method: "GET",
			responseType: "json",
		}),
		(err) => {
			assert.ok(err instanceof Error);
			return true;
		},
	);
});

/* ======================================================================
 * 2. PKCE 与授权 URL
 * ==================================================================== */
test("createPkcePair：verifier 合规，challenge === base64url(sha256(verifier))", () => {
	const a = createPkcePair();
	const b = createPkcePair();

	assert.match(a.verifier, /^[A-Za-z0-9\-._~]{43,128}$/, "verifier 必须是 RFC 7636 允许的字符集与长度");
	assert.notEqual(a.verifier, b.verifier, "每次授权都必须重新生成");

	const expected = crypto
		.createHash("sha256")
		.update(a.verifier)
		.digest("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	assert.equal(a.challenge, expected, "challenge 必须是 base64url(sha256(verifier))");
	assert.equal(a.challenge.length, 43, "sha256 的 base64url 固定 43 个字符");
	assert.ok(!a.challenge.includes("=") && !a.challenge.includes("+") && !a.challenge.includes("/"));
});

test("buildAuthorizeUrl：必填参数齐全，manual 模式不带 redirect_uri", () => {
	const url = new URL(buildAuthorizeUrl({ appKey: "abc123", challenge: "CH", state: "ST" }));
	assert.equal(url.origin + url.pathname, DROPBOX_AUTHORIZE_URL);
	const q = url.searchParams;
	assert.equal(q.get("client_id"), "abc123");
	assert.equal(q.get("response_type"), "code");
	assert.equal(q.get("code_challenge"), "CH");
	assert.equal(q.get("code_challenge_method"), "S256");
	assert.equal(q.get("state"), "ST");
	assert.equal(q.get("token_access_type"), "offline", "不带 offline 就拿不到 refresh_token");
	assert.equal(q.get("redirect_uri"), null);
});

test("buildAuthorizeUrl：callback 模式 redirect_uri 精确编码不丢字符", () => {
	const redirectUri = "http://localhost:53682/";
	const raw = buildAuthorizeUrl({ appKey: "abc123", challenge: "C+/-_", state: "s 1", redirectUri });
	assert.ok(raw.includes("redirect_uri=http%3A%2F%2Flocalhost%3A53682%2F"), raw);
	const q = new URL(raw).searchParams;
	assert.equal(q.get("redirect_uri"), redirectUri);
	assert.equal(q.get("code_challenge"), "C+/-_", "base64url 里的 + / = 必须原样还原");
	assert.equal(q.get("state"), "s 1");
});

/* ======================================================================
 * 3. token 换发（注入一个把 URL 改写到 mock 的 HttpClient）
 * ==================================================================== */
/** oauth.ts 里的 token 端点地址是写死的 Dropbox 官方地址，测试时改写到本地 mock */
function makeRewritingHttp(lastUrls) {
	const real = createNodeHttpClient();
	return {
		async request(req) {
			lastUrls.push(req.url);
			if (req.url === DROPBOX_TOKEN_URL) {
				return await real.request({ ...req, url: `${mock.baseUrl}/oauth2/token` });
			}
			return await real.request(req);
		},
	};
}

test("exchangeCodeForTokens：表单参数正确，返回带 refresh_token 的 tokens", async () => {
	const urls = [];
	const before = mock.tokenForms.length;
	const tokens = await exchangeCodeForTokens(makeRewritingHttp(urls), {
		appKey: "app-key",
		code: "good-code",
		verifier: "verifier-abc",
		redirectUri: "http://localhost:53682/",
	});

	assert.deepEqual(urls, [DROPBOX_TOKEN_URL], "必须打到官方 token 端点地址");
	const form = mock.tokenForms.at(-1);
	assert.equal(mock.tokenForms.length, before + 1);
	assert.equal(form.grant_type, "authorization_code");
	assert.equal(form.code, "good-code");
	assert.equal(form.client_id, "app-key");
	assert.equal(form.code_verifier, "verifier-abc");
	assert.equal(form.redirect_uri, "http://localhost:53682/");
	assert.ok(form.__headers.contentType.includes("application/x-www-form-urlencoded"));

	assert.equal(tokens.appKey, "app-key");
	assert.equal(tokens.accessToken, mock.currentToken);
	assert.equal(tokens.refreshToken, mock.refreshToken, "offline 授权必须拿到 refresh_token");
	assert.equal(tokens.accountId, "dbid:AAA_mock");
	assert.ok(tokens.expiresAt > Date.now() + 3600_000, "expiresAt 应按 expires_in 算出来");
	assert.ok(tokens.expiresAt <= Date.now() + 14400_000 + 5000);

	// 不带 redirect_uri 时表单里就不该有这一项
	await exchangeCodeForTokens(makeRewritingHttp([]), {
		appKey: "app-key",
		code: "good-code",
		verifier: "v2",
	});
	assert.equal(mock.tokenForms.at(-1).redirect_uri, undefined, "manual 模式不能带 redirect_uri");
});

test("exchangeCodeForTokens：换码失败时抛出带 error_description 的异常", async () => {
	await assert.rejects(
		exchangeCodeForTokens(makeRewritingHttp([]), {
			appKey: "app-key",
			code: "bad-code",
			verifier: "v",
		}),
		(err) => {
			assert.match(err.message, /HTTP 400/);
			assert.match(err.message, /invalid_grant/);
			assert.match(err.message, /code has expired or been revoked/);
			return true;
		},
	);
});

test("refreshAccessToken：用 refresh_token 换到新的 access_token", async () => {
	const urls = [];
	const beforeToken = mock.currentToken;
	const r = await refreshAccessToken(makeRewritingHttp(urls), {
		appKey: "app-key",
		refreshToken: mock.refreshToken,
	});
	assert.deepEqual(urls, [DROPBOX_TOKEN_URL]);
	const form = mock.tokenForms.at(-1);
	assert.equal(form.grant_type, "refresh_token");
	assert.equal(form.refresh_token, mock.refreshToken);
	assert.equal(form.client_id, "app-key");
	assert.equal(r.expiresIn, 14400);
	assert.notEqual(r.accessToken, beforeToken, "刷新后必须是新 token");
	assert.equal(r.accessToken, mock.currentToken);

	// 用错的 refresh_token 要报错
	await assert.rejects(
		refreshAccessToken(makeRewritingHttp([]), { appKey: "app-key", refreshToken: "rt-wrong" }),
		/refresh token is invalid or revoked/,
	);
});

/* ======================================================================
 * 4. 本地 OAuth 回调服务器（真 socket）
 * ==================================================================== */
test("回调服务器：state 正确时拿到 code，返回中文提示页", async () => {
	const srv = await startLocalCallbackServer(0, "STATE-1");
	try {
		assert.match(srv.redirectUri, /^http:\/\/localhost:\d+\/$/);
		const waiting = srv.waitForCode(5000);
		const res = await fetch(`${srv.redirectUri}?code=CODE-OK&state=STATE-1`);
		assert.equal(res.status, 200);
		assert.match(await res.text(), /授权成功/);
		assert.equal(await waiting, "CODE-OK");

		// 拿到结果后服务器应该已经关掉，不会一直占着端口
		await sleep(20);
		await assert.rejects(fetch(`${srv.redirectUri}?code=X&state=STATE-1`));
	} finally {
		srv.close();
	}
});

test("回调服务器：state 不匹配直接 reject（防 CSRF）", async () => {
	const srv = await startLocalCallbackServer(0, "STATE-2");
	try {
		const waiting = srv.waitForCode(5000);
		// 先挂上断言，再触发请求：否则 reject 会先于 handler 出现，被 test runner 当成未处理拒绝
		const assertion = assert.rejects(waiting, /state 不匹配/);
		const res = await fetch(`${srv.redirectUri}?code=CODE&state=WRONG`);
		assert.equal(res.status, 400);
		assert.match(await res.text(), /state 校验失败/);
		await assertion;
	} finally {
		srv.close();
	}
});

test("回调服务器：favicon 之类无参数请求不会打断授权流程", async () => {
	const srv = await startLocalCallbackServer(0, "STATE-3");
	try {
		const waiting = srv.waitForCode(5000);
		const fav = await fetch(`${srv.redirectUri}favicon.ico`);
		assert.equal(fav.status, 404);
		assert.equal(await fav.text(), "Not found");
		// 流程必须还活着
		const ok = await fetch(`${srv.redirectUri}?state=STATE-3&code=AFTER-FAVICON`);
		assert.equal(ok.status, 200);
		assert.equal(await waiting, "AFTER-FAVICON");
	} finally {
		srv.close();
	}
});

test("回调服务器：error 参数、超时、主动 close 都会 reject", async () => {
	const s1 = await startLocalCallbackServer(0, "S");
	try {
		const w1 = s1.waitForCode(5000);
		const a1 = assert.rejects(w1, /access_denied/);
		const res = await fetch(`${s1.redirectUri}?error=access_denied&error_description=nope&state=S`);
		assert.equal(res.status, 200);
		assert.match(await res.text(), /授权被拒绝/);
		await a1;
	} finally {
		s1.close();
	}

	const s2 = await startLocalCallbackServer(0, "S");
	try {
		assert.match(s2.redirectUri, /^http:\/\/localhost:\d+\/$/);
		await assert.rejects(s2.waitForCode(150), /超时/);
	} finally {
		s2.close();
	}

	const s3 = await startLocalCallbackServer(0, "S");
	const w3 = s3.waitForCode(5000);
	const a3 = assert.rejects(w3, /已关闭/);
	s3.close();
	await a3;
});

/* ======================================================================
 * 5. DropboxClient
 * ==================================================================== */
test("remotePath：baseDir 与 relPath 各种拼法规范化一致", () => {
	const c = newClient();
	assert.equal(c.remotePath(""), "/Obsidian-Config-Backup");
	assert.equal(c.remotePath("app.json"), "/Obsidian-Config-Backup/app.json");
	assert.equal(c.remotePath("/app.json"), "/Obsidian-Config-Backup/app.json");
	assert.equal(c.remotePath("./app.json"), "/Obsidian-Config-Backup/app.json");
	assert.equal(c.remotePath("a\\b\\c.txt"), "/Obsidian-Config-Backup/a/b/c.txt");
	assert.equal(c.remotePath("a//b/"), "/Obsidian-Config-Backup/a/b");
	assert.equal(c.remotePath("/"), "/Obsidian-Config-Backup");
	assert.equal(c.remotePath("  "), "/Obsidian-Config-Backup");

	// 尾斜杠的 baseDir 与根 baseDir 都要规范
	const trailing = newClient({ baseDir: "/Obsidian-Config-Backup/" });
	assert.equal(trailing.remotePath("a/b"), "/Obsidian-Config-Backup/a/b");
	const root = newClient({ baseDir: "/" });
	assert.equal(root.remotePath(""), "");
	assert.equal(root.remotePath("a/b"), "/a/b");
	assert.equal(newClient({ baseDir: "" }).remotePath("a"), "/a");
});

test("getCurrentAccount / getSpaceUsage：解析正确，且无参端点发送的 body 是字面量 null", async () => {
	const c = newClient();
	const acct = await c.getCurrentAccount();
	assert.deepEqual(acct, {
		accountId: "dbid:AAA_mock",
		name: "Test User",
		email: "test@example.com",
	});
	assert.equal(mock.lastAccountBody, "null", "Dropbox 无参端点要求 body 为 JSON null");

	const space = await c.getSpaceUsage();
	assert.equal(space.used, 6860300288);
	assert.equal(space.allocated, 19327352832);
	assert.equal(mock.lastSpaceBody, "null");
});

test("uploadFile：小文件走单次上传，中文路径与字节完全一致", async () => {
	const c = newClient();
	const local = path.join(TMP_DIR, "小文件 app.json");
	const data = Buffer.from(JSON.stringify({ a: 1, 名字: "配置" }), "utf8");
	await fsp.writeFile(local, data);

	// 中文 relPath 会被塞进 Dropbox-API-Arg 头：头值只能 ASCII，必须转义后仍能还原
	const relPath = "vault/.obsidian/plugins/中文插件/data.json";
	const before = mock.requestCount("/files/upload");
	const info = await c.uploadFile(relPath, local);

	assert.ok(info.rev.length > 0, "必须拿到 rev");
	assert.equal(info.size, data.length);
	assert.equal(info.contentHash, dropboxContentHash(data));
	assert.equal(mock.requestCount("/files/upload"), before + 1);
	assert.equal(mock.requestCount("/files/upload_session/start"), 0, "小文件不该建上传会话");

	const stored = mock.files.get(`/Obsidian-Config-Backup/${relPath}`);
	assert.ok(stored, "中文路径必须原样还原到远端路径上");
	assert.equal(sha256(stored.data), sha256(data));
	assert.deepEqual(await c.listFolderRecursive("vault"), [
		{
			relPath: "vault/.obsidian/plugins/中文插件/data.json",
			size: data.length,
			rev: info.rev,
			serverModified: stored.serverModified,
			contentHash: info.contentHash,
		},
	]);
});

test("uploadFile：20MB 大文件走分块上传，offset 递增且字节完全一致", async () => {
	const c = newClient();
	const size = 2 * CHUNK + 12345;
	const data = crypto.randomBytes(size);
	const local = path.join(TMP_DIR, "big-20mb.bin");
	await fsp.writeFile(local, data);

	const beforeSingle = mock.requestCount("/files/upload");
	const beforeCalls = mock.sessionCalls.length;
	const info = await c.uploadFile("vault/.obsidian/plugins/big.bin", local);

	const calls = mock.sessionCalls.slice(beforeCalls);
	assert.deepEqual(
		calls.map((x) => x.op),
		["start", "append", "finish"],
		`20MB 应切成 3 段，实际：${JSON.stringify(calls.map((x) => x.op))}`,
	);
	assert.deepEqual(calls.map((x) => x.offset), [0, CHUNK, 2 * CHUNK], "offset 必须是累计字节数");
	assert.deepEqual(calls.map((x) => x.bytes), [CHUNK, CHUNK, 12345]);
	assert.equal(mock.requestCount("/files/upload"), beforeSingle, "大文件不该走单次上传");

	assert.equal(info.size, size);
	const stored = mock.files.get("/Obsidian-Config-Backup/vault/.obsidian/plugins/big.bin");
	assert.equal(stored.data.length, size);
	assert.equal(sha256(stored.data), sha256(data), "分块重组后的字节必须与原文件一致");
});

test("uploadBuffer：>8MB 走分块上传，字节一致；正好 2×CHUNK 时用 start+finish 两段完成", async () => {
	const c = newClient();

	const small = crypto.randomBytes(1024);
	const sInfo = await c.uploadBuffer("a/small.bin", new Uint8Array(small));
	assert.equal(sInfo.size, 1024);
	assert.equal(sha256(mock.files.get("/Obsidian-Config-Backup/a/small.bin").data), sha256(small));

	// 正好 2×CHUNK：start(前 8MB) → finish(后 8MB，offset=8MB)，第二段既是末段就无需 append
	const exact = crypto.randomBytes(2 * CHUNK);
	const beforeCalls = mock.sessionCalls.length;
	const bInfo = await c.uploadBuffer("a/exact.bin", new Uint8Array(exact));
	const calls = mock.sessionCalls.slice(beforeCalls);
	assert.deepEqual(calls.map((x) => x.op), ["start", "finish"]);
	assert.deepEqual(calls.map((x) => x.offset), [0, CHUNK], "finish 的 offset 必须是已上传字节数");
	assert.deepEqual(calls.map((x) => x.bytes), [CHUNK, CHUNK]);

	assert.equal(bInfo.size, 2 * CHUNK);
	const stored = mock.files.get("/Obsidian-Config-Backup/a/exact.bin");
	assert.equal(stored.data.length, 2 * CHUNK);
	assert.equal(sha256(stored.data), sha256(exact));
});

test("listFolderRecursive：递归 + 自动翻页 + 中文路径，relPath 相对 baseDir 且不含目录项", async () => {
	const base = "/Listing-Root";
	mock.seed(`${base}/VaultA/.obsidian/app.json`, Buffer.from("a1"));
	mock.seed(`${base}/VaultA/.obsidian/plugins/foo/main.js`, Buffer.from("m2"));
	mock.seed(`${base}/VaultA/.obsidian/plugins/中文插件/data.json`, Buffer.from("中文配置"));
	mock.seed(`${base}/VaultB/.obsidian/appearance.json`, Buffer.from("a3"));
	mock.seed(`${base}/other/decoy.txt`, Buffer.from("decoy"));
	mock.dirs.add(`${base}/VaultA/.obsidian/themes/Obsidianite`);
	// 故意放到别的 baseDir 之下，验证不会被列出来
	mock.seed("/Obsidian-Config-Backup/不该出现.txt", Buffer.from("x"));
	mock.pageSize = 3; // 强制翻页

	const beforeContinue = mock.requestCount("/files/list_folder/continue");
	const entries = await newClient({ baseDir: base }).listFolderRecursive();
	const rels = entries.map((e) => e.relPath).sort();

	assert.deepEqual(rels, [
		"VaultA/.obsidian/app.json",
		"VaultA/.obsidian/plugins/foo/main.js",
		"VaultA/.obsidian/plugins/中文插件/data.json",
		"VaultB/.obsidian/appearance.json",
		"other/decoy.txt",
	], "relPath 必须是相对 baseDir 的 '/' 分隔路径，且不含目录项");

	assert.ok(
		mock.requestCount("/files/list_folder/continue") > beforeContinue,
		"has_more 为真时必须继续翻页",
	);

	const zhPath = `${base}/VaultA/.obsidian/plugins/中文插件/data.json`;
	const zh = entries.find((e) => e.relPath.includes("中文插件"));
	assert.equal(zh.size, Buffer.byteLength("中文配置", "utf8"));
	assert.equal(zh.serverModified, mock.files.get(zhPath).serverModified);
	assert.equal(zh.rev, mock.files.get(zhPath).rev);
	assert.equal(zh.contentHash, mock.files.get(zhPath).contentHash);
	mock.pageSize = 1000;
});

test("listFolderRecursive：远端目录不存在时返回空数组而不是抛错", async () => {
	const c = newClient({ baseDir: "/Not-There-Yet" });
	await assert.doesNotReject(c.listFolderRecursive());
	assert.deepEqual(await c.listFolderRecursive(), []);
	// 指定的子目录不存在也一样
	assert.deepEqual(await newClient().listFolderRecursive("NoSuchVault"), []);
});

test("deletePath：删除存在的文件；对不存在的文件静默成功（幂等）", async () => {
	const c = newClient();
	mock.seed("/Obsidian-Config-Backup/gone/.obsidian/workspace.json", Buffer.from("{}"));

	await c.deletePath("gone/.obsidian/workspace.json");
	assert.equal(mock.files.has("/Obsidian-Config-Backup/gone/.obsidian/workspace.json"), false);
	assert.equal((await c.listFolderRecursive("gone")).length, 0);

	await assert.doesNotReject(c.deletePath("gone/.obsidian/workspace.json"), "删不存在的文件必须幂等");
	await assert.doesNotReject(c.deletePath("never/existed.json"));
});

test("ensureFolder：深路径逐级补齐（父目录不存在时也不会失败），重复调用不报错", async () => {
	const c = newClient();
	// 祖先目录一个都不存在：真实 Dropbox 会先回 409 path/not_found，客户端必须自己 mkdir -p
	const deep = "VaultC/.obsidian/themes/MyTheme";
	assert.equal(mock.dirs.has(`/Obsidian-Config-Backup/${deep}`), false);
	await c.ensureFolder(deep);
	for (const p of [
		"/Obsidian-Config-Backup",
		"/Obsidian-Config-Backup/VaultC",
		"/Obsidian-Config-Backup/VaultC/.obsidian",
		"/Obsidian-Config-Backup/VaultC/.obsidian/themes",
		`/Obsidian-Config-Backup/${deep}`,
	]) {
		assert.equal(mock.dirs.has(p), true, `${p} 应该被创建`);
	}
	await assert.doesNotReject(c.ensureFolder(deep), "已存在时必须静默成功");
	// 空路径（baseDir 本身）不需要任何请求
	await assert.doesNotReject(c.ensureFolder(""));
});

test("downloadFile / downloadBuffer：内容一致；远端不存在时抛 DropboxApiError(409)", async () => {
	const c = newClient();
	const data = Buffer.from("下载内容：abc-123-中文\n", "utf8");
	mock.seed("/Obsidian-Config-Backup/dl/.obsidian/hotkeys.json", data);

	const buf = await c.downloadBuffer("dl/.obsidian/hotkeys.json");
	assert.ok(buf instanceof Uint8Array);
	assert.equal(sha256(Buffer.from(buf)), sha256(data));

	const dest = path.join(TMP_DIR, "dl", "nested", "hotkeys.json");
	await c.downloadFile("dl/.obsidian/hotkeys.json", dest);
	assert.equal(fs.existsSync(dest), true, "读取前必须自动建父目录");
	assert.equal(sha256(await fsp.readFile(dest)), sha256(data));

	await assert.rejects(
		c.downloadBuffer("dl/.obsidian/missing.json"),
		(err) => {
			assert.ok(err instanceof DropboxApiError, `应为 DropboxApiError，实际 ${err?.name}`);
			assert.equal(err.status, 409);
			assert.match(err.summary, /not_found/);
			return true;
		},
	);
});

test("uploadMany：并发不超上限，成功/失败分别归集，进度回调次数正确", async () => {
	const c = newClient({ concurrency: 2 });
	const dir = path.join(TMP_DIR, "many");
	await fsp.mkdir(dir, { recursive: true });

	const items = [];
	for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
		const p = path.join(dir, name);
		await fsp.writeFile(p, Buffer.from(`内容-${name}`));
		items.push({ relPath: `many/${name}`, absPath: p });
	}
	mock.failures.set("/Obsidian-Config-Backup/many/c.txt", {
		status: 409,
		times: Infinity,
		summary: "path/conflict/file/..",
	});

	mock.uploadDelayMs = 40;
	mock.maxInFlightUploads = 0;
	const progress = [];
	const res = await c.uploadMany(items, (done, total, relPath) => {
		progress.push({ done, total, relPath });
	});
	mock.uploadDelayMs = 0;

	assert.deepEqual(
		res.ok.map((x) => x.relPath),
		["many/a.txt", "many/b.txt", "many/d.txt"],
		"失败项不能拖垮整批，成功项要保持输入顺序",
	);
	assert.equal(res.failed.length, 1);
	assert.equal(res.failed[0].relPath, "many/c.txt");
	assert.match(res.failed[0].message, /conflict/);
	assert.equal(res.ok[0].size, Buffer.byteLength("内容-a.txt", "utf8"));
	assert.ok(res.ok.every((x) => x.rev.length > 0 && x.contentHash));

	assert.equal(progress.length, 4, "每个文件都要回调一次");
	assert.deepEqual(progress.map((p) => p.done), [1, 2, 3, 4]);
	assert.ok(progress.every((p) => p.total === 4));

	assert.ok(mock.maxInFlightUploads >= 2, "并发 2 应该真的并发");
	assert.ok(mock.maxInFlightUploads <= 2, `并发不能超过上限 2，实际 ${mock.maxInFlightUploads}`);
});

test("重试：503/429 退避后成功；持续 500 重试 3 次后抛错", async () => {
	const c = newClient();
	const dir = path.join(TMP_DIR, "retry");
	await fsp.mkdir(dir, { recursive: true });

	const p503 = path.join(dir, "r503.bin");
	await fsp.writeFile(p503, Buffer.from("retry-503"));
	mock.failures.set("/Obsidian-Config-Backup/retry/r503.bin", {
		status: 503,
		times: 2,
		summary: "internal_error/..",
	});
	const info = await c.uploadFile("retry/r503.bin", p503);
	assert.ok(info.rev.length > 0, "两次 503 之后第三次必须成功");
	assert.equal(mock.pathUploadCounts.get("/Obsidian-Config-Backup/retry/r503.bin"), 3);

	const p429 = path.join(dir, "r429.bin");
	await fsp.writeFile(p429, Buffer.from("retry-429"));
	mock.failures.set("/Obsidian-Config-Backup/retry/r429.bin", {
		status: 429,
		times: 1,
		summary: "too_many_requests/..",
		retryAfter: 0,
	});
	await assert.doesNotReject(c.uploadFile("retry/r429.bin", p429));
	assert.equal(mock.pathUploadCounts.get("/Obsidian-Config-Backup/retry/r429.bin"), 2);

	const p500 = path.join(dir, "r500.bin");
	await fsp.writeFile(p500, Buffer.from("retry-500"));
	mock.failures.set("/Obsidian-Config-Backup/retry/r500.bin", {
		status: 500,
		times: Infinity,
		summary: "internal_error/..",
	});
	await assert.rejects(
		c.uploadFile("retry/r500.bin", p500),
		(err) => {
			assert.ok(err instanceof DropboxApiError);
			assert.equal(err.status, 500);
			assert.match(err.summary, /internal_error/);
			return true;
		},
	);
	assert.equal(
		mock.pathUploadCounts.get("/Obsidian-Config-Backup/retry/r500.bin"),
		3,
		"最多尝试 3 次后必须放弃",
	);
});

test("401：自动刷新 token 后原样重试，并通过 onTokenRefreshed 回报", async () => {
	const refreshed = [];
	const tokens = {
		appKey: "app-key",
		accessToken: "stale-token",
		refreshToken: mock.refreshToken,
	};
	const c = newClient({ tokens, onTokenRefreshed: (t) => refreshed.push({ ...t }) });

	const beforeTokenForms = mock.tokenForms.length;
	const beforeAuthRejects = mock.authRejects;
	const beforeUrls = clientTokenUrls.length;
	const acct = await c.getCurrentAccount();

	assert.equal(acct.accountId, "dbid:AAA_mock", "刷新后必须自动重试成功");
	assert.equal(mock.authRejects, beforeAuthRejects + 1, "只应该被拒一次");
	assert.ok(
		clientTokenUrls.slice(beforeUrls).includes(DROPBOX_TOKEN_URL),
		"刷新必须打到官方 token 端点",
	);
	const forms = mock.tokenForms.slice(beforeTokenForms);
	assert.equal(forms.length, 1, "只应该刷新一次");
	assert.equal(forms[0].grant_type, "refresh_token");
	assert.equal(tokens.accessToken, mock.currentToken);
	assert.ok(tokens.expiresAt > Date.now() + 3600_000);
	assert.equal(refreshed.length, 1);
	assert.equal(refreshed[0].accessToken, mock.currentToken, "回调里要带上新 token 供持久化");
});

test("ensureAccessToken：无凭据抛错；凭据过期时自动刷新；token 刷新并发只打一次", async () => {
	await assert.rejects(
		newClient({ tokens: { appKey: "app-key" } }).ensureAccessToken(),
		/尚未授权/,
	);

	const tokens = {
		appKey: "app-key",
		accessToken: "expired-token",
		refreshToken: mock.refreshToken,
		expiresAt: Date.now() - 1000,
	};
	const c = newClient({ tokens });

	const before = mock.tokenForms.length;
	const [t1, t2, t3] = await Promise.all([
		c.ensureAccessToken(),
		c.ensureAccessToken(),
		c.ensureAccessToken(),
	]);
	assert.equal(t1, t2);
	assert.equal(t2, t3);
	assert.equal(t1, mock.currentToken);
	assert.equal(mock.tokenForms.length, before + 1, "并发调用只能触发一次刷新");
	assert.ok(tokens.expiresAt > Date.now());
});
