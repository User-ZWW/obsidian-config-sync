/**
 * UI 层与主插件类之间的接口。★ 冻结契约。
 *
 * 目的：让 src/ui/** 只依赖这个接口，而不是直接依赖 main.ts，
 * 这样 UI 层拿不到 Plugin 内部字段也能编译，并且日后好测。
 */
import type {
	PluginSettings,
	SyncRunResult,
	TriggerKind,
	DropboxAccountInfo,
	Logger,
} from "./types.ts";
import type { SettingsStore } from "./settings.ts";
import type { SyncEngine } from "./sync/engine.ts";
import type { DropboxClient } from "./dropbox/client.ts";
import type { RestoreManager } from "./restore.ts";

export interface ConfigSyncPluginApi {
	settings: PluginSettings;
	settingsStore: SettingsStore;
	logger: Logger;

	engine: SyncEngine;

	/** vault 的 .obsidian 目录绝对路径 */
	configDirAbs(): string;
	/** 当前 vault 名（用作远端子目录名） */
	vaultName(): string;

	/** 保存设置并让触发器按新设置重启 */
	saveSettings(): Promise<void>;
	/** 重新按当前设置装配 watcher / scheduler */
	refreshTriggers(): void;

	getClient(): DropboxClient;
	/** 没有 RestoreManager（桌面端之外）时为 null */
	getRestoreManager(): RestoreManager | null;

	runSync(trigger: TriggerKind, opts?: { dryRun?: boolean }): Promise<SyncRunResult>;

	/** 走 OAuth PKCE 授权流程（callback 或 manual 模式） */
	connectDropbox(): Promise<void>;
	disconnectDropbox(): Promise<void>;
	testConnection(): Promise<DropboxAccountInfo>;

	/** 设置面板里的实时日志 */
	appendLog(line: string): void;
	getLog(): string[];

	/**
	 * 【Phase 2 / Agent D 追加】清空内存里的日志。
	 * 设置面板的「清空」按钮用；可选 —— 未实现时面板退化为只刷新视图，
	 * 所以 main.ts 不实现它也不会编译不过。
	 */
	clearLog?(): void;
}
