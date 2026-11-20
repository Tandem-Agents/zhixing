/**
 * Anthropic Messages 协议适配器
 *
 * 通过 @anthropic-ai/sdk 直连 Anthropic Messages API。
 *
 * 设计决策（详见 docs/modules/providers/anthropic-adapter.md）：
 * - 消费原始 SSE 事件流，不用 SDK 高级抽象（避免部分 JSON 解析的 O(n²)）
 * - 工具参数累积原始 JSON 字符串，完成时一次解析
 * - cache_control 放在 system prompt 和最后一条 user 消息上（低成本高收益）
 * - 不做重试 / Failover —— 那是 Resilience 层的职责
 */

import type Anthropic from "@anthropic-ai/sdk";
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
import { markResponseStreamInterrupted } from "@zhixing-ai/core/resilience";
import {
  buildThinkingProtocolState,
  collectBoundSecrets,
  normalizeAdapterError,
  resolveAdapterProvenance,
  validateInboundThinkingProtocolState,
  type AdapterProvenance,
} from "./protocol-helpers.js";
import { buildAnthropicThinkingRequestFields } from "./thinking-params.js";

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
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; argsJson: string };

// ─── 工厂函数 ───

export function createAnthropicProvider(resolved: ResolvedProvider): LLMProvider {
  const connectionTransport: ConnectionDeliveryTransport | undefined =
    resolved.network !== undefined || resolved.networkProxy !== undefined
      ? createConnectionDeliveryFetch({
          proxyPolicy: resolved.network?.proxy ?? "inherit",
          networkProxy: resolved.networkProxy,
          allowPrivateOrigin: resolved.network?.allowPrivateOrigin,
          confirmedOrigin: resolved.baseUrl,
        })
      : undefined;
  const boundFetch = connectionTransport?.fetch ?? deliveryFetch;

  // SDK 在首次真正调用模型时才加载并构造，不进入宿主启动的模块图；加载失败下次重试。
  let client: Promise<Anthropic> | undefined;
  const connect = (): Promise<Anthropic> => {
    client ??= import("@anthropic-ai/sdk").then(({ default: Anthropic }) => {
      const authMode = resolved.authMode ?? "api-key";
      const customHeaders: Record<string, string | null> | undefined =
        authMode === "none"
          ? { "x-api-key": null }
          : authMode === "header" && resolved.authHeaderName
            ? { "x-api-key": null, [resolved.authHeaderName]: resolved.apiKey }
            : undefined;
      return new Anthropic({
        apiKey: authMode === "api-key" ? resolved.apiKey : "not-used",
        baseURL: resolved.baseUrl || undefined,
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

  const provenance = resolveAdapterProvenance(resolved, "anthropic-messages");
  const boundSecrets = collectBoundSecrets(resolved);

  return {
    id: resolved.id,
    protocol: "anthropic-messages",
    sourceConnectionId: provenance.sourceConnectionId,
    sourceOriginKey: provenance.sourceOriginKey,
    appendOnlyTurnContext: false,
    models: resolved.declaredModels,

    async prepare(): Promise<void> {
      await connect();
    },

    async close(): Promise<void> {
      await connectionTransport?.close();
    },

    async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const messages = convertMessages(request.messages, provenance);
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

      // Extended thinking 原生参数：
      // - Claude 4.7+ 使用 adaptive + output_config.effort（不再发送弃用的 enabled + budget_tokens）
      // - 较早代际保留 thinking{type:enabled, budget_tokens}
      const thinkingFields = buildAnthropicThinkingRequestFields(
        request.thinking,
        request.model,
      );
      if (thinkingFields.thinking) {
        params.thinking = thinkingFields.thinking;
      }
      if (thinkingFields.output_config) {
        params.output_config = thinkingFields.output_config;
      }

      applyCacheControlToLastUserMessage(messages);

      yield { type: "message_start" };

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let responseStreamStarted = false;
      const blocks = new Map<number, BlockState>();

      const delivery = newDelivery();
      try {
        const stream = await withDelivery(delivery, async () => (await connect()).messages.create(
          params as unknown as Anthropic.MessageCreateParamsStreaming,
          request.abortSignal ? { signal: request.abortSignal } : undefined,
        ));
        responseStreamStarted = true;

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
              } else if (cb.type === "redacted_thinking") {
                const redactedData =
                  typeof (cb as { data?: unknown }).data === "string"
                    ? (cb as { data: string }).data
                    : "";
                if (redactedData) {
                  blocks.set(event.index, {
                    type: "redacted_thinking",
                    data: redactedData,
                  });
                  yield { type: "thinking_block_start" };
                }
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
                const sig = block.signature || undefined;
                const protocolState = buildThinkingProtocolState(provenance, request.model, {
                  ...(sig ? { signature: sig } : {}),
                });
                const boundViolation = validateInboundThinkingProtocolState(protocolState);
                if (boundViolation) {
                  yield {
                    type: "error",
                    error: markResponseStreamInterrupted(
                      normalizeAdapterError(
                        new Error(`Anthropic Messages ${boundViolation}`),
                        delivery,
                        boundSecrets,
                      ),
                    ),
                  };
                  return;
                }
                yield {
                  type: "thinking_block_end",
                  signature: sig,
                  protocolState,
                };
              } else if (block?.type === "redacted_thinking") {
                const protocolState = buildThinkingProtocolState(provenance, request.model, {
                  opaqueStep: JSON.stringify({
                    type: "redacted_thinking",
                    data: block.data,
                  }),
                });
                const boundViolation = validateInboundThinkingProtocolState(protocolState);
                if (boundViolation) {
                  yield {
                    type: "error",
                    error: markResponseStreamInterrupted(
                      normalizeAdapterError(
                        new Error(`Anthropic Messages ${boundViolation}`),
                        delivery,
                        boundSecrets,
                      ),
                    ),
                  };
                  return;
                }
                yield {
                  type: "thinking_block_end",
                  protocolState,
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
 * 内部 Message → Anthropic MessageParam。
 *
 * 内部格式按 Anthropic 模型设计，所以转换相对简单：
 * - tool_result 留在 user 消息的 content 数组中（不像 OpenAI 需要独立 role=tool）
 * - 字段命名从 camelCase 转 snake_case
 */
function convertMessages(
  messages: Message[],
  provenance: AdapterProvenance,
): Anthropic.Messages.MessageParam[] {
  const converted: Anthropic.Messages.MessageParam[] = [];
  for (const msg of messages) {
    const sourceBlocks =
      msg.role === "user"
        ? coalesceUserMaterialTextBlocks(msg.content)
        : msg.content;
    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    for (const block of sourceBlocks) {
      const projected = convertContentBlock(block, provenance);
      if (projected) {
        blocks.push(projected);
      }
    }
    if (blocks.length > 0) {
      converted.push({
        role: msg.role,
        content: blocks,
      });
    }
  }
  return converted;
}

function convertContentBlock(
  block: ContentBlock,
  provenance: AdapterProvenance,
): Anthropic.Messages.ContentBlockParam | null {
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

    case "thinking": {
      // 设计 §2.3：必须先核对同一可信来源（sourceConnectionId + sourceOriginKey + protocol）；
      // 跨连接、改地址、跨协议或来源不明旧记录绝不转发私有推理签名/不透明载荷，也不将其转为普通文本。
      if (!isSameTrustedThinkingSource(block.protocolState, provenance)) {
        return null;
      }
      const state = block.protocolState!;
      if (state.opaqueStep) {
        try {
          const parsed = JSON.parse(state.opaqueStep) as {
            type?: unknown;
            data?: unknown;
          };
          if (parsed.type === "redacted_thinking" && typeof parsed.data === "string") {
            return {
              type: "redacted_thinking",
              data: parsed.data,
            };
          }
        } catch {
          return null;
        }
      }
      const sig = state.signature ?? block.signature;
      if (sig) {
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: sig,
        };
      }
      // 同来源无签名块（例如老记录）安全省略，不造假签名
      return null;
    }
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
 *   - `inputTokens` 保留 vendor 原值（input_tokens），供明确需要 vendor 原始字段
 *     的诊断 / 展示链路使用
 *   - `totalInputTokens` = 三者之和，给到需要"全量输入"规范口径的消费方
 *     （请求总量、token anchor、estimator calibration actual 等，经
 *     getTotalInputTokens 读取）
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
