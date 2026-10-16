import { App, PluginSettingTab } from "obsidian";
import type { ConfigSyncPluginApi } from "../plugin-api.ts";

/**
 * 设置面板。分区：
 *   1. Dropbox 连接 —— App key、连接/断开、账户与配额、远端根目录、授权模式
 *   2. 同步范围   —— include/exclude 两个多行输入框 + 一行实时预览（当前会同步多少文件/多少 MB）
 *   3. 触发       —— 变更自动同步开关 + 防抖秒数、定时间隔、启动延迟
 *   4. 快照       —— 开关、every-run/daily、保留份数
 *   5. 备份与还原 —— 立即备份 / 预览差异 / 还原 / 立即生成快照
 *   6. 日志       —— 最近 500 行 + 清空 + 复制
 *
 * 所有改设置的动作都要 await api.saveSettings() 再 api.refreshTriggers()。
 */
export class ConfigSyncSettingTab extends PluginSettingTab {
	private api: ConfigSyncPluginApi;

	constructor(app: App, api: ConfigSyncPluginApi) {
		super(app, api as never);
		this.api = api;
	}

	display(): void {
		void this.api;
		throw new Error("not implemented: display");
	}
}
