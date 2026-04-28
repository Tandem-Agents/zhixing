/**
 * OpenAI Compatible 协议适配器
 *
 * 将 ResolvedProvider 转为实现 LLMProvider 接口的实例。
 * 通过 OpenAI SDK 连接所有 OpenAI 兼容服务商：
 * DeepSeek、MiniMax、Kimi、千问、GLM、硅基流动、OpenAI 等。
 *
 * 职责：
 * - 构建 OpenAI SDK client（baseUrl + apiKey）
 * - ChatRequest → OpenAI SDK 请求格式
 * - OpenAI SDK 流式响应 → StreamEvent
 * - 通过 quirks 处理服务商差异
 */

import OpenAI from "openai";
import type {
  ChatRequest,
  LLMProvider,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@zhixing/core";
import type { Message, ContentBlock, ToolSpec } from "@zhixing/core";
import type { ResolvedProvider } from "../types.js";

// ─── 工厂函数 ───

/**
 * 根据 ResolvedProvider 创建 LLMProvider 实例。
 *
 * `LLMProvider.models[]` 直接复用 `provider.declaredModels`——catalog 数据本身就是
 * `ModelInfo` 形态，无需转换。网关型 provider 一般 declaredModels=[]；catalog 之外
 * 的 model 由 core/resolveModelInfo 走协议族默认（PROTOCOL_BUDGET_DEFAULTS["openai-compatible"]）兜底。
 */
export function createOpenAICompatibleProvider(provider: ResolvedProvider): LLMProvider {
  const client = new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
  });

  return {
    id: provider.id,
    models: provider.declaredModels,

    async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const openaiMessages = convertMessages(request.messages);
      const tools = request.tools ? convertTools(request.tools) : undefined;

      const maxTokensParam = buildMaxTokensParam(
        provider.quirks.maxTokensField,
        request.maxTokens ?? 4096,
      );

      const params: OpenAI.ChatCompletionCreateParamsStreaming = {
        model: request.model,
        messages: openaiMessages,
        stream: true,
        stream_options: provider.quirks.supportsStreamUsage
          ? { include_usage: true }
          : undefined,
        ...maxTokensParam,
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.stopSequences ? { stop: request.stopSequences } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(request.systemPrompt ? {} : {}),
      };

      // system prompt 作为首条 system 消息插入
      if (request.systemPrompt) {
        params.messages = [
          { role: "system" as const, content: request.systemPrompt },
          ...params.messages,
        ];
      }

      yield { type: "message_start" };

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";

      // 追踪工具调用状态
      const activeToolCalls = new Map<number, { id: string; name: string }>();

      try {
        const stream = await client.chat.completions.create(params, {
          signal: request.abortSignal ?? undefined,
        });

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];

          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          if (!choice) continue;

          const delta = choice.delta;

          // 文本输出
          if (delta?.content) {
            yield { type: "text_delta", text: delta.content };
          }

          // 工具调用（流式）
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;

              // 新的工具调用开始
              if (tc.id && tc.function?.name) {
                activeToolCalls.set(idx, { id: tc.id, name: tc.function.name });
                yield {
                  type: "tool_call_start",
                  id: tc.id,
                  name: tc.function.name,
                };
              }

              // 工具参数增量
              if (tc.function?.arguments) {
                const active = activeToolCalls.get(idx);
                if (active) {
                  yield {
                    type: "tool_call_delta",
                    id: active.id,
                    argsFragment: tc.function.arguments,
                  };
                }
              }
            }
          }

          // 响应结束
          if (choice.finish_reason) {
            // 发射所有未结束的工具调用的 end 事件
            for (const [, active] of activeToolCalls) {
              yield { type: "tool_call_end", id: active.id };
            }
            activeToolCalls.clear();

            stopReason = mapFinishReason(choice.finish_reason);
          }
        }
      } catch (err) {
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
        return;
      }

      yield { type: "message_end", stopReason, usage };
    },
  };
}

// ─── 消息格式转换 ───

/**
 * 将内部消息格式转为 OpenAI SDK 格式。
 *
 * 关键差异：我们的 tool_result 在 user 消息的 content 中，
 * OpenAI 格式需要独立的 { role: "tool" } 消息。
 */
function convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(convertAssistantMessage(msg));
    } else {
      // user 消息可能包含 tool_result 和/或 text
      const toolResults = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      const textBlocks = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      );

      if (toolResults.length > 0) {
        // tool_result → 每个转为独立的 { role: "tool" } 消息
        for (const tr of toolResults) {
          result.push({
            role: "tool" as const,
            tool_call_id: tr.toolUseId,
            content: tr.content,
          });
        }
        // 如果还有文本块，作为额外的 user 消息
        if (textBlocks.length > 0) {
          result.push({
            role: "user",
            content: textBlocks.map((b) => b.text).join("\n"),
          });
        }
      } else {
        // 纯文本 user 消息
        const text = textBlocks.map((b) => b.text).join("\n");
        result.push({ role: "user", content: text || "" });
      }
    }
  }

  return result;
}

function convertAssistantMessage(msg: Message): OpenAI.ChatCompletionAssistantMessageParam {
  const content = msg.content;

  const textParts = content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolUses = content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );

  if (toolUses.length === 0) {
    return { role: "assistant", content: textParts || null };
  }

  return {
    role: "assistant",
    content: textParts || null,
    tool_calls: toolUses.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    })),
  };
}

// ─── 工具格式转换 ───

function convertTools(tools: ToolSpec[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
    },
  }));
}

// ─── 辅助函数 ───

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function buildMaxTokensParam(
  field: "max_tokens" | "max_completion_tokens",
  value: number,
): Record<string, number> {
  return { [field]: value };
}
