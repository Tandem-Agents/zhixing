import path from "node:path";
import {
  MockLLMProvider,
  advancementReviewAttemptId,
  advancementReviewLineageId,
  advancementReviewRootRequestId,
  type AdvancementReviewAttempt,
  type ConfirmedRubricSnapshot,
  type RunRecordInput,
} from "@zhixing/core";
import { AdvancementStore } from "../../../../core/src/advancement/store.js";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  ImmediateRootResourceLease,
  ResourceReservationPort,
  Signature,
} from "@zhixing/core/contracts";
import {
  createSignedCapabilityDescriptor,
  protocolDigest,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  ADVANCEMENT_SUBMIT_REVIEW_TOOL,
  createAdvancementRuntime,
} from "@zhixing/orchestrator/advancement";
import { AnchorResourceGovernor } from "@zhixing/owner-kernel";
import {
  AdvancementEvidenceCoordinator,
} from "@zhixing/owner-services";
import { createAdvancementReviewAttemptApplication } from "@zhixing/owner-services/advancement/review-attempt-correctness";
import { createAdvancementReviewExternalMechanism } from "@zhixing/owner-services/advancement/review-external-mechanism";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";

const NOW = "2026-08-04T00:00:00.000Z";
const RUN_REF = { shardId: "000001", runIndex: 0 } as const;
const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "executor-1",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};
const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    if (signature.sig !== protocolDigest(schemaId, version, payload)) {
      throw new TypeError("signature mismatch");
    }
  },
};

class CrashAfterInvokingStore extends AdvancementStore {
  #crash = true;

  override async transitionReviewAttempt(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementReviewAttempt,
    timestamp?: string,
  ) {
    const session = await super.transitionReviewAttempt(
      conversationId,
      sessionId,
      attempt,
      timestamp,
    );
    if (this.#crash && attempt.phase === "invoking") {
      this.#crash = false;
      throw new Error("simulated process crash after invoking");
    }
    return session;
  }
}

class CrashBeforeReviewCommitStore extends AdvancementStore {
  #crash = true;

  override async appendTerminalRunReview(
    ...args: Parameters<AdvancementStore["appendTerminalRunReview"]>
  ) {
    if (this.#crash) {
      this.#crash = false;
      throw new Error("simulated process crash before review commit");
    }
    return await super.appendTerminalRunReview(...args);
  }
}

class HoldDeferredTransitionStore extends AdvancementStore {
  readonly deferredReached: Promise<void>;
  readonly #resumeDeferred: Promise<void>;
  #markDeferred!: () => void;
  #releaseDeferred!: () => void;
  #hold = true;

  constructor(root: string) {
    super(root);
    this.deferredReached = new Promise<void>((resolve) => {
      this.#markDeferred = resolve;
    });
    this.#resumeDeferred = new Promise<void>((resolve) => {
      this.#releaseDeferred = resolve;
    });
  }

  releaseDeferred(): void {
    this.#releaseDeferred();
  }

  override async transitionReviewAttempt(
    ...args: Parameters<AdvancementStore["transitionReviewAttempt"]>
  ) {
    if (
      this.#hold &&
      args[2].phase === "deferred" &&
      args[2].detail === "review deferred"
    ) {
      this.#hold = false;
      this.#markDeferred();
      await this.#resumeDeferred;
    }
    return await super.transitionReviewAttempt(...args);
  }
}

describe("advancement review attempt production recovery", { timeout: 30_000 }, () => {
  it("never replays an invoking root and eventually commits one review with the real governor and metered reviewer", async () => {
    const root = await createTempDir("advancement-review-attempt");
    const store = new CrashAfterInvokingStore(path.join(root, "advancement"));
    await makeActive(store);

    const governor = createGovernor(root);
    const resources = loseFirstAcquireResponse(governor);
    const provider = new MockLLMProvider([{
      toolCalls: [{
        id: "review-call-1",
        name: ADVANCEMENT_SUBMIT_REVIEW_TOOL,
        input: {
          decision: "passed",
          evidenceIds: [],
          criteria: [
            { criterionId: "pc-1", verdict: "met", reason: "任务已完成。" },
            { criterionId: "pc-2", verdict: "met", reason: "结果符合要求。" },
          ],
        },
      }],
    }]);
    const reviewer = createAdvancementRuntime({
      provider,
      model: "mock-model",
      resourceMeter: resources,
      now: () => new Date(NOW),
      idGenerator: () => "review-1",
    });
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources,
      resolveTarget: async () => undefined,
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const input = {
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    } as const;

    const firstReviews = reviewAttemptApplication(store, resources, {
      reviewer,
      evidence,
    });
    await expect(firstReviews.reviewAcceptedRun(input)).rejects.toThrow(
      "simulated process crash after invoking",
    );
    expect(provider.callCount).toBe(0);

    const recoveredReviews = reviewAttemptApplication(store, resources, {
      reviewer,
      evidence,
    });
    const result = await recoveredReviews.reviewAcceptedRun(input);

    expect(result.kind, JSON.stringify(result)).toBe("completed");
    expect(provider.callCount).toBe(1);
    const session = await store.loadSession("conversation-1", "session-1");
    expect(session?.status).toBe("completed");
    expect(session?.runs).toHaveLength(1);
    expect(session?.reviewAttempts).toEqual([
      expect.objectContaining({ generation: 2, phase: "consumed" }),
    ]);

    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    const workload = (generation: number) => ({
      kind: "control" as const,
      id: advancementReviewAttemptId(lineageId, generation),
      attempt: 1,
    });
    await expect(governor.inspectImmediateRoot(workload(1))).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });
    await expect(governor.inspectImmediateRoot(workload(2))).resolves.toMatchObject({
      kind: "reservation",
      state: "settled",
    });

    const cleanupReviews = reviewAttemptApplication(store, resources, {
      reviewer,
      evidence,
    });
    await cleanupReviews.reconcileConversation("conversation-1");
    await expect(store.loadActiveSession("conversation-1")).resolves.toBeNull();
    await expect(governor.inspectImmediateRoot(workload(2))).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });
    expect(provider.callCount).toBe(1);
  });

  it("moves to a new root when provider usage completed before the review commit crashed", async () => {
    const root = await createTempDir("advancement-review-attempt-provider-crash");
    const store = new CrashBeforeReviewCommitStore(path.join(root, "advancement"));
    await makeActive(store);

    const governor = createGovernor(root);
    const provider = new MockLLMProvider([
      passedReviewResponse("review-call-1"),
      passedReviewResponse("review-call-2"),
    ]);
    const reviewer = createAdvancementRuntime({
      provider,
      model: "mock-model",
      resourceMeter: governor,
      now: () => new Date(NOW),
      idGenerator: () => "review-1",
    });
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources: governor,
      resolveTarget: async () => undefined,
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const input = {
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    } as const;

    const firstReviews = reviewAttemptApplication(store, governor, {
      reviewer,
      evidence,
    });
    await expect(firstReviews.reviewAcceptedRun(input)).rejects.toThrow(
      "simulated process crash before review commit",
    );
    expect(provider.callCount).toBe(1);
    await expect(store.loadSession("conversation-1", "session-1")).resolves.toMatchObject({
      status: "active",
      runs: [],
      reviewAttempts: [expect.objectContaining({ generation: 1, phase: "invoking" })],
    });

    const recoveredReviews = reviewAttemptApplication(store, governor, {
      reviewer,
      evidence,
    });
    const result = await recoveredReviews.reviewAcceptedRun(input);

    expect(result.kind).toBe("completed");
    expect(provider.callCount).toBe(2);
    const session = await store.loadSession("conversation-1", "session-1");
    expect(session).toMatchObject({
      status: "completed",
      runs: [expect.objectContaining({ id: "review-1" })],
      reviewAttempts: [expect.objectContaining({ generation: 2, phase: "consumed" })],
    });

    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    const workload = (generation: number) => ({
      kind: "control" as const,
      id: advancementReviewAttemptId(lineageId, generation),
      attempt: 1,
    });
    await expect(governor.inspectImmediateRoot(workload(1))).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });
    await expect(governor.inspectImmediateRoot(workload(2))).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });
  });

  it("settles reserved provider usage before advancing after a stream failure", async () => {
    const root = await createTempDir("advancement-review-attempt-open-usage");
    const store = new AdvancementStore(path.join(root, "advancement"));
    await makeActive(store);

    const governor = createGovernor(root);
    const provider = new MockLLMProvider([
      { error: new Error("provider unavailable") },
      passedReviewResponse("review-call-2"),
    ]);
    const reviewer = createAdvancementRuntime({
      provider,
      model: "mock-model",
      resourceMeter: governor,
      now: () => new Date(NOW),
      idGenerator: () => "review-1",
    });
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources: governor,
      resolveTarget: async () => undefined,
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const reviews = reviewAttemptApplication(store, governor, {
      reviewer,
      evidence,
    });
    const input = {
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    } as const;

    await expect(reviews.reviewAcceptedRun(input)).resolves.toMatchObject({
      kind: "review-deferred",
      cause: "infrastructure",
    });
    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    const workload = (generation: number) => ({
      kind: "control" as const,
      id: advancementReviewAttemptId(lineageId, generation),
      attempt: 1,
    });
    await expect(governor.inspectImmediateRoot(workload(1))).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });

    await expect(reviews.reviewAcceptedRun(input)).resolves.toMatchObject({
      kind: "completed",
    });
    expect(provider.callCount).toBe(2);
    await expect(store.loadSession("conversation-1", "session-1")).resolves.toMatchObject({
      status: "completed",
      runs: [expect.objectContaining({ id: "review-1" })],
      reviewAttempts: [expect.objectContaining({ generation: 2, phase: "consumed" })],
    });
    await expect(governor.inspectImmediateRoot(workload(2))).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });
  });

  it("expires a started attempt whose target changed without invoking its frozen root", async () => {
    const root = await createTempDir("advancement-review-attempt-target-drift");
    const store = new AdvancementStore(path.join(root, "advancement"));
    await makeActive(store);

    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    const id = advancementReviewAttemptId(lineageId, 1);
    await store.transitionReviewAttempt("conversation-1", "session-1", {
      lineageId,
      generation: 1,
      runId: "run-1",
      runIndex: 0,
      runRecordRef: RUN_REF,
      phase: "started",
      root: {
        workload: { kind: "control", id, attempt: 1 },
        budget: { maxCalls: 8, maxTokens: 300_000 },
        requestId: advancementReviewRootRequestId(lineageId, 1),
        audience: { executorId: "executor-1" },
        scopeBinding: {
          kind: "conversation",
          conversationId: "conversation-1",
          ownerEpoch: 2,
        },
      },
    }, NOW);

    const governor = createGovernor(root);
    const provider = new MockLLMProvider([passedReviewResponse("review-call-1")]);
    const reviewer = createAdvancementRuntime({
      provider,
      model: "mock-model",
      resourceMeter: governor,
      now: () => new Date(NOW),
      idGenerator: () => "review-1",
    });
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources: governor,
      resolveTarget: async () => evidenceTarget(1),
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const reviews = reviewAttemptApplication(store, governor, {
      reviewer,
      evidence,
    });
    const input = {
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    } as const;

    const drifted = await reviews.reviewAcceptedRun(input);
    expect(drifted.kind).toBe("review-deferred");
    expect(provider.callCount).toBe(0);
    await expect(store.loadSession("conversation-1", "session-1")).resolves.toMatchObject({
      reviewAttempts: [expect.objectContaining({ generation: 1, phase: "expired" })],
    });
  });

  it("rechecks the owner after acquire so cancellation wins before external review", async () => {
    const root = await createTempDir("advancement-review-attempt-cancel-race");
    const store = new AdvancementStore(path.join(root, "advancement"));
    await makeActive(store);

    const governor = createGovernor(root);
    const held = holdFirstAcquireResponse(governor);
    const provider = new MockLLMProvider([passedReviewResponse("review-call-1")]);
    const reviewer = createAdvancementRuntime({
      provider,
      model: "mock-model",
      resourceMeter: held.resources,
      now: () => new Date(NOW),
      idGenerator: () => "review-1",
    });
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources: held.resources,
      resolveTarget: async () => undefined,
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const reviews = reviewAttemptApplication(store, held.resources, {
      reviewer,
      evidence,
    });
    const review = reviews.reviewAcceptedRun({
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    });

    await held.acquired;
    await reviews.cancelSession({
      conversationId: "conversation-1",
      advancementSessionId: "session-1",
      reason: "user-cancelled",
      message: "用户停止推进",
    });
    held.releaseResponse();

    await expect(review).resolves.toMatchObject({ kind: "review-deferred" });
    expect(provider.callCount).toBe(0);
    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    await expect(governor.inspectImmediateRoot({
      kind: "control",
      id: advancementReviewAttemptId(lineageId, 1),
      attempt: 1,
    })).resolves.toMatchObject({ kind: "reservation", state: "released" });
    await expect(store.loadSession("conversation-1", "session-1")).resolves.toMatchObject({
      status: "cancelled",
      reviewAttempts: [expect.objectContaining({ phase: "expired" })],
    });
  });

  it("drives a queued root to a durable terminal before cancellation completes", async () => {
    const root = await createTempDir("advancement-review-attempt-queued-cancel");
    const store = new AdvancementStore(path.join(root, "advancement"));
    await makeActive(store);

    const governor = createGovernor(root);
    const held = holdFirstAcquireAfterQueue(governor);
    const provider = new MockLLMProvider([passedReviewResponse("review-call-1")]);
    const reviewer = createAdvancementRuntime({
      provider,
      model: "mock-model",
      resourceMeter: held.resources,
      now: () => new Date(NOW),
      idGenerator: () => "review-1",
    });
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources: held.resources,
      resolveTarget: async () => undefined,
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const reviews = reviewAttemptApplication(store, held.resources, {
      reviewer,
      evidence,
    });
    const review = reviews.reviewAcceptedRun({
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    });

    await held.queued;
    await reviews.cancelSession({
      conversationId: "conversation-1",
      advancementSessionId: "session-1",
      reason: "user-cancelled",
      message: "用户停止推进",
    });
    held.releaseAcquire();

    await expect(review).resolves.toMatchObject({ kind: "review-deferred" });
    expect(provider.callCount).toBe(0);
    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    await expect(governor.inspectImmediateRoot({
      kind: "control",
      id: advancementReviewAttemptId(lineageId, 1),
      attempt: 1,
    })).resolves.toMatchObject({ kind: "reservation", state: "released" });
    await expect(store.loadSession("conversation-1", "session-1")).resolves.toMatchObject({
      status: "cancelled",
      reviewAttempts: [expect.objectContaining({ phase: "expired" })],
    });
  });

  it("lets the first durable terminal win when cancellation races reviewer deferral", async () => {
    const root = await createTempDir("advancement-review-attempt-terminal-race");
    const store = new HoldDeferredTransitionStore(path.join(root, "advancement"));
    await makeActive(store);

    const governor = createGovernor(root);
    const reviewer = {
      review: async () => ({
        kind: "deferred" as const,
        cause: "infrastructure" as const,
        reason: "review deferred",
      }),
    };
    const evidence = new AdvancementEvidenceCoordinator({
      store,
      resources: governor,
      resolveTarget: async () => undefined,
      clientFor: () => undefined,
      signer,
      verifier,
      now: () => NOW,
    });
    const reviews = reviewAttemptApplication(store, governor, {
      reviewer,
      evidence,
    });
    const review = reviews.reviewAcceptedRun({
      conversationId: "conversation-1",
      runId: "run-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: RUN_REF,
    });

    await store.deferredReached;
    await reviews.cancelSession({
      conversationId: "conversation-1",
      advancementSessionId: "session-1",
      reason: "user-cancelled",
      message: "用户停止推进",
    });
    store.releaseDeferred();

    await expect(review).resolves.toMatchObject({ kind: "review-deferred" });
    await expect(store.loadSession("conversation-1", "session-1")).resolves.toMatchObject({
      status: "cancelled",
      reviewAttempts: [expect.objectContaining({ phase: "deferred" })],
    });
    const lineageId = advancementReviewLineageId("session-1", RUN_REF);
    await expect(governor.inspectImmediateRoot({
      kind: "control",
      id: advancementReviewAttemptId(lineageId, 1),
      attempt: 1,
    })).resolves.toMatchObject({ kind: "reservation", state: "released" });
  });
});

function createGovernor(root: string): AnchorResourceGovernor {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => new Date().toISOString(),
  });
  onTestFinished(() => log.stopStorageMaintenance());
  return new AnchorResourceGovernor({
    log,
    signer,
    verifier,
    guard: { assert() {} },
    anchorEpoch: 1,
    localExecutorId: "executor-1",
    reporterKeyFor: () => "executor-1",
    clock: () => new Date().toISOString(),
  });
}

function reviewAttemptApplication(
  store: AdvancementStore,
  resources: ResourceReservationPort,
  mechanismOptions: Parameters<
    typeof createAdvancementReviewExternalMechanism
  >[0],
) {
  return createAdvancementReviewAttemptApplication({
    store,
    resources,
    mechanism: createAdvancementReviewExternalMechanism(mechanismOptions),
    reviewerAvailable: true,
    now: () => NOW,
  });
}

function loseFirstAcquireResponse(
  governor: AnchorResourceGovernor,
): ResourceReservationPort {
  let loseResponse = true;
  let failConsumedRelease = true;
  return {
    enqueueRoot: (...args) => governor.enqueueRoot(...args),
    prepareAssignmentRoot: (...args) => governor.prepareAssignmentRoot(...args),
    prepareSystemJobRoot: (...args) => governor.prepareSystemJobRoot(...args),
    acquireRoot: async (...args) => {
      const lease = await governor.acquireRoot(...args);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("simulated acquire response loss");
      }
      return lease;
    },
    inspectImmediateRoot: (workload) => governor.inspectImmediateRoot(workload),
    acquireChild: (...args) => governor.acquireChild(...args),
    reserveUsage: (...args) => governor.reserveUsage(...args),
    consume: (...args) => governor.consume(...args),
    settle: (...args) => governor.settle(...args),
    release: async (lease, ctx) => {
      if (
        failConsumedRelease &&
        lease.workload.id.endsWith(":generation:2")
      ) {
        failConsumedRelease = false;
        throw new Error("simulated crash before consumed root release");
      }
      await governor.release(lease, ctx);
    },
    reclaim: (lease) => governor.reclaim(lease),
  };
}

function holdFirstAcquireResponse(governor: AnchorResourceGovernor): {
  readonly resources: ResourceReservationPort;
  readonly acquired: Promise<void>;
  readonly releaseResponse: () => void;
} {
  let markAcquired!: () => void;
  let releaseResponse!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const resources: ResourceReservationPort = {
    enqueueRoot: (...args) => governor.enqueueRoot(...args),
    prepareAssignmentRoot: (...args) => governor.prepareAssignmentRoot(...args),
    prepareSystemJobRoot: (...args) => governor.prepareSystemJobRoot(...args),
    acquireRoot: async (...args) => {
      const lease = await governor.acquireRoot(...args);
      markAcquired();
      await held;
      return lease;
    },
    inspectImmediateRoot: (workload) => governor.inspectImmediateRoot(workload),
    acquireChild: (...args) => governor.acquireChild(...args),
    reserveUsage: (...args) => governor.reserveUsage(...args),
    consume: (...args) => governor.consume(...args),
    settle: (...args) => governor.settle(...args),
    release: (...args) => governor.release(...args),
    reclaim: (lease) => governor.reclaim(lease),
  };
  return { resources, acquired, releaseResponse };
}

function holdFirstAcquireAfterQueue(governor: AnchorResourceGovernor): {
  readonly resources: ResourceReservationPort;
  readonly queued: Promise<void>;
  readonly releaseAcquire: () => void;
} {
  let first = true;
  let markQueued!: () => void;
  let releaseAcquire!: () => void;
  const queued = new Promise<void>((resolve) => {
    markQueued = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseAcquire = resolve;
  });
  const resources: ResourceReservationPort = {
    enqueueRoot: (...args) => governor.enqueueRoot(...args),
    prepareAssignmentRoot: (...args) => governor.prepareAssignmentRoot(...args),
    prepareSystemJobRoot: (...args) => governor.prepareSystemJobRoot(...args),
    acquireRoot: async (...args) => {
      if (first) {
        first = false;
        const [workload, , origin, ctx] = args;
        const reservationId = `reservation:${protocolDigest(
          "ImmediateResourceReservation",
          1,
          workload,
        ).slice("sha256:".length)}`;
        await governor.enqueueRoot(reservationId, workload, origin, ctx);
        markQueued();
        await held;
      }
      return await governor.acquireRoot(...args);
    },
    inspectImmediateRoot: (workload) => governor.inspectImmediateRoot(workload),
    acquireChild: (...args) => governor.acquireChild(...args),
    reserveUsage: (...args) => governor.reserveUsage(...args),
    consume: (...args) => governor.consume(...args),
    settle: (...args) => governor.settle(...args),
    release: (...args) => governor.release(...args),
    reclaim: (lease) => governor.reclaim(lease),
  };
  return { resources, queued, releaseAcquire };
}

async function makeActive(store: AdvancementStore): Promise<void> {
  const originalUserTask = {
    parts: [{ type: "text" as const, text: "完成任务并核对结果" }],
  };
  await store.createSession({
    id: "session-1",
    conversationId: "conversation-1",
    originalUserTask,
    pendingRubricDraft: {
      draftId: "draft-1",
      originalTurnId: "turn-1",
      source: "generated",
      candidateRubricIds: [],
      title: "任务验收",
      description: "核对任务是否完成",
      content: {
        passCriteria: ["任务已完成", "结果符合要求"],
        evidenceRequirements: [],
        failureHandling: [{ id: "retry", scenario: "未完成", reply: "继续完成任务。" }],
      },
      createdAt: NOW,
    },
    createdAt: NOW,
  });
  await store.confirmRubric(
    "conversation-1",
    "session-1",
    confirmedRubric(),
    {
      turnId: "turn-1",
      surfacePrincipal: "surface:test",
      turnOrigin: { channel: "rpc", triggeredBy: "surface:test" },
      inputDigest: protocolDigest("AdvancementOriginalTaskInput", 1, originalUserTask),
    },
    NOW,
  );
}

function confirmedRubric(): ConfirmedRubricSnapshot {
  return {
    source: { kind: "local-draft", snapshotId: "draft-1", contentDigest: protocolDigest("draft", 1, {}) },
    title: "任务验收",
    description: "核对任务是否完成",
    content: {
      passCriteria: [
        { id: "pc-1", text: "任务已完成" },
        { id: "pc-2", text: "结果符合要求" },
      ],
      evidenceRequirements: [],
      failureHandling: [{ id: "retry", scenario: "未完成", reply: "继续完成任务。" }],
    },
    confirmedAt: NOW,
    confirmedBy: "user",
  };
}

function passedReviewResponse(callId: string) {
  return {
    toolCalls: [{
      id: callId,
      name: ADVANCEMENT_SUBMIT_REVIEW_TOOL,
      input: {
        decision: "passed",
        evidenceIds: [],
        criteria: [
          { criterionId: "pc-1", verdict: "met", reason: "任务已完成。" },
          { criterionId: "pc-2", verdict: "met", reason: "结果符合要求。" },
        ],
      },
    }],
  };
}

function evidenceTarget(ownerEpoch: number) {
  return {
    ownerEpoch,
    executorId: "executor-1",
    descriptor: createSignedCapabilityDescriptor({
      v: 1,
      executorId: "executor-1",
      revision: 1,
      protocolVersion: "1",
      workspaces: [],
      tools: [],
      mcpServers: [],
      credentialBindings: [],
      evidenceCapabilities: [],
      at: NOW,
    }, signer),
  };
}

function runRecord(): RunRecordInput {
  return {
    timestamp: NOW,
    messages: [
      { role: "user", content: [{ type: "text", text: "完成任务" }] },
      { role: "assistant", content: [{ type: "text", text: "任务已经完成。" }] },
    ],
  };
}
