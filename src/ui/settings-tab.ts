import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { ConfigSyncPluginApi } from "../plugin-api.ts";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from "../config/defaults.ts";
import {
	formatBytes,
	formatCount,
	formatDuration,
	formatInterval,
	formatIsoClock,
	formatScopeSummary,
	formatSpaceUsage,
	formatSyncSummary,
} from "./format.ts";

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
 *
 * 本文件 import 了 obsidian，只能在 Obsidian 里跑；所有文案格式化都委托给 ./format.ts。
 */

/** 错误对象 → 用户可读的一行。 */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** 远端根目录规范化：去空白、统一成 '/'、补前导 '/'、去结尾 '/'。 */
function normalizeRemoteDir(input: string): string {
	const anchored = input.trim().replace(/\\/g, "/");
	const withSlash = anchored.startsWith("/") ? anchored : `/${anchored}`;
	const trimmed = withSlash.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

/** 多行文本 → 去空行、去前后空白的模式数组。 */
function splitLines(input: string): string[] {
	return input
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** 还原确认弹窗：拿到用户的选择后 resolve；Esc / 点背景关掉 = 放弃。 */
class ConfirmModal extends Modal {
	private readonly headingText: string;
	private readonly lines: string[];
	private resolveChoice: ((ok: boolean) => void) | null = null;

	constructor(app: App, headingText: string, lines: string[]) {
		super(app);
		this.headingText = headingText;
		this.lines = lines;
	}

	ask(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolveChoice = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.titleEl.setText(this.headingText);
		for (const line of this.lines) this.contentEl.createDiv({ text: line });
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(false));
		row.createEl("button", { text: "确认还原", cls: "mod-warning" }).addEventListener("click", () => this.finish(true));
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}

	private finish(ok: boolean): void {
		const resolve = this.resolveChoice;
		this.resolveChoice = null;
		if (resolve === null) return; // 已经处理过（onClose 会再调一次）
		this.close();
		resolve(ok);
	}
}

export class ConfigSyncSettingTab extends PluginSettingTab {
	private api: ConfigSyncPluginApi;

	constructor(app: App, plugin: Plugin, api: ConfigSyncPluginApi) {
		super(app, plugin);
		this.api = api;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("config-sync-settings");
		this.renderDropboxSection(containerEl);
		this.renderScopeSection(containerEl);
		this.renderTriggerSection(containerEl);
		this.renderSnapshotSection(containerEl);
		this.renderActionsSection(containerEl);
		this.renderLogSection(containerEl);
	}

	/** 所有改设置的地方都走这里：先落盘，再按新设置重装配触发器。 */
	private async applySettings(): Promise<void> {
		try {
			await this.api.saveSettings();
			this.api.refreshTriggers();
		} catch (err) {
			new Notice(`保存设置失败：${errText(err)}`, 8000);
		}
	}

	private heading(containerEl: HTMLElement, name: string): void {
		new Setting(containerEl).setName(name).setHeading();
	}

	/* ============================ 1. Dropbox 连接 ============================ */

	private renderDropboxSection(containerEl: HTMLElement): void {
		this.heading(containerEl, "Dropbox 连接");

		new Setting(containerEl)
			.setName("App key")
			.setDesc("在 Dropbox App Console 建好 App 后把 App key 填到这里（不需要 App secret，我们走 PKCE）")
			.addText((text) =>
				text
					.setPlaceholder("例如 a1b2c3d4e5f6")
					.setValue(this.api.settings.dropbox.appKey)
					.onChange(async (value) => {
						this.api.settings.dropbox.appKey = value.trim();
						await this.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("授权模式")
			.setDesc("callback：本地起一次 http 回调自动收授权码（需在 App Console 登记 redirect_uri）；manual：不传 redirect_uri，手动粘贴 Dropbox 显示的授权码")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("callback", "本地回调（推荐）")
					.addOption("manual", "手动粘贴授权码")
					.setValue(this.api.settings.authMode)
					.onChange(async (value) => {
						this.api.settings.authMode = value === "manual" ? "manual" : "callback";
						await this.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("回调端口")
			.setDesc("仅 callback 模式使用；必须与 App Console 登记的 redirect_uri 端口一致")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.api.settings.redirectPort)).onChange(async (value) => {
					const port = Number.parseInt(value, 10);
					if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
					this.api.settings.redirectPort = port;
					await this.applySettings();
				});
			});

		new Setting(containerEl)
			.setName("远端根目录")
			.setDesc("形如 /Obsidian-Config-Backup；实际路径会在它下面按 vault 名再建一层子目录")
			.addText((text) =>
				text
					.setPlaceholder("/Obsidian-Config-Backup")
					.setValue(this.api.settings.remoteBaseDir)
					.onChange(async (value) => {
						this.api.settings.remoteBaseDir = normalizeRemoteDir(value);
						await this.applySettings();
					}),
			);

		const accountEl = containerEl.createDiv({ cls: "config-sync-account" });
		void this.refreshAccount(accountEl);

		new Setting(containerEl)
			.setName("账户与配额")
			.setDesc("连接状态、账户名与 Dropbox 剩余空间")
			.addButton((button) =>
				button
					.setButtonText("连接")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.api.connectDropbox();
							new Notice("Dropbox 已连接");
						} catch (err) {
							new Notice(`连接失败：${errText(err)}`, 10000);
						} finally {
							button.setDisabled(false);
							this.display();
						}
					}),
			)
			.addButton((button) =>
				button.setButtonText("测试连接").onClick(async () => {
					button.setDisabled(true);
					try {
						const info = await this.api.testConnection();
						new Notice(`连接正常：${info.name} <${info.email}>`);
						await this.refreshAccount(accountEl);
					} catch (err) {
						new Notice(`连接失败：${errText(err)}`, 10000);
					} finally {
						button.setDisabled(false);
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("断开")
					.setWarning()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.api.disconnectDropbox();
							new Notice("已断开 Dropbox");
						} catch (err) {
							new Notice(`断开失败：${errText(err)}`, 8000);
						} finally {
							button.setDisabled(false);
							this.display();
						}
					}),
			);
	}

	private async refreshAccount(accountEl: HTMLElement): Promise<void> {
		const tokens = this.api.settings.dropbox;
		if (!tokens.accessToken && !tokens.refreshToken) {
			accountEl.setText("账户：未连接");
			return;
		}
		accountEl.setText("账户：读取中…");
		try {
			const info = await this.api.testConnection();
			const usage = await this.api.getClient().getSpaceUsage();
			accountEl.setText(`账户：${info.name} <${info.email}>　配额：${formatSpaceUsage(usage.used, usage.allocated)}`);
		} catch (err) {
			accountEl.setText(`账户：读取失败（${errText(err)}）`);
		}
	}

	/* ============================ 2. 同步范围 ============================ */

	private renderScopeSection(containerEl: HTMLElement): void {
		this.heading(containerEl, "同步范围");

		let hintEl: HTMLElement | null = null;
		const setHint = (text: string): void => {
			if (hintEl) hintEl.setText(text);
		};

		new Setting(containerEl)
			.setName("白名单（include）")
			.setDesc("每行一条 gitignore 风格模式；留空 = 全部纳入，再减去黑名单")
			.addTextArea((area) =>
				area
					.setPlaceholder("留空 = 全部")
					.setValue(this.api.settings.includePatterns.join("\n"))
					.onChange(async (value) => {
						this.api.settings.includePatterns = splitLines(value);
						setHint(formatScopeSummary(this.api.settings));
						await this.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("黑名单（exclude）")
			.setDesc("每行一条 gitignore 风格模式；目录结尾带 '/' 只匹配目录，例如 icons/")
			.addTextArea((area) =>
				area
					.setPlaceholder("例如 .git/")
					.setValue(this.api.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.api.settings.excludePatterns = splitLines(value);
						setHint(formatScopeSummary(this.api.settings));
						await this.applySettings();
					}),
			);

		hintEl = containerEl.createDiv({ cls: "config-sync-scope-hint" });
		setHint(formatScopeSummary(this.api.settings));

		const previewEl = containerEl.createDiv({ cls: "config-sync-scope-hint" });
		previewEl.setText("点「计算当前范围」会真实扫描一次本地 .obsidian 并比对远端（只读，不写任何东西）");

		new Setting(containerEl)
			.setName("范围预览 / 重置")
			.setDesc("「计算当前范围」等于一次 dryRun；「重置为默认规则」恢复本插件实测过的默认排除项")
			.addButton((button) =>
				button.setButtonText("计算当前范围").onClick(async () => {
					button.setDisabled(true);
					previewEl.setText("正在扫描…");
					try {
						const result = await this.api.engine.plan();
						previewEl.setText(
							`会同步：上传 ${formatCount(result.plan.toUpload.length)} 个 / 待删除 ${formatCount(result.plan.toDelete.length)} 个 / 无变化 ${formatCount(result.plan.unchanged)} 个 / 被排除 ${formatCount(result.plan.excluded)} 个；` +
								`本地扫描 ${formatCount(result.scan.files.length)} 个文件 ${formatBytes(result.scan.totalBytes)}，用时 ${formatDuration(result.scan.durationMs)}`,
						);
					} catch (err) {
						previewEl.setText(`计算失败：${errText(err)}`);
					} finally {
						button.setDisabled(false);
					}
				}),
			)
			.addButton((button) =>
				button.setButtonText("重置为默认规则").onClick(async () => {
					this.api.settings.includePatterns = [...DEFAULT_INCLUDES];
					this.api.settings.excludePatterns = [...DEFAULT_EXCLUDES];
					await this.applySettings();
					this.display();
				}),
			);
	}

	/* ============================ 3. 触发 ============================ */

	private renderTriggerSection(containerEl: HTMLElement): void {
		this.heading(containerEl, "触发");

		new Setting(containerEl)
			.setName("文件变更时自动同步")
			.setDesc("监听 .obsidian 的改动，静默一段时间后自动跑一轮")
			.addToggle((toggle) =>
				toggle.setValue(this.api.settings.syncOnChange).onChange(async (value) => {
					this.api.settings.syncOnChange = value;
					await this.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("变更防抖")
			.setDesc("连续改动静默多少秒后才真正开始同步")
			.addSlider((slider) =>
				slider
					.setLimits(5, 600, 5)
					.setDynamicTooltip()
					.setValue(this.api.settings.changeDebounceSec)
					.onChange(async (value) => {
						this.api.settings.changeDebounceSec = value;
						await this.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("定时同步间隔（分钟）")
			.setDesc(`0 = 关闭；当前：${formatInterval(this.api.settings.intervalMinutes)}`)
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.api.settings.intervalMinutes)).onChange(async (value) => {
					const minutes = Number.parseInt(value, 10);
					if (!Number.isInteger(minutes) || minutes < 0) return;
					this.api.settings.intervalMinutes = minutes;
					await this.applySettings();
				});
			});

		new Setting(containerEl)
			.setName("启动后延迟（秒）")
			.setDesc("Obsidian 启动后等多久再跑第一轮，避开启动高峰；0 = 立刻")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.api.settings.startupDelaySec)).onChange(async (value) => {
					const seconds = Number.parseFloat(value);
					if (!Number.isFinite(seconds) || seconds < 0) return;
					this.api.settings.startupDelaySec = seconds;
					await this.applySettings();
				});
			});
	}

	/* ============================ 4. 快照 ============================ */

	private renderSnapshotSection(containerEl: HTMLElement): void {
		this.heading(containerEl, "快照");

		new Setting(containerEl)
			.setName("启用快照")
			.setDesc("把整个 .obsidian 打成 zip 上传，作为强一致的回滚点")
			.addToggle((toggle) =>
				toggle.setValue(this.api.settings.snapshotEnabled).onChange(async (value) => {
					this.api.settings.snapshotEnabled = value;
					await this.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("快照频率")
			.setDesc("每轮一份 = 每次同步都打；每天一份 = 一天最多一份")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("every-run", "每轮一份")
					.addOption("daily", "每天一份")
					.setValue(this.api.settings.snapshotMode)
					.onChange(async (value) => {
						this.api.settings.snapshotMode = value === "every-run" ? "every-run" : "daily";
						await this.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("保留份数")
			.setDesc("远端只保留最近 N 份快照，超出的自动轮转删除")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.api.settings.snapshotKeep)).onChange(async (value) => {
					const keep = Number.parseInt(value, 10);
					if (!Number.isInteger(keep) || keep < 1) return;
					this.api.settings.snapshotKeep = keep;
					await this.applySettings();
				});
			});
	}

	/* ============================ 5. 备份与还原 ============================ */

	private renderActionsSection(containerEl: HTMLElement): void {
		this.heading(containerEl, "备份与还原");

		const resultEl = containerEl.createDiv({ cls: "config-sync-action-result" });
		resultEl.setText("尚未执行操作");
		const showResult = (lines: string[]): void => {
			resultEl.empty();
			for (const line of lines) resultEl.createDiv({ text: line });
		};

		new Setting(containerEl)
			.setName("立即备份")
			.setDesc(this.snapshotDesc())
			.addButton((button) =>
				button
					.setButtonText("立即备份")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						resultEl.setText("正在同步…");
						try {
							const result = await this.api.runSync("manual");
							showResult([
								`结果：${formatSyncSummary(result)}`,
								`开始：${formatIsoClock(result.startedAt)}　结束：${formatIsoClock(result.finishedAt)}`,
								result.snapshotPath ? `快照：${result.snapshotPath}` : "快照：本轮未生成",
								...result.errors.slice(0, 5).map((item) => `失败：${item.relPath} —— ${item.message}`),
							]);
							if (result.errors.length > 0) new Notice(`同步完成，但有 ${result.errors.length} 个文件失败`, 8000);
							else new Notice("配置备份完成");
						} catch (err) {
							showResult([`同步失败：${errText(err)}`]);
							new Notice(`同步失败：${errText(err)}`, 10000);
						} finally {
							button.setDisabled(false);
						}
					}),
			);

		new Setting(containerEl)
			.setName("预览差异")
			.setDesc("只读：列出这轮会传哪些、会删哪些，不做任何写入")
			.addButton((button) =>
				button.setButtonText("预览差异").onClick(async () => {
					button.setDisabled(true);
					resultEl.setText("正在扫描本地并比对远端…");
					try {
						const result = await this.api.engine.plan();
						showResult([
							`需要上传：${formatCount(result.plan.toUpload.length)} 个文件`,
							`需要删除：${formatCount(result.plan.toDelete.length)} 个远端文件`,
							`无变化跳过：${formatCount(result.plan.unchanged)} 个`,
							`被规则排除：${formatCount(result.plan.excluded)} 个`,
							`超过大小上限跳过：${formatCount(result.scan.skippedBig)} 个`,
							`远端已有文件：${formatCount(result.remote.length)} 个`,
							`扫描：${formatCount(result.scan.files.length)} 个文件 / ${formatBytes(result.scan.totalBytes)}，用时 ${formatDuration(result.scan.durationMs)}`,
						]);
					} catch (err) {
						showResult([`预览失败：${errText(err)}`]);
					} finally {
						button.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl)
			.setName("立即生成快照")
			.setDesc("立刻跑一轮同步；本轮是否生成快照由上面的「快照」设置决定")
			.addButton((button) =>
				button.setButtonText("立即生成快照").onClick(async () => {
					button.setDisabled(true);
					resultEl.setText("正在同步并处理快照…");
					try {
						const result = await this.api.runSync("manual");
						showResult([
							result.snapshotPath ? `已生成快照：${result.snapshotPath}` : "本轮没有生成快照（开关关闭，或 daily 模式今天已生成过）",
							`同步结果：${formatSyncSummary(result)}`,
						]);
						new Notice(result.snapshotPath ? "快照已生成" : "本轮没有生成快照");
					} catch (err) {
						showResult([`生成快照失败：${errText(err)}`]);
						new Notice(`生成快照失败：${errText(err)}`, 10000);
					} finally {
						button.setDisabled(false);
					}
				}),
			);

		let includeDelete = false;
		new Setting(containerEl)
			.setName("还原时删除本地多出的文件")
			.setDesc("默认关闭：只把远端缺失的文件写回来，本地独有的文件原样保留")
			.addToggle((toggle) =>
				toggle.setTooltip("危险操作，建议保持关闭").setValue(false).onChange((value) => {
					includeDelete = value;
				}),
			);

		new Setting(containerEl)
			.setName("还原")
			.setDesc("从远端镜像还原 .obsidian；还原前一定会先给当前配置打一份留底 zip")
			.addButton((button) =>
				button.setButtonText("预览还原").onClick(async () => {
					const restore = this.api.getRestoreManager();
					if (!restore) {
						new Notice("当前环境不支持还原（仅桌面端可用）");
						return;
					}
					button.setDisabled(true);
					resultEl.setText("正在生成还原计划…");
					try {
						const plan = await restore.preview({ kind: "mirror" });
						showResult([
							`来源：${plan.sourceLabel}`,
							`要写回：${formatCount(plan.toWrite.length)} 个文件（${formatBytes(plan.bytesToDownload)}）`,
							`本地独有（${formatCount(plan.toDelete.length)} 个）默认不动`,
							`两侧一致跳过：${formatCount(plan.unchanged)} 个`,
							`被排除规则挡掉：${formatCount(plan.skippedByRules)} 个`,
						]);
					} catch (err) {
						showResult([`预览失败：${errText(err)}`]);
					} finally {
						button.setDisabled(false);
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("开始还原")
					.setWarning()
					.onClick(async () => {
						const restore = this.api.getRestoreManager();
						if (!restore) {
							new Notice("当前环境不支持还原（仅桌面端可用）");
							return;
						}
						button.setDisabled(true);
						resultEl.setText("正在生成还原计划…");
						try {
							const plan = await restore.preview({ kind: "mirror" });
							const outcome = await restore.apply(plan, {
								includeDelete,
								confirm: async (confirmed) => {
									if (!this.api.settings.confirmBeforeRestore) return true;
									return new ConfirmModal(this.app, "确认还原 .obsidian 配置", [
										`来源：${confirmed.sourceLabel}`,
										`会写回 ${formatCount(confirmed.toWrite.length)} 个文件（${formatBytes(confirmed.bytesToDownload)}）`,
										includeDelete
											? `会删除 ${formatCount(confirmed.toDelete.length)} 个本地独有文件`
											: "不会删除任何本地独有文件",
										"还原前会自动在安全目录生成一份留底 zip。",
									]).ask();
								},
							});
							showResult([
								`已写回：${formatCount(outcome.written)} 个文件`,
								`已删除：${formatCount(outcome.deleted)} 个文件`,
								`留底 zip：${outcome.safetyZip || "（未生成）"}`,
								...outcome.errors.slice(0, 5).map((item) => `失败：${item.relPath} —— ${item.message}`),
							]);
							new Notice(outcome.errors.length > 0 ? `还原完成，但有 ${outcome.errors.length} 个文件失败` : "还原完成", 8000);
						} catch (err) {
							showResult([`还原失败：${errText(err)}`]);
							new Notice(`还原失败：${errText(err)}`, 10000);
						} finally {
							button.setDisabled(false);
						}
					}),
			);
	}

	/** 立即备份那一行的说明，顺带把当前快照策略写出来。 */
	private snapshotDesc(): string {
		const settings = this.api.settings;
		if (!settings.snapshotEnabled) return "上传本地改动到远端（快照已关闭）";
		const mode = settings.snapshotMode === "daily" ? "每天最多一份" : "每轮一份";
		return `上传本地改动到远端，并按设置生成快照（${mode}，保留 ${settings.snapshotKeep} 份）`;
	}

	/* ============================ 6. 日志 ============================ */

	private renderLogSection(containerEl: HTMLElement): void {
		this.heading(containerEl, "日志");

		new Setting(containerEl)
			.setName("日志级别")
			.setDesc("quiet 只保留错误；info 常规；debug 最啰嗦（排查上传问题时用）")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("quiet", "quiet（只留错误）")
					.addOption("info", "info（常规）")
					.addOption("debug", "debug（详细）")
					.setValue(this.api.settings.logLevel)
					.onChange(async (value) => {
						this.api.settings.logLevel = value === "quiet" ? "quiet" : value === "debug" ? "debug" : "info";
						await this.applySettings();
					}),
			);

		const logEl = containerEl.createEl("textarea", { cls: "config-sync-log" });
		logEl.readOnly = true;
		logEl.rows = 14;
		const readLog = (): string => this.api.getLog().slice(-500).join("\n");
		logEl.value = readLog();

		new Setting(containerEl)
			.setName("日志操作")
			.setDesc("面板里保留最近 500 行")
			.addButton((button) =>
				button.setButtonText("刷新").onClick(() => {
					logEl.value = readLog();
					logEl.scrollTop = logEl.scrollHeight;
				}),
			)
			.addButton((button) =>
				button.setButtonText("复制").onClick(async () => {
					try {
						await navigator.clipboard.writeText(logEl.value);
						new Notice("日志已复制到剪贴板");
					} catch (err) {
						new Notice(`复制失败：${errText(err)}；可以直接全选文本框手动复制`, 8000);
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("清空")
					.setWarning()
					.onClick(() => {
						this.api.clearLog?.();
						logEl.value = readLog();
					}),
			);
	}
}
