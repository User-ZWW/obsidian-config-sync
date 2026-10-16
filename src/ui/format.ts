/**
 * UI 展示用的纯函数工具。
 *
 * ★ 约束：本文件不许 import "obsidian"、不许碰 fs —— 因为它是 `test/watch.test.mjs`
 *   用 `node --test` 直接跑的被测对象。它只依赖 `src/types.ts` 里的类型。
 *   `src/ui/status.ts` 与 `src/ui/settings-tab.ts` 用它格式化所有用户可见文案，
 *   这样格式化逻辑本身能被真实测试覆盖（那两个文件 import 了 obsidian，测不了）。
 */
import type { PluginSettings, SyncRunResult, TriggerKind } from "../types.ts";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 人类可读的字节数。B 不带小数，其余单位保留 1 位；非法值 / 负数一律当成 0。
 * 例：0 → "0 B"，1024 → "1.0 KB"，344 MiB → "344.0 MB"。
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** 耗时。小于 1 秒用毫秒，小于 1 分钟用秒，再往上用分/时。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
	const totalSec = Math.round(ms / 1000);
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
}

/** 本地时区的 'YYYY-MM-DD HH:MM:SS'；时间戳非法返回 '—'。 */
export function formatClock(timestampMs: number): string {
	if (!Number.isFinite(timestampMs)) return "—";
	const d = new Date(timestampMs);
	if (Number.isNaN(d.getTime())) return "—";
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 本地时区的 'YYYY-MM-DD HH:MM'（去掉秒）。 */
export function formatClockMinutes(timestampMs: number): string {
	const full = formatClock(timestampMs);
	return full === "—" ? full : full.slice(0, 16);
}

/** ISO 字符串 → 本地 'YYYY-MM-DD HH:MM'；空值 / 非法字符串返回 '—'。 */
export function formatIsoClock(iso: string | null | undefined): string {
	if (!iso) return "—";
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? "—" : formatClockMinutes(parsed);
}

/** 相对时间：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前；超过一周直接给日期。 */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number = Date.now()): string {
	if (!iso) return "从未";
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) return "从未";
	const diff = nowMs - parsed;
	if (diff < 10_000) return "刚刚"; // 含时间戳在未来（时钟漂移）的情况
	if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return formatClockMinutes(parsed);
}

const TRIGGER_LABELS: Record<TriggerKind, string> = {
	manual: "手动",
	interval: "定时",
	watch: "文件变更",
	startup: "启动",
};

/** 触发来源的中文名。 */
export function formatTrigger(kind: TriggerKind): string {
	const label: string | undefined = TRIGGER_LABELS[kind];
	return label ?? kind;
}

/** 千分位整数；非法值当 0。例：1234567 → "1,234,567"。 */
export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const rounded = Math.trunc(n);
	return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 百分比（已四舍五入并夹到 0~100）；total <= 0 时返回 '0%'。 */
export function formatPercent(done: number, total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0%";
	const pct = Math.max(0, Math.min(100, (done / total) * 100));
	return `${Math.round(pct)}%`;
}

/** '上传 3/10（30%）'；总量未知时只给阶段名。 */
export function formatProgress(phase: string, done: number, total: number): string {
	if (!Number.isFinite(total) || total <= 0) return phase;
	return `${phase} ${formatCount(done)}/${formatCount(total)}（${formatPercent(done, total)}）`;
}

/** 定时间隔的中文描述；0 / 非法 = 关闭。 */
export function formatInterval(minutes: number): string {
	if (!Number.isFinite(minutes) || minutes <= 0) return "关闭";
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** '2.0 GB / 8.0 GB（已用 25%）'；配额未知时只给已用量。 */
export function formatSpaceUsage(used: number, allocated: number): string {
	if (!Number.isFinite(allocated) || allocated <= 0) return formatBytes(used);
	return `${formatBytes(used)} / ${formatBytes(allocated)}（已用 ${formatPercent(used, allocated)}）`;
}

/** 同步范围设置的一行摘要。 */
export function formatScopeSummary(settings: PluginSettings): string {
	const includeCount = settings.includePatterns.length;
	const includeText = includeCount === 0 ? "白名单为空（全部纳入）" : `白名单 ${includeCount} 条`;
	return `${includeText}，黑名单 ${settings.excludePatterns.length} 条`;
}

/** 一轮同步结果的一行摘要，直接给状态栏 / 通知用。 */
export function formatSyncSummary(result: SyncRunResult): string {
	const parts: string[] = [formatTrigger(result.trigger)];
	if (result.dryRun) parts.push("预演");
	const bytes = result.bytesUploaded > 0 ? `（${formatBytes(result.bytesUploaded)}）` : "";
	parts.push(`上传 ${formatCount(result.uploaded)}${bytes}`);
	if (result.deleted > 0) parts.push(`删除 ${formatCount(result.deleted)}`);
	parts.push(`跳过 ${formatCount(result.skipped)}`);
	if (result.errors.length > 0) parts.push(`失败 ${formatCount(result.errors.length)}`);
	if (result.snapshotPath) parts.push("已生成快照");
	const started = Date.parse(result.startedAt);
	const finished = Date.parse(result.finishedAt);
	if (!Number.isNaN(started) && !Number.isNaN(finished)) parts.push(`用时 ${formatDuration(finished - started)}`);
	return parts.join(" · ");
}

/** 截断到 maxChars 个字符（含省略号）。 */
export function truncate(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
	return `${text.slice(0, maxChars - 1)}…`;
}

/** 保留头尾、中间省略，适合长路径。例：'abcdefghij'(7) → 'abc…hij'。 */
export function truncateMiddle(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return `${text.slice(0, 1)}…`;
	const head = Math.ceil((maxChars - 1) / 2);
	const tail = Math.floor((maxChars - 1) / 2);
	return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
