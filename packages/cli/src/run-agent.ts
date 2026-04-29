/**
 * Agent 运行编排
 *
 * 职责：组装 Provider + Tools + EventBus，运行 Agent Loop，
 * 通过回调通知调用方 yield 事件。
 *
 * 返回运行结果和本轮产生的新消息（用于 REPL 的对话历史维护）。
 */

import {
  type AgentResult,
  type AgentYield,
  type AgentEventMap,
  type CompactMarker,
  type ConfirmationFallbackStrategy,
  type ContextBudget,
  type IConfirmationBroker,
  type Message,
  type RunResult,
  type ToolResultBlock,
  type IPermissionStore,
  type IToolArgumentExtractor,
  type MutableToolBoundaryRegistry,
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
  createToolResultTrimStrategy,
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
import {
  renderRetryAttempt,
  renderRetryExhausted,
  renderRetrySuccess,
  renderBudgetStatus,
  renderCompactStart,
  renderCompactEnd,
  setupInterruptRendering,
} from "./render.js";
import { subscribeCompactAccumulator } from "@zhixing/orchestrator/runtime";
import { createCompactionFlush } from "@zhixing/orchestrator/runtime";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadProjectContext, injectContext, enrichContext, type EnrichOptions } from "@zhixing/orchestrator/runtime";
import { renderBlockedMessage, renderUserDeniedMessage } from "./security/index.js";
import { createSecureExecuteTool } from "@zhixing/orchestrator/security";

// ─── 类型 ───

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
   * 为什么 optional：如果 forceCompact 只触发了非摘要型策略（ToolResultTrim /
   * MessageDrop），没有 LLM 生成的 summary，此时不该写 compact marker（会产生
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
  /** 在渲染 EventBus 事件（重试/预算）前调用，用于暂停 spinner 等 UI 动画 */
  onBeforeEventRender?: () => void;
  /** 反思相关选项（上一轮工具调用数、是否已提议过） */
  enrichOptions?: EnrichOptions;
  /**
   * Turn 级上下文（ADR-007 Phase 2）。channel 会话传入含 commitToUser；
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
   * 缺省时本层注入 `DEFAULT_WATCHDOG_POLICY`(60s idle, 50% warn)。这是 spec 规定的
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

// ─── 创建运行时 ───

/**
 * 创建一个 Agent 运行时。运行时持有 Provider/Tools/EventBus 实例，
 * 可多次调用 run() 执行不同的对话。
 */
export async function createAgentRuntime(options: {
  model?: string;
  provider?: string;
  workspace?: string;
  /** 额外工具（如 schedule），在内置工具之后注入 */
  extraTools?: import("@zhixing/core").ToolDefinition[];
  /**
   * 确认超时降级策略，透传给 secure-executor。默认 "deny"。
   * 参见 remote-confirmation-execution.md §3.8。
   */
  confirmationFallback?: ConfirmationFallbackStrategy;
}): Promise<AgentRuntime> {
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

  const tools = [
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
  const systemPrompt = buildSystemPrompt({
    tools,
    cwd,
    workspace: workspace.path,
    workspaceSource: workspace.source,
    globalConfigPath: getGlobalConfigPath(),
  });

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
    ToolArgumentExtractor.fromTools(tools);
  const persistentStore = new PermissionStore({
    extractArgument: (req) => toolArgumentExtractor.extract(req),
  });
  const boundaryRegistry: MutableToolBoundaryRegistry =
    BoundaryRegistry.fromTools(tools);
  // builtin 规则注入：每个工具 namespace 自管,用户池任一命中将完全决定结果
  // (builtin 不参与),保证用户最终决定权(ADR-TPE-008)。
  // 未来子 agent / MCP 等模块以同样模式注入: `registerBuiltinRules(ns, rules)`
  persistentStore.registerBuiltinRules("web_fetch", [...WEB_FETCH_DEFAULT_RULES]);
  const securityPipeline = new SecurityPipeline({
    workspace: workspace.path,
    sessionType,
    permissionStore: persistentStore,
    toolBoundaryRegistry: boundaryRegistry,
  });

  // 确认交互 broker：会话级单例。渲染器由 REPL 在 attach 时注入。
  const confirmationBroker = new ConfirmationBroker();

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
    overrides: config.providers?.[roles.main.provider.id]?.modelOverrides,
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
  //   priority 0   ToolResultTrim  免费 — 旧轮 tool_result 裁剪
  //   priority 3   MemoryFlush     有 LLM 调用 — 仅 usage >= 0.75 触发
  //   priority 5   MessageDrop     免费 — usage < 0.9 触发（超过 0.9 让给 LLMSummarize）
  //   priority 200 LLMSummarize    昂贵 — usage >= 0.9 触发，MessageDrop 让位
  const strategies = [
    createToolResultTrimStrategy(),
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
        // localBus 本就随函数结束 GC，但显式 dispose 对齐契约，未来若 localBus 升级为
        // 跨 run 共享时（非当前形态）能自动避免 listener 泄漏。
        accumulator.dispose();
      }
    },

    async run(params: RunParams): Promise<RunResult> {
      const eventBus = createEventBus<AgentEventMap>();
      const startTime = Date.now();

      // 收集本轮产生的新消息，用于 REPL 对话历史
      const newMessages: Message[] = [];
      let pendingToolResults: ToolResultBlock[] = [];
      let toolEndCount = 0;
      // compactBefore 由下面的 subscribeCompactAccumulator 累积，run 结束时从 getter 读出

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

      // 在 EventBus 渲染前暂停 spinner，避免 \r 覆盖输出
      const pauseUI = params.onBeforeEventRender ?? (() => {});

      // 订阅重试事件 → 终端渲染
      eventBus.on("retry:attempt", (info) => {
        pauseUI();
        renderRetryAttempt(info);
      });
      eventBus.on("retry:success", (info) => {
        pauseUI();
        renderRetrySuccess(info);
      });
      eventBus.on("retry:exhausted", (info) => {
        pauseUI();
        renderRetryExhausted(info);
      });

      // 订阅上下文事件 → 仅在 pre-compact + warning+ 时渲染
      //   （post-compact 重复的状态不再渲染，避免 "预警 → 压缩 → 再次预警" 的视觉抖动；
      //    normal 仍由摘要行覆盖）
      eventBus.on("context:budget_check", (info) => {
        if (info.phase !== "pre-compact") return;
        if (info.status === "warning" || info.status === "compact" || info.status === "critical") {
          pauseUI();
          renderBudgetStatus(info);
        }
      });
      eventBus.on("context:compact_start", (info) => {
        pauseUI();
        renderCompactStart(info);
      });

      // Compact 累积订阅 —— 多个触发点 fire 时累加 turnsCompacted、
      // 取最新 summary、锚定 firstTokensBefore。run 结束时读出作为 RunResult.compactBefore。
      // 事件本身的渲染（renderCompactEnd）在累积订阅内 onEvent 回调触发，pauseUI 同步执行。
      //
      // dispose 在外层 try/finally 里调 —— 当前 eventBus 每 run 独立 + 随 GC，
      // dispose 非必须；但跟契约一致更安全，未来 bus 共享化也自动受保护。
      const accumulator = subscribeCompactAccumulator(eventBus, (info) => {
        pauseUI();
        renderCompactEnd(info);
      });

      // 中断 EventBus 渲染 — 装载 warn / fired / run_end 订阅, run 结束 finally dispose
      // 避免 listener 跨 run 累积。与 accumulator 同模式 (per-run 装载 + 自动卸载)。
      const interruptRendering = setupInterruptRendering(eventBus, pauseUI);

     try {
      // 根据最后一条用户消息检索匹配的技能 + 反思提示
      const enrichedContext = await enrichContext(
        projectContext,
        params.messages,
        params.enrichOptions,
      );

      // 将项目上下文 + 匹配的技能 + 反思提示注入到首条 user message
      const messagesWithContext = injectContext(params.messages, enrichedContext);

      // Per-turn 动态上下文注入到最新 user message（时间、任务状态等）
      const messagesWithTurnContext = turnContextInjector.inject(messagesWithContext);

      // pre-flight compact 检查 —— 防止上 run 尾累积到超标、下 run 入口直接送 LLM 爆 context。
      //
      // 关键设计（审查 V1）：必须在 messagesWithTurnContext 上跑，不能在 params.messages 上。
      //   params.messages 到 messagesWithTurnContext 的 token 增量可能达数 K（project context +
      //   enriched skills），在小模型（32K）上可能跨越一个预算阈值。pre-flight 必须看真实输入
      //   才能做出正确决策。
      //
      // 代价：如果 LLMSummarize 在 pre-flight 触发，注入的内容会被一起 summarize。7 段 prompt
      //   要求"标识符原样保留"，路径/文件名等保留；注入内容进入 summary 是冗余但不破坏语义。
      //
      // 终止归一化：复用 core 的 `resolveContextManager`，与 agent-loop 内部两条触发点
      // 共享同一判别逻辑（throw / aborted / overflow），避免第三处复制 abort 优先规则
      // 和 AgentError 包装 —— 新加触发点时只需做 shape 映射。
      let loopMessages = messagesWithTurnContext;

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
          // budget 快照用 messagesWithTurnContext —— 即使 engine 抛错也能给一个保守值
          budget: contextEngine.checkBudget(messagesWithTurnContext),
          toolEndCount: 0,
          injectedSkillIds: enrichedContext.injectedSkillIds,
          compactBefore,
        };
      };

      const preFlight = await resolveContextManager(
        contextEngine,
        {
          messages: messagesWithTurnContext,
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
        onBlocked: renderBlockedMessage,
        onUserDenied: renderUserDeniedMessage,
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
        // watchdog fallback 单点: spec 规定调用边界注入默认值, agent-loop 内部不二次 fallback
        // 保证调用方显式传入的 policy(含禁用 idle-timer 的 `{ idleTimeoutMs: 0 }`)一路透传
        watchdog: params.watchdog ?? DEFAULT_WATCHDOG_POLICY,
        deps: {
          callLLM: resilientCallLLM,
          executeTool: secureExecuteTool,
        },
        contextManager: contextEngine,
        llmRoles: roles,
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
     } finally {
       // 保证 accumulator 订阅被取消 —— 即使 preFlight throw / agent-loop throw /
       // 调用方中断 gen（触发 finally in for-of caller），listener 都能正确摘除。
       accumulator.dispose();
       // 中断渲染同样要 dispose: 取消 warn ticker + 移除 4 个事件 listener,
       // 防止 listener 跨 run 累积导致内存泄漏 / 重复渲染
       interruptRendering.dispose();
     }
    },
  };
}

// ─── 便捷函数：单次运行 ───

export async function runOnce(options: {
  prompt: string;
  model?: string;
  provider?: string;
  workspace?: string;
  onYield?: (event: AgentYield) => void;
  onBeforeEventRender?: () => void;
}): Promise<RunResult> {
  const runtime = await createAgentRuntime(options);
  return runtime.run({
    messages: [userMessage(options.prompt)],
    turnIndex: 0,   // 单次运行，turn 计数从 0 开始
    onYield: options.onYield,
    onBeforeEventRender: options.onBeforeEventRender,
  });
}

// ─── 消息追踪 ───

/**
 * 从 yield 事件中重建本轮产生的消息序列。
 */
function trackMessages(
  event: AgentYield,
  newMessages: Message[],
  pendingToolResults: ToolResultBlock[],
): void {
  switch (event.type) {
    case "assistant_message":
      newMessages.push(event.message);
      break;

    case "tool_end":
      pendingToolResults.push({
        type: "tool_result",
        toolUseId: event.id,
        content: event.result.content,
        isError: event.result.isError,
      });
      break;

    case "turn_complete":
      if (pendingToolResults.length > 0) {
        newMessages.push({
          role: "user",
          content: [...pendingToolResults],
        });
        pendingToolResults.length = 0;
      }
      break;
  }
}
