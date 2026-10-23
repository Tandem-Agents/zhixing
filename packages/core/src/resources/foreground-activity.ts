/**
 * 宿主前台活动：用户请求在途、正在进行的运行（派发、模型与工具执行、提交收尾），以及正在向用户推送的进展。
 * 后台维护（例如升级后的会话迁移）据此让路：前台活动期间不推进，前台安静一段时间后再继续；
 * 前台正在等待的那一部分工作由调用方自行判断，不经这里让路。
 */
export interface ForegroundActivityPort {
  /** 开始一段前台工作，返回结束函数（重复调用无副作用）。 */
  enter(): () => void;
  /** 一次瞬时的前台活动，例如向用户推送了一条运行进展。 */
  pulse(): void;
}

/** 前台仍在活动时复查的间隔。 */
const ACTIVE_RECHECK_MS = 50;

export class ForegroundActivity implements ForegroundActivityPort {
  #active = 0;
  #lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = () => performance.now()) {}

  enter(): () => void {
    this.#active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#active--;
      this.#lastAt = this.now();
    };
  }

  pulse(): void {
    this.#lastAt = this.now();
  }

  /** 没有在途的前台工作，且最近一次前台活动已过去至少 quietMs。 */
  quiet(quietMs: number): boolean {
    return this.#active === 0 && this.now() - this.#lastAt >= quietMs;
  }

  /** 等到前台安静；取消时立即返回（不抛出），调用方自行判断是否继续。 */
  async whenQuiet(quietMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted && !this.quiet(quietMs)) {
      const remaining = this.#active > 0 ? ACTIVE_RECHECK_MS : Math.max(1, quietMs - (this.now() - this.#lastAt));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        timer.unref?.();
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}
