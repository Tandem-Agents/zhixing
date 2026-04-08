/**
 * Anthropic Messages 协议适配器
 *
 * 通过 @anthropic-ai/sdk 直连 Anthropic Messages API。
 *
 * 设计决策（详见 research/design/specifications/anthropic-adapter.md）：
 * - 消费原始 SSE 事件流，不用 SDK 高级抽象（避免部分 JSON 解析的 O(n²)）
 * - 工具参数累积原始 JSON 字符串，完成时一次解析
 * - cache_control 放在 system prompt 和最后一条 user 消息上（低成本高收益）
 * - 不做重试 / Failover —— 那是 Resilience 层的职责
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@zhixing/core";
import type { Message, ContentBlock, ToolSpec } from "@zhixing/core";
import type { ResolvedProvider } from "../types.js";

// ─── 内部类型 ───

type BlockState =
  | { type: "text" }
  | { type: "thinking" }
  | { type: "tool_use"; id: string; name: string; argsJson: string };

// ─── 工厂函数 ───

export function createAnthropicProvider(resolved: ResolvedProvider): LLMProvider {
  const client = new Anthropic({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl || undefined,
  });

  const defaultModel = resolved.defaultModel ?? "claude-sonnet-4-20250514";

  const modelInfo: ModelInfo = {
    id: defaultModel,
    name: defaultModel,
    provider: resolved.id,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    supportsThinking: resolved.quirks.supportsThinking,
    supportsTools: resolved.quirks.supportsTools,
    supportsImages: true,
  };

  return {
    id: resolved.id,
    models: [modelInfo],

    async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const messages = convertMessages(request.messages);
      const tools = request.tools ? convertTools(request.tools) : undefined;

      const params: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxTokens ?? 8192,
        messages,
        stream: true,
      };

      if (request.systemPrompt) {
        params.system = [
          {
            type: "text",
            text: request.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ];
      }

      if (request.temperature != null) {
        params.temperature = request.temperature;
      }

      if (request.stopSequences) {
        params.stop_sequences = request.stopSequences;
      }

      if (tools && tools.length > 0) {
        params.tools = tools;
      }

      applyCacheControlToLastUserMessage(messages);

      yield { type: "message_start" };

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      const blocks = new Map<number, BlockState>();

      try {
        const stream = await client.messages.create(
          params as unknown as Anthropic.MessageCreateParamsStreaming,
          request.abortSignal ? { signal: request.abortSignal } : undefined,
        );

        for await (const event of stream) {
          switch (event.type) {
            case "message_start": {
              usage = extractUsage(event.message.usage);
              break;
            }

            case "content_block_start": {
              const cb = event.content_block;
              if (cb.type === "text") {
                blocks.set(event.index, { type: "text" });
              } else if (cb.type === "thinking") {
                blocks.set(event.index, { type: "thinking" });
              } else if (cb.type === "tool_use") {
                blocks.set(event.index, {
                  type: "tool_use",
                  id: cb.id,
                  name: cb.name,
                  argsJson: "",
                });
                yield { type: "tool_call_start", id: cb.id, name: cb.name };
              }
              break;
            }

            case "content_block_delta": {
              const block = blocks.get(event.index);
              if (!block) break;

              const delta = event.delta;
              if (delta.type === "text_delta" && block.type === "text") {
                yield { type: "text_delta", text: delta.text };
              } else if (
                delta.type === "thinking_delta" &&
                block.type === "thinking"
              ) {
                yield {
                  type: "thinking_delta",
                  thinking: delta.thinking,
                };
              } else if (
                delta.type === "input_json_delta" &&
                block.type === "tool_use"
              ) {
                block.argsJson += delta.partial_json;
                yield {
                  type: "tool_call_delta",
                  id: block.id,
                  argsFragment: delta.partial_json,
                };
              }
              // signature_delta：累积但不发射（由 LLM call 层在需要时使用）
              break;
            }

            case "content_block_stop": {
              const block = blocks.get(event.index);
              if (block?.type === "tool_use") {
                yield { type: "tool_call_end", id: block.id };
              }
              break;
            }

            case "message_delta": {
              stopReason = mapStopReason(event.delta.stop_reason);
              if (event.usage) {
                usage.outputTokens = event.usage.output_tokens;
              }
              break;
            }

            case "message_stop":
              break;
          }
        }
      } catch (err) {
        yield {
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        };
        return;
      }

      yield { type: "message_end", stopReason, usage };
    },
  };
}

// ─── 消息格式转换 ───

/**
 * 内部 Message → Anthropic MessageParam。
 *
 * 内部格式按 Anthropic 模型设计，所以转换相对简单：
 * - tool_result 留在 user 消息的 content 数组中（不像 OpenAI 需要独立 role=tool）
 * - 字段命名从 camelCase 转 snake_case
 */
function convertMessages(
  messages: Message[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map(convertContentBlock),
  }));
}

function convertContentBlock(
  block: ContentBlock,
): Anthropic.Messages.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };

    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };

    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError ?? false,
      };

    case "image":
      if (block.source.type === "base64") {
        return {
          type: "image",
          source: {
            type: "base64" as const,
            media_type: block.source.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: block.source.data,
          },
        };
      }
      // URL 图片不被 Anthropic 直接支持，降级为文本描述
      return { type: "text", text: `[Image: ${block.source.url}]` };

    case "thinking":
      return { type: "text", text: block.thinking };
  }
}

// ─── 工具格式转换 ───

function convertTools(
  tools: ToolSpec[],
): Anthropic.Messages.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object" as const,
      properties: tool.inputSchema.properties ?? {},
      required: tool.inputSchema.required,
    },
  }));
}

// ─── Prompt Cache ───

/**
 * 在最后一条 user 消息的最后一个 content block 上打 cache_control。
 * 配合 system prompt 上的 cache_control，实现增量对话的前缀缓存命中。
 */
function applyCacheControlToLastUserMessage(
  messages: Anthropic.Messages.MessageParam[],
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user" || typeof msg.content === "string") continue;

    const contentBlocks = msg.content;
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) continue;

    const lastBlock = contentBlocks[contentBlocks.length - 1];
    if (lastBlock && typeof lastBlock === "object") {
      (lastBlock as unknown as Record<string, unknown>).cache_control = {
        type: "ephemeral",
      };
    }
    break;
  }
}

// ─── 辅助函数 ───

interface AnthropicUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function extractUsage(apiUsage: AnthropicUsageLike): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: apiUsage.input_tokens,
    outputTokens: apiUsage.output_tokens,
  };

  if (apiUsage.cache_read_input_tokens) {
    usage.cacheReadTokens = apiUsage.cache_read_input_tokens;
  }

  if (apiUsage.cache_creation_input_tokens) {
    usage.cacheWriteTokens = apiUsage.cache_creation_input_tokens;
  }

  return usage;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
