/**
 * 基于 Node 内置 fetch 的 HttpClient 实现，**只给开发侧的冒烟脚本用**。
 *
 * 为什么需要它：Node 的 `node:http` / `node:https` 不读 `http_proxy` / `https_proxy`
 * 环境变量，所以在挂了系统代理（Clash 之类）的机器上，src/http/node.ts 直连 Dropbox 会
 * ETIMEDOUT。而 Node ≥ 24 的内置 fetch 在 `NODE_USE_ENV_PROXY=1` 时会走环境变量里的代理。
 *
 * 插件本身不需要这个：Obsidian 的 requestUrl 走 Electron 网络栈，自带系统代理。
 *
 * 语义必须与 src/http/node.ts 一致：4xx/5xx 不抛异常，只回 status。
 */
export function createFetchHttpClient() {
	return {
		async request(req) {
			const init = { method: req.method, headers: { ...(req.headers ?? {}) } };
			if (req.body !== undefined && req.body !== null) init.body = req.body;

			const res = await fetch(req.url, init);
			const headers = {};
			res.headers.forEach((value, key) => {
				headers[key] = value;
			});

			const out = { status: res.status, headers };
			const kind = req.responseType ?? "json";
			if (kind === "arraybuffer") {
				out.arrayBuffer = await res.arrayBuffer();
			} else if (kind === "text") {
				out.text = await res.text();
			} else {
				const text = await res.text();
				if (text.length > 0) {
					try {
						out.json = JSON.parse(text);
					} catch {
						out.json = undefined;
					}
				}
			}
			return out;
		},
	};
}
