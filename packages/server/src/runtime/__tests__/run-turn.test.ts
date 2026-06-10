/**
 * runTurnWithCommit 测试 —— 运行 + 提交编排的路径守卫。
 *
 * 状态模型：run 输入瞬态构造、内部状态只经 acceptRun（接受协议）前进——
 * 所有失败路径内存自然停在 run 前基底，无回滚动作可言。
 *
 * 覆盖 5 条路径：
 *   1. completed + recordTurn 成功 → 窗口前进一个蒸馏对（正常路径）
 *   2. completed + recordTurn throw → 窗口不前进 + onCommitFailure 通知
 *   3. non-completed（error / max_turns / aborted）→ 不调 recordTurn，窗口不前进
 *   4. runtime throw → 窗口不前进 + rethrow
 *   5. yield forward → caller 能消费每个 AgentYield
 */

import { describe, it, expect, vi } from "vitest";
import type {
  AgentYield,
  Message,
  RunRecordInput,
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
  const messages: Message[] = [];

  return {
    sessionId,
    async *run(text): AsyncGenerator<AgentYield, RunResult> {
      if (behavior.throwError) {
        throw new Error(behavior.throwError);
      }

      // 新协议：run 输入瞬态构造，内部状态不在 run 中变更
      const userMsg: Message = {
        role: "user",
        content: [{ type: "text", text: typeof text === "string" ? text : "" }],
      };

      for (const y of behavior.yields ?? []) {
        yield y;
      }

      const reason = behavior.reason ?? "completed";
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: `echo: ${text}` }],
      };

      const usage = { inputTokens: 0, outputTokens: 0 };
      const record = (msgs: Message[]): RunRecordInput => ({
        timestamp: new Date().toISOString(),
        messages: msgs,
        usage,
      });

      if (reason === "completed") {
        return {
          agentResult: { reason: "completed", message: assistantMsg, usage },
          runRecord: record([userMsg, assistantMsg]),
          newMessages: [assistantMsg],
          durationMs: 0,
        };
      }

      if (reason === "error") {
        return {
          agentResult: {
            reason: "error",
            error: Object.assign(new Error("boom"), { name: "AgentError" }),
            usage,
          } as RunResult["agentResult"],
          runRecord: record([userMsg]),
          newMessages: [],
          durationMs: 0,
        };
      }

      if (reason === "max_turns") {
        return {
          agentResult: { reason: "max_turns", usage },
          runRecord: record([userMsg]),
          newMessages: [],
          durationMs: 0,
        };
      }

      // aborted
      return {
        agentResult: { reason: "aborted", usage },
        runRecord: record([userMsg]),
        newMessages: [],
        durationMs: 0,
      };
    },
    getHistory(limit) {
      return limit ? messages.slice(-limit) : [...messages];
    },
    acceptRun(input) {
      // 接受协议的窗口侧最小模拟：追加 [首条, 末条] 蒸馏对
      messages.push(
        input.runMessages[0]!,
        input.runMessages[input.runMessages.length - 1]!,
      );
      return {};
    },
    abort(): boolean { return false; },
    async dispose() {
      messages.length = 0;
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

/** appendRun 成功 stub —— 返回 store 分配的 runIndex（自增） */
function appendRunOk() {
  let next = 0;
  return vi.fn(async () => ({ runIndex: next++, shardId: "000001" }));
}

// ─── Tests ───

describe("runTurnWithCommit", () => {
  const config = {
    graceTimeoutMs: 60_000,
    idleTimeoutMs: 30 * 60_000,
    idleCheckIntervalMs: 999_999,
  };

  it("[路径 1] completed + recordTurn 成功 → 窗口前进一个蒸馏对", async () => {
    const mgr = new ConversationManager(createFactory(), config, {
      appendRun: appendRunOk(),
    });

    await mgr.getOrCreate("c1");
    const gen = runTurnWithCommit(mgr, "c1", "hello");
    let runResult: RunResult | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) { runResult = value; break; }
    }

    expect(runResult!.agentResult.reason).toBe("completed");
    // 持久化成功 → recordTurn 经 acceptRun 推进窗口：本轮 [user, assistant] 配对
    expect(mgr.get("c1")!.getHistory()).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "echo: hello" }] },
    ]);
    mgr.disposeAll();
  });

  it("[路径 2] completed + recordTurn throw → 窗口不前进 + onCommitFailure 通知", async () => {
    const mgr = new ConversationManager(createFactory(), config, {
      appendRun: async () => {
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

    // 持久化失败 → runResult 仍 return completed
    expect(runResult!.agentResult.reason).toBe("completed");
    // 窗口停在 run 前基底（空）
    expect(mgr.get("c2")!.getHistory()).toEqual(preRun);
    // onCommitFailure 被调用
    expect(onCommitFailure).toHaveBeenCalledTimes(1);
    expect(onCommitFailure.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onCommitFailure.mock.calls[0]![0] as Error).message).toBe("disk full");
    expect(onCommitFailure.mock.calls[0]![1].agentResult.reason).toBe("completed");

    mgr.disposeAll();
  });

  it("[路径 3a] non-completed reason=error → 不调 recordTurn，窗口不前进", async () => {
    const appendRun = appendRunOk();
    const mgr = new ConversationManager(createFactory({ reason: "error" }), config, {
      appendRun,
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
    expect(appendRun).not.toHaveBeenCalled();    // 非 completed 不持久化
    expect(mgr.get("c3")!.getHistory()).toEqual(preRun);  // 窗口停在原基底

    mgr.disposeAll();
  });

  it("[路径 3b] non-completed reason=max_turns → 同样不前进", async () => {
    const appendRun = appendRunOk();
    const mgr = new ConversationManager(createFactory({ reason: "max_turns" }), config, {
      appendRun,
    });

    await mgr.getOrCreate("c4");
    const gen = runTurnWithCommit(mgr, "c4", "hi");
    while (true) {
      const { done } = await gen.next();
      if (done) break;
    }

    expect(appendRun).not.toHaveBeenCalled();
    expect(mgr.get("c4")!.getHistory()).toEqual([]);

    mgr.disposeAll();
  });

  it("[路径 4] runtime throw → 窗口不前进 + rethrow", async () => {
    const appendRun = appendRunOk();
    const mgr = new ConversationManager(
      createFactory({ throwError: "provider timeout" }),
      config,
      { appendRun },
    );

    await mgr.getOrCreate("c5");
    const preRun = mgr.get("c5")!.getHistory();

    const gen = runTurnWithCommit(mgr, "c5", "hi");
    await expect(gen.next()).rejects.toThrow("provider timeout");

    expect(appendRun).not.toHaveBeenCalled();   // throw 前未到 commit
    expect(mgr.get("c5")!.getHistory()).toEqual(preRun);  // 窗口停在原基底

    mgr.disposeAll();
  });

  it("[路径 5] yield events 透传给 caller", async () => {
    const yields: AgentYield[] = [
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
    ];

    const mgr = new ConversationManager(createFactory({ yields }), config, {
      appendRun: appendRunOk(),
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
      appendRun: appendRunOk(),
    });

    const gen = runTurnWithCommit(mgr, "nonexistent", "hi");
    await expect(gen.next()).rejects.toThrow(/session nonexistent not found/i);

    mgr.disposeAll();
  });

  it("[跨轮防护] non-completed 后内存停在原基底，不产生孤儿 userMsg", async () => {
    // error → 窗口不前进，本轮 userMsg 不残留为孤儿
    const mgr = new ConversationManager(createFactory({ reason: "error" }), config, {
      appendRun: appendRunOk(),
    });

    await mgr.getOrCreate("c7");

    // Run 1 (error) → 窗口不前进
    const gen1 = runTurnWithCommit(mgr, "c7", "first");
    while (true) {
      const { done } = await gen1.next();
      if (done) break;
    }
    expect(mgr.get("c7")!.getHistory()).toEqual([]); // 原基底（空）

    mgr.disposeAll();
  });
});
