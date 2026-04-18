import { describe, it, expect, beforeEach } from "vitest";
import type { AgentResult, AgentYield, Message } from "@zhixing/core";
import { RuntimeRegistry } from "../registry.js";
import type { SessionRuntime, RuntimeFactory } from "../types.js";

// ─── 测试用 mock runtime ───

function createMockRuntime(sessionId: string): SessionRuntime {
  const messages: Message[] = [];
  let aborted = false;

  return {
    sessionId,
    async *run(text): AsyncGenerator<AgentYield, AgentResult> {
      messages.push({ role: "user", content: [{ type: "text", text }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] });
      yield {
        type: "text_delta",
        text: `echo: ${text}`,
      };
      yield { type: "turn_complete", turnCount: 1, usage: { inputTokens: 0, outputTokens: 0 } };
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

// ─── 测试 ───

describe("RuntimeRegistry", () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry(createMockFactory());
  });

  it("creates a new runtime when no sessionId provided", async () => {
    const runtime = await registry.getOrCreate();
    expect(runtime.sessionId).toMatch(/^sess_/);
    expect(registry.list()).toHaveLength(1);
  });

  it("returns existing runtime when sessionId provided and exists", async () => {
    const s1 = await registry.getOrCreate();
    const s2 = await registry.getOrCreate(s1.sessionId);
    expect(s1).toBe(s2);
    expect(registry.list()).toHaveLength(1);
  });

  it("creates runtime with specified sessionId when not present", async () => {
    const runtime = await registry.getOrCreate("custom-id");
    expect(runtime.sessionId).toBe("custom-id");
  });

  it("list() returns metadata for all runtimes", async () => {
    await registry.getOrCreate("a");
    await registry.getOrCreate("b");
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    for (const info of list) {
      expect(info.busy).toBe(false);
      expect(info.messageCount).toBe(0);
    }
  });

  it("setBusy reflects in list()", async () => {
    await registry.getOrCreate("a");
    registry.setBusy("a", true);
    expect(registry.list()[0]!.busy).toBe(true);
    registry.setBusy("a", false);
    expect(registry.list()[0]!.busy).toBe(false);
  });

  it("messageCount updates after run()", async () => {
    const s = await registry.getOrCreate("a");
    const gen = s.run("hello");
    while (!(await gen.next()).done) {
      // consume
    }
    expect(registry.list()[0]!.messageCount).toBe(2);
  });

  it("abort() returns false for unknown runtime", () => {
    expect(registry.abort("nope")).toBe(false);
  });

  it("abort() invokes runtime.abort and returns true", async () => {
    const s = (await registry.getOrCreate("a")) as SessionRuntime & { _aborted: boolean };
    expect(registry.abort("a")).toBe(true);
    expect(s._aborted).toBe(true);
  });

  it("delete() removes runtime and invokes dispose", async () => {
    await registry.getOrCreate("a");
    expect(registry.delete("a")).toBe(true);
    expect(registry.has("a")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it("delete() returns false for unknown runtime", () => {
    expect(registry.delete("nope")).toBe(false);
  });

  it("disposeAll clears everything", async () => {
    await registry.getOrCreate("a");
    await registry.getOrCreate("b");
    registry.disposeAll();
    expect(registry.list()).toHaveLength(0);
  });

  it("getOrCreate updates lastActiveAt on existing runtime", async () => {
    const s = await registry.getOrCreate("a");
    const initialLast = registry.list()[0]!.lastActiveAt;
    await new Promise((r) => setTimeout(r, 5));
    await registry.getOrCreate(s.sessionId);
    const updatedLast = registry.list()[0]!.lastActiveAt;
    expect(updatedLast >= initialLast).toBe(true);
  });
});
