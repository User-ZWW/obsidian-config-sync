import { requestUrl } from "obsidian";
import type { HttpClient, HttpRequest, HttpResponse } from "../types.ts";

/**
 * 用 Obsidian 的 requestUrl 实现 HttpClient —— 它是 Electron 主进程发请求，
 * 天然绕开浏览器 CORS，所以 Dropbox API 的 content.dropboxapi.com 才能直接用。
 *
 * 要求：
 *   - responseType 'json' → requestUrl({ ..., throw: false }) 后 JSON.parse(res.text)
 *     注意 requestUrl 在 responseType:'json' 时已经解析好了，直接用 res.json
 *   - 二进制用 responseType: 'arraybuffer'
 */

/** Obsidian 的 body 只接受 string | ArrayBuffer，这里把 Uint8Array 转过去 */
function toBody(body: HttpRequest["body"]): string | ArrayBuffer | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) {
		// 只有整块都是它自己时才直接复用底层 buffer，否则必须精确切片
		if (body.byteOffset === 0 && body.byteLength === body.buffer.byteLength) {
			return body.buffer as ArrayBuffer;
		}
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
	}
	return body;
}

export function createObsidianHttpClient(): HttpClient {
	return {
		async request(req: HttpRequest): Promise<HttpResponse> {
			const res = await requestUrl({
				url: req.url,
				method: req.method,
				headers: req.headers,
				body: toBody(req.body),
				// 关键：4xx/5xx 不抛，交给上层统一判断和重试
				throw: false,
			});
			const out: HttpResponse = { status: res.status, headers: res.headers ?? {} };
			if (req.responseType === "arraybuffer") {
				out.arrayBuffer = res.arrayBuffer;
			} else if (req.responseType === "text") {
				out.text = res.text;
			} else {
				out.text = res.text;
				try {
					out.json = res.json;
				} catch {
					// 响应体不是 JSON 时 Obsidian 的 json getter 会抛，降级成 undefined
					out.json = undefined;
				}
			}
			return out;
		},
	};
}
