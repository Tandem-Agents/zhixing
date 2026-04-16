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
  type ContextBudget,
  type IConfirmationBroker,
  type Message,
  type ToolResultBlock,
  type IPermissionStore,
  ConfirmationBroker,
  createEventBus,
  createContextEngine,
  createTokenEstimator,
  createToolResultTrimStrategy,
  createMessageDropStrategy,
  createMemoryFlushStrategy,
  MemoryStore,
  PermissionStore,
  resolveAgentIdentity,
  SecurityPipeline,
  setAgentIdentity,
  userMessage,
  withRetry,
  runAgentLoop,
} from "@zhixing/core";
import {
  createProviderFromConfig,
  getGlobalConfigPath,
  resolveWorkspace,
  type ResolvedWorkspace,
} from "@zhixing/providers";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createBashTool,
  createMemoryTool,
} from "@zhixing/tools-builtin";
import {
  renderRetryAttempt,
  renderRetryExhausted,
  renderRetrySuccess,
  renderBudgetStatus,
  renderCompactStart,
  renderCompactEnd,
} from "./render.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadProjectContext, injectContext, enrichContext, type EnrichOptions } from "./project-context.js";
import {
  createSecureExecuteTool,
  type PromptFn,
} from "./security/index.js";

// ─── 类型 ───

export interface AgentSession {
  providerId: string;
  model: string;
  run: (params: RunParams) => Promise<RunResult>;
  /** 查询当前消息列表的上下文预算状态 */
  checkBudget: (messages: readonly Message[]) => ContextBudget | undefined;
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
}

export interface ForceCompactResult {
  modified: boolean;
  messages: Message[];
  budget?: ContextBudget;
}

export interface RunParams {
  messages: Message[];
  onYield?: (event: AgentYield) => void;
  /** 在渲染 EventBus 事件（重试/预算）前调用，用于暂停 spinner 等 UI 动画 */
  onBeforeEventRender?: () => void;
  /** 反思相关选项（上一轮工具调用数、是否已提议过） */
  enrichOptions?: EnrichOptions;
  /**
   * 安全确认对话框的提示器。REPL 注入 rl.question；
   * 不提供时 confirm 决策会被视为 block（适合 CI / 一次性脚本）。
   */
  securityPrompt?: PromptFn;
}

export interface RunResult {
  agentResult: AgentResult;
  /** 本轮产生的新消息（assistant + tool_result），调用方追加到对话历史 */
  newMessages: Message[];
  durationMs: number;
  /** 运行结束后的上下文预算快照（渐进式摘要行使用） */
  budget?: ContextBudget;
  /** 本轮工具调用完成次数（tool_end 事件数），用于反思触发 */
  toolEndCount: number;
  /** 本轮注入的技能 ID 列表（用于效果推断） */
  injectedSkillIds: string[];
  /** 本轮是否发生了上下文压缩（用于写入 compact 行） */
  compactInfo?: CompactInfo;
}

export interface CompactInfo {
  summary: string;
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
}

// ─── 创建会话 ───

/**
 * 创建一个 Agent 会话。会话持有 Provider/Tools/EventBus 实例，
 * 可多次调用 run() 执行不同的对话。
 */
export async function createSession(options: {
  model?: string;
  provider?: string;
  workspace?: string;
}): Promise<AgentSession> {
  const { provider, defaultModel, config } = createProviderFromConfig({
    providerId: options.provider,
  });

  // 应用级身份单例：启动时设一次，后续所有 user-facing 字符串通过
  // getAgentIdentity() 读取。默认 "知行"，可通过 zhixing.config.json
  // 的 agent.displayName 覆盖。
  setAgentIdentity(resolveAgentIdentity(config.agent));

  const model = options.model ?? defaultModel;
  const cwd = process.cwd();

  // 工作区解析：按优先级链 CLI > 目录级配置 > 全局配置 > cwd 兜底
  const sessionType: "interactive" | "ci" = process.stdin.isTTY
    ? "interactive"
    : "ci";
  const workspace = resolveWorkspace(config, {
    cliWorkspace: options.workspace,
    sessionType,
  });

  const tools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createMemoryTool(),
  ];
  const systemPrompt = buildSystemPrompt({
    tools,
    cwd,
    workspace: workspace.path,
    workspaceSource: workspace.source,
    globalConfigPath: getGlobalConfigPath(),
  });

  // 安全管线：会话级单例，跨多次 run() 共享权限规则、确认追踪、频率限制状态。
  // 持久化 store 落盘到 ~/.zhixing/permissions/，规则跨进程保留。
  // workspace 由 resolveWorkspace 按优先级链解析，不再硬编码 cwd。
  const persistentStore = new PermissionStore({});
  const securityPipeline = new SecurityPipeline({
    workspace: workspace.path,
    sessionType,
    permissionStore: persistentStore,
  });

  // 确认交互 broker：会话级单例。渲染器由 REPL 在 attach 时注入。
  // 非交互模式（CI / 管道）下 broker 自动走 fail-to-deny 策略。
  const confirmationBroker = new ConfirmationBroker();

  // 加载项目上下文（ZHIXING.md + 环境信息），注入到首条 user message
  const projectContext = await loadProjectContext(cwd);

  // 从 provider 获取模型信息，构建上下文引擎组件
  // estimator 跨 run() 共享以保持校准状态
  const modelInfo = provider.models.find((m) => m.id === model) ?? provider.models[0];
  const estimator = createTokenEstimator();
  const memoryStore = new MemoryStore();

  // Flush 用的 LLM 调用：消费流式响应，拼接 text_delta 为完整文本
  const flushCallLLM = async (msgs: Message[]): Promise<string> => {
    const chunks: string[] = [];
    for await (const event of provider.chat({ model, messages: msgs, tools: [] })) {
      if (event.type === "text_delta") {
        chunks.push(event.text);
      }
    }
    return chunks.join("") || "[]";
  };

  const strategies = [
    createToolResultTrimStrategy(),
    createMemoryFlushStrategy({ callLLM: flushCallLLM, store: memoryStore }),
    createMessageDropStrategy(),
  ];
  const modelBudgetInfo = modelInfo
    ? { contextWindow: modelInfo.contextWindow, maxOutputTokens: modelInfo.maxOutputTokens }
    : undefined;

  return {
    providerId: config.defaultProvider ?? provider.id,
    model,
    securityPipeline,
    permissionStore: persistentStore,
    confirmationBroker,
    resolvedWorkspace: workspace,

    get calibrationFactor(): number {
      return estimator.calibrationFactor;
    },

    checkBudget(messages: readonly Message[]): ContextBudget | undefined {
      if (!modelBudgetInfo) return undefined;
      const engine = createContextEngine(estimator, strategies, { modelInfo: modelBudgetInfo });
      return engine.checkBudget(messages);
    },

    async callText(prompt: string): Promise<string> {
      return flushCallLLM([userMessage(prompt)]);
    },

    async forceCompact(messages: Message[], turnCount: number): Promise<ForceCompactResult> {
      if (!modelBudgetInfo) return { modified: false, messages };
      const engine = createContextEngine(estimator, strategies, { modelInfo: modelBudgetInfo });
      const result = await engine.onTurnComplete({ messages, turnCount });
      if (!result.modified) {
        // 自动压缩因阈值未达而跳过，强制用较低阈值重试
        const forceEngine = createContextEngine(estimator, strategies, {
          modelInfo: modelBudgetInfo,
          thresholds: { warning: 0, compact: 0, critical: 0.95 },
        });
        const forceResult = await forceEngine.onTurnComplete({ messages, turnCount });
        const budget = engine.checkBudget(forceResult.messages);
        return { modified: forceResult.modified, messages: forceResult.messages, budget };
      }
      const budget = engine.checkBudget(result.messages);
      return { modified: result.modified, messages: result.messages, budget };
    },

    async run(params: RunParams): Promise<RunResult> {
      const eventBus = createEventBus<AgentEventMap>();
      const startTime = Date.now();

      // 收集本轮产生的新消息，用于 REPL 对话历史
      const newMessages: Message[] = [];
      let pendingToolResults: ToolResultBlock[] = [];
      let toolEndCount = 0;
      let compactInfo: CompactInfo | undefined;

      // 通过 deps.callLLM 注入容错能力，agent-loop.ts 零修改
      const resilientCallLLM = withRetry(
        (request) => provider.chat(request),
        { eventBus },
      );

      // 每次 run 创建带 eventBus 的引擎实例（事件需绑定到当前 run 的 eventBus）
      const contextEngine = modelBudgetInfo
        ? createContextEngine(estimator, strategies, { modelInfo: modelBudgetInfo }, eventBus)
        : undefined;

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

      // 订阅上下文事件 → 仅在 warning+ 时渲染（normal 由摘要行覆盖）
      eventBus.on("context:budget_check", (info) => {
        if (info.status === "warning" || info.status === "compact" || info.status === "critical") {
          pauseUI();
          renderBudgetStatus(info);
        }
      });
      eventBus.on("context:compact_start", (info) => {
        pauseUI();
        renderCompactStart(info);
      });
      eventBus.on("context:compact_end", (info) => {
        pauseUI();
        renderCompactEnd(info);
        if (info.success) {
          compactInfo = {
            summary: "(auto-compacted)",
            turnsCompacted: 0,
            tokensBefore: info.tokensBefore,
            tokensAfter: info.tokensAfter,
          };
        }
      });

      // 根据最后一条用户消息检索匹配的技能 + 反思提示
      const enrichedContext = await enrichContext(
        projectContext,
        params.messages,
        params.enrichOptions,
      );

      // 将项目上下文 + 匹配的技能 + 反思提示注入到首条 user message
      const messagesWithContext = injectContext(params.messages, enrichedContext);

      // 用 SecurityPipeline 包装工具执行——每次 run() 重新构造 wrapper。
      // 同时传入 broker（会话级，跨 run 共享队列）和 legacy prompt（回退路径）。
      // secure-executor 内部按 env `ZHIXING_CONFIRMATION_RENDERER` 决定走哪条。
      const secureExecuteTool = createSecureExecuteTool({
        pipeline: securityPipeline,
        originalExecute: (tool, input, context) => tool.call(input, context),
        prompt: params.securityPrompt,
        broker: confirmationBroker,
        sessionType,
      });

      const gen = runAgentLoop({
        provider,
        model,
        tools,
        messages: messagesWithContext,
        systemPrompt,
        eventBus,
        workingDirectory: process.cwd(),
        deps: {
          callLLM: resilientCallLLM,
          executeTool: secureExecuteTool,
        },
        contextManager: contextEngine,
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

          const budget = contextEngine?.checkBudget(allMessages);

          return {
            agentResult: value,
            newMessages,
            durationMs: Date.now() - startTime,
            budget,
            toolEndCount,
            injectedSkillIds: enrichedContext.injectedSkillIds,
            compactInfo,
          };
        }

        // 通知调用方（渲染用）
        params.onYield?.(value);

        // 追踪消息以维护对话历史
        if (value.type === "tool_end") toolEndCount++;
        trackMessages(value, newMessages, pendingToolResults);
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
  const session = await createSession(options);
  return session.run({
    messages: [userMessage(options.prompt)],
    onYield: options.onYield,
    onBeforeEventRender: options.onBeforeEventRender,
  });
}

// ─── 消息追踪 ───

/**
 * 从 yield 事件中重建本轮产生的消息序列。
 *
 * Agent Loop 内部维护了完整的消息历史，但不对外暴露。
 * REPL 需要在外部维护历史以实现多轮对话。
 *
 * 重建规则（与 agent-loop.ts 内部行为一致）：
 * - assistant_message → 追加到 newMessages
 * - tool_end → 收集 ToolResultBlock
 * - turn_complete → 将收集的 tool results 组装为 user 消息，追加到 newMessages
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
