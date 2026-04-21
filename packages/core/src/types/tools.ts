/**
 * 工具系统类型定义
 *
 * 设计原则：
 * - 自描述：每个工具声明自己的能力和安全约束
 * - Fail-closed 默认值：未声明的属性取保守值（有副作用、不可并行、需要权限）
 * - JSON Schema 作为参数描述格式：这是 LLM API 的通用标准
 *
 * 对比 Claude Code：它用 buildTool() 工厂 + 多个布尔属性。
 * 我们的设计类似但更显式 — 安全属性直接在接口上，不需要工厂函数。
 */

import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../channels/types.js";

// ─── Turn 上下文（ADR-007 Phase 2） ───

/**
 * 每轮对话的跨层元信息：由入口（Channel InboundRouter 等）构造，
 * 穿透 SessionRuntime → AgentRuntime → 每次 tool.call 的 ToolExecutionContext。
 *
 * REPL 等无 channel 场景下所有字段可为 undefined，工具需支持降级路径。
 */
export interface TurnContext {
  /** 全局唯一 turn 标识（Phase 2 用于观测；Phase 3 起接 Outbox Turn Slot） */
  turnId?: string;
  /** 当前 turn 绑定的用户 target */
  emissionTarget?: DeliveryTarget;
  /** 直接向用户发送 commitment（经 Outbox）
   *
   * `meta.toolName` 由 AgentLoop 层注入（每次 tool.call 注入当前工具名），
   * 用于 EmissionSource 的 `tool-commitment.toolName` 字段——提供生产日志中
   * "这条 commit 是哪个工具发的"的可观测性。
   */
  commitToUser?: (
    content: OutboundContent,
    meta?: { toolName?: string },
  ) => Promise<DeliveryResult>;
}

// ─── JSON Schema ───

/**
 * JSON Schema 属性描述。
 * 这是发送给 LLM 的格式，LLM 根据此 schema 构造工具调用参数。
 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  [key: string]: unknown;
}

/**
 * 工具输入参数的 JSON Schema（顶层必须是 object）。
 */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

// ─── 工具执行 ───

/**
 * 工具执行上下文 — 传递给工具 call 函数的运行时信息。
 * 随着系统演进会逐步扩展（如权限信息、会话 ID 等）。
 *
 * 从 ADR-007 Phase 2 起，含可选的 turn 元信息（`turnId` / `emissionTarget` / `commitToUser`）：
 * - 这些字段在**channel 发起的用户会话 turn** 中有值
 * - REPL 单次命令、定时任务 ephemeral turn 中均为 undefined
 * - 工具若依赖这些字段，必须同时支持"无上下文"路径（降级为 LLM 叙述）
 */
export interface ToolExecutionContext {
  /** 当前工作目录 */
  workingDirectory: string;
  /** 中止信号，用于取消长时间运行的工具 */
  abortSignal?: AbortSignal;

  // ─── Turn 元信息（可选，ADR-007 Phase 2 引入） ───

  /**
   * 当前 turn 的全局唯一标识。Phase 2 主要用于日志/事件关联；
   * Phase 3 起作为 Outbox Turn Slot 的 key，触发因果依赖。
   */
  turnId?: string;

  /**
   * 当前 turn 绑定的用户目标。Phase 2 作为元信息可见；Phase 3 起供工具记录
   * `createdInTurn` 到其副作用（如 Scheduled Task）中，实现跨路径因果追溯。
   */
  emissionTarget?: DeliveryTarget;

  /**
   * 直接向用户发送一条 commitment 消息（经 Outbox），不依赖 LLM 后续叙述。
   * 参见 ADR-007 决策 2 / [message-outbox.md §4.2](../../../../research/design/specifications/message-outbox.md)。
   *
   * 工具的调用契约：
   * - 应仅在该 tool 确实造成了**用户感兴趣的副作用**后调用（如 task 创建成功）
   * - 调用后应检查返回的 `DeliveryResult.success`——仅当 true 才在 ToolResult 里设
   *   `committedToUser: true`；否则降级为 LLM 叙述路径，否则"LLM 不叙述 + commit 未到达"
   *   会让用户完全感知不到副作用
   * - 若整体为 undefined（非 channel 上下文），工具应退化为"在 ToolResult.content 描述结果让 LLM 叙述"
   *
   * 注意：工具看到的 commitToUser 是由 AgentLoop 包装过的——已经自动带上当前工具名，
   * 工具**无需**手动传 `{ toolName }` 参数。
   */
  commitToUser?: (content: OutboundContent) => Promise<DeliveryResult>;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  content: string;
  isError?: boolean;

  /**
   * 提示调用方：本工具已通过 `ToolExecutionContext.commitToUser` 向用户发出可视化反馈，
   * LLM 应避免再次叙述（参见 ADR-007 Phase 2 / 系统提示中的 commitment 抑制段）。
   *
   * 仅在工具实际调用了 commitToUser 且承诺已发送/入队后置为 true。
   */
  committedToUser?: boolean;
}

// ─── 工具定义 ───

/**
 * 工具定义 — 工具向系统声明自己的全部信息。
 *
 * 安全属性采用 fail-closed 设计（借鉴 Claude Code）：
 * - isReadOnly 默认 false → 假设有副作用
 * - isParallelSafe 默认 false → 假设不能并发
 * - needsPermission 默认 true → 假设需要用户确认
 *
 * 这意味着新工具如果忘了声明这些属性，系统会采取最保守的策略，
 * 而不是意外地允许危险操作。
 */
export interface ToolDefinition {
  /** 工具名称，全局唯一标识符 */
  name: string;
  /** 工具描述，发送给 LLM 指导工具选择 */
  description: string;
  /** 输入参数的 JSON Schema */
  inputSchema: JsonSchema;

  /** 此工具是否只读（不修改文件系统或外部状态）。默认 false */
  isReadOnly?: boolean;
  /** 此工具是否可以与其他工具并行执行。默认 false */
  isParallelSafe?: boolean;
  /** 此工具是否需要用户权限确认。默认 true */
  needsPermission?: boolean;
  /** 结果的最大字符数，超出时自动截断。不设置则不限制 */
  maxResultChars?: number;

  /**
   * 执行工具
   * @param input - 经过 schema 验证的输入参数
   * @param context - 运行时上下文（工作目录、中止信号等）
   */
  call(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

/**
 * 发送给 LLM 的工具声明（不包含实现细节）。
 * Provider 层使用此类型构造 API 请求。
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** 从 ToolDefinition 提取 ToolSpec（去掉实现细节，只留 LLM 需要的信息） */
export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
