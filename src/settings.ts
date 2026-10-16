import type { PluginSettings } from "./types.ts";
import { DEFAULT_SETTINGS } from "./config/defaults.ts";

/** 抽象出 Obsidian 的 loadData / saveData，便于测试 */
export interface DataAdapter {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 把磁盘上读到的数据与默认值深合并。
 * 数组整体替换（不逐项合并）—— 因为排除规则列表用户会整段编辑。
 * 缺字段补默认，多的字段保留（向前兼容）。
 */
export function mergeSettings(raw: unknown): PluginSettings {
	return deepMerge(structuredClone(DEFAULT_SETTINGS), raw) as PluginSettings;
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(patch)) return base;
	if (!isPlainObject(base)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		const b = out[k];
		out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
	}
	return out as T;
}

export class SettingsStore {
	settings: PluginSettings;
	private adapter: DataAdapter;

	constructor(adapter: DataAdapter) {
		this.adapter = adapter;
		this.settings = structuredClone(DEFAULT_SETTINGS);
	}

	async load(): Promise<PluginSettings> {
		const raw = await this.adapter.loadData();
		this.settings = mergeSettings(raw);
		return this.settings;
	}

	async save(): Promise<void> {
		await this.adapter.saveData(this.settings);
	}

	async update(patch: Partial<PluginSettings>): Promise<void> {
		this.settings = deepMerge(this.settings, patch);
		await this.save();
	}

	/** 把 .dropbox 子树整体替换（断开连接时会用） */
	async replaceDropbox(dropbox: PluginSettings["dropbox"]): Promise<void> {
		this.settings.dropbox = { ...dropbox };
		await this.save();
	}
}
