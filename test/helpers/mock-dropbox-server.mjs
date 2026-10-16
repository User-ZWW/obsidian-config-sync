/**
 * 保真度较高的本地 mock Dropbox 服务，供端到端集成测试使用。
 *
 * 故意收紧的地方（比"能跑通就行"的 stub 更苛刻，用来抓真实 bug）：
 *   - list_folder 每页只回 3 条 → 强制走 list_folder/continue 翻页
 *   - upload_session/append_v2 与 finish 校验 cursor.offset，对不上就回 409 incorrect_offset
 *   - create_folder_v2 不自动补父目录（真实 Dropbox 就是 409 path/not_found）
 *   - delete_v2 删不存在的路径回 409 path_lookup/not_found（调用方必须当成功处理）
 *   - 所有响应都是真 socket + 真 HTTP 状态码，不是函数打桩
 *
 * 也顺带验证了 Dropbox-API-Arg 头里的非 ASCII 转义：这里直接 JSON.parse 头值，
 * 中文路径只要没按 \uXXXX 转义就会在 Node 的 http 层先炸掉。
 */
import http from "node:http";
import crypto from "node:crypto";

const PAGE_SIZE = 3;

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function sendJson(res, status, obj) {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
	res.end(body);
}

/** Dropbox 的 content_hash：sha256 后按 4MB 分块各取 sha256 再拼起来（非标准 sha256） */
function dropboxContentHash(buf) {
	const hashes = [];
	for (let i = 0; i < buf.length; i += 4 * 1024 * 1024) {
		hashes.push(crypto.createHash("sha256").update(buf.subarray(i, i + 4 * 1024 * 1024)).digest());
	}
	if (hashes.length === 0) hashes.push(crypto.createHash("sha256").update(Buffer.alloc(0)).digest());
	return crypto.createHash("sha256").update(Buffer.concat(hashes)).digest("hex");
}

/** HTTP 头只能是 ASCII：非 ASCII 必须 \uXXXX 转义（真实 Dropbox 就是这么干的） */
function asciiHeaderValue(obj) {
	return JSON.stringify(obj).replace(
		/[\u007f-\uffff]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const pathKey = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export async function startMockDropbox() {
	const files = new Map(); // key -> { path, buffer, rev, serverModified }
	const folders = new Set(); // key（含 "" 作为根）
	const sessions = new Map(); // sessionId -> { chunks: Buffer[], received: number }
	const requests = []; // { route, path }，测试用来断言确实跑了翻页/分块
	let revCounter = 0;
	let sessionCounter = 0;

	folders.add("");

	const metaOf = (entry) => ({
		".tag": "file",
		name: entry.path.split("/").pop(),
		path_lower: pathKey(entry.path),
		path_display: entry.path,
		id: `id:${entry.path}`,
		client_modified: entry.serverModified,
		server_modified: entry.serverModified,
		rev: entry.rev,
		size: entry.buffer.length,
		content_hash: dropboxContentHash(entry.buffer),
	});

	function store(rawPath, buffer) {
		const key = pathKey(rawPath);
		revCounter += 1;
		// 真实 Dropbox 上传会自动建父目录，这里照做，否则后续 list_folder 会 409
		const parts = key.split("/");
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
		const entry = {
			path: rawPath.replace(/\\/g, "/"),
			buffer: Buffer.from(buffer),
			rev: `${revCounter.toString(16).padStart(16, "0")}`,
			serverModified: new Date().toISOString(),
		};
		files.set(key, entry);
		return entry;
	}

	function childFolders(prefix) {
		const out = [];
		for (const f of folders) {
			if (f === "" || f === prefix) continue;
			if (prefix === "" ? !f.includes("/") : f.startsWith(`${prefix}/`) && !f.slice(prefix.length + 1).includes("/")) {
				out.push(f);
			}
		}
		return out;
	}

	function listing(prefix, recursive) {
		const entries = [];
		for (const key of childFolders(prefix)) {
			entries.push({ ".tag": "folder", name: key.split("/").pop(), path_lower: key, path_display: key });
		}
		for (const entry of files.values()) {
			const key = pathKey(entry.path);
			if (prefix !== "" && !key.startsWith(`${prefix}/`)) continue;
			if (!recursive && key.slice(prefix === "" ? 0 : prefix.length + 1).includes("/")) continue;
			entries.push(metaOf(entry));
		}
		entries.sort((a, b) => (a.path_lower < b.path_lower ? -1 : a.path_lower > b.path_lower ? 1 : 0));
		return entries;
	}

	function conflict(res, summary, tag, sub) {
		sendJson(res, 409, { error_summary: summary, error: { ".tag": tag, [sub.tag]: sub.value } });
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const route = url.pathname.replace(/^\/2/, "");
		const body = await readBody(req);
		const argHeader = req.headers["dropbox-api-arg"];
		let arg = null;
		if (typeof argHeader === "string") arg = JSON.parse(argHeader);
		else if (body.length > 0) arg = JSON.parse(body.toString("utf8"));

		requests.push({ route, path: arg && typeof arg === "object" ? arg.path ?? null : null });

		switch (route) {
			case "/files/upload": {
				const entry = store(arg.path, body);
				return sendJson(res, 200, metaOf(entry));
			}

			case "/files/upload_session/start": {
				sessionCounter += 1;
				const id = `mock-session-${sessionCounter}`;
				sessions.set(id, { chunks: [Buffer.from(body)], received: body.length });
				return sendJson(res, 200, { session_id: id });
			}

			case "/files/upload_session/append_v2": {
				const s = sessions.get(arg.cursor.session_id);
				if (!s) return conflict(res, "not_found/session", "not_found", { tag: "path_lookup", value: { ".tag": "not_found" } });
				if (arg.cursor.offset !== s.received) {
					return conflict(res, "incorrect_offset/...", "incorrect_offset", {
						tag: "incorrect_offset",
						value: { correct_offset: s.received },
					});
				}
				s.chunks.push(Buffer.from(body));
				s.received += body.length;
				return sendJson(res, 200, {});
			}

			case "/files/upload_session/finish": {
				const s = sessions.get(arg.cursor.session_id);
				if (!s) return conflict(res, "not_found/session", "not_found", { tag: "path_lookup", value: { ".tag": "not_found" } });
				if (arg.cursor.offset !== s.received) {
					return conflict(res, "incorrect_offset/...", "incorrect_offset", {
						tag: "incorrect_offset",
						value: { correct_offset: s.received },
					});
				}
				s.chunks.push(Buffer.from(body));
				sessions.delete(arg.cursor.session_id);
				const entry = store(arg.commit.path, Buffer.concat(s.chunks));
				return sendJson(res, 200, metaOf(entry));
			}

			case "/files/list_folder": {
				const prefix = pathKey(arg.path);
				if (arg.path !== "" && !folders.has(prefix)) {
					return sendJson(res, 409, {
						error_summary: "path/not_found/...",
						error: { ".tag": "path", path: { ".tag": "not_found" } },
					});
				}
				const all = listing(prefix, arg.recursive !== false);
				const page = all.slice(0, PAGE_SIZE);
				return sendJson(res, 200, {
					entries: page,
					cursor: `cur:${arg.path ?? ""}:${page.length}`,
					has_more: all.length > page.length,
				});
			}

			case "/files/list_folder/continue": {
				const m = /^cur:(.*):(\d+)$/.exec(arg.cursor);
				if (!m) return conflict(res, "invalid_cursor", "invalid_cursor", { tag: "invalid_cursor", value: {} });
				const prefix = pathKey(m[1]);
				const offset = Number(m[2]);
				const all = listing(prefix, true);
				const page = all.slice(offset, offset + PAGE_SIZE);
				return sendJson(res, 200, {
					entries: page,
					cursor: `cur:${m[1]}:${offset + page.length}`,
					has_more: all.length > offset + page.length,
				});
			}

			case "/files/delete_v2": {
				const key = pathKey(arg.path);
				if (!files.has(key)) {
					return conflict(res, "path_lookup/not_found/...", "path_lookup", {
						tag: "path_lookup",
						value: { ".tag": "not_found" },
					});
				}
				const entry = files.get(key);
				files.delete(key);
				return sendJson(res, 200, { metadata: metaOf(entry) });
			}

			case "/files/create_folder_v2": {
				const key = pathKey(arg.path);
				const parent = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
				if (folders.has(key) || files.has(key)) {
					return conflict(res, "path/conflict/folder", "path", {
						tag: "path",
						value: { ".tag": "conflict", conflict: { ".tag": "folder" } },
					});
				}
				if (!folders.has(parent)) {
					return conflict(res, "path/not_found/...", "path", {
						tag: "path",
						value: { ".tag": "not_found" },
					});
				}
				folders.add(key);
				return sendJson(res, 200, { metadata: { ".tag": "folder", name: key.split("/").pop(), path_lower: key, path_display: arg.path } });
			}

			case "/files/download": {
				const key = pathKey(arg.path);
				const entry = files.get(key);
				if (!entry) {
					return conflict(res, "path_lookup/not_found/...", "path_lookup", {
						tag: "path_lookup",
						value: { ".tag": "not_found" },
					});
				}
				res.writeHead(200, {
					"Content-Type": "application/octet-stream",
					"Content-Length": entry.buffer.length,
					"Dropbox-API-Result": asciiHeaderValue(metaOf(entry)),
				});
				return res.end(entry.buffer);
			}

			case "/users/get_current_account": {
				return sendJson(res, 200, {
					account_id: "dbid:mock",
					name: { display_name: "Mock User" },
					email: "mock@example.com",
				});
			}

			case "/users/get_space_usage": {
				let used = 0;
				for (const e of files.values()) used += e.buffer.length;
				return sendJson(res, 200, {
					used,
					allocation: { ".tag": "individual", allocated: 18 * 1024 * 1024 * 1024 },
				});
			}

			default:
				return sendJson(res, 404, { error_summary: `unknown route ${route}`, error: { ".tag": "other" } });
		}
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		files,
		folders,
		requests,
		/** 远端某个绝对路径上的字节；不存在返回 null */
		read(path) {
			const e = files.get(pathKey(path));
			return e ? e.buffer : null;
		},
		/** 扁平的文件路径列表（按 Dropbox 风格），测试用来做集合断言 */
		paths() {
			return [...files.values()].map((e) => e.path).sort();
		},
		stop() {
			return new Promise((resolve) => server.close(resolve));
		},
	};
}
