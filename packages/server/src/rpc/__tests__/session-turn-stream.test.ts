import { describe, expect, it, vi } from "vitest";
import type {
  AgentYield,
  Message,
  RunRecordInput,
  RunResult,
} from "@zhixing/core";
import {
  ConversationManager,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import { projectSessionTurn } from "@zhixing/rpc";
import { stubDurableTurnExecutor } from "../../__tests__/durable-turn-executor-stub.js";

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

  it("publishes the durable final only after the committed completion notification", async () => {
    const order: string[] = [];
    const result: RunResult = {
      agentResult: {
        reason: "completed",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      runRecord: {
        timestamp: "2026-07-18T00:00:00.000Z",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      newMessages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      durationMs: 1,
    };
    const manager = new ConversationManager(createFactory([]), undefined, {
      durableTurnExecutor: stubDurableTurnExecutor({
        async *run(): AsyncGenerator<AgentYield, RunResult> {
          return result;
        },
        async publishPendingFinals() {
          order.push("final");
          return 1;
        },
      }),
    });
    const managed = await manager.getOrCreate("c1");

    await projectSessionTurn({
      manager,
      managed,
      text: "hello",
      turnId: "turn-durable",
      notify: (method) => order.push(method),
    });

    expect(order).toEqual(["session.complete", "final"]);
  });

  it("keeps a committed turn settled when final publication is deferred for recovery", async () => {
    const publishError = new Error("observer unavailable");
    const onFinalPublishFailure = vi.fn();
    const notifications: string[] = [];
    const manager = new ConversationManager(createFactory([]), undefined, {
      durableTurnExecutor: stubDurableTurnExecutor({
        async *run(): AsyncGenerator<AgentYield, RunResult> {
          return {
            agentResult: {
              reason: "completed",
              message: { role: "assistant", content: [{ type: "text", text: "done" }] },
              usage: { inputTokens: 1, outputTokens: 1 },
            },
            runRecord: {
              timestamp: "2026-07-18T00:00:00.000Z",
              messages: [
                { role: "user", content: [{ type: "text", text: "hello" }] },
                { role: "assistant", content: [{ type: "text", text: "done" }] },
              ],
              usage: { inputTokens: 1, outputTokens: 1 },
            },
            newMessages: [
              { role: "assistant", content: [{ type: "text", text: "done" }] },
            ],
            durationMs: 1,
          };
        },
        async publishPendingFinals() {
          throw publishError;
        },
      }),
    });
    const managed = await manager.getOrCreate("c1");

    const projected = await projectSessionTurn({
      manager,
      managed,
      text: "hello",
      turnId: "turn-recover-final",
      hooks: { onFinalPublishFailure },
      notify: (method) => notifications.push(method),
    });

    expect(projected.kind).toBe("settled");
    expect(notifications).toEqual(["session.complete"]);
    expect(onFinalPublishFailure).toHaveBeenCalledWith(
      publishError,
      expect.objectContaining({ agentResult: expect.objectContaining({ reason: "completed" }) }),
    );
  });
});
