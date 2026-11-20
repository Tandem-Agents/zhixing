/**
 * OpenAI Responses 协议适配器（设计 §1.1 / §2.3 / §5.6）
 *
 * 通过官方 `openai` SDK（`client.responses.create({ stream: true })`）直连 OpenAI Responses
 * 及兼容 Responses 端点，严格遵循：
 * - 无状态调用（`store: false`）+ `include: ["reasoning.encrypted_content"]`，保持客户端权威历史与 ZDR 兼容；
 * - GPT-6.2+ 将稳定 `systemPrompt` 投影为 `input` 首位 `developer` 消息（顶层 `instructions` 仅留单轮）；
 *   较早 Responses 型号沿用顶层稳定 `instructions`；
 * - 逐项保序回放同来源 `reasoning`（`id` / `summary` / `encrypted_content`）与 assistant `phase`
 *   （`commentary` / `final_answer`，缺失绝不猜造）；
 * - 跨连接、改地址、跨协议、来源不明旧记录或已知前缀代际失效（`invalidatedPrefixBeforeIndex`）的
 *   私有推理载荷诚实省略，绝不伪造保真或将加密载荷转为文本；
 * - 复用受控单跳传输 `createConnectionDeliveryFetch` 与整次调用未送达记账，不开启 SDK 内置重试。
 */

import type OpenAI from "openai";
import type {
  ChatRequest,
  ContentBlock,
  LLMProvider,
  Message,
  StopReason,
  StreamEvent,
  TextProtocolState,
  TokenUsage,
  ToolSpec,
} from "@zhixing-ai/core";
import {
  coalesceUserMaterialTextBlocks,
  isSameTrustedThinkingSource,
} from "@zhixing-ai/core";
import { markResponseStreamInterrupted } from "@zhixing-ai/core/resilience";
import type { ResolvedProvider } from "../types.js";
import {
  createConnectionDeliveryFetch,
  deliveryFetch,
  newDelivery,
  withDelivery,
  type ConnectionDeliveryTransport,
} from "./delivery-transport.js";
import {
  buildThinkingProtocolState,
  collectBoundSecrets,
  isSameTextProtocolSource,
  normalizeAdapterError,
  resolveAdapterProvenance,
  validateInboundThinkingProtocolState,
  type AdapterProvenance,
} from "./protocol-helpers.js";
import { buildOpenAIResponsesThinkingParam } from "./thinking-params.js";

/**
 * 判断型号是否为 GPT-6.2 及更新代际：
 * 设计 §5.6 规定 GPT-6.2+ 将可复用稳定 `systemPrompt` 置于 `input` 首位 `developer` 消息
 * 以参与前缀缓存与推理延续，顶层 `instructions` 留空（单轮生效）；较早 Responses 型号沿用顶层稳定 `instructions`。
 */
export function usesDeveloperPrefixSystemPrompt(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /(?:^|\/)gpt-(?:6\.[2-9]\d*|6\.[1-9]\d+|[7-9](?:\.\d+)?|\d{2,}(?:\.\d+)?)(?:[-._]|$)/u.test(
    normalized,
  );
}

interface ActiveReasoningItem {
  readonly kind: "reasoning";
  readonly id?: string;
  started: boolean;
  streamedText: string;
  summaryParts: Map<number, string>;
  lastSummaryIndex?: number;
}

interface ActiveMessageItem {
  readonly kind: "message";
  readonly id?: string;
  readonly blockId: string;
  phase?: "commentary" | "final_answer";
  streamedText: boolean;
}

interface ActiveFunctionCallItem {
  readonly kind: "function_call";
  readonly callId: string;
  readonly name: string;
  streamedArgs: boolean;
}

type ActiveOutputItem =
  | ActiveReasoningItem
  | ActiveMessageItem
  | ActiveFunctionCallItem;

export function createOpenAIResponsesProvider(
  provider: ResolvedProvider,
): LLMProvider {
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
        apiKey: authMode === "api-key" ? provider.apiKey : "not-used",
        ...(customHeaders ? { defaultHeaders: customHeaders } : {}),
        maxRetries: 0,
        fetch: boundFetch,
      });
    });
    client.catch(() => {
      client = undefined;
    });
    return client;
  };

  const provenance = resolveAdapterProvenance(provider, "openai-responses");
  const boundSecrets = collectBoundSecrets(provider);

  return {
    id: provider.id,
    protocol: "openai-responses",
    sourceConnectionId: provenance.sourceConnectionId,
    sourceOriginKey: provenance.sourceOriginKey,
    appendOnlyTurnContext: true,
    models: provider.declaredModels,

    async prepare(): Promise<void> {
      await connect();
    },

    async close(): Promise<void> {
      await connectionTransport?.close();
    },

    async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const developerPrefixMode = usesDeveloperPrefixSystemPrompt(request.model);
      const inputItems = convertMessagesToResponsesInput(
        request.messages,
        provenance,
        request.invalidatedPrefixBeforeIndex,
      );

      if (request.systemPrompt && developerPrefixMode) {
        inputItems.unshift({
          type: "message",
          role: "developer",
          content: request.systemPrompt,
        });
      }

      const tools =
        request.tools && request.tools.length > 0
          ? convertToolsToResponses(request.tools)
          : undefined;
      const reasoningParam = buildOpenAIResponsesThinkingParam(request.thinking);

      const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
        model: request.model,
        input: inputItems,
        store: false,
        stream: true,
        ...(request.systemPrompt && !developerPrefixMode
          ? { instructions: request.systemPrompt }
          : {}),
        ...(request.thinking?.mode !== "off"
          ? { include: ["reasoning.encrypted_content"] }
          : {}),
        ...(request.maxTokens != null
          ? { max_output_tokens: request.maxTokens }
          : {}),
        ...(request.temperature != null
          ? { temperature: request.temperature }
          : {}),
        ...(tools ? { tools } : {}),
        ...(reasoningParam
          ? { reasoning: reasoningParam as OpenAI.Reasoning }
          : {}),
      };

      yield { type: "message_start" };

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let hasToolCalls = false;
      let receivedTerminalEvent = false;
      let responseStreamStarted = false;
      const activeItems = new Map<number, ActiveOutputItem>();

      const buildTextProtocolState = (
        item: ActiveMessageItem,
      ): TextProtocolState | undefined => {
        if (!item.phase && !item.id) return undefined;
        return {
          protocol: "openai-responses",
          sourceConnectionId: provenance.sourceConnectionId,
          sourceOriginKey: provenance.sourceOriginKey,
          sourceModel: request.model,
          ...(item.phase ? { phase: item.phase } : {}),
          ...(item.id ? { itemId: item.id } : {}),
        };
      };

      const delivery = newDelivery();
      try {
        const stream = await withDelivery(delivery, async () =>
          (await connect()).responses.create(params, {
            signal: request.abortSignal ?? undefined,
          }),
        );
        responseStreamStarted = true;

        for await (const event of stream) {
          switch (event.type) {
            case "response.output_item.added": {
              const item = event.item;
              if (item.type === "reasoning") {
                activeItems.set(event.output_index, {
                  kind: "reasoning",
                  id: item.id || undefined,
                  started: false,
                  streamedText: "",
                  summaryParts: new Map(),
                });
              } else if (item.type === "message") {
                const phase = normalizeResponsePhase(item.phase);
                activeItems.set(event.output_index, {
                  kind: "message",
                  id: item.id || undefined,
                  blockId: item.id || `msg-${event.output_index}`,
                  ...(phase ? { phase } : {}),
                  streamedText: false,
                });
              } else if (item.type === "function_call") {
                activeItems.set(event.output_index, {
                  kind: "function_call",
                  callId: item.call_id,
                  name: item.name,
                  streamedArgs: false,
                });
                hasToolCalls = true;
                yield {
                  type: "tool_call_start",
                  id: item.call_id,
                  name: item.name,
                };
              }
              break;
            }

            case "response.reasoning_summary_part.added": {
              let item = activeItems.get(event.output_index);
              if (!item || item.kind !== "reasoning") {
                item = {
                  kind: "reasoning",
                  id: event.item_id || undefined,
                  started: false,
                  streamedText: "",
                  summaryParts: new Map(),
                };
                activeItems.set(event.output_index, item);
              }
              const idx = typeof event.summary_index === "number" ? event.summary_index : 0;
              if (!item.summaryParts.has(idx)) {
                item.summaryParts.set(
                  idx,
                  typeof event.part?.text === "string" ? event.part.text : "",
                );
              }
              break;
            }

            case "response.reasoning_summary_text.delta": {
              let item = activeItems.get(event.output_index);
              if (!item || item.kind !== "reasoning") {
                item = {
                  kind: "reasoning",
                  id: event.item_id || undefined,
                  started: false,
                  streamedText: "",
                  summaryParts: new Map(),
                };
                activeItems.set(event.output_index, item);
              }
              if (!item.started) {
                item.started = true;
                yield { type: "thinking_block_start" };
              }
              const idx = typeof event.summary_index === "number" ? event.summary_index : 0;
              if (event.delta) {
                const prevText = item.summaryParts.get(idx) ?? "";
                item.summaryParts.set(idx, prevText + event.delta);
                const needsBreak =
                  item.lastSummaryIndex !== undefined &&
                  item.lastSummaryIndex !== idx &&
                  item.streamedText.length > 0;
                const displayChunk = needsBreak ? `\n\n${event.delta}` : event.delta;
                item.lastSummaryIndex = idx;
                item.streamedText += displayChunk;
                yield { type: "thinking_delta", thinking: displayChunk };
              }
              break;
            }

            case "response.reasoning_summary_text.done": {
              const item = activeItems.get(event.output_index);
              if (item?.kind === "reasoning") {
                const idx = typeof event.summary_index === "number" ? event.summary_index : 0;
                if (typeof event.text === "string") {
                  item.summaryParts.set(idx, event.text);
                }
              }
              break;
            }

            case "response.reasoning_summary_part.done": {
              const item = activeItems.get(event.output_index);
              if (item?.kind === "reasoning") {
                const idx = typeof event.summary_index === "number" ? event.summary_index : 0;
                if (typeof event.part?.text === "string") {
                  item.summaryParts.set(idx, event.part.text);
                }
              }
              break;
            }

            case "response.reasoning_text.delta": {
              let item = activeItems.get(event.output_index);
              if (!item || item.kind !== "reasoning") {
                item = {
                  kind: "reasoning",
                  id: event.item_id || undefined,
                  started: false,
                  streamedText: "",
                  summaryParts: new Map(),
                };
                activeItems.set(event.output_index, item);
              }
              if (!item.started) {
                item.started = true;
                yield { type: "thinking_block_start" };
              }
              if (event.delta) {
                item.streamedText += event.delta;
                yield { type: "thinking_delta", thinking: event.delta };
              }
              break;
            }

            case "response.output_text.delta": {
              let item = activeItems.get(event.output_index);
              if (!item || item.kind !== "message") {
                item = {
                  kind: "message",
                  id: event.item_id || undefined,
                  blockId: event.item_id || `msg-${event.output_index}`,
                  streamedText: false,
                };
                activeItems.set(event.output_index, item);
              }
              item.streamedText = true;
              const textProtocolState = buildTextProtocolState(item);
              yield {
                type: "text_delta",
                text: event.delta,
                blockId: item.blockId,
                ...(textProtocolState ? { protocolState: textProtocolState } : {}),
              };
              break;
            }

            case "response.function_call_arguments.delta": {
              const item = activeItems.get(event.output_index);
              if (item?.kind === "function_call" && event.delta) {
                item.streamedArgs = true;
                yield {
                  type: "tool_call_delta",
                  id: item.callId,
                  argsFragment: event.delta,
                };
              }
              break;
            }

            case "response.output_item.done": {
              const doneItem = event.item;
              const tracked = activeItems.get(event.output_index);

              if (doneItem.type === "reasoning") {
                const reasoningTracked: ActiveReasoningItem =
                  tracked?.kind === "reasoning"
                    ? tracked
                    : {
                        kind: "reasoning",
                        id: doneItem.id || undefined,
                        started: false,
                        streamedText: "",
                        summaryParts: new Map(),
                      };
                const summaryText = extractReasoningSummaryText(doneItem);
                const encryptedContent =
                  typeof doneItem.encrypted_content === "string" &&
                  doneItem.encrypted_content.length > 0
                    ? doneItem.encrypted_content
                    : undefined;
                const itemId = doneItem.id || reasoningTracked.id;
                const opaqueStep = buildOpaqueReasoningStep(doneItem, reasoningTracked, itemId);

                if (
                  reasoningTracked.started ||
                  summaryText.length > 0 ||
                  encryptedContent !== undefined
                ) {
                  if (!reasoningTracked.started) {
                    reasoningTracked.started = true;
                    yield { type: "thinking_block_start" };
                  }
                  if (reasoningTracked.streamedText.length === 0 && summaryText.length > 0) {
                    yield { type: "thinking_delta", thinking: summaryText };
                  }
                  const protocolState = buildThinkingProtocolState(
                    provenance,
                    request.model,
                    {
                      ...(encryptedContent ? { encryptedContent } : {}),
                      ...(opaqueStep ? { opaqueStep } : {}),
                    },
                  );
                  const boundViolation = validateInboundThinkingProtocolState(protocolState);
                  if (boundViolation) {
                    yield {
                      type: "error",
                      error: markResponseStreamInterrupted(
                        normalizeAdapterError(
                          new Error(`OpenAI Responses ${boundViolation}`),
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
                }
                activeItems.delete(event.output_index);
              } else if (doneItem.type === "message") {
                const phase = normalizeResponsePhase(doneItem.phase);
                const msgTracked: ActiveMessageItem =
                  tracked?.kind === "message"
                    ? tracked
                    : {
                        kind: "message",
                        id: doneItem.id || undefined,
                        blockId: doneItem.id || `msg-${event.output_index}`,
                        streamedText: false,
                      };
                if (phase) msgTracked.phase = phase;
                const finalProtocolState = buildTextProtocolState({
                  ...msgTracked,
                  id: doneItem.id || msgTracked.id,
                });

                if (!msgTracked.streamedText) {
                  const fullText = extractAssistantMessageText(doneItem);
                  if (fullText.length > 0) {
                    yield {
                      type: "text_delta",
                      text: fullText,
                      blockId: msgTracked.blockId,
                      ...(finalProtocolState
                        ? { protocolState: finalProtocolState }
                        : {}),
                    };
                  }
                } else if (finalProtocolState) {
                  // 若 phase 仅在 output_item.done 到达，以零长元事件补绑到对应文本块（不向 UI 产出空 delta）
                  yield {
                    type: "text_delta",
                    text: "",
                    blockId: msgTracked.blockId,
                    protocolState: finalProtocolState,
                  };
                }
                activeItems.delete(event.output_index);
              } else if (doneItem.type === "function_call") {
                hasToolCalls = true;
                if (tracked?.kind !== "function_call") {
                  yield {
                    type: "tool_call_start",
                    id: doneItem.call_id,
                    name: doneItem.name,
                  };
                  if (doneItem.arguments) {
                    yield {
                      type: "tool_call_delta",
                      id: doneItem.call_id,
                      argsFragment: doneItem.arguments,
                    };
                  }
                } else if (!tracked.streamedArgs && doneItem.arguments) {
                  yield {
                    type: "tool_call_delta",
                    id: doneItem.call_id,
                    argsFragment: doneItem.arguments,
                  };
                }
                yield { type: "tool_call_end", id: doneItem.call_id };
                activeItems.delete(event.output_index);
              }
              break;
            }

            case "response.completed":
            case "response.incomplete": {
              const resp = event.response;
              if (resp.status === "failed" || resp.status === "cancelled") {
                const respErr = resp.error;
                const failedError = Object.assign(
                  new Error(
                    respErr?.message ||
                      `OpenAI Responses stream_incomplete: terminal status ${resp.status}`,
                  ),
                  {
                    ...(respErr?.code ? { code: respErr.code } : {}),
                  },
                );
                yield {
                  type: "error",
                  error: markResponseStreamInterrupted(
                    normalizeAdapterError(failedError, delivery, boundSecrets),
                  ),
                };
                return;
              }
              receivedTerminalEvent = true;
              if (resp.usage) {
                usage = extractResponsesUsage(resp.usage);
              }
              const outputHasFunctionCall =
                hasToolCalls ||
                resp.output?.some((o) => o.type === "function_call") === true;
              if (outputHasFunctionCall) {
                stopReason = "tool_use";
              } else if (
                event.type === "response.incomplete" &&
                resp.incomplete_details?.reason === "max_output_tokens"
              ) {
                stopReason = "max_tokens";
              } else {
                stopReason = "end_turn";
              }
              break;
            }

            case "response.failed": {
              const respErr = event.response.error;
              const failedError = Object.assign(
                new Error(
                  respErr?.message || "OpenAI Responses stream failed",
                ),
                {
                  ...(respErr?.code ? { code: respErr.code } : {}),
                },
              );
              yield {
                type: "error",
                error: markResponseStreamInterrupted(
                  normalizeAdapterError(failedError, delivery, boundSecrets),
                ),
              };
              return;
            }

            case "error": {
              const streamErr = Object.assign(
                new Error(event.message || "OpenAI Responses stream error"),
                {
                  ...(event.code ? { code: event.code } : {}),
                },
              );
              yield {
                type: "error",
                error: markResponseStreamInterrupted(
                  normalizeAdapterError(streamErr, delivery, boundSecrets),
                ),
              };
              return;
            }
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
        if (!receivedTerminalEvent || activeItems.size > 0) {
          const reason = !receivedTerminalEvent
            ? "未收到协议终止事件（response.completed/incomplete）"
            : `存在 ${activeItems.size} 个未闭合的输出项`;
          yield {
            type: "error",
            error: markResponseStreamInterrupted(
              normalizeAdapterError(
                new Error(`OpenAI Responses stream_incomplete: ${reason}`),
                delivery,
                boundSecrets,
              ),
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

// ─── 请求与响应投影辅助 ───

function convertMessagesToResponsesInput(
  messages: Message[],
  provenance: AdapterProvenance,
  invalidatedPrefixBeforeIndex?: number,
): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]!;
    if (msg.role === "user") {
      const normalizedBlocks = coalesceUserMaterialTextBlocks(msg.content);
      const userParts: OpenAI.Responses.ResponseInputContent[] = [];

      const flushUserParts = (): void => {
        if (userParts.length === 0) return;
        items.push({
          type: "message",
          role: "user",
          content: [...userParts],
        });
        userParts.length = 0;
      };

      for (const block of normalizedBlocks) {
        if (block.type === "tool_result") {
          flushUserParts();
          items.push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output: block.content,
          });
        } else if (block.type === "text") {
          if (block.text.length > 0 || normalizedBlocks.length === 1) {
            userParts.push({ type: "input_text", text: block.text });
          }
        } else if (block.type === "image") {
          userParts.push({
            type: "input_image",
            image_url:
              block.source.type === "url"
                ? block.source.url
                : `data:${block.source.mediaType};base64,${block.source.data}`,
            detail: "auto",
          });
        }
      }
      flushUserParts();
      continue;
    }

    // assistant 消息：严格保持块到达顺序，逐项投影 reasoning / message(phase) / function_call
    const prefixInvalidated =
      invalidatedPrefixBeforeIndex !== undefined &&
      msgIndex < invalidatedPrefixBeforeIndex;

    for (const block of msg.content) {
      projectAssistantBlock(block, provenance, prefixInvalidated, items);
    }
  }

  return items;
}

function projectAssistantBlock(
  block: ContentBlock,
  provenance: AdapterProvenance,
  prefixInvalidated: boolean,
  items: OpenAI.Responses.ResponseInputItem[],
): void {
  switch (block.type) {
    case "thinking": {
      // 设计 §2.3 & §5.6：
      // 1. 必须先核对同一可信来源（sourceConnectionId + sourceOriginKey + openai-responses）
      // 2. 前缀代际已变化（压缩/窗口重建/冷重启/切换）的已结算旧推理载荷诚实省略，不伪造保真
      // 3. 绝不将 encrypted_content 降级为普通文本
      if (prefixInvalidated) return;
      if (!isSameTrustedThinkingSource(block.protocolState, provenance)) return;
      const encryptedContent = block.protocolState?.encryptedContent;
      if (!encryptedContent) return;

      const parsedOpaque = parseOpaqueReasoningPayload(block.protocolState?.opaqueStep);
      const itemId = parsedOpaque?.id;
      const summary: OpenAI.Responses.ResponseReasoningItem.Summary[] =
        parsedOpaque?.summary !== undefined
          ? parsedOpaque.summary
          : block.thinking
            ? [{ type: "summary_text", text: block.thinking }]
            : [];
      const reasoningItem: OpenAI.Responses.ResponseReasoningItem = {
        type: "reasoning",
        id: itemId ?? "",
        summary,
        ...(parsedOpaque?.content ? { content: parsedOpaque.content } : {}),
        ...(parsedOpaque?.status ? { status: parsedOpaque.status } : {}),
        encrypted_content: encryptedContent,
      };
      if (!itemId) {
        delete (reasoningItem as { id?: string }).id;
      }
      items.push(reasoningItem);
      return;
    }

    case "text": {
      const sameSourceText = isSameTextProtocolSource(block.protocolState, provenance);
      const phase = sameSourceText ? block.protocolState?.phase : undefined;
      const itemId = sameSourceText ? block.protocolState?.itemId : undefined;
      if (itemId) {
        const outputMsg: OpenAI.Responses.ResponseOutputMessage = {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: block.text,
              annotations: [],
            },
          ],
          ...(phase ? { phase } : {}),
        };
        items.push(outputMsg);
      } else {
        // 未携带原 phase 时绝不猜造 phase
        const easyMsg: OpenAI.Responses.EasyInputMessage = {
          type: "message",
          role: "assistant",
          content: block.text,
          ...(phase ? { phase } : {}),
        };
        items.push(easyMsg);
      }
      return;
    }

    case "tool_use": {
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
      return;
    }

    default:
      return;
  }
}

function convertToolsToResponses(
  tools: ToolSpec[],
): OpenAI.Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as Record<string, unknown>,
    strict: false,
  }));
}

function normalizeResponsePhase(
  value: unknown,
): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

interface OpaqueReasoningPayload {
  readonly id?: string;
  readonly summary?: OpenAI.Responses.ResponseReasoningItem.Summary[];
  readonly content?: OpenAI.Responses.ResponseReasoningItem.Content[];
  readonly status?: OpenAI.Responses.ResponseReasoningItem["status"];
}

function buildOpaqueReasoningStep(
  doneItem: OpenAI.Responses.ResponseReasoningItem,
  tracked: ActiveReasoningItem,
  itemId: string | undefined,
): string | undefined {
  let summary: OpenAI.Responses.ResponseReasoningItem.Summary[] = [];
  if (Array.isArray(doneItem.summary) && doneItem.summary.length > 0) {
    summary = doneItem.summary.map((entry) => ({ ...entry }));
  } else if (tracked.summaryParts.size > 0) {
    summary = [...tracked.summaryParts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => ({ type: "summary_text" as const, text }));
  }
  const content =
    Array.isArray(doneItem.content) && doneItem.content.length > 0
      ? doneItem.content.map((entry) => ({ ...entry }))
      : undefined;
  const status =
    doneItem.status === "in_progress" ||
    doneItem.status === "completed" ||
    doneItem.status === "incomplete"
      ? doneItem.status
      : undefined;

  const fullPayload = {
    type: "reasoning" as const,
    ...(itemId ? { id: itemId } : {}),
    summary,
    ...(content ? { content } : {}),
    ...(status ? { status } : {}),
  };
  return JSON.stringify(fullPayload);
}

function parseOpaqueReasoningPayload(
  opaqueStep: string | undefined,
): OpaqueReasoningPayload | undefined {
  if (!opaqueStep) return undefined;
  try {
    const parsed = JSON.parse(opaqueStep) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const id =
      typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : undefined;
    const summary = Array.isArray(parsed.summary)
      ? (parsed.summary as OpenAI.Responses.ResponseReasoningItem.Summary[]).filter(
          (entry) =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.text === "string" &&
            typeof entry.type === "string",
        )
      : undefined;
    const content = Array.isArray(parsed.content)
      ? (parsed.content as OpenAI.Responses.ResponseReasoningItem.Content[]).filter(
          (entry) =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof entry.text === "string" &&
            typeof entry.type === "string",
        )
      : undefined;
    const status =
      parsed.status === "in_progress" ||
      parsed.status === "completed" ||
      parsed.status === "incomplete"
        ? parsed.status
        : undefined;
    return {
      ...(id ? { id } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(content && content.length > 0 ? { content } : {}),
      ...(status ? { status } : {}),
    };
  } catch {
    return undefined;
  }
}

function extractReasoningSummaryText(
  item: OpenAI.Responses.ResponseReasoningItem,
): string {
  const fromSummary = (item.summary ?? [])
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  if (fromSummary.length > 0) return fromSummary;
  return (item.content ?? [])
    .map((c) => c.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

function extractAssistantMessageText(
  item: OpenAI.Responses.ResponseOutputMessage,
): string {
  return (item.content ?? [])
    .map((part) => (part.type === "output_text" ? part.text : ""))
    .join("");
}

export function extractResponsesUsage(
  apiUsage: OpenAI.Responses.ResponseUsage,
): TokenUsage {
  const cached = apiUsage.input_tokens_details?.cached_tokens ?? 0;
  const usage: TokenUsage = {
    inputTokens: apiUsage.input_tokens,
    outputTokens: apiUsage.output_tokens,
  };
  if (cached > 0) {
    usage.cacheReadTokens = cached;
  }
  return usage;
}
