/**
 * ServerSession 适配器测试 — 用 mock AgentSession 验证 callback → AsyncGenerator 桥接
 */

import { describe, it, expect } from "vitest";
import { type AgentResult, type AgentYield, type Message } from "@zhixing/core";
import { createServerSessionAdapter } from "../session-adapter.js";
import type { AgentSession, RunParams, RunResult } from "../../run-agent.js";

// ─── Mock AgentSession ───

interface MockBehavior {
  /** 推送的 delta 事件 */
  yields?: AgentYield[];
  /** run() 抛出错误 */
  throwError?: string;
  /** 最终的 AgentResult.reason */
  reason?: AgentResult["reason"];
}

function createMockAgentSession(behavior: MockBehavior = {}): AgentSession {
  // 满足类型签名所需的最小骨架（其他属性测试不会触达）
  const stub = {} as AgentSession;
  return Object.assign(stub, {
    providerId: "mock",
    model: "mock-model",
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

describe("createServerSessionAdapter", () => {
  it("yields events from onYield callback then returns final result", async () => {
    const session = createServerSessionAdapter(
      "test-1",
      createMockAgentSession({
        yields: [
          { type: "text_delta", text: "hi" } as AgentYield,
          { type: "text_delta", text: " there" } as AgentYield,
        ],
      }),
    );

    const yields: AgentYield[] = [];
    const gen = session.run("hello");
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
    const session = createServerSessionAdapter("test-2", createMockAgentSession());
    const gen = session.run("hello");
    while (!(await gen.next()).done) {
      // consume
    }
    const history = session.getHistory();
    // 1 user (from adapter) + 1 assistant (from mock newMessages)
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe("user");
    expect(history[1]!.role).toBe("assistant");
  });

  it("propagates errors from agentSession.run via throw", async () => {
    const session = createServerSessionAdapter(
      "test-3",
      createMockAgentSession({ throwError: "boom" }),
    );

    const gen = session.run("hi");
    await expect(gen.next()).rejects.toThrow("boom");
  });

  it("multiple sequential runs accumulate history", async () => {
    const session = createServerSessionAdapter("test-4", createMockAgentSession());

    const gen1 = session.run("first");
    while (!(await gen1.next()).done) {
      /* consume */
    }
    const gen2 = session.run("second");
    while (!(await gen2.next()).done) {
      /* consume */
    }

    const history = session.getHistory();
    expect(history).toHaveLength(4); // 2 turns × 2 messages
  });

  it("dispose clears history", async () => {
    const session = createServerSessionAdapter("test-5", createMockAgentSession());
    const gen = session.run("x");
    while (!(await gen.next()).done) {
      /* consume */
    }
    expect(session.getHistory()).toHaveLength(2);

    session.dispose();
    expect(session.getHistory()).toHaveLength(0);
  });

  it("abort flag causes next run to throw immediately (then auto-resets)", async () => {
    const session = createServerSessionAdapter("test-6", createMockAgentSession());

    session.abort();

    const gen = session.run("after-abort");
    await expect(gen.next()).rejects.toThrow(/aborted/i);

    // 下一次 run 应该正常工作（abort 标志已重置）
    const gen2 = session.run("normal");
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

  it("getHistory respects limit parameter", async () => {
    const session = createServerSessionAdapter("test-7", createMockAgentSession());
    const gen1 = session.run("first");
    while (!(await gen1.next()).done) {
      /* consume */
    }
    const gen2 = session.run("second");
    while (!(await gen2.next()).done) {
      /* consume */
    }

    const last2 = session.getHistory(2);
    expect(last2).toHaveLength(2);
    // last 2 should be the second turn
    const lastUser = last2[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]!.text).toBe("second");
  });
});
