/**
 * 默认设置与默认同步范围规则。本文件不依赖 obsidian，可在 node 测试里直接引用。
 *
 * ★ 冻结契约：不得修改已有导出名与字段名，只能追加。
 */

import type { PluginSettings } from "../types.ts";

/**
 * 默认排除规则（gitignore 风格子集）。
 * 支持：`*` 匹配单段内任意字符；`**` 匹配任意层级；`?` 匹配单字符；结尾 `/` 表示只匹配目录。
 * 不支持 `!` 取反 —— 需要什么就直接往 includePatterns 里加。
 *
 * 默认值有实测依据：本机 .obsidian 共 786,622,940 字节，其中
 *   .git/ = 214M、icons/ = 91M、plugins/插件备份* = 144M  —— 这三项共 442,577,814 字节
 * 排除后目标载荷约 344 MB。
 */
export const DEFAULT_EXCLUDES: string[] = [
	// —— 体积大户，且都可重新获得 ——
	".git/",
	"icons/",
	"plugins/插件备份*/",
	"plugins/*/插件备份*/",
	// —— 会话态 / 每次开窗都在变，纳入同步只会制造噪声 ——
	"workspace.json",
	"workspace*.json",
	"workspace-mobile.json",
	"graph.json",
	// —— 高频变动的插件运行时数据（沿用 vault 根 .gitignore 的既有约定）——
	"plugins/focus-time/data/",
	"plugins/focus-time/data.json",
	"plugins/update-time-on-edit/data.json",
	"plugins/obsidian-git/*.json",
	// —— 杂项 ——
	"**/.DS_Store",
	"**/Thumbs.db",
	"**/*.tmp",
	"**/*.crswap",
	// 还原前安全留底目录（默认落在 vault 根，不在 configDir 内，这里保险起见也排掉）
	"**/.obsidian-safety-snapshots/",
];

/** 默认白名单为空 = 全部纳入（再减掉 excludePatterns） */
export const DEFAULT_INCLUDES: string[] = [];

export const DEFAULT_SETTINGS: PluginSettings = {
	dropbox: {
		appKey: "",
		appSecret: "",
		accessToken: undefined,
		refreshToken: undefined,
		expiresAt: undefined,
		accountId: undefined,
		accountName: undefined,
		email: undefined,
	},
	remoteBaseDir: "/Obsidian-Config-Backup",
	redirectPort: 53682,
	authMode: "callback",

	includePatterns: [...DEFAULT_INCLUDES],
	excludePatterns: [...DEFAULT_EXCLUDES],

	mirrorDelete: true,
	useHash: false,
	concurrency: 3,
	maxFileSizeMB: 150,

	syncOnChange: true,
	changeDebounceSec: 60,
	intervalMinutes: 0,
	startupDelaySec: 45,

	snapshotEnabled: true,
	snapshotMode: "daily",
	snapshotKeep: 7,

	safetyDir: "",
	confirmBeforeRestore: true,

	logLevel: "info",
	lastResultSummary: undefined,
};
