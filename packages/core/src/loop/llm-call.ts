/**
 * streamLLMCall — 流式 LLM 调用子生成器
 *
 * 职责：
 * 1. 构建 ChatRequest 并调用 LLM Provider
 * 2. 消费流式事件，组装完整的 assistant Message
 * 3. 将 text_delta / thinking_delta 透传给消费者（通过 yield）
 * 4. 解析工具调用参数（流式 JSON 拼接）
 * 5. 通过 EventBus 发射 LLM 相关事件
 * 6. 在 abort 触发时立即退出 stream 消费循环并返回 partial 数据
 *
 * 中断架构：
 *
 * - **接 controller 而非 abortSignal**：后续里程碑的看门狗需要 controller.abort() 写权限
 *   触发 idle-timeout abort；agent-loop 是 controller 的所有者，下游全程透传 signal。
 *
 * - **wrapStreamWithWatchdog 包装 stream**：facade 组合 race 基础层 + 可选 idle-timer
 *   叠加层。race 永远生效，保证 iterator.next() 在 controller aborted 后短时间内返回 done，
 *   无论底层 SDK / mock stream 是否响应 abortSignal —— 这是中断响应延迟的下限保证。
 *   idle-timer 在 watchdog policy idleTimeoutMs > 0 时叠加，处理"LLM 流静默挂死"场景。
 *
 * - **先处理后 check 模式**：for-await 内先累积 pendingText/Thinking 再 check abort。
 *   保证 abort 瞬间收到的最后一个 chunk 已进 partial.text，partial 内容完整。
 *
 * - **abort 路径返回 partial 而非完整 message**：partial 仅含 text+thinking，pendingToolCalls
 *   故意丢弃（未完成的 tool_use 不能放进 message —— 协议要求每个 tool_use 必有配对
 *   tool_result，残缺会让下一轮 LLM 报 400）。assistant_message 不在 abort 路径 yield，
 *   由 agent-loop 调 cleanup 用 assemblePartialMessage 注入 [interrupted] 标记后再 yield。
 *
 * 为什么是子生成器：
 * - 通过 yield* 在主循环中调用，消费者的 yield 链路不断裂
 * - return 返回 LLMCallResult，调用方直接解构使用
 * - 关注点分离：流处理逻辑独立于循环编排
 */

import { assembleSafeMessage } from "../interrupt/assemble.js";
import type { IEventBus } from "../events/types.js";
import { wrapStreamWithWatchdog } from "../interrupt/watchdog.js";
import type { WatchdogPolicy } from "../interrupt/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { AgentError } from "../types/errors.js";
import type { ChatRequest, StopReason, TokenUsage } from "../types/llm.js";
import { emptyUsage } from "../types/llm.js";
import type { ContentBlock, Message } from "../types/messages.js";
import type { ToolSpec } from "../types/tools.js";
import type { AgentLoopDeps, AgentYield, LLMCallResult } from "./types.js";

interface StreamLLMCallParams {
  deps: AgentLoopDeps;
  messages: readonly Message[];
  model: string;
  systemPrompt?: string;
  toolSpecs: ToolSpec[];
  /**
   * 中断控制器 —— loop 内部子生成器例外接受 controller (生产路径由 agent-loop 持有)，
   * 下游 ChatRequest 仍接 controller.signal，Provider 抽象不变。
   */
  controller: AbortController;
  /**
   * stream 看门狗策略。缺省 (`undefined`) 时 wrapStreamWithWatchdog 用模块层
   * 默认 DEFAULT_WATCHDOG_POLICY (60s idle, 50% warn)。
   *
   * 透传链:agent-loop 把 params.watchdog 不做 fallback 直接转到这里,默认值
   * 由调用边界 (cli/src/run-agent.ts) 单点注入,本层不二次 fallback 保证
   * 用户显式禁用 idle-timer (`{ idleTimeoutMs: 0 }`) 不被覆盖。
   */
  watchdog?: WatchdogPolicy;
  eventBus?: IEventBus<AgentEventMap>;
}

/**
 * 发起一次流式 LLM 调用。
 *
 * yield: text_delta / thinking_delta / assistant_message (仅非 abort 路径)
 * return: LLMCallResult 判别联合 (aborted=false 含 message+stopReason；aborted=true 含 partial)
 */
export async function* streamLLMCall(
  params: StreamLLMCallParams,
): AsyncGenerator<AgentYield, LLMCallResult> {
  const { deps, messages, model, systemPrompt, toolSpecs, controller, watchdog, eventBus } = params;

  const request: ChatRequest = {
    model,
    systemPrompt,
    messages: messages as Message[],
    tools: toolSpecs.length > 0 ? toolSpecs : undefined,
    abortSignal: controller.signal,
  };

  console.log(`[llm] 请求 model=${model} msgs=${messages.length} tools=${toolSpecs.length > 0 ? toolSpecs.map(t => t.name).join(",") : "无"}`);

  await eventBus?.emit("llm:request_start", {
    model,
    messageCount: messages.length,
    hasTools: toolSpecs.length > 0,
  });

  const startTime = Date.now();
  const contentBlocks: ContentBlock[] = [];

  // 用于积累流式文本/思考
  let pendingText = "";
  let pendingThinking = "";

  // 用于解析流式工具调用 (abort 路径丢弃)
  const pendingToolCalls = new Map<string, { id: string; name: string; argsJson: string }>();

  let stopReason: StopReason = "end_turn";
  let usage: TokenUsage = emptyUsage();
  // provider error event 路径用 —— 与 abort 分离 (abort 走 aborted variant，不走 error)
  let providerError: AgentError | undefined;

  try {
    const rawStream = deps.callLLM(request);
    // wrap watchdog: race 基础层永远生效 (即使底层 SDK 不响应 abortSignal,iterator.next()
    // 在 abort 后短时间内返回 done) + 可选 idle-timer 叠加层 (chunk-arrival idle 触发 abort,
    // 由 watchdog policy idleTimeoutMs 控制阈值, <= 0 时仅启用 race)。
    const stream = wrapStreamWithWatchdog(rawStream, controller, watchdog, eventBus);

    for await (const event of stream) {
      // 透传原始流事件到 EventBus（供 UI 层消费）
      await eventBus?.emit("llm:stream_event", event);

      // **先处理 event 累积 partial**：保证 abort 瞬间收到的最后一个 chunk 已进 pending 区
      switch (event.type) {
        case "text_delta":
          pendingText += event.text;
          yield { type: "text_delta", text: event.text };
          break;

        case "thinking_delta":
          pendingThinking += event.thinking;
          yield { type: "thinking_delta", thinking: event.thinking };
          break;

        case "tool_call_start":
          pendingToolCalls.set(event.id, { id: event.id, name: event.name, argsJson: "" });
          break;

        case "tool_call_delta": {
          const pending = pendingToolCalls.get(event.id);
          if (pending) {
            pending.argsJson += event.argsFragment;
          }
          break;
        }

        case "tool_call_end":
          // tool_call_end 不需要额外处理，参数在 message_end 后统一解析
          break;

        case "message_end":
          stopReason = event.stopReason;
          usage = event.usage;
          break;

        case "error":
          // provider error 与 abort 分离：abort 走 aborted variant，error 走 success variant
          // 携带 error 字段；这里记 providerError 让循环结束后统一返回
          providerError = new AgentError(
            event.error.message,
            "provider_error",
            true,
            event.error,
          );
          break;

        case "message_start":
          break;
      }

      // **再 check abort**：race 层已保证下次 next() 在 abort 后 ≤10ms 返回 done，
      // 此处显式 break 是与 race 形成双保险——表达"本 event 处理完即退出"的意图，
      // 省一次 micro-task 的 race resolve 等待，让 abort 响应延迟更稳定
      if (controller.signal.aborted) break;

      // provider error 同样退出 (但走非 abort 路径，下方会构造 success variant + error 字段)
      if (providerError) break;
    }
  } catch (err) {
    // SDK 抛错路径：区分 abort 触发的 AbortError 与真实 provider 错误
    if (controller.signal.aborted) {
      // SDK 因 abort 抛 AbortError —— 落到下方 abort 出口
    } else {
      // 真实 provider 错误（network failure / 序列化错误等）：包成 AgentError 走
      // success variant + error 字段。
      // message 用 assembleSafeMessage 跳过残缺 tool_use (流中断时 pendingToolCalls 可能
      // 含未完成的 tool_use, 进 next-turn LLM 会因缺配对 tool_result 报 400)。
      // 行为与下方 provider error event 出口一致：partial 非空时 yield assistant_message
      // 让 trackMessages 收集进 newMessages, 保留用户已看到的 partial 输出进 transcript。
      const duration = Date.now() - startTime;
      await eventBus?.emit("llm:request_end", {
        model,
        duration,
        usage,
        stopReason,
      });

      const agentError = err instanceof AgentError
        ? err
        : new AgentError(
            err instanceof Error ? err.message : String(err),
            "provider_error",
            true,
            err,
          );

      const safePartial = assembleSafeMessage(pendingText, pendingThinking);
      if (safePartial) {
        yield { type: "assistant_message", message: safePartial };
      }

      return {
        aborted: false,
        message: safePartial ?? ({ role: "assistant", content: [] } as const),
        stopReason,
        usage,
        error: agentError,
      };
    }
  }

  // ── abort 出口 ──
  // partial 仅含 text+thinking，pendingToolCalls 故意丢弃 (协议要求每个 tool_use
  // 配对 tool_result, partial 中残缺的 tool_use 会让下一轮 LLM 报 400)。
  // assistant_message 不在此 yield，由 agent-loop 调 cleanup 注入 [interrupted] 标记后处理。
  if (controller.signal.aborted) {
    const duration = Date.now() - startTime;
    await eventBus?.emit("llm:request_end", {
      model,
      duration,
      usage,
      stopReason,
    });
    return {
      aborted: true,
      partial: { text: pendingText, thinking: pendingThinking },
      usage,
    };
  }

  // ── 正常出口 ──
  // 两条子路径:
  //   1. provider error event 触发的中断 (providerError 非空):用 assembleSafeMessage 跳过
  //      残缺 tool_use 防协议违规 (与 catch 块 SDK 错误路径一致);仅在 partial 非空时 yield
  //      让 trackMessages 收集进 newMessages 保留用户已看到的 LLM 输出
  //   2. 完整完成:assembleMessage 走完整路径 (含 tool_use), yield 给 trackMessages
  const duration = Date.now() - startTime;
  await eventBus?.emit("llm:request_end", {
    model,
    duration,
    usage,
    stopReason,
  });

  if (providerError) {
    const safePartial = assembleSafeMessage(pendingText, pendingThinking);
    if (safePartial) {
      yield { type: "assistant_message", message: safePartial };
    }
    return {
      aborted: false,
      message: safePartial ?? ({ role: "assistant", content: [] } as const),
      stopReason,
      usage,
      error: providerError,
    };
  }

  const message = assembleMessage(contentBlocks, pendingText, pendingThinking, pendingToolCalls);
  yield { type: "assistant_message", message };

  return {
    aborted: false,
    message,
    stopReason,
    usage,
  };
}

// ─── 内部辅助 ───

/**
 * 将积累的流式内容组装为完整的 assistant Message。
 * 顺序：ThinkingBlock → TextBlock → ToolUseBlock[]
 */
function assembleMessage(
  existingBlocks: ContentBlock[],
  pendingText: string,
  pendingThinking: string,
  pendingToolCalls: Map<string, { id: string; name: string; argsJson: string }>,
): Message {
  const content: ContentBlock[] = [...existingBlocks];

  if (pendingThinking) {
    content.push({ type: "thinking", thinking: pendingThinking });
  }
  if (pendingText) {
    content.push({ type: "text", text: pendingText });
  }
  for (const tc of pendingToolCalls.values()) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: parseToolCallArgs(tc.argsJson),
    });
  }

  return { role: "assistant", content };
}

/**
 * 安全解析工具调用参数 JSON。
 * 解析失败时返回空对象 —— 工具执行器会处理参数缺失的情况。
 */
function parseToolCallArgs(argsJson: string): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
