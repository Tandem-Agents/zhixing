/**
 * Ephemeral Agent Turn 执行器
 *
 * 定时任务的默认执行路径：绕过 ConversationManager，直接用一个共享的 AgentRuntime
 * 跑单 prompt → 收集结果 → 返回 AgentTurnResult。磁盘零痕迹。
 *
 * 对比用户会话路径（走 ConversationManager）：
 * - 用户会话：跨多轮累积历史，持久化 transcript 到 conv_xxx/（身份绑定、可恢复）
 * - 定时任务：每次执行独立，不留历史，不落盘（K8s Job / Serverless / Claude Code 子 Agent 同构）
 *
 * 规格引用：persistent-service.md §4.2 TaskAction（sessionId 未提供时的 ephemeral 模式）
 */
import {
  userMessage,
  type AgentYield,
  type Message,
  type TurnContext,
} from "@zhixing/core";
import type { AgentTurnResult } from "@zhixing/core";
import {
  assertKernelRunEvent,
  assertKernelTerminal,
  type AgentRuntime,
  type KernelRunEvent,
  type KernelTerminal,
} from "@zhixing/orchestrator/runtime";
import { serializeAbortReason } from "./abort-serializer.js";

export interface EphemeralTurnOptions {
  runtime: AgentRuntime;
  prompt: string;
  /** 可选：流式事件回调（调试/审计用，默认不消费） */
  onYield?: (event: AgentYield) => void;
  /**
   * 可选 turn 级上下文。scheduler → ephemeralRuntime 路径由 serve/command.ts
   * 填入 `{ turnId, turnOrigin: { channel: "scheduler", target?, triggeredBy: taskId } }`——
   * 用于远程确认把请求路由回创建任务时的通道对话
   * （remote-confirmation-execution.md §3.3）。
   */
  turnContext?: TurnContext;
  /**
   * 可选 abortSignal。由当前执行 owner 提供；scheduler user job 已走耐久
   * cancellation dispatcher，不再由进程内 RunRegistry 持有取消事实。
   * 后,agent-loop / LLM call / 工具执行通过 signal 链路自然完成 cleanup,
   * aborted Kernel terminal 携带类型化中断源,经 `serializeAbortReason`
   * 序列化到 `AgentTurnResult.detail`。
   *
   * 不传时所有 LLM 调用无外部限制(REPL / 单元测试 / 手工触发场景)。
   */
  abortSignal?: AbortSignal;
}

function unhandledEphemeralKernelEvent(event: never): never {
  throw new TypeError(`Unhandled ephemeral Kernel event: ${String(event)}`);
}

/** Kernel → ephemeral product result projection. */
function projectKernelEventToEphemeralYield(
  event: KernelRunEvent,
): AgentYield {
  assertKernelRunEvent(event);
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", text: event.text };
    case "thinking_block_start":
      return { type: "thinking_block_start" };
    case "thinking_delta":
      return { type: "thinking_delta", thinking: event.thinking };
    case "thinking_block_end":
      return { type: "thinking_block_end" };
    case "assistant_message":
      return {
        type: "assistant_message",
        message: structuredClone(event.message),
      };
    case "tool_start":
      return {
        type: "tool_start",
        id: event.id,
        name: event.name,
        input: structuredClone(event.input),
      };
    case "tool_end":
      return {
        type: "tool_end",
        id: event.id,
        name: event.name,
        result: structuredClone(event.result),
        duration: event.duration,
      };
    case "turn_complete":
      return {
        type: "turn_complete",
        turnCount: event.turnCount,
        usage: structuredClone(event.usage),
      };
    default:
      return unhandledEphemeralKernelEvent(event);
  }
}

function unhandledEphemeralKernelTerminal(terminal: never): never {
  throw new TypeError(`Unhandled ephemeral Kernel terminal: ${String(terminal)}`);
}

/** Kernel terminal → ephemeral product result projection. */
function projectKernelTerminalToEphemeralResult(
  terminal: KernelTerminal,
  output: string | undefined,
  durationMs: number,
): AgentTurnResult {
  assertKernelTerminal(terminal);
  switch (terminal.reason) {
    case "completed":
      return { status: "ok", output, durationMs };
    case "max_turns":
      return {
        status: "error",
        output,
        error: "Max turns reached",
        durationMs,
      };
    case "aborted": {
      const serialized = serializeAbortReason(terminal.abortReason);
      return {
        status: "error",
        output,
        error: serialized.message,
        detail: serialized.detail ?? undefined,
        durationMs,
      };
    }
    case "error":
      return {
        status: "error",
        output,
        error: terminal.error.message,
        durationMs,
      };
    default:
      return unhandledEphemeralKernelTerminal(terminal);
  }
}

/**
 * 执行一次 ephemeral agent-turn。
 * - 仅传入本次 prompt 的消息列表（不累积历史）
 * - 聚合 text_delta 为 output 字符串
 * - 映射 KernelTerminal.reason → AgentTurnResult.status
 */
export async function runEphemeralTurn(
  opts: EphemeralTurnOptions,
): Promise<AgentTurnResult> {
  const startTime = Date.now();
  const textChunks: string[] = [];
  try {
    const messages: Message[] = [userMessage(opts.prompt)];
    const runResult = await opts.runtime.run({
      modelInput: { messages },
      identity: {
        turnIndex: 0, // ephemeral 单次执行（不累积 counter，钩子上下文里恒为 0）
        turnContext: opts.turnContext,
      },
      control: { abortSignal: opts.abortSignal },
      correctness: {},
      observation: {
        onEvent: (event) => {
          const productEvent = projectKernelEventToEphemeralYield(event);
          if (productEvent.type === "text_delta") {
            textChunks.push(productEvent.text);
          }
          opts.onYield?.(productEvent);
        },
      },
    });

    const output = textChunks.join("") || undefined;
    return projectKernelTerminalToEphemeralResult(
      runResult.terminal,
      output,
      Date.now() - startTime,
    );
  } catch (err) {
    return {
      status: "error",
      output: textChunks.join("") || undefined,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
