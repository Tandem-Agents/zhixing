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

import type OpenAI from "openai";
import type {
  ChatRequest,
  LLMProvider,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@zhixing-ai/core";
import {
  coalesceUserMaterialTextBlocks,
  isSameTrustedThinkingSource,
  type ContentBlock,
  type Message,
  type ToolSpec,
} from "@zhixing-ai/core";
import type { ResolvedProvider } from "../types.js";
import {
  createConnectionDeliveryFetch,
  deliveryFetch,
  newDelivery,
  withDelivery,
  type ConnectionDeliveryTransport,
} from "./delivery-transport.js";
import { parseOpenAICompatibleUsage } from "./openai-usage.js";
import { markResponseStreamInterrupted } from "@zhixing-ai/core/resilience";
import {
  buildThinkingProtocolState,
  collectBoundSecrets,
  normalizeAdapterError,
  resolveAdapterProvenance,
  type AdapterProvenance,
} from "./protocol-helpers.js";
import {
  buildOpenAICompatibleThinkingParams,
  supportsOpenAICompatibleReasoningContentReplay,
} from "./thinking-params.js";

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
  const connectionTransport: ConnectionDeliveryTransport | undefined =
    provider.network !== undefined || provider.networkProxy !== undefined
      ? createConnectionDeliveryFetch({
          proxyPolicy: provider.network?.proxy ?? "inherit",
          networkProxy: provider.networkProxy,
          allowPrivateOrigin: provider.network?.allowPrivateOrigin,
          confirmedOrigin: provider.baseUrl,
        })
      : undefined;
  const boundFetch = connectionTransport?.fetch ?? deliveryFetch;

  // SDK 在首次真正调用模型时才加载并构造，不进入宿主启动的模块图；加载失败下次重试。
  let client: Promise<OpenAI> | undefined;
  const connect = (): Promise<OpenAI> => {
    client ??= import("openai").then(({ default: OpenAI }) => {
      const authMode = provider.authMode ?? "api-key";
      const customHeaders: Record<string, string | null> | undefined =
        authMode === "none"
          ? { Authorization: null }
          : authMode === "header" && provider.authHeaderName
            ? { Authorization: null, [provider.authHeaderName]: provider.apiKey }
            : undefined;
      return new OpenAI({
        baseURL: provider.baseUrl,
        // 免密或自定义头模式不发送假 Bearer Key（通过 defaultHeaders 移除 Authorization）
        apiKey: authMode === "api-key" ? provider.apiKey : "not-used",
        ...(customHeaders ? { defaultHeaders: customHeaders } : {}),
        // 重试只在 core 的 withRetry 一层：一次调用只发一次请求，界面显示的重试次数也是真实次数
        maxRetries: 0,
        // 受控传输按调用记账，只有整次调用都没送达才给错误打未送达标记（计量据此按 0 token 结算）
        fetch: boundFetch,
      });
    });
    client.catch(() => { client = undefined; });
    return client;
  };

  const provenance = resolveAdapterProvenance(provider, "openai-compatible");
  const boundSecrets = collectBoundSecrets(provider);
  const thinkingDialect =
    provider.quirks.thinkingDialect === "anthropic" ||
    provider.quirks.thinkingDialect === "openai-responses" ||
    provider.quirks.thinkingDialect === "google-interactions"
      ? "none"
      : provider.quirks.thinkingDialect;
  const allowReasoningReplay =
    supportsOpenAICompatibleReasoningContentReplay(thinkingDialect);

  return {
    id: provider.id,
    protocol: "openai-compatible",
    sourceConnectionId: provenance.sourceConnectionId,
    sourceOriginKey: provenance.sourceOriginKey,
    appendOnlyTurnContext: false,
    async close(): Promise<void> {
      await connectionTransport?.close();
    },
    models: provider.declaredModels,

    async prepare(): Promise<void> {
      await connect();
    },

    async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const openaiMessages = convertMessages(
        request.messages,
        provenance,
        allowReasoningReplay,
      );
      const tools = request.tools ? convertTools(request.tools) : undefined;

      const maxTokensParam = buildMaxTokensParam(
        provider.quirks.maxTokensField,
        request.maxTokens ?? 4096,
      );

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
      let responseStreamStarted = false;

      const delivery = newDelivery();
      try {
        const stream = await withDelivery(delivery, async () => (await connect()).chat.completions.create(params, {
          signal: request.abortSignal ?? undefined,
        }));
        responseStreamStarted = true;

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
              yield {
                type: "thinking_block_end",
                protocolState: buildThinkingProtocolState(provenance, request.model),
              };
              inThinking = false;
            }
            yield { type: "text_delta", text: delta.content };
          }

          // 工具调用（流式）—— tool_calls 同 content 一样标志 thinking 流结束
          if (delta?.tool_calls) {
            if (inThinking) {
              yield {
                type: "thinking_block_end",
                protocolState: buildThinkingProtocolState(provenance, request.model),
              };
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
              yield {
                type: "thinking_block_end",
                protocolState: buildThinkingProtocolState(provenance, request.model),
              };
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
        if (request.abortSignal?.aborted) {
          yield {
            type: "error",
            error: normalizeAdapterError(
              new DOMException("The operation was aborted.", "AbortError"),
              delivery,
              boundSecrets,
            ),
          };
          return;
        }
      } catch (err) {
        const normalized = normalizeAdapterError(err, delivery, boundSecrets);
        if (responseStreamStarted && !request.abortSignal?.aborted) {
          markResponseStreamInterrupted(normalized);
        }
        yield {
          type: "error",
          error: normalized,
        };
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
function convertMessages(
  messages: Message[],
  provenance: AdapterProvenance,
  allowReasoningReplay: boolean,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(convertAssistantMessage(msg, provenance, allowReasoningReplay));
    } else {
      // user 消息可能包含 tool_result 和/或普通用户内容；含文件材料描述的连续文本块按原拼接语义折叠
      const normalizedBlocks = coalesceUserMaterialTextBlocks(msg.content);
      const toolResults = normalizedBlocks.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      const userContentBlocks = normalizedBlocks.filter(
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

function convertAssistantMessage(
  msg: Message,
  provenance: AdapterProvenance,
  allowReasoningReplay: boolean,
): DeepSeekAssistantMessage {
  const content = msg.content;

  const textParts = content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 设计 §2.3：仅当目标连接方言支持 reasoning_content 且思考块经非秘密来源身份核对为同来源时才发送；
  // 跨连接、同连接改址、跨协议、来源不明旧记录或保守聚合端一律省略该私有字段，不盲目外传。
  const thinkingParts = allowReasoningReplay
    ? content
        .filter(
          (b): b is Extract<ContentBlock, { type: "thinking" }> =>
            b.type === "thinking" &&
            isSameTrustedThinkingSource(b.protocolState, provenance),
        )
        .map((b) => b.thinking)
        .join("")
    : "";

  const toolUses = content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );

  const result: DeepSeekAssistantMessage = {
    role: "assistant",
    content: textParts || null,
  };

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
