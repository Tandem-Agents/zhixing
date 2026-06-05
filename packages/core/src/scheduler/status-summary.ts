/**
 * 任务状态摘要 —— 平台无关纯函数。
 *
 * 把「任务列表 → 状态摘要」的计算从 Scheduler 实例方法里抽出来，让两个消费者共用同一逻辑、
 * 不各写一套：
 * - daemon 内 Scheduler.getStatusSummary（持有实例、读内存任务）
 * - cli 读 scheduler.json 从属投影（去自起 Scheduler 后没有实例，只有磁盘上的任务快照）
 */

import type { ScheduledTask, TaskStatusSummary } from "./types.js";

/**
 * 内部任务（系统维护）谓词。内部任务不进用户视图 / agent 上下文 —— 调用方据此过滤。
 * 复用现有 `ScheduledTask.system` 标记，不另起来源维度字段。
 */
export function isInternal(task: ScheduledTask): boolean {
  return task.system === true;
}

/**
 * 由任务列表算出状态摘要。不内置内部/外部过滤 —— 保持纯计算，调用方按需先 filter
 * （用户视图 / turn-context 用 isInternal 排除内部任务后再传入）。
 *
 * @param recentWindowMs 最近完成/失败的时间窗口（默认 30 分钟）
 */
export function computeStatusSummary(
  tasks: ScheduledTask[],
  now: Date,
  recentWindowMs = 30 * 60 * 1000,
): TaskStatusSummary {
  const cutoff = new Date(now.getTime() - recentWindowMs);

  return {
    active: tasks
      .filter((t) => t.enabled && t.state.nextRunAt)
      .sort((a, b) => (a.state.nextRunAt ?? "").localeCompare(b.state.nextRunAt ?? ""))
      .map((t) => ({
        name: t.name,
        schedule: formatSchedule(t.schedule),
        nextRunAt: t.state.nextRunAt,
      })),

    recentlyCompleted: tasks
      .filter(
        (t) =>
          t.state.lastRunAt &&
          new Date(t.state.lastRunAt) >= cutoff &&
          !t.state.lastError,
      )
      .sort((a, b) => (b.state.lastRunAt ?? "").localeCompare(a.state.lastRunAt ?? ""))
      .map((t) => ({
        name: t.name,
        completedAt: t.state.lastRunAt!,
        summary: t.state.lastSummary?.slice(0, 100),
        delivered: t.state.lastDeliveryStatus === "sent",
      })),

    recentlyFailed: tasks
      .filter(
        (t) =>
          t.state.lastError &&
          t.state.lastRunAt &&
          new Date(t.state.lastRunAt) >= cutoff,
      )
      .sort((a, b) => (b.state.lastRunAt ?? "").localeCompare(a.state.lastRunAt ?? ""))
      .map((t) => ({
        name: t.name,
        failedAt: t.state.lastRunAt!,
        error: t.state.lastError!,
      })),
  };
}

/** 人类可读的调度描述（如 "cron 0 8 * * *"、"每 30 分钟"）。 */
export function formatSchedule(schedule: ScheduledTask["schedule"]): string {
  switch (schedule.kind) {
    case "once":
      return "一次性";
    case "interval": {
      const sec = Math.round(schedule.everyMs / 1000);
      if (sec < 60) return `每 ${sec} 秒`;
      const min = Math.round(sec / 60);
      if (min < 60) return `每 ${min} 分钟`;
      const hr = Math.round(min / 60);
      return `每 ${hr} 小时`;
    }
    case "cron":
      return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default:
      return "未知";
  }
}
