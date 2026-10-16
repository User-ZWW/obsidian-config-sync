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
export function createNodeHttpClient(): HttpClient {
	throw new Error("not implemented: createNodeHttpClient");
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
