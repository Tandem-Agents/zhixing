/**
 * Ephemeral 执行器单测 — mock AgentRuntime，验证 AgentResult → AgentTurnResult 映射
 */

import { describe, it, expect, vi } from "vitest";
import type { AbortReason, AgentResult, AgentYield, Message } from "@zhixing/core";
import type { RunResult } from "@zhixing/core";
import type { AgentRuntime, RunParams } from "@zhixing/orchestrator/runtime";
import { runEphemeralTurn } from "../ephemeral-executor.js";

interface MockBehavior {
  yields?: AgentYield[];
  reason?: AgentResult["reason"];
  throwError?: string;
  errorMessage?: string;
  abortReason?: AbortReason;
}

function createMockAgentRuntime(behavior: MockBehavior = {}): AgentRuntime {
  const stub = {} as AgentRuntime;
  return Object.assign(stub, {
    providerId: "mock",
    model: "mock-model",
    async run(params: RunParams): Promise<RunResult> {
      if (behavior.throwError) throw new Error(behavior.throwError);

      const yields = behavior.yields ?? [];
      for (const y of yields) params.onYield?.(y);

      const reason = behavior.reason ?? "completed";
      const completedResult: AgentResult = {
        reason: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      const result: AgentResult =
        reason === "completed"
          ? completedResult
          : reason === "max_turns"
            ? { reason: "max_turns", maxTurns: 100, usage: { inputTokens: 1, outputTokens: 1 } }
            : reason === "aborted"
              ? {
                  reason: "aborted",
                  abortReason: behavior.abortReason,
                  usage: { inputTokens: 0, outputTokens: 0 },
                }
              : {
                  reason: "error",
                  error: Object.assign(new Error(behavior.errorMessage ?? "boom"), {
                    name: "AgentError",
                  }) as AgentResult extends { reason: "error"; error: infer E } ? E : never,
                  usage: { inputTokens: 0, outputTokens: 0 },
                };

      const newMessages: Message[] =
        reason === "completed"
          ? [{ role: "assistant", content: [{ type: "text", text: "done" }] }]
          : [];

      return {
        agentResult: result,
        newMessages,
        durationMs: 10,
      };
    },
  });
}

describe("runEphemeralTurn", () => {
  it("收集 text_delta 为 output，completed 映射为 ok", async () => {
    const runtime = createMockAgentRuntime({
      yields: [
        { type: "text_delta", text: "你好" },
        { type: "text_delta", text: "世界" },
      ],
    });

    const result = await runEphemeralTurn({ runtime, prompt: "say hi" });
    expect(result.status).toBe("ok");
    expect(result.output).toBe("你好世界");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("无 text_delta 时 output 为 undefined", async () => {
    const runtime = createMockAgentRuntime({ yields: [] });
    const result = await runEphemeralTurn({ runtime, prompt: "silent" });
    expect(result.status).toBe("ok");
    expect(result.output).toBeUndefined();
  });

  it("max_turns 映射为 error + 'Max turns reached'", async () => {
    const runtime = createMockAgentRuntime({ reason: "max_turns" });
    const result = await runEphemeralTurn({ runtime, prompt: "loop" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("Max turns reached");
  });

  it("aborted 无 abortReason → error + 通用 'Aborted.' 兜底", async () => {
    const runtime = createMockAgentRuntime({ reason: "aborted" });
    const result = await runEphemeralTurn({ runtime, prompt: "stop" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("Aborted.");
    expect(result.detail).toBeUndefined();
  });

  it("aborted 携带 abortReason → error + 类型化 message + detail 完整保留 fork 链", async () => {
    const wrapped: AbortReason = {
      kind: "parent-abort",
      parentReason: { kind: "external", origin: "scheduler-shutdown" },
    };
    const runtime = createMockAgentRuntime({
      reason: "aborted",
      abortReason: wrapped,
    });
    const result = await runEphemeralTurn({ runtime, prompt: "stop" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("Aborted: scheduler-shutdown.");
    expect(result.detail).toEqual(wrapped);
  });

  it("reason=error 映射 agentError.message", async () => {
    const runtime = createMockAgentRuntime({
      reason: "error",
      errorMessage: "LLM quota exceeded",
    });
    const result = await runEphemeralTurn({ runtime, prompt: "x" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("LLM quota exceeded");
  });

  it("run() 抛异常 → error + 捕获 message", async () => {
    const runtime = createMockAgentRuntime({ throwError: "network fail" });
    const result = await runEphemeralTurn({ runtime, prompt: "x" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("network fail");
  });

  it("仅传本轮 messages（验证 stateless 语义）", async () => {
    const runSpy = vi.fn(async (_params: RunParams): Promise<RunResult> => ({
      agentResult: {
        reason: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      newMessages: [],
      durationMs: 1,
    }));
    const runtime = Object.assign({} as AgentRuntime, {
      providerId: "mock",
      model: "mock",
      run: runSpy,
    });

    await runEphemeralTurn({ runtime, prompt: "question one" });
    await runEphemeralTurn({ runtime, prompt: "question two" });

    expect(runSpy).toHaveBeenCalledTimes(2);
    const firstCallMsgs = runSpy.mock.calls[0]![0].messages;
    const secondCallMsgs = runSpy.mock.calls[1]![0].messages;
    expect(firstCallMsgs).toHaveLength(1);
    expect(secondCallMsgs).toHaveLength(1);
  });

  it("onYield 回调透传给调用方", async () => {
    const seen: AgentYield[] = [];
    const runtime = createMockAgentRuntime({
      yields: [{ type: "text_delta", text: "x" }],
    });
    await runEphemeralTurn({
      runtime,
      prompt: "p",
      onYield: (e) => seen.push(e),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: "text_delta", text: "x" });
  });

  // ─── PR-2 / remote-confirmation-execution.md §3.3：turnContext 透传 ───

  it("可选 turnContext 透传给 runtime.run（scheduler → ephemeral 路径）", async () => {
    const runSpy = vi.fn(async (_params: RunParams): Promise<RunResult> => ({
      agentResult: {
        reason: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      newMessages: [],
      durationMs: 1,
    }));
    const runtime = Object.assign({} as AgentRuntime, {
      providerId: "mock",
      model: "mock",
      run: runSpy,
    });

    await runEphemeralTurn({
      runtime,
      prompt: "task prompt",
      turnContext: {
        turnId: "turn_abc",
        turnOrigin: {
          channel: "scheduler",
          target: { channelId: "feishu", to: "ou_xyz" },
          triggeredBy: "task-42",
        },
      },
    });

    const received = runSpy.mock.calls[0]![0];
    expect(received.turnContext?.turnId).toBe("turn_abc");
    expect(received.turnContext?.turnOrigin).toEqual({
      channel: "scheduler",
      target: { channelId: "feishu", to: "ou_xyz" },
      triggeredBy: "task-42",
    });
  });

  it("无 turnContext 时 runtime.run 的 turnContext 为 undefined", async () => {
    const runSpy = vi.fn(async (_params: RunParams): Promise<RunResult> => ({
      agentResult: {
        reason: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      newMessages: [],
      durationMs: 1,
    }));
    const runtime = Object.assign({} as AgentRuntime, {
      providerId: "mock",
      model: "mock",
      run: runSpy,
    });

    await runEphemeralTurn({ runtime, prompt: "no origin" });

    expect(runSpy.mock.calls[0]![0].turnContext).toBeUndefined();
  });
});
