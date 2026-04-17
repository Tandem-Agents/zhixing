/**
 * 内置系统任务处理器
 *
 * 这些 handler 通过 SystemHandler 类型注册到 Scheduler，
 * 由 ScheduledTask.action: { kind: "system", handler: "__xxx" } 触发。
 *
 * 命名约定：双下划线前缀 `__` 表示系统内置（用户不可创建/删除）。
 *
 * 当前阶段（S2.E）：
 * - __health-check：周期性健康自检（不依赖外部资源）
 * - __journal-gc：调用 JournalStore 凝练逻辑（如果 store 可用）
 *
 * S3 阶段会追加：
 * - __delivery-retry：扫描 delivery-queue 重试失败投递
 */

import type { SystemHandler } from "@zhixing/core";

// ─── __health-check ───

export function buildHealthCheckHandler(deps?: {
  onCheck?: () => Promise<{ ok: boolean; details?: string }>;
}): SystemHandler {
  return async () => {
    const startedAt = Date.now();
    const memory = process.memoryUsage();

    let extraOk = true;
    let extraDetails: string | undefined;
    if (deps?.onCheck) {
      try {
        const r = await deps.onCheck();
        extraOk = r.ok;
        extraDetails = r.details;
      } catch (err) {
        extraOk = false;
        extraDetails = err instanceof Error ? err.message : String(err);
      }
    }

    const summary =
      `heap=${Math.round(memory.heapUsed / 1024 / 1024)}MB ` +
      `rss=${Math.round(memory.rss / 1024 / 1024)}MB ` +
      `latency=${Date.now() - startedAt}ms` +
      (extraDetails ? ` ${extraDetails}` : "");

    return {
      status: extraOk ? "ok" : "error",
      summary,
    };
  };
}

// ─── __journal-gc ───

export interface JournalGcDeps {
  /** 注入由 CLI/Server 提供的 journal 凝练函数。不提供则 handler 报告未配置 */
  runJournalLifecycle?: () => Promise<{ condensed: number; expired: number }>;
}

export function buildJournalGcHandler(deps: JournalGcDeps = {}): SystemHandler {
  return async () => {
    if (!deps.runJournalLifecycle) {
      return {
        status: "ok",
        summary: "journal-gc: not configured (no-op)",
      };
    }
    try {
      const r = await deps.runJournalLifecycle();
      return {
        status: "ok",
        summary: `journal-gc: condensed=${r.condensed} expired=${r.expired}`,
      };
    } catch (err) {
      return {
        status: "error",
        summary: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// ─── 注册器 ───

export interface SystemHandlersOptions {
  journal?: JournalGcDeps;
  healthCheck?: { onCheck?: () => Promise<{ ok: boolean; details?: string }> };
}

/**
 * 构建包含所有内置系统 handler 的 Map，可直接传给 Scheduler。
 */
export function buildSystemHandlers(opts: SystemHandlersOptions = {}): Map<string, SystemHandler> {
  const map = new Map<string, SystemHandler>();
  map.set("__health-check", buildHealthCheckHandler(opts.healthCheck));
  map.set("__journal-gc", buildJournalGcHandler(opts.journal));
  return map;
}
