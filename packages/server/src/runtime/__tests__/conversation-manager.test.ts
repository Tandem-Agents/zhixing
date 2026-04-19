import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentResult, AgentYield, Message } from "@zhixing/core";
import { ConversationManager } from "../conversation-manager.js";
import type { SessionRuntime, RuntimeFactory } from "../types.js";

// ─── Mock Runtime ───

function createMockRuntime(sessionId: string): SessionRuntime {
  const messages: Message[] = [];
  let aborted = false;

  return {
    sessionId,
    async *run(text): AsyncGenerator<AgentYield, AgentResult> {
      messages.push({ role: "user", content: [{ type: "text", text }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] });
      yield { type: "text_delta", text: `echo: ${text}` };
      return {
        reason: "completed",
        message: messages[messages.length - 1]!,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    getHistory(limit) {
      return limit ? messages.slice(-limit) : messages;
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
});
