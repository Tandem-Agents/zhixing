import { describe, expect, it, vi } from "vitest";
import type {
  AgentYield,
  Message,
  RunRecordInput,
  RunResult,
} from "@zhixing/core";
import { ConversationManager } from "../../runtime/conversation-manager.js";
import type { RuntimeFactory, SessionRuntime } from "../../runtime/types.js";
import { projectSessionTurn } from "../session-turn-stream.js";

function createRuntime(yields: readonly AgentYield[]): SessionRuntime {
  return {
    sessionId: "c1",
    async *run(messages): AsyncGenerator<AgentYield, RunResult> {
      for (const event of yields) yield event;
      const userMessage = messages[messages.length - 1]!;
      const assistantMessage: Message = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      };
      const usage = { inputTokens: 0, outputTokens: 0 };
      const runRecord: RunRecordInput = {
        timestamp: new Date().toISOString(),
        messages: [userMessage, assistantMessage],
        usage,
      };
      return {
        agentResult: {
          reason: "completed",
          message: assistantMessage,
          usage,
        },
        runRecord,
        newMessages: [assistantMessage],
        durationMs: 0,
      };
    },
    abort() {
      return false;
    },
    async dispose() {},
  };
}

function createFactory(yields: readonly AgentYield[]): RuntimeFactory {
  return {
    async create() {
      return createRuntime(yields);
    },
  };
}

describe("projectSessionTurn", () => {
  it("strips presentation from default session.delta payloads", async () => {
    const manager = new ConversationManager(
      createFactory([
        {
          type: "tool_end",
          id: "edit-1",
          name: "edit",
          duration: 3,
          result: {
            content: "Replaced text",
            presentation: {
              kind: "file-diff",
              path: "a.ts",
              operation: "modified",
              changeStats: { kind: "exact", addedLines: 1, removedLines: 1 },
              hunks: [],
            },
          },
        },
      ]),
      {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      },
      {
        appendRun: vi.fn(async () => ({ runIndex: 0, shardId: "000001" })),
      },
    );
    const managed = await manager.getOrCreate("c1");
    const notifications: Array<{ method: string; params: unknown }> = [];

    await projectSessionTurn({
      manager,
      managed,
      text: "change file",
      turnId: "turn-1",
      notify: (method, params) => notifications.push({ method, params }),
    });

    const delta = notifications.find((n) => n.method === "session.delta");
    expect(JSON.stringify(delta?.params)).toContain("Replaced text");
    expect(JSON.stringify(delta?.params)).not.toContain("file-diff");
  });
});
