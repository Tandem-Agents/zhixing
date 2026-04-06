/**
 * streamLLMCall — 流式 LLM 调用子生成器
 *
 * 职责：
 * 1. 构建 ChatRequest 并调用 LLM Provider
 * 2. 消费流式事件，组装完整的 assistant Message
 * 3. 将 text_delta / thinking_delta 透传给消费者（通过 yield）
 * 4. 解析工具调用参数（流式 JSON 拼接）
 * 5. 通过 EventBus 发射 LLM 相关事件
 *
 * 为什么是子生成器：
 * - 通过 yield* 在主循环中调用，消费者的 yield 链路不断裂
 * - return 返回 LLMCallResult，调用方直接解构使用
 * - 关注点分离：流处理逻辑独立于循环编排
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { AgentError } from "../types/errors.js";
import type { ChatRequest, StopReason, TokenUsage } from "../types/llm.js";
import { emptyUsage } from "../types/llm.js";
import type { ContentBlock, Message } from "../types/messages.js";
import type { ToolSpec } from "../types/tools.js";
import type { AgentLoopDeps, AgentYield, LLMCallResult } from "./types.js";

interface StreamLLMCallParams {
  deps: AgentLoopDeps;
  messages: readonly Message[];
  model: string;
  systemPrompt?: string;
  toolSpecs: ToolSpec[];
  abortSignal?: AbortSignal;
  eventBus?: IEventBus<AgentEventMap>;
}

/**
 * 发起一次流式 LLM 调用。
 *
 * yield: text_delta / thinking_delta / assistant_message
 * return: LLMCallResult（包含组装好的 Message、stopReason、usage、可能的错误）
 */
export async function* streamLLMCall(
  params: StreamLLMCallParams,
): AsyncGenerator<AgentYield, LLMCallResult> {
  const { deps, messages, model, systemPrompt, toolSpecs, abortSignal, eventBus } = params;

  const request: ChatRequest = {
    model,
    systemPrompt,
    messages: messages as Message[],
    tools: toolSpecs.length > 0 ? toolSpecs : undefined,
    abortSignal,
  };

  await eventBus?.emit("llm:request_start", {
    model,
    messageCount: messages.length,
    hasTools: toolSpecs.length > 0,
  });

  const startTime = Date.now();
  const contentBlocks: ContentBlock[] = [];

  // 用于积累流式文本/思考
  let pendingText = "";
  let pendingThinking = "";

  // 用于解析流式工具调用
  const pendingToolCalls = new Map<string, { id: string; name: string; argsJson: string }>();

  let stopReason: StopReason = "end_turn";
  let usage: TokenUsage = emptyUsage();

  try {
    const stream = deps.callLLM(request);

    for await (const event of stream) {
      // 透传原始流事件到 EventBus（供 UI 层消费）
      await eventBus?.emit("llm:stream_event", event);

      switch (event.type) {
        case "text_delta":
          pendingText += event.text;
          yield { type: "text_delta", text: event.text };
          break;

        case "thinking_delta":
          pendingThinking += event.thinking;
          yield { type: "thinking_delta", thinking: event.thinking };
          break;

        case "tool_call_start":
          pendingToolCalls.set(event.id, { id: event.id, name: event.name, argsJson: "" });
          break;

        case "tool_call_delta": {
          const pending = pendingToolCalls.get(event.id);
          if (pending) {
            pending.argsJson += event.argsFragment;
          }
          break;
        }

        case "tool_call_end":
          // tool_call_end 不需要额外处理，参数在 message_end 后统一解析
          break;

        case "message_end":
          stopReason = event.stopReason;
          usage = event.usage;
          break;

        case "error":
          return {
            message: assembleMessage(contentBlocks, pendingText, pendingThinking, pendingToolCalls),
            stopReason,
            usage,
            error: new AgentError(
              event.error.message,
              "provider_error",
              true,
              event.error,
            ),
          };

        case "message_start":
          break;
      }
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    await eventBus?.emit("llm:request_end", {
      model,
      duration,
      usage,
      stopReason,
    });

    const agentError = err instanceof AgentError
      ? err
      : new AgentError(
          err instanceof Error ? err.message : String(err),
          "provider_error",
          true,
          err,
        );

    return {
      message: assembleMessage(contentBlocks, pendingText, pendingThinking, pendingToolCalls),
      stopReason,
      usage,
      error: agentError,
    };
  }

  const message = assembleMessage(contentBlocks, pendingText, pendingThinking, pendingToolCalls);

  const duration = Date.now() - startTime;
  await eventBus?.emit("llm:request_end", {
    model,
    duration,
    usage,
    stopReason,
  });

  yield { type: "assistant_message", message };

  return { message, stopReason, usage };
}

// ─── 内部辅助 ───

/**
 * 将积累的流式内容组装为完整的 assistant Message。
 * 顺序：ThinkingBlock → TextBlock → ToolUseBlock[]
 */
function assembleMessage(
  existingBlocks: ContentBlock[],
  pendingText: string,
  pendingThinking: string,
  pendingToolCalls: Map<string, { id: string; name: string; argsJson: string }>,
): Message {
  const content: ContentBlock[] = [...existingBlocks];

  if (pendingThinking) {
    content.push({ type: "thinking", thinking: pendingThinking });
  }
  if (pendingText) {
    content.push({ type: "text", text: pendingText });
  }
  for (const tc of pendingToolCalls.values()) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: parseToolCallArgs(tc.argsJson),
    });
  }

  return { role: "assistant", content };
}

/**
 * 安全解析工具调用参数 JSON。
 * 解析失败时返回空对象 —— 工具执行器会处理参数缺失的情况。
 */
function parseToolCallArgs(argsJson: string): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
