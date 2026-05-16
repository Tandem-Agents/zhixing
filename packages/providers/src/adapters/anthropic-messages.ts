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

// ─── 内部类型 ───
//
// BlockState 覆盖 anthropic 协议中需要在 stream 期间维持状态的三类 content block:
//   - text:无内部状态,仅作类型标记让 content_block_delta 知道 emit text_delta
//   - thinking:同上,让 content_block_delta 知道 emit thinking_delta
//     (Claude thinking 模式当前未在请求侧接入,但仍要处理 content_block 协议事件 —
//     未来接入或 SDK 默认行为变化时,本路径自动激活,无需重新加状态;同时跨
//     provider 续聊场景下的 ThinkingBlock 不流经本 adapter 入站路径)
//   - tool_use:维持 id / name / argsJson 累积
//
// 协议事件层 vs 能力层分离:
//   本 adapter 正确发射 thinking_block_start / thinking_delta / thinking_block_end
//   协议事件,与 tool_call_start/end 对称。但 Claude thinking **能力**完整接入
//   (请求传 thinking 参数 + 出站写 thinking block + signature + 跨 provider 兜底)
//   是独立工程;当前 presets.anthropic.quirks.supportsThinking = false 保持诚实。

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
              }
              // 未识别的 delta 类型(signature_delta 等)静默丢弃 —— signature
              // 当前不处理(Claude thinking 能力层未接入,见 BlockState 注释)
              break;
            }

            case "content_block_stop": {
              const block = blocks.get(event.index);
              if (block?.type === "thinking") {
                yield { type: "thinking_block_end" };
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
      // 跨 provider 续聊兜底,不是 Claude thinking 实现:
      //
      // Message.content 是 provider-agnostic 类型,可能携带来自 OpenAI 兼容路径
      // (DeepSeek v4-pro / Qwen-QwQ / Kimi-thinking 等)的 ThinkingBlock。当用户
      // 在持久化对话里跨 provider 续聊或 main/light/power 路由分发到 anthropic
      // 时,这些 block 会流到本 adapter。
      //
      // 选择降级为 text 而非抛错:
      //   - 保留信息(thinking trace 转为普通文本,模型能读到推理痕迹)
      //   - Anthropic 协议接受任意 text 块,不会因为缺 signature 拒绝
      //   - 与抛错 / 静默丢弃相比,降级是最稳健的内容保真方案
      //
      // 真正接入 Claude thinking 的路径见 BlockState 顶部注释,届时本 case 需要
      // 区分"来自 anthropic 自己 + 含 signature"与"跨 provider 流入 + 无 signature"
      // 两种情形分别处理。当前 anthropic thinking 未接入,本 case 仅服务跨 provider 兜底。
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
