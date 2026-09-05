import { describe, expect, it, vi } from "vitest";
import type {
  ConversationPerspectivesDurableExecutionInput,
  ConversationPerspectivesRuntimePort,
} from "@zhixing/core/conversation/application";
import type {
  ConversationManager,
  ManagedSession,
} from "@zhixing/owner-kernel/conversation-manager";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";
import {
  createConversationPerspectivesCorrectnessPort,
  projectConversationPerspectivesRuntime,
} from "./conversation-perspectives-correctness.js";

describe("Conversation perspective Host Correctness adapter", () => {
  it("projects only the finite runtime capabilities and preserves metering", async () => {
    const callTextWithUsage = vi.fn(async () => ({
      text: "allocation",
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const runOrchestrationV1 = vi.fn(async () => ({ status: "completed" }));
    const runtime = {
      sessionId: "runtime-1",
      callTextWithUsage,
      runOrchestrationV1,
      estimateMessagesTokens: () => 41,
    } as unknown as SessionRuntime;
    const managed = {
      conversationId: "conversation-1",
      runtime,
      turnCount: 3,
      window: { getMessages: () => [] },
    } as unknown as ManagedSession;
    const projection = projectConversationPerspectivesRuntime(managed);
    const metering = {
      meter: {} as never,
      nextCallIndex: () => 1,
    };

    await expect(
      projection.callText("allocate", "main", { modelCallMetering: metering }),
    ).resolves.toMatchObject({ text: "allocation" });
    expect(callTextWithUsage).toHaveBeenCalledWith("allocate", "main", {
      modelCallMetering: metering,
    });
    expect(projection.turnCount()).toBe(3);
    expect(projection.estimateMessagesTokens([])).toBe(41);

    const orchestrationInput = {
      executable: {},
      runInput: "question",
      contextSnapshot: {},
      eventBus: {},
      modelCallMetering: metering,
    } as unknown as Parameters<
      ConversationPerspectivesRuntimePort["runOrchestration"]
    >[0];
    await projection.runOrchestration(orchestrationInput);
    expect(runOrchestrationV1).toHaveBeenCalledWith({
      ...orchestrationInput,
      parentLineage: "perspectives",
    });
  });

  it("rebuilds the durable synthetic runtime without taking ownership of the manager", async () => {
    const meter = {} as never;
    const authorizeToolExecution = vi.fn();
    const outcome = { status: "completed" } as never;
    const runResult = { runRecord: {} } as never;
    const baseRuntime = {
      sessionId: "base-runtime",
      abort: vi.fn(() => true),
    } as unknown as SessionRuntime;
    const managed = {
      conversationId: "conversation-1",
      runtime: baseRuntime,
      turnCount: 4,
      window: { getMessages: () => [] },
    } as unknown as ManagedSession;
    const durableRun = vi.fn((input: Parameters<
      NonNullable<ReturnType<ConversationManager["durableTurnExecutor"]>>["run"]
    >[0]) => (async function* () {
      const nested = input.runtime.run(input.messages, {
        ...input.options,
        authorizeToolExecution,
        modelCallResourceMeter: meter,
      });
      for (;;) {
        const step = await nested.next();
        if (step.done) return step.value;
        yield step.value;
      }
    })());
    const manager = {
      usesDurableTurnProtocol: () => true,
      getSession: (conversationId: string) =>
        conversationId === managed.conversationId ? managed : undefined,
      durableTurnExecutor: () => ({ run: durableRun }),
    } as unknown as ConversationManager;
    const port = createConversationPerspectivesCorrectnessPort({
      manager: () => manager,
    });
    const execute = vi.fn(async (
      runtime: ConversationPerspectivesRuntimePort,
      controls: Parameters<
        ConversationPerspectivesDurableExecutionInput["execute"]
      >[1],
    ) => {
      expect(runtime.conversationId).toBe("conversation-1");
      expect(controls.authorizeToolExecution).toBe(authorizeToolExecution);
      expect(controls.modelCallMetering?.meter).toBe(meter);
      expect(controls.modelCallMetering?.nextCallIndex()).toBe(1);
      expect(controls.modelCallMetering?.nextCallIndex()).toBe(2);
      return { outcome, runResult };
    });

    await expect(
      port.runDurable({
        conversationId: "conversation-1",
        originalInput: "@ evaluate",
        messages: [],
        baseRevision: 4,
        question: "evaluate",
        source: "channel",
        execute,
      }),
    ).resolves.toBe(outcome);
    expect(durableRun).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        baseRevision: 4,
        invocation: {
          kind: "perspectives",
          source: "channel",
          question: "evaluate",
        },
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});
