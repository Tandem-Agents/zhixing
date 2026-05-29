/**
 * Agent 运行编排
 *
 * 职责：组装 Provider + Tools + EventBus，运行 Agent Loop，
 * 通过回调通知调用方 yield 事件。
 *
 * 运行时不感知具体调用方(REPL / 服务端 / 子 agent)。展示层订阅与安全事件 UI 通知
 * 都通过依赖注入(decorateRunBus / onSecurityBlocked / onUserDenied)从外部接入。
 */

import {
  type AgentResult,
  type AgentYield,
  type AgentEventMap,
  type CompactMarker,
  type ConfirmationFallbackStrategy,
  type ContextBudget,
  type IConfirmationBroker,
  type IEventBus,
  type Message,
  type RunResult,
  type ToolResultBlock,
  type IPermissionStore,
  type IToolArgumentExtractor,
  type LLMRole,
  type MutableToolBoundaryRegistry,
  type ResolvedRoleThinking,
  type ThinkingConfig,
  type ToolDefinition,
  type TurnContext,
  type TurnContextProvider,
  type TurnSource,
  type WatchdogPolicy,
  buildTurn,
  resolveTurnTimestamp,
  BoundaryRegistry,
  ConfirmationBroker,
  createEventBus,
  createContextEngine,
  createLLMSummarizeStrategy,
  createSegmentManager,
  createSegmentSummarizeFn,
  createTokenEstimator,
  type SegmentPersistence,
  type SegmentStreamFactory,
  type TaskListReader,
  wrapStreamWithWatchdog,
  wrapWithCalibration,
  ToolArgumentExtractor,
  emptyUsage,
  createMessageDropStrategy,
  createMemoryFlushStrategy,
  DEFAULT_WATCHDOG_POLICY,
  MemoryStore,
  PeopleStore,
  getMemoryDir,
  getWorkSceneMemoryDir,
  PermissionStore,
  resolveAgentIdentity,
  resolveContextManager,
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
  getAbortReason,
  SkillStore,
  getSkillsRoot,
  renderSkillIndex,
  type SkillMode,
  type Resettable,
} from "@zhixing/core";
import {
  createProviderRoles,
  ensureWorkspaceDir,
  getGlobalConfigPath,
  PROTOCOL_BUDGET_DEFAULTS,
  getModelCapabilityOverride,
  resolveModelCapability,
  resolveWorkspace,
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
import { subscribeCompactAccumulator } from "./compact-accumulator.js";
import { subscribeSegmentMarkerAccumulator } from "./segment-marker-accumulator.js";
import { subscribeWorkModeAccumulator } from "./workmode-accumulator.js";
import {
  createSummarizeCallLLM,
  createMemoryFlushCallLLM,
} from "./compaction-llm.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  loadProjectContext,
  injectContext,
  enrichContext,
  type EnrichOptions,
} from "./project-context.js";
import {
  createSecureExecuteTool,
  type OnBlockedFn,
  type OnUserDeniedFn,
} from "../security/secure-executor.js";
import { trackMessages } from "./track-messages.js";
import { runContextStorage } from "./run-context.js";
import { createTaskTool } from "../tools/task.js";

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

// ─── 类型 ───

/**
 * 装饰器的入参 —— 仅暴露当前 run 的 EventBus。
 *
 * 任何 UI 概念(spinner 暂停、终端清屏等)都不应进入 runtime API;
 * UI 类装饰器应通过 closure 捕获自身依赖(如 renderer 实例)在工厂层注入,
 * 保持 runtime 与展示层零耦合。
 */
export interface RunBusContext {
  bus: IEventBus<AgentEventMap>;
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
   * 调用时机：cli `/clear` 在 `store.compactAll` 之后调一次；
   * server 在 conversation 切换 / 重置场景按需调。
   *
   * 失败语义：单个 Resettable 抛错 → 收集到聚合错误数组继续后续 reset，
   * 全部跑完后再统一抛 ResetConversationStateError（含失败的 ids）。
   * 调用方决定是否阻塞 /clear 完成 —— 多数情况吞错继续即可（state 已部分清，
   * 内存语义已是"清空"，下次 LLM call 仍会按新视图编排）。
   */
  resetConversationState(): Promise<void>;
}

export interface ForceCompactResult {
  modified: boolean;
  messages: Message[];
  /** 压缩后的预算快照（modelInfo 由 resolver 保证可用，必填） */
  budget: ContextBudget;
  /**
   * compact 事务的权威元数据（仅当事务产生了 summary 时非空）。
   *
   * 由 forceCompact 内部 eventBus 订阅 context:compact_end 并 L1 累积组装。
   * 消费者：REPL /compact 直接把这个 marker 交给 store.appendCompact 持久化，
   * 不再自己拼接 "(manual compact)" 等硬编码字符串。
   *
   * 为什么 optional：如果 forceCompact 只触发了非摘要型策略（如 MessageDrop /
   * MemoryFlush），没有 LLM 生成的 summary，此时不该写 compact marker（会产生
   * 假摘要污染 transcript）。调用方应该判断此字段存在再持久化。
   */
  compactBefore?: CompactMarker;
}

export interface RunParams {
  messages: Message[];
  /**
   * 本 turn 序号 —— 由调用方维护的 counter，落盘为 Turn.turnIndex。
   *
   * - REPL: `state.turnCounter`（每次 commitTurn 成功后 +1）
   * - server: `ManagedSession.turnCount`
   * - ephemeral / 单次运行：0
   */
  turnIndex: number;
  /**
   * 当前 conversation id —— 透传到 runContextStorage，工具按需取（用于
   * 在持久化会话中区分写入目标 / 读取上下文）。
   *
   * 可选：ephemeral 路径（一次性 --print / 定时任务 / 单测 fixture）省略；
   * 工具收到 undefined 时显式分支处理（拒绝执行 / graceful degrade）。
   */
  conversationId?: string;
  /** 触发源，落盘为 Turn.source。不指定时字段为 undefined */
  source?: TurnSource;
  onYield?: (event: AgentYield) => void;
  /** 反思相关选项（上一轮工具调用数、是否已提议过） */
  enrichOptions?: EnrichOptions;
  /**
   * Turn 级上下文。channel 会话传入含 commitToUser；
   * REPL / 定时任务 ephemeral turn 省略。字段进入每个工具调用的
   * ToolExecutionContext（turnId / emissionTarget / commitToUser）。
   */
  turnContext?: TurnContext;
  /**
   * Abort 信号 —— 透传到 agent-loop 和 contextManager（compact 策略内的 LLM 调用）。
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

export interface CreateAgentRuntimeOptions {
  /**
   * 工作区：
   *   - string   → cli/配置工作区，经 resolveWorkspace 正常解析
   *   - undefined → 同上（无 cli 覆盖，resolveWorkspace 按配置/兜底）
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
   * 个人记忆域作用域 —— 装配期据此解析整域 root 并注入全部 me/ 访问者
   * （单一 MemoryStore = 工具 + flush 共用、scoped PeopleStore、
   * profile-loader），后续不可变。缺省 personal（root = getMemoryDir()，
   * 对外行为与历史一致）。
   */
  memoryScope?:
    | { kind: "personal" }
    | { kind: "workscene"; sceneId: string };
  /**
   * 技能库 store —— 缺省时内部按全局库根(~/.zhixing/skills)自建一个。
   *
   * cli 注入会话级单一实例,使 runtime 的索引读 / load_skill 与 cli 侧的 /<name>
   * 唤醒、技能管理面板共享同一锁域(index.json 读改写串行),从根上杜绝跨实例
   * 并发写丢更新。serve / 一次性 --print / 测试等无 cli 面板的路径不传,走内部
   * 自建即可(技能为全局、库根固定,实例无状态、无生命周期负担)。
   */
  skillStore?: SkillStore;
  /**
   * 主对话槽位 —— 缺省 "main"。决定主对话语义六处（capability /
   * Task provider+model / budget resolveModelInfo / 返回 providerId+model /
   * resilientCallLLM / runAgentLoop）取 roles[primaryRole]，及主对话 loop +
   * Task 子 agent loop 的思考解析跟随；压缩域按 task 性质分流（LLMSummarize
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
   * （contextEngine LLMSummarize）。这让小型/极简集成（如纯测试 runtime）
   * 不必装配段切换也能跑通；段切换是 cli 装配层的产品能力，不是 runtime 必需。
   */
  segmentDeps?: {
    readonly taskListReader: TaskListReader;
    readonly persistence: SegmentPersistence;
  };
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
  // （LLMSummarize→main / MemoryFlush+callText→light / 段切换→light，详见
  // secondary-llm-capability ADR-SLLM-009）不跟随、roleThinking 三角色聚合
  // 不跟随（见下）。缺省 main，工作模式装配传 power。
  const primaryRole = options.primaryRole ?? "main";

  // 应用级身份单例：启动时设一次，后续所有 user-facing 字符串通过
  // getAgentIdentity() 读取。默认 "知行"，可通过 zhixing.config.json
  // 的 agent.displayName 覆盖。
  setAgentIdentity(resolveAgentIdentity(config.agent));

  const cwd = process.cwd();

  // 工作区解析：按优先级链 CLI > 目录级配置 > 全局配置 > cwd 兜底
  const sessionType: "interactive" | "ci" = process.stdin.isTTY
    ? "interactive"
    : "ci";
  // workspace === null：显式无工作区（无 workdir 工作场景），跳过解析、
  // 直接 source:"none"；否则按优先级链 resolveWorkspace。
  const workspace: ResolvedWorkspace =
    options.workspace === null
      ? { path: null, source: "none" }
      : resolveWorkspace(config, {
          cliWorkspace: options.workspace,
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
  // 实例）与 scoped PeopleStore（人物检索同源隔离），profile
  // 经 loadProjectContext 透传同一 root。runtime 生命周期内不变。
  const memoryRoot =
    options.memoryScope?.kind === "workscene"
      ? getWorkSceneMemoryDir(options.memoryScope.sceneId)
      : getMemoryDir();
  const memoryStore = new MemoryStore(memoryRoot);
  const peopleStore = new PeopleStore(memoryRoot);

  // 技能分区跟随场景,与记忆域同源于 memoryScope —— "工作场景"这一个轴同时定
  // 记忆域与技能区:工作场景注入 work 区技能,个人对话注入 main 区。SkillStore
  // 是技能库唯一磁盘访问点(库根固定 ~/.zhixing/skills,不随场景隔离 —— 技能跨
  // 场景共享,只按 mode 分区注入),load_skill 工具与索引段共用此实例。
  const skillMode: SkillMode =
    options.memoryScope?.kind === "workscene" ? "work" : "main";
  const skillStore = options.skillStore ?? new SkillStore(getSkillsRoot());

  const builtinCtx = { proxy: config.network?.proxy, memoryStore, skillStore };
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
    trustContext:
      workspace.path !== null
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

  // 思考控制装配期一次性解析（runtime 生命周期内 config + 解析后的 role 均不变，
  // 无需 per-run 重算）。三类用途严格分区：
  //   - roleThinking ：**真实 per-role 映射**（每个 role 按其自身 config 解析），
  //     沿 llmRoles 同路径下传 ToolExecutionContext 供工具按所用角色扇出；
  //     不跟随 primaryRole（工具调 ctx.llm.light 就该拿 light 的思考配置）
  //   - primaryThinking：主对话 loop + Task 子 agent loop（二者均跑
  //     roles[primaryRole] 单 model）→ 取 roleThinking[primaryRole]
  //   - lightThinking ：MemoryFlush + callText + 段切换摘要（恒走 roles.light，
  //     不跟 primaryRole；主对话压缩 LLMSummarize 走 roles.main 用 mainThinking，
  //     见 secondary-llm-capability ADR-SLLM-009）
  const roleThinking: ResolvedRoleThinking = {
    main: resolveRoleThinking(roles.main, config.llm?.main?.thinking),
    light: resolveRoleThinking(roles.light, config.llm?.light?.thinking),
    power: resolveRoleThinking(roles.power, config.llm?.power?.thinking),
  };
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

  // systemPrompt 后置到 tools 装配完成之后 —— Task 工具的描述文本需进入
  // ## Tool Usage 段,LLM 才能学习"何时派 Task / 何时直接调单工具"的决策。
  //
  // ⚠ Prompt cache 死线:此处是 main agent systemPrompt 的**唯一构造点**,
  // 整个 runtime 生命周期内 byte-equal 不变。每轮 run() 在 line ~944 把同一
  // 字符串引用透传给 runAgentLoop —— 不得在 run() / loop / LLM call 路径里
  // 重建 systemPrompt,不得追加 per-turn 信息(时间走 turn-context 注入,
  // tools[] 装配一次 freeze 不变)。详见 buildSystemPrompt 的"调用契约"注释。
  //
  // 技能索引段(渐进披露的"廉价目录"):装配期取该模式 top-N 渲染成文本,作为
  // 系统提示词稳定前缀的一段一次性注入(模型按 id 调 load_skill 取全文展开)。
  // 在此预渲染而非 buildSystemPrompt 内部取数,是为让后者保持纯同步、不耦合
  // SkillStore —— 技能扫描的磁盘 I/O 归装配方,与 systemPrompt 同生命周期(切模式
  // = 重建 runtime = 新窗口,故窗口内 byte-equal 不变)。无技能 → null → 段跳过。
  const skillIndex = renderSkillIndex(
    await skillStore.queryTopN(skillMode, SKILL_INDEX_TOP_N),
  );
  const systemPrompt = buildSystemPrompt({
    profile,
    tools,
    cwd,
    workspace: workspace.path,
    workspaceSource: workspace.source,
    globalConfigPath: getGlobalConfigPath(),
    skillIndex,
  });

  // Per-turn 上下文注入器：时间 + 后续注册的 provider（如 scheduler）
  const turnContextInjector = new TurnContextInjector();
  turnContextInjector.register(
    new TimeProvider(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );

  // 加载项目上下文（ZHIXING.md + 环境信息），注入到首条 user message。
  // memoryRoot 透传 → profile 从 scoped 记忆域加载（与 store/people 同源）
  const projectContext = await loadProjectContext(cwd, memoryRoot);

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
  const estimator = createTokenEstimator();

  // 对话级 Resettable 注册表 —— 视图层 stage 实现 Resettable 后在装配期注册，
  // /clear 一并清空。
  const resettables: Resettable[] = [];

  // 压缩管线的 LLM 调用按用途分流到不同角色——主对话压缩走 main（摘要质量直接
  // 关系下一轮 LLM 认知输入），记忆提取走 light（I/O 边界结构化数据净化）。
  // 详见 compaction-llm.ts 的设计注释。
  const mainThinking = roleThinking.main;
  const summarizeCallLLM = createSummarizeCallLLM(roles, mainThinking);
  const memoryFlushCallLLM = createMemoryFlushCallLLM(roles, lightThinking);

  // 策略编排（engine 按 priority asc 执行，到 normal/warning 就 break）：
  //   priority 3   MemoryFlush     有 LLM 调用 — 仅 usage >= 0.75 触发
  //   priority 5   MessageDrop     免费 — usage < 0.9 触发（超过 0.9 让给 LLMSummarize）
  //   priority 200 LLMSummarize    昂贵 — usage >= 0.9 触发，MessageDrop 让位
  const strategies = [
    createMemoryFlushStrategy({ callLLM: memoryFlushCallLLM, store: memoryStore }),
    createMessageDropStrategy(),
    createLLMSummarizeStrategy({
      callLLM: summarizeCallLLM,
      estimator,
      triggerRatio: 0.9,
      preserveRecentTurns: 2,
    }),
  ];

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

    get calibrationFactor(): number {
      return estimator.calibrationFactor;
    },

    checkBudget(messages: readonly Message[]): ContextBudget {
      const engine = createContextEngine(estimator, strategies, { modelInfo: modelBudgetInfo });
      return engine.checkBudget(messages);
    },

    async callText(prompt: string, role: "main" | "light" = "light"): Promise<string> {
      // 单发 LLM 文本调用入口（无对话历史，独立 ChatRequest 隔离）。按 role 复用已装配
      // 的角色通道 CompactLLMFn：默认 light（工作场景纪要 / 日志凝练等轻量任务，与
      // MemoryFlush 同 light 角色）；role="main" 走主档（质量敏感的单发任务，如 MCP
      // 接入标识推断，与主对话压缩同 main 角色 + mainThinking）。
      const caller = role === "main" ? summarizeCallLLM : memoryFlushCallLLM;
      return caller([userMessage(prompt)]);
    },

    async forceCompact(messages: Message[], turnCount: number): Promise<ForceCompactResult> {
      // 独立 eventBus —— 捕获本次 forceCompact 的 compact_end 事件；
      // 和 run() 的外层 eventBus 隔离，不混淆 REPL 的事件流。
      // 两次 onTurnComplete 尝试（初始 + 降阈值重试）共用同一 bus，
      // 累积订阅保证 compactBefore 包含两次尝试的汇总。
      const localBus = createEventBus<AgentEventMap>();
      const accumulator = subscribeCompactAccumulator(localBus);

      try {
        const engine = createContextEngine(
          estimator,
          strategies,
          { modelInfo: modelBudgetInfo },
          localBus,
        );
        const result = await engine.onTurnComplete({ messages, turnCount });

        let finalMessages: Message[];
        let finalModified: boolean;

        if (!result.modified) {
          // 自动压缩因阈值未达而跳过，强制用较低阈值重试
          const forceEngine = createContextEngine(
            estimator,
            strategies,
            {
              modelInfo: modelBudgetInfo,
              thresholds: { warning: 0, compact: 0, critical: 0.95 },
            },
            localBus,
          );
          const forceResult = await forceEngine.onTurnComplete({ messages, turnCount });
          finalMessages = forceResult.messages;
          finalModified = forceResult.modified;
        } else {
          finalMessages = result.messages;
          finalModified = result.modified;
        }

        const budget = engine.checkBudget(finalMessages);
        const compactBefore = accumulator.getMarker();

        return {
          modified: finalModified,
          messages: finalMessages,
          budget,
          compactBefore,
        };
      } finally {
        // localBus 本就随函数结束 GC,但显式 dispose 对齐契约,未来若 localBus
        // 升级为跨调用共享时能自动避免 listener 泄漏。走 safeDispose 与 run() 对称:
        // dispose throw 不会覆盖 forceCompact 内 LLM summarize / strategy 抛出的原始错误。
        safeDispose("forceCompact.accumulator", () => accumulator.dispose());
      }
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

      // 每次 run 创建带 eventBus 的引擎实例（事件需绑定到当前 run 的 eventBus）。
      // modelBudgetInfo 由 resolveModelInfo 保证非空 —— compact 永远启用。
      const contextEngine = createContextEngine(
        estimator,
        strategies,
        { modelInfo: modelBudgetInfo },
        eventBus,
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
      // segmentDeps 缺省 → 不构造 SegmentManager，agent-loop 走 budget-only 兜底
      // 路径（contextEngine LLMSummarize 在 critical 时承担兜底）。
      //
      // 不变量假设：budget compact 阈值 × contextWindow > optimalMaxTokens。
      // 这保证 SegmentManager 在 attention 阈值（远早于 budget）先触发，
      // contextManager 几乎从不在 SegmentManager 评估前改 messages。如果用户
      // override 让阈值倒置，SegmentManager 会处理已被 LLMSummarize 改过的
      // messages（套娃压缩，但功能上不破，仅降级摘要质量）。
      const segmentWatchdog = params.watchdog ?? DEFAULT_WATCHDOG_POLICY;
      const segmentStreamFactory: SegmentStreamFactory = (req) => {
        // 上游 abortSignal 桥接到段切换内部 controller：让 watchdog idle
        // 触发和上游 abort 共享同一 cancel 通道
        const controller = new AbortController();
        if (req.abortSignal) {
          if (req.abortSignal.aborted) controller.abort();
          else
            req.abortSignal.addEventListener(
              "abort",
              () => controller.abort(),
              { once: true },
            );
        }
        // 装配链(由内到外):resilientCallLLM → wrapStreamWithWatchdog → wrapWithCalibration
        //   - resilientCallLLM: 重试与降级
        //   - wrapStreamWithWatchdog: idle 看门狗 + abort race
        //   - wrapWithCalibration: 每次段切换 LLM call 用真实 inputTokens 校准 estimator
        //
        // calibration 不走 EventBus(llm:request_end):段切换 LLM call 与主对话
        // emit 同型事件,listener 无可靠方式区分归属;流包装层归属精确。
        return wrapWithCalibration(
          wrapStreamWithWatchdog(
            resilientCallLLM({
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
            segmentWatchdog,
            eventBus,
          ),
          { estimator, messages: req.messages },
        );
      };
      const segmentManager = options.segmentDeps
        ? createSegmentManager({
            estimator,
            // capability 是会话所跑的 primaryRole model 的注意力/风险阈值，
            // 复用装配期解析的 primaryModelCapability（与 Task riskMaxTokens 同源）。
            // 段切换摘要 callLLM 与之正交 —— 段切换摘要恒走 roles.light（廉价），不跟 primaryRole
            //（注：主对话压缩 LLMSummarize 走 roles.main，见 secondary-llm-capability ADR-SLLM-009）。
            capability: primaryModelCapability,
            callLLM: createSegmentSummarizeFn(
              segmentStreamFactory,
              roles.light.model,
            ),
            persistence: options.segmentDeps.persistence,
            taskListReader: options.segmentDeps.taskListReader,
            eventBus,
          })
        : undefined;

      // 渲染装饰器 —— 调用方自管 retry / context / interrupt 等终端订阅。
      // runtime 主流程不再硬编码任何 UI 订阅,实现 runtime 层与展示层解耦。
      // 装饰器自身的 UI 依赖(renderer 实例等)由工厂层 closure 捕获,不入参传递。
      const disposeRender = options.decorateRunBus?.({ bus: eventBus });

      // Compact 累积订阅 —— 多个触发点 fire 时累加 turnsCompacted、
      // 取最新 summary、锚定 firstTokensBefore。run 结束时读出作为 RunResult.compactBefore。
      //
      // 数据收集订阅,与展示层正交,留在 runtime 主流程。事件本身的渲染由 decorateRunBus
      // 注入的订阅处理(若有)。
      const accumulator = subscribeCompactAccumulator(eventBus);

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
        safeDispose("run.accumulator", () => accumulator.dispose());
        safeDispose("run.segmentAccumulator", () => segmentAccumulator.dispose());
        safeDispose("run.workModeAccumulator", () =>
          workModeAccumulator.dispose(),
        );
        safeDispose("run.decorate", () => disposeRender?.());
      };

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
        return await runContextStorage.run(
          {
            bus: eventBus,
            lineage: "main",
            conversationId: params.conversationId,
          },
          async (): Promise<RunResult> => {
            return await runMainLoop();
          },
        );
      } finally {
        disposeAll();
      }

      async function runMainLoop(): Promise<RunResult> {
        // 根据最后一条用户消息检索匹配的人物
        // scoped 存储由装配期注入，置于 per-run options 之后 → scope 隔离
        // 不可被调用方 enrichOptions 覆盖
        const enrichedContext = await enrichContext(
          projectContext,
          params.messages,
          { ...params.enrichOptions, peopleStore },
        );

        // 将项目上下文 + 匹配的人物注入到首条 user message
        const messagesWithContext = injectContext(params.messages, enrichedContext);

        // pre-flight compact 检查 —— 防止上 run 尾累积到超标、下 run 入口直接送 LLM 爆 context。
        //
        // 关键设计：跑在 messagesWithContext（含项目上下文与人物注入）上，不在 params.messages。
        //   params.messages 到 messagesWithContext 的 token 增量可能达数 K（project context +
        //   动态上下文），在小模型（32K）上可能跨越一个预算阈值。pre-flight 必须看真实输入
        //   才能做出正确决策。
        //
        // turn-context 块（时间、任务状态等）由 agent-loop 在每次 LLM call 之前 per-call inject，
        // pre-flight 这里不预 inject——避免 inject 与 pre-flight 触发的 LLMSummarize 双重处理；
        // turn-context 体积较小（百级 tokens），pre-flight 评估的 under-estimate 不会跨预算阈值。
        //
        // 终止归一化：复用 core 的 `resolveContextManager`，与 agent-loop 内部两条触发点
        // 共享同一判别逻辑（throw / aborted / overflow），避免第三处复制 abort 优先规则
        // 和 AgentError 包装 —— 新加触发点时只需做 shape 映射。
        let loopMessages = messagesWithContext;

        // 原始 user 消息（params.messages 最后一条，未经 enrichContext / turnContextInjector 增强）
        // —— buildTurn 契约要求持久化 Turn 的 userMessage 是用户真实输入，不是内部增强版
        const originalUserMessage =
          params.messages[params.messages.length - 1] ??
          (userMessage("") as Message);

        const buildPreFlightError = (agentResult: AgentResult): RunResult => {
          // 时序协调：turn.timestamp 必须严格 > compactBefore.timestamp。
          // 老文件 lazy migrate 用 `turn.ts <= compact.ts` 判丢弃，同毫秒会误伤。
          // resolveTurnTimestamp 一行防御：max(now, compact.ts+1ms) 消除误判。
          const compactBefore = accumulator.getMarker();
          return {
            agentResult,
            turn: buildTurn({
              turnIndex: params.turnIndex,
              source: params.source,
              userMessage: originalUserMessage,
              newMessages: [],
              agentResult,
              timestamp: resolveTurnTimestamp(compactBefore),
            }),
            newMessages: [],
            durationMs: Date.now() - startTime,
            // budget 快照用 messagesWithContext —— 即使 engine 抛错也能给一个保守值；
            // turn-context 块由 agent-loop per-LLM-call 注入，不在此 budget 估算里
            budget: contextEngine.checkBudget(messagesWithContext),
            compactBefore,
            pendingModeSwitch: workModeAccumulator.getIntent(),
          };
        };

        const preFlight = await resolveContextManager(
          contextEngine,
          {
            messages: messagesWithContext,
            turnCount: 0,
            abortSignal: params.abortSignal,
          },
          params.abortSignal,
          "pre-flight",
        );
        switch (preFlight.kind) {
          case "error":
            return buildPreFlightError({
              reason: "error",
              error: preFlight.error,
              usage: emptyUsage(),
            });
          case "aborted":
            // pre-flight 阶段 agent-loop 未启动 —— 不 emit 任何 EventBus 事件
            // (订阅方观察的事件流应是"本次 run 未真启动":无 run_start / fired / run_end);
            // emit fired 但缺 run_end 会成为孤儿事件破坏中断事件单向蕴含语义。
            // 仅在 RunResult.agentResult 上同步携带 abortReason,让 REPL renderSummary 能按
            // 错误码分支显示差异化文本(裸 abort 无类型化 reason 时 fallback 到 { kind: "external" })。
            // exitDelayMs 不填——pre-flight 阶段无 abort listener 无法测量。
            return buildPreFlightError({
              reason: "aborted",
              usage: emptyUsage(),
              abortReason: (params.abortSignal && getAbortReason(params.abortSignal))
                ?? { kind: "external" },
            });
          case "ok":
            if (preFlight.output.modified) {
              loopMessages = preFlight.output.messages;
            }
            break;
        }

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
          tools,
          messages: loopMessages,
          systemPrompt,
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
          contextManager: contextEngine,
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
        });

        while (true) {
          const { value, done } = await gen.next();

          if (done) {
            const allMessages = [...params.messages, ...newMessages];

            // 校准已下沉到 agent-loop per-LLM-call —— 这里仅 budget 评估用 state.messages
            // 维度（保 budget 与状态体积同源，与 calibration baseline 双 baseline 设计）。

            const budget = contextEngine.checkBudget(allMessages);

            // 时序协调（见 buildPreFlightError 注释）：turn.timestamp > compactBefore.timestamp
            //
            // marker 优先级：segment > compact（段切换 marker 含 segmentId +
            // structuredSummary 等结构化信息，应优先采用；compact 是 budget 兜底
            // 路径产生的 marker，单 run 内两者通常不会同时存在 —— attention 触发
            // 远早于 budget critical）。
            const compactBefore =
              segmentAccumulator.getMarker() ?? accumulator.getMarker();
            return {
              agentResult: value,
              turn: buildTurn({
                turnIndex: params.turnIndex,
                source: params.source,
                userMessage: originalUserMessage,
                newMessages,
                agentResult: value,
                timestamp: resolveTurnTimestamp(compactBefore),
              }),
              newMessages,
              durationMs: Date.now() - startTime,
              budget,
              compactBefore,
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

