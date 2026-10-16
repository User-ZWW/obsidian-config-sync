import type { ConfigSyncPluginApi } from "../plugin-api.ts";

/**
 * 状态栏 + ribbon 图标 + 通知。
 * 状态栏文案三态：空闲（上次同步时间）/ 进行中（进度）/ 出错（红色）。
 * 点状态栏 = 立即同步。
 */
export class StatusIndicator {
	constructor(api: ConfigSyncPluginApi) {
		throw new Error("not implemented: StatusIndicator");
	}

	setIdle(text: string): void {
		throw new Error("not implemented: setIdle");
	}

	setBusy(phase: string, done: number, total: number): void {
		throw new Error("not implemented: setBusy");
	}

	setError(text: string): void {
		throw new Error("not implemented: setError");
	}

	unload(): void {
		throw new Error("not implemented: unload");
	}
}
