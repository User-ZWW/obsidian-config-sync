/**
 * 定时同步：固定间隔 + 启动后延迟首次。intervalMinutes = 0 表示关闭。
 */
export interface SchedulerOptions {
	intervalMinutes: number;
	startupDelaySec: number;
	onTick: (reason: "interval" | "startup") => void;
}

export class Scheduler {
	constructor(opts: SchedulerOptions) {
		throw new Error("not implemented: Scheduler");
	}

	start(): void {
		throw new Error("not implemented: start");
	}

	stop(): void {
		throw new Error("not implemented: stop");
	}

	/** 改设置后重启计时；0 分钟则停掉 */
	update(opts: Partial<SchedulerOptions>): void {
		throw new Error("not implemented: update");
	}

	/** 下次触发的毫秒时间戳；关闭时为 null */
	nextFireAt(): number | null {
		throw new Error("not implemented: nextFireAt");
	}
}
