import { randomUUID } from "node:crypto";
import { PROCESS_LOG_SOURCE } from "@zhixing/core/interrupt";
import type { IEventBus } from "@zhixing/core/events";
import type { BindLogSource, LogDraft, LogRecordPort, LogRef, LogSource } from "@zhixing/core/logging";
import type { AgentEventMap, ChatRequest, StreamEvent } from "@zhixing/core/types";
import { runContextStorage } from "./run-context.js";

const fields = {
  model: "text", provider: "text", reason: "text", error: "text", errorType: "text",
  duration: "number", tool: "text", resultSize: "number", messageCount: "number",
  toolCount: "number", turnIndex: "number", lineage: "text", attempt: "number",
  maxRetries: "number", delayMs: "number", willRetry: "boolean", decision: "text",
  hookId: "text", phase: "text", inputChars: "number", outputChars: "number",
  inputUnits: "number", outputUnits: "number", thinking: "text",
  tools: { items: "text", maxItems: 32 },
} as const;
const event = (message: string, level: "info" | "warn" | "error" = "info") =>
  ({ message, level, tier: "critical" as const, fields });
export const KERNEL_LOG_SOURCE: LogSource = {
  id: "kernel", version: 1,
  events: {
    configured: { message: "运行配置已生效", level: "info", tier: "critical", fields: {
      model: "text", provider: "text", toolCount: "number", tools: { items: "text", maxItems: 32 },
      toolSetVersion: "text", toolNamesOmitted: "number", turnIndex: "number", primaryRole: "text", sessionType: "text",
      thinking: "text", contextUnits: "number", maxOutputUnits: "number",
    } }, started: event("模型运行开始"),
    finished: event("模型运行已结束"), released: event("运行观察资源已释放"),
    input: event("运行接纳后续输入"), toolStarted: event("工具调用开始"),
    toolFinished: event("工具调用已返回"), permission: event("工具权限已裁决"),
    childStarted: event("子任务开始"), childFinished: event("子任务已结束"),
    retry: event("模型调用重试裁决", "warn"), recovered: event("模型调用重试后成功"),
    exhausted: event("模型调用重试已耗尽", "error"),
    interrupted: event("运行取消已观察到", "warn"),
    error: event("运行边界发生错误", "error"), warning: event("运行已降级", "warn"),
    window: event("上下文窗口发生变化"),
  },
};
export const PROVIDER_LOG_SOURCE: LogSource = {
  id: "provider", version: 1,
  events: { requested: event("已调用模型适配器"), returned: event("模型适配器调用已结束") },
};

export interface KernelLogPorts { readonly kernel: LogRecordPort; readonly provider: LogRecordPort; readonly process: LogRecordPort; readonly mcp?: LogRecordPort }
export interface KernelLogIdentity {
  readonly conversationId?: string;
  readonly refs?: readonly LogRef[];
}
export type KernelLogFactory = (identity: KernelLogIdentity) => KernelLogPorts;

export function optionalKernelLogs(factory: KernelLogFactory | undefined, identity: KernelLogIdentity): KernelLogPorts | undefined {
  try { return factory?.(identity); } catch { return undefined; }
}

/** Called only by the trusted Host; no Store or reader crosses into the Kernel. */
export function createKernelLogFactory(bind: BindLogSource, mcpSource?: LogSource): KernelLogFactory {
  return (identity) => {
    const access = { scope: identity.conversationId ? `conversation:${identity.conversationId}` : "storage" };
    const refs = [
      ...(identity.conversationId ? [{ kind: "conversation", id: identity.conversationId }] : []),
      ...(identity.refs ?? []),
    ];
    return { kernel: bind(KERNEL_LOG_SOURCE, access, refs), provider: bind(PROVIDER_LOG_SOURCE, access, refs), process: bind(PROCESS_LOG_SOURCE, access, refs), mcp: mcpSource ? bind(mcpSource, access, refs) : undefined };
  };
}

/** Explicit event bindings: no raw chunks, arguments, prompts or bus-wide transcription. */
export function observeKernelRun(bus: IEventBus<AgentEventMap>, records: LogRecordPort): () => void {
  const dispose: (() => void)[] = [];
  const on = <K extends keyof AgentEventMap & string>(name: K, project: (value: AgentEventMap[K]) => LogDraft) => {
    dispose.push(bus.on(name, (value, meta) => records.record(() => {
      const draft = project(value);
      const child = runContextStorage.getStore()?.childTaskId;
      return { ...draft, data: { ...draft.data, lineage: meta?.lineage },
        refs: [...(draft.refs ?? []), ...(child ? [{ kind: "task", id: child }] : [])] };
    })));
  };
  on("agent:run_start", (v) => ({ event: "started", data: { inputChars: v.prompt.length } }));
  on("agent:run_end", (v) => ({ event: "finished", result: v.reason === "completed" ? "success" : v.reason === "aborted" ? "cancelled" : "failure", data: { reason: v.reason, error: v.error, errorType: v.errorType, duration: v.duration, inputUnits: v.usage.inputTokens, outputUnits: v.usage.outputTokens } }));
  on("agent:input_received", (v) => ({ event: "input", data: { messageCount: v.inputs.length } }));
  on("tool:call_start", (v) => ({ event: "toolStarted", refs: [{ kind: "toolCall", id: v.id }], data: { tool: v.name } }));
  on("tool:execution_observed", (v) => ({ event: "toolFinished", refs: [{ kind: "toolCall", id: v.id }], result: v.result, data: { tool: v.name, duration: v.duration, resultSize: v.resultSize, error: v.error instanceof Error ? v.error.message : typeof v.error === "string" ? v.error : undefined } }));
  on("tool:child_start", (v) => ({ event: "childStarted", refs: [{ kind: "toolCall", id: v.parentToolCallId }, { kind: "task", id: v.childAgentId }] }));
  on("tool:child_end", (v) => ({ event: "childFinished", refs: [{ kind: "toolCall", id: v.parentToolCallId }, { kind: "task", id: v.childAgentId }], result: v.status === "succeeded" ? "success" : v.status === "aborted" ? "cancelled" : "failure", data: { duration: v.duration } }));
  on("retry:attempt", (v) => ({ event: "retry", data: { ...v } }));
  on("retry:exhausted", (v) => ({ event: "exhausted", result: "failure", data: { error: v.lastError, errorType: v.errorType, attempt: v.totalAttempts } }));
  on("retry:success", (v) => ({ event: "recovered", result: "success", data: { attempt: v.attemptsTaken, duration: v.totalDelayMs } }));
  on("interrupt:fired", (v) => ({ event: "interrupted", result: "cancelled", data: { reason: v.reason?.kind, duration: v.exitDelayMs } }));
  on("error:fatal", (v) => ({ event: "error", result: "failure", data: { error: v.message, errorType: v.type } }));
  on("error:recoverable", (v) => ({ event: "warning", data: { error: v.message, errorType: v.type, willRetry: v.willRetry, attempt: v.attempt } }));
  on("lifecycle:hook_failed", (v) => ({ event: "error", result: "failure", data: { ...v } }));
  on("lifecycle:warning", (v) => ({ event: "warning", data: { hookId: v.hookId, phase: v.phase, error: v.message } }));
  on("lifecycle:prompt_rebuilt", (v) => ({ event: "window", data: { reason: v.reason } }));
  on("segment:transition_failed", (v) => ({ event: "error", result: "failure", data: { error: v.error } }));
  return () => { for (const unsubscribe of dispose) unsubscribe(); };
}

/** Each invocation is an actual adapter attempt, including retries and auxiliary calls. */
export async function* observeProviderCall(
  call: (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined>,
  request: ChatRequest,
  provider: string,
  fallback?: LogRecordPort,
): AsyncGenerator<StreamEvent, void, undefined> {
  const context = runContextStorage.getStore();
  const records = context?.logPorts?.provider ?? fallback;
  if (!records) { yield* call(request); return; }
  const refs: LogRef[] = [{ kind: "modelAttempt", id: randomUUID() }];
  const child = context?.childTaskId;
  if (child) refs.push({ kind: "task", id: child });
  const started = performance.now();
  let result: LogDraft["result"] = "unknown", error: unknown;
  let outputChars = 0, inputTokens: number | undefined, outputTokens: number | undefined;
  records.record(() => ({ event: "requested", refs, data: {
    model: request.model, provider, messageCount: request.messages.length,
    toolCount: request.tools?.length ?? 0, tools: request.tools?.slice(0, 33).map((tool) => tool.name),
    thinking: request.thinking?.mode,
  } }));
  try {
    for await (const item of call(request)) {
      try {
      if (item.type === "text_delta") outputChars += item.text.length;
      else if (item.type === "error") { result = "failure"; error = item.error; }
      else if (item.type === "message_end") {
        if (result !== "failure") result = "success";
        inputTokens = item.usage.inputTokens; outputTokens = item.usage.outputTokens;
      }
      } catch { /* A malformed observation never changes the provider stream. */ }
      yield item;
    }
  } catch (cause) {
    result = request.abortSignal?.aborted ? "cancelled" : "failure";
    error = cause;
    throw cause;
  } finally {
    records.record(() => ({ event: "returned", refs,
      result: result === "unknown" && request.abortSignal?.aborted ? "cancelled" : result,
      data: { model: request.model, provider, error: error instanceof Error ? error.message : error === undefined ? undefined : "模型适配器返回异常", outputChars, inputUnits: inputTokens, outputUnits: outputTokens, duration: performance.now() - started } }));
  }
}
