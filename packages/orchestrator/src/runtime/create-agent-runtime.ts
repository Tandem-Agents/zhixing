/**
 * Agent 运行编排
 *
 * 职责：组装 Provider + Tools + EventBus，运行 Agent Loop，
 * 通过回调通知调用方 yield 事件。
 *
 * 运行时不感知具体调用方(REPL / 服务端 / 子 agent)。展示层订阅与安全事件 UI 通知
 * 都通过依赖注入(decorateRunBus / onSecurityBlocked / onUserDenied)从外部接入。
 */

import { randomUUID } from "node:crypto";
import {
  type AgentYield,
  type AgentEventMap,
  type WindowCompact,
  type ConfirmationFallbackStrategy,
  type ContextBudget,
  type IConfirmationBroker,
  type IEventBus,
  type Message,
  type RunResult,
  type RunRecordAdvancementMetadata,
  type ToolResultBlock,
  type IPermissionStore,
  type IToolArgumentExtractor,
  type LLMRole,
  type MutableToolBoundaryRegistry,
  type PermissionContextId,
  type PermissionRule,
  type RiskLevel,
  type ResolvedRoleThinking,
  type SecurityRule,
  type ThinkingConfig,
  type ToolDefinition,
  type TurnContext,
  type TurnContextProvider,
  type TurnSource,
  type WatchdogPolicy,
  buildRunRecord,
  BoundaryRegistry,
  ConfirmationBroker,
  createEventBus,
  createSegmentManager,
  createSegmentSummarizeFn,
  createTokenEstimator,
  type SegmentPersistence,
  type SegmentStreamFactory,
  type TaskListReader,
  wrapStreamWithWatchdog,
  wrapWithCalibration,
  ToolArgumentExtractor,
  MemoryFlusher,
  calculateBudget,
  createMemoryFlushHook,
  toToolSpec,
  DEFAULT_WATCHDOG_POLICY,
  MemoryStore,
  getMemoryDir,
  getWorkSceneMemoryDir,
  PermissionStore,
  resolveAgentIdentity,
  resolveModelInfo,
  SecurityPipeline,
  setAgentIdentity,
  extractText,
  userMessage,
  validateThinkingConfig,
  withRetry,
  runAgentLoop,
  TurnContextInjector,
  TimeProvider,
  SkillStore,
  getSkillsRoot,
  renderSkillIndex,
  builtinIndexEntries,
  type SkillMode,
  type Resettable,
  type WindowLifecycle,
  type WindowChangeReason,
  resolveModelInputCapabilities,
} from "@zhixing/core";
import {
  createProviderRoles,
  ensureWorkspaceDir,
  getGlobalConfigPath,
  PROTOCOL_BUDGET_DEFAULTS,
  getModelCapabilityOverride,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  ROLE_SPECS,
  type ResolvedWorkspace,
  type WorkspaceDirStatus,
} from "@zhixing/providers";
import {
  BUILTIN_TOOL_FACTORIES,
  BUILTIN_TOOL_NAMES,
  WEB_FETCH_DEFAULT_RULES,
} from "@zhixing/tools-builtin";
import { mainProfile } from "../profile/default-profiles.js";
import type { AgentRoleProfile } from "../profile/agent-role-profile.js";
import { subscribeSegmentMarkerAccumulator } from "./segment-marker-accumulator.js";
import { subscribeWorkModeAccumulator } from "./workmode-accumulator.js";
import {
  createMainCallLLM,
  createLightCallLLM,
} from "./call-llm.js";
import { buildSystemPrompt, type SystemPromptSegment } from "./system-prompt.js";
import { prependContextBlock } from "./user-context.js";
import {
  createSecureExecuteTool,
  type OnBlockedFn,
  type OnUserDeniedFn,
} from "../security/secure-executor.js";
import { trackMessages } from "./track-messages.js";
import { runContextStorage } from "./run-context.js";
import { createTaskTool } from "../tools/task.js";
import {
  parseTaskUsageFromMessages,
  type TaskUsageEntry,
} from "../tools/task-usage.js";
import type {
  AgentRuntimeLifecycle,
  LifecycleContextBase,
  LifecycleWindowOpenContext,
  LifecycleWindowCloseContext,
  LifecycleBeforeRunContext,
  LifecycleAfterRunContext,
  WindowOpenReason,
  WindowCloseReason,
  DisposeReason,
  AttentionWindowChangeReason,
} from "./lifecycle.js";

/**
 * 注入系统提示词的技能索引上限(按当前模式 top-N)。
 *
 * 索引落在 prompt 缓存稳定前缀里,每轮都计费 —— N 越大覆盖越全但前缀越贵。
 * 个人助理的技能集天然不大,20 条足以覆盖常用;超出部分靠 usage 排序的 top-N
 * 自然让位(高频技能优先入索引),未来由技能管家(分级 / 淘汰)进一步策展。
 */
const SKILL_INDEX_TOP_N = 20;

// ─── 内部辅助 ───

/**
 * 资源清理统一防御契约 —— 所有 dispose 路径(run / forceCompact / 未来新调用点)
 * 都应通过此函数包装,保证:
 *   1. dispose throw 不再次抛出,仅记录结构化日志(防 finally 块二次 throw
 *      覆盖原始异常,丢失诊断信息);
 *   2. 多个 dispose 串联时,前一个 throw 不阻断后续(防部分订阅卸载、部分残留
 *      导致跨 run listener 累积 / 内存泄漏);
 *   3. 命名空间化日志 label 让告警可追溯到具体 dispose 失败点。
 *
 * 同步契约:dispose 必须是同步函数(返回 void),与 EventBus.off / clearInterval
 * 等无 Promise 资源的释放语义一致。若未来引入 async dispose,改返 Promise 并
 * 在调用方 await。
 */
function safeDispose(label: string, dispose: () => void): void {
  try {
    dispose();
  } catch (error) {
    console.error(`[orchestrator.${label}] dispose failed:`, error);
  }
}

/**
 * 内置 skill 索引订阅者 —— lifecycle 框架的首个消费者。每个注意力窗口开启时用
 * O(1) 版本比对决定是否重建：版本未变（绝大多数段切换）零 IO、零重算、不调接口；
 * 版本变了才 queryTopN 渲染、经公共 updateSystemPromptSegment 贡献 skill-index 段，
 * 拼装 / byte-equal / 单调提交归运行体。
 *
 * skill 索引的唯一来源是此订阅者 —— 装配期不再硬编码注入，首窗 onWindowOpen 首次
 * 贡献、运行体首次 buildSystemPrompt 即含 skill 段，单一路径无并存。
 */
function makeSkillIndexLifecycle(
  skillStore: SkillStore,
  skillMode: SkillMode,
): AgentRuntimeLifecycle {
  let builtVersion = -1; // 上次贡献所依据的 skill 版本
  return {
    id: "skill-index-rebuild",
    async onWindowOpen(ctx) {
      const cur = skillStore.version(skillMode);
      if (cur === builtVersion) return; // 已最新 → 零 IO、零重算、不调接口
      // 双池拼装:用户池(top-N)+ builtin 池(注册集按模式取,独立小额度、
      // 不挤占用户额度)。遮蔽必须用**含 disabled 的全集** id——loadText 对
      // disabled 技能仍按目录优先(禁用只影响索引可见性、指名加载仍可),
      // 若用剔 disabled 的 listAll 判遮蔽,禁用的 own 同名 fork 会让 builtin
      // 文案回到索引、加载却出用户版,展示与加载指向两份内容。builtin 随
      // 版本恒定,不参与版本比对(零开销路径不受影响)。
      const userTopN = await skillStore.queryTopN(skillMode, SKILL_INDEX_TOP_N);
      const userIds = new Set(
        (await skillStore.listForManagement()).map((record) => record.id),
      );
      const next = renderSkillIndex([
        ...userTopN,
        ...builtinIndexEntries(skillMode, userIds),
      ]);
      ctx.updateSystemPromptSegment("skill-index", next);
      builtVersion = cur;
    },
  };
}

/** 钩子错误转可读消息 —— lifecycle 失败事件 / 销毁调用方 warn 共用。 */
function lifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── 类型 ───

/**
 * 装饰器的入参 —— 当前 run 的 EventBus 与运行身份。
 *
 * 任何 UI 概念(spinner 暂停、终端清屏等)都不应进入 runtime API;
 * UI 类装饰器应通过 closure 捕获自身依赖(如 renderer 实例)在工厂层注入,
 * 保持 runtime 与展示层零耦合。
 *
 * conversationId / turnContext 透传自 run 参数——跨进程转发类装饰器据此
 * 路由事件归属(哪个对话、哪个 turn、谁发起);ephemeral / 测试路径可缺省,
 * 装饰器应对 undefined 自行分支(如:无对话身份则不转发)。
 */
export interface RunBusContext {
  bus: IEventBus<AgentEventMap>;
  conversationId?: string;
  turnContext?: TurnContext;
}

/**
 * Per-run EventBus 装饰钩子。
 *
 * runtime.run() 创建 per-run eventBus 后调用一次,装饰器挂载渲染 / 监听器,
 * 返回 dispose 函数;run() 结束 finally 调一次,杜绝 listener 跨 run 累积。
 *
 * 用例:
 *   - cli 终端路径:工厂层捕获 renderer,装饰器订阅 retry / context / interrupt
 *   - 服务端路径:不传,事件由 channel adapter 自管 RPC 推送
 *   - 子 agent 路径:不传,事件靠层级化 EventBus 冒泡
 */
export type DecorateRunBusFn = (ctx: RunBusContext) => () => void;

export interface AgentRuntime {
  providerId: string;
  model: string;
  run: (params: RunParams) => Promise<RunResult>;
  /**
   * 查询当前消息列表的上下文预算状态。
   *
   * modelInfo 由 resolveModelInfo 保证永远可用（即使是保守 fallback），
   * 因此返回非 optional —— 调用方无需处理 undefined 分支。
   */
  checkBudget: (messages: readonly Message[]) => ContextBudget;
  /** 手动触发上下文压缩，无论当前预算状态如何 */
  forceCompact: (messages: Message[], turnCount: number) => Promise<ForceCompactResult>;
  /**
   * 简易单发 LLM 文本调用（无对话历史，独立 ChatRequest 隔离）。
   * 默认 `light` 档——Journal condense 等轻量辅助任务；传 `"main"` 走主档，
   * 用于质量敏感的单发任务（如 MCP 接入的标识 → 连接方式推断）。
   */
  callText: (prompt: string, role?: "main" | "light") => Promise<string>;
  /** 当前消息列表里的 Task/sub-agent 用量拆分(/usage 的结构化数据面)。 */
  subAgentUsages: (messages: readonly Message[]) => readonly TaskUsageEntry[];
  /** 当前运行体安全状态只读快照（/security 的宿主数据面）。 */
  securitySnapshot: () => RuntimeSecuritySnapshot;
  /** 当前 Token 估算器的校准因子（1.0 = 未校准） */
  readonly calibrationFactor: number;
  /** 安全管线（用于 /trust /security 命令访问权限规则、审计日志等） */
  readonly securityPipeline: SecurityPipeline;
  /** 权限规则存储的快捷访问 */
  readonly permissionStore: IPermissionStore;
  /**
   * 确认交互 broker——会话级单例，跨多次 run() 共享队列和 grace period。
   * REPL 负责 attach 一个 TerminalConfirmationRenderer 到它。
   */
  readonly confirmationBroker: IConfirmationBroker;
  /** 解析后的工作区信息（路径 + 来源），供启动展示和 RuntimeContext 使用 */
  readonly resolvedWorkspace: ResolvedWorkspace;
  /** 工作区目录状态（exists/created/skipped），供启动展示区分场景 */
  readonly workspaceDirStatus: WorkspaceDirStatus;
  /** 注册 per-turn 上下文 provider（如 SchedulerProvider），支持后注册 */
  registerTurnContextProvider(provider: TurnContextProvider): void;
  /**
   * 注册"对话级"可重置组件 —— `/clear` 时一并清空。
   *
   * 任何在会话期间持有对话级状态的组件实现 Resettable 后在 runtime 装配时注册
   * 一次，无需 cli 在 /clear handler 里硬编码各 state 的 reset 调用。
   *
   * 多次注册按注册顺序累积；reset 按 LIFO 串行执行（让后注册组件先 reset，给"被
   * 后注册组件依赖"的前注册组件留下还能被读取的窗口）。
   */
  registerConversationStateReset(target: Resettable): void;
  /**
   * 触发所有已注册组件 reset 自身对话级状态。
   *
   * 调用时机：cli `/clear` 在持久层 appendClear 之后调一次；
   * server 在 conversation 切换 / 重置场景按需调。
   *
   * 失败语义：单个 Resettable 抛错 → 收集到聚合错误数组继续后续 reset，
   * 全部跑完后再统一抛 ResetConversationStateError（含失败的 ids）。
   * 调用方决定是否阻塞 /clear 完成 —— 多数情况吞错继续即可（state 已部分清，
   * 内存语义已是"清空"，下次 LLM call 仍会按新视图编排）。
   */
  resetConversationState(): Promise<void>;
  /**
   * 销毁运行体实例 —— 触发末窗 onWindowClose（reason 透传销毁类型）。幂等
   *（重复调第二次起 no-op，reason 取首次）。运行体内部本无需释放的资源（全
   * in-memory），dispose 的存在意义是承载末窗 onWindowClose。
   *
   * 失败语义：onWindowClose 抛错不阻断销毁链 —— 全部跑完后若有失败,聚合抛
   * {@link LifecycleHookError} 让销毁调用方 warn（cli writer.notify）,不押 console。
   */
  dispose(reason: DisposeReason): Promise<void>;
  /**
   * run 外注意力窗口换代（/clear · /resume）—— 旧窗 onWindowClose → 新窗
   * onWindowOpen，更新实例权威 prompt（下个 run 入口 capture 到新值）。失败聚合
   * 抛 {@link LifecycleHookError}。run 内换代（段切换 / compact）不走此入口,由
   * agent-loop 的 windowLifecycle.onChange 驱动。
   */
  onAttentionWindowChange(reason: AttentionWindowChangeReason): Promise<void>;
}

export interface RuntimeSecuritySnapshot {
  readonly contextId: PermissionContextId;
  readonly workspacePath: string | null;
  readonly permissionRules: readonly PermissionRule[];
  readonly builtinRules: readonly SecurityRule[];
  readonly rateLimits: readonly { key: string; used: number; limit: number }[];
  readonly confirmations: readonly {
    key: string;
    count: number;
    highestRisk: RiskLevel;
  }[];
}

export interface ForceCompactResult {
  modified: boolean;
  messages: Message[];
  /** 压缩后的预算快照（modelInfo 由 resolver 保证可用，必填） */
  budget: ContextBudget;
  /**
   * 强制段切换产出的窗口重构指令（切段成功时非空——含应急地板的机械降级）。
   *
   * 消费者：REPL /compact 把它交给注意力窗口折叠（applyCompact），并按
   * 折叠交出的覆盖锚写派生快照——压缩是窗口的视图操作，不落盘 transcript。
   *
   * 为什么 optional：摘要失败且未达风险线、或无可压缩内容时切段不发生，
   * 窗口不该折叠。调用方应判断此字段存在再动窗口。
   */
  windowCompact?: WindowCompact;
  /**
   * 应急地板降级信息 —— 摘要 LLM 失败、切段以机械保尾截断完成时携带
   * （正常摘要切段缺省）。与自动路径的 segment:emergency_floor 事件同语义：
   * 调用方据此向用户呈现降级方式与代价（先方式与代价、后结果），不让
   * 有损截断伪装成正常摘要。
   */
  emergencyFloor?: { droppedTurns: number; error: string };
}

export interface RunParams {
  messages: Message[];
  /**
   * 本 turn 序号 —— 由调用方维护的 counter，进生命周期钩子上下文
   * （LifecycleBeforeRunContext / LifecycleAfterRunContext）供订阅者观测。
   *
   * - REPL: `state.turnCounter`（每次持久化成功后 +1）
   * - server: `ManagedSession.turnCount`
   * - ephemeral / 单次运行：0
   */
  turnIndex: number;
  /**
   * 当前 conversation id —— 透传到 runContextStorage，工具按需取（用于
   * 在持久化会话中区分写入目标 / 读取上下文）。
   *
   * 可选：ephemeral 路径（定时任务 / 单测 fixture）省略；
   * 工具收到 undefined 时显式分支处理（拒绝执行 / graceful degrade）。
   */
  conversationId?: string;
  /** 触发源，落盘为 run record 的 source 字段。不指定时字段为 undefined */
  source?: TurnSource;
  /** 推进侧代理 run 的产品层元数据；不进入 Message role/content */
  advancement?: RunRecordAdvancementMetadata;
  onYield?: (event: AgentYield) => void;
  /**
   * Turn 级上下文。channel 会话传入含 commitToUser；
   * REPL / 定时任务 ephemeral turn 省略。字段进入每个工具调用的
   * ToolExecutionContext（turnId / emissionTarget / commitToUser）。
   */
  turnContext?: TurnContext;
  /**
   * Abort 信号 —— 透传到 agent-loop 与段切换内的 LLM 调用。
   * 上游来源：SessionRuntime.abort()、用户 /abort、daemon grace timer。
   * 未设置时所有 LLM 调用无限制运行。
   */
  abortSignal?: AbortSignal;
  /**
   * stream 看门狗策略 —— 控制 LLM 流 chunk 间隔的 idle-timer 行为。
   *
   * 缺省时本层注入 `DEFAULT_WATCHDOG_POLICY`(60s idle, 50% warn)。这是契约规定的
   * **唯一** fallback 注入点 —— agent-loop 内部不再二次 fallback。
   *
   * 调用方显式传入(包括 `createWatchdogPolicy({ idleTimeoutMs: 0 })` 禁用 idle-timer)
   * 时一路透传到看门狗,不被默认值覆盖。配置错误的 policy(如 warnThresholdRatio 超出
   * 开区间)应通过 createWatchdogPolicy 工厂构造,在创建期 throw 而非运行期失败。
   */
  watchdog?: WatchdogPolicy;
}

// RunResult 从 @zhixing/core 统一（单一事实源）。
// cli 的 AgentRuntime.run 和 server 的 SessionRuntime.run 共享此契约。
export type { RunResult };

/**
 * resetConversationState 失败聚合异常 —— 单个 Resettable 抛错不阻断其它 reset，
 * 全跑完再抛此聚合异常让调用方决定吞错 / 升级 / UI 提示。
 */
export class ResetConversationStateError extends Error {
  readonly failures: ReadonlyArray<{ id: string; error: unknown }>;

  constructor(failures: ReadonlyArray<{ id: string; error: unknown }>) {
    const ids = failures.map((f) => f.id).join(", ");
    super(`resetConversationState 失败：${ids}`);
    this.name = "ResetConversationStateError";
    this.failures = failures;
  }
}

/**
 * 末窗 / run 外换代的 onWindowClose / onWindowOpen 失败聚合异常 —— 单个订阅者
 * 抛错不阻断销毁链 / 换代后续,全跑完再抛此聚合异常让销毁 / 命令调用方 warn
 *（cli writer.notify,不沿用 console）。
 */
export class LifecycleHookError extends Error {
  readonly phase: string;
  readonly failures: ReadonlyArray<{ id: string; error: unknown }>;

  constructor(
    phase: string,
    failures: ReadonlyArray<{ id: string; error: unknown }>,
  ) {
    const ids = failures.map((f) => f.id).join(", ");
    super(`生命周期钩子 ${phase} 失败：${ids}`);
    this.name = "LifecycleHookError";
    this.phase = phase;
    this.failures = failures;
  }
}

export interface CreateAgentRuntimeOptions {
  /**
   * 工作区：
   *   - string   → 运行时显式工作区覆盖(如工作场景 workdir)，经 resolveWorkspace 正常解析
   *   - undefined → 无运行时覆盖，resolveWorkspace 按配置/兜底
   *   - null     → **显式无工作区**（无 workdir 的工作场景）：跳过
   *     resolveWorkspace，直接 { path:null, source:"none" }，且
   *     workingDirectory 不兜底 cwd —— 与 powerProfile 无文件工具二分
   *     互为纵深，by-construction 杜绝串到 cwd / 主工作区
   */
  workspace?: string | null;
  /** 额外工具（如 schedule），在内置工具之后注入 */
  extraTools?: ToolDefinition[];
  /**
   * 确认超时降级策略，透传给 secure-executor。默认 "deny"。
   * 参见 remote-confirmation-execution.md。
   */
  confirmationFallback?: ConfirmationFallbackStrategy;
  /** Per-run EventBus 装饰钩子,详见 {@link DecorateRunBusFn} */
  decorateRunBus?: DecorateRunBusFn;
  /**
   * 工具被 SecurityPipeline 阻止时的 UI 通知钩子。
   * cli 路径注入终端渲染;服务端 / 子 agent 路径不传,静默处理(事件仍走 EventBus)。
   */
  onSecurityBlocked?: OnBlockedFn;
  /**
   * 用户在 confirmation 面板选择拒绝时的 UI 通知钩子。
   * cli 路径注入终端渲染;服务端 / 子 agent 路径不传。
   */
  onUserDenied?: OnUserDeniedFn;
  /**
   * 角色 profile —— 决定 system prompt 身份段 + 工具集装配。
   *
   * 默认 mainProfile()。可传入预定义 profile（mainProfile / subAgentProfile）
   * 或自定义 profile；profile.enabledTools 是工具装配的唯一权威源。
   *
   * Task 工具的装配条件：profile.enabledTools 含 "Task"。Task 工具 closure capture
   * 装配期已知的服务（provider / pipeline / broker / 当前工具集 snapshot 等），
   * per-run 上下文通过 runContextStorage 传递。
   */
  profile?: AgentRoleProfile;
  /**
   * 个人记忆域作用域 —— 装配期据此解析整域 root，构造单一 MemoryStore
   * （memory 工具 + flush strategy 共用），后续不可变。缺省 personal
   * （root = getMemoryDir()，对外行为与历史一致）。
   */
  memoryScope?:
    | { kind: "personal" }
    | { kind: "workscene"; sceneId: string };
  /**
   * 技能库 store —— 缺省时内部按全局库根(~/.zhixing/skills)自建一个。
   *
   * cli 注入会话级单一实例,使 runtime 的索引读 / load_skill 与 cli 侧的 /<name>
   * 唤醒、技能管理面板共享同一锁域(index.json 读改写串行),从根上杜绝跨实例
   * 并发写丢更新。serve / 测试等无 cli 面板的路径不传,走内部
   * 自建即可(技能为全局、库根固定,实例无状态、无生命周期负担)。
   */
  skillStore?: SkillStore;
  /**
   * 主对话槽位 —— 缺省 "main"。决定主对话语义六处（capability /
   * Task provider+model / budget resolveModelInfo / 返回 providerId+model /
   * resilientCallLLM / runAgentLoop）取 roles[primaryRole]，及主对话 loop +
   * Task 子 agent loop 的思考解析跟随；单发调用域按性质分流（callText main
   * →roles.main / MemoryFlush+callText→roles.light / 段切换→roles.light，
   * 详见 secondary-llm-capability ADR-SLLM-009）不随 primaryRole 漂移，
   * roleThinking 三角色映射为真实 per-role 不跟随。
   * 工作模式装配 power runtime 时传 "power"。
   */
  primaryRole?: "main" | "power";
  /**
   * 可选：注入会话级 PermissionStore——跨 hot reload 复用 session scope 授权
   * （用户的"本次会话允许"不丢）。
   *
   * 不传时内部 new 一个新实例（向后兼容现有调用方）。
   *
   * 注：装配期 `registerBuiltinRules("web_fetch", ...)` 是幂等的（同 namespace 覆盖式
   * 注册），同一注入 store 被多次 register 不会累积重复规则。
   */
  permissionStore?: IPermissionStore;
  /**
   * 段切换外部依赖 —— cli 装配层注入 task_list 读取 + 持久化实现。
   *
   * orchestrator 内部用此 + 解析自身的依赖（provider / capability / estimator /
   * per-run eventBus）构造 SegmentManager，按 turn 边界透传给 agent-loop。
   *
   * 缺省时 SegmentManager 不构造、不透传，agent-loop 走 budget-only 兜底路径
   * 。这让小型/极简集成（如纯测试 runtime）
   * 不必装配段切换也能跑通；段切换是 cli 装配层的产品能力，不是 runtime 必需。
   */
  segmentDeps?: {
    readonly taskListReader: TaskListReader;
    readonly persistence: SegmentPersistence;
  };
  /**
   * 运行体生命周期钩子订阅者集合 —— 装配期注入、实例内恒定（注册单位是实例，
   * 触发单位是注意力窗口 / run）。内置 skill 索引重建订阅者默认置于列表首位，
   * 此处传入的订阅者追加其后。第一版不做运行时 register（首窗语义需装配期注入）。
   */
  lifecycle?: readonly AgentRuntimeLifecycle[];
}

/**
 * 装配期解析某 role 的**生效**思考控制 —— 三条 ChatRequest 构造路径
 * （主对话 / 压缩 flush / 段切换摘要）统一经此注入，杜绝散落分支。
 *
 * 兜底语义（绝不向请求注入无效思考参数）：
 *   - 未配置 → undefined（不发送思考参数，服务端用自身默认，确定安全）
 *   - model 在 catalog 内：按其 thinkingControl（缺省等价 none）校验配置形态，
 *     不相容（如换 model 后旧配置残留）→ warn + undefined
 *   - model 不在 catalog 内（网关型 provider 返回 []，无法证伪）→ 透传，
 *     交由 adapter 的 provider 思考方言作终判（用户主权范畴）
 */
function resolveRoleThinking(
  role: LLMRole,
  configured: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (configured === undefined) return undefined;
  const modelInfo = role.provider.models.find((m) => m.id === role.model);
  if (modelInfo === undefined) return configured;
  const control = modelInfo.thinkingControl ?? { type: "none" };
  if (validateThinkingConfig(configured, control)) return configured;
  console.warn(
    `[zhixing] 模型 ${role.model} 不支持所配置的思考控制形态，已忽略该思考配置`,
  );
  return undefined;
}

// ─── 创建运行时 ───

/**
 * 创建一个 Agent 运行时。运行时持有 Provider/Tools/EventBus 实例，
 * 可多次调用 run() 执行不同的对话。
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const { roles, config, resolvedRoles } = createProviderRoles();

  // 可选角色降级（显式配了 light/power 但其 provider 凭证/配置缺失）——
  // 已回退 main，不阻断启动；此处打一次可见的非致命告警，保留"不静默掩盖
  // 用户期望的多 provider 架构"这一关切（与上方思考配置降级同址同范式）。
  // `?? []` 是刻意的韧性边界：降级告警是最佳努力诊断，绝不能因其缺失/异常
  // 反过来令 agent 创建崩溃（真实 resolveLLMRoles 恒返回数组，仅测试替身可能省略）。
  for (const d of resolvedRoles.degradations ?? []) {
    const label =
      ROLE_SPECS.find((s) => s.id === d.role)?.labelZh ?? d.role;
    console.warn(
      `[zhixing] ${label} 配为 ${d.configured.provider} · ${d.configured.model} 但${d.reason}，已回退主模型（不影响启动；如需该角色请在配置中补全或移除该段）`,
    );
  }

  // 主对话槽位 —— 决定主对话语义六处取哪个 role（capability / Task
  // provider+model / budget resolveModelInfo / 返回 providerId+model /
  // resilientCallLLM / runAgentLoop）+ loop 思考解析跟随。压缩域按 task 分流
  // （callText main→main / 记忆提取+callText→light / 段切换→light，详见
  // secondary-llm-capability ADR-SLLM-009）不跟随、roleThinking 三角色聚合
  // 不跟随（见下）。缺省 main，工作模式装配传 power。
  const primaryRole = options.primaryRole ?? "main";

  // 应用级身份单例：启动时设一次，后续所有 user-facing 字符串通过
  // getAgentIdentity() 读取。默认 "知行"，可通过全局 config.jsonc
  // 的 agent.displayName 覆盖。
  setAgentIdentity(resolveAgentIdentity(config.agent));

  const cwd = process.cwd();

  // 工作区解析：按优先级链运行时显式覆盖 > 全局配置 > cwd 兜底
  const sessionType = resolveWorkspaceSessionType();
  // workspace === null：显式无工作区（无 workdir 工作场景），跳过解析、
  // 直接 source:"none"；否则按优先级链 resolveWorkspace。
  const workspace: ResolvedWorkspace =
    options.workspace === null
      ? { path: null, source: "none" }
      : resolveWorkspace(config, {
          runtimeWorkspace: options.workspace,
          sessionType,
        });

  // 确保工作区目录存在（首次启动自动创建，目录被删除则重建）
  const workspaceDirStatus = ensureWorkspaceDir(workspace);

  // 角色 profile —— 决定工具集与身份段。enabledTools 是装配的唯一权威源。
  const profile = options.profile ?? mainProfile();

  // baseTools = profile.enabledTools 中的 builtin + options.extraTools，
  // **不含 Task** —— Task 装配依赖 securityPipeline / confirmationBroker
  // （都在下方装配），需要后置追加。
  //
  // 装配两步走：
  //   1. profile.enabledTools 中的 builtin 工具名 → BUILTIN_TOOL_FACTORIES 实例化
  //      （含 "Task" 则跳过本步骤，由后续装配块处理；含未注册 builtin 名 fail-fast）
  //   2. options.extraTools 全部追加（cli 注入的外部依赖工具如 schedule，
  //      由 cli 持有所需 ref 在外部实例化后传入）
  //
  // baseTools 是 SecurityPipeline / BoundaryRegistry / ToolArgumentExtractor
  // 的注册输入（Task 工具 needsPermission: false 且无 boundaries，不参与
  // 这些链路）。
  // 个人记忆域 scope 解析 —— 装配期唯一解析点。从 memoryScope 定整域 root
  // （personal = getMemoryDir() Layer-A 正确默认；workscene = 该场景 me/ 域），
  // 据此构造**单一** MemoryStore（memory 工具 + flush strategy 共用，消除双
  // 实例）。runtime 生命周期内不变。
  const memoryRoot =
    options.memoryScope?.kind === "workscene"
      ? getWorkSceneMemoryDir(options.memoryScope.sceneId)
      : getMemoryDir();
  const memoryStore = new MemoryStore(memoryRoot);

  // 技能分区跟随场景,与记忆域同源于 memoryScope —— "工作场景"这一个轴同时定
  // 记忆域与技能区:工作场景注入 work 区技能,个人对话注入 main 区。SkillStore
  // 是技能库唯一磁盘访问点(库根固定 ~/.zhixing/skills,不随场景隔离 —— 技能跨
  // 场景共享,只按 mode 分区注入),load_skill 工具与索引段共用此实例。
  const skillMode: SkillMode =
    options.memoryScope?.kind === "workscene" ? "work" : "main";
  const skillStore = options.skillStore ?? new SkillStore(getSkillsRoot());

  // 思考控制装配期一次性解析（runtime 生命周期内 config + 解析后的 role 均不变，
  // 无需 per-run 重算）。三类用途严格分区：
  //   - roleThinking ：**真实 per-role 映射**（每个 role 按其自身 config 解析），
  //     沿 llmRoles 同路径下传 ToolExecutionContext 供工具按所用角色扇出；
  //     不跟随 primaryRole（工具调 ctx.llm.light 就该拿 light 的思考配置）
  //   - primaryThinking：主对话 loop + Task 子 agent loop（二者均跑
  //     roles[primaryRole] 单 model）→ 取 roleThinking[primaryRole]
  //   - lightThinking ：MemoryFlush + callText + 段切换摘要（恒走 roles.light，
  //     不跟 primaryRole；质量敏感单发（callText main）走 roles.main 用 mainThinking，
  //     见 secondary-llm-capability ADR-SLLM-009）
  // 构造位置先于 builtinCtx：单发通道（mainCallLLM）要直接注入工具上下文
  // （admit_skill 的独立裁判通道），零 lazy 间接层。
  const roleThinking: ResolvedRoleThinking = {
    main: resolveRoleThinking(roles.main, config.llm?.main?.thinking),
    light: resolveRoleThinking(roles.light, config.llm?.light?.thinking),
    power: resolveRoleThinking(roles.power, config.llm?.power?.thinking),
  };

  // 单发文本 LLM 调用按档位分流到不同角色——质量敏感单发（callText "main"）
  // 走 main，记忆提取与 callText 默认档走 light（I/O 边界结构化数据净化）。
  // 详见 call-llm.ts 的设计注释。
  const mainCallLLM = createMainCallLLM(roles, roleThinking.main);
  const lightCallLLM = createLightCallLLM(roles, roleThinking.light);

  const builtinCtx = {
    proxy: config.network?.proxy,
    memoryStore,
    skillStore,
    skillMode,
    // 接入审查独立裁判：绑 main 档单发（质量敏感安全裁决）、不带对话上下文
    admissionLlm: (prompt: string) => mainCallLLM([userMessage(prompt)]),
  };
  const baseTools: ToolDefinition[] = [];
  for (const name of profile.enabledTools) {
    if (name === "Task") continue; // 后置装配
    if (!BUILTIN_TOOL_NAMES.has(name)) {
      throw new Error(
        `AgentRoleProfile "${profile.role}" 声明的工具 "${name}" 不在 BUILTIN_TOOL_FACTORIES。` +
          `profile.enabledTools 仅可声明内置工具名 + "Task"；外部依赖工具（如 schedule）` +
          `通过 options.extraTools 注入。`,
      );
    }
    baseTools.push(BUILTIN_TOOL_FACTORIES[name]!(builtinCtx));
  }
  baseTools.push(...(options.extraTools ?? []));

  // 安全管线：会话级单例，跨多次 run() 共享权限规则、确认追踪、频率限制状态。
  //
  // BoundaryRegistry / ToolArgumentExtractor 均走"启动时 snapshot"路径
  // (`fromTools(tools)`)，把 boundaries / permissionArgumentKey 声明从工具
  // 自描述映射到 security 基础设施。运行时工具集变更（MCP 连接等）走 reload
  // 整体重建后重新 fromTools，不走 in-place 增删（故无 unregister）。
  //
  // boundary registry 内容：read/write/edit/glob/grep/bash 走 context classifier、
  // 不声明 boundaries；memory/schedule（app-state）、web_fetch（network）、MCP 工具
  // （external-service）等声明边界的工具进 registry。tool-aware extractor 让
  // PermissionStore.match 按工具声明的 permissionArgumentKey 提参，避免多 string
  // 字段工具的字段顺序歧义。
  const toolArgumentExtractor: IToolArgumentExtractor =
    ToolArgumentExtractor.fromTools(baseTools);
  // 注入式优先：caller 跨 reload 复用 session scope 授权（store 已在首次创建时 init
  // 过 builtin 规则，此处跳过避免重复）；不传时内部 new 一个并 init builtin。
  //
  // builtin 规则归属：每工具 namespace 自管，用户池任一命中将完全决定结果
  // （builtin 不参与），保证用户最终决定权。未来子 agent / MCP 等模块以同样模式扩展：
  // `store.registerBuiltinRules(ns, rules)`。
  const persistentStore: IPermissionStore =
    options.permissionStore ??
    (() => {
      const fresh = new PermissionStore({
        extractArgument: (req) => toolArgumentExtractor.extract(req),
      });
      fresh.registerBuiltinRules("web_fetch", [...WEB_FETCH_DEFAULT_RULES]);
      return fresh;
    })();
  const boundaryRegistry: MutableToolBoundaryRegistry =
    BoundaryRegistry.fromTools(baseTools);
  const securityPipeline = new SecurityPipeline({
    // 工作场景实例用场景信任(会话锚:整会话生效、跟场景身份而非 workdir 偶然
    // 共享)——allow-context 沉淀进 scene 上下文,与 /trust 的场景语境视角同源。
    // workdir 仍经 workspace 解析承载文件操作根,与信任锚正交。
    // 非场景实例维持路径锚:有工作区即 workspace 信任,否则 global。
    trustContext:
      options.memoryScope?.kind === "workscene"
        ? { kind: "scene", sceneId: options.memoryScope.sceneId }
        : workspace.path !== null
          ? { kind: "workspace", dir: workspace.path }
          : { kind: "global" },
    sessionType,
    permissionStore: persistentStore,
    toolBoundaryRegistry: boundaryRegistry,
  });

  // 确认交互 broker：会话级单例。渲染器由 REPL 在 attach 时注入。
  const confirmationBroker = new ConfirmationBroker();

  // tools = baseTools + (可选 Task 工具)。Task 装配时 capture 装配期已知的
  // 共享服务 + 当前 baseTools snapshot 作为子工具池来源(子按 sub-agent
  // profile.enabledTools 过滤后派生)。防递归: sub-agent profile 不含 "Task",
  // 子 agent 装配时 Task 自然不在 childTools 中。
  //
  // per-run 的 eventBus / lineage 由 runtime.run() 入口的 runContextStorage.run
  // 包裹建立,Task closure call() 时取用 —— 与本装配期解耦,无 mutable runtime 字段。
  //
  // boundary 后注册:Task 装配晚于 BoundaryRegistry.fromTools(baseTools),其
  // boundaries 必须显式 register 进 mutable registry,否则 BoundaryImpactClassifier
  // 找不到 → fail-closed → critical → 在 ci 模式下被 PermissionMatcher block。
  // 这同时是 MCP / 动态插件接入路径的统一模式,不是 Task 专用 hack。
  // ModelCapability 解析 —— Task 工具 + segmentManager 共用同源 capability。
  // 优先级:用户 modelCapabilityOverrides[model] > 内置 MODEL_CAPABILITIES > UNKNOWN 兜底。
  // map key / model ID 双向 normalize(剥 vendor 前缀 + 大小写无关),用户任意形式都命中。
  const primaryModelCapability = resolveModelCapability(
    roles[primaryRole].model,
    getModelCapabilityOverride(
      config.modelCapabilityOverrides,
      roles[primaryRole].model,
    ),
  );

  // 思考控制与单发通道已在装配早期构造（builtinCtx 之前,见上）;此处仅派生
  // 主对话档与 light 档别名供下游消费。
  const primaryThinking = roleThinking[primaryRole];
  const lightThinking = roleThinking.light;

  let tools: ToolDefinition[] = baseTools;
  if (profile.enabledTools.includes("Task")) {
    const taskTool = createTaskTool({
      // 子 agent 复用父 primaryRole 的 provider+model；其自身 loop 思考 =
      // primaryThinking（与该 model 配对）；roleThinking 映射供子工具按角色扇出。
      provider: roles[primaryRole].provider,
      model: roles[primaryRole].model,
      loopThinking: primaryThinking,
      roleThinking,
      llmRoles: roles,
      securityPipeline,
      workspace: workspace.path,
      workspaceSource: workspace.source,
      globalConfigPath: getGlobalConfigPath(),
      parentBroker: confirmationBroker,
      parentTools: baseTools,
      // sub-agent 复用父 primaryRole model,riskMaxTokens 从同一 capability 解析
      riskMaxTokens: primaryModelCapability.riskMaxTokens,
    });
    tools = [...baseTools, taskTool];
    if (taskTool.boundaries && taskTool.boundaries.length > 0) {
      boundaryRegistry.register(taskTool.name, taskTool.boundaries);
    }
  }

  // ─── 系统提示词的双层 holder + 注意力窗口生命周期钩子 ───
  //
  // systemPrompt 后置到 tools 装配之后 —— Task 工具描述需进 ## Tool Usage 段,LLM
  // 才能学习"何时派 Task / 何时直接调单工具"。
  //
  // 生效 systemPrompt 不是装配期一个 const,而是双层 holder（prompt cache 死线的
  // 承重设计,本意见 skill-system.md §3.1 / lifecycle-concepts.md / buildSystemPrompt
  // 的"调用契约"注释）:
  //   - 实例权威 prompt + 实例级段覆盖,由实例级窗口换代维护（首窗 / clear / resume
  //     / reload）,供新 run 起步快照;
  //   - 每个 run 入口 capture 一份本 run 局部 prompt（run() 内）,agent-loop 每个 LLM
  //     call 经 getSystemPrompt 现取它。
  // 窗口内 byte-equal 靠 run 局部私有成立;并发 run 各自换代互不干扰（一个 run 的
  // 窗口重建绝不改另一 in-flight run 的生效 prompt）;窗口跨多 run 靠 run 入口
  // capture 实例权威延续值 byte-equal。tools[] 装配一次冻结（reload 级、比注意力
  // 窗口更强）,任何阶段不增删改;per-turn 信息走 turn-context 注入、不进 systemPrompt。
  //
  // 数据驱动段（skill-index）的内容不在装配期硬编码,而由 onWindowOpen 订阅者经公共
  // updateSystemPromptSegment 贡献 —— 首窗首次贡献、首次 buildSystemPrompt 即含该段
  //（单一路径,无装配期与订阅者并存）。固定段输入（profile / tools / cwd / workspace,
  // 运行体生命周期内不变）装配期 capture,与段覆盖一起喂 buildSystemPrompt 重拼。
  const runtimeId = randomUUID();
  const lifecycle: readonly AgentRuntimeLifecycle[] = [
    makeSkillIndexLifecycle(skillStore, skillMode),
    ...(options.lifecycle ?? []),
  ];
  const fixedPromptInputs = {
    profile,
    tools,
    cwd,
    workspace: workspace.path,
    workspaceSource: workspace.source,
    globalConfigPath: getGlobalConfigPath(),
  };
  const buildPrompt = (
    overrides: Partial<Record<SystemPromptSegment, string | null>>,
  ): string =>
    buildSystemPrompt({ ...fixedPromptInputs, segmentOverrides: overrides });

  // 实例级 holder（所有 run 共享）—— authoritativePrompt 由首窗 onWindowOpen 建立。
  const instanceSegmentOverrides: Partial<
    Record<SystemPromptSegment, string | null>
  > = {};
  let authoritativePrompt = "";
  // 单调提交：实例权威只接受"更晚换代"的贡献,不被滞后并发 run 回退。windowEpoch
  // 按换代触发顺序递增分配,instanceEpoch 记已提交进实例级的最大 epoch。
  let instanceEpoch = 0;
  let windowEpochCounter = 0;
  // windowIndex 实例内自增（首窗 0）。仅用于钩子归属 / 日志,并发下不要求精确。
  let windowCounter = 0;
  // run 入口窗口判据：记录上个 run 入口时所在窗口 index，算 isWindowFirstRun
  //（当前窗口 != 上次入口窗口 → 本 run 是该窗口首个 run）。-1 = 尚无 run 入口。
  let lastRunEntryWindowIndex = -1;

  const lifecycleBase = (): LifecycleContextBase => ({
    runtimeId,
    mode: skillMode,
    sceneId:
      options.memoryScope?.kind === "workscene"
        ? options.memoryScope.sceneId
        : undefined,
    providerId: roles[primaryRole].provider.id,
    model: roles[primaryRole].model,
  });

  // 实例级窗口开启 —— 首窗（instance-start）/ run 外换代（clear / resume / reload）。
  // 订阅者经 ctx 写实例级段覆盖,全部跑完后重拼实例权威。collectFailures:
  //   false（首窗）→ 订阅者抛错直接传播（让 createAgentRuntime 失败、安全回滚）;
  //   true（run 外换代）→ 收集失败返回（命令调用方 warn、不阻断后续订阅者）。
  const openInstanceWindow = async (
    reason: WindowOpenReason,
    collectFailures: boolean,
  ): Promise<Array<{ id: string; error: unknown }>> => {
    const windowIndex = windowCounter++;
    const failures: Array<{ id: string; error: unknown }> = [];
    const ctx: LifecycleWindowOpenContext = {
      ...lifecycleBase(),
      reason,
      windowIndex,
      updateSystemPromptSegment(segment, content) {
        instanceSegmentOverrides[segment] = content;
      },
    };
    for (const sub of lifecycle) {
      if (collectFailures) {
        try {
          await sub.onWindowOpen?.(ctx);
        } catch (err) {
          failures.push({ id: sub.id, error: err });
        }
      } else {
        await sub.onWindowOpen?.(ctx);
      }
    }
    instanceEpoch = ++windowEpochCounter;
    authoritativePrompt = buildPrompt(instanceSegmentOverrides);
    return failures;
  };

  // 实例级窗口关闭钩子 —— 末窗（dispose）/ run 外换代旧窗。收集失败返回（不抛、
  // 不阻断后续订阅者）,由调用方聚合处理。run 内换代的旧窗 close 走 windowLifecycle
  //（per-run bus emit 通道,不复用此处）。
  const runCloseHooks = async (
    reason: WindowCloseReason,
    windowIndex: number,
  ): Promise<Array<{ id: string; error: unknown }>> => {
    const ctx: LifecycleWindowCloseContext = {
      ...lifecycleBase(),
      reason,
      windowIndex,
    };
    const failures: Array<{ id: string; error: unknown }> = [];
    for (const sub of lifecycle) {
      try {
        await sub.onWindowClose?.(ctx);
      } catch (err) {
        failures.push({ id: sub.id, error: err });
      }
    }
    return failures;
  };

  let disposed = false;

  // 实例销毁 —— 末窗 onWindowClose（幂等;抛错不阻断销毁链,全跑完聚合抛）。
  const dispose = async (reason: DisposeReason): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const failures = await runCloseHooks(reason, windowCounter - 1);
    if (failures.length > 0) {
      throw new LifecycleHookError("dispose", failures);
    }
  };

  // run 外注意力窗口换代（/clear · /resume · /compact）—— 旧窗 close → 新窗
  // open、更新实例权威。close + open 失败聚合抛,不阻断换代后续。
  const onAttentionWindowChange = async (
    reason: AttentionWindowChangeReason,
  ): Promise<void> => {
    const closeFailures = await runCloseHooks(reason, windowCounter - 1);
    const openFailures = await openInstanceWindow(reason, true);
    const failures = [...closeFailures, ...openFailures];
    if (failures.length > 0) {
      throw new LifecycleHookError("onAttentionWindowChange", failures);
    }
  };

  // Per-turn 上下文注入器：时间 + 后续注册的 provider（如 scheduler）
  const turnContextInjector = new TurnContextInjector();
  turnContextInjector.register(
    new TimeProvider(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );

  // 解析模型预算信息 —— resolver 保证 info 永不为 undefined。
  // 数据源四层（高 → 低）：
  //   1. modelOverrides[model]                — 用户精调
  //   2. provider.models.find(id===model)     — declared catalog 命中
  //   3. PROTOCOL_BUDGET_DEFAULTS[protocol]   — 协议族默认（网关型 provider 兜底）
  //   4. CONSERVATIVE_FALLBACK                — defensive 兜底（生产路径不应触达）
  // estimator 跨 run() 共享以保持校准状态。
  const resolvedModel = resolveModelInfo({
    providerId: roles[primaryRole].provider.id,
    model: roles[primaryRole].model,
    providerModels: roles[primaryRole].provider.models,
    overrides: resolvedRoles[primaryRole].resolved.modelOverrides,
    protocolDefaults:
      PROTOCOL_BUDGET_DEFAULTS[resolvedRoles[primaryRole].resolved.protocol],
  });
  for (const w of resolvedModel.warnings) {
    console.warn(`[zhixing] ${w.message}`);
  }
  const modelBudgetInfo = resolvedModel.info;
  const modelInputCapabilities = resolveModelInputCapabilities({
    model: roles[primaryRole].model,
    providerModels: roles[primaryRole].provider.models,
    overrides: resolvedRoles[primaryRole].resolved.modelInputCapabilities,
  });
  const estimator = createTokenEstimator();

  // 对话级 Resettable 注册表 —— 视图层 stage 实现 Resettable 后在装配期注册，
  // /clear 一并清空。
  const resettables: Resettable[] = [];

  // 记忆提取 —— 挂在段切换 afterSummarize：内容被摘要
  // 替代、离开注意力窗口之时正是从原文蒸馏长期记忆的自然时刻。提取核心
  // （MemoryFlusher）装配期单例，hook 跨 run 共享（无状态）。
  const memoryFlushHook = createMemoryFlushHook({
    flusher: new MemoryFlusher({
      callLLM: lightCallLLM,
      store: memoryStore,
    }),
  });

  // 段切换摘要的流装配工厂 —— run 内评估与手动 forceCompact 共用同一条
  // 保护链（withRetry 重试降级 → watchdog idle 看门狗 → calibration 估算校准），
  // 杜绝两处装配漂移。bus 按调用方传入（run 用 per-run bus，forceCompact 用
  // 本地 bus），重试与看门狗事件随之归属正确的事件流。
  const makeSegmentStreamFactory = (
    bus: IEventBus<AgentEventMap>,
    watchdog: WatchdogPolicy,
  ): SegmentStreamFactory => {
    const callWithRetry = withRetry(
      (request) => roles[primaryRole].provider.chat(request),
      { eventBus: bus },
    );
    return (req) => {
      // 上游 abortSignal 桥接到段切换内部 controller：让 watchdog idle
      // 触发和上游 abort 共享同一 cancel 通道
      const controller = new AbortController();
      if (req.abortSignal) {
        if (req.abortSignal.aborted) controller.abort();
        else
          req.abortSignal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
      }
      return wrapWithCalibration(
        wrapStreamWithWatchdog(
          callWithRetry({
            model: req.model,
            systemPrompt: req.systemPrompt,
            tools: req.tools,
            messages: req.messages,
            // 段切换摘要走 roles.light（model 由 createSegmentSummarizeFn
            // 绑 roles.light.model），思考控制随实际 role 注入 lightThinking。
            thinking: lightThinking,
            abortSignal: controller.signal,
          }),
          controller,
          watchdog,
          bus,
        ),
        { estimator, messages: req.messages },
      );
    };
  };

  // 首窗 onWindowOpen（instance-start）—— 订阅者贡献数据驱动段（skill-index 等）,
  // 据此首次 buildSystemPrompt 建实例权威 prompt。抛错让装配失败（实例未就绪、
  // 安全回滚,对齐 work-mode）。createAgentRuntime 为 async,此处 await 合法。
  await openInstanceWindow("instance-start", false);

  return {
    providerId: roles[primaryRole].provider.id,
    model: roles[primaryRole].model,
    securityPipeline,
    permissionStore: persistentStore,
    confirmationBroker,
    resolvedWorkspace: workspace,
    workspaceDirStatus,

    registerTurnContextProvider(provider: TurnContextProvider): void {
      turnContextInjector.register(provider);
    },

    registerConversationStateReset(target: Resettable): void {
      resettables.push(target);
    },

    async resetConversationState(): Promise<void> {
      // LIFO 串行：后注册先 reset。失败聚合：单个抛错不阻断后续 reset，
      // 全跑完再统一抛 ResetConversationStateError 让调用方决定吞 / 升级。
      const failures: { id: string; error: unknown }[] = [];
      for (let i = resettables.length - 1; i >= 0; i--) {
        const target = resettables[i]!;
        try {
          await target.reset();
        } catch (err) {
          failures.push({ id: target.id, error: err });
        }
      }
      if (failures.length > 0) {
        throw new ResetConversationStateError(failures);
      }
    },

    dispose,
    onAttentionWindowChange,

    get calibrationFactor(): number {
      return estimator.calibrationFactor;
    },

    checkBudget(messages: readonly Message[]): ContextBudget {
      // 纯展示计算（压缩决策已全部归段机制）
      return calculateBudget(
        modelBudgetInfo,
        estimator.estimateMessages(messages),
      );
    },

    subAgentUsages(messages: readonly Message[]): readonly TaskUsageEntry[] {
      return parseTaskUsageFromMessages(messages);
    },

    async callText(prompt: string, role: "main" | "light" = "light"): Promise<string> {
      // 单发 LLM 文本调用入口（无对话历史，独立 ChatRequest 隔离）。按 role 复用已装配
      // 的角色通道 TextCallLLMFn：默认 light（工作场景纪要 / 日志凝练等轻量任务，与
      // 记忆提取同 light 角色）；role="main" 走主档（质量敏感的单发任务，如 MCP
      // 接入标识推断，带 mainThinking）。
      const caller = role === "main" ? mainCallLLM : lightCallLLM;
      return caller([userMessage(prompt)]);
    },

    securitySnapshot(): RuntimeSecuritySnapshot {
      const contextId = securityPipeline.getContextId();
      return {
        contextId,
        workspacePath: securityPipeline.getWorkspace(),
        permissionRules: securityPipeline.getPermissionStore().list(contextId),
        builtinRules: securityPipeline.getPolicyEngine().getActiveRules(),
        rateLimits: securityPipeline
          .getExecutionGuard()
          .getRateLimiter()
          .snapshot(),
        confirmations: securityPipeline.getConfirmationTracker().snapshot(),
      };
    },

    async forceCompact(messages: Message[], turnCount: number): Promise<ForceCompactResult> {
      // 手动压缩 = 强制段切换：阈值置零 → 任何规模都走 risk-exceeded 强制
      // trigger，天然绕过 in-progress defer（用户明确要求压缩，不该被推迟）。
      // 摘要调用复用实例权威 prompt + 冻结 tools——与主对话请求同形，prompt
      // cache 前缀命中；摘要失败由段管理器的应急地板机械兜底。产物与自动
      // 切段同构（windowCompact + 可选快照锚），owner 经窗口 applyCompact
      // 应用——本方法只产指令、不触窗口、不落盘。
      //
      // 本地 bus：段事件与 REPL 主事件流隔离（/compact 的用户反馈由调用方
      // 按 ForceCompactResult 渲染）。记忆提取 hook 照常挂载——手动切段
      // 与自动切段的蒸馏时刻语义一致。
      const localBus = createEventBus<AgentEventMap>({ lineage: "main" });
      const segmentManager = createSegmentManager({
        estimator,
        capability: { optimalMaxTokens: 0, riskMaxTokens: 0 },
        callLLM: createSegmentSummarizeFn(
          makeSegmentStreamFactory(localBus, DEFAULT_WATCHDOG_POLICY),
          roles.light.model,
        ),
        // 手动压缩无对话身份语境（评估入参不带 conversationId）——
        // segmentMeta 不写，两个依赖以 no-op / 恒否兜底
        persistence: { async appendSegment() {} },
        taskListReader: { hasInProgress: () => false },
        eventBus: localBus,
        hooks: [memoryFlushHook],
      });

      // localBus 与 UI 隔离，降级信息经返回值显式交付——在 evaluate 期间
      // 收集 emergency_floor（emit 同步 await，evaluate 返回前必已触发）。
      let emergencyFloor: ForceCompactResult["emergencyFloor"];
      localBus.on("segment:emergency_floor", (info) => {
        emergencyFloor = { droppedTurns: info.droppedTurns, error: info.error };
      });

      const out = await segmentManager.evaluate({
        messages,
        systemPrompt: authoritativePrompt,
        tools: tools.map(toToolSpec),
        turnCount,
        conversationId: undefined,
      });

      const finalMessages =
        out.modified && out.newSegmentMessages ? out.newSegmentMessages : messages;
      return {
        modified: out.modified,
        messages: finalMessages,
        budget: calculateBudget(
          modelBudgetInfo,
          estimator.estimateMessages(finalMessages),
        ),
        windowCompact: out.windowCompact,
        emergencyFloor,
      };
    },

    async run(params: RunParams): Promise<RunResult> {
      // 主 agent 的 root EventBus 显式标记 lineage="main",建立父子事件契约的根:
      //   - 主 run 事件 meta.lineage === "main" (订阅方可按 lineage 过滤/路由)
      //   - 子 agent EventBus 通过 createEventBus({ parent, lineage: "main/<id>" })
      //     形成可追溯的层级链(保证 lineage 必须以父 lineage 为前缀)
      // 旧 listener 单参签名继续兼容(meta 是可选第二参,被忽略)
      const eventBus = createEventBus<AgentEventMap>({ lineage: "main" });
      const startTime = Date.now();

      // 收集本轮产生的新消息，用于 REPL 对话历史
      const newMessages: Message[] = [];
      let pendingToolResults: ToolResultBlock[] = [];

      // 通过 deps.callLLM 注入容错能力，agent-loop.ts 零修改
      const resilientCallLLM = withRetry(
        (request) => roles[primaryRole].provider.chat(request),
        { eventBus },
      );

      // 段切换管理器 —— attention-driven 主路径，与 contextEngine 并列。
      //
      // 内部依赖（orchestrator 解析）：
      //   - estimator / eventBus：与 contextEngine 共享
      //   - capability：从 modelId 解析（含 config 用户 override）
      //   - callLLM：**复用主对话同款保护链** —— resilientCallLLM (withRetry) +
      //     wrapStreamWithWatchdog (idle timer + abort race)，让段切换 LLM 自动
      //     继承容错与中断保护，避免"段切换路径绕过统一容错"的架构债
      //
      // 外部依赖（cli 装配层注入）：
      //   - taskListReader：决策时读 in-progress 任务（用于 defer 判定）
      //   - persistence：segmentMetadata 累积写入（transcript marker 不走这条，
      //     走 segment:new_started 事件 → accumulator → run-agent 单点 commit）
      //
      // segmentDeps 缺省 → 不构造 SegmentManager —— 该 run 没有任何窗口压缩
      // （段切换是唯一压缩机制），仅剩测试 / 纯嵌入消费这么用。
      const segmentWatchdog = params.watchdog ?? DEFAULT_WATCHDOG_POLICY;
      const segmentStreamFactory = makeSegmentStreamFactory(
        eventBus,
        segmentWatchdog,
      );
      const segmentManager = options.segmentDeps
        ? createSegmentManager({
            estimator,
            // capability 是会话所跑的 primaryRole model 的注意力/风险阈值，
            // 复用装配期解析的 primaryModelCapability（与 Task riskMaxTokens 同源）。
            // 段切换摘要 callLLM 与之正交 —— 段切换摘要恒走 roles.light（廉价），不跟 primaryRole
            //（注：质量敏感单发 callText main 走 roles.main，见 secondary-llm-capability ADR-SLLM-009）。
            capability: primaryModelCapability,
            callLLM: createSegmentSummarizeFn(
              segmentStreamFactory,
              roles.light.model,
            ),
            persistence: options.segmentDeps.persistence,
            taskListReader: options.segmentDeps.taskListReader,
            eventBus,
            // 记忆提取挂段切换时刻（afterSummarize）—— 失败由段管理器降级
            // warning，绝不阻断切段
            hooks: [memoryFlushHook],
          })
        : undefined;

      // 渲染装饰器 —— 调用方自管 retry / context / interrupt 等终端订阅。
      // runtime 主流程不再硬编码任何 UI 订阅,实现 runtime 层与展示层解耦。
      // 装饰器自身的 UI 依赖(renderer 实例等)由工厂层 closure 捕获,不入参传递。
      // 运行身份(对话 / turn)透传——跨进程转发类装饰器据此路由事件归属。
      const disposeRender = options.decorateRunBus?.({
        bus: eventBus,
        conversationId: params.conversationId,
        turnContext: params.turnContext,
      });

      //
      // 数据收集订阅,与展示层正交,留在 runtime 主流程。事件本身的渲染由 decorateRunBus
      // 注入的订阅处理(若有)。

      // Segment marker 累积订阅 —— attention-driven 段切换 marker 走独立事件流。
      // 与 compact accumulator 对偶：单 run 内段切换最多一次（attention 阈值
      // 远早于 budget critical），重复触发取最新。run 结束时 segment marker
      // 优先于 compact marker（段切换 marker 含 segmentId / structuredSummary
      // 等更丰富的结构化信息）。
      const segmentAccumulator = subscribeSegmentMarkerAccumulator(eventBus);

      // 工作模式切换意图收集 —— last-wins 单一意图（非累加）。纯管道:
      // 仅收集,run 结束带出 RunResult.pendingModeSwitch,不执行任何切换。
      const workModeAccumulator = subscribeWorkModeAccumulator(eventBus);

      // 资源清理统一入口 —— 每个 dispose 独立 try-catch 隔离故障传播:
      //   - accumulator 抛错不能阻断 disposeRender(否则 CLI 渲染订阅 / interrupt
      //     warn ticker 会跨 run 累积,造成内存泄漏与重复渲染);
      //   - dispose 内部异常仅记录日志,不再次 throw,见 safeDispose 注释。
      const disposeAll = (): void => {
        safeDispose("run.segmentAccumulator", () => segmentAccumulator.dispose());
        safeDispose("run.workModeAccumulator", () =>
          workModeAccumulator.dispose(),
        );
        safeDispose("run.decorate", () => disposeRender?.());
      };

      // ─── 本 run 局部 prompt + 注意力窗口换代回调 ───
      //
      // 入口 capture 实例权威当前值（窗口延续则 byte-equal、cache 跨 run 命中;上个
      // run 末轮切段 / run 外换代已更新实例权威则取到新值）。run 内换代只改本 run
      // 局部,并发 run 互不观测对方的换代（窗口内 byte-equal 在并发下成立的根本）。
      const localSegmentOverrides: Partial<
        Record<SystemPromptSegment, string | null>
      > = { ...instanceSegmentOverrides };
      let localPrompt = authoritativePrompt;
      const getRunSystemPrompt = (): string => localPrompt;

      // run 内三条上下文重构出口（runTurnBegin 段切换 / pre-flight 压缩 / runTurnEnd
      // 段切换-压缩）统一经此触发窗口换代：旧窗 onWindowClose → 新窗 onWindowOpen →
      // 重拼本 run 局部 prompt（+ 单调更新实例权威给后续新 run）。失败不阻塞主对话。
      const windowLifecycle: WindowLifecycle = {
        async onChange(reason: WindowChangeReason): Promise<void> {
          const myEpoch = ++windowEpochCounter;
          const closingIndex = windowCounter - 1;
          const openingIndex = windowCounter++;

          const closeCtx: LifecycleWindowCloseContext = {
            ...lifecycleBase(),
            reason,
            windowIndex: closingIndex,
          };
          for (const sub of lifecycle) {
            try {
              await sub.onWindowClose?.(closeCtx);
            } catch (err) {
              eventBus.emit("lifecycle:hook_failed", {
                hookId: sub.id,
                phase: "onWindowClose",
                error: lifecycleErrorMessage(err),
              });
            }
          }

          // 新窗 open —— 订阅者贡献写本 run 局部段覆盖（重拼本 run 局部 prompt）,
          // 并单调写实例级（给后续新 run,不回退滞后并发 run 的旧值）。
          const openCtx: LifecycleWindowOpenContext = {
            ...lifecycleBase(),
            reason,
            windowIndex: openingIndex,
            updateSystemPromptSegment(segment, content) {
              localSegmentOverrides[segment] = content;
              if (myEpoch > instanceEpoch) {
                instanceSegmentOverrides[segment] = content;
              }
            },
          };
          for (const sub of lifecycle) {
            try {
              await sub.onWindowOpen?.(openCtx);
            } catch (err) {
              eventBus.emit("lifecycle:hook_failed", {
                hookId: sub.id,
                phase: "onWindowOpen",
                error: lifecycleErrorMessage(err),
              });
            }
          }

          // 重拼本 run 局部 prompt —— byte-equal 比较:skill 没变（绝大多数段切换）
          // 则不动、保住 cache;真换才 emit prompt_rebuilt。
          const nextLocal = buildPrompt(localSegmentOverrides);
          if (nextLocal !== localPrompt) {
            localPrompt = nextLocal;
            eventBus.emit("lifecycle:prompt_rebuilt", { reason });
          }
          // 单调更新实例权威 —— 仅当本次换代是迄今最晚的提交。
          if (myEpoch > instanceEpoch) {
            instanceEpoch = myEpoch;
            authoritativePrompt = buildPrompt(instanceSegmentOverrides);
          }
        },
      };

      // onBeforeRun —— run 前唯一业务介入点（窗口内、ALS 外、与 onAfterRun 同侧）：
      // 观测即将发送的 messages + 异步副作用,以及经 ctx.injectUserContext 向当前 run
      // 用户消息贡献注入内容。不重建 system prompt（run 入口重建会违反窗口内
      // byte-equal）。抛错不阻塞 run。
      //
      // isWindowFirstRun：run 入口所在窗口（windowCounter - 1）与上个 run 入口窗口
      // 比对 —— 这段同步、单线程原子;窗口可在 run 内换代,故按入口时刻判定。
      const entryWindowIndex = windowCounter - 1;
      const isWindowFirstRun = entryWindowIndex !== lastRunEntryWindowIndex;
      lastRunEntryWindowIndex = entryWindowIndex;

      // 订阅者经 injectUserContext 贡献注入内容,运行体收齐后拼一个 <context> 块
      //（拼装 / 包标签 / 注入位置归运行体,订阅者只递交内容）。
      const userContextContributions: string[] = [];
      const beforeRunCtx: LifecycleBeforeRunContext = {
        ...lifecycleBase(),
        conversationId: params.conversationId,
        turnIndex: params.turnIndex,
        isWindowFirstRun,
        messages: params.messages,
        injectUserContext(content) {
          if (content !== null && content.trim().length > 0) {
            userContextContributions.push(content);
          }
        },
      };
      for (const sub of lifecycle) {
        try {
          await sub.onBeforeRun?.(beforeRunCtx);
        } catch (err) {
          eventBus.emit("lifecycle:hook_failed", {
            hookId: sub.id,
            phase: "onBeforeRun",
            error: lifecycleErrorMessage(err),
          });
        }
      }
      // 收齐贡献 → 注入当前 run 用户消息,作为本 run loop 的输入起点。
      const injectedMessages = prependContextBlock(
        params.messages,
        userContextContributions,
      );

      // ALS 包裹整个 run loop 主体 —— 让 Task 工具(及未来任何 closure 工具)
      // 在 call() 内部通过 runContextStorage.getStore() 拿到当前 run 的
      // bus 与 lineage,无需把这两字段塞进 ToolExecutionContext 接口(只对
      // Task 一个工具有意义,污染所有工具的 ctx 不合理)。
      //
      // ALS 自动按异步上下文隔离:同一 runtime 并发跑多个 run() 时各自的
      // RunContext 不串扰;子 agent 嵌套(runChildAgent 内部再 run ALS)
      // 自动覆盖为 child bus / child lineage,孙子 Task 自动取 sub 当前的上下文。
      //
      // disposeAll 留在 finally(ALS 包裹外):dispose 不依赖 RunContext,
      // 且 finally 的语义是"无论 ALS 内 throw 与否都执行清理",位置正确。
      try {
        const result = await runContextStorage.run(
          {
            bus: eventBus,
            lineage: "main",
            conversationId: params.conversationId,
            turnOrigin: params.turnContext?.turnOrigin,
          },
          async (): Promise<RunResult> => {
            return await runMainLoop();
          },
        );
        // onAfterRun —— run 产出 RunResult 后（ALS 外、disposeAll 前;若 run() 自身
        // 抛错则不触发,onBeforeRun→onAfterRun 非强配对）。抛错不污染已就绪结果。
        const afterRunCtx: LifecycleAfterRunContext = {
          ...lifecycleBase(),
          conversationId: params.conversationId,
          turnIndex: params.turnIndex,
          result,
        };
        for (const sub of lifecycle) {
          try {
            await sub.onAfterRun?.(afterRunCtx);
          } catch (err) {
            eventBus.emit("lifecycle:hook_failed", {
              hookId: sub.id,
              phase: "onAfterRun",
              error: lifecycleErrorMessage(err),
            });
          }
        }
        return result;
      } finally {
        disposeAll();
      }

      async function runMainLoop(): Promise<RunResult> {
        // onBeforeRun 订阅者贡献的 <context> 已注入当前 run 用户消息（injectedMessages，
        // 在 run 入口拼好）。本 loop 从它起步。
        //
        // pre-flight compact 检查 —— 防止上 run 尾累积到超标、下 run 入口直接送 LLM 爆 context。
        //
        // 关键设计：跑在 injectedMessages（含 onBeforeRun 注入的 <context>）上，不在
        //   params.messages。注入可能带来数 K token 增量（小模型 32K 上可能跨越预算
        //   阈值），pre-flight 必须看真实输入才能做出正确决策。
        //
        // turn-context 块（时间、任务状态等）由 agent-loop 在每次 LLM call 之前 per-call inject，

        // turn-context 体积较小（百级 tokens），pre-flight 评估的 under-estimate 不会跨预算阈值。
        const loopMessages = injectedMessages;

        // 原始 user 消息（params.messages 最后一条，未经 <context> / turn-context 注入增强）
        // —— 持久化输入的 messages[0] 必须是用户真实输入，不是内部增强版
        const originalUserMessage =
          params.messages[params.messages.length - 1] ??
          (userMessage("") as Message);


        // 用 SecurityPipeline 包装工具执行——每次 run() 重新构造 wrapper。
        // 把 turnContext（turnId / emissionTarget / commitToUser）合并到每次 tool.call 的 ToolExecutionContext；core loop 对此无感知。
        //
        // commitToUser 在这里再包装一层，自动注入当前 tool.name——工具代码无需
        // 手动报告自己名字；EmissionSource.tool-commitment.toolName 不会出现 "unknown" 占位。
        // turnContext 作为选项直接传给 secure-executor——由其在包装函数入口
        // 一次性展开到 ToolExecutionContext（保证 pipeline.evaluate /
        // handleBrokerPath / 工具调用 共享同一增强 context）。
        const secureExecuteTool = createSecureExecuteTool({
          pipeline: securityPipeline,
          originalExecute: (tool, input, context) => tool.call(input, context),
          broker: confirmationBroker,
          sessionType,
          confirmationFallback: options.confirmationFallback,
          turnContext: {
            ...params.turnContext,
            userIntent: extractText(originalUserMessage),
          },
          onBlocked: options.onSecurityBlocked,
          onUserDenied: options.onUserDenied,
          // per-run 事件总线 —— 启用安全审计发射（pipeline 决策事件 + 管家三态裁决事件）
          eventBus,
        });

        const gen = runAgentLoop({
          provider: roles[primaryRole].provider,
          model: roles[primaryRole].model,
          // 主对话走 roles[primaryRole]，loop 思考解析同 role（装配期已校验兜底）。
          thinking: primaryThinking,
          inputCapabilities: modelInputCapabilities,
          tools,
          messages: loopMessages,
          getSystemPrompt: getRunSystemPrompt,
          eventBus,
          // 工具执行的工作目录：与 system prompt 暴露给 LLM 的 "Working directory"
          // 字段保持一致——workspace 配置存在时用 workspace，否则 fallback 到 cwd。
          // 让 LLM 视图（用户配置的工作区即工作目录）与工具实际执行目录对齐，
          // 消除"LLM 知道 workspace 是 D:\，但 Bash dir 在 E:\ 执行"的语义错位。
          // source:"none"（显式无工作区，无 workdir 工作场景）→ 不兜底 cwd，
          // 不让文件路径落进程 cwd / 主工作区（纵深防御；主防线是该场景
          // 装配期无文件工具，见 powerProfile 二分）。其余路径维持原语义。
          workingDirectory:
            workspace.source === "none"
              ? undefined
              : (workspace.path ?? process.cwd()),
          abortSignal: params.abortSignal,
          // watchdog fallback 单点: 调用边界注入默认值, agent-loop 内部不二次 fallback
          // 保证调用方显式传入的 policy(含禁用 idle-timer 的 `{ idleTimeoutMs: 0 }`)一路透传
          watchdog: params.watchdog ?? DEFAULT_WATCHDOG_POLICY,
          deps: {
            callLLM: resilientCallLLM,
            executeTool: secureExecuteTool,
          },
          llmRoles: roles,
          // 各角色生效思考配置，沿 llmRoles 同路径注入到工具 ctx.roleThinking，
          // 让工具 I/O 边界调对应角色（如 WebFetch 蒸馏走 light）遵循用户配置。
          roleThinking,
          // 视图层 turn-context 注入由 agent-loop 在每次 LLM call 之前调用，
          // 让任务状态 / 定时任务 / 时间等动态信息在多 LLM call 之间实时刷新
          turnContextInjector,
          // 估算器 per-LLM-call 校准：agent-loop 在每次成功 LLM call 后用本次实际
          // 送入的 messagesForLLM 对账 inputTokens，让系数与 LLM 实际处理的 size 对账
          tokenEstimator: estimator,
          // 段切换：attention-driven 主路径，按 turn 边界评估 + 可选切段
          segmentManager,
          conversationId: params.conversationId,
          // 注意力窗口换代回调 —— run 内 messages 重构后触发窗口钩子、重拼本 run
          // 局部 prompt（让重建后的 system prompt 在下个 LLM call 生效）。
          windowLifecycle,
        });

        while (true) {
          const { value, done } = await gen.next();

          if (done) {
            const allMessages = [...params.messages, ...newMessages];

            // budget 是纯展示快照（压缩决策已全部归段机制）
            const budget = calculateBudget(
              modelBudgetInfo,
              estimator.estimateMessages(allMessages),
            );

            // 窗口重构指令唯一生产者 = 段切换（自动评估 / 应急地板同一出口）
            const windowCompact = segmentAccumulator.getWindowCompact();
            return {
              agentResult: value,
              runRecord: buildRunRecord({
                source: params.source,
                advancement: params.advancement,
                userMessage: originalUserMessage,
                newMessages,
                agentResult: value,
              }),
              newMessages,
              durationMs: Date.now() - startTime,
              budget,
              windowCompact,
              pendingModeSwitch: workModeAccumulator.getIntent(),
            };
          }

          // 通知调用方（渲染用）
          params.onYield?.(value);

          // 追踪消息以维护对话历史
          trackMessages(value, newMessages, pendingToolResults);
        }
      }
    },
  };
}
