import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ConfirmationBroker,
  type AgentYield,
  type IConfirmationBroker,
  type Message,
  type RunResult,
} from "@zhixing/core";
import { ConversationManager } from "../conversation-manager.js";
import { ConfirmationHub } from "../../confirmation/hub.js";
import type { SessionRuntime, RuntimeFactory } from "../types.js";

// ─── Mock Runtime ───

function createMockRuntime(sessionId: string): SessionRuntime {
  let messages: Message[] = [];
  let aborted = false;

  return {
    sessionId,
    async *run(text): AsyncGenerator<AgentYield, RunResult> {
      const userMsg: Message = {
        role: "user",
        content: [{ type: "text", text: typeof text === "string" ? text : "" }],
      };
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text: `echo: ${text}` }],
      };
      // 新协议：run 输入瞬态构造，内部状态只经 acceptRun 前进
      yield { type: "text_delta", text: `echo: ${text}` };
      return {
        agentResult: {
          reason: "completed",
          message: assistantMsg,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        runRecord: {
          timestamp: new Date().toISOString(),
          messages: [userMsg, assistantMsg],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        newMessages: [assistantMsg],
        durationMs: 0,
      };
    },
    getHistory(limit) {
      return limit ? messages.slice(-limit) : messages;
    },
    acceptRun(input) {
      // 接受协议的窗口侧最小模拟：追加 [首条, 末条] 蒸馏对
      messages.push(
        input.runMessages[0]!,
        input.runMessages[input.runMessages.length - 1]!,
      );
    },
    abort(): boolean {
      aborted = true;
      return true;
    },
    dispose() {
      messages.length = 0;
    },
    get _aborted() {
      return aborted;
    },
  } as SessionRuntime & { _aborted: boolean };
}

function createMockFactory(): RuntimeFactory {
  return {
    async create(sessionId) {
      return createMockRuntime(sessionId);
    },
  };
}

// ─── Tests ───

describe("ConversationManager", () => {
  let manager: ConversationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ConversationManager(createMockFactory(), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    await manager.disposeAll();
    vi.useRealTimers();
  });

  // ─── 基本生命周期（与 RuntimeRegistry 兼容） ───

  describe("basic lifecycle", () => {
    it("creates a new session when no id provided", async () => {
      const session = await manager.getOrCreate();
      expect(session.conversationId).toMatch(/^conv_/);
      expect(manager.list()).toHaveLength(1);
    });

    it("returns existing session when id matches", async () => {
      const s1 = await manager.getOrCreate("test-conv");
      const s2 = await manager.getOrCreate("test-conv");
      expect(s1).toBe(s2);
      expect(manager.list()).toHaveLength(1);
    });

    it("concurrent getOrCreate with same id creates only one runtime", async () => {
      let createCount = 0;
      const slowFactory: RuntimeFactory = {
        async create(sessionId) {
          createCount++;
          await new Promise((r) => setTimeout(r, 10));
          return createMockRuntime(sessionId);
        },
      };
      const mgr = new ConversationManager(slowFactory, {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      });

      const p = Promise.all([
        mgr.getOrCreate("race"),
        mgr.getOrCreate("race"),
      ]);
      await vi.advanceTimersByTimeAsync(20);
      const [s1, s2] = await p;

      expect(s1).toBe(s2);
      expect(createCount).toBe(1);
      expect(mgr.list()).toHaveLength(1);
      await mgr.disposeAll();
    });

    it("calls initTranscript for new conversations (no history)", async () => {
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        initTranscript: async (id) => { inited.push(id); },
        appendRun: async () => ({ runIndex: 0, shardId: "000001" }), // 配置守卫：有持久化意图必须带 appendRun
      });

      await mgr.getOrCreate("new-conv");
      expect(inited).toEqual(["new-conv"]);
      await mgr.disposeAll();
    });

    it("does NOT call initTranscript when loadHistory returns messages", async () => {
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        loadHistory: async () => [
          {
            type: "run" as const,
            runIndex: 0,
            timestamp: new Date().toISOString(),
            messages: [
              { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
              { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
            ],
          },
        ],
        initTranscript: async (id) => { inited.push(id); },
        appendRun: async () => ({ runIndex: 0, shardId: "000001" }), // 配置守卫：有持久化意图必须带 appendRun
      });

      const session = await mgr.getOrCreate("existing");
      expect(inited).toEqual([]);
      expect(session.turnCount).toBe(1);
      await mgr.disposeAll();
    });

    it("initializes turnCount from loaded history", async () => {
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        loadHistory: async () => [1, 2].map((i) => ({
          type: "run" as const,
          runIndex: i - 1,
          timestamp: new Date().toISOString(),
          messages: [
            { role: "user" as const, content: [{ type: "text" as const, text: `q${i}` }] },
            { role: "assistant" as const, content: [{ type: "text" as const, text: `a${i}` }] },
          ],
        })),
        appendRun: async () => ({ runIndex: 0, shardId: "000001" }), // 配置守卫：有持久化意图必须带 appendRun
      });

      const session = await mgr.getOrCreate("restored");
      expect(session.turnCount).toBe(2);
      await mgr.disposeAll();
    });

    it("creates session with specified id when not present", async () => {
      const session = await manager.getOrCreate("my-conversation");
      expect(session.conversationId).toBe("my-conversation");
      expect(session.runtime.sessionId).toBe("my-conversation");
    });

    it("list() returns metadata for all sessions", async () => {
      await manager.getOrCreate("a");
      await manager.getOrCreate("b");
      const list = manager.list();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.conversationId).sort()).toEqual(["a", "b"]);
      for (const info of list) {
        expect(info.busy).toBe(false);
        expect(info.messageCount).toBe(0);
        expect(info.observerCount).toBe(0);
      }
    });

    it("list() includes sessionId for backward compat", async () => {
      await manager.getOrCreate("a");
      const list = manager.list();
      expect(list[0]!.sessionId).toBe("a");
    });

    it("setBusy reflects in list()", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);
      expect(manager.list()[0]!.busy).toBe(true);
      manager.setBusy("a", false);
      expect(manager.list()[0]!.busy).toBe(false);
    });

    it("get() returns the raw SessionRuntime", async () => {
      const session = await manager.getOrCreate("a");
      expect(manager.get("a")).toBe(session.runtime);
    });

    it("getSession() returns the ManagedSession", async () => {
      const session = await manager.getOrCreate("a");
      expect(manager.getSession("a")).toBe(session);
    });

    it("has() checks existence", async () => {
      expect(manager.has("a")).toBe(false);
      await manager.getOrCreate("a");
      expect(manager.has("a")).toBe(true);
    });

    it("abort() invokes runtime.abort() 并返双维度 AbortResult", async () => {
      const session = await manager.getOrCreate("a");
      const result = manager.abort("a");
      expect(result).toEqual({ abortedInFlight: true, cancelledPending: 0 });
      expect((session.runtime as SessionRuntime & { _aborted: boolean })._aborted).toBe(true);
    });

    it("abort() 不存在的 conversation → 双零(不抛)", () => {
      expect(manager.abort("nope")).toEqual({
        abortedInFlight: false,
        cancelledPending: 0,
      });
    });

    it("delete() removes session and disposes runtime", async () => {
      await manager.getOrCreate("a");
      expect(await manager.delete("a")).toBe(true);
      expect(manager.has("a")).toBe(false);
      expect(manager.list()).toHaveLength(0);
    });

    it("delete() returns false for unknown id", async () => {
      expect(await manager.delete("nope")).toBe(false);
    });

    it("disposeAll() clears everything", async () => {
      await manager.getOrCreate("a");
      await manager.getOrCreate("b");
      await manager.disposeAll();
      expect(manager.list()).toHaveLength(0);
    });

    it("getOrCreate updates lastActiveAt on existing session", async () => {
      const s = await manager.getOrCreate("a");
      const initialLast = s.lastActiveAt;
      await vi.advanceTimersByTimeAsync(100);
      await manager.getOrCreate("a");
      expect(s.lastActiveAt > initialLast).toBe(true);
    });
  });

  // ─── Observer 跟踪 ───

  describe("observer tracking", () => {
    it("addObserver increases observer count", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      expect(manager.getObserverCount("a")).toBe(1);
      manager.addObserver("a", "conn-2");
      expect(manager.getObserverCount("a")).toBe(2);
    });

    it("addObserver returns false for unknown session", () => {
      expect(manager.addObserver("nope", "conn-1")).toBe(false);
    });

    it("addObserver is idempotent for same connectionId", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.addObserver("a", "conn-1");
      expect(manager.getObserverCount("a")).toBe(1);
    });

    it("removeObserver decreases observer count", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.addObserver("a", "conn-2");
      manager.removeObserver("a", "conn-1");
      expect(manager.getObserverCount("a")).toBe(1);
    });

    it("removeObserverFromAll cleans up across sessions", async () => {
      await manager.getOrCreate("a");
      await manager.getOrCreate("b");
      manager.addObserver("a", "conn-1");
      manager.addObserver("b", "conn-1");
      manager.addObserver("b", "conn-2");

      manager.removeObserverFromAll("conn-1");
      expect(manager.getObserverCount("a")).toBe(0);
      expect(manager.getObserverCount("b")).toBe(1);
    });

    it("list() includes observerCount", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.addObserver("a", "conn-2");
      expect(manager.list()[0]!.observerCount).toBe(2);
    });
  });

  // ─── Grace Period (60s) ───

  describe("grace period", () => {
    it("releases session 60s after last observer disconnects", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      expect(manager.has("a")).toBe(true);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(manager.has("a")).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(manager.has("a")).toBe(false);
    });

    it("cancels grace timer when new observer joins", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      await vi.advanceTimersByTimeAsync(30_000);
      manager.addObserver("a", "conn-2");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.has("a")).toBe(true);
    });

    it("cancels grace timer when getOrCreate is called", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      await vi.advanceTimersByTimeAsync(30_000);
      await manager.getOrCreate("a");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.has("a")).toBe(true);
    });

    it("does not start grace timer while busy", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.setBusy("a", true);
      manager.removeObserver("a", "conn-1");

      await vi.advanceTimersByTimeAsync(120_000);
      expect(manager.has("a")).toBe(true);
    });

    it("starts grace timer when setBusy(false) with no observers", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(manager.has("a")).toBe(false);
    });

    it("fires onRelease callback with 'grace' reason", async () => {
      const released: Array<[string, string]> = [];
      const mgr = new ConversationManager(
        createMockFactory(),
        { graceTimeoutMs: 100, idleTimeoutMs: 999_999, idleCheckIntervalMs: 999_999 },
        (id, reason) => released.push([id, reason]),
      );

      await mgr.getOrCreate("a");
      mgr.addObserver("a", "conn-1");
      mgr.removeObserver("a", "conn-1");

      await vi.advanceTimersByTimeAsync(101);
      expect(released).toEqual([["a", "grace"]]);
      await mgr.disposeAll();
    });
  });

  // ─── Idle Timeout (30min) ───

  describe("idle timeout", () => {
    it("releases idle session after 30 minutes", async () => {
      await manager.getOrCreate("a");

      await vi.advanceTimersByTimeAsync(30 * 60_000 + 60_001);
      expect(manager.has("a")).toBe(false);
    });

    it("does not release busy session", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      await vi.advanceTimersByTimeAsync(30 * 60_000 + 60_001);
      expect(manager.has("a")).toBe(true);
    });

    it("resets idle timer on activity", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      manager.setBusy("a", true);
      manager.setBusy("a", false);

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(manager.has("a")).toBe(true);

      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(manager.has("a")).toBe(false);
    });

    it("fires onRelease callback with 'idle' reason", async () => {
      const released: Array<[string, string]> = [];
      const mgr = new ConversationManager(
        createMockFactory(),
        { graceTimeoutMs: 999_999, idleTimeoutMs: 1000, idleCheckIntervalMs: 500 },
        (id, reason) => released.push([id, reason]),
      );

      await mgr.getOrCreate("a");
      await vi.advanceTimersByTimeAsync(1501);
      expect(released).toEqual([["a", "idle"]]);
      await mgr.disposeAll();
    });
  });

  // ─── setBusy 与 grace 的交互 ───

  describe("busy and grace interaction", () => {
    it("setBusy(true) clears pending grace timer", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      await vi.advanceTimersByTimeAsync(30_000);
      manager.setBusy("a", true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.has("a")).toBe(true);
    });
  });

  // ─── Pending Queue (§4.5) ───

  describe("pending queue", () => {
    it("returns 'immediate' when session is not busy", async () => {
      await manager.getOrCreate("a");
      const executed: string[] = [];
      const status = manager.enqueue("a", {
        execute: async () => { executed.push("task"); },
        cancel: () => {},
      });
      expect(status).toBe("immediate");
      expect(executed).toHaveLength(0);
    });

    it("returns 'queued' when session is busy", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);
      const status = manager.enqueue("a", {
        execute: async () => {},
        cancel: () => {},
      });
      expect(status).toBe("queued");
      expect(manager.pendingCount("a")).toBe(1);
    });

    it("returns 'full' when queue reaches maxPending", async () => {
      const mgr = new ConversationManager(createMockFactory(), {
        maxPending: 2,
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      });
      await mgr.getOrCreate("a");
      mgr.setBusy("a", true);

      expect(mgr.enqueue("a", { execute: async () => {}, cancel: () => {} })).toBe("queued");
      expect(mgr.enqueue("a", { execute: async () => {}, cancel: () => {} })).toBe("queued");
      expect(mgr.enqueue("a", { execute: async () => {}, cancel: () => {} })).toBe("full");
      await mgr.disposeAll();
    });

    it("dequeues next task when setBusy(false)", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      const executed: string[] = [];
      manager.enqueue("a", {
        execute: async () => { executed.push("task-1"); },
        cancel: () => {},
      });
      manager.enqueue("a", {
        execute: async () => { executed.push("task-2"); },
        cancel: () => {},
      });

      expect(manager.pendingCount("a")).toBe(2);

      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(0);
      expect(executed).toEqual(["task-1"]);
      expect(manager.pendingCount("a")).toBe(1);

      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(0);
      expect(executed).toEqual(["task-1", "task-2"]);
      expect(manager.pendingCount("a")).toBe(0);
    });

    it("does not start grace timer while queue has pending tasks", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      manager.enqueue("a", {
        execute: async () => {},
        cancel: () => {},
      });

      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(manager.has("a")).toBe(true);
    });

    it("starts grace timer after queue drains with no observers", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      manager.enqueue("a", {
        execute: async () => {},
        cancel: () => {},
      });

      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(0);

      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(manager.has("a")).toBe(false);
    });

    it("cancels all pending tasks on delete", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      const cancelled: string[] = [];
      manager.enqueue("a", {
        execute: async () => {},
        cancel: () => { cancelled.push("task-1"); },
      });
      manager.enqueue("a", {
        execute: async () => {},
        cancel: () => { cancelled.push("task-2"); },
      });

      await manager.delete("a");
      expect(cancelled).toEqual(["task-1", "task-2"]);
      expect(manager.pendingCount("a")).toBe(0);
    });

    it("cancels all pending tasks on disposeAll", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      const cancelled: string[] = [];
      manager.enqueue("a", {
        execute: async () => {},
        cancel: () => { cancelled.push("task-1"); },
      });

      await manager.disposeAll();
      expect(cancelled).toEqual(["task-1"]);
    });

    it("list() includes pendingCount", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);
      manager.enqueue("a", { execute: async () => {}, cancel: () => {} });

      const list = manager.list();
      expect(list[0]!.pendingCount).toBe(1);
    });

    it("returns 'full' for unknown conversation", async () => {
      const status = manager.enqueue("nope", {
        execute: async () => {},
        cancel: () => {},
      });
      expect(status).toBe("full");
    });

    it("abort 期间的 pending 被清空 + 各 cancel hook 被调,后续 setBusy(false) 不再 dequeue", async () => {
      // 反映 spec:abort = 用户说"停",pending(已发未跑)也是用户期待 abort 的目标。
      // 旧实现"abort 不清 pending,后续仍 dequeue 跑"违背语义,新实现纠正。
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      const executed: string[] = [];
      const cancelled: string[] = [];
      manager.enqueue("a", {
        execute: async () => { executed.push("queued-task"); },
        cancel: () => { cancelled.push("queued-task"); },
      });

      const result = manager.abort("a");
      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(0);

      expect(result.abortedInFlight).toBe(true);
      expect(result.cancelledPending).toBe(1);
      expect(cancelled).toEqual(["queued-task"]);
      expect(executed).toEqual([]);
      expect(manager.pendingCount("a")).toBe(0);
    });
  });

  // ─── AbortResult 双维度 + abortAll/abortAllAndWait ───

  describe("abort 双维度 + abortAll", () => {
    it("纯 idle session(无 in-flight 无 pending)→ 双零", async () => {
      await manager.getOrCreate("a");
      // session 创建后 busy=false,无 pending → abort 应该是 nooop 维度
      // mock runtime.abort() 永返 true,但实际应:in-flight 维度仅在 in-flight 时返 true
      // 真实 SessionRuntime 在 idle 时返 false;此 mock 简化,本测试覆盖 ConversationManager
      // 自身的 pending 维度
      const result = manager.abort("a");
      expect(result.cancelledPending).toBe(0);
    });

    it("pending only(无 in-flight,有 pending)→ pending 全清 + cancel hook 全调", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);
      const cancelled: number[] = [];
      manager.enqueue("a", { execute: async () => {}, cancel: () => cancelled.push(1) });
      manager.enqueue("a", { execute: async () => {}, cancel: () => cancelled.push(2) });
      manager.enqueue("a", { execute: async () => {}, cancel: () => cancelled.push(3) });

      const result = manager.abort("a");
      expect(result.cancelledPending).toBe(3);
      expect(cancelled).toEqual([1, 2, 3]);
      expect(manager.pendingCount("a")).toBe(0);
    });

    it("一个 task.cancel hook 抛错不影响其它 task 被 cancel", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);
      const cancelled: number[] = [];
      manager.enqueue("a", { execute: async () => {}, cancel: () => cancelled.push(1) });
      manager.enqueue("a", {
        execute: async () => {},
        cancel: () => { throw new Error("hook failure"); },
      });
      manager.enqueue("a", { execute: async () => {}, cancel: () => cancelled.push(3) });

      const result = manager.abort("a");
      expect(result.cancelledPending).toBe(3);
      expect(cancelled).toEqual([1, 3]);
    });

    it("session 不存在 → 双零,不抛", () => {
      const result = manager.abort("ghost");
      expect(result).toEqual({ abortedInFlight: false, cancelledPending: 0 });
    });

    it("abortAll 与单 session abort 行为对称:in-flight 全 fire + 各 pending 全清", async () => {
      await manager.getOrCreate("a");
      await manager.getOrCreate("b");
      await manager.getOrCreate("c");

      manager.setBusy("a", true);
      manager.setBusy("c", true);
      const cancelledA: string[] = [];
      const cancelledC: string[] = [];
      manager.enqueue("a", { execute: async () => {}, cancel: () => cancelledA.push("a1") });
      manager.enqueue("c", { execute: async () => {}, cancel: () => cancelledC.push("c1") });
      manager.enqueue("c", { execute: async () => {}, cancel: () => cancelledC.push("c2") });

      const aborted = manager.abortAll({ kind: "external", origin: "scheduler-shutdown" });

      // mock runtime.abort 永返 true → 3 个 session 都被算作 in-flight aborted
      expect(aborted).toBe(3);
      expect(cancelledA).toEqual(["a1"]);
      expect(cancelledC).toEqual(["c1", "c2"]);
      expect(manager.pendingCount("a")).toBe(0);
      expect(manager.pendingCount("c")).toBe(0);
    });
  });

  describe("abortAllAndWait — event-driven drain", () => {
    it("全 idle 时立即返回(走 fast path)", async () => {
      await manager.getOrCreate("a");
      const aborted = await manager.abortAllAndWait({
        kind: "external",
        origin: "scheduler-shutdown",
      });
      expect(aborted).toBeGreaterThanOrEqual(0);
    });

    it("有 busy session → setBusy(false) 触发 drain resolve(无需轮询)", async () => {
      vi.useRealTimers();
      try {
        const mgr = new ConversationManager(createMockFactory(), {
          graceTimeoutMs: 60_000,
          idleTimeoutMs: 30 * 60_000,
          idleCheckIntervalMs: 60_000,
        });
        try {
          await mgr.getOrCreate("a");
          mgr.setBusy("a", true);

          const drainPromise = mgr.abortAllAndWait(
            { kind: "external", origin: "scheduler-shutdown" },
            5_000,
          );

          // 等待短暂时间确认 drain 还没 resolve
          await new Promise((r) => setTimeout(r, 30));
          let drained = false;
          drainPromise.then(() => { drained = true; });
          await new Promise((r) => setTimeout(r, 10));
          expect(drained).toBe(false);

          // 触发 setBusy(false) → drainResolver 应被调
          mgr.setBusy("a", false);

          const aborted = await drainPromise;
          expect(aborted).toBe(1);
        } finally {
          await mgr.disposeAll();
        }
      } finally {
        vi.useFakeTimers();
      }
    });

    it("超时直接返回不抛(避免 grace 类工具 hang 关停链)", async () => {
      vi.useRealTimers();
      try {
        const mgr = new ConversationManager(createMockFactory(), {
          graceTimeoutMs: 60_000,
          idleTimeoutMs: 30 * 60_000,
          idleCheckIntervalMs: 60_000,
        });
        try {
          await mgr.getOrCreate("a");
          mgr.setBusy("a", true);

          const aborted = await mgr.abortAllAndWait(
            { kind: "external", origin: "scheduler-shutdown" },
            50, // 50ms 超时
          );

          expect(aborted).toBe(1);
          // session 仍 busy,但 abortAllAndWait 不抛
          expect(mgr.list()[0]!.busy).toBe(true);
        } finally {
          await mgr.disposeAll();
        }
      } finally {
        vi.useFakeTimers();
      }
    });
  });

  // ─── Ephemeral + recordTurn + promote ───

  describe("ephemeral sessions", () => {
    it("creates ephemeral session that skips loadHistory and initTranscript", async () => {
      const loaded: string[] = [];
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        loadHistory: async (id) => { loaded.push(id); return undefined; },
        initTranscript: async (id) => { inited.push(id); },
        // 构造守卫要求：有持久化意图（loadHistory / initTranscript）必须配 appendRun。
        // 本测试只验证 ephemeral 隔离行为，appendRun 是 no-op 占位。
        appendRun: async () => ({ runIndex: 0, shardId: "000001" }),
      });

      const session = await mgr.getOrCreate(undefined, { ephemeral: true });
      expect(session.ephemeral).toBe(true);
      expect(loaded).toEqual([]);
      expect(inited).toEqual([]);
      await mgr.disposeAll();
    });

    it("ephemeral session accumulates pendingRuns instead of persisting", async () => {
      const persisted: unknown[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        appendRun: async (_cid, record) => {
          persisted.push(record);
          return { runIndex: persisted.length - 1, shardId: "000001" };
        },
      });

      const session = await mgr.getOrCreate("eph-1", { ephemeral: true });
      const mockRecord = {
        timestamp: new Date().toISOString(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };

      await mgr.recordTurn("eph-1", mockRecord);

      expect(persisted).toHaveLength(0);
      expect(session.pendingRuns.size).toBe(1);
      expect(session.turnCount).toBe(1);
      await mgr.disposeAll();
    });

    it("ephemeral acceptRun 携 provisional runIndex（pending 队列序号），promote 对账一致时静默", async () => {
      const accepted: Array<number | undefined> = [];
      const runtime = createMockRuntime("eph-prov");
      const origAccept = runtime.acceptRun.bind(runtime);
      runtime.acceptRun = (input) => {
        accepted.push(input.runIndex);
        origAccept(input);
      };
      const factory: RuntimeFactory = { create: async () => runtime };

      let next = 0;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const mgr = new ConversationManager(factory, {
          graceTimeoutMs: 60_000,
          idleTimeoutMs: 30 * 60_000,
          idleCheckIntervalMs: 999_999,
        }, {
          // 全新 transcript：store 从 0 顺序分配 —— 与 provisional 必然一致
          appendRun: async () => ({ runIndex: next++, shardId: "000001" }),
        });

        await mgr.getOrCreate("eph-prov", { ephemeral: true });
        const makeRecord = (idx: number) => ({
          timestamp: new Date().toISOString(),
          messages: [
            { role: "user" as const, content: [{ type: "text" as const, text: `q${idx}` }] },
            { role: "assistant" as const, content: [{ type: "text" as const, text: `a${idx}` }] },
          ],
        });
        await mgr.recordTurn("eph-prov", makeRecord(0));
        await mgr.recordTurn("eph-prov", makeRecord(1)); // 触发 auto-promote

        // 窗口配对恒有 runIndex（折叠覆盖锚点在 ephemeral 期就成立）
        expect(accepted).toEqual([0, 1]);
        // FIFO flush 到全新 transcript：对账一致，零告警
        expect(warnSpy).not.toHaveBeenCalled();
        await mgr.disposeAll();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("promote 对账不一致（transcript 非全新）→ warn 暴露窗口锚与持久化错位", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let next = 5; // 模拟同 id 旧 transcript 已有 5 条 —— store 从 5 继续分配
        const mgr = new ConversationManager(createMockFactory(), {
          graceTimeoutMs: 60_000,
          idleTimeoutMs: 30 * 60_000,
          idleCheckIntervalMs: 999_999,
        }, {
          appendRun: async () => ({ runIndex: next++, shardId: "000001" }),
        });

        const session = await mgr.getOrCreate("eph-stale", { ephemeral: true });
        const mockRecord = {
          timestamp: new Date().toISOString(),
          messages: [
            { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "yo" }] },
          ],
        };
        session.pendingRuns.enqueue(mockRecord); // 缓冲定格 provisional = 0

        await mgr.promote("eph-stale");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]![0])).toContain("对账不一致");
        await mgr.disposeAll();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("auto-promotes ephemeral session on 2nd turn", async () => {
      const persisted: Array<{ cid: string; record: unknown }> = [];
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        appendRun: async (cid, record) => {
          persisted.push({ cid, record });
          return { runIndex: persisted.length - 1, shardId: "000001" };
        },
        initTranscript: async (id) => { inited.push(id); },
      });

      const session = await mgr.getOrCreate("eph-auto", { ephemeral: true });
      const makeRecord = (idx: number) => ({
        timestamp: new Date().toISOString(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: `q${idx}` }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: `a${idx}` }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      await mgr.recordTurn("eph-auto", makeRecord(0));
      expect(session.ephemeral).toBe(true);
      expect(inited).toEqual([]);

      await mgr.recordTurn("eph-auto", makeRecord(1));
      expect(session.ephemeral).toBe(false);
      expect(inited).toEqual(["eph-auto"]);
      expect(persisted).toHaveLength(2);
      expect(session.pendingRuns.size).toBe(0);
      expect(session.turnCount).toBe(2);
      await mgr.disposeAll();
    });

    it("promote() flushes pendingRuns and calls initTranscript", async () => {
      const persisted: unknown[] = [];
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        appendRun: async (_cid, record) => {
          persisted.push(record);
          return { runIndex: persisted.length - 1, shardId: "000001" };
        },
        initTranscript: async (id) => { inited.push(id); },
      });

      const session = await mgr.getOrCreate("eph-promote", { ephemeral: true });
      const mockRecord = {
        timestamp: new Date().toISOString(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      session.pendingRuns.enqueue(mockRecord);

      const result = await mgr.promote("eph-promote");
      expect(result).toBe(true);
      expect(session.ephemeral).toBe(false);
      expect(inited).toEqual(["eph-promote"]);
      expect(persisted).toHaveLength(1);
      expect(session.pendingRuns.size).toBe(0);
      await mgr.disposeAll();
    });

    it("promote() returns false for non-ephemeral session", async () => {
      const result = await manager.promote("nope");
      expect(result).toBe(false);

      await manager.getOrCreate("persistent");
      const result2 = await manager.promote("persistent");
      expect(result2).toBe(false);
    });

    it("persistent session persists run immediately via recordTurn", async () => {
      const persisted: Array<{ cid: string; record: unknown }> = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        appendRun: async (cid, record) => {
          persisted.push({ cid, record });
          return { runIndex: persisted.length - 1, shardId: "000001" };
        },
      });

      await mgr.getOrCreate("persist-1");
      const mockRecord = {
        timestamp: new Date().toISOString(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };

      await mgr.recordTurn("persist-1", mockRecord);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.cid).toBe("persist-1");

      const session = mgr.getSession("persist-1")!;
      expect(session.turnCount).toBe(1);
      await mgr.disposeAll();
    });

    it("list() includes ephemeral field", async () => {
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      });

      await mgr.getOrCreate("pers");
      await mgr.getOrCreate("eph", { ephemeral: true });

      const list = mgr.list();
      const pers = list.find(s => s.conversationId === "pers")!;
      const eph = list.find(s => s.conversationId === "eph")!;
      expect(pers.ephemeral).toBe(false);
      expect(eph.ephemeral).toBe(true);
      await mgr.disposeAll();
    });

    it("promote() is idempotent — partial failure + retry does not duplicate init or turns", async () => {
      let persistCallCount = 0;
      const inited: string[] = [];
      const persisted: string[] = [];

      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        initTranscript: async (id) => { inited.push(id); },
        appendRun: async (_cid, record) => {
          persistCallCount++;
          if (persistCallCount === 2) {
            throw new Error("disk full");
          }
          const first = record.messages[0]!.content[0]!;
          persisted.push(first.type === "text" ? first.text : "?");
          // runIndex 按"已成功落盘数"分配 —— 与真实 store 语义一致（失败
          // 调用不占号），重试路径对账才不误告警
          return { runIndex: persisted.length - 1, shardId: "000001" };
        },
      });

      const session = await mgr.getOrCreate("eph-retry", { ephemeral: true });
      const makeRecord = (idx: number) => ({
        timestamp: new Date().toISOString(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: `q${idx}` }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: `a${idx}` }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      session.pendingRuns.enqueue(makeRecord(0));
      session.pendingRuns.enqueue(makeRecord(1));

      // First promote: r0 persists, r1 throws
      await expect(mgr.promote("eph-retry")).rejects.toThrow("disk full");
      expect(inited).toEqual(["eph-retry"]);
      expect(persisted).toEqual(["q0"]);
      expect(session.pendingRuns.size).toBe(1); // r1 still pending
      expect(session.ephemeral).toBe(true);
      expect(session.transcriptInited).toBe(true);

      // Retry promote: should NOT re-init, should only persist r1
      await mgr.promote("eph-retry");
      expect(inited).toEqual(["eph-retry"]); // NOT called again
      expect(persisted).toEqual(["q0", "q1"]);
      expect(session.pendingRuns.size).toBe(0);
      expect(session.ephemeral).toBe(false);

      await mgr.disposeAll();
    });
  });

  // ─── 配置守卫 ───
  //
  // "persistent 分支无路可走 / promote 错误晋升" 两类配置错误的根源都是
  // appendRun 是 optional。这组测试保证：
  //   1. 构造时部分配置（有 loadHistory/initTranscript 但无 appendRun）→ throw
  //   2. 运行时 persistent 分支无 cb → throw（defense-in-depth）
  //   3. 运行时 promote 无 cb → return false 保持 ephemeral 状态

  describe("configuration guards", () => {
    it("constructor throws if loadHistory is provided without appendRun", () => {
      expect(
        () =>
          new ConversationManager(createMockFactory(), {
            graceTimeoutMs: 60_000,
            idleTimeoutMs: 30 * 60_000,
            idleCheckIntervalMs: 999_999,
          }, {
            loadHistory: async () => undefined,
            // appendRun 故意缺失
          }),
      ).toThrow(/appendRun.*required/i);
    });

    it("constructor throws if initTranscript is provided without appendRun", () => {
      expect(
        () =>
          new ConversationManager(createMockFactory(), {
            graceTimeoutMs: 60_000,
            idleTimeoutMs: 30 * 60_000,
            idleCheckIntervalMs: 999_999,
          }, {
            initTranscript: async () => {},
            // appendRun 故意缺失
          }),
      ).toThrow(/appendRun.*required/i);
    });

    it("constructor allows pure ephemeral-only manager (no persistence callbacks)", () => {
      expect(
        () =>
          new ConversationManager(createMockFactory(), {
            graceTimeoutMs: 60_000,
            idleTimeoutMs: 30 * 60_000,
            idleCheckIntervalMs: 999_999,
          }),
      ).not.toThrow();
    });

    it("constructor allows full persistent config", () => {
      expect(
        () =>
          new ConversationManager(createMockFactory(), {
            graceTimeoutMs: 60_000,
            idleTimeoutMs: 30 * 60_000,
            idleCheckIntervalMs: 999_999,
          }, {
            loadHistory: async () => undefined,
            initTranscript: async () => {},
            appendRun: async () => ({ runIndex: 0, shardId: "000001" }),
          }),
      ).not.toThrow();
    });

    it("promote() returns false when appendRun is missing (preserves ephemeral state)", async () => {
      // 纯 ephemeral-only manager —— 构造合法（三个 callback 都无）
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      });

      const session = await mgr.getOrCreate("eph-no-cb", { ephemeral: true });
      const mockRecord = {
        timestamp: new Date().toISOString(),
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      session.pendingRuns.enqueue(mockRecord);

      // promote 必须 return false、不变 ephemeral 标志、不丢 pendingRuns
      const ok = await mgr.promote("eph-no-cb");
      expect(ok).toBe(false);
      expect(session.ephemeral).toBe(true);
      expect(session.pendingRuns.size).toBe(1);

      await mgr.disposeAll();
    });
  });

  // ─── ConfirmationHub 集成（PR-3 M2b + Fix-1 P0 回归守卫） ───
  //
  // 验证 getOrCreate 后 broker 真正挂到 Hub，四条 dispose 路径正确 detach。
  // 这是 P0-1（session-adapter 漏 broker）只在单元测试全绿但线上失效的
  // 直接原因——缺少"manager + hub + 真实 SessionRuntime 带 broker"的集成测试。

  describe("confirmationHub integration", () => {
    function createRuntimeWithBroker(
      sessionId: string,
    ): SessionRuntime & { confirmationBroker: IConfirmationBroker } {
      const base = createMockRuntime(sessionId);
      return Object.assign(base, {
        confirmationBroker: new ConfirmationBroker(),
      });
    }

    function factoryWithBroker(): RuntimeFactory {
      return {
        async create(sessionId) {
          return createRuntimeWithBroker(sessionId);
        },
      };
    }

    it("getOrCreate 后 hub 能按 conversationId 反查到 broker", async () => {
      const hub = new ConfirmationHub();
      const mgr = new ConversationManager(
        factoryWithBroker(),
        { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
        { confirmationHub: hub },
      );

      const session = await mgr.getOrCreate("conv-A");
      const found = hub.findBrokerByConversation("conv-A");
      expect(found).toBe(session.runtime.confirmationBroker);

      await mgr.disposeAll();
    });

    it("runtime 无 confirmationBroker 时 attachToHub 是 no-op（不抛错）", async () => {
      const hub = new ConfirmationHub();
      // 使用默认 factory——createMockRuntime 返回的 SessionRuntime 无 broker
      const mgr = new ConversationManager(
        createMockFactory(),
        { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
        { confirmationHub: hub },
      );

      await mgr.getOrCreate("conv-no-broker");
      expect(hub.findBrokerByConversation("conv-no-broker")).toBeUndefined();
      expect(hub.snapshot().brokers).toHaveLength(0);

      await mgr.disposeAll();
    });

    it("delete 触发 detach，hub 反查返 undefined", async () => {
      const hub = new ConfirmationHub();
      const mgr = new ConversationManager(
        factoryWithBroker(),
        { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
        { confirmationHub: hub },
      );

      await mgr.getOrCreate("conv-A");
      expect(hub.findBrokerByConversation("conv-A")).toBeDefined();

      await mgr.delete("conv-A");
      expect(hub.findBrokerByConversation("conv-A")).toBeUndefined();
    });

    it("grace timeout 释放会话 → detach 发生", async () => {
      const hub = new ConfirmationHub();
      const mgr = new ConversationManager(
        factoryWithBroker(),
        { graceTimeoutMs: 1_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
        { confirmationHub: hub },
      );

      await mgr.getOrCreate("conv-A");
      mgr.addObserver("conv-A", "conn-1");
      mgr.removeObserver("conv-A", "conn-1");
      expect(hub.findBrokerByConversation("conv-A")).toBeDefined();

      await vi.advanceTimersByTimeAsync(1_001);
      expect(hub.findBrokerByConversation("conv-A")).toBeUndefined();

      await mgr.disposeAll();
    });

    it("disposeAll → 所有会话的 broker 均 detach", async () => {
      const hub = new ConfirmationHub();
      const mgr = new ConversationManager(
        factoryWithBroker(),
        { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
        { confirmationHub: hub },
      );

      await mgr.getOrCreate("conv-A");
      await mgr.getOrCreate("conv-B");
      expect(hub.snapshot().brokers).toHaveLength(2);

      await mgr.disposeAll();
      expect(hub.snapshot().brokers).toHaveLength(0);
    });

    it("重新 getOrCreate 同一 conversationId → INV-H1 不冲突", async () => {
      const hub = new ConfirmationHub();
      const mgr = new ConversationManager(
        factoryWithBroker(),
        { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
        { confirmationHub: hub },
      );

      await mgr.getOrCreate("conv-A");
      await mgr.delete("conv-A");
      // 立即重建应无 INV-H1 冲突
      await expect(mgr.getOrCreate("conv-A")).resolves.toBeDefined();

      await mgr.disposeAll();
    });
  });
});
