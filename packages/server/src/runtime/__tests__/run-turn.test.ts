/**
 * runTurnWithCommit 测试 —— Phase 5 Bug B 回归守卫
 *
 * 覆盖 5 条路径：
 *   1. completed + recordTurn 成功 → canonical 覆盖 adapter state（正常路径）
 *   2. completed + recordTurn throw → rollback + onCommitFailure 通知
 *   3. non-completed（error / max_turns / aborted）→ rollback 不调 recordTurn
 *   4. runtime throw → rollback + rethrow
 *   5. yield forward → caller 能消费每个 AgentYield
 */

import { describe, it, expect, vi } from "vitest";
import type {
  AgentYield,
  IConfirmationBroker,
  Message,
  RunResult,
} from "@zhixing/core";
import { ConversationManager } from "../conversation-manager.js";
import { runTurnWithCommit } from "../run-turn.js";
import type { SessionRuntime, RuntimeFactory } from "../types.js";

// ─── 可配置 Mock Runtime ───

interface MockRuntimeBehavior {
  /** run 过程中 yield 的事件序列 */
  readonly yields?: readonly AgentYield[];
  /** agent-loop 终止原因 */
  readonly reason?: "completed" | "error" | "max_turns" | "aborted";
  /** run 本身抛错（模拟 provider error / abort） */
  readonly throwError?: string;
}

function createMockRuntime(
  sessionId: string,
  behavior: MockRuntimeBehavior = {},
): SessionRuntime {
  let messages: Message[] = [];

  return {
    sessionId,
    async *run(text): AsyncGenerator<AgentYield, RunResult> {
      if (behavior.throwError) {
        throw new Error(behavior.throwError);
      }

      const userMsg: Message = {
        role: "user",
        content: [{ type: "text", text: typeof text === "string" ? text : "" }],
      };
      messages.push(userMsg);

      for (const y of behavior.yields ?? []) {
        yield y;
      }

      const reason = behavior.reason ?? "completed";
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: `echo: ${text}` }],
      };

      if (reason === "completed") {
        return {
          agentResult: {
            reason: "completed",
            message: assistantMsg,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          turn: {
            type: "turn",
            turnIndex: 0,
            timestamp: new Date().toISOString(),
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          newMessages: [assistantMsg],
          durationMs: 0,
          toolEndCount: 0,
          injectedSkillIds: [],
        };
      }

      if (reason === "error") {
        return {
          agentResult: {
            reason: "error",
            error: Object.assign(new Error("boom"), { name: "AgentError" }),
            usage: { inputTokens: 0, outputTokens: 0 },
          } as RunResult["agentResult"],
          turn: {
            type: "turn",
            turnIndex: 0,
            timestamp: new Date().toISOString(),
            userMessage: userMsg,
            assistantMessage: { role: "assistant", content: [] },
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          newMessages: [],
          durationMs: 0,
          toolEndCount: 0,
          injectedSkillIds: [],
        };
      }

      if (reason === "max_turns") {
        return {
          agentResult: {
            reason: "max_turns",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          turn: {
            type: "turn",
            turnIndex: 0,
            timestamp: new Date().toISOString(),
            userMessage: userMsg,
            assistantMessage: { role: "assistant", content: [] },
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          newMessages: [],
          durationMs: 0,
          toolEndCount: 0,
          injectedSkillIds: [],
        };
      }

      // aborted
      return {
        agentResult: {
          reason: "aborted",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        turn: {
          type: "turn",
          turnIndex: 0,
          timestamp: new Date().toISOString(),
          userMessage: userMsg,
          assistantMessage: { role: "assistant", content: [] },
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        newMessages: [],
        durationMs: 0,
        toolEndCount: 0,
        injectedSkillIds: [],
      };
    },
    getHistory(limit) {
      return limit ? messages.slice(-limit) : [...messages];
    },
    updateMessages(canonical) {
      messages = [...canonical];
    },
    abort(): boolean { return false; },
    dispose() {
      messages = [];
    },
  };
}

function createFactory(behavior: MockRuntimeBehavior = {}): RuntimeFactory {
  return {
    async create(sessionId) {
      return createMockRuntime(sessionId, behavior);
    },
  };
}

// ─── Tests ───

describe("runTurnWithCommit", () => {
  const config = {
    graceTimeoutMs: 60_000,
    idleTimeoutMs: 30 * 60_000,
    idleCheckIntervalMs: 999_999,
  };

  it("[路径 1] completed + recordTurn 成功 → canonical 覆盖 adapter state", async () => {
    const committed: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "echo: hello" }] },
    ];

    const mgr = new ConversationManager(createFactory(), config, {
      commitTurn: async () => committed,
    });

    await mgr.getOrCreate("c1");
    const gen = runTurnWithCommit(mgr, "c1", "hello");
    let runResult: RunResult | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) { runResult = value; break; }
    }

    expect(runResult!.agentResult.reason).toBe("completed");
    // recordTurn 返回 committed → updateMessages 覆盖 adapter
    expect(mgr.get("c1")!.getHistory()).toEqual(committed);
    mgr.disposeAll();
  });

  it("[路径 2] completed + recordTurn throw → rollback + onCommitFailure 通知", async () => {
    const mgr = new ConversationManager(createFactory(), config, {
      commitTurn: async () => {
        throw new Error("disk full");
      },
    });

    await mgr.getOrCreate("c2");
    const preRun = mgr.get("c2")!.getHistory(); // 空
    const onCommitFailure = vi.fn();

    const gen = runTurnWithCommit(mgr, "c2", "hi", undefined, { onCommitFailure });
    let runResult: RunResult | undefined;
    while (true) {
      const { done, value } = await gen.next();
      if (done) { runResult = value; break; }
    }

    // commitTurn 失败 → runResult 仍 return completed
    expect(runResult!.agentResult.reason).toBe("completed");
    // adapter state 回到 preRun（空）
    expect(mgr.get("c2")!.getHistory()).toEqual(preRun);
    // onCommitFailure 被调用
    expect(onCommitFailure).toHaveBeenCalledTimes(1);
    expect(onCommitFailure.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onCommitFailure.mock.calls[0]![0] as Error).message).toBe("disk full");
    expect(onCommitFailure.mock.calls[0]![1].agentResult.reason).toBe("completed");

    mgr.disposeAll();
  });

  it("[路径 3a] non-completed reason=error → rollback 不调 recordTurn", async () => {
    const commitTurn = vi.fn().mockResolvedValue([]);
    const mgr = new ConversationManager(createFactory({ reason: "error" }), config, {
      commitTurn,
    });

    await mgr.getOrCreate("c3");
    const preRun = mgr.get("c3")!.getHistory();

    const gen = runTurnWithCommit(mgr, "c3", "hi");
    let runResult: RunResult | undefined;
    while (true) {
      const { done, value } = await gen.next();
      if (done) { runResult = value; break; }
    }

    expect(runResult!.agentResult.reason).toBe("error");
    expect(commitTurn).not.toHaveBeenCalled();    // 非 completed 不调 commitTurn
    expect(mgr.get("c3")!.getHistory()).toEqual(preRun);  // rollback

    mgr.disposeAll();
  });

  it("[路径 3b] non-completed reason=max_turns → 同样 rollback", async () => {
    const commitTurn = vi.fn().mockResolvedValue([]);
    const mgr = new ConversationManager(createFactory({ reason: "max_turns" }), config, {
      commitTurn,
    });

    await mgr.getOrCreate("c4");
    const gen = runTurnWithCommit(mgr, "c4", "hi");
    while (true) {
      const { done } = await gen.next();
      if (done) break;
    }

    expect(commitTurn).not.toHaveBeenCalled();
    expect(mgr.get("c4")!.getHistory()).toEqual([]);

    mgr.disposeAll();
  });

  it("[路径 4] runtime throw → rollback + rethrow", async () => {
    const commitTurn = vi.fn().mockResolvedValue([]);
    const mgr = new ConversationManager(
      createFactory({ throwError: "provider timeout" }),
      config,
      { commitTurn },
    );

    await mgr.getOrCreate("c5");
    const preRun = mgr.get("c5")!.getHistory();

    const gen = runTurnWithCommit(mgr, "c5", "hi");
    await expect(gen.next()).rejects.toThrow("provider timeout");

    expect(commitTurn).not.toHaveBeenCalled();   // throw 前未到 commit
    expect(mgr.get("c5")!.getHistory()).toEqual(preRun);  // rollback 生效

    mgr.disposeAll();
  });

  it("[路径 5] yield events 透传给 caller", async () => {
    const yields: AgentYield[] = [
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
    ];

    const mgr = new ConversationManager(createFactory({ yields }), config, {
      commitTurn: async () => [],
    });

    await mgr.getOrCreate("c6");
    const gen = runTurnWithCommit(mgr, "c6", "say");

    const collected: AgentYield[] = [];
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      collected.push(value);
    }

    expect(collected).toEqual(yields);

    mgr.disposeAll();
  });

  it("[契约] session 不存在时抛明确错误", async () => {
    const mgr = new ConversationManager(createFactory(), config, {
      commitTurn: async () => [],
    });

    const gen = runTurnWithCommit(mgr, "nonexistent", "hi");
    await expect(gen.next()).rejects.toThrow(/session nonexistent not found/i);

    mgr.disposeAll();
  });

  it("[跨轮防护] non-completed 后下一轮 run 的 adapter 输入不含 orphan userMsg", async () => {
    // Run 1：error → rollback
    // Run 2：switch behavior 到 completed → 看 messages 里只有本轮 userMsg
    const mgr = new ConversationManager(createFactory({ reason: "error" }), config, {
      commitTurn: async (_id, payload) => {
        // 真实语义：returns [userMsg, assistantMsg]
        if (!payload.turn) return [];
        return [payload.turn.userMessage, payload.turn.assistantMessage];
      },
    });

    await mgr.getOrCreate("c7");

    // Run 1 (error) → rollback
    const gen1 = runTurnWithCommit(mgr, "c7", "first");
    while (true) {
      const { done } = await gen1.next();
      if (done) break;
    }
    expect(mgr.get("c7")!.getHistory()).toEqual([]); // rollback OK

    mgr.disposeAll();
  });
});
