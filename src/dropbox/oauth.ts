import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import * as nodeHttp from "node:http";
import { URL, URLSearchParams } from "node:url";
import type { DropboxTokens, HttpClient } from "../types.ts";

/**
 * Dropbox OAuth 2.0 + PKCE（公开客户端，不需要 App secret）。
 *
 * 官方规则（已核对 developers.dropbox.com/oauth-guide）：
 *  - 桌面端要后台访问 → 用 code flow + PKCE + refresh token，授权 URL 必须带
 *    token_access_type=offline 才会返回 refresh_token。
 *  - redirect_uri 必须与 App Console 登记值完全一致，且除 localhost 外必须 HTTPS。
 *  - code flow 下 redirect_uri 可以省略，此时 Dropbox 把 code 显示给用户手动粘贴。
 *    这是零配置兜底路径（authMode = 'manual'）。
 */

/** 追加导出：授权页地址（测试与文档引用它，避免各处硬编码字符串） */
export const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
/** 追加导出：token 端点（换 code / 换 refresh token 共用） */
export const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

/** 建议等待用户授权的超时：5 分钟 */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface PkcePair {
	/** 每次授权重新生成，只存在内存里 */
	verifier: string;
	/** base64url(sha256(verifier)) */
	challenge: string;
}

/** base64url 编码（RFC 4648 §5，去掉 '=' 填充）—— PKCE 与 Dropbox 都用这个 */
function base64url(input: Uint8Array): string {
	return Buffer.from(input)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function createPkcePair(): PkcePair {
	// 64 字节随机 → base64url 后 86 个字符，落在 RFC 7636 允许的 43~128 区间内
	const verifier = base64url(randomBytes(64));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export interface AuthorizeUrlOptions {
	appKey: string;
	challenge: string;
	state: string;
	/** 省略则走 manual 模式 */
	redirectUri?: string;
}

export function buildAuthorizeUrl(o: AuthorizeUrlOptions): string {
	const p = new URLSearchParams();
	p.set("client_id", o.appKey);
	p.set("response_type", "code");
	p.set("code_challenge", o.challenge);
	p.set("code_challenge_method", "S256");
	p.set("state", o.state);
	// 不带 offline 只会给 access_token，刷新不了；这是后台同步的核心
	p.set("token_access_type", "offline");
	if (o.redirectUri) p.set("redirect_uri", o.redirectUri);
	return `${DROPBOX_AUTHORIZE_URL}?${p.toString()}`;
}

export interface ExchangeOptions {
	appKey: string;
	code: string;
	verifier: string;
	redirectUri?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** token 端点的错误体形如 { error: "invalid_grant", error_description: "..." } */
function tokenError(res: { status: number; json?: unknown; text?: string }): string {
	const j = asRecord(res.json);
	const desc = typeof j.error_description === "string" ? j.error_description : "";
	const code = typeof j.error === "string" ? j.error : "";
	const detail = [code, desc].filter(Boolean).join(": ");
	if (detail) return detail;
	const text = typeof res.text === "string" ? res.text.trim() : "";
	return text ? text.slice(0, 300) : "（响应无正文）";
}

async function postTokenForm(
	http: HttpClient,
	form: URLSearchParams,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await http.request({
		url: DROPBOX_TOKEN_URL,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: form.toString(),
		responseType: "json",
	});
	return { status: res.status, json: asRecord(res.json) };
}

/** 用授权码换 access_token + refresh_token */
export async function exchangeCodeForTokens(
	http: HttpClient,
	o: ExchangeOptions,
): Promise<DropboxTokens> {
	const form = new URLSearchParams();
	form.set("code", o.code);
	form.set("grant_type", "authorization_code");
	form.set("client_id", o.appKey);
	form.set("code_verifier", o.verifier);
	// 只有当初带了 redirect_uri，换 token 时也必须带上并且完全一致
	if (o.redirectUri) form.set("redirect_uri", o.redirectUri);

	const { status, json } = await postTokenForm(http, form);
	const accessToken = typeof json.access_token === "string" ? json.access_token : "";
	if (status < 200 || status >= 300 || !accessToken) {
		throw new Error(`Dropbox 授权失败（HTTP ${status}）：${tokenError({ status, json })}`);
	}
	const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 14_400;
	return {
		appKey: o.appKey,
		accessToken,
		refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
		expiresAt: Date.now() + expiresIn * 1000,
		accountId:
			typeof json.account_id === "string"
				? json.account_id
				: typeof json.uid === "string"
					? json.uid
					: undefined,
	};
}

/** 用 refresh_token 换新的 access_token */
export async function refreshAccessToken(
	http: HttpClient,
	o: { appKey: string; refreshToken: string },
): Promise<{ accessToken: string; expiresIn: number }> {
	const form = new URLSearchParams();
	form.set("grant_type", "refresh_token");
	form.set("refresh_token", o.refreshToken);
	form.set("client_id", o.appKey);

	const { status, json } = await postTokenForm(http, form);
	const accessToken = typeof json.access_token === "string" ? json.access_token : "";
	if (status < 200 || status >= 300 || !accessToken) {
		throw new Error(`Dropbox token 刷新失败（HTTP ${status}）：${tokenError({ status, json })}`);
	}
	return {
		accessToken,
		expiresIn: typeof json.expires_in === "number" ? json.expires_in : 14_400,
	};
}

export interface CallbackServer {
	/** 已绑定成功的 redirect_uri，形如 http://localhost:53682/ */
	redirectUri: string;
	/** 等用户在浏览器里点完授权；超时/state 不匹配都要 reject */
	waitForCode(timeoutMs?: number): Promise<string>;
	close(): void;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
	);
}

/** 一次性回调页面的响应头：Connection: close 让浏览器/undici 用完就断开，不留 keep-alive */
const PAGE_HEADERS: Record<string, string> = {
	"Content-Type": "text/html; charset=utf-8",
	Connection: "close",
};

/**
 * 在 127.0.0.1:port 起一个一次性 HTTP 服务接 OAuth 回调。
 * 必须校验返回的 state —— 不匹配就是 CSRF，直接 reject。
 * 建议超时 5 分钟。
 */
export async function startLocalCallbackServer(
	port: number,
	expectedState: string,
): Promise<CallbackServer> {
	const server = nodeHttp.createServer();

	let settled = false;
	let codeValue: string | undefined;
	let errorValue: Error | undefined;
	let resolveCode: ((code: string) => void) | undefined;
	let rejectCode: ((err: Error) => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	const close = (): void => {
		if (closed) return;
		closed = true;
		try {
			server.close();
		} catch {
			/* 已经关了 */
		}
		// 兜底：等 250ms 让已完成响应先写出去，再销毁任何残留连接（含 keep-alive 的）
		setTimeout(() => {
			try {
				server.closeAllConnections();
			} catch {
				/* 忽略 */
			}
		}, 250);
		// 主动关闭时要让还在等的人立刻知道，而不是干等到超时
		if (!settled) {
			settled = true;
			if (timer) clearTimeout(timer);
			errorValue = new Error("OAuth 回调服务器已关闭，未收到授权码");
			rejectCode?.(errorValue);
		}
	};

	const settle = (err: Error | null, code?: string): void => {
		if (settled) return;
		settled = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (err) {
			errorValue = err;
			rejectCode?.(err);
		} else {
			codeValue = code ?? "";
			resolveCode?.(codeValue);
		}
		close();
	};

	server.on("request", (req, res) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "/", `http://localhost:${port}`);
		} catch {
			res.writeHead(400, PAGE_HEADERS);
			res.end("<h3>无法解析回调请求</h3>");
			return;
		}
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const oauthError = url.searchParams.get("error");

		// 浏览器经常会顺手请求 /favicon.ico、/robots.txt，这些没有 code/error/state，
		// 一律忽略，绝不能因此打断授权流程
		if (!code && !oauthError && !state) {
			res.writeHead(404, PAGE_HEADERS);
			res.end("Not found");
			return;
		}
		if (oauthError) {
			res.writeHead(200, PAGE_HEADERS);
			res.end(`<h3>授权被拒绝：${escapeHtml(oauthError)}</h3><p>可以关闭此窗口。</p>`);
			res.once("finish", () => settle(new Error(`Dropbox 授权被拒绝：${oauthError}`)));
			return;
		}
		if (state !== expectedState) {
			res.writeHead(400, PAGE_HEADERS);
			res.end("<h3>state 校验失败，已中止本次授权</h3>");
			res.once("finish", () =>
				settle(new Error("OAuth state 不匹配（可能是 CSRF），已中止本次授权")),
			);
			return;
		}
		res.writeHead(200, PAGE_HEADERS);
		res.end("<h3>授权成功</h3><p>可以关闭此窗口，回到 Obsidian 了。</p>");
		// 等响应真的写出去再结束，避免客户端拿到连接被重置的错误
		res.once("finish", () => settle(null, code ?? ""));
	});

	server.on("error", (err: Error) => settle(err));

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => reject(err);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resolve();
		});
	});

	const addr = server.address();
	const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;

	return {
		redirectUri: `http://localhost:${actualPort}/`,
		waitForCode(timeoutMs: number = CALLBACK_TIMEOUT_MS): Promise<string> {
			if (settled) {
				return errorValue ? Promise.reject(errorValue) : Promise.resolve(codeValue ?? "");
			}
			return new Promise<string>((resolve, reject) => {
				resolveCode = resolve;
				rejectCode = reject;
				timer = setTimeout(
					() =>
						settle(
							new Error(
								`等待 Dropbox 授权回调超时（${Math.round(timeoutMs / 1000)} 秒），请重试`,
							),
						),
					timeoutMs,
				);
			});
		},
		close,
	};
}
