import { Plugin } from "obsidian";

/**
 * 主插件类。★ 由主 agent 在 Phase 3 完成装配，子 agent 不要改这个文件。
 * 现在只是个能编译的骨架，让 Phase 1 的构建/测试命令先跑通。
 */
export default class ConfigSyncPlugin extends Plugin {
	async onload(): Promise<void> {
		// Phase 3 装配：SettingsStore / RingLogger / DropboxClient / SyncEngine /
		// ConfigWatcher / Scheduler / StatusIndicator / ConfigSyncSettingTab /
		// RestoreManager 以及全部命令与 ribbon。
	}

	async onunload(): Promise<void> {
		// Phase 3：停掉 watcher / scheduler / 状态栏。
	}
}
