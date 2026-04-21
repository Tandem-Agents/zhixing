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
import { userMessage, type AgentYield, type Message } from "@zhixing/core";
import type { AgentTurnResult } from "@zhixing/core";
import type { AgentRuntime } from "../run-agent.js";

export interface EphemeralTurnOptions {
  runtime: AgentRuntime;
  prompt: string;
  /** 可选：流式事件回调（调试/审计用，默认不消费） */
  onYield?: (event: AgentYield) => void;
}

/**
 * 执行一次 ephemeral agent-turn。
 * - 仅传入本次 prompt 的消息列表（不累积历史）
 * - 聚合 text_delta 为 output 字符串
 * - 映射 AgentResult.reason → AgentTurnResult.status
 */
export async function runEphemeralTurn(
  opts: EphemeralTurnOptions,
): Promise<AgentTurnResult> {
  const startTime = Date.now();
  const textChunks: string[] = [];
  try {
    const messages: Message[] = [userMessage(opts.prompt)];
    const runResult = await opts.runtime.run({
      messages,
      onYield: (event) => {
        if (event.type === "text_delta") textChunks.push(event.text);
        opts.onYield?.(event);
      },
    });

    const output = textChunks.join("") || undefined;
    const r = runResult.agentResult;
    if (r.reason === "completed") {
      return { status: "ok", output, durationMs: Date.now() - startTime };
    }
    if (r.reason === "max_turns") {
      return {
        status: "error",
        output,
        error: "Max turns reached",
        durationMs: Date.now() - startTime,
      };
    }
    if (r.reason === "aborted") {
      return {
        status: "error",
        output,
        error: "Aborted",
        durationMs: Date.now() - startTime,
      };
    }
    return {
      status: "error",
      output,
      error: r.error.message,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "error",
      output: textChunks.join("") || undefined,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
