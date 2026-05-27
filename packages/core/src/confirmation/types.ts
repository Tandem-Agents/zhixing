/**
 * 确认交互系统类型定义
 *
 * 设计原则（spec §四 架构总览）：
 *   - Core 不认识 TTY / Ink / chalk / readline / prompt_toolkit
 *   - 任何渲染器（终端 / Web / 微信 / 钉钉）都通过 ConfirmationRenderer 接口接入
 *   - 同一个 ConfirmationRequest 在不同渲染器上可能呈现不同的选项子集
 *     （按 renderer.capabilities 过滤）
 *
 * 与安全系统的关系：
 *   SecurityPipeline 决定"需要确认" → 构造 ConfirmationRequest → 交给 Broker
 *   Broker 串行化 + 队列 + 通知渲染器 → 等待 decision
 *   上层根据 decision 决定执行 / 拒绝 / 编辑后执行
 */

import type { OperationClass, RiskLevel, SecurityDecision, SessionType } from "../security/types.js";
import type { PermissionRule } from "../security/types.js";
import type { SuggestedPattern } from "../security/confirmation-tracker.js";
import type { TurnOrigin } from "../types/tools.js";

// ─── 请求标识 ───

/**
 * ConfirmationRequest 的 id。
 * 调用方可提供 stable id（例如 tool_use_id）以便跨重启追踪；
 * 未提供时 broker 生成 UUID。
 */
export type ConfirmationRequestId = string;

// ─── 显示体 ───

/**
 * DisplayBody 是判别式联合类型。
 * 渲染器按 `kind` 字段分派到不同的渲染函数——新增业务领域（财务、智能家居、
 * 支付等）时只加一个 variant，不需要改 Core 或任何已有渲染器。
 */
export type DisplayBody =
  | { kind: "bash"; command: string; commandPreview: string }
  | { kind: "file-edit"; path: string; diff?: string }
  | { kind: "file-write"; path: string; preview?: string }
  | { kind: "file-read"; path: string }
  | {
      kind: "network";
      host: string;
      direction: "inbound" | "outbound";
    }
  | { kind: "messaging"; recipient: string; content: string }
  | { kind: "calendar"; title: string; invitees: string[] }
  | {
      kind: "generic";
      summary: string;
      details?: Record<string, string>;
    };

/**
 * 面板里额外展示的元数据——渲染器用来构造"元数据表格"（见 spec §6.3）。
 * 所有字段都是可选的；提供多少由上层决定。
 */
export interface ConfirmationDisplay {
  /** 面板标题，例如 "Bash 命令" / "编辑文件" */
  title: string;
  /** 主内容（判别式联合） */
  body: DisplayBody;
  /** 经过 sanitize 的命令文本，防 ANSI 显示欺骗 */
  commandPreview?: string;
  /** 完整命令（用于 "展开查看" 的 view 操作） */
  commandFull?: string;
  /** 环境变量的 key 列表（不含 value，避免泄露秘密） */
  envKeys?: string[];
  /** 被影响的文件/路径（已 realpath 解析） */
  resolvedPaths?: string[];
  /** 执行位置 */
  cwd: string;
}

// ─── 选项 ───

/**
 * ConfirmationOption 描述了用户可以选择的一个决策选项。
 *
 * 设计要点：
 *   - `hotkey` 是可选的字母快捷键。箭头导航与 hotkey 并存：初级用户用箭头，
 *     熟练用户直接按字母。
 *   - 带 `-with-note` / `-with-reason` 后缀的选项是 inline-input 能力：
 *     用户在同一个 select 组件里敲字。渲染器 capabilities 不支持时自动剔除。
 *   - `-session` / `-workspace` / `-global` 的 pattern 由 broker 的调用方
 *     （secure-executor）从 SuggestedPattern 预先计算好再传入。
 */
export type ConfirmationOption =
  | { kind: "allow-once"; label: string; hotkey?: string }
  | {
      kind: "allow-session";
      label: string;
      pattern: SuggestedPattern;
      hotkey?: string;
    }
  | {
      kind: "allow-workspace";
      label: string;
      pattern: SuggestedPattern;
      hotkey?: string;
    }
  | {
      kind: "allow-global";
      label: string;
      pattern: SuggestedPattern;
      hotkey?: string;
    }
  | { kind: "deny"; label: string; hotkey?: string }
  | {
      kind: "allow-with-note";
      label: string;
      placeholder: string;
      hotkey?: string;
    }
  | {
      kind: "deny-with-reason";
      label: string;
      placeholder: string;
      hotkey?: string;
    }
  | { kind: "edit-then-allow"; label: string; hotkey?: string }
  | { kind: "show-full"; label: string; hotkey?: string };

/**
 * `ConfirmationOption` 的 kind 字段集合——用于 RendererCapabilities.supportedOptions。
 */
export type ConfirmationOptionKind = ConfirmationOption["kind"];

// ─── 请求 ───

/**
 * ConfirmationRequest 是 broker 的输入。
 * 它是**纯数据 payload**——没有任何 Promise、回调或渲染器引用。
 */
export interface ConfirmationRequest {
  /**
   * 唯一标识。调用方可提供 stable id，或留空让 broker 生成 UUID。
   * 注意：id 在 broker 内必须全局唯一；重复 id 会被拒绝。
   */
  id: ConfirmationRequestId;

  // ── 被请求的操作 ──
  tool: string;
  toolInput: Record<string, unknown>;
  workingDirectory: string;

  // ── 来自 SecurityPipeline 的上下文（可选） ──
  /** 上层安全系统已做出的初步决策（如果有） */
  decision?: SecurityDecision;
  /** 操作影响分类 */
  operationClass?: OperationClass;
  /** 命中的权限规则（如果有） */
  matchedPermissionRule?: PermissionRule;

  // ── 显示信息 ──
  display: ConfirmationDisplay;

  // ── 用户可选的决定 ──
  options: ConfirmationOption[];

  // ── 会话上下文 ──
  sessionType: SessionType;
  workspaceId: string | null;

  // ── 时间约束 ──
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 过期时间戳（ms）。超时后 broker 以 expired 自动 resolve */
  expiresAt: number;

  // ── 远程确认回程地址（ADR-010 / remote-confirmation-execution.md §3.3） ──
  /**
   * Turn 发起入口的元信息。由 secure-executor 从 ToolExecutionContext.turnContext
   * 透传填入。远程渲染器（TextConfirmationRenderer）读 `target` 字段决定把确认
   * 消息发回哪个用户通道；RPC Bridge 读 `triggeredBy` 做推送过滤。
   *
   * REPL / 一次性命令下 turnOrigin 为 undefined——本地 TerminalRenderer 直接
   * 走 TTY 不需要回程地址。
   */
  turnOrigin?: TurnOrigin;
}

// ─── 决定 ───

/**
 * 所有可能的决定——判别式联合。
 *
 * 核心创新:
 *   - `note` / `reason` 字段是自由文本（来自 inline input）。批准时追加的 note
 *     和拒绝时的 reason 都会回流到 tool_result，让模型理解用户意图。
 *   - `edit-then-allow.modifiedInput` 让用户在审批时修改工具参数。
 *   - `expired` / `cancelled` 与 `deny` 语义严格区分：前二者不是用户主动拒绝。
 */
export type ConfirmationDecision =
  | { kind: "allow-once"; note?: string }
  | { kind: "allow-session"; pattern: SuggestedPattern; note?: string }
  | { kind: "allow-workspace"; pattern: SuggestedPattern; note?: string }
  | { kind: "allow-global"; pattern: SuggestedPattern; note?: string }
  | {
      kind: "edit-then-allow";
      modifiedInput: Record<string, unknown>;
      note?: string;
    }
  | { kind: "deny"; reason?: string }
  | { kind: "expired" }
  | { kind: "cancelled"; cause: CancelCause };

/**
 * `deny` decision 的判别辅助——自由文本拒绝（reason 非空）vs 结构化拒绝（reason 缺失）。
 *
 * 远程确认场景：词集匹配 allow/deny 产出结构化 decision；任意其它文本作为自由文本
 * 理由产出 `{ kind: "deny", reason }`。本函数给下游（埋点 / Bridge 推送）提供统一的
 * 判别入口，避免调用方各自判 `reason !== undefined`。
 */
export function isFreeTextDeny(
  decision: ConfirmationDecision,
): decision is { kind: "deny"; reason: string } {
  return decision.kind === "deny" && typeof decision.reason === "string" && decision.reason.length > 0;
}

/**
 * 取消原因——区分不同的非用户主动拒绝场景。
 */
export type CancelCause =
  | "user-ctrl-c" // 用户按 Ctrl+C
  | "user-ctrl-d" // 用户按 Ctrl+D
  | "session-end" // 会话结束时清场
  | "aborted" // 外部 AbortSignal 触发
  | "backpressure"; // 队列已满

// ─── 渲染器能力 ───

/**
 * 渲染器能力声明——broker 根据此剔除不支持的选项。
 *
 * 例子：
 *   - 终端渲染器通常支持 supportsInlineInput=true
 *   - 未来的 "轻量通知型" 渲染器（钉钉快捷按钮）可能只支持 allow-once/deny
 *   - 所有渲染器必须至少支持 deny 选项
 */
export interface RendererCapabilities {
  /** 支持的 ConfirmationOption.kind 集合 */
  supportedOptions: ConfirmationOptionKind[];
  /** 是否支持批准时追加 note（用户批准同时补充指示） */
  supportsAllowNote: boolean;
  /** 是否支持拒绝时追加 reason（用户拒绝同时告诉智能体原因） */
  supportsDenyReason: boolean;
  /** 是否支持 edit-then-allow */
  supportsEdit: boolean;
  /** 是否能同时显示多个 pending（有队列视图） */
  supportsQueue: boolean;
  /** 是否有内联 input 组件（select + input 混合） */
  supportsInlineInput: boolean;
}

// ─── 渲染器接口 ───

/**
 * 渲染器——把 ConfirmationRequest 呈现给用户并收集 ConfirmationDecision。
 *
 * Step 1（Broker 阶段）这个接口只是类型定义；真实实现在 Step 2+ 构造。
 *
 * 生命周期:
 *   1. 上层调用 renderer.attach(broker) 开始监听
 *   2. Broker 有新请求时调用通过 broker.onRequest 注册的回调
 *   3. 渲染器显示 UI 并等待用户响应
 *   4. 用户响应后渲染器调用 broker.resolve(id, decision)
 *   5. 渲染器 detach() 时取消订阅
 */
export interface ConfirmationRenderer {
  readonly name: string;
  readonly capabilities: RendererCapabilities;

  attach(broker: IConfirmationBroker): () => void;
  detach(): void;
}

// ─── 超时降级策略（远程确认，远程路径专用） ───

/**
 * 确认请求在 broker 内部到达 `expiresAt` 而用户未响应时的降级策略。
 *
 * - **deny**（默认）：按普通拒绝处理，抛 SecurityBlockError。严格安全。
 * - **auto-approve-safe**：检查 `operationClass`，observe / internal 放行；
 *   external / critical 仍然拒绝。适合"希望定时任务超时后也能执行低风险操作"的运维。
 *
 * 参见 remote-confirmation-execution.md §3.8。
 */
export type ConfirmationFallbackStrategy = "deny" | "auto-approve-safe";

// ─── 非交互策略 ───

/**
 * 非交互模式的解析器——broker 在没有渲染器订阅时调用。
 *
 * Step 1 提供两个内置实现（non-interactive.ts）：
 *   - failToDenyResolver: 返回 deny
 *   - failToExpiredResolver: 返回 expired
 *
 * Phase 2+ 可以注入：
 *   - delegate-to-preapproval: 查预审批规则列表
 *   - delegate-to-llm: 走辅助 LLM 分诊
 */
export interface NonInteractiveResolver {
  readonly name: string;
  resolve(request: ConfirmationRequest): ConfirmationDecision;
}

// ─── Broker 接口 ───

/**
 * Broker 的 pending 请求快照。
 * 不包括已 resolve 但还在 grace period 内的请求。
 */
export interface PendingSnapshot {
  request: ConfirmationRequest;
  status: "queued" | "showing";
}

/**
 * Broker 状态快照——供 /security 等调试命令使用。
 */
export interface BrokerSnapshot {
  /** broker 实例 id —— 与 IConfirmationBroker.id 一致,审计血缘追溯起点 */
  id: string;
  /**
   * 父 broker id(可选) —— 仅在子 agent 派生 broker 时被透传,主 broker 无此字段。
   * 审计场景按此字段重建父子关系链。
   */
  parentBrokerId?: string;
  /**
   * 派生此 broker 的 sub-agent 实例 id(可选) —— 与 ChildAgentResult.subAgentId
   * 一致,审计时可关联 broker 活动到具体的 sub-agent dispatch 记录。
   */
  sourceAgentId?: string;
  pending: PendingSnapshot[];
  resolvedRecently: Array<{
    id: ConfirmationRequestId;
    decision: ConfirmationDecision;
    resolvedAt: number;
  }>;
  listenerCount: number;
  nonInteractiveResolver: string;
}

/**
 * 新请求事件的监听器类型——渲染器订阅此事件以知道何时开始显示。
 */
export type RequestListener = (request: ConfirmationRequest) => void;

/**
 * 请求被解决事件的监听器类型——聚合层（ConfirmationHub）订阅以清理索引、推送 RPC 通知。
 *
 * 语义：在任何路径（用户 resolve / cancel / expire / 非交互兜底 / backpressure）
 * 上请求最终得到 decision 时同步调用一次。每个 requestId 至多触发一次。
 *
 * 与 `confirmation:resolved` EventBus 事件的区别：
 *   - `confirmation:resolved` 仅针对 user-resolve 路径（见 broker 中的 resolve 实现）
 *   - `onResolved` 覆盖全部 5 条 resolved 路径，是"请求终结"的唯一真源
 */
export type ResolvedListener = (
  requestId: ConfirmationRequestId,
  decision: ConfirmationDecision,
) => void;

/**
 * Broker 取消订阅函数。
 */
export type BrokerUnsubscribe = () => void;

/**
 * Broker 接口——确认交互系统的核心调度器。
 */
export interface IConfirmationBroker {
  /**
   * broker 实例 id —— 用于审计血缘追溯。
   *
   * 子 agent 派生 broker 时,会把父 broker.id 透传成子 broker.parentBrokerId,
   * 由审计层依据 parent/child id 关系重建调用链路。
   *
   * 缺省由 broker 构造时 randomUUID() 生成;测试场景可通过 ConfirmationBrokerOptions.id
   * 显式注入稳定值。
   */
  readonly id: string;

  /**
   * 注册一个确认请求。
   * 返回的 Promise 在用户做出决定、请求超时、或请求被取消时 resolve。
   *
   * 串行化规则：
   *   - 任意时刻只有一个请求处于 "showing" 状态（队首）
   *   - 其它请求在 "queued" 状态等待
   *   - 队首 resolve/cancel/expire 后，队列前进并通知下一个
   *
   * 非交互降级：
   *   - 如果调用时没有任何 onRequest 监听器 → 立即应用 nonInteractiveResolver
   */
  requestConfirmation(
    request: ConfirmationRequest,
  ): Promise<ConfirmationDecision>;

  /**
   * 订阅新请求通知——由渲染器调用。
   * 只有 "showing" 状态的请求会触发监听器；queued 的不会。
   */
  onRequest(listener: RequestListener): BrokerUnsubscribe;

  /**
   * 订阅请求被解决通知——聚合层（如 ConfirmationHub）调用。
   *
   * 任何路径完成时同步触发一次：
   *   - 用户 resolve（成功路径）
   *   - cancel（成功路径）
   *   - expire（超时）
   *   - 无监听器时的非交互兜底（requestConfirmation 直接返回）
   *   - backpressure（队列满）
   *
   * 触发顺序保证：listener 在请求 Promise resolve 之前触发，
   * 以便 Hub 可在外部观察到 decision 前完成索引清理。
   */
  onResolved(listener: ResolvedListener): BrokerUnsubscribe;

  /**
   * 解决一个 pending 请求——由渲染器调用。
   * 返回 true 表示成功；false 表示 id 已经被解决/取消/过期（幂等语义）。
   */
  resolve(
    requestId: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): boolean;

  /**
   * 取消某个 pending 请求。
   * 返回 true 表示成功；false 表示 id 不存在或已被解决。
   */
  cancel(requestId: ConfirmationRequestId, cause: CancelCause): boolean;

  /**
   * 取消所有 pending 请求——例如会话结束时清场。
   * 返回被取消的请求数量。
   */
  cancelAll(cause: CancelCause): number;

  /** 列出当前 pending 的请求（含 queued 和 showing） */
  listPending(): PendingSnapshot[];

  /** 取状态快照 */
  snapshot(): BrokerSnapshot;
}

// ─── 事件类型 ───

/**
 * Broker 通过 EventBus 发射的事件类型。
 * 用于审计、可观测性，以及 /security 仪表盘展示。
 *
 * 所有事件 payload 含可选的 audit 元信息(`brokerId` / `parentBrokerId` /
 * `sourceAgentId`)。broker 在 emit 时自动注入这些字段,订阅方据此重建
 * "本次活动来自哪个 broker、其父 broker 是谁、对应哪个 sub-agent dispatch"
 * 的完整血缘链路,便于跨 agent 审计与故障定位。
 *
 * 主 broker(无父)发的事件 `parentBrokerId` / `sourceAgentId` 缺省;
 * 子 broker 必有这两字段。
 */
export type ConfirmationEventMap = {
  "confirmation:requested": {
    requestId: ConfirmationRequestId;
    tool: string;
    operationClass?: OperationClass;
    riskLevel?: RiskLevel;
    queueDepth: number;
    timestamp: number;
    brokerId: string;
    parentBrokerId?: string;
    sourceAgentId?: string;
  };
  "confirmation:shown": {
    requestId: ConfirmationRequestId;
    tool: string;
    queueDepth: number;
    timestamp: number;
    brokerId: string;
    parentBrokerId?: string;
    sourceAgentId?: string;
  };
  "confirmation:resolved": {
    requestId: ConfirmationRequestId;
    tool: string;
    decision: ConfirmationDecision;
    durationMs: number;
    timestamp: number;
    brokerId: string;
    parentBrokerId?: string;
    sourceAgentId?: string;
  };
  "confirmation:cancelled": {
    requestId: ConfirmationRequestId;
    tool: string;
    cause: CancelCause;
    timestamp: number;
    brokerId: string;
    parentBrokerId?: string;
    sourceAgentId?: string;
  };
  "confirmation:expired": {
    requestId: ConfirmationRequestId;
    tool: string;
    durationMs: number;
    timestamp: number;
    brokerId: string;
    parentBrokerId?: string;
    sourceAgentId?: string;
  };
  "confirmation:auto-resolved": {
    requestId: ConfirmationRequestId;
    tool: string;
    resolverName: string;
    decision: ConfirmationDecision;
    timestamp: number;
    brokerId: string;
    parentBrokerId?: string;
    sourceAgentId?: string;
  };
};
