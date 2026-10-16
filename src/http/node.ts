import { Buffer } from "node:buffer";
import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import { URL } from "node:url";
import type { HttpClient, HttpRequest, HttpResponse } from "../types.ts";

/**
 * 基于 node:http/https 的 HttpClient。生产环境用不到（生产用 Obsidian 的 requestUrl），
 * 但它是单元测试和命令行冒烟脚本的主力：测试里用它在本地起 mock Dropbox 服务。
 *
 * 返回的 HttpResponse 语义必须与 Obsidian 实现一致：
 *   - 4xx/5xx 不抛异常，而是返回对应 status（由调用方决定重试/报错）
 *   - responseType === 'json'  时填 json
 *   - responseType === 'arraybuffer' 时填 arrayBuffer
 *   - responseType === 'text'  时填 text
 */

/** 单次请求超时。分块上传每个 chunk 只有 8MB，120 秒已经很宽松。 */
const REQUEST_TIMEOUT_MS = 120_000;

/** 把请求体统一成 Buffer；null / undefined 表示没有请求体 */
function toBuffer(body: HttpRequest["body"]): Buffer | null {
	if (body === undefined || body === null) return null;
	if (typeof body === "string") return Buffer.from(body, "utf8");
	if (body instanceof Uint8Array) {
		// 不复制：请求发出期间调用方不应该再改动这块数据
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	}
	// 走到这里只剩 ArrayBuffer：拷一份，避免调用方在请求途中改动
	return Buffer.from(new Uint8Array(body));
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
	const ab = new ArrayBuffer(b.byteLength);
	new Uint8Array(ab).set(b);
	return ab;
}

/** node 的响应头可能是数组（例如 set-cookie），统一成小写键 + 逗号拼接的字符串 */
function normalizeHeaders(h: nodeHttp.IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) {
		if (v === undefined) continue;
		out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
	}
	return out;
}

export function createNodeHttpClient(): HttpClient {
	return {
		async request(req: HttpRequest): Promise<HttpResponse> {
			const url = new URL(req.url);
			const secure = url.protocol === "https:";
			const payload = toBuffer(req.body);

			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = v;
			// 显式给 Content-Length，避免 node 退化成 chunked 编码
			if (payload && payload.byteLength > 0) headers["Content-Length"] = String(payload.byteLength);
			else if (req.method === "POST") headers["Content-Length"] = "0";

			const options: nodeHttp.RequestOptions = {
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port === "" ? undefined : Number(url.port),
				path: `${url.pathname}${url.search}`,
				method: req.method,
				headers,
				// 关掉 keep-alive（agent: false = 每次新建一个无 keep-alive 的 Agent）：
				// 测试里 mock server 关闭后进程能立刻退出，不会挂着空 socket
				agent: false,
			};

			const raw = await new Promise<{
				status: number;
				headers: Record<string, string>;
				body: Buffer;
			}>((resolve, reject) => {
				const onResponse = (res: nodeHttp.IncomingMessage): void => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("error", reject);
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							headers: normalizeHeaders(res.headers),
							body: Buffer.concat(chunks),
						}),
					);
				};
				const r = secure
					? nodeHttps.request(options, onResponse)
					: nodeHttp.request(options, onResponse);
				r.on("error", reject);
				r.setTimeout(REQUEST_TIMEOUT_MS, () => {
					r.destroy(new Error(`HTTP 请求超时（${REQUEST_TIMEOUT_MS}ms）：${req.url}`));
				});
				if (payload && payload.byteLength > 0) r.write(payload);
				r.end();
			});

			const out: HttpResponse = { status: raw.status, headers: raw.headers };
			const kind = req.responseType ?? "json";
			if (kind === "arraybuffer") {
				out.arrayBuffer = toArrayBuffer(raw.body);
			} else {
				const text = raw.body.toString("utf8");
				out.text = text;
				if (kind === "json" && text.length > 0) {
					try {
						out.json = JSON.parse(text);
					} catch {
						// 不是 JSON 就只留 text，让调用方自己决定怎么报错
						out.json = undefined;
					}
				}
			}
			return out;
		},
	};
}

/** 便于测试：不真正发请求，用给定响应表返回 */
export function createMockHttpClient(
	handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse,
): HttpClient {
	return {
		async request(req: HttpRequest): Promise<HttpResponse> {
			return await handler(req);
		},
	};
}
