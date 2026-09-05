import { describe, expect, it, vi } from "vitest";
import type { RunResult } from "../loop/types.js";
import type { Message } from "../types/messages.js";
import {
  ConversationPerspectivesApplicationService,
  PERSPECTIVES_CONVERGENCE_NODE_ID,
  PERSPECTIVES_DELIBERATION_DEFINITION_ID,
  assemblePerspectiveExecutable,
  type ConversationPerspectivesCorrectnessPort,
  type ConversationPerspectivesRuntimePort,
  type PerspectiveAllocationStrategy,
  type PerspectivesOrchestrationExecutor,
} from "./perspectives-application.js";

describe("ConversationPerspectivesApplicationService", () => {
  it("owns the bounded divergence/cross/convergence template", () => {
    const assembly = assemblePerspectiveExecutable({
      allocation: allocation(7),
    });

    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    expect(assembly.allocation.perspectives).toHaveLength(5);
    expect(assembly.executable.definition.nodeIds).toHaveLength(11);
    expect(assembly.executable.definition.policy.maxParallel).toBe(5);
    expect(
      assembly.executable.definition.nodesById["diverge-2"]!.policy.modelRole,
    ).toBe("power");
    expect(
      assembly.executable.definition.nodesById["cross-2"]!.instruction,
    ).toContain("你的第一轮版本是 id 为 diverge-2 的输出");
    expect(
      assembly.executable.definition.nodesById[
        PERSPECTIVES_CONVERGENCE_NODE_ID
      ]!.dependsOn,
    ).toEqual(["cross-1", "cross-2", "cross-3", "cross-4", "cross-5"]);
  });

  it("commits only the original user message and convergence answer", async () => {
    const harness = createHarness();
    const application = createApplication(harness.correctness);

    const result = await application.runPerspectiveTurn({
      conversationId: "conversation-1",
      originalInput: "@ 请审查这个方案",
      question: "请审查这个方案",
      turnContext: { turnId: "turn-1" },
    });

    expect(result.status).toBe("completed");
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]).toMatchObject({
      turnId: "turn-1",
      record: {
        source: "interactive",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "@ 请审查这个方案" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "最终版本" }],
          },
        ],
        perspectives: {
          definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
          perspectiveCount: 3,
        },
      },
    });
    expect(harness.records[0]!.record.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 6,
    });
  });

  it("does not commit partial orchestration output", async () => {
    const harness = createHarness();
    const application = createApplication(harness.correctness, {
      orchestrationExecutor: failedExecutor("cross node failed"),
    });

    await expect(
      application.runPerspectiveTurn({
        conversationId: "conversation-1",
        originalInput: "@ 评估风险",
        question: "评估风险",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      stage: "orchestration",
      message: "cross node failed",
    });
    expect(harness.records).toEqual([]);
  });

  it("reports legacy commit failure without publishing a false completion", async () => {
    const harness = createHarness({ recordError: new Error("disk unavailable") });
    const application = createApplication(harness.correctness);

    await expect(
      application.runPerspectiveTurn({
        conversationId: "conversation-1",
        originalInput: "@ 评估",
        question: "评估",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      stage: "commit",
      message: "failed to commit perspective final answer: disk unavailable",
    });
  });

  it("keeps a durable completion when final publication must be retried", async () => {
    const harness = createHarness({
      durable: true,
      publishError: new Error("observer temporarily unavailable"),
    });
    const deferred = vi.fn();
    const application = createApplication(harness.correctness, {
      onDurableFinalPublicationDeferred: deferred,
    });

    const result = await application.runPerspectiveTurn({
      conversationId: "conversation-1",
      originalInput: "@ 使用耐久协议",
      question: "使用耐久协议",
      turnContext: { turnId: "turn-durable" },
    });

    expect(result.status).toBe("completed");
    expect(harness.records).toEqual([]);
    expect(harness.durableRunResults).toHaveLength(1);
    expect(harness.durableRunResults[0]!.runRecord).toMatchObject({
      perspectives: {
        definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
        perspectiveCount: 3,
      },
    });
    expect(harness.publishPendingFinals).toHaveBeenCalledWith("conversation-1");
    expect(deferred).toHaveBeenCalledWith(
      expect.objectContaining({ message: "observer temporarily unavailable" }),
    );
  });

  it("does not let a diagnostic observer rewrite an already committed outcome", async () => {
    const harness = createHarness({
      durable: true,
      publishError: new Error("observer temporarily unavailable"),
    });
    const application = createApplication(harness.correctness, {
      onDurableFinalPublicationDeferred: () => {
        throw new Error("diagnostic sink unavailable");
      },
    });

    await expect(
      application.runPerspectiveTurn({
        conversationId: "conversation-1",
        originalInput: "@ 使用耐久协议",
        question: "使用耐久协议",
      }),
    ).resolves.toMatchObject({ status: "completed", finalText: "最终版本" });
    expect(harness.durableRunResults).toHaveLength(1);
  });

  it("fails allocation before orchestration when fewer than two views are returned", async () => {
    const harness = createHarness();
    const orchestration = completedExecutor("不会执行");
    const run = vi.spyOn(orchestration, "run");
    const application = createApplication(harness.correctness, {
      allocationStrategy: fixedAllocation(1),
      orchestrationExecutor: orchestration,
    });

    await expect(
      application.runPerspectiveTurn({
        conversationId: "conversation-1",
        originalInput: "@ 评估",
        question: "评估",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      stage: "allocation",
      message: "at least 2 perspectives are required.",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("owns pending cancellation, active abort and busy release", async () => {
    const harness = createHarness();
    const results: string[] = [];
    const application = createApplication(harness.correctness);
    const execution = application.createTurnExecution({
      originalInput: "@ 评估",
      question: "评估",
      turnContext: { turnId: "turn-pending" },
      surfacePrincipal: "surface:test",
      source: "channel",
      observer: {
        onResult: ({ result }) => results.push(result.status),
        onPendingCancelled: () => results.push("cancelled"),
      },
    });

    expect(execution.abort()).toBe(true);
    expect(execution.abort()).toBe(false);
    await execution.execute({
      conversationId: "conversation-1",
      turnId: "turn-pending",
    });
    expect(results).toEqual(["aborted"]);
    expect(harness.released).toEqual(["conversation-1"]);

    const pending = application.createTurnExecution({
      originalInput: "@ 稍后评估",
      question: "稍后评估",
      turnContext: { turnId: "turn-queued" },
      surfacePrincipal: "surface:test",
      source: "channel",
      observer: {
        onResult: () => {},
        onPendingCancelled: () => results.push("cancelled"),
      },
    });
    pending.cancelPending({
      conversationId: "conversation-1",
      turnId: "turn-queued",
    });
    expect(results).toEqual(["aborted", "cancelled"]);
  });
});

function createApplication(
  correctness: ConversationPerspectivesCorrectnessPort,
  overrides: Readonly<{
    allocationStrategy?: PerspectiveAllocationStrategy;
    orchestrationExecutor?: PerspectivesOrchestrationExecutor;
    onDurableFinalPublicationDeferred?: (error: unknown) => void;
  }> = {},
): ConversationPerspectivesApplicationService {
  return new ConversationPerspectivesApplicationService({
    correctness,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    allocationStrategy: overrides.allocationStrategy ?? fixedAllocation(3),
    orchestrationExecutor:
      overrides.orchestrationExecutor ?? completedExecutor("最终版本"),
    ...(overrides.onDurableFinalPublicationDeferred
      ? {
          onDurableFinalPublicationDeferred:
            overrides.onDurableFinalPublicationDeferred,
        }
      : {}),
  });
}

function createHarness(options: Readonly<{
  durable?: boolean;
  recordError?: Error;
  publishError?: Error;
}> = {}) {
  const messages: readonly Message[] = Object.freeze([]);
  const runtime: ConversationPerspectivesRuntimePort = Object.freeze({
    conversationId: "conversation-1",
    windowMessages: () => messages,
    turnCount: () => 0,
    estimateMessagesTokens: (input) => Math.max(1, input.length * 10),
    callText: async () => "",
    runOrchestration: async () => orchestrationResult("最终版本"),
  });
  const records: Array<{
    conversationId: string;
    record: RunResult["runRecord"];
    turnId?: string;
  }> = [];
  const durableRunResults: RunResult[] = [];
  const released: string[] = [];
  const publishPendingFinals = vi.fn(async (conversationId: string) => {
    if (options.publishError) throw options.publishError;
    void conversationId;
    return 1;
  });
  const correctness: ConversationPerspectivesCorrectnessPort = Object.freeze({
    usesDurableTurnProtocol: () => options.durable ?? false,
    session: (conversationId) =>
      conversationId === runtime.conversationId ? runtime : undefined,
    runDurable: async (input) => {
      const execution = await input.execute(runtime, {});
      durableRunResults.push(execution.runResult);
      return execution.outcome;
    },
    recordLegacyTurn: async (conversationId, record, turnId) => {
      if (options.recordError) throw options.recordError;
      records.push({ conversationId, record, ...(turnId ? { turnId } : {}) });
    },
    publishPendingFinals,
    releaseBusy: (conversationId) => released.push(conversationId),
  });
  return {
    correctness,
    durableRunResults,
    publishPendingFinals,
    records,
    released,
  };
}

function allocation(count: number) {
  return {
    perspectives: Array.from({ length: count }, (_, index) => ({
      name: `视角${index + 1}`,
      charge: `负责第 ${index + 1} 个判断维度`,
    })),
    usage: { inputTokens: 2, outputTokens: 1 },
  };
}

function fixedAllocation(count: number): PerspectiveAllocationStrategy {
  return { allocate: async () => allocation(count) };
}

function completedExecutor(finalText: string): PerspectivesOrchestrationExecutor {
  return { run: async () => orchestrationResult(finalText) };
}

function failedExecutor(message: string): PerspectivesOrchestrationExecutor {
  return {
    run: async () => ({
      ...orchestrationResult(""),
      status: "failed",
      errors: {
        run: { type: "node_failed", message, origin: "node" },
        nodes: {},
      },
    }),
  };
}

function orchestrationResult(finalText: string) {
  return {
    runId: "orchestration-1",
    definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
    status: "completed" as const,
    outputs: finalText
      ? {
          [PERSPECTIVES_CONVERGENCE_NODE_ID]: {
            nodeId: PERSPECTIVES_CONVERGENCE_NODE_ID,
            format: "text" as const,
            content: finalText,
          },
        }
      : {},
    nodeResults: {},
    errors: { nodes: {} },
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 1,
  };
}
