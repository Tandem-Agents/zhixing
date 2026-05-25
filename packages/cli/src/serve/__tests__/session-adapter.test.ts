/**
 * SessionRuntime 适配器测试 — 用 mock AgentRuntime 验证 callback → AsyncGenerator 桥接
 *
 * Mock 设计:cooperative 响应 abortSignal —— 真实 AgentLoop 在 abort 触发后通过
 * cleanup 路径返回 `AgentResult.aborted` with abortReason(.then 而非 throw),
 * 此 mock 同模式,避免测试和实现脱节。
 */

import { describe, it, expect } from "vitest";
import {
  ConfirmationBroker,
  getAbortReason,
  type AbortReason,
  type AgentResult,
  type AgentYield,
  type Message,
} from "@zhixing/core";
import type { SessionRuntime } from "@zhixing/server";
import { createServerRuntimeAdapter } from "../session-adapter.js";
import type { AgentRuntime, RunParams, RunResult } from "../../run-agent.js";

function commitNewMessages(runtime: SessionRuntime, newMessages: Message[]): void {
  runtime.updateMessages([...runtime.getHistory(), ...newMessages]);
}

interface MockBehavior {
  yields?: AgentYield[];
  throwError?: string;
  reason?: AgentResult["reason"];
  /** 模拟 LLM 流的延迟,让测试有空间在中途触发 abort */
  yieldDelayMs?: number;
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

      // pre-flight:已 aborted 的 signal 直接走 aborted 路径,模拟 agent-loop 行为
      if (params.abortSignal?.aborted) {
        const abortReason = getAbortReason(params.abortSignal) ?? undefined;
        return buildAbortedResult(params, abortReason);
      }

      const yields = behavior.yields ?? [
        { type: "text_delta", text: "hello" } as AgentYield,
      ];
      for (const y of yields) {
        if (params.abortSignal?.aborted) {
          const abortReason = getAbortReason(params.abortSignal) ?? undefined;
          return buildAbortedResult(params, abortReason);
        }
        params.onYield?.(y);
        if (behavior.yieldDelayMs && behavior.yieldDelayMs > 0) {
          await sleepWithAbort(behavior.yieldDelayMs, params.abortSignal);
          if (params.abortSignal?.aborted) {
            const abortReason = getAbortReason(params.abortSignal) ?? undefined;
            return buildAbortedResult(params, abortReason);
          }
        }
      }

      const reason = behavior.reason ?? "completed";
      return buildResultByReason(params, reason);
    },
  });
}

function buildAbortedResult(
  params: RunParams,
  abortReason: AbortReason | undefined,
): RunResult {
  return {
    agentResult: {
      reason: "aborted",
      abortReason,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    turn: {
      type: "turn",
      turnIndex: params.turnIndex,
      timestamp: new Date().toISOString(),
      userMessage:
        params.messages[params.messages.length - 1] ??
        ({ role: "user", content: [] } as Message),
      assistantMessage: { role: "assistant", content: [] } as Message,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    newMessages: [],
    durationMs: 1,
  };
}

function buildResultByReason(
  params: RunParams,
  reason: AgentResult["reason"],
): RunResult {
  const assistantMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  };
  const result: AgentResult =
    reason === "completed"
      ? {
          reason: "completed",
          message: assistantMsg,
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      : reason === "max_turns"
        ? { reason: "max_turns", maxTurns: 100, usage: { inputTokens: 1, outputTokens: 1 } }
        : reason === "aborted"
          ? { reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } }
          : {
              reason: "error",
              error: Object.assign(new Error("agent error"), { name: "AgentError" }) as unknown as AgentResult & { reason: "error" } extends infer T ? T extends { error: infer E } ? E : never : never,
              usage: { inputTokens: 0, outputTokens: 0 },
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
  };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

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
    // throw 路径 pop userMsg 防孤儿
    expect(runtime.getHistory()).toHaveLength(0);
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
    expect(history).toHaveLength(4);
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
    const lastUser = last2[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]!.text).toBe("second");
  });

  it("adapter 透传 AgentRuntime 的 confirmationBroker——远程确认链路依赖", () => {
    const agent = createMockAgentRuntime();
    const runtime = createServerRuntimeAdapter("test-broker", agent);
    expect(runtime.confirmationBroker).toBe(agent.confirmationBroker);
  });

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

      expect(runtime.getHistory()).toHaveLength(1);
      expect(runtime.getHistory()[0]!.role).toBe("user");
    });

    it("non-completed 后再次 run 不留下 orphan user 消息（跨 run 防护）", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-seq",
        createMockAgentRuntime({ reason: "error" }),
      );

      const gen1 = runtime.run("first");
      while (true) {
        const { done } = await gen1.next();
        if (done) break;
      }
      expect(runtime.getHistory()).toHaveLength(0);

      const gen2 = runtime.run("second");
      const { done } = await gen2.next();
      if (!done) {
        while (!(await gen2.next()).done) {/* drain */}
      }

      expect(runtime.getHistory()).toHaveLength(0);
    });
  });

  // ─── abort(reason?) 新行为:fire current controller / 单维度返 boolean ───

  describe("abort(reason?) 新行为", () => {
    it("无 in-flight 时 abort() 返 false(idle 是正常状态,不抛)", () => {
      const runtime = createServerRuntimeAdapter("test-no-flight", createMockAgentRuntime());
      expect(runtime.abort()).toBe(false);
    });

    it("无 in-flight 时 abort 不影响下一轮 run(controller 由 run 入口创建)", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-no-flight-then-run",
        createMockAgentRuntime(),
      );

      runtime.abort();

      const gen = runtime.run("normal");
      let runResult: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { runResult = value; break; }
      }
      expect(runResult?.agentResult.reason).toBe("completed");
    });

    it("in-flight abort:agent loop 通过 abortSignal 自然产 RunResult.aborted,history pop", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-inflight-abort",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "partial" } as AgentYield],
          yieldDelayMs: 200,
        }),
      );

      const gen = runtime.run("long task");

      // 拿到第一个 partial yield
      const first = await gen.next();
      expect(first.done).toBe(false);

      // 触发 abort
      const fired = runtime.abort();
      expect(fired).toBe(true);

      // mock 检测到 abortSignal,后续 .then 返回 aborted RunResult,consumer loop done
      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }
      expect(result?.agentResult.reason).toBe("aborted");

      // userMsg 已被 pop —— history 保持空
      expect(runtime.getHistory()).toHaveLength(0);
    });

    it("abort 携带 reason → 透传到 agent loop 的 abortSignal(无 parent 时不 wrap)", async () => {
      // 无 parent abortSignal:run 入口创建独立 controller,abort fire 后 reason
      // 直接是用户传入的 typed reason(无 parent-abort 包装)。
      // 真实 server 路径(RPC connection close → SessionAdapter outer)会有 parent
      // 因此 fork 一层,渲染层走 unwrapParentAbort 拿根因(详见 abort-formatter-zh)。
      const runtime = createServerRuntimeAdapter(
        "test-typed-reason",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const gen = runtime.run("task");
      await gen.next();

      runtime.abort({ kind: "user-cancel", source: "rpc", pressedAt: 12345 });

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }

      expect(result?.agentResult.reason).toBe("aborted");
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      expect(r.abortReason).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 12345,
      });
    });

    it("有 parent abortSignal:abort fire 后 reason 经 fork wrap 为 parent-abort", async () => {
      // 有 parent abortSignal:createInterruptController({ parent }) 走 forkController
      // 路径,SessionAdapter 自身的 abort(reason) 触发后,reason 直接是 typed reason
      // (因为 fire 的是 child 自己的 controller,不经过 parent 的 fork wrap)。
      // 但若 parent 自己 fire abort,fork listener 会把 parent reason wrap 成
      // parent-abort{ parentReason }。本测试覆盖 parent 触发 abort 的 wrap 行为。
      const runtime = createServerRuntimeAdapter(
        "test-parent-fork",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const parent = new AbortController();
      const gen = runtime.run("task", { abortSignal: parent.signal });
      await gen.next();

      // parent 触发 abort,带 typed reason
      const { abortWithReason } = await import("@zhixing/core");
      abortWithReason(parent, { kind: "user-cancel", source: "rpc", pressedAt: 99 });

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }

      expect(result?.agentResult.reason).toBe("aborted");
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      expect(r.abortReason?.kind).toBe("parent-abort");
      const wrapped = r.abortReason as Extract<AbortReason, { kind: "parent-abort" }>;
      expect(wrapped.parentReason).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 99,
      });
    });

    it("abort 缺省 reason → external{ origin: session-runtime-abort } 兜底", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-default-reason",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const gen = runtime.run("task");
      await gen.next();

      runtime.abort();

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      // 无 parent → reason 直接是 external 兜底
      expect(r.abortReason).toEqual({
        kind: "external",
        origin: "session-runtime-abort",
      });
    });

    it("幂等:多次 abort 仅第一次返 true,后续返 false 不覆盖原 reason", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-idempotent",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const gen = runtime.run("task");
      await gen.next();

      const first = runtime.abort({ kind: "user-cancel", source: "rpc", pressedAt: 1 });
      const second = runtime.abort({ kind: "user-cancel", source: "esc", pressedAt: 2 });
      const third = runtime.abort();

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(third).toBe(false);

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      // first-wins:保留 source: "rpc" pressedAt: 1(无 parent → 不 wrap)
      expect(r.abortReason).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 1,
      });
    });

    it("已 aborted 的 parent abortSignal:run 入口 controller 立即 aborted,agent pre-flight 返 aborted", async () => {
      const runtime = createServerRuntimeAdapter(
        "test-pre-aborted",
        createMockAgentRuntime(),
      );

      const ac = new AbortController();
      ac.abort();

      const gen = runtime.run("never runs", ac.signal);

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }

      expect(result?.agentResult.reason).toBe("aborted");
      // userMsg 已 pop
      expect(runtime.getHistory()).toHaveLength(0);
    });

    it("turn 完成后 abort 返 false(currentController 已被 finally 清空)", async () => {
      const runtime = createServerRuntimeAdapter("test-after-done", createMockAgentRuntime());

      const gen = runtime.run("ok");
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      expect(runtime.abort()).toBe(false);
    });
  });
});
