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
  type MutableToolBoundaryRegistry,
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
  createTokenEstimator,
  ToolArgumentExtractor,
  emptyUsage,
  createMessageDropStrategy,
  createMemoryFlushStrategy,
  DEFAULT_WATCHDOG_POLICY,
  MemoryStore,
  PermissionStore,
  resolveAgentIdentity,
  resolveContextManager,
  resolveModelInfo,
  SecurityPipeline,
  setAgentIdentity,
  userMessage,
  withRetry,
  runAgentLoop,
  TurnContextInjector,
  TimeProvider,
  getAbortReason,
} from "@zhixing/core";
import {
  createProviderRoles,
  ensureWorkspaceDir,
  getGlobalConfigPath,
  PROTOCOL_BUDGET_DEFAULTS,
  resolveWorkspace,
  type ResolvedWorkspace,
  type WorkspaceDirStatus,
} from "@zhixing/providers";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createBashTool,
  createMemoryTool,
  createWebFetchTool,
  WEB_FETCH_DEFAULT_RULES,
} from "@zhixing/tools-builtin";
import { subscribeCompactAccumulator } from "./compact-accumulator.js";
import { createCompactionFlush } from "./compaction-llm.js";
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
  /** 简易 LLM 文本调用（用于 Journal condense 等辅助任务） */
  callText: (prompt: string) => Promise<string>;
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

export interface CreateAgentRuntimeOptions {
  model?: string;
  provider?: string;
  workspace?: string;
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
   * 是否启用 Task 工具(主 agent 可派生子 agent 的入口)。**默认 false**。
   *
   * 装配语义:工具集尾部追加 `createTaskTool(env)`,Task closure capture
   * 装配期已知的服务(provider / pipeline / broker / 当前工具集 snapshot 等),
   * **不**通过 attachTool 后置注入,避免 forward reference 与依赖完整性破坏。
   *
   * Per-run 上下文(eventBus / lineage)通过 `runContextStorage` (AsyncLocalStorage)
   * 传递到 Task closure 的 call() 内部 —— 由 runtime.run() 入口 `runContextStorage.run`
   * 包裹建立。这两点(closure capture 装配期服务 + ALS 传递 per-run 上下文)
   * 共同实现"Task 工具实例稳定可复用,EventBus 严格 per-run 隔离"。
   *
   * 子 agent 工具集自动按 `subAgentSafe===true` 过滤;Task 自身 `subAgentSafe: false`,
   * 实现"子 agent 不能再派子 agent"的递归深度上限。
   */
  enableTaskTool?: boolean;
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
}

// ─── 创建运行时 ───

/**
 * 创建一个 Agent 运行时。运行时持有 Provider/Tools/EventBus 实例，
 * 可多次调用 run() 执行不同的对话。
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const { roles, config, resolvedRoles } = createProviderRoles({
    providerOverride: options.provider,
    modelOverride: options.model,
  });

  // 应用级身份单例：启动时设一次，后续所有 user-facing 字符串通过
  // getAgentIdentity() 读取。默认 "知行"，可通过 zhixing.config.json
  // 的 agent.displayName 覆盖。
  setAgentIdentity(resolveAgentIdentity(config.agent));

  const cwd = process.cwd();

  // 工作区解析：按优先级链 CLI > 目录级配置 > 全局配置 > cwd 兜底
  const sessionType: "interactive" | "ci" = process.stdin.isTTY
    ? "interactive"
    : "ci";
  const workspace = resolveWorkspace(config, {
    cliWorkspace: options.workspace,
    sessionType,
  });

  // 确保工作区目录存在（首次启动自动创建，目录被删除则重建）
  const workspaceDirStatus = ensureWorkspaceDir(workspace);

  // baseTools = builtin + extra,**不含 Task** —— Task 装配依赖
  // securityPipeline / confirmationBroker(都在下方装配),需要后置追加。
  // baseTools 是 SecurityPipeline / BoundaryRegistry / ToolArgumentExtractor
  // 的注册输入(Task 工具 needsPermission: false 且无 boundaries,不参与这些链路)。
  const baseTools: ToolDefinition[] = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createMemoryTool(),
    createWebFetchTool({ proxy: config.network?.proxy }),
    ...(options.extraTools ?? []),
  ];

  // 安全管线：会话级单例，跨多次 run() 共享权限规则、确认追踪、频率限制状态。
  //
  // BoundaryRegistry / ToolArgumentExtractor 当前均走"启动时 snapshot"路径
  // (`fromTools(tools)`)，把 boundaries / permissionArgumentKey 声明从工具
  // 自描述映射到 security 基础设施。两者都暴露 `register/unregister` API，
  // 未来 MCP / 插件动态接入工具时无需 reconfigure 整个 SecurityPipeline。
  //
  // 现有 8 个 builtin 工具均不声明 boundaries（context classifier 接管），
  // boundary registry 实际为空但链路已通；未来无 context classifier 的新工具
  // （web_fetch / web_search 等）声明后立即生效。tool-aware extractor 让
  // PermissionStore.match 按工具自身声明的 permissionArgumentKey 提取参数，
  // 避免多 string 字段工具的字段顺序歧义。
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
    workspace: workspace.path,
    sessionType,
    permissionStore: persistentStore,
    toolBoundaryRegistry: boundaryRegistry,
  });

  // 确认交互 broker：会话级单例。渲染器由 REPL 在 attach 时注入。
  const confirmationBroker = new ConfirmationBroker();

  // tools = baseTools + (可选 Task 工具)。Task 装配时 capture 装配期已知的
  // 共享服务 + 当前 baseTools snapshot 作为子工具池来源(子按 subAgentSafe
  // 过滤后派生)。Task 自身 subAgentSafe: false,不会出现在子工具集中(防递归)。
  //
  // per-run 的 eventBus / lineage 由 runtime.run() 入口的 runContextStorage.run
  // 包裹建立,Task closure call() 时取用 —— 与本装配期解耦,无 mutable runtime 字段。
  //
  // boundary 后注册:Task 装配晚于 BoundaryRegistry.fromTools(baseTools),其
  // boundaries 必须显式 register 进 mutable registry,否则 BoundaryImpactClassifier
  // 找不到 → fail-closed → critical → 在 ci 模式下被 PermissionMatcher block。
  // 这同时是 MCP / 动态插件接入路径的统一模式,不是 Task 专用 hack。
  let tools: ToolDefinition[] = baseTools;
  if (options.enableTaskTool) {
    const taskTool = createTaskTool({
      provider: roles.main.provider,
      model: roles.main.model,
      llmRoles: roles,
      securityPipeline,
      workspace: workspace.path,
      workspaceSource: workspace.source,
      globalConfigPath: getGlobalConfigPath(),
      parentBroker: confirmationBroker,
      parentTools: baseTools,
    });
    tools = [...baseTools, taskTool];
    if (taskTool.boundaries && taskTool.boundaries.length > 0) {
      boundaryRegistry.register(taskTool.name, taskTool.boundaries);
    }
  }

  // systemPrompt 后置到 tools 装配完成之后 —— Task 工具的描述文本需进入
  // ## Tool Usage 段,LLM 才能学习"何时派 Task / 何时直接调单工具"的决策。
  const systemPrompt = buildSystemPrompt({
    tools,
    cwd,
    workspace: workspace.path,
    workspaceSource: workspace.source,
    globalConfigPath: getGlobalConfigPath(),
  });

  // Per-turn 上下文注入器：时间 + 后续注册的 provider（如 scheduler）
  const turnContextInjector = new TurnContextInjector();
  turnContextInjector.register(
    new TimeProvider(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );

  // 加载项目上下文（ZHIXING.md + 环境信息），注入到首条 user message
  const projectContext = await loadProjectContext(cwd);

  // 解析模型预算信息 —— resolver 保证 info 永不为 undefined。
  // 数据源四层（高 → 低）：
  //   1. modelOverrides[model]                — 用户精调
  //   2. provider.models.find(id===model)     — declared catalog 命中
  //   3. PROTOCOL_BUDGET_DEFAULTS[protocol]   — 协议族默认（网关型 provider 兜底）
  //   4. CONSERVATIVE_FALLBACK                — defensive 兜底（生产路径不应触达）
  // estimator 跨 run() 共享以保持校准状态。
  const resolvedModel = resolveModelInfo({
    providerId: roles.main.provider.id,
    model: roles.main.model,
    providerModels: roles.main.provider.models,
    overrides: resolvedRoles.main.resolved.modelOverrides,
    protocolDefaults:
      PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.main.resolved.protocol],
  });
  for (const w of resolvedModel.warnings) {
    console.warn(`[zhixing] ${w.message}`);
  }
  const modelBudgetInfo = resolvedModel.info;
  const estimator = createTokenEstimator();
  const memoryStore = new MemoryStore();

  // Flush 用的 LLM 调用——绑定 secondary 角色。详见 compaction-llm.ts 的
  // 设计注释（路由契约 + 单测覆盖）。
  const flushCallLLM = createCompactionFlush(roles);

  // 策略编排（engine 按 priority asc 执行，到 normal/warning 就 break）：
  //   priority 3   MemoryFlush     有 LLM 调用 — 仅 usage >= 0.75 触发
  //   priority 5   MessageDrop     免费 — usage < 0.9 触发（超过 0.9 让给 LLMSummarize）
  //   priority 200 LLMSummarize    昂贵 — usage >= 0.9 触发，MessageDrop 让位
  //
  // tool_result 体积管理由数据层 manageWindow.applyTierCompression 统一负责（每轮无条件运行），
  // 不在 strategies 链路内重复处理。
  const strategies = [
    createMemoryFlushStrategy({ callLLM: flushCallLLM, store: memoryStore }),
    createMessageDropStrategy(),
    createLLMSummarizeStrategy({
      callLLM: flushCallLLM,
      estimator,
      triggerRatio: 0.9,
      preserveRecentTurns: 2,
    }),
  ];

  return {
    providerId: roles.main.provider.id,
    model: roles.main.model,
    securityPipeline,
    permissionStore: persistentStore,
    confirmationBroker,
    resolvedWorkspace: workspace,
    workspaceDirStatus,

    registerTurnContextProvider(provider: TurnContextProvider): void {
      turnContextInjector.register(provider);
    },

    get calibrationFactor(): number {
      return estimator.calibrationFactor;
    },

    checkBudget(messages: readonly Message[]): ContextBudget {
      const engine = createContextEngine(estimator, strategies, { modelInfo: modelBudgetInfo });
      return engine.checkBudget(messages);
    },

    async callText(prompt: string): Promise<string> {
      return flushCallLLM([userMessage(prompt)]);
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
      let toolEndCount = 0;

      // 通过 deps.callLLM 注入容错能力，agent-loop.ts 零修改
      const resilientCallLLM = withRetry(
        (request) => roles.main.provider.chat(request),
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

      // 资源清理统一入口 —— 每个 dispose 独立 try-catch 隔离故障传播:
      //   - accumulator 抛错不能阻断 disposeRender(否则 CLI 渲染订阅 / interrupt
      //     warn ticker 会跨 run 累积,造成内存泄漏与重复渲染);
      //   - dispose 内部异常仅记录日志,不再次 throw,见 safeDispose 注释。
      const disposeAll = (): void => {
        safeDispose("run.accumulator", () => accumulator.dispose());
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
          { bus: eventBus, lineage: "main" },
          async (): Promise<RunResult> => {
            return await runMainLoop();
          },
        );
      } finally {
        disposeAll();
      }

      async function runMainLoop(): Promise<RunResult> {
        // 根据最后一条用户消息检索匹配的技能 + 反思提示
        const enrichedContext = await enrichContext(
          projectContext,
          params.messages,
          params.enrichOptions,
        );

        // 将项目上下文 + 匹配的技能 + 反思提示注入到首条 user message
        const messagesWithContext = injectContext(params.messages, enrichedContext);

        // pre-flight compact 检查 —— 防止上 run 尾累积到超标、下 run 入口直接送 LLM 爆 context。
        //
        // 关键设计：跑在 messagesWithContext（含项目上下文与技能注入）上，不在 params.messages。
        //   params.messages 到 messagesWithContext 的 token 增量可能达数 K（project context +
        //   enriched skills），在小模型（32K）上可能跨越一个预算阈值。pre-flight 必须看真实输入
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
            toolEndCount: 0,
            injectedSkillIds: enrichedContext.injectedSkillIds,
            compactBefore,
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
          turnContext: params.turnContext,
          onBlocked: options.onSecurityBlocked,
          onUserDenied: options.onUserDenied,
        });

        const gen = runAgentLoop({
          provider: roles.main.provider,
          model: roles.main.model,
          tools,
          messages: loopMessages,
          systemPrompt,
          eventBus,
          workingDirectory: process.cwd(),
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
          // 视图层 turn-context 注入由 agent-loop 在每次 LLM call 之前调用，
          // 让任务状态 / 定时任务 / 时间等动态信息在多 LLM call 之间实时刷新
          turnContextInjector,
        });

        while (true) {
          const { value, done } = await gen.next();

          if (done) {
            const allMessages = [...params.messages, ...newMessages];

            // Token 校准：用 API 返回的真实 token 数校正估算器
            if (value.usage.inputTokens > 0) {
              const estimated = estimator.estimateMessages(allMessages);
              estimator.calibrate(estimated, value.usage.inputTokens);
            }

            const budget = contextEngine.checkBudget(allMessages);

            // 时序协调（见 buildPreFlightError 注释）：turn.timestamp > compactBefore.timestamp
            const compactBefore = accumulator.getMarker();
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
              toolEndCount,
              injectedSkillIds: enrichedContext.injectedSkillIds,
              compactBefore,
            };
          }

          // 通知调用方（渲染用）
          params.onYield?.(value);

          // 追踪消息以维护对话历史
          if (value.type === "tool_end") toolEndCount++;
          trackMessages(value, newMessages, pendingToolResults);
        }
      }
    },
  };
}

