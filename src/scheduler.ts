/**
 * 定时同步：固定间隔 + 启动后延迟首次。intervalMinutes = 0 表示关闭。
 *
 * 生命周期：
 *   start()  → 排一个「启动延迟」一次性计时器，再排一个「固定间隔」周期计时器
 *   update() → 只重建周期计时器（改间隔 / 关掉定时不该重跑启动同步）
 *   stop()   → 全部拆掉，nextFireAt() 变回 null
 */
export interface SchedulerOptions {
	intervalMinutes: number;
	startupDelaySec: number;
	onTick: (reason: "interval" | "startup") => void;
	/**
	 * 注入点：仅测试用。给了就用它当定时间隔（毫秒），忽略 intervalMinutes。
	 */
	intervalMs?: number;
}

/** 让计时器不阻止 node 进程退出（浏览器环境没有 unref，忽略即可）。 */
function unrefIfPossible(handle: unknown): void {
	if (handle === null || typeof handle !== "object") return;
	const maybe = handle as { unref?: unknown };
	if (typeof maybe.unref === "function") (maybe.unref as () => void).call(handle);
}

export class Scheduler {
	private intervalMinutes: number;
	private startupDelaySec: number;
	private onTick: (reason: "interval" | "startup") => void;
	private intervalMs: number | undefined;

	private running = false;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;
	private startupAt: number | null = null;
	private intervalTimer: ReturnType<typeof setInterval> | null = null;
	private intervalNextAt: number | null = null;

	constructor(opts: SchedulerOptions) {
		this.intervalMinutes = opts.intervalMinutes;
		this.startupDelaySec = opts.startupDelaySec;
		this.onTick = opts.onTick;
		this.intervalMs = opts.intervalMs;
	}

	start(): void {
		if (this.running) return; // 幂等
		this.running = true;
		const delayMs = Math.max(0, this.startupDelaySec) * 1000;
		this.startupAt = Date.now() + delayMs;
		// 注意：即使延迟为 0 也走 setTimeout，保证 start() 内不同步回调
		this.startupTimer = setTimeout(() => {
			this.startupTimer = null;
			this.startupAt = null;
			this.fire("startup");
		}, delayMs);
		unrefIfPossible(this.startupTimer);
		this.armInterval();
	}

	stop(): void {
		this.clearStartup();
		this.clearInterval();
		this.running = false;
	}

	/** 改设置后重启计时；0 分钟则停掉 */
	update(opts: Partial<SchedulerOptions>): void {
		if (opts.intervalMinutes !== undefined) this.intervalMinutes = opts.intervalMinutes;
		if (opts.startupDelaySec !== undefined) this.startupDelaySec = opts.startupDelaySec;
		if (opts.onTick !== undefined) this.onTick = opts.onTick;
		if ("intervalMs" in opts) this.intervalMs = opts.intervalMs;
		if (!this.running) return;
		// 只重建周期计时器；启动延迟计时器保持不动（改间隔不该重跑启动同步）。
		// 没显式传 intervalMs 时保留原注入值（注入只有测试会用到）。
		this.clearInterval();
		this.armInterval();
	}

	/** 下次触发的毫秒时间戳；关闭时为 null */
	nextFireAt(): number | null {
		const candidates: number[] = [];
		if (this.startupAt !== null) candidates.push(this.startupAt);
		if (this.intervalNextAt !== null) candidates.push(this.intervalNextAt);
		if (candidates.length === 0) return null;
		return Math.min(...candidates);
	}

	/** 周期毫秒数；<= 0 / NaN 表示不做周期触发 */
	private period(): number {
		if (this.intervalMs !== undefined) return this.intervalMs;
		return this.intervalMinutes * 60_000;
	}

	private armInterval(): void {
		const period = this.period();
		if (!(period > 0)) return;
		this.intervalNextAt = Date.now() + period;
		this.intervalTimer = setInterval(() => {
			this.intervalNextAt = Date.now() + period;
			this.fire("interval");
		}, period);
		unrefIfPossible(this.intervalTimer);
	}

	private clearStartup(): void {
		if (this.startupTimer !== null) {
			clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}
		this.startupAt = null;
	}

	private clearInterval(): void {
		if (this.intervalTimer !== null) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		this.intervalNextAt = null;
	}

	private fire(reason: "interval" | "startup"): void {
		if (!this.running) return;
		try {
			this.onTick(reason);
		} catch {
			/* 回调抛错不能打断计时循环 */
		}
	}
}
