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
import type { SessionRuntime } from "@zhixing/server";
import { createServerRuntimeAdapter } from "../session-adapter.js";
import type { AgentRuntime, RunParams, RunResult } from "../../run-agent.js";

/**
 * 单一事实源模拟辅助：模拟 ConversationManager.recordTurn 后的 updateMessages 回喂。
 *
 * Phase 5 §0.7.5 契约：adapter.messages 由调用方通过 updateMessages(canonical) 整体替换，
 * adapter 内部不再自动 push newMessages。测试直接用 adapter 时需自行模拟这步。
 */
function commitNewMessages(runtime: SessionRuntime, newMessages: Message[]): void {
  runtime.updateMessages([...runtime.getHistory(), ...newMessages]);
}

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

      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      };
      const newMessages: Message[] =
        reason === "completed" ? [assistantMsg] : [];

      return {
        agentResult: result,
        turn: {
          type: "turn",
          turnIndex: params.turnIndex,
          timestamp: new Date().toISOString(),
          userMessage:
            params.messages[params.messages.length - 1] ??
            ({ role: "user", content: [] } as Message),
          assistantMessage:
            reason === "completed" ? assistantMsg : ({ role: "assistant", content: [] } as Message),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
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
        // Phase 5: return 值是 RunResult（非 AgentResult）
        expect(value.agentResult.reason).toBe("completed");
        break;
      }
      yields.push(value);
    }
    expect(yields).toHaveLength(2);
    expect((yields[0] as { text: string }).text).toBe("hi");
  });

  it("getHistory returns all messages including new ones from run（经 updateMessages 回喂）", async () => {
    const runtime = createServerRuntimeAdapter("test-2", createMockAgentRuntime());
    const gen = runtime.run("hello");
    let result: RunResult | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
    // Phase 5 契约：adapter 不再自动 push newMessages；调用方（ConversationManager）
    // 收到 RunResult 后应走 commitTurn + updateMessages(canonical)。此处模拟之。
    commitNewMessages(runtime, result!.newMessages);

    const history = runtime.getHistory();
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

  it("multiple sequential runs accumulate history（每轮经 updateMessages 回喂）", async () => {
    const runtime = createServerRuntimeAdapter("test-4", createMockAgentRuntime());

    const gen1 = runtime.run("first");
    let r1: RunResult | undefined;
    while (true) {
      const { value, done } = await gen1.next();
      if (done) { r1 = value; break; }
    }
    commitNewMessages(runtime, r1!.newMessages);

    const gen2 = runtime.run("second");
    let r2: RunResult | undefined;
    while (true) {
      const { value, done } = await gen2.next();
      if (done) { r2 = value; break; }
    }
    commitNewMessages(runtime, r2!.newMessages);

    const history = runtime.getHistory();
    expect(history).toHaveLength(4); // 2 turns × 2 messages
  });

  it("dispose clears history", async () => {
    const runtime = createServerRuntimeAdapter("test-5", createMockAgentRuntime());
    const gen = runtime.run("x");
    let result: RunResult | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
    commitNewMessages(runtime, result!.newMessages);
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
    let r1: RunResult | undefined;
    while (true) {
      const { value, done } = await gen1.next();
      if (done) { r1 = value; break; }
    }
    commitNewMessages(runtime, r1!.newMessages);

    const gen2 = runtime.run("second");
    let r2: RunResult | undefined;
    while (true) {
      const { value, done } = await gen2.next();
      if (done) { r2 = value; break; }
    }
    commitNewMessages(runtime, r2!.newMessages);

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

  // ─── Phase 5 Bug A 回归守卫：non-completed 自动 pop userMsg ───
  //
  // agent-loop 返回 reason ∈ {error, max_turns, aborted} 时，caller 按约定不调
  // recordTurn → updateMessages 不会执行 → adapter.messages 不应留下 orphan userMsg。
  // adapter 内部自修：done 分支非 completed 主动 pop 入口 push 的 userMsg。
  //
  // 和 "abortSignal 触发 throw 路径" 的 pop 是两条独立路径 —— 这里覆盖 agent-loop
  // 内部 return non-completed 的场景（产生 done 队列项而非 error 队列项）。

  describe("non-completed 路径自修", () => {
    it("reason=error：return runResult 前 pop userMsg，history 保持空", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-err",
        createMockAgentRuntime({ reason: "error" }),
      );

      const gen = runtime.run("q");
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      // adapter 自修：messages 回到 run 前的空状态
      expect(runtime.getHistory()).toHaveLength(0);
    });

    it("reason=max_turns：同样 pop userMsg", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-max",
        createMockAgentRuntime({ reason: "max_turns" }),
      );

      const gen = runtime.run("q");
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      expect(runtime.getHistory()).toHaveLength(0);
    });

    it("reason=aborted（agent-loop 内部 abort，非 abortSignal）：同样 pop userMsg", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-abrt",
        createMockAgentRuntime({ reason: "aborted" }),
      );

      const gen = runtime.run("q");
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      expect(runtime.getHistory()).toHaveLength(0);
    });

    it("reason=completed：保留 userMsg 等 caller updateMessages（回归不变）", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-ok",
        createMockAgentRuntime({ reason: "completed" }),
      );

      const gen = runtime.run("q");
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      // completed 路径：userMsg 保留 —— caller 会 updateMessages(canonical) 覆盖
      expect(runtime.getHistory()).toHaveLength(1);
      expect(runtime.getHistory()[0]!.role).toBe("user");
    });

    it("non-completed 后再次 run 不留下 orphan user 消息（跨 run 防护）", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-seq",
        createMockAgentRuntime({ reason: "error" }),
      );

      // 第一轮 run 失败
      const gen1 = runtime.run("first");
      while (true) {
        const { done } = await gen1.next();
        if (done) break;
      }
      expect(runtime.getHistory()).toHaveLength(0);

      // 第二轮 run：messages 入口 push 后只应有 1 条 user（没 orphan）
      const gen2 = runtime.run("second");
      const { done } = await gen2.next();
      if (!done) {
        // 消费完剩余 yield
        while (!(await gen2.next()).done) {/* drain */}
      }

      // 第二轮也失败 → 又 pop → messages 回空
      expect(runtime.getHistory()).toHaveLength(0);
    });
  });
});
