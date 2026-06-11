/**
 * 内置系统任务处理器
 *
 * 这些 handler 通过 SystemHandler 类型注册到 Scheduler，
 * 由 ScheduledTask.action: { kind: "system", handler: "__xxx" } 触发。
 *
 * 命名约定：双下划线前缀 `__` 表示系统内置（用户不可创建/删除）。
 *
 * 分层纪律：handler 一律是**薄触发壳**——到点调用对应模块自带的维护能力、
 * 把返回转成 `{status, summary}`，自身不含任何维护算法（算法归属各模块：
 * journal 凝练在 JournalStore、transcript 保留清理在持久层 runRetentionSweep）。
 *
 * - __health-check：周期性健康自检（不依赖外部资源）
 * - __journal-gc：调用 JournalStore 凝练逻辑（如果 store 可用）
 * - __transcript-gc：调用持久层时间窗保留清理（分片 + 摘要快照）
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

// ─── __transcript-gc ───

export interface TranscriptGcDeps {
  /**
   * 注入持久层保留清理能力（runRetentionSweep 的闭包，roots 由装配方解析）。
   * 不提供则 handler 报告未配置——与 journal-gc 同款可缺省模式。
   */
  runSweep?: () => Promise<{
    conversationsScanned: number;
    shardsDeleted: number;
    snapshotsDeleted: number;
    warnings: string[];
  }>;
}

export function buildTranscriptGcHandler(
  deps: TranscriptGcDeps = {},
): SystemHandler {
  return async () => {
    if (!deps.runSweep) {
      return {
        status: "ok",
        summary: "transcript-gc: not configured (no-op)",
      };
    }
    try {
      const r = await deps.runSweep();
      // warnings 是单点跳过的聚合（坏索引 / 删被占用文件失败等）——整轮
      // 仍算成功（幂等，下轮自然重试），计数进 summary 供运维观测
      return {
        status: "ok",
        summary:
          `transcript-gc: conversations=${r.conversationsScanned} ` +
          `shards=${r.shardsDeleted} snapshots=${r.snapshotsDeleted} ` +
          `warnings=${r.warnings.length}`,
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
  transcript?: TranscriptGcDeps;
  healthCheck?: { onCheck?: () => Promise<{ ok: boolean; details?: string }> };
}

/**
 * 构建包含所有内置系统 handler 的 Map，可直接传给 Scheduler。
 */
export function buildSystemHandlers(opts: SystemHandlersOptions = {}): Map<string, SystemHandler> {
  const map = new Map<string, SystemHandler>();
  map.set("__health-check", buildHealthCheckHandler(opts.healthCheck));
  map.set("__journal-gc", buildJournalGcHandler(opts.journal));
  map.set("__transcript-gc", buildTranscriptGcHandler(opts.transcript));
  return map;
}
