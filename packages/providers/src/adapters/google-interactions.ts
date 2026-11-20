/**
 * Google Gemini Interactions 协议适配器（设计 §1.1 / §2.3）
 *
 * 按 Google Interactions API 当前 GA step 合同实现无状态流式调用（`store: false`, `stream: true`）：
 * - 端点：默认 `<baseUrl>/v1/interactions?alt=sse`（若用户显式配置 `/v1beta` 或 `/interactions` 则按配置保留）；
 * - 认证：默认 `x-goog-api-key`（支持自定义认证头与免密模式），复用受控单跳传输 `createConnectionDeliveryFetch`
 *   与未送达记账，不绕过 SSRF/代理/NO_PROXY 边界；
 * - 流事件：按 `event_type` 消费 `interaction.created`、`step.start`、`step.delta`
 *   （`text`、`thought_summary.content`、`thought_signature`、`arguments_delta.arguments`、`function_call`）、
 *   `step.stop` 与 `interaction.completed`（支持 `status: "requires_action"`，不依赖终事件回填 steps）；
 * - 思考与无状态回放：完整保留多个 `thought` step 的顺序、签名及空摘要纯签名 thought；
 *   同来源历史（含同来源换型号）按原 `thought` step 形状重传，跨连接/改址/跨协议/来源不明旧记录诚实省略。
 */

import type {
  ChatRequest,
  ContentBlock,
  LLMProvider,
  Message,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolSpec,
} from "@zhixing-ai/core";
import {
  coalesceUserMaterialTextBlocks,
  isSameTrustedThinkingSource,
} from "@zhixing-ai/core";
import {
  markResponseStreamInterrupted,
  sanitizeProviderErrorMessage,
} from "@zhixing-ai/core/resilience";
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
  normalizeAdapterError,
  resolveAdapterProvenance,
  validateInboundThinkingProtocolState,
  type AdapterProvenance,
} from "./protocol-helpers.js";
import { buildGoogleInteractionsThinkingParams } from "./thinking-params.js";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export function resolveGoogleInteractionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/u, "");
  if (clean.endsWith("/interactions")) {
    return `${clean}?alt=sse`;
  }
  if (/\/v1(?:beta\d*)?$/u.test(clean)) {
    return `${clean}/interactions?alt=sse`;
  }
  return `${clean}/v1/interactions?alt=sse`;
}

interface ActiveThoughtStep {
  readonly kind: "thought";
  signature: string;
  summaryItems: Record<string, unknown>[];
  started: boolean;
}

interface ActiveModelOutputStep {
  readonly kind: "model_output";
}

interface ActiveFunctionCallStep {
  readonly kind: "function_call";
  id: string;
  name: string;
  started: boolean;
  emittedArgs: boolean;
  initialArguments?: unknown;
}

type ActiveStepState =
  | ActiveThoughtStep
  | ActiveModelOutputStep
  | ActiveFunctionCallStep;

export function createGoogleInteractionsProvider(
  resolved: ResolvedProvider,
): LLMProvider {
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
  const provenance = resolveAdapterProvenance(resolved, "google-interactions");
  const boundSecrets = collectBoundSecrets(resolved);
  const endpointUrl = resolveGoogleInteractionsUrl(resolved.baseUrl);

  return {
    id: resolved.id,
    protocol: "google-interactions",
    sourceConnectionId: provenance.sourceConnectionId,
    sourceOriginKey: provenance.sourceOriginKey,
    appendOnlyTurnContext: false,
    models: resolved.declaredModels,

    async prepare(): Promise<void> {
      // 无外部重型 SDK，受控 fetch 就绪即可
    },

    async close(): Promise<void> {
      await connectionTransport?.close();
    },

    async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const inputSteps = convertMessagesToInteractionSteps(
        request.messages,
        provenance,
      );
      const tools =
        request.tools && request.tools.length > 0
          ? convertToolsToInteractions(request.tools)
          : undefined;
      const thinkingConfig = buildGoogleInteractionsThinkingParams(request.thinking);

      const generationConfig: Record<string, unknown> = {
        ...(request.maxTokens != null
          ? { max_output_tokens: request.maxTokens }
          : {}),
        ...(request.temperature != null
          ? { temperature: request.temperature }
          : {}),
        ...(request.stopSequences && request.stopSequences.length > 0
          ? { stop_sequences: request.stopSequences }
          : {}),
        ...thinkingConfig,
      };

      const body: Record<string, unknown> = {
        model: request.model,
        store: false,
        stream: true,
        input: inputSteps,
        ...(request.systemPrompt
          ? { system_instruction: request.systemPrompt }
          : {}),
        ...(tools ? { tools } : {}),
        ...(Object.keys(generationConfig).length > 0
          ? { generation_config: generationConfig }
          : {}),
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      const authMode = resolved.authMode ?? "api-key";
      if (authMode === "api-key") {
        headers["x-goog-api-key"] = resolved.apiKey;
      } else if (authMode === "header" && resolved.authHeaderName) {
        headers[resolved.authHeaderName] = resolved.apiKey;
      }

      yield { type: "message_start" };

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let hasToolCalls = false;
      let receivedTerminalEvent = false;
      let responseStreamStarted = false;
      const activeSteps = new Map<number, ActiveStepState>();

      const flushStep = function* (
        index: number,
        step: ActiveStepState,
        delivery: ReturnType<typeof newDelivery>,
      ): Generator<StreamEvent, boolean, undefined> {
        activeSteps.delete(index);
        if (step.kind === "thought") {
          const thoughtPayload: Record<string, unknown> = { type: "thought" };
          if (step.signature) thoughtPayload.signature = step.signature;
          if (step.summaryItems.length > 0) {
            thoughtPayload.summary = step.summaryItems;
          }
          const opaqueStep = JSON.stringify(thoughtPayload);
          const protocolState = buildThinkingProtocolState(provenance, request.model, {
            ...(step.signature ? { signature: step.signature } : {}),
            opaqueStep,
          });
          const boundViolation = validateInboundThinkingProtocolState(protocolState);
          if (boundViolation) {
            yield {
              type: "error",
              error: markResponseStreamInterrupted(
                normalizeAdapterError(
                  new Error(`Google Interactions ${boundViolation}`),
                  delivery,
                  boundSecrets,
                ),
              ),
            };
            return false;
          }
          yield {
            type: "thinking_block_end",
            ...(step.signature ? { signature: step.signature } : {}),
            protocolState,
          };
          return true;
        } else if (step.kind === "function_call") {
          if (!step.started) {
            step.started = true;
            yield { type: "tool_call_start", id: step.id, name: step.name };
          }
          if (!step.emittedArgs && step.initialArguments !== undefined) {
            yield {
              type: "tool_call_delta",
              id: step.id,
              argsFragment:
                typeof step.initialArguments === "string"
                  ? step.initialArguments
                  : JSON.stringify(step.initialArguments),
            };
          }
          yield { type: "tool_call_end", id: step.id };
        }
        return true;
      };

      const delivery = newDelivery();
      try {
        const response = await withDelivery(delivery, () =>
          boundFetch(endpointUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: request.abortSignal,
          }),
        );

        if (!response.ok) {
          const httpError = await buildGoogleHttpError(response, boundSecrets);
          yield {
            type: "error",
            error: normalizeAdapterError(httpError, delivery, boundSecrets),
          };
          return;
        }

        if (!response.body) {
          yield {
            type: "error",
            error: markResponseStreamInterrupted(
              normalizeAdapterError(
                new Error("Google Interactions API returned an empty response body"),
                delivery,
                boundSecrets,
              ),
            ),
          };
          return;
        }

        responseStreamStarted = true;

        for await (const frame of readSseFrames(response.body, request.abortSignal)) {
          if (frame.data === "[DONE]") break;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(frame.data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType =
            typeof payload.event_type === "string"
              ? payload.event_type
              : frame.event ?? "";

          if (eventType === "step.start") {
            const index = readStepIndex(payload.index);
            const step = asRecord(payload.step);
            const stepType = typeof step?.type === "string" ? step.type : "";
            if (stepType === "thought") {
              const initialSig =
                typeof step?.signature === "string" ? step.signature : "";
              const summaryItems: Record<string, unknown>[] = [];
              const initialDisplay = appendThoughtSummaryItems(summaryItems, step?.summary);
              const state: ActiveThoughtStep = {
                kind: "thought",
                signature: initialSig,
                summaryItems,
                started: true,
              };
              activeSteps.set(index, state);
              yield { type: "thinking_block_start" };
              if (initialDisplay) {
                yield { type: "thinking_delta", thinking: initialDisplay };
              }
            } else if (stepType === "model_output") {
              activeSteps.set(index, { kind: "model_output" });
              const initialText = extractContentArrayText(step?.content);
              if (initialText) {
                yield { type: "text_delta", text: initialText };
              }
            } else if (stepType === "function_call" || stepType === "tool_call") {
              const callId =
                typeof step?.id === "string" && step.id.length > 0
                  ? step.id
                  : `gcall_${index}`;
              const callName =
                typeof step?.name === "string" ? step.name : "";
              const hasInitialNonEmptyArgs =
                step?.arguments !== undefined &&
                step.arguments !== null &&
                (typeof step.arguments !== "object" ||
                  Object.keys(step.arguments as Record<string, unknown>).length > 0);
              const state: ActiveFunctionCallStep = {
                kind: "function_call",
                id: callId,
                name: callName,
                started: Boolean(callName),
                emittedArgs: false,
                ...(hasInitialNonEmptyArgs
                  ? { initialArguments: step?.arguments }
                  : {}),
              };
              activeSteps.set(index, state);
              hasToolCalls = true;
              if (callName) {
                yield { type: "tool_call_start", id: callId, name: callName };
              }
            }
          } else if (eventType === "step.delta") {
            const index = readStepIndex(payload.index);
            const delta = asRecord(payload.delta);
            if (!delta) continue;
            const deltaType = typeof delta.type === "string" ? delta.type : "";

            if (deltaType === "thought_summary") {
              let step = activeSteps.get(index);
              if (!step || step.kind !== "thought") {
                step = {
                  kind: "thought",
                  signature: "",
                  summaryItems: [],
                  started: true,
                };
                activeSteps.set(index, step);
                yield { type: "thinking_block_start" };
              }
              const rawSummaryDelta =
                delta.content !== undefined
                  ? delta.content
                  : delta.summary !== undefined
                    ? delta.summary
                    : delta.text;
              const displayChunk = appendThoughtSummaryItems(
                step.summaryItems,
                rawSummaryDelta,
              );
              if (displayChunk) {
                yield { type: "thinking_delta", thinking: displayChunk };
              }
            } else if (deltaType === "thought_signature") {
              let step = activeSteps.get(index);
              if (!step || step.kind !== "thought") {
                step = {
                  kind: "thought",
                  signature: "",
                  summaryItems: [],
                  started: true,
                };
                activeSteps.set(index, step);
                yield { type: "thinking_block_start" };
              }
              if (typeof delta.signature === "string" && delta.signature.length > 0) {
                step.signature += delta.signature;
              }
            } else if (deltaType === "text") {
              if (typeof delta.text === "string" && delta.text.length > 0) {
                yield { type: "text_delta", text: delta.text };
              }
            } else if (deltaType === "arguments_delta") {
              const step = activeSteps.get(index);
              const fragment =
                typeof delta.arguments === "string"
                  ? delta.arguments
                  : typeof delta.arguments_string === "string"
                    ? delta.arguments_string
                    : typeof delta.text === "string"
                      ? delta.text
                      : "";
              if (step?.kind === "function_call" && fragment.length > 0) {
                if (!step.started && step.name) {
                  step.started = true;
                  yield { type: "tool_call_start", id: step.id, name: step.name };
                }
                step.emittedArgs = true;
                yield {
                  type: "tool_call_delta",
                  id: step.id,
                  argsFragment: fragment,
                };
              }
            } else if (deltaType === "function_call" || deltaType === "tool_call") {
              let step = activeSteps.get(index);
              const callId =
                typeof delta.id === "string" && delta.id.length > 0
                  ? delta.id
                  : step?.kind === "function_call"
                    ? step.id
                    : `gcall_${index}`;
              const callName =
                typeof delta.name === "string" && delta.name.length > 0
                  ? delta.name
                  : step?.kind === "function_call"
                    ? step.name
                    : "";
              if (!step || step.kind !== "function_call") {
                step = {
                  kind: "function_call",
                  id: callId,
                  name: callName,
                  started: false,
                  emittedArgs: false,
                };
                activeSteps.set(index, step);
              }
              hasToolCalls = true;
              if (!step.started && step.name) {
                step.started = true;
                yield { type: "tool_call_start", id: step.id, name: step.name };
              }
              if (delta.arguments !== undefined && delta.arguments !== null) {
                step.emittedArgs = true;
                yield {
                  type: "tool_call_delta",
                  id: step.id,
                  argsFragment:
                    typeof delta.arguments === "string"
                      ? delta.arguments
                      : JSON.stringify(delta.arguments),
                };
              }
            }
          } else if (eventType === "step.stop") {
            const index = readStepIndex(payload.index);
            const step = activeSteps.get(index);
            if (step) {
              const ok = yield* flushStep(index, step, delivery);
              if (!ok) return;
            }
          } else if (eventType === "interaction.completed") {
            const interaction = asRecord(payload.interaction);
            const status =
              typeof interaction?.status === "string" ? interaction.status : "";
            if (status === "failed" || status === "cancelled") {
              const errObj = asRecord(interaction?.error);
              const err = buildGoogleStreamError(errObj, payload, status, boundSecrets);
              yield {
                type: "error",
                error: markResponseStreamInterrupted(
                  normalizeAdapterError(err, delivery, boundSecrets),
                ),
              };
              return;
            }
            if (activeSteps.size > 0) {
              yield {
                type: "error",
                error: markResponseStreamInterrupted(
                  normalizeAdapterError(
                    new Error(
                      `Google Interactions stream_incomplete: interaction.completed 到达时仍有 ${activeSteps.size} 个未闭合的 step`,
                    ),
                    delivery,
                    boundSecrets,
                  ),
                ),
              };
              return;
            }
            receivedTerminalEvent = true;
            if (interaction?.usage) {
              usage = extractGoogleInteractionsUsage(interaction.usage);
            }
            if (status === "requires_action" || hasToolCalls) {
              stopReason = "tool_use";
            } else if (status === "incomplete" || status === "max_tokens") {
              stopReason = "max_tokens";
            } else {
              stopReason = "end_turn";
            }
          } else if (eventType === "error" || eventType === "interaction.failed") {
            const errObj =
              asRecord(payload.error) ?? asRecord(asRecord(payload.interaction)?.error);
            const streamErr = buildGoogleStreamError(errObj, payload, undefined, boundSecrets);
            yield {
              type: "error",
              error: markResponseStreamInterrupted(
                normalizeAdapterError(streamErr, delivery, boundSecrets),
              ),
            };
            return;
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
        // 绝不把 EOF 或 [DONE] 独自当作协议完成，也不刷出未闭合的悬挂步骤
        if (!receivedTerminalEvent || activeSteps.size > 0) {
          const reason = !receivedTerminalEvent
            ? "未收到协议终止事件（interaction.completed）"
            : `存在 ${activeSteps.size} 个未闭合的 step`;
          yield {
            type: "error",
            error: markResponseStreamInterrupted(
              normalizeAdapterError(
                new Error(`Google Interactions stream_incomplete: ${reason}`),
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

// ─── 输入步骤投影 ───

function convertMessagesToInteractionSteps(
  messages: Message[],
  provenance: AdapterProvenance,
): Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  const toolNameById = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNameById.set(block.id, block.name);
        }
        projectAssistantStep(block, provenance, steps);
      }
      continue;
    }

    const normalized = coalesceUserMaterialTextBlocks(msg.content);
    const userContent: Record<string, unknown>[] = [];
    const flushUserContent = (): void => {
      if (userContent.length === 0) return;
      steps.push({
        type: "user_input",
        content: [...userContent],
      });
      userContent.length = 0;
    };

    for (const block of normalized) {
      if (block.type === "tool_result") {
        flushUserContent();
        steps.push({
          type: "function_result",
          call_id: block.toolUseId,
          name: toolNameById.get(block.toolUseId) ?? "tool",
          result: block.content,
          ...(block.isError ? { is_error: true } : {}),
        });
      } else if (block.type === "text") {
        if (block.text.length > 0 || normalized.length === 1) {
          userContent.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (block.source.type === "base64") {
          userContent.push({
            type: "image",
            data: block.source.data,
            mime_type: block.source.mediaType,
          });
        } else {
          userContent.push({
            type: "image",
            uri: block.source.url,
          });
        }
      }
    }
    flushUserContent();
  }

  return steps;
}

function projectAssistantStep(
  block: ContentBlock,
  provenance: AdapterProvenance,
  steps: Record<string, unknown>[],
): void {
  switch (block.type) {
    case "thinking": {
      // 设计 §2.3：仅同可信来源且同协议（google-interactions，含同来源换型号）才按原 thought step 重传；
      // 跨连接、同连接改地址、跨协议或来源不明旧记录一律省略，绝不将签名/不透明步骤转为普通文本。
      if (!isSameTrustedThinkingSource(block.protocolState, provenance)) return;
      const state = block.protocolState!;
      if (state.opaqueStep) {
        try {
          const parsed = JSON.parse(state.opaqueStep) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed.type === "thought") {
            steps.push(parsed);
            return;
          }
        } catch {
          // fall through to structured fields if valid
        }
      }
      const sig = state.signature ?? block.signature;
      if (!sig && !block.thinking) return;
      const thoughtStep: Record<string, unknown> = { type: "thought" };
      if (sig) thoughtStep.signature = sig;
      if (block.thinking) {
        thoughtStep.summary = [{ type: "text", text: block.thinking }];
      }
      steps.push(thoughtStep);
      return;
    }

    case "text":
      steps.push({
        type: "model_output",
        content: [{ type: "text", text: block.text }],
      });
      return;

    case "tool_use":
      steps.push({
        type: "function_call",
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
      return;

    default:
      return;
  }
}

function convertToolsToInteractions(
  tools: ToolSpec[],
): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as Record<string, unknown>,
  }));
}

// ─── SSE 解析与错误/用量提取 ───

interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = findSseBoundary(buffer);
      while (boundary !== null) {
        const rawBlock = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseSseBlock(rawBlock);
        if (frame) yield frame;
        boundary = findSseBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors on already-closed stream
    }
    reader.releaseLock();
  }
}

function findSseBoundary(
  text: string,
): { readonly index: number; readonly length: number } | null {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return crlf < lf ? { index: crlf, length: 4 } : { index: lf, length: 2 };
}

function parseSseBlock(rawBlock: string): SseFrame | null {
  const trimmed = rawBlock.trim();
  if (!trimmed) return null;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of rawBlock.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    const rawValue = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  return {
    ...(eventName ? { event: eventName } : {}),
    data: dataLines.join("\n"),
  };
}

async function buildGoogleHttpError(
  response: Response,
  boundSecrets: readonly string[],
): Promise<Error> {
  let rawText = "";
  try {
    const buf = new Uint8Array(await response.arrayBuffer());
    rawText = new TextDecoder("utf-8").decode(
      buf.byteLength > MAX_ERROR_BODY_BYTES
        ? buf.subarray(0, MAX_ERROR_BODY_BYTES)
        : buf,
    );
  } catch {
    rawText = response.statusText || "HTTP error";
  }

  let parsedError: Record<string, unknown> | undefined;
  let errorCode: string | undefined;
  let errorStatus: string | undefined;
  let errorMessage = rawText.trim() || response.statusText || "Request failed";
  let reason: string | undefined;

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const inner = asRecord(parsed.error);
    if (inner) {
      parsedError = inner;
      if (typeof inner.code === "string" && inner.code.trim()) {
        errorCode = inner.code.trim();
      }
      if (typeof inner.status === "string" && inner.status.trim()) {
        errorStatus = inner.status.trim();
      }
      if (typeof inner.reason === "string" && inner.reason.trim()) {
        reason = inner.reason.trim();
      }
      if (typeof inner.message === "string" && inner.message.trim()) {
        errorMessage = inner.message.trim();
      }
      if (!reason && Array.isArray(inner.details)) {
        for (const item of inner.details) {
          const rec = asRecord(item);
          if (typeof rec?.reason === "string" && rec.reason.length > 0) {
            reason = rec.reason;
            break;
          }
        }
      }
    }
  } catch {
    // plain-text error body
  }

  const label = [...new Set([errorCode, errorStatus, reason].filter(Boolean))].join(" / ");
  const message = `HTTP ${response.status}${label ? ` (${label})` : ""}: ${sanitizeProviderErrorMessage(errorMessage, boundSecrets)}`;
  return Object.assign(new Error(message), {
    status: response.status,
    ...(errorCode ?? errorStatus ? { code: errorCode ?? errorStatus } : {}),
    ...(errorStatus ? { errorStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(parsedError ? { error: parsedError } : {}),
  });
}

function buildGoogleStreamError(
  errObj: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
  terminalStatus: string | undefined,
  boundSecrets: readonly string[],
): Error {
  const numericStatus =
    typeof errObj?.code === "number" && Number.isInteger(errObj.code)
      ? errObj.code
      : typeof errObj?.http_status === "number" && Number.isInteger(errObj.http_status)
        ? errObj.http_status
        : undefined;
  const stringCode =
    typeof errObj?.code === "string" && errObj.code.trim()
      ? errObj.code.trim()
      : undefined;
  const errStatus =
    typeof errObj?.status === "string" && errObj.status.trim()
      ? errObj.status.trim()
      : undefined;
  let reason =
    typeof errObj?.reason === "string" && errObj.reason.trim()
      ? errObj.reason.trim()
      : undefined;
  if (!reason && Array.isArray(errObj?.details)) {
    for (const item of errObj.details) {
      const rec = asRecord(item);
      if (typeof rec?.reason === "string" && rec.reason.trim()) {
        reason = rec.reason.trim();
        break;
      }
    }
  }
  const msg =
    typeof errObj?.message === "string" && errObj.message.trim()
      ? errObj.message.trim()
      : typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : terminalStatus
          ? `Google Interactions stream_incomplete: terminal status ${terminalStatus}`
          : "Google Interactions stream error";
  const label = [...new Set([stringCode, errStatus, reason].filter(Boolean))].join(" / ");
  const prefix = numericStatus !== undefined ? `HTTP ${numericStatus}` : "Google Interactions";
  return Object.assign(
    new Error(
      `${prefix}${label ? ` (${label})` : ""}: ${sanitizeProviderErrorMessage(msg, boundSecrets)}`,
    ),
    {
      ...(numericStatus !== undefined ? { status: numericStatus } : {}),
      ...(stringCode ?? errStatus ? { code: stringCode ?? errStatus } : {}),
      ...(errStatus ? { errorStatus: errStatus } : {}),
      ...(reason ? { reason } : {}),
      ...(errObj ? { error: errObj } : {}),
    },
  );
}

export function extractGoogleInteractionsUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  const inputTokens =
    readNumber(u.total_input_tokens) ?? readNumber(u.input_tokens) ?? 0;
  const baseOutput =
    readNumber(u.total_output_tokens) ?? readNumber(u.output_tokens) ?? 0;
  const thoughtTokens = readNumber(u.total_thought_tokens) ?? 0;
  const totalTokens = readNumber(u.total_tokens);
  const outputTokens =
    thoughtTokens > 0 &&
    totalTokens !== undefined &&
    inputTokens + baseOutput + thoughtTokens === totalTokens
      ? baseOutput + thoughtTokens
      : baseOutput;
  const cached =
    readNumber(u.total_cached_tokens) ?? readNumber(u.cached_tokens) ?? 0;
  const usage: TokenUsage = { inputTokens, outputTokens };
  if (cached > 0) {
    usage.cacheReadTokens = cached;
  }
  return usage;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStepIndex(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainTextSummaryItem(item: Record<string, unknown>): item is { type: "text"; text: string } {
  const keys = Object.keys(item);
  return keys.length === 2 && item.type === "text" && typeof item.text === "string";
}

/**
 * 按原生顺序将 Google Interactions `thought` summary 条目合入 `target`（完整保留 text / image / text 结构与顺序），
 * 同时返回仅用于界面展示的派生文本增量。
 */
function appendThoughtSummaryItems(
  target: Record<string, unknown>[],
  raw: unknown,
): string {
  if (raw === undefined || raw === null) return "";
  const items = Array.isArray(raw) ? raw : [raw];
  let display = "";

  const pushText = (text: string): void => {
    if (!text) return;
    const prev = target.at(-1);
    if (prev && isPlainTextSummaryItem(prev)) {
      prev.text += text;
      display += text;
    } else {
      const hadPriorItem = target.length > 0;
      target.push({ type: "text", text });
      display += hadPriorItem ? `\n\n${text}` : text;
    }
  };

  for (const entry of items) {
    if (typeof entry === "string") {
      pushText(entry);
      continue;
    }
    const rec = asRecord(entry);
    if (!rec) continue;
    if (isPlainTextSummaryItem(rec)) {
      pushText(rec.text);
      continue;
    }
    if (typeof rec.type === "string") {
      target.push(structuredClone(rec));
      if (rec.type === "text" && typeof rec.text === "string" && rec.text.length > 0) {
        display += display ? `\n\n${rec.text}` : rec.text;
      }
    } else if (typeof rec.text === "string") {
      pushText(rec.text);
    }
  }
  return display;
}

function extractContentArrayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const rec = asRecord(part);
      return rec?.type === "text" && typeof rec.text === "string" ? rec.text : "";
    })
    .join("");
}
