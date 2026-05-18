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
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@zhixing/core";
import type { Message, ContentBlock, ToolSpec } from "@zhixing/core";
import type { ResolvedProvider } from "../types.js";
import { buildAnthropicThinkingParam } from "./thinking-params.js";

// ─── 内部类型 ───
//
// BlockState 覆盖 anthropic 协议中需要在 stream 期间维持状态的三类 content block:
//   - text:无内部状态,仅作类型标记让 content_block_delta 知道 emit text_delta
//   - thinking:维持 signature 累积(随 signature_delta 在块末到达),
//     content_block_stop 时随 thinking_block_end 一次性带出
//   - tool_use:维持 id / name / argsJson 累积
//
// Claude extended thinking 已完整接入:请求侧按 ChatRequest.thinking 发
// thinking{type,budget_tokens}(buildAnthropicThinkingParam);入站累积
// signature_delta;出站 convertContentBlock 对含 signature 的思考块原样回传
// (thinking + signature 逐字节一致,服务端解密校验,改写/缺失会 400)。无
// signature 的跨 provider 思考块降级为 text 兜底。

type BlockState =
  | { type: "text" }
  | { type: "thinking"; signature: string }
  | { type: "tool_use"; id: string; name: string; argsJson: string };

// ─── 工厂函数 ───

export function createAnthropicProvider(resolved: ResolvedProvider): LLMProvider {
  const client = new Anthropic({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl || undefined,
  });

  // `LLMProvider.models[]` 直接复用 `resolved.declaredModels`——catalog 数据本身就是
  // `ModelInfo` 形态，无需转换。catalog 之外的 model（如新发布尚未补 preset 的版本）走
  // core/resolveModelInfo 的协议族默认（PROTOCOL_BUDGET_DEFAULTS["anthropic-messages"]）兜底。

  return {
    id: resolved.id,
    models: resolved.declaredModels,

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

      // Extended thinking 原生参数（thinking{type:enabled,budget_tokens}）。
      // 缺省 / 不适用形态 → 不传该参数 = 标准模式（安全兜底）。
      const thinkingParam = buildAnthropicThinkingParam(request.thinking);
      if (thinkingParam) {
        params.thinking = thinkingParam;
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
                blocks.set(event.index, { type: "thinking", signature: "" });
                yield { type: "thinking_block_start" };
              } else if (cb.type === "tool_use") {
                blocks.set(event.index, {
                  type: "tool_use",
                  id: cb.id,
                  name: cb.name,
                  argsJson: "",
                });
                yield { type: "tool_call_start", id: cb.id, name: cb.name };
              }
              // 未识别 block 类型(redacted_thinking / server_tool_use 等)
              // 不 set BlockState,后续 delta 自然 fall-through 静默丢弃。
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
                yield { type: "thinking_delta", thinking: delta.thinking };
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
              } else if (
                delta.type === "signature_delta" &&
                block.type === "thinking"
              ) {
                // Extended thinking 加密签名(块末到达)。累积后于
                // content_block_stop 随 thinking_block_end 一次性带出,供消息
                // 组装写入 ThinkingBlock.signature 以支持多轮原样回传。
                block.signature += delta.signature;
              }
              break;
            }

            case "content_block_stop": {
              const block = blocks.get(event.index);
              if (block?.type === "thinking") {
                yield {
                  type: "thinking_block_end",
                  signature: block.signature || undefined,
                };
              } else if (block?.type === "tool_use") {
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
      // 含 signature → Anthropic 原生思考块,多轮**原样回传**(thinking +
      // signature 字段必须与服务端返回逐字节一致,服务端解密校验,改写或缺失
      // 会 400)。这是 Anthropic extended thinking 多轮对话的协议必要条件。
      if (block.signature) {
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      }
      // 无 signature → 跨 provider 续聊兜底,非 Anthropic 原生思考块:
      //
      // Message.content 是 provider-agnostic 类型,可能携带来自 OpenAI 兼容路径
      // (DeepSeek v4-pro / Qwen-QwQ / Kimi-thinking 等)的 ThinkingBlock。当用户
      // 在持久化对话里跨 provider 续聊或 main/light/power 路由分发到 anthropic
      // 时,这些 block 会流到本 adapter。
      //
      // 选择降级为 text 而非抛错:
      //   - 保留信息(thinking trace 转为普通文本,模型能读到推理痕迹)
      //   - Anthropic 协议接受任意 text 块,无 signature 的 thinking 块直接传会被拒
      //   - 与抛错 / 静默丢弃相比,降级是最稳健的内容保真方案
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

export interface AnthropicUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Anthropic usage 归一。
 *
 * 关键语义：Anthropic 的 `input_tokens` 仅是"未命中的新输入"，cache 命中/写入
 * 部分单列在 `cache_read_input_tokens` / `cache_creation_input_tokens`。因此：
 *   - `inputTokens` 保留 vendor 原值（input_tokens）—— anchor / estimator 校准等
 *     既有消费方按此锚定，**刻意不动**，保证依赖它的链路逐字节不变
 *   - `totalInputTokens` = 三者之和，给到需要"全量输入"规范口径的消费方
 *     （状态区流量等，经 getTotalInputTokens 读取）
 *
 * 这是唯一需要显式设 totalInputTokens 的 adapter —— OpenAI 兼容族 prompt_tokens
 * 本就是全量，由 getTotalInputTokens 的 fallback 自然得到。
 *
 * 导出供 usage-conformance 测试做契约校验（纯函数，契约本就是公开关注点）。
 */
export function extractUsage(apiUsage: AnthropicUsageLike): TokenUsage {
  const cacheRead = apiUsage.cache_read_input_tokens ?? 0;
  const cacheWrite = apiUsage.cache_creation_input_tokens ?? 0;

  const usage: TokenUsage = {
    inputTokens: apiUsage.input_tokens,
    totalInputTokens: apiUsage.input_tokens + cacheRead + cacheWrite,
    outputTokens: apiUsage.output_tokens,
  };

  if (cacheRead > 0) {
    usage.cacheReadTokens = cacheRead;
  }

  if (cacheWrite > 0) {
    usage.cacheWriteTokens = cacheWrite;
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
