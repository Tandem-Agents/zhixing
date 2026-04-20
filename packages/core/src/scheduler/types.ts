/**
 * Scheduler 核心类型定义
 *
 * 设计原则：
 * - 调度器不依赖具体的 Agent 实现——通过 SchedulerDeps.runAgentTurn 注入
 * - TaskSchedule 是可扩展的 discriminated union（S3.5 将添加 after/self-paced）
 * - TaskState 是运行时状态，与任务定义分离
 * - S1 范围：once / interval / cron 三种调度，agent-turn / system 两种动作
 */

// ─── 任务优先级 ───

export type TaskPriority = "low" | "normal" | "high" | "urgent";

/**
 * 优先级排序权重（数值越大越先执行）
 */
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// ─── 调度策略 ───

/**
 * S1 支持的调度类型：
 * - once: 一次性定时任务
 * - interval: 固定间隔重复
 * - cron: cron 表达式
 *
 * S3.5 将扩展：after（前置依赖）、self-paced（自定步调）
 */
export type TaskSchedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string };

// ─── 任务动作 ───

/**
 * S1 支持的动作类型：
 * - agent-turn: 启动一次 Agent 对话（prompt → LLM → tools → result）
 * - system: 调用内置系统处理器（如 __journal-gc）
 */
export type TaskAction =
  | {
      kind: "agent-turn";
      prompt: string;
      model?: string;
      tools?: string[];
    }
  | { kind: "system"; handler: string; params?: Record<string, unknown> };

// ─── 投递配置 ───

export type TaskDelivery =
  | { kind: "none" }
  | { kind: "channel"; channel: string; to: string }
  | { kind: "webhook"; url: string; headers?: Record<string, string> };

// ─── 任务运行时状态 ───

export interface TaskState {
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  lastSummary?: string;
  /** 最近一次执行的投递状态 */
  lastDeliveryStatus?: "sent" | "skipped" | "failed";
  consecutiveErrors: number;
  runCount: number;
}

// ─── 完整的调度任务 ───

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: TaskPriority;

  schedule: TaskSchedule;
  action: TaskAction;
  delivery?: TaskDelivery;

  state: TaskState;

  createdAt: string;
  updatedAt: string;
  /** 系统内置任务标记——用户不可删除 */
  system?: boolean;
}

// ─── 任务状态摘要（用于 per-turn 上下文注入） ───

export interface TaskStatusSummary {
  active: Array<{
    name: string;
    /** 人类可读的调度描述（如 "cron 每天 08:00"） */
    schedule: string;
    nextRunAt?: string;
  }>;
  recentlyCompleted: Array<{
    name: string;
    completedAt: string;
    summary?: string;
    delivered?: boolean;
  }>;
  recentlyFailed: Array<{
    name: string;
    failedAt: string;
    error: string;
  }>;
}

// ─── Agent Turn 接口（依赖注入） ───

export interface AgentTurnParams {
  prompt: string;
  model?: string;
  tools?: string[];
  abortSignal?: AbortSignal;
  context?: "scheduled-task";
}

export interface AgentTurnResult {
  status: "ok" | "error";
  output?: string;
  error?: string;
  durationMs: number;
}

// ─── System Handler ───

export type SystemHandler = (params?: Record<string, unknown>) => Promise<{
  status: "ok" | "error";
  summary?: string;
}>;

// ─── TaskStore ───

export interface TaskStore {
  load(): Promise<ScheduledTask[]>;
  save(tasks?: ScheduledTask[]): Promise<void>;
  list(): ScheduledTask[];
  addTask(task: ScheduledTask): Promise<void>;
  updateTask(id: string, patch: Partial<ScheduledTask>): Promise<void>;
  removeTask(id: string): Promise<void>;
  getTask(id: string): ScheduledTask | undefined;
}

// ─── TimerLoop ───

export interface TimerLoop {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  rearm(): void;
}

// ─── Logger（最小接口） ───

export interface SchedulerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}
