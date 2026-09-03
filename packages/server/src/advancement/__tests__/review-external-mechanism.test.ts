import { describe, expect, it, vi } from "vitest";
import type {
  AdvancementReviewAttempt,
  AdvancementReviewRootContract,
  AdvancementRunReview,
  AdvancementSession,
} from "@zhixing/core";
import type { ImmediateRootResourceLease } from "@zhixing/core/contracts";
import type {
  AdvancementReviewAttemptInput,
  AdvancementReviewRootBinding,
} from "@zhixing/core/advancement/application";
import {
  AdvancementEvidenceDeferredError,
  type AdvancementEvidenceTarget,
} from "@zhixing/owner-services";
import { createAdvancementReviewExternalMechanism } from "@zhixing/owner-services/advancement/review-external-mechanism";

describe("Advancement review external mechanism", () => {
  it("binds concurrently resolved evidence targets to the originating accepted request", async () => {
    const collect = vi.fn(async () => ({ canonicalEvidence: [] }));
    const evidence = {
      carriedOutcomeRootTarget: vi.fn(() => undefined),
      resolveTarget: vi.fn(async (_conversationId: string, runId: string) =>
        target(runId === "run-1" ? "executor-1" : "executor-2"),
      ),
      collect,
    };
    const mechanism = createAdvancementReviewExternalMechanism({
      evidence,
      reviewer: {
        review: vi.fn(async () => ({
          kind: "deferred" as const,
          cause: "infrastructure" as const,
          reason: "stop",
        })),
      },
    });
    const first = request("run-1", 0);
    const second = request("run-2", 1);

    await mechanism.resolveRootBinding(session(), first);
    await mechanism.resolveRootBinding(session(), second);
    for (const [accepted, runIndex] of [[first, 0], [second, 1]] as const) {
      await mechanism.prepareEvidence({
        session: session(),
        request: accepted,
        attempt: attempt(runIndex),
        rootLease: lease(),
      });
    }

    expect(collect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: expect.objectContaining({ executorId: "executor-1" }),
      }),
    );
    expect(collect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: expect.objectContaining({ executorId: "executor-2" }),
      }),
    );
  });

  it("owns opaque root encoding, persisted materialization, and strict recovery matching", async () => {
    const evidence = {
      carriedOutcomeRootTarget: vi.fn(() => undefined),
      resolveTarget: vi.fn(async () => target("executor-1", 7)),
      collect: vi.fn(async () => ({ canonicalEvidence: [] })),
    };
    const mechanism = createAdvancementReviewExternalMechanism({ evidence });
    const accepted = request("run-1", 0);
    const binding = await mechanism.resolveRootBinding(session(), accepted);
    expect(binding).toEqual(expect.any(String));
    if (!binding) throw new Error("expected review root binding");

    const root = rootContract();
    const materialized = mechanism.materializeReviewRoot({ root, binding });
    expect(materialized).toEqual({
      workload: root.workload,
      budget: root.budget,
      requestId: root.requestId,
      audience: { executorId: "executor-1" },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 7,
      },
    });
    expect(
      mechanism.reviewRootMatchesBinding({ root: materialized, binding }),
    ).toBe(true);

    const changed = createAdvancementReviewExternalMechanism({
      evidence: {
        ...evidence,
        resolveTarget: vi.fn(async () => target("executor-1", 8)),
      },
    });
    const changedBinding = await changed.resolveRootBinding(session(), accepted);
    if (!changedBinding) throw new Error("expected changed review root binding");
    expect(
      mechanism.reviewRootMatchesBinding({
        root: materialized,
        binding: changedBinding,
      }),
    ).toBe(false);
    expect(
      mechanism.reviewRootMatchesBinding({
        root: {
          ...materialized,
          audience: { executorId: "executor-1", extra: true } as never,
        },
        binding,
      }),
    ).toBe(false);

    const forged = "forged" as AdvancementReviewRootBinding;
    expect(() => mechanism.materializeReviewRoot({ root, binding: forged })).toThrow(
      "Advancement review root binding is invalid",
    );
    expect(() =>
      mechanism.reviewRootMatchesBinding({ root: materialized, binding: forged }),
    ).toThrow("Advancement review root binding is invalid");
  });

  it("reconstructs a carried-outcome binding after restart without live target resolution", async () => {
    const resolveTarget = vi.fn(async () => target("wrong-executor", 99));
    const mechanism = createAdvancementReviewExternalMechanism({
      evidence: {
        carriedOutcomeRootTarget: vi.fn(() => ({
          executorId: "executor-1",
          ownerEpoch: 7,
        })),
        resolveTarget,
        collect: vi.fn(async () => ({ canonicalEvidence: [] })),
      },
    });
    const binding = await mechanism.resolveRootBinding(
      session(),
      request("run-1", 0),
    );
    if (!binding) throw new Error("expected carried review root binding");

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(
      mechanism.reviewRootMatchesBinding({
        root: {
          ...rootContract(),
          audience: { executorId: "executor-1" },
          scopeBinding: {
            kind: "conversation",
            conversationId: "conversation-1",
            ownerEpoch: 7,
          },
        },
        binding,
      }),
    ).toBe(true);
  });

  it("preserves external failure classes and validates the accepted run binding", async () => {
    const accepted = request("run-1", 0);
    const mechanism = createAdvancementReviewExternalMechanism({
      evidence: {
        carriedOutcomeRootTarget: vi.fn(() => undefined),
        resolveTarget: vi.fn(async () => undefined),
        collect: vi.fn(async () => {
          throw new AdvancementEvidenceDeferredError("offline");
        }),
      },
      reviewer: {
        review: vi.fn(async () => ({
          kind: "reviewed" as const,
          review: review({ runIndex: 1 }),
        })),
      },
    });

    await expect(
      mechanism.prepareEvidence({
        session: session(),
        request: accepted,
        attempt: attempt(0),
        rootLease: lease(),
      }),
    ).resolves.toMatchObject({ kind: "deferred", cause: "aborted" });
    await expect(
      mechanism.invokeReviewer({
        session: session(),
        rubric: session().confirmedRubric!,
        request: accepted,
        attempt: attempt(0),
        rootLease: lease(),
      }),
    ).rejects.toThrow("does not match accepted runIndex");
  });
});

function request(runId: string, runIndex: number) {
  return Object.freeze({
    conversationId: "conversation-1",
    runId,
    runIndex,
    runRecord: { timestamp: "2026-08-31T00:00:00.000Z", messages: [] },
    runRecordRef: { shardId: "000001", runIndex },
  }) satisfies AdvancementReviewAttemptInput & {
    readonly runRecordRef: { readonly shardId: string; readonly runIndex: number };
  };
}

function session(): AdvancementSession {
  return {
    id: "advancement-1",
    conversationId: "conversation-1",
    status: "active",
    originalUserTask: { parts: [{ type: "text", text: "finish" }] },
    confirmedRubric: {
      source: { kind: "local-draft", draftId: "draft-1" },
      title: "review",
      content: {
        passCriteria: ["done"],
        evidenceRequirements: [],
        failureHandling: [],
      },
      confirmedAt: "2026-08-31T00:00:00.000Z",
    },
    rubricDraftVersion: 1,
    runs: [],
    proxyMessages: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function attempt(runIndex: number): AdvancementReviewAttempt {
  return {
    lineageId: `lineage-${runIndex}`,
    generation: 1,
    runId: `run-${runIndex + 1}`,
    runIndex,
    runRecordRef: { shardId: "000001", runIndex },
    phase: "started",
    root: {
      requestId: `request-${runIndex}`,
      workload: { kind: "control", id: `review-${runIndex}`, attempt: 1 },
      budget: { maxCalls: 1, maxTokens: 1 },
      audience: { executorId: "executor-1" },
      scopeBinding: { kind: "control", subject: `review-${runIndex}` },
    },
  };
}

function lease(): ImmediateRootResourceLease {
  return { digest: "sha256:test" } as ImmediateRootResourceLease;
}

function target(executorId: string, ownerEpoch = 1): AdvancementEvidenceTarget {
  return {
    executorId,
    ownerEpoch,
    descriptor: { executorId } as AdvancementEvidenceTarget["descriptor"],
  };
}

function rootContract(): AdvancementReviewRootContract {
  return {
    workload: { kind: "control", id: "review-1", attempt: 1 },
    budget: { maxCalls: 8, maxTokens: 300_000 },
    requestId: "review-1:root",
  };
}

function review(overrides: Partial<AdvancementRunReview> = {}): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 0,
    runRecordRef: { shardId: "000001", runIndex: 0 },
    reviewedAt: "2026-08-31T00:00:00.000Z",
    decision: "passed",
    evidence: [],
    attribution: { criteria: [] },
    unmetCriteria: [],
    ...overrides,
  };
}
