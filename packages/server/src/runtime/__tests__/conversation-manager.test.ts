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
      messages.push(userMsg, assistantMsg);
      yield { type: "text_delta", text: `echo: ${text}` };
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
    },
    getHistory(limit) {
      return limit ? messages.slice(-limit) : messages;
    },
    updateMessages(canonical) {
      messages = [...canonical];
    },
    abort() {
      aborted = true;
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

  afterEach(() => {
    manager.disposeAll();
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
      mgr.disposeAll();
    });

    it("calls initTranscript for new conversations (no history)", async () => {
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        initTranscript: async (id) => { inited.push(id); },
        commitTurn: async () => [], // 配置守卫：有持久化意图必须带 commitTurn
      });

      await mgr.getOrCreate("new-conv");
      expect(inited).toEqual(["new-conv"]);
      mgr.disposeAll();
    });

    it("does NOT call initTranscript when loadHistory returns messages", async () => {
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        loadHistory: async () => [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
        initTranscript: async (id) => { inited.push(id); },
        commitTurn: async () => [], // 配置守卫：有持久化意图必须带 commitTurn
      });

      const session = await mgr.getOrCreate("existing");
      expect(inited).toEqual([]);
      expect(session.turnCount).toBe(1);
      mgr.disposeAll();
    });

    it("initializes turnCount from loaded history", async () => {
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        loadHistory: async () => [
          { role: "user", content: [{ type: "text", text: "q1" }] },
          { role: "assistant", content: [{ type: "text", text: "a1" }] },
          { role: "user", content: [{ type: "text", text: "q2" }] },
          { role: "assistant", content: [{ type: "text", text: "a2" }] },
        ],
        commitTurn: async () => [], // 配置守卫：有持久化意图必须带 commitTurn
      });

      const session = await mgr.getOrCreate("restored");
      expect(session.turnCount).toBe(2);
      mgr.disposeAll();
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

    it("abort() invokes runtime.abort()", async () => {
      const session = await manager.getOrCreate("a");
      expect(manager.abort("a")).toBe(true);
      expect((session.runtime as SessionRuntime & { _aborted: boolean })._aborted).toBe(true);
    });

    it("abort() returns false for unknown id", () => {
      expect(manager.abort("nope")).toBe(false);
    });

    it("delete() removes session and disposes runtime", async () => {
      await manager.getOrCreate("a");
      expect(manager.delete("a")).toBe(true);
      expect(manager.has("a")).toBe(false);
      expect(manager.list()).toHaveLength(0);
    });

    it("delete() returns false for unknown id", () => {
      expect(manager.delete("nope")).toBe(false);
    });

    it("disposeAll() clears everything", async () => {
      await manager.getOrCreate("a");
      await manager.getOrCreate("b");
      manager.disposeAll();
      expect(manager.list()).toHaveLength(0);
    });

    it("getOrCreate updates lastActiveAt on existing session", async () => {
      const s = await manager.getOrCreate("a");
      const initialLast = s.lastActiveAt;
      vi.advanceTimersByTime(100);
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
      vi.advanceTimersByTime(59_999);
      expect(manager.has("a")).toBe(true);
      vi.advanceTimersByTime(2);
      expect(manager.has("a")).toBe(false);
    });

    it("cancels grace timer when new observer joins", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      vi.advanceTimersByTime(30_000);
      manager.addObserver("a", "conn-2");

      vi.advanceTimersByTime(60_000);
      expect(manager.has("a")).toBe(true);
    });

    it("cancels grace timer when getOrCreate is called", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      vi.advanceTimersByTime(30_000);
      await manager.getOrCreate("a");

      vi.advanceTimersByTime(60_000);
      expect(manager.has("a")).toBe(true);
    });

    it("does not start grace timer while busy", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.setBusy("a", true);
      manager.removeObserver("a", "conn-1");

      vi.advanceTimersByTime(120_000);
      expect(manager.has("a")).toBe(true);
    });

    it("starts grace timer when setBusy(false) with no observers", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      manager.setBusy("a", false);
      vi.advanceTimersByTime(60_001);
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

      vi.advanceTimersByTime(101);
      expect(released).toEqual([["a", "grace"]]);
      mgr.disposeAll();
    });
  });

  // ─── Idle Timeout (30min) ───

  describe("idle timeout", () => {
    it("releases idle session after 30 minutes", async () => {
      await manager.getOrCreate("a");

      vi.advanceTimersByTime(30 * 60_000 + 60_001);
      expect(manager.has("a")).toBe(false);
    });

    it("does not release busy session", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      vi.advanceTimersByTime(30 * 60_000 + 60_001);
      expect(manager.has("a")).toBe(true);
    });

    it("resets idle timer on activity", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");

      vi.advanceTimersByTime(20 * 60_000);
      manager.setBusy("a", true);
      manager.setBusy("a", false);

      vi.advanceTimersByTime(20 * 60_000);
      expect(manager.has("a")).toBe(true);

      vi.advanceTimersByTime(11 * 60_000);
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
      vi.advanceTimersByTime(1501);
      expect(released).toEqual([["a", "idle"]]);
      mgr.disposeAll();
    });
  });

  // ─── setBusy 与 grace 的交互 ───

  describe("busy and grace interaction", () => {
    it("setBusy(true) clears pending grace timer", async () => {
      await manager.getOrCreate("a");
      manager.addObserver("a", "conn-1");
      manager.removeObserver("a", "conn-1");

      vi.advanceTimersByTime(30_000);
      manager.setBusy("a", true);

      vi.advanceTimersByTime(60_000);
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
      mgr.disposeAll();
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
      vi.advanceTimersByTime(60_001);
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
      vi.advanceTimersByTime(60_001);
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

      manager.delete("a");
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

      manager.disposeAll();
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

    it("abort while busy triggers dequeue of next pending task", async () => {
      await manager.getOrCreate("a");
      manager.setBusy("a", true);

      const executed: string[] = [];
      manager.enqueue("a", {
        execute: async () => { executed.push("queued-task"); },
        cancel: () => {},
      });

      manager.abort("a");
      manager.setBusy("a", false);
      await vi.advanceTimersByTimeAsync(0);

      expect(executed).toEqual(["queued-task"]);
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
        // 构造守卫要求：有持久化意图（loadHistory / initTranscript）必须配 commitTurn。
        // 本测试只验证 ephemeral 隔离行为，commitTurn 是 no-op 占位。
        commitTurn: async () => [],
      });

      const session = await mgr.getOrCreate(undefined, { ephemeral: true });
      expect(session.ephemeral).toBe(true);
      expect(loaded).toEqual([]);
      expect(inited).toEqual([]);
      mgr.disposeAll();
    });

    it("ephemeral session accumulates pendingTurns instead of persisting", async () => {
      const persisted: unknown[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        commitTurn: async (_cid, payload) => {
          if (payload.turn) persisted.push(payload.turn);
          return [];
        },
      });

      const session = await mgr.getOrCreate("eph-1", { ephemeral: true });
      const mockTurn = {
        type: "turn" as const,
        turnIndex: 0,
        timestamp: new Date().toISOString(),
        userMessage: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };

      await mgr.recordTurn("eph-1", mockTurn);

      expect(persisted).toHaveLength(0);
      expect(session.pendingTurns).toHaveLength(1);
      expect(session.turnCount).toBe(1);
      mgr.disposeAll();
    });

    it("auto-promotes ephemeral session on 2nd turn", async () => {
      const persisted: Array<{ cid: string; turn: unknown }> = [];
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        commitTurn: async (cid, payload) => {
          if (payload.turn) persisted.push({ cid, turn: payload.turn });
          return [];
        },
        initTranscript: async (id) => { inited.push(id); },
      });

      const session = await mgr.getOrCreate("eph-auto", { ephemeral: true });
      const makeTurn = (idx: number) => ({
        type: "turn" as const,
        turnIndex: idx,
        timestamp: new Date().toISOString(),
        userMessage: { role: "user" as const, content: [{ type: "text" as const, text: `q${idx}` }] },
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: `a${idx}` }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      await mgr.recordTurn("eph-auto", makeTurn(0));
      expect(session.ephemeral).toBe(true);
      expect(inited).toEqual([]);

      await mgr.recordTurn("eph-auto", makeTurn(1));
      expect(session.ephemeral).toBe(false);
      expect(inited).toEqual(["eph-auto"]);
      expect(persisted).toHaveLength(2);
      expect(session.pendingTurns).toHaveLength(0);
      expect(session.turnCount).toBe(2);
      mgr.disposeAll();
    });

    it("promote() flushes pendingTurns and calls initTranscript", async () => {
      const persisted: unknown[] = [];
      const inited: string[] = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        commitTurn: async (_cid, payload) => {
          if (payload.turn) persisted.push(payload.turn);
          return [];
        },
        initTranscript: async (id) => { inited.push(id); },
      });

      const session = await mgr.getOrCreate("eph-promote", { ephemeral: true });
      const mockTurn = {
        type: "turn" as const,
        turnIndex: 0,
        timestamp: new Date().toISOString(),
        userMessage: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      session.pendingTurns.push(mockTurn);

      const result = await mgr.promote("eph-promote");
      expect(result).toBe(true);
      expect(session.ephemeral).toBe(false);
      expect(inited).toEqual(["eph-promote"]);
      expect(persisted).toHaveLength(1);
      expect(session.pendingTurns).toHaveLength(0);
      mgr.disposeAll();
    });

    it("promote() returns false for non-ephemeral session", async () => {
      const result = await manager.promote("nope");
      expect(result).toBe(false);

      await manager.getOrCreate("persistent");
      const result2 = await manager.promote("persistent");
      expect(result2).toBe(false);
    });

    it("persistent session persists turn immediately via recordTurn", async () => {
      const persisted: Array<{ cid: string; turn: unknown }> = [];
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        commitTurn: async (cid, payload) => {
          if (payload.turn) persisted.push({ cid, turn: payload.turn });
          return [];
        },
      });

      await mgr.getOrCreate("persist-1");
      const mockTurn = {
        type: "turn" as const,
        turnIndex: 0,
        timestamp: new Date().toISOString(),
        userMessage: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };

      await mgr.recordTurn("persist-1", mockTurn);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.cid).toBe("persist-1");

      const session = mgr.getSession("persist-1")!;
      expect(session.turnCount).toBe(1);
      mgr.disposeAll();
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
      mgr.disposeAll();
    });

    it("promote() is idempotent — partial failure + retry does not duplicate init or turns", async () => {
      let persistCallCount = 0;
      const inited: string[] = [];
      const persisted: number[] = [];

      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      }, {
        initTranscript: async (id) => { inited.push(id); },
        commitTurn: async (_cid, payload) => {
          persistCallCount++;
          if (persistCallCount === 2) {
            throw new Error("disk full");
          }
          if (payload.turn) {
            persisted.push((payload.turn as { turnIndex: number }).turnIndex);
          }
          return [];
        },
      });

      const session = await mgr.getOrCreate("eph-retry", { ephemeral: true });
      const makeTurn = (idx: number) => ({
        type: "turn" as const,
        turnIndex: idx,
        timestamp: new Date().toISOString(),
        userMessage: { role: "user" as const, content: [{ type: "text" as const, text: `q${idx}` }] },
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: `a${idx}` }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      session.pendingTurns.push(makeTurn(0), makeTurn(1));

      // First promote: t0 persists, t1 throws
      await expect(mgr.promote("eph-retry")).rejects.toThrow("disk full");
      expect(inited).toEqual(["eph-retry"]);
      expect(persisted).toEqual([0]);
      expect(session.pendingTurns).toHaveLength(1); // t1 still pending
      expect(session.ephemeral).toBe(true);
      expect(session.transcriptInited).toBe(true);

      // Retry promote: should NOT re-init, should only persist t1
      await mgr.promote("eph-retry");
      expect(inited).toEqual(["eph-retry"]); // NOT called again
      expect(persisted).toEqual([0, 1]);
      expect(session.pendingTurns).toHaveLength(0);
      expect(session.ephemeral).toBe(false);

      mgr.disposeAll();
    });
  });

  // ─── 配置守卫（Phase 5 Bug #1/#2 回归守卫） ───
  //
  // "persistent 静默丢消息 / promote 错误晋升" 两个 bug 的根源都是
  // commitTurn 是 optional。这组测试保证：
  //   1. 构造时部分配置（有 loadHistory/initTranscript 但无 commitTurn）→ throw
  //   2. 运行时 persistent 分支无 cb → throw（defense-in-depth）
  //   3. 运行时 promote 无 cb → return false 保持 ephemeral 状态

  describe("configuration guards", () => {
    it("constructor throws if loadHistory is provided without commitTurn", () => {
      expect(
        () =>
          new ConversationManager(createMockFactory(), {
            graceTimeoutMs: 60_000,
            idleTimeoutMs: 30 * 60_000,
            idleCheckIntervalMs: 999_999,
          }, {
            loadHistory: async () => undefined,
            // commitTurn 故意缺失
          }),
      ).toThrow(/commitTurn.*required/i);
    });

    it("constructor throws if initTranscript is provided without commitTurn", () => {
      expect(
        () =>
          new ConversationManager(createMockFactory(), {
            graceTimeoutMs: 60_000,
            idleTimeoutMs: 30 * 60_000,
            idleCheckIntervalMs: 999_999,
          }, {
            initTranscript: async () => {},
            // commitTurn 故意缺失
          }),
      ).toThrow(/commitTurn.*required/i);
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
            commitTurn: async () => [],
          }),
      ).not.toThrow();
    });

    it("promote() returns false when commitTurn is missing (preserves ephemeral state)", async () => {
      // 纯 ephemeral-only manager —— 构造合法（三个 callback 都无）
      const mgr = new ConversationManager(createMockFactory(), {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      });

      const session = await mgr.getOrCreate("eph-no-cb", { ephemeral: true });
      const mockTurn = {
        type: "turn" as const,
        turnIndex: 0,
        timestamp: new Date().toISOString(),
        userMessage: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      session.pendingTurns.push(mockTurn);

      // promote 必须 return false、不变 ephemeral 标志、不丢 pendingTurns
      const ok = await mgr.promote("eph-no-cb");
      expect(ok).toBe(false);
      expect(session.ephemeral).toBe(true);
      expect(session.pendingTurns).toHaveLength(1);

      mgr.disposeAll();
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

      mgr.disposeAll();
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

      mgr.disposeAll();
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

      mgr.delete("conv-A");
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

      mgr.disposeAll();
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

      mgr.disposeAll();
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
      mgr.delete("conv-A");
      // 立即重建应无 INV-H1 冲突
      await expect(mgr.getOrCreate("conv-A")).resolves.toBeDefined();

      mgr.disposeAll();
    });
  });
});
