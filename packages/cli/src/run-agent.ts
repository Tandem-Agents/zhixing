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
  type Message,
  type ToolResultBlock,
  createEventBus,
  userMessage,
  withRetry,
  runAgentLoop,
} from "@zhixing/core";
import { createProviderFromConfig } from "@zhixing/providers";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createBashTool,
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

// ─── 类型 ───

export interface AgentSession {
  providerId: string;
  model: string;
  run: (params: RunParams) => Promise<RunResult>;
}

export interface RunParams {
  messages: Message[];
  onYield?: (event: AgentYield) => void;
  /** 在渲染 EventBus 事件（重试/预算）前调用，用于暂停 spinner 等 UI 动画 */
  onBeforeEventRender?: () => void;
}

export interface RunResult {
  agentResult: AgentResult;
  /** 本轮产生的新消息（assistant + tool_result），调用方追加到对话历史 */
  newMessages: Message[];
  durationMs: number;
}

// ─── 创建会话 ───

/**
 * 创建一个 Agent 会话。会话持有 Provider/Tools/EventBus 实例，
 * 可多次调用 run() 执行不同的对话。
 */
export function createSession(options: {
  model?: string;
  provider?: string;
}): AgentSession {
  const { provider, defaultModel, config } = createProviderFromConfig({
    providerId: options.provider,
  });

  const model = options.model ?? defaultModel;
  const tools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
  ];
  const systemPrompt = buildSystemPrompt(process.cwd());

  return {
    providerId: config.defaultProvider ?? provider.id,
    model,

    async run(params: RunParams): Promise<RunResult> {
      const eventBus = createEventBus<AgentEventMap>();
      const startTime = Date.now();

      // 收集本轮产生的新消息，用于 REPL 对话历史
      const newMessages: Message[] = [];
      let pendingToolResults: ToolResultBlock[] = [];

      // 通过 deps.callLLM 注入容错能力，agent-loop.ts 零修改
      const resilientCallLLM = withRetry(
        (request) => provider.chat(request),
        { eventBus },
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

      // 订阅上下文事件 → 预算状态 + 压缩过程
      eventBus.on("context:budget_check", (info) => {
        pauseUI();
        renderBudgetStatus(info);
      });
      eventBus.on("context:compact_start", (info) => {
        pauseUI();
        renderCompactStart(info);
      });
      eventBus.on("context:compact_end", (info) => {
        pauseUI();
        renderCompactEnd(info);
      });

      const gen = runAgentLoop({
        provider,
        model,
        tools,
        messages: params.messages,
        systemPrompt,
        eventBus,
        workingDirectory: process.cwd(),
        deps: { callLLM: resilientCallLLM },
      });

      while (true) {
        const { value, done } = await gen.next();

        if (done) {
          return {
            agentResult: value,
            newMessages,
            durationMs: Date.now() - startTime,
          };
        }

        // 通知调用方（渲染用）
        params.onYield?.(value);

        // 追踪消息以维护对话历史
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
  onYield?: (event: AgentYield) => void;
  onBeforeEventRender?: () => void;
}): Promise<RunResult> {
  const session = createSession(options);
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
