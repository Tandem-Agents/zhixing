/**
 * Scheduler ephemeral run 的中断注册表 —— 与 Scheduler 同包。
 *
 * 职责:为每个 in-flight ephemeral run 持有一个 `AbortController`,允许:
 *   - 外部 RPC `schedule.abortRun(runId, reason)` 主动中断特定 run
 *   - cron / scheduler 自身按 task 配置(deadline / 超时)主动中断
 *   - graceful shutdown 通过 `abortAllAndWait` 让所有 in-flight run 走完 cleanup
 *
 * 设计:与 `ConversationManager` 平行(都是 INV-R5 的"执行单元独占 controller"
 * 实现),server / cli 都从 `@zhixing/core` 引用,无反向依赖。首次引入 scheduler
 * → interrupt 的模块内依赖,合法且无循环(interrupt 不反向引用 scheduler)。
 */

import { abortWithReason } from "../interrupt/index.js";
import type { AbortReason } from "../interrupt/types.js";

export class RunRegistry {
  private runs = new Map<string, AbortController>();
  /**
   * `abortAllAndWait` 的 drain resolver:event-driven 等所有 in-flight 完成
   * (`unregisterRun` 末端检测 runs 清空时 resolve)。null 表示当前无 wait 在挂。
   */
  private drainResolver: (() => void) | null = null;

  /**
   * 注册一个 run,返回该 run 的 abortSignal。caller(`runAgentTurn` finally
   * 块)必须在 run 结束时调 `unregisterRun`,否则 leak。
   */
  registerRun(runId: string): AbortSignal {
    const ctrl = new AbortController();
    this.runs.set(runId, ctrl);
    return ctrl.signal;
  }

  unregisterRun(runId: string): void {
    this.runs.delete(runId);
    if (this.runs.size === 0 && this.drainResolver) {
      const resolve = this.drainResolver;
      this.drainResolver = null;
      resolve();
    }
  }

  /**
   * 触发特定 run 的 abort,带 typed reason。返回 false 表示 runId 不存在或已 aborted
   * (幂等)。
   */
  abortRun(runId: string, reason: AbortReason): boolean {
    const ctrl = this.runs.get(runId);
    if (!ctrl || ctrl.signal.aborted) return false;
    abortWithReason(ctrl, reason);
    return true;
  }

  /**
   * 触发所有 in-flight run 的 abort。返回真正 fire 的数量(已 aborted 的不算)。
   * 与 `ConversationManager.abortAll` 平行设计。
   */
  abortAll(reason: AbortReason): number {
    let aborted = 0;
    for (const [, ctrl] of this.runs) {
      if (!ctrl.signal.aborted) {
        abortWithReason(ctrl, reason);
        aborted++;
      }
    }
    return aborted;
  }

  /**
   * 触发 `abortAll` 后 await 所有 in-flight run 走完 cleanup —— event-driven
   * `unregisterRun` 在 runs 清空时 resolve drain Promise,不轮询。
   *
   * `timeoutMs` 兜底:超时不抛,直接返回 —— 避免 grace 类工具 hang 整条关停链;
   * graceful shutdown 必须有上限,接受"30s 之后强行进下一步"的工程妥协。
   */
  async abortAllAndWait(reason: AbortReason, timeoutMs = 30_000): Promise<number> {
    const aborted = this.abortAll(reason);
    if (this.runs.size === 0) return aborted;

    const drained = new Promise<void>((resolve) => {
      this.drainResolver = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([drained, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // 超时路径主动清掉 resolver,避免后续 unregisterRun 误调一个无效 resolve
      this.drainResolver = null;
    }
    return aborted;
  }

  /** 当前 in-flight run 数,便于诊断 / 测试 */
  size(): number {
    return this.runs.size;
  }
}
