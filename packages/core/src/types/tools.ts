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
import type { LLMRoles, ResolvedRoleThinking } from "./llm.js";
import type { BoundaryCrossing } from "../security/types.js";

// ─── Turn 上下文（ADR-007 Phase 2） ───

/**
 * TurnOrigin —— turn 发起入口的元信息。
 *
 * 用途：
 *   - 远程确认：`TextConfirmationRenderer` 读 `target` 决定把确认消息发回哪里
 *   - 审计：`triggeredBy` 记录是谁触发了这个 turn
 *   - RPC 推送过滤：`channel="rpc"` + `triggeredBy=connectionId` 支持定向通知
 *
 * 3 个 turn 入口的填充约定（remote-confirmation-execution.md §3.3）：
 *   - 通道用户消息 → `{ channel: msg.channelId, target: replyTarget, triggeredBy: msg.from }`
 *   - RPC `session.send`（Web UI / IDE）→ `{ channel: "rpc", triggeredBy: connectionId }`
 *   - Scheduler → ephemeralRuntime → `{ channel: "scheduler", target?: task.deliveryTarget, triggeredBy: task.id }`
 *
 * REPL / 一次性 CLI 命令下 turnOrigin 为 undefined（本地 TTY 走 TerminalRenderer，不需要回程地址）。
 */
export interface TurnOrigin {
  /** 入口通道标识符。已知值：feishu / dingtalk / wechat / rpc / cli / scheduler；新通道可自由扩展。 */
  channel: string;
  /** 投递目标——若可达则确认请求路由到这里（通道用户回复的原会话）。 */
  target?: DeliveryTarget;
  /** 触发者（用户 ID / connectionId / taskId）——审计 + 推送过滤。 */
  triggeredBy?: string;
}

/**
 * 每轮对话的跨层元信息：由入口（Channel InboundRouter 等）构造，
 * 穿透 SessionRuntime → AgentRuntime → 每次 tool.call 的 ToolExecutionContext。
 *
 * REPL 等无 channel 场景下所有字段可为 undefined，工具需支持降级路径。
 */
/**
 * 生成一个全局 Turn ID。
 *
 * 格式：`turn_${base36Time}_${rand}`——与 Outbox entry id 语义相近，便于日志交叉定位。
 *
 * 统一实现位置：所有 turn 入口（channel InboundRouter / RPC session / scheduler）
 * 共用此函数，保证格式一致 + 未来调整（如碰撞率升级为 UUID）只需改一处。
 */
export function generateTurnId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `turn_${ts}_${rand}`;
}

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
  /**
   * Turn 发起入口的元信息（远程确认的回程地址）。
   * 填充入口：InboundRouter / RPC session.send / Scheduler→ephemeralRuntime。
   * REPL / 一次性命令为 undefined。
   */
  turnOrigin?: TurnOrigin;
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

  /**
   * Turn 发起入口的元信息——远程确认的回程地址。
   * 由 AgentRuntime 从 `RunParams.turnContext.turnOrigin` 展开注入；
   * secure-executor 透传到 ConfirmationRequest.turnOrigin 让 Renderer / Hub / Bridge
   * 知道把确认请求推回哪个通道对话 / RPC 连接。
   *
   * REPL / 一次性命令下为 undefined（本地 TerminalRenderer 不需要远程路由）。
   * 参见 remote-confirmation-execution.md §3.3。
   */
  turnOrigin?: TurnOrigin;

  /**
   * 当前会话可用的 LLM 角色实例（main + light + power）。
   *
   * 入口（cli/run-agent → core agent-loop → tool-executor）创建 ctx 时一次性注入；
   * 工具消费 `ctx.llm.light` 在 I/O 边界做信息净化，避免噪音灌入主上下文；
   * `ctx.llm.power` 是重活槽（基础设施已就位，消费者按需接入）。
   *
   * Optional 的语义：单测 / 极简自动化路径可能不注入。consumer 必须显式分支处理
   * `ctx.llm === undefined`（推荐 graceful degrade，如 WebFetch 退到 raw markdown；
   * 强依赖 LLM 的工具应在 ToolDefinition.description 标注并返回明确 isError）。
   * 禁止 silent return / 抛 throw 给 secure-executor 通用 catch。
   */
  llm?: LLMRoles;

  /**
   * 各角色装配期已解析的思考控制 —— 与 {@link llm} 平行、同路径注入。
   *
   * 工具在 I/O 边界调 `ctx.llm.<role>.chat` 时，附带
   * `thinking: ctx.roleThinking?.<role>` 即让该次调用遵循用户对该角色的思考
   * 配置（已过校验兜底）。缺省（单测 / 未注入路径）→ 不发思考参数，与
   * `ctx.llm` 缺省同款 graceful degrade 语义。
   */
  roleThinking?: ResolvedRoleThinking;
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

// ─── 工具中断策略 ───

/**
 * 工具被 abort 时的预期行为。每个值表达工具如何响应 ctx.abortSignal。
 *
 * 协议字段是工具自描述的一部分 —— tool-executor 不读取此字段(中断响应是工具
 * 自身职责),仅作为契约文档让审计者 / 维护者 / 未来 background 调度器知道每个
 * 工具的中断语义。新增 background 等高阶行为时,tool-executor 才需要消费。
 */
export type ToolInterruptBehavior =
  /**
   * 立即中止 —— tool.call 内部应在 ctx.abortSignal.aborted 时尽快 reject AbortError 或
   * return partial result。纯 JS 工具(read / edit / grep / web_fetch / memory 等)适用。
   */
  | "cancel"
  /**
   * 优雅停止 —— 工具持有外部子进程或长跑资源,abort 时实现 SIGTERM → grace 期 → SIGKILL
   * 升级链。推荐 import 模块层提供的 gracefulKill helper, 不允许自写 SIGTERM/SIGKILL
   * 防止跨平台行为分歧。Bash / 长跑外部程序工具适用。
   */
  | "grace"
  /**
   * 不中止 —— 工具应 yield 一个 background 引用,主 loop 不等待。供未来子 agent 抽象
   * 使用,本里程碑无消费方。
   */
  | "background";

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
 *
 * 子 agent 工具集由 `AgentRoleProfile.enabledTools` 显式声明驱动 —— profile
 * 是工具装配的唯一权威源。防递归（子不能再派子）由 sub-agent profile.enabledTools
 * 不含 "Task" 保证。
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
   * 此工具跨越的安全边界（forward-looking 字段）。
   *
   * 用于让 `BoundaryImpactClassifier`（OperationClassifier 兜底分类器）
   * 按工具自描述的边界判断 OperationClass，避免每个新工具都被默认归为 critical。
   *
   * **何时不应声明**：read / write / edit / glob / grep / bash 通过专属 context
   * classifier（FileSystemClassifier / ShellClassifier）接管——它们的影响取决于运行时
   * 上下文（路径在不在 workspace、命令内容），非静态边界；`CompositeClassifier` 优先
   * contextClassifiers，对这几个工具声明 boundaries 是死代码、**不应**声明。
   * 反之，memory / schedule 等"固定写本地应用状态"的工具应声明 `app-state` 边界
   * （判 internal），而非硬编码进 classifier。
   *
   * **何时必须声明**：未来无 context classifier 的新工具（如 web_fetch / web_search /
   * MCP HTTP 工具 / 第三方插件）必须声明，否则 `BoundaryImpactClassifier` 会
   * fail-closed 分类为 critical（每次调用触发 confirm，UX 极差）。
   *
   * 见 [tool-permission-execution.md](../../../../research/design/specifications/tool-permission-execution.md)
   * §4.1 与 ADR-TPE-006。
   */
  boundaries?: BoundaryCrossing[];

  /**
   * 工具自描述的 system-prompt 引导行（forward-looking 字段）。
   *
   * 由 cli/system-prompt 的 `buildToolUsage` 自动追加到 ## Tool Usage 段——
   * 工具自描述,无需在 cli 包 hardcode 每个工具的提示模板。与 `boundaries` /
   * `permissionArgumentKey` 同属"工具自描述"哲学(21A 既定模式)。
   *
   * 典型用途:
   *   - web_fetch: preapproved hosts 列表(避免与 PermissionRule 字面值重复)
   *   - mcp 工具: 按服务器特性提示参数约定
   *   - 工具特定的"何时用 / 不该用"边界声明
   *
   * 写作约定:
   *   - 每条以 `- ` 开头(融入 markdown bullet 列表)
   *   - 英文(与现有 system prompt 一致风格)
   *   - 简洁,聚焦 LLM 决策时需要知道的信息(don't restate description)
   */
  systemPromptHints?: readonly string[];

  /**
   * 权限规则匹配时使用哪个输入字段作为 "argument"（forward-looking 字段）。
   *
   * `PermissionStore` 在匹配 `pattern.argument` glob 时需要从工具参数中提取一个字符串。
   * 默认使用内置启发式（priority list `path / file_path / target / destination`，否则取
   * 第一个 string 字段）——对单 string 字段工具够用，但对多 string 字段工具
   * （如未来 `web_fetch { url, prompt? }`、`web_search { query, allowed_domains? }`）
   * 不可靠，可能命中错误字段。
   *
   * 推荐每个 `needsPermission: true` 的工具显式声明，避免依赖隐式约定。
   * 仅 `needsPermission: false` 的工具（glob / grep）不进权限匹配链路，无需声明。
   *
   * 实际生效路径：CLI / serve 入口注入 `createToolAwareExtractor(tools)` 到
   * `PermissionStoreOptions.extractArgument`；store 在 match 时优先用此字段、
   * 未声明则降级到内置启发式。
   *
   * 见 [tool-permission-execution.md](../../../../research/design/specifications/tool-permission-execution.md)
   * §4.2 与 ADR-TPE-003。
   */
  permissionArgumentKey?: string;

  /**
   * 工具被 abort 时的预期行为。默认 "cancel" —— 纯 JS 工具(read/edit/grep 等)
   * 立即中止;持有外部子进程的工具(bash)应声明 "grace" 并 import gracefulKill helper
   * 实现 SIGTERM → grace 期 → SIGKILL 升级链。
   *
   * 协议字段是工具自描述的一部分 —— tool-executor 不读取此字段, 工具自身负责按
   * 声明实现中断响应。详见 ToolInterruptBehavior 各 variant 的注释。
   */
  interruptBehavior?: ToolInterruptBehavior;

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
