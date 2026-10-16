import type { HttpClient } from "../types.ts";

/**
 * 用 Obsidian 的 requestUrl 实现 HttpClient —— 它是 Electron 主进程发请求，
 * 天然绕开浏览器 CORS，所以 Dropbox API 的 content.dropboxapi.com 才能直接用。
 *
 * 要求：
 *   - responseType 'json' → requestUrl({ ..., throw: false }) 后 JSON.parse(res.text)
 *     注意 requestUrl 在 responseType:'json' 时已经解析好了，直接用 res.json
 *   - 二进制用 responseType: 'arraybuffer'
 */
export function createObsidianHttpClient(): HttpClient {
	throw new Error("not implemented: createObsidianHttpClient");
}
