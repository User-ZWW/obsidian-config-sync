import { Notice } from "obsidian";
import type { Plugin } from "obsidian";
import type { ConfigSyncPluginApi } from "../plugin-api.ts";
import { formatProgress, formatSyncSummary, truncate } from "./format.ts";

/**
 * 状态栏 + ribbon 图标 + 通知。
 * 状态栏文案三态：空闲（上次同步时间）/ 进行中（进度）/ 出错（红色）。
 * 点状态栏 = 立即同步。
 * 构造时拿 Plugin 是为了 addStatusBarItem() / addRibbonIcon()。
 *
 * 本文件 import 了 obsidian，所以只能在 Obsidian 里跑；
 * 文案格式化全部委托给 ./format.ts（那部分有真实测试）。
 */
export class StatusIndicator {
	private api: ConfigSyncPluginApi;
	private statusEl: HTMLElement;
	private ribbonEl: HTMLElement;
	private busy = false;

	constructor(api: ConfigSyncPluginApi, plugin: Plugin) {
		this.api = api;

		this.statusEl = plugin.addStatusBarItem();
		this.statusEl.addClass("config-sync-status");
		this.statusEl.onClickEvent((evt) => {
			evt.preventDefault();
			void this.triggerSync();
		});

		this.ribbonEl = plugin.addRibbonIcon("refresh-cw", "配置文件夹云备份：立即同步", () => {
			void this.triggerSync();
		});

		const last = this.api.settings.lastResultSummary;
		this.setIdle(last ? `配置备份：${last}` : "配置备份：就绪");
	}

	setIdle(text: string): void {
		this.busy = false;
		this.statusEl.removeClass("config-sync-busy");
		this.statusEl.removeClass("config-sync-error");
		this.statusEl.setText(text);
		this.statusEl.setAttribute("aria-label", text);
		this.statusEl.setAttribute("title", text);
	}

	setBusy(phase: string, done: number, total: number): void {
		this.busy = true;
		this.statusEl.removeClass("config-sync-error");
		this.statusEl.addClass("config-sync-busy");
		const text = `配置备份：${formatProgress(phase, done, total)}`;
		this.statusEl.setText(text);
		this.statusEl.setAttribute("aria-label", text);
	}

	setError(text: string): void {
		this.busy = false;
		this.statusEl.removeClass("config-sync-busy");
		this.statusEl.addClass("config-sync-error");
		const shown = `配置备份：${truncate(text, 80)}`;
		this.statusEl.setText(shown);
		this.statusEl.setAttribute("aria-label", shown);
		new Notice(`配置文件夹云备份失败：${text}`, 8000);
	}

	unload(): void {
		this.statusEl.remove();
		this.ribbonEl.remove();
	}

	/** 点状态栏 / ribbon：跑一轮手动同步并把结果回写到状态栏与通知。 */
	private async triggerSync(): Promise<void> {
		if (this.busy || this.api.engine.running) {
			new Notice("配置备份：已经有一轮同步在进行，请稍候");
			return;
		}
		this.setBusy("同步中", 0, 0);
		try {
			const result = await this.api.runSync("manual");
			if (result.errors.length > 0) {
				this.setError(`有 ${result.errors.length} 个文件失败，详见设置面板的日志`);
				return;
			}
			const summary = formatSyncSummary(result);
			this.setIdle(`配置备份：${summary}`);
			new Notice(`配置备份完成：${summary}`, 5000);
		} catch (err) {
			this.setError(err instanceof Error ? err.message : String(err));
		}
	}
}
