/**
 * SessionRuntime 适配器测试 — 用 mock AgentRuntime 验证 callback → AsyncGenerator 桥接
 */

import { describe, it, expect } from "vitest";
import {
  ConfirmationBroker,
  type AgentResult,
  type AgentYield,
  type Message,
} from "@zhixing/core";
import { createServerRuntimeAdapter } from "../session-adapter.js";
import type { AgentRuntime, RunParams, RunResult } from "../../run-agent.js";

// ─── Mock AgentRuntime ───

interface MockBehavior {
  /** 推送的 delta 事件 */
  yields?: AgentYield[];
  /** run() 抛出错误 */
  throwError?: string;
  /** 最终的 AgentResult.reason */
  reason?: AgentResult["reason"];
}

function createMockAgentRuntime(behavior: MockBehavior = {}): AgentRuntime {
  const stub = {} as AgentRuntime;
  const broker = new ConfirmationBroker();
  return Object.assign(stub, {
    providerId: "mock",
    model: "mock-model",
    confirmationBroker: broker,
    async run(params: RunParams): Promise<RunResult> {
      if (behavior.throwError) {
        throw new Error(behavior.throwError);
      }
      const yields = behavior.yields ?? [
        { type: "text_delta", text: "hello" } as AgentYield,
      ];
      for (const y of yields) {
        params.onYield?.(y);
      }
      const reason = behavior.reason ?? "completed";
      const result: AgentResult =
        reason === "completed"
          ? {
              reason: "completed",
              message: { role: "assistant", content: [{ type: "text", text: "done" }] },
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          : reason === "max_turns"
            ? { reason: "max_turns", usage: { inputTokens: 1, outputTokens: 1 } }
            : reason === "aborted"
              ? { reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } }
              : {
                  reason: "error",
                  error: Object.assign(new Error("agent error"), { name: "AgentError" }) as unknown as AgentResult & { reason: "error" } extends infer T ? T extends { error: infer E } ? E : never : never,
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
        toolEndCount: 0,
        injectedSkillIds: [],
      };
    },
  });
}

// ─── Tests ───

describe("createServerRuntimeAdapter", () => {
  it("yields events from onYield callback then returns final result", async () => {
    const runtime = createServerRuntimeAdapter(
      "test-1",
      createMockAgentRuntime({
        yields: [
          { type: "text_delta", text: "hi" } as AgentYield,
          { type: "text_delta", text: " there" } as AgentYield,
        ],
      }),
    );

    const yields: AgentYield[] = [];
    const gen = runtime.run("hello");
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        expect(value.reason).toBe("completed");
        break;
      }
      yields.push(value);
    }
    expect(yields).toHaveLength(2);
    expect((yields[0] as { text: string }).text).toBe("hi");
  });

  it("getHistory returns all messages including new ones from run", async () => {
    const runtime = createServerRuntimeAdapter("test-2", createMockAgentRuntime());
    const gen = runtime.run("hello");
    while (!(await gen.next()).done) {
      // consume
    }
    const history = runtime.getHistory();
    // 1 user (from adapter) + 1 assistant (from mock newMessages)
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe("user");
    expect(history[1]!.role).toBe("assistant");
  });

  it("propagates errors from agentRuntime.run via throw", async () => {
    const runtime = createServerRuntimeAdapter(
      "test-3",
      createMockAgentRuntime({ throwError: "boom" }),
    );

    const gen = runtime.run("hi");
    await expect(gen.next()).rejects.toThrow("boom");
  });

  it("multiple sequential runs accumulate history", async () => {
    const runtime = createServerRuntimeAdapter("test-4", createMockAgentRuntime());

    const gen1 = runtime.run("first");
    while (!(await gen1.next()).done) {
      /* consume */
    }
    const gen2 = runtime.run("second");
    while (!(await gen2.next()).done) {
      /* consume */
    }

    const history = runtime.getHistory();
    expect(history).toHaveLength(4); // 2 turns × 2 messages
  });

  it("dispose clears history", async () => {
    const runtime = createServerRuntimeAdapter("test-5", createMockAgentRuntime());
    const gen = runtime.run("x");
    while (!(await gen.next()).done) {
      /* consume */
    }
    expect(runtime.getHistory()).toHaveLength(2);

    runtime.dispose();
    expect(runtime.getHistory()).toHaveLength(0);
  });

  it("abort flag causes next run to throw immediately (then auto-resets)", async () => {
    const runtime = createServerRuntimeAdapter("test-6", createMockAgentRuntime());

    runtime.abort();

    const gen = runtime.run("after-abort");
    await expect(gen.next()).rejects.toThrow(/aborted/i);

    // 下一次 run 应该正常工作（abort 标志已重置）
    const gen2 = runtime.run("normal");
    let completed = false;
    while (true) {
      const { done } = await gen2.next();
      if (done) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
  });

  it("abortSignal stops generator immediately and reverts user message", async () => {
    const slowRuntime = createMockAgentRuntime();
    const originalRun = slowRuntime.run.bind(slowRuntime);
    slowRuntime.run = async (params: RunParams) => {
      // Simulate slow LLM: yield one event, then wait before completing
      params.onYield?.({ type: "text_delta", text: "partial" } as AgentYield);
      await new Promise((r) => setTimeout(r, 500));
      return originalRun(params);
    };

    const runtime = createServerRuntimeAdapter("test-abort-signal", slowRuntime);

    const abortController = new AbortController();
    const gen = runtime.run("should abort", abortController.signal);

    // Read the first yield
    const first = await gen.next();
    expect(first.done).toBe(false);

    // Abort mid-stream
    abortController.abort();

    // Next read should throw
    await expect(gen.next()).rejects.toThrow(/abort/i);

    // User message should be reverted — history stays empty
    expect(runtime.getHistory()).toHaveLength(0);
  });

  it("already-aborted signal throws immediately without modifying history", async () => {
    const runtime = createServerRuntimeAdapter("test-pre-abort", createMockAgentRuntime());

    const abortController = new AbortController();
    abortController.abort();

    const gen = runtime.run("never runs", abortController.signal);
    await expect(gen.next()).rejects.toThrow(/abort/i);

    expect(runtime.getHistory()).toHaveLength(0);
  });

  it("getHistory respects limit parameter", async () => {
    const runtime = createServerRuntimeAdapter("test-7", createMockAgentRuntime());
    const gen1 = runtime.run("first");
    while (!(await gen1.next()).done) {
      /* consume */
    }
    const gen2 = runtime.run("second");
    while (!(await gen2.next()).done) {
      /* consume */
    }

    const last2 = runtime.getHistory(2);
    expect(last2).toHaveLength(2);
    // last 2 should be the second turn
    const lastUser = last2[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]!.text).toBe("second");
  });

  // ─── Fix-1：remote-confirmation 链路完整性回归守卫 ───

  it("adapter 透传 AgentRuntime 的 confirmationBroker——远程确认链路依赖", () => {
    const agent = createMockAgentRuntime();
    const runtime = createServerRuntimeAdapter("test-broker", agent);

    // broker 必须是同一个引用——adapter 不包装、不复制 broker 身份
    expect(runtime.confirmationBroker).toBe(agent.confirmationBroker);
  });
});
