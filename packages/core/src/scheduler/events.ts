/**
 * Scheduler 事件定义
 *
 * 命名约定：`scheduler:{动作}`
 * 与 AgentEventMap 同级——Scheduler 有自己独立的 EventBus 实例，
 * 不污染 Agent Loop 的事件空间。
 *
 * CLI REPL 订阅这些事件来渲染任务执行通知。
 */

import type { TaskSchedule } from "./types.js";

export type SchedulerEventMap = {
  /** 任务创建 */
  "scheduler:task-created": {
    taskId: string;
    name: string;
    schedule: TaskSchedule;
    nextRunAt?: string;
  };

  /** 任务更新 */
  "scheduler:task-updated": {
    taskId: string;
    name: string;
  };

  /** 任务删除 */
  "scheduler:task-deleted": {
    taskId: string;
    name: string;
  };

  /** 任务开始执行 */
  "scheduler:task-started": {
    taskId: string;
    name: string;
    actionKind: string;
  };

  /** 任务执行成功 */
  "scheduler:task-completed": {
    taskId: string;
    name: string;
    durationMs: number;
    summary?: string;
  };

  /** 任务执行失败 */
  "scheduler:task-failed": {
    taskId: string;
    name: string;
    error: string;
    consecutiveErrors: number;
    nextRunAt?: string;
  };

  /** 任务因连续失败被自动 disable */
  "scheduler:task-disabled": {
    taskId: string;
    name: string;
    reason: string;
    lastError?: string;
  };
};
