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

export interface PkcePair {
	/** 每次授权重新生成，只存在内存里 */
	verifier: string;
	/** base64url(sha256(verifier)) */
	challenge: string;
}

export function createPkcePair(): PkcePair {
	throw new Error("not implemented: createPkcePair");
}

export interface AuthorizeUrlOptions {
	appKey: string;
	challenge: string;
	state: string;
	/** 省略则走 manual 模式 */
	redirectUri?: string;
}

export function buildAuthorizeUrl(o: AuthorizeUrlOptions): string {
	throw new Error("not implemented: buildAuthorizeUrl");
}

export interface ExchangeOptions {
	appKey: string;
	code: string;
	verifier: string;
	redirectUri?: string;
}

/** 用授权码换 access_token + refresh_token */
export async function exchangeCodeForTokens(
	http: HttpClient,
	o: ExchangeOptions,
): Promise<DropboxTokens> {
	throw new Error("not implemented: exchangeCodeForTokens");
}

/** 用 refresh_token 换新的 access_token */
export async function refreshAccessToken(
	http: HttpClient,
	o: { appKey: string; refreshToken: string },
): Promise<{ accessToken: string; expiresIn: number }> {
	throw new Error("not implemented: refreshAccessToken");
}

export interface CallbackServer {
	/** 已绑定成功的 redirect_uri，形如 http://localhost:53682/ */
	redirectUri: string;
	/** 等用户在浏览器里点完授权；超时/state 不匹配都要 reject */
	waitForCode(timeoutMs?: number): Promise<string>;
	close(): void;
}

/**
 * 在 127.0.0.1:port 起一个一次性 HTTP 服务接 OAuth 回调。
 * 必须校验返回的 state —— 不匹配就是 CSRF，直接 reject。
 * 建议超时 5 分钟。
 */
export async function startLocalCallbackServer(
	port: number,
	expectedState: string,
): Promise<CallbackServer> {
	throw new Error("not implemented: startLocalCallbackServer");
}
