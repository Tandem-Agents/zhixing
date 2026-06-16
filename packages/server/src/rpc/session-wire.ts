/**
 * 会话域 RPC wire 契约 —— 方法结果与推送 payload 的单一真相源。
 *
 * 覆盖 session.* 与 workscene.*(场景对话是会话域的场景形态)。server 方法
 * 实现与接入面设施(cli 的 RpcConversationFacade / RpcWorksceneFacade)共用
 * 此处类型:发射端以 satisfies / 返回类型钉住构造形状,接入端以同一类型还原,
 * 协议两侧不各自手写镜像——镜像即漂移点。
 *
 * 通知谱:
 * - session.delta / session.complete —— 主通道(turn 产出流),经 observer 组播
 * - session.event —— 带外通道,信封类型与转发器内聚在 session-events.ts
 * - session.changed —— 会话级变更(run 外发生),经同一组播名册
 * - session.activity —— 非当前对话的低噪活动提示,只给工作台类接入面
 * - session.modeSwitchIntent —— 可执行控制意图,仅定向发起连接
 */

import type {
  AgentResult,
  AgentYield,
  ContextBudget,
  TaskListState,
  TokenUsage,
  WorkModeSwitchIntent,
} from "@zhixing/core";
import type {
  RuntimeSecuritySnapshot,
  RuntimeSubAgentUsageEntry,
} from "../runtime/types.js";

// ─── wire 投影 ───

/** wire 上的错误形状——结构对象,非 Error 类实例 */
export interface WireAgentError {
  name: string;
  message: string;
}

/**
 * AgentResult 的 wire 投影:error 分支的 AgentError 是 Error 类实例,
 * message / name 是不可枚举的原型属性、JSON 序列化即丢——上 wire 前必须
 * 投影为结构对象。其余分支纯数据,原样透传。
 */
export type WireAgentResult =
  | Exclude<AgentResult, { reason: "error" }>
  | {
      reason: "error";
      error: WireAgentError;
      usage: TokenUsage;
    };

/** 发射端唯一投影点——complete 通知的 result 一律经此上 wire */
export function toWireAgentResult(result: AgentResult): WireAgentResult {
  if (result.reason !== "error") return result;
  return {
    reason: "error",
    error: { name: result.error.name, message: result.error.message },
    usage: result.usage,
  };
}

// ─── 通知方法名 ───

/** 会话域全部推送通知的方法名——发射端与订阅端共用,字符串不两侧各写 */
export const SESSION_NOTIFICATIONS = {
  delta: "session.delta",
  complete: "session.complete",
  event: "session.event",
  changed: "session.changed",
  activity: "session.activity",
  modeSwitchIntent: "session.modeSwitchIntent",
} as const;

// ─── 通知 payload ───

export interface SessionDeltaPayload {
  conversationId: string;
  /** @deprecated 使用 conversationId */
  sessionId: string;
  /** 本次 turn 的身份,用于发起端把 delta/complete 与 send 返回精确关联 */
  turnId: string;
  delta: AgentYield;
}

export interface SessionCompletePayload {
  conversationId: string;
  /** @deprecated 使用 conversationId */
  sessionId: string;
  /** 本次 turn 的身份,与 session.send 返回值一致 */
  turnId: string;
  result: WireAgentResult;
}

/**
 * 会话级变更(run 外发生)。联合成员只列已实现的变更——类型领先实现即
 * 声明面领先生效面。
 */
export type SessionChangedPayload =
  | { conversationId: string; change: "renamed"; name: string }
  | { conversationId: string; change: "deleted" }
  | { conversationId: string; change: "cleared" }
  /**
   * task_list 视图层状态变更(meta 变更的一种)——接入面屏底任务区据此实时
   * 刷新。taskList 为 tools-builtin 的 TaskListState 快照(null = 已清空),
   * server 不依赖该包、以透传形声明,发射端与消费端同源同包类型。
   */
  | { conversationId: string; change: "taskList"; taskList: TaskListState | null };

export interface SessionModeSwitchIntentPayload {
  conversationId: string;
  /** 产生该模式切换意图的 turn 身份 */
  turnId: string;
  intent: WorkModeSwitchIntent;
}

/**
 * 非当前会话的活动提示。它不是内容流:不携带用户文本或助手回复,只用于让
 * CLI 这类工作台刷新列表、标未读或显示低噪提示。当前正在观察该会话的连接
 * 仍通过 delta / complete 收完整内容。
 */
export interface SessionActivityPayload {
  conversationId: string;
  source: string;
  lastActiveAt: string;
  unreadHint: boolean;
  listInvalidated: boolean;
}

// ─── 方法结果 ───

export interface SessionSendResult {
  conversationId: string;
  /** @deprecated 使用 conversationId */
  sessionId: string;
  /** 本次 send 对应的 turn 身份;delta/complete/modeSwitchIntent 均携同值 */
  turnId: string;
}

/** session.list 条目——盘上事实叠加活跃态 */
export interface SessionConversationEntry {
  conversationId: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  active: boolean;
  busy: boolean;
  observerCount: number;
  pendingCount: number;
}

export interface SessionListResult {
  conversations: SessionConversationEntry[];
}

export interface SessionRenameResult {
  conversationId: string;
  name: string;
}

export interface SessionSubscribeResult {
  subscribed: boolean;
}

export interface SessionUnsubscribeResult {
  unsubscribed: boolean;
}

export interface SessionClearResult {
  cleared: true;
}

export interface SessionNewResult {
  conversationId: string;
  name: string;
}

export interface SessionResumeResult {
  conversationId: string;
  name: string;
  /** 会话当前是否活跃(活跃则 subscribe 可立即开始旁观进行中的流) */
  active: boolean;
  busy: boolean;
}

/** /task new·done 的动作形(执行体在宿主,语义单一定义于装配实现) */
export type SessionTaskListAction =
  | { kind: "add"; content: string }
  | { kind: "done"; token: string };

export interface SessionTaskListUpdateResult {
  ok: boolean;
  /** 用户可读反馈(成功与失败都有——接入面原样呈现) */
  message: string;
  /** 写后权威快照——发起端用它同步只读视图,不依赖 observer 广播回环。 */
  taskList: TaskListState | null;
}

export interface SessionTaskListResult {
  /** 宿主权威快照;无状态时为 null。 */
  taskList: TaskListState | null;
}

export interface SessionContextBudgetResult {
  budget: ContextBudget;
  turnCount: number;
  calibrationFactor: number;
}

export interface SessionUsageResult extends SessionContextBudgetResult {
  subUsages: readonly RuntimeSubAgentUsageEntry[];
}

export type SessionSecurityResult = RuntimeSecuritySnapshot;

export interface SessionCompactResult {
  /** 是否真的发生了折叠(false = 无可压缩内容 / 未达执行条件) */
  modified: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  /** 摘要降级信息——以机械保尾截断完成时携带,接入面须如实呈现降级方式 */
  emergencyFloor?: { droppedTurns: number; error: string };
}

// ─── workscene 方法结果 ───

export interface WorksceneSummary {
  sceneId: string;
  name: string;
  workdir?: string;
  lastActiveAt?: string;
}

export interface WorksceneListResult {
  scenes: WorksceneSummary[];
}

export interface WorksceneEnterResult {
  /** 场景当前对话的全域键(ws: 前缀)——接入面据此切当前对话指针 */
  conversationId: string;
  scene: WorksceneSummary;
}
