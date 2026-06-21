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
 *
 * 不做的事(分层关注点)：
 * - Usage 字段方言归一(prompt cache 命中字段在 vendor 间分裂为
 *   `prompt_tokens_details.cached_tokens` vs `prompt_cache_hit_tokens` 等)
 *   委托给 ./openai-usage.ts;主适配器对方言无感知。
 *   新 vendor 方言扩展见 openai-usage.ts 顶部"扩展点"注释。
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
import { parseOpenAICompatibleUsage } from "./openai-usage.js";
import { buildOpenAICompatibleThinkingParams } from "./thinking-params.js";

// ─── Vendor Protocol Extensions ───
//
// OpenAI 兼容生态在标准 ChatCompletion 类型之上演化出一类 vendor 私有扩展字段。
// 这些字段不在 OpenAI 官方 SDK 类型里,但已成为 de facto 标准——头部 vendor
// 提出后被同生态其他厂商沿用,横切覆盖 thinking 类模型的通信协议。
//
// 当前已知扩展:
//
//   reasoning_content (string)
//     出现在 stream delta 与 assistant message 上,内容是模型 thinking 阶段的
//     输出文本。multi-turn replay 时必须原样回传给服务端,缺失会被协议层 400
//     拒绝(DeepSeek thinking 模式严格校验;Qwen-QwQ / Kimi-thinking /
//     MoonShot reasoning / 智谱 GLM-Z 等沿用同一字段约定)。
//
//     本适配器协议级处理:有则透传,缺失自动跳过。对非 thinking 模型零影响,
//     字段从不出现在 delta 与出站 payload。
//
// 内部承载:reasoning_content 对应内部消息的 ThinkingBlock(语义同构,model
// reasoning trace)。入站 reasoning_content delta 复用 StreamEvent.thinking_delta
// 事件;出站时由 convertAssistantMessage 从 ThinkingBlock 拼回 reasoning_content。
//
// 扩展约定:
//   - 字段名属于 de facto 标准(多 vendor 沿用) → 在本 section 扩展接口
//   - 字段名在 vendor 间分裂(真正方言) → 抽 dialect 模块(参考 openai-usage.ts)

interface DeepSeekChatDeltaExtension {
  reasoning_content?: string;
}

type DeepSeekAssistantMessage = OpenAI.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

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

      // 思考参数按 provider 思考方言写成原生形态（anthropic 走自有协议，
      // 不应出现在 OpenAI 兼容路径；防御性归一为 none = 不发思考参数）。
      const thinkingDialect =
        provider.quirks.thinkingDialect === "anthropic"
          ? "none"
          : provider.quirks.thinkingDialect;
      const thinkingParams = buildOpenAICompatibleThinkingParams(
        thinkingDialect,
        request.thinking,
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
        ...thinkingParams,
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

      // Thinking 块状态机 —— OpenAI 兼容协议下 reasoning_content / content 没有
      // 显式 block_start/stop 事件,本状态机从字段切换推断 thinking 边界,emit
      // zhixing 内部 StreamEvent.thinking_block_start / thinking_block_end 与
      // anthropic 协议事件层对称(详见 core/types/llm.ts StreamEvent 注释):
      //
      //   首个 reasoning_content chunk → emit thinking_block_start + set true
      //   content / tool_calls 到达且 inThinking=true → emit thinking_block_end + set false
      //   finish_reason 到达且 inThinking=true → emit thinking_block_end 兜底
      //     (与 tool_call_end finish_reason 兜底同模式,防 LLM 只 think 不 content
      //     的极端场景 thinking 段悬挂)
      let inThinking = false;

      try {
        const stream = await client.chat.completions.create(params, {
          signal: request.abortSignal ?? undefined,
        });

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];

          if (chunk.usage) {
            // Vendor 方言归一(DeepSeek / OpenAI 标准 / MiniMax / Kimi 等)由
            // openai-usage.ts 统一处理;主适配器对方言分裂无感知。
            // preset 显式声明 quirks.usageDialect 走最短解析路径;否则 auto 嗅探。
            usage = parseOpenAICompatibleUsage(
              chunk.usage,
              provider.quirks.usageDialect,
            );
          }

          if (!choice) continue;

          const delta = choice.delta;

          // Reasoning 内容(vendor 协议扩展,详见顶部 Vendor Protocol Extensions
          // section)。DeepSeek 协议时序为 reasoning_content 先于 content,yield
          // 顺序对齐:thinking_block_start → thinking_delta → text_delta;字段
          // 缺失自动跳过。
          const reasoningDelta = (delta as DeepSeekChatDeltaExtension | undefined)
            ?.reasoning_content;
          if (reasoningDelta) {
            if (!inThinking) {
              yield { type: "thinking_block_start" };
              inThinking = true;
            }
            yield { type: "thinking_delta", thinking: reasoningDelta };
          }

          // 文本输出 —— content 到达即标志 thinking 流结束(若曾进入)
          if (delta?.content) {
            if (inThinking) {
              yield { type: "thinking_block_end" };
              inThinking = false;
            }
            yield { type: "text_delta", text: delta.content };
          }

          // 工具调用（流式）—— tool_calls 同 content 一样标志 thinking 流结束
          if (delta?.tool_calls) {
            if (inThinking) {
              yield { type: "thinking_block_end" };
              inThinking = false;
            }
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

          // 响应结束 —— 兜底关闭未关闭的 thinking 块与 tool_call 块,避免悬挂
          if (choice.finish_reason) {
            // 极端场景兜底:LLM 只 think 不输出 content(纯 reasoning),
            // finish_reason 触发但 inThinking 仍为 true → 关闭 thinking 边界
            if (inThinking) {
              yield { type: "thinking_block_end" };
              inThinking = false;
            }
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
      // user 消息可能包含 tool_result 和/或普通用户内容
      const toolResults = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      const userContentBlocks = msg.content.filter(
        (
          b,
        ): b is Extract<ContentBlock, { type: "text" | "image" }> =>
          b.type === "text" || b.type === "image",
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
        // 如果还有用户内容块，作为额外的 user 消息，并保留原始块顺序
        if (userContentBlocks.length > 0) {
          result.push({
            role: "user",
            content: convertUserContent(userContentBlocks),
          });
        }
      } else {
        result.push({
          role: "user",
          content: convertUserContent(userContentBlocks),
        });
      }
    }
  }

  return result;
}

function convertUserContent(
  blocks: readonly Extract<ContentBlock, { type: "text" | "image" }>[],
): OpenAI.ChatCompletionUserMessageParam["content"] {
  const hasImage = blocks.some((block) => block.type === "image");
  if (!hasImage) {
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n") || "";
  }

  const parts: NonNullable<
    Exclude<OpenAI.ChatCompletionUserMessageParam["content"], string>
  > = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) {
          parts.push({ type: "text", text: block.text });
        }
        break;
      case "image":
        parts.push({
          type: "image_url",
          image_url: {
            url:
              block.source.type === "url"
                ? block.source.url
                : `data:${block.source.mediaType};base64,${block.source.data}`,
          },
        });
        break;
    }
  }
  return parts;
}

function convertAssistantMessage(msg: Message): DeepSeekAssistantMessage {
  const content = msg.content;

  const textParts = content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  const thinkingParts = content
    .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
    .map((b) => b.thinking)
    .join("");

  const toolUses = content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );

  const result: DeepSeekAssistantMessage = {
    role: "assistant",
    content: textParts || null,
  };

  // Reasoning 内容(vendor 协议扩展,详见顶部 Vendor Protocol Extensions section)。
  // DeepSeek thinking 模式要求 multi-turn replay 时原样回传 reasoning_content,
  // 否则 400 拒绝;Qwen-QwQ / Kimi-thinking 等沿用同一约定。
  // 缺失 ThinkingBlock(非 thinking 模型) → 不写字段,出站 payload 与历史完全一致。
  if (thinkingParts) {
    result.reasoning_content = thinkingParts;
  }

  if (toolUses.length > 0) {
    result.tool_calls = toolUses.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    }));
  }

  return result;
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
