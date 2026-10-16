import { Modal, Notice, Plugin, Setting, type TextComponent } from "obsidian";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { DEFAULT_SETTINGS } from "./config/defaults.ts";
import { createObsidianHttpClient } from "./http/obsidian.ts";
import { RingLogger } from "./logger.ts";
import { compileMatcher } from "./scan/exclude.ts";
import { SettingsStore, type DataAdapter } from "./settings.ts";
import { DropboxClient } from "./dropbox/client.ts";
import {
	buildAuthorizeUrl,
	createPkcePair,
	exchangeCodeForTokens,
	startLocalCallbackServer,
} from "./dropbox/oauth.ts";
import { emptyIndex, parseIndex } from "./sync/index-store.ts";
import { SyncEngine } from "./sync/engine.ts";
import { SnapshotManager } from "./snapshot/manager.ts";
import { RestoreManager } from "./restore.ts";
import { ConfigWatcher } from "./watch/watcher.ts";
import { Scheduler } from "./scheduler.ts";
import { StatusIndicator } from "./ui/status.ts";
import { ConfigSyncSettingTab } from "./ui/settings-tab.ts";
import type { ConfigSyncPluginApi } from "./plugin-api.ts";
import type {
	DropboxAccountInfo,
	PluginSettings,
	SyncIndex,
	SyncRunResult,
	TriggerKind,
} from "./types.ts";

/** 同步索引的文件名，放在插件自己的目录里。★ 必须排除在同步之外，否则会自触发死循环 */
const INDEX_FILENAME = "sync-index.json";
/** 快照 zip 的本地临时目录名 */
const TMP_DIRNAME = "obsidian-config-sync";

export default class ConfigSyncPlugin extends Plugin implements ConfigSyncPluginApi {
	settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
	settingsStore!: SettingsStore;
	logger!: RingLogger;

	private client: DropboxClient | null = null;
	private snapshotManager: SnapshotManager | null = null;
	private restoreManager: RestoreManager | null = null;
	private watcher: ConfigWatcher | null = null;
	private scheduler: Scheduler | null = null;
	private status: StatusIndicator | null = null;

	private index: SyncIndex = emptyIndex();
	private syncing = false;
	/**
	 * 同步引擎懒建。★ 不能在 onload 里就建：构造它需要 Dropbox 凭据，
	 * 而新装插件的人还没配凭据 —— 那样会让 onload 抛错，插件整个加载不起来。
	 */
	private _engine: SyncEngine | null = null;

	async onload(): Promise<void> {
		this.logger = new RingLogger({ level: "info", max: 500, console: false });

		const adapter: DataAdapter = {
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		};
		this.settingsStore = new SettingsStore(adapter);
		await this.settingsStore.load();
		this.settings = this.settingsStore.settings;
		this.logger.setLevel(this.settings.logLevel);
		await this.loadIndex();

		this.logger.info("插件已加载", {
			configDir: this.configDirAbs(),
			remoteRoot: this.remoteRoot(),
			authConfigured: Boolean(this.settings.dropbox.refreshToken),
		});

		this.status = new StatusIndicator(this, this);
		this.status.setIdle(this.settings.lastResultSummary ?? "尚未同步");

		this.addSettingTab(new ConfigSyncSettingTab(this.app, this, this));

		this.registerCommands();
		this.refreshTriggers();

		if (!this.settings.dropbox.appKey) {
			new Notice("配置文件夹云备份：还没填 Dropbox App key，去插件设置里配置一下。", 8000);
		}
	}

	async onunload(): Promise<void> {
		this.watcher?.stop();
		this.scheduler?.stop();
		this.status?.unload();
		await this.persistIndex().catch(() => undefined);
	}

	/* ============================ ConfigSyncPluginApi ============================ */

	configDirAbs(): string {
		return nodePath.join(this.vaultBasePath(), this.app.vault.configDir);
	}

	vaultName(): string {
		return this.app.vault.getName();
	}

	async saveSettings(): Promise<void> {
		this.settings = this.settingsStore.settings;
		await this.settingsStore.save();
		this.logger.setLevel(this.settings.logLevel);
	}

	refreshTriggers(): void {
		this.watcher?.stop();
		this.watcher = null;
		this.scheduler?.stop();
		this.scheduler = null;

		if (this.settings.syncOnChange) {
			const matcher = this.matcher();
			this.watcher = new ConfigWatcher({
				rootDir: this.configDirAbs(),
				isRelevant: (relPath, isDir) => matcher(relPath, isDir),
				debounceMs: Math.max(5, this.settings.changeDebounceSec) * 1000,
				onChange: (relPaths) => {
					this.logger.debug(`检测到 ${relPaths.length} 个变更，触发同步`);
					void this.runSync("watch").catch((e) => this.logger.error("变更触发同步失败", e));
				},
				onError: (err) => this.logger.error("目录监听出错", err),
			});
			this.watcher.start();
		}

		this.scheduler = new Scheduler({
			intervalMinutes: this.settings.intervalMinutes,
			startupDelaySec: this.settings.startupDelaySec,
			onTick: (reason) => {
				void this.runSync(reason === "startup" ? "startup" : "interval").catch((e) =>
					this.logger.error("定时同步失败", e),
				);
			},
		});
		this.scheduler.start();

		this.logger.debug("触发器已按设置重启", {
			watch: this.settings.syncOnChange,
			intervalMinutes: this.settings.intervalMinutes,
		});
	}

	getClient(): DropboxClient {
		if (this.client) return this.client;
		const tokens = this.settings.dropbox;
		if (!tokens.accessToken && !tokens.refreshToken) {
			throw new Error("还没连接 Dropbox，请先在插件设置里点「连接 Dropbox」");
		}
		this.client = new DropboxClient({
			http: createObsidianHttpClient(),
			tokens,
			baseDir: this.remoteRoot(),
			concurrency: this.settings.concurrency,
			logger: this.logger,
			onTokenRefreshed: (t) => {
				this.settings.dropbox = { ...t };
				void this.saveSettings();
			},
		});
		return this.client;
	}

	getRestoreManager(): RestoreManager | null {
		if (this.restoreManager) return this.restoreManager;
		let client: DropboxClient;
		try {
			client = this.getClient();
		} catch {
			return null;
		}
		this.restoreManager = new RestoreManager({
			client,
			configDir: this.configDirAbs(),
			safetyDir: this.safetyDirAbs(),
			matcher: this.matcher(),
			logger: this.logger,
		});
		return this.restoreManager;
	}

	async runSync(trigger: TriggerKind, opts?: { dryRun?: boolean }): Promise<SyncRunResult> {
		if (this.syncing) {
			this.logger.warn("上一轮同步还没结束，忽略本次触发");
			throw new Error("上一轮同步还在进行中");
		}
		this.syncing = true;
		this.status?.setBusy("准备中", 0, 0);
		try {
			const result = await this.engine.run(trigger, opts);
			const summary =
				`${new Date(result.finishedAt).toLocaleString()} 上传 ${result.uploaded} / ` +
				`删除 ${result.deleted} / 错误 ${result.errors.length}`;
			this.settings.lastResultSummary = summary;
			await this.saveSettings();
			if (result.errors.length > 0) this.status?.setError(summary);
			else this.status?.setIdle(`配置备份：${summary}`);
			return result;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.status?.setError(msg);
			throw e;
		} finally {
			this.syncing = false;
		}
	}

	async testConnection(): Promise<DropboxAccountInfo> {
		const info = await this.getClient().getCurrentAccount();
		this.settings.dropbox = {
			...this.settings.dropbox,
			accountId: info.accountId,
			accountName: info.name,
			email: info.email,
		};
		await this.saveSettings();
		return info;
	}

	async connectDropbox(): Promise<void> {
		const appKey = this.settings.dropbox.appKey?.trim();
		if (!appKey) {
			throw new Error("请先填 App key（Dropbox App Console → 你的 App → Settings → App key）");
		}

		const http = createObsidianHttpClient();
		const pkce = createPkcePair();
		const state = randomState();

		let redirectUri: string | undefined;
		let server: Awaited<ReturnType<typeof startLocalCallbackServer>> | null = null;
		if (this.settings.authMode === "callback") {
			try {
				server = await startLocalCallbackServer(this.settings.redirectPort, state);
				redirectUri = server.redirectUri;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(
					`本地回调端口 ${this.settings.redirectPort} 启动失败（${msg}）。` +
						`要么把端口换成空闲的（同时要在 Dropbox App Console 里把 Redirect URI 改成 http://localhost:<端口>/），` +
						`要么把授权模式切成「手动粘贴授权码」。`,
				);
			}
		}

		try {
			const url = buildAuthorizeUrl({ appKey, challenge: pkce.challenge, state, redirectUri });
			this.openExternalUrl(url);

			let code: string;
			if (server) {
				new Notice("已打开浏览器，请在 Dropbox 页面点「允许」，然后回来等我抓授权码。", 10000);
				code = await server.waitForCode(5 * 60 * 1000);
			} else {
				const pasted = await promptForCode(this.app, url);
				if (!pasted) throw new Error("已取消：没有拿到授权码");
				code = pasted.trim();
			}

			const tokens = await exchangeCodeForTokens(http, {
				appKey,
				code,
				verifier: pkce.verifier,
				redirectUri,
			});
			this.settings.dropbox = { ...tokens, appKey };
			await this.saveSettings();
			this.client = null;
			this.restoreManager = null;
			this.invalidateEngine();

			const info = await this.testConnection();
			new Notice(`已连接 Dropbox：${info.name} <${info.email}>`, 6000);
		} finally {
			server?.close();
		}
	}

	async disconnectDropbox(): Promise<void> {
		this.settings.dropbox = {
			...DEFAULT_SETTINGS.dropbox,
			appKey: this.settings.dropbox.appKey,
		};
		await this.saveSettings();
		this.client = null;
		this.restoreManager = null;
		this.logger.info("已断开 Dropbox（App key 保留）");
	}

	appendLog(line: string): void {
		this.logger.info(line);
	}

	getLog(): string[] {
		return this.logger.getLines();
	}

	/** 设置面板「清空日志」按钮用（plugin-api 里是可选成员） */
	clearLog(): void {
		this.logger.clear();
	}

	/** 懒建：第一次真正要用到 Dropbox 时才构造，没配凭据时报可读的错。 */
	get engine(): SyncEngine {
		if (!this._engine) this._engine = this.buildEngine(this.getClient());
		return this._engine;
	}

	/* ============================ 内部装配 ============================ */

	private vaultBasePath(): string {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
		throw new Error("拿不到 vault 的物理路径：这个插件只能在桌面端运行");
	}

	private pluginDirAbs(): string {
		return nodePath.join(this.configDirAbs(), "plugins", this.manifest.id);
	}

	private indexFileAbs(): string {
		return nodePath.join(this.pluginDirAbs(), INDEX_FILENAME);
	}

	private tmpDirAbs(): string {
		return nodePath.join(os.tmpdir(), TMP_DIRNAME);
	}

	safetyDirAbs(): string {
		const configured = this.settings.safetyDir?.trim();
		if (configured) return configured;
		return nodePath.join(this.vaultBasePath(), ".obsidian-safety-snapshots");
	}

	private remoteRoot(): string {
		const base = this.settings.remoteBaseDir?.trim() || "/Obsidian-Config-Backup";
		return nodePath.posix.join(base, this.vaultName());
	}

	/**
	 * 同步范围匹配器 = 用户规则 + 插件自身运行时文件。
	 * 索引文件必须排除，否则「写索引 → 监听触发同步 → 再写索引」会形成死循环。
	 * 注意：本插件自己的 data.json（含 Dropbox 凭据）**故意保留在同步范围内**，
	 * 这样换机器能连设置一起恢复；不接受的用户可以在排除规则里加它。
	 */
	private matcher(): (relPath: string, isDir?: boolean) => boolean {
		const base = compileMatcher({
			includePatterns: this.settings.includePatterns,
			excludePatterns: this.settings.excludePatterns,
		});
		const selfPrefix = `plugins/${this.manifest.id}/`;
		return (relPath, isDir) => {
			if (relPath === INDEX_FILENAME || relPath.endsWith(`/${INDEX_FILENAME}`)) return false;
			if (relPath.startsWith(selfPrefix) && relPath.endsWith(".tmp")) return false;
			return base(relPath, isDir);
		};
	}

	private buildEngine(client: DropboxClient): SyncEngine {
		this.snapshotManager = new SnapshotManager({
			client,
			localRootDir: this.configDirAbs(),
			tmpDir: this.tmpDirAbs(),
			keep: this.settings.snapshotKeep,
			logger: this.logger,
		});
		return new SyncEngine({
			client,
			indexStore: {
				get: () => this.index,
				set: async (next) => {
					this.index = next;
					await this.persistIndex();
				},
			},
			getSettings: () => this.settings,
			configDir: this.configDirAbs(),
			logger: this.logger,
			snapshotManager: this.settings.snapshotEnabled ? this.snapshotManager : undefined,
			onProgress: (phase, done, total) => this.status?.setBusy(phase, done, total),
		});
	}

	/** 凭据或设置变了：丢掉旧引擎与快照器，下次用时会按新设置重建 */
	private invalidateEngine(): void {
		this._engine = null;
		this.snapshotManager = null;
		this.restoreManager = null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: "sync-now",
			name: "立即备份 .obsidian 到 Dropbox",
			callback: () => {
				void this.runSync("manual").catch((e) =>
					new Notice(`备份失败：${errText(e)}`, 8000),
				);
			},
		});

		this.addCommand({
			id: "preview-diff",
			name: "预览差异（不写入任何东西）",
			callback: () => {
				void this.previewDiff();
			},
		});

		this.addCommand({
			id: "snapshot-now",
			name: "立即生成快照 zip",
			callback: () => {
				void this.runSync("manual").catch((e) => new Notice(`生成快照失败：${errText(e)}`, 8000));
			},
		});

		this.addCommand({
			id: "connect-dropbox",
			name: "连接 Dropbox（授权）",
			callback: () => {
				void this.connectDropbox().catch((e) => new Notice(`连接失败：${errText(e)}`, 10000));
			},
		});

		this.addCommand({
			id: "disconnect-dropbox",
			name: "断开 Dropbox",
			callback: () => {
				void this.disconnectDropbox().then(() => new Notice("已断开 Dropbox"));
			},
		});

		this.addCommand({
			id: "restore-preview",
			name: "还原：预览云端与本地差异",
			callback: () => {
				void this.restorePreview();
			},
		});

		this.addCommand({
			id: "restore-apply",
			name: "还原：从云端拉回 .obsidian（防呆）",
			callback: () => {
				void this.doRestore();
			},
		});

		this.addCommand({
			id: "open-settings",
			name: "打开设置",
			callback: () => {
				const app = this.app as unknown as {
					setting?: { open(): void; openTabById(id: string): void };
				};
				app.setting?.open();
				app.setting?.openTabById(this.manifest.id);
			},
		});
	}

	private async previewDiff(): Promise<void> {
		try {
			const p = await this.engine.plan();
			new Notice(
				`待上传 ${p.plan.toUpload.length} 个，待删除 ${p.plan.toDelete.length} 个，` +
					`无变化 ${p.plan.unchanged} 个，已排除 ${p.plan.excluded} 个`,
				12000,
			);
		} catch (e) {
			new Notice(`预览失败：${errText(e)}`, 10000);
		}
	}

	private async restorePreview(): Promise<Awaited<ReturnType<RestoreManager["preview"]>> | null> {
		const rm = this.getRestoreManager();
		if (!rm) {
			new Notice("还没连接 Dropbox，先连接再还原");
			return null;
		}
		try {
			const plan = await rm.preview({ kind: "mirror" });
			new Notice(
				`还原预览：要写回 ${plan.toWrite.length} 个文件、本地多出 ${plan.toDelete.length} 个` +
					`（默认不删）、无变化 ${plan.unchanged} 个、需下载 ` +
					`${(plan.bytesToDownload / 1024 / 1024).toFixed(1)} MB`,
				15000,
			);
			return plan;
		} catch (e) {
			new Notice(`还原预览失败：${errText(e)}`, 10000);
			return null;
		}
	}

	private async doRestore(): Promise<void> {
		const plan = await this.restorePreview();
		if (!plan) return;
		const rm = this.getRestoreManager();
		if (!rm) return;

		let includeDelete = false;
		if (this.settings.confirmBeforeRestore) {
			const answer = await confirmRestore(this.app, plan, this.safetyDirAbs());
			if (!answer.confirmed) {
				new Notice("已取消还原");
				return;
			}
			includeDelete = answer.includeDelete;
		}

		try {
			const res = await rm.apply(plan, { includeDelete, confirm: async () => true });
			const tail = res.errors.length > 0 ? `，有 ${res.errors.length} 个文件失败（见日志）` : "";
			new Notice(
				`还原完成：写入 ${res.written} 个文件${tail}。留底 zip：${res.safetyZip}。建议重启 Obsidian。`,
				15000,
			);
		} catch (e) {
			new Notice(`还原失败：${errText(e)}`, 12000);
		}
	}

	/* ============================ 索引持久化 ============================ */

	private async loadIndex(): Promise<void> {
		try {
			const raw = await fs.promises.readFile(this.indexFileAbs(), "utf8");
			this.index = parseIndex(JSON.parse(raw));
		} catch {
			this.index = emptyIndex();
		}
	}

	private async persistIndex(): Promise<void> {
		const target = this.indexFileAbs();
		await fs.promises.mkdir(nodePath.dirname(target), { recursive: true });
		const tmp = `${target}.tmp`;
		await fs.promises.writeFile(tmp, JSON.stringify(this.index, null, "\t"), "utf8");
		await fs.promises.rename(tmp, target);
	}

	/* ============================ 杂项 ============================ */

	private openExternalUrl(url: string): void {
		try {
			const opened = window.open(url, "_blank");
			if (opened) return;
		} catch {
			/* 落到 electron */
		}
		try {
			const g = globalThis as unknown as {
				require?: (id: string) => { shell?: { openExternal(u: string): void } };
			};
			g.require?.("electron")?.shell?.openExternal(url);
		} catch (e) {
			this.logger.error("无法打开浏览器，请手动复制这个链接", url, e);
		}
	}
}

/* ============================ 小工具 / 弹窗 ============================ */

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function randomState(): string {
	const bytes = new Uint8Array(16);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** manual 模式下让用户把 Dropbox 页面上的授权码粘进来 */
function promptForCode(app: Plugin["app"], url: string): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new CodeModal(app, url, resolve);
		modal.open();
	});
}

class CodeModal extends Modal {
	private authUrl: string;
	private done: (value: string | null) => void;
	private input: TextComponent | null = null;

	constructor(app: Plugin["app"], authUrl: string, done: (value: string | null) => void) {
		super(app);
		this.authUrl = authUrl;
		this.done = done;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "粘贴 Dropbox 授权码" });
		contentEl.createEl("p", {
			text: "浏览器里点完「允许」后会显示一串授权码。如果浏览器没自动打开，手动访问下面这个地址：",
		});
		contentEl.createEl("div", { text: this.authUrl, cls: "config-sync-log" });

		new Setting(contentEl).setName("授权码").addText((t) => {
			this.input = t;
			t.setPlaceholder("把 Dropbox 给的授权码粘到这里");
			t.inputEl.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") this.finish();
			});
		});

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("确定")
					.setCta()
					.onClick(() => this.finish()),
			)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.cancel()));
	}

	private finish(): void {
		const value = this.input?.getValue().trim() ?? "";
		this.done(value.length > 0 ? value : null);
		this.close();
	}

	private cancel(): void {
		this.done(null);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 还原前的二次确认：把将发生的事写清楚，不给「一键直接覆盖」这种路径 */
function confirmRestore(
	app: Plugin["app"],
	plan: Awaited<ReturnType<RestoreManager["preview"]>>,
	safetyDir: string,
): Promise<{ confirmed: boolean; includeDelete: boolean }> {
	return new Promise((resolve) => {
		const modal = new ConfirmRestoreModal(app, plan, safetyDir, resolve);
		modal.open();
	});
}

class ConfirmRestoreModal extends Modal {
	private plan: Awaited<ReturnType<RestoreManager["preview"]>>;
	private safetyDir: string;
	private done: (value: { confirmed: boolean; includeDelete: boolean }) => void;
	private includeDelete = false;

	constructor(
		app: Plugin["app"],
		plan: Awaited<ReturnType<RestoreManager["preview"]>>,
		safetyDir: string,
		done: (value: { confirmed: boolean; includeDelete: boolean }) => void,
	) {
		super(app);
		this.plan = plan;
		this.safetyDir = safetyDir;
		this.done = done;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "确认从云端还原 .obsidian？" });
		contentEl.createEl("p", {
			text:
				`将要写回 ${this.plan.toWrite.length} 个文件，共需下载 ` +
				`${(this.plan.bytesToDownload / 1024 / 1024).toFixed(1)} MB。`,
		});

		for (const w of this.plan.warnings ?? []) {
			contentEl.createEl("p", { text: `⚠️ ${w}`, cls: "config-sync-warn" });
		}

		contentEl.createEl("p", { text: `写入前会先把当前的 .obsidian 打包留底到：${this.safetyDir}` });
		contentEl.createEl("p", {
			text: "注意：Obsidian 正在运行，配置文件和已加载的插件文件可能被占用，个别文件可能写不进去。还原完成后请重启 Obsidian。",
			cls: "config-sync-warn",
		});

		new Setting(contentEl)
			.setName("同时删除本地多出的文件")
			.setDesc(
				`本地有 ${this.plan.toDelete.length} 个文件在云端不存在。默认保留它们（更安全）；` +
					`只有确认这些文件确实该消失时才打开。删掉的东西可以从留底 zip 里找回。`,
			)
			.addToggle((t) =>
				t.setValue(false).onChange((v) => {
					this.includeDelete = v;
				}),
			);

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("确认还原")
					.setWarning()
					.onClick(() => {
						this.done({ confirmed: true, includeDelete: this.includeDelete });
						this.close();
					}),
			)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.cancel()));
	}

	private cancel(): void {
		this.done({ confirmed: false, includeDelete: false });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
