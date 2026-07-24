import {
  AuthorityStorageError,
  type ArtifactStore,
} from "@zhixing/core/authority";
import type {
  AuthorityCapability,
  DispatchEnvelope,
  ExecutionAbortRequest,
  SealedBundle,
} from "@zhixing/core/contracts";
import {
  InProcessAssignmentSubmission,
  type ConversationAssignmentLedger,
} from "@zhixing/executor";
import type { RuntimeFactory } from "@zhixing/owner-kernel";
import { MeshProtocolError } from "@zhixing/mesh/errors";
import {
  StreamDigestChain,
  type StreamFrameMeta,
} from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConversationAssignmentWorker } from "./conversation-assignment-worker.js";
import type { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";

function interactionObserver(): DurableConversationInteractionObserver {
  return {
    withBinding: vi.fn((_binding: unknown, operation: () => Promise<unknown>) => operation()),
    drainAssignment: vi.fn(async () => undefined),
    releaseAssignment: vi.fn(),
  } as unknown as DurableConversationInteractionObserver;
}

describe("ConversationAssignmentWorker", () => {
  it("does not execute after the owner durably rejects the started observation", async () => {
    const assignmentId = "asg-worker-start-rejected";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const runtimeFactory = {
      create: vi.fn(),
    } as unknown as RuntimeFactory;
    const rejection = new TypeError("started observation rejected");
    const onError = vi.fn();
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: {
        start: vi.fn(async () => ({ started: true })),
      } as unknown as ConversationAssignmentLedger,
      runtimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(async () => { throw rejection; }),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
      onError,
    });

    worker.accept(envelope);
    await worker.drain();

    expect(runtimeFactory.create).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(assignmentId, rejection);
  });

  it("durably terminates an assignment when runtime creation fails", async () => {
    const assignmentId = "asg-worker-create-failure";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
      work: {
        conversationId: "conversation-worker-create-failure",
        ingress: { kind: "first-party" },
      },
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const failExecution = vi.fn(async () => undefined);
    const ledger = {
      start: vi.fn(async () => ({ started: true })),
      closePendingInteractionsForRunEnd: vi.fn(async () => 0),
      pendingInteractionMirrorBatch: vi.fn(async () => undefined),
      hasPendingTicketCancellation: vi.fn(async () => false),
      failExecution,
    } as unknown as ConversationAssignmentLedger;
    const runtimeFailure = new Error("runtime factory unavailable");
    const onError = vi.fn();
    const finalizeUsage = vi.fn()
      .mockRejectedValueOnce(new MeshProtocolError("service-failed", "Mesh service failed"))
      .mockResolvedValueOnce({ reportDigest: "sha256:usage", upToUsageSeq: 0 });
    const interactions = interactionObserver();
    const drainAssignment = vi.mocked(interactions.drainAssignment)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("temporary stream projection failure"))
      .mockResolvedValue(undefined);
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {
        create: vi.fn(async () => { throw runtimeFailure; }),
      } as unknown as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(async () => undefined),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage,
      interactions,
      onError,
    });

    worker.accept(envelope);
    await worker.drain();

    expect(failExecution).toHaveBeenCalledWith(assignmentId, {
      reason: runtimeFailure.message,
      usageFinal: { reportDigest: "sha256:usage", upToUsageSeq: 0 },
    });
    expect(finalizeUsage).toHaveBeenCalledTimes(2);
    expect(drainAssignment).toHaveBeenCalledTimes(3);
    expect(ledger.closePendingInteractionsForRunEnd).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(assignmentId, runtimeFailure);
  });

  it("durably terminates an assignment when its stream cannot be opened", async () => {
    const assignmentId = "asg-worker-stream-open-failure";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
      work: {
        conversationId: "conversation-worker-stream-open-failure",
        runId: "run-worker-stream-open-failure",
        ownerEpoch: 1,
        ingress: { kind: "first-party" },
      },
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const streamFailure = new Error("stream storage unavailable");
    const failExecution = vi.fn(async () => undefined);
    const runtimeFactory = { create: vi.fn() } as unknown as RuntimeFactory;
    const onError = vi.fn();
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: {
        start: vi.fn(async () => ({ started: true })),
        closePendingInteractionsForRunEnd: vi.fn(async () => 0),
        pendingInteractionMirrorBatch: vi.fn(async () => undefined),
        hasPendingTicketCancellation: vi.fn(async () => false),
        failExecution,
      } as unknown as ConversationAssignmentLedger,
      runtimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(async () => undefined),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(async () => ({
        reportDigest: "sha256:usage",
        upToUsageSeq: 0,
      })),
      interactions: interactionObserver(),
      createStream: vi.fn(async () => {
        throw streamFailure;
      }),
      onError,
    });

    worker.accept(envelope);
    await worker.drain();

    expect(runtimeFactory.create).not.toHaveBeenCalled();
    expect(failExecution).toHaveBeenCalledWith(assignmentId, {
      reason: streamFailure.message,
      usageFinal: { reportDigest: "sha256:usage", upToUsageSeq: 0 },
    });
    expect(onError).toHaveBeenCalledWith(assignmentId, streamFailure);
  });

  it("redrives sealed executor-owned bundles after restart", async () => {
    const assignmentId = "asg-worker-recovery";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{} as AuthorityCapability],
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const bundle = { assignmentId } as SealedBundle;
    const acknowledge = vi.fn(async () => undefined);
    const ledger = {
      recoverableConversationAssignments: vi.fn(async () => [envelope]),
      recoverableConversationCancellations: vi.fn(async () => []),
      start: vi.fn(async () => ({ started: false })),
      sealedBundleForRecovery: vi.fn(async () => ({ kind: "sealed", bundle })),
      acknowledge,
    } as unknown as ConversationAssignmentLedger;
    const submitBundle = vi.fn(async () => ({
      committed: true as const,
      commitRevision: 7,
    }));
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle,
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
    });

    await expect(worker.recover()).resolves.toBe(1);
    await worker.drain();

    expect(submitBundle).toHaveBeenCalledWith(
      bundle,
      expect.objectContaining({ requestId: `submission:${assignmentId}` }),
    );
    expect(acknowledge).toHaveBeenCalledWith(assignmentId, 7);
  });

  it.each([
    [
      "a retryable authority rejection",
      { committed: false as const, error: {
        code: "busy" as const,
        message: "owner is busy",
        retryable: true,
      } },
    ],
    [
      "an unknown remote service result",
      new MeshProtocolError("service-failed", "Mesh service failed"),
    ],
  ])("keeps sealed submission obligations after %s", async (_label, firstOutcome) => {
    const assignmentId = `asg-worker-retry-${String(_label).replaceAll(" ", "-")}`;
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{} as AuthorityCapability],
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const bundle = { assignmentId } as SealedBundle;
    const acknowledge = vi.fn(async () => undefined);
    const ledger = {
      recoverableConversationAssignments: vi.fn(async () => [envelope]),
      recoverableConversationCancellations: vi.fn(async () => []),
      start: vi.fn(async () => ({ started: false })),
      sealedBundleForRecovery: vi.fn(async () => ({ kind: "sealed", bundle })),
      acknowledge,
    } as unknown as ConversationAssignmentLedger;
    const submitBundle = vi.fn()
      .mockImplementationOnce(async () => {
        if (firstOutcome instanceof Error) throw firstOutcome;
        return firstOutcome;
      })
      .mockResolvedValueOnce({ committed: true, commitRevision: 8 });
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle,
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
    });

    await worker.recover();
    await worker.drain();

    expect(submitBundle).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledWith(assignmentId, 8);
  });

  it("terminates a sealed submission only after an explicit stable authority rejection", async () => {
    const assignmentId = "asg-worker-stable-rejection";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{} as AuthorityCapability],
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const onError = vi.fn();
    const submitBundle = vi.fn(async () => ({
      committed: false as const,
      error: { code: "invalid" as const, message: "invalid bundle", retryable: false },
    }));
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: {
        recoverableConversationAssignments: vi.fn(async () => [envelope]),
        recoverableConversationCancellations: vi.fn(async () => []),
        start: vi.fn(async () => ({ started: false })),
        sealedBundleForRecovery: vi.fn(async () => ({
          kind: "sealed",
          bundle: { assignmentId } as SealedBundle,
        })),
        acknowledge: vi.fn(),
      } as unknown as ConversationAssignmentLedger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle,
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
      onError,
    });

    await worker.recover();
    await worker.drain();

    expect(submitBundle).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      assignmentId,
      expect.objectContaining({ message: "Conversation commit rejected: invalid bundle" }),
    );
  });

  it("propagates durable remote cancellation into the active runtime", async () => {
    const assignmentId = "asg-worker-cancel";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
      permissionLease: {},
      resourceLease: {},
      work: {
        conversationId: "conversation-worker-cancel",
        runId: "run-worker-cancel",
        baseRevision: 2,
        ingress: {
          kind: "first-party",
          surfacePrincipal: "surface:test",
          deviceId: "device-owner",
          ingressId: "ingress-worker-cancel",
          receivedAt: new Date().toISOString(),
        },
        windowInput: { t: "full", windowEpoch: 3, messages: [] },
      },
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const failExecution = vi.fn(async () => undefined);
    const ledger = {
      start: vi.fn(async () => ({ started: true })),
      closePendingInteractionsForRunEnd: vi.fn(async () => 0),
      pendingInteractionMirrorBatch: vi.fn(async () => undefined),
      hasPendingTicketCancellation: vi.fn(async () => false),
      failExecution,
    } as unknown as ConversationAssignmentLedger;
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn(async function* (
      _messages: unknown,
      options: { abortSignal?: AbortSignal },
    ) {
      observedSignal = options.abortSignal;
      await new Promise<void>((resolve) => {
        if (options.abortSignal?.aborted) resolve();
        else options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { agentResult: { reason: "aborted" } };
    });
    const interactions = interactionObserver();
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {
        create: vi.fn(async () => ({ run, dispose: vi.fn(async () => undefined) })),
      } as unknown as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(async () => undefined),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(async () => ({ reportDigest: "sha256:usage", upToUsageSeq: 0 })),
      interactions,
    });

    worker.accept(envelope);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    expect(worker.abort(assignmentId, new Error("cancelled"))).toBe(true);
    await worker.drain();

    expect(observedSignal?.aborted).toBe(true);
    expect(failExecution).toHaveBeenCalledWith(assignmentId, {
      reason: "运行已中止",
      usageFinal: { reportDigest: "sha256:usage", upToUsageSeq: 0 },
    });
    expect(interactions.drainAssignment).toHaveBeenCalledTimes(2);
    expect(interactions.drainAssignment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        signal: expect.objectContaining({ aborted: false }),
      }),
    );
  });

  it("owns ticket cancellation from durable prefix through proof submission", async () => {
    const assignmentId = "asg-worker-ticket-cancel";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const proof = { assignmentId, cause: "abort-ticket" } as never;
    const abortWithTicket = vi.fn(async () => ({ kind: "accepted" as const }));
    const continueTicketCancellation = vi.fn(async () => proof);
    const submitCancelProof = vi.fn(async () => undefined);
    const ledger = {
      abortWithTicket,
      conversationAssignmentForRecovery: vi.fn(async () => envelope),
      pendingInteractionMirrorBatch: vi.fn(async () => undefined),
      continueTicketCancellation,
      hasOpenSideEffects: vi.fn(async () => false),
    } as unknown as ConversationAssignmentLedger;
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof,
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
    });
    const request = {
      assignmentId,
      reason: "owner unavailable",
    } as unknown as ExecutionAbortRequest;

    await worker.abortWithTicket(request);
    await worker.drain();

    expect(abortWithTicket).toHaveBeenCalledWith(request);
    expect(continueTicketCancellation).toHaveBeenCalledWith(assignmentId);
    expect(submitCancelProof).toHaveBeenCalledWith(
      assignmentId,
      proof,
      expect.objectContaining({
        requestId: `submission:${assignmentId}`,
      }),
    );
  });

  it("routes an authorized surface answer through the active runtime broker", async () => {
    const assignmentId = "asg-worker-ticket-answer";
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
      permissionLease: {},
      resourceLease: {},
      work: {
        conversationId: "conversation-worker-ticket-answer",
        runId: "run-worker-ticket-answer",
        ownerEpoch: 1,
        baseRevision: 2,
        ingress: {
          kind: "first-party",
          surfacePrincipal: "surface:test",
          deviceId: "device-owner",
          ingressId: "ingress-worker-ticket-answer",
          receivedAt: new Date().toISOString(),
        },
        windowInput: { t: "full", windowEpoch: 3, messages: [] },
      },
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const prepared = {
      kind: "authorized" as const,
      ticketId: "ticket-interact",
      surfacePrincipal: "surface:test",
      decision: { kind: "allow-once" as const },
    };
    const ledger = {
      start: vi.fn(async () => ({ started: true })),
      prepareInteractionAnswerFromSurface: vi.fn(async () => prepared),
      closePendingInteractionsForRunEnd: vi.fn(async () => 0),
      pendingInteractionMirrorBatch: vi.fn(async () => undefined),
      hasPendingTicketCancellation: vi.fn(async () => false),
      failExecution: vi.fn(async () => undefined),
    } as unknown as ConversationAssignmentLedger;
    const confirmationBroker = {} as never;
    let observedSignal: AbortSignal | undefined;
    const run = vi.fn(async function* (
      _messages: unknown,
      options: { abortSignal?: AbortSignal },
    ) {
      observedSignal = options.abortSignal;
      await new Promise<void>((resolve) => {
        if (options.abortSignal?.aborted) resolve();
        else options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { agentResult: { reason: "aborted" } };
    });
    const resolveWithSurfaceTicket = vi.fn(async () => true);
    const interactions = {
      ...interactionObserver(),
      resolveWithSurfaceTicket,
    } as unknown as DurableConversationInteractionObserver;
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {
        create: vi.fn(async () => ({
          run,
          confirmationBroker,
          dispose: vi.fn(async () => undefined),
        })),
      } as unknown as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(async () => undefined),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(async () => ({
        reportDigest: "sha256:usage",
        upToUsageSeq: 0,
      })),
      interactions,
    });

    worker.accept(envelope);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await expect(
      worker.answerInteractionWithTicket({
        assignmentId,
        requestId: "request-interact",
        ticketId: prepared.ticketId,
        surfacePrincipal: prepared.surfacePrincipal,
        decision: prepared.decision,
      }),
    ).resolves.toBeUndefined();
    expect(resolveWithSurfaceTicket).toHaveBeenCalledWith(
      confirmationBroker,
      expect.objectContaining({
        assignmentId,
        requestId: "request-interact",
        ticketId: prepared.ticketId,
        surfacePrincipal: prepared.surfacePrincipal,
      }),
    );

    expect(worker.abort(assignmentId, new Error("test complete"))).toBe(true);
    await worker.drain();
  });

  it("does not stop or redrive when the assignment won the terminal race", async () => {
    const conversationAssignmentForRecovery = vi.fn();
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: {
        abortWithTicket: vi.fn(async () => ({ kind: "terminal" as const })),
        conversationAssignmentForRecovery,
      } as unknown as ConversationAssignmentLedger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: vi.fn(),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
    });

    await expect(worker.abortWithTicket({
      assignmentId: "asg-terminal-race",
      reason: "owner unavailable",
    } as unknown as ExecutionAbortRequest)).resolves.toBeUndefined();
    expect(conversationAssignmentForRecovery).not.toHaveBeenCalled();
  });

  it("retries transient sealed-bundle reads but surfaces corrupt durable state", async () => {
    const envelope = {
      execution: "conversation",
      assignmentId: "asg-worker-recovery-read",
      capabilities: [{} as AuthorityCapability],
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const bundle = { assignmentId: envelope.assignmentId } as SealedBundle;
    const transientLedger = {
      recoverableConversationAssignments: vi.fn(async () => [envelope]),
      recoverableConversationCancellations: vi.fn(async () => []),
      start: vi.fn(async () => ({ started: false })),
      sealedBundleForRecovery: vi.fn()
        .mockRejectedValueOnce(new Error("temporary read failure"))
        .mockResolvedValueOnce({ kind: "sealed", bundle }),
      acknowledge: vi.fn(async () => undefined),
    } as unknown as ConversationAssignmentLedger;
    const submitBundle = vi.fn(async () => ({ committed: true as const, commitRevision: 9 }));
    const transientWorker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: transientLedger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle,
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
    });

    await transientWorker.recover();
    await transientWorker.drain();
    expect(submitBundle).toHaveBeenCalledOnce();

    const corruption = new AuthorityStorageError(
      "invalid-authority-record",
      "corrupt sealed record",
    );
    const onError = vi.fn();
    const corruptWorker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: {
        recoverableConversationAssignments: vi.fn(async () => [envelope]),
        recoverableConversationCancellations: vi.fn(async () => []),
        start: vi.fn(async () => ({ started: false })),
        sealedBundleForRecovery: vi.fn(async () => { throw corruption; }),
      } as unknown as ConversationAssignmentLedger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
      onError,
    });
    await corruptWorker.recover();
    await corruptWorker.drain();
    expect(onError).toHaveBeenCalledWith(envelope.assignmentId, corruption);
  });

  it("closes admission synchronously before draining active work", async () => {
    const start = vi.fn(async () => ({ started: true }));
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger: { start } as unknown as ConversationAssignmentLedger,
      runtimeFactory: {} as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(),
      interactions: interactionObserver(),
    });
    worker.stopAccepting();
    worker.accept({
      execution: "conversation",
      assignmentId: "asg-after-close",
    } as unknown as DispatchEnvelope);
    await worker.drain();
    expect(start).not.toHaveBeenCalled();
  });

  it("binds turn origin to every remotely produced stream frame", async () => {
    const assignmentId = "asg-worker-turn-origin";
    const turnOrigin = {
      channel: "channel-test",
      target: { channelId: "channel-test", to: "user-test" },
      triggeredBy: "message-test",
    };
    const envelope = {
      execution: "conversation",
      assignmentId,
      capabilities: [{ expiry: new Date(Date.now() + 60_000).toISOString() }],
      permissionLease: {},
      resourceLease: {},
      work: {
        conversationId: "conversation-turn-origin",
        runId: "run-turn-origin",
        ownerEpoch: 2,
        baseRevision: 3,
        ingress: {
          kind: "channel",
          surfacePrincipal: "surface:test",
          ingressId: "ingress-turn-origin",
          receivedAt: new Date().toISOString(),
          replyTarget: { channelId: "channel-test", to: "user-test" },
          turnOrigin,
        },
        windowInput: { t: "full", windowEpoch: 4, messages: [] },
      },
    } as unknown as Extract<DispatchEnvelope, { execution: "conversation" }>;
    const yielded = { type: "text_delta", text: "hello" } as never;
    const event = {
      event: "agent:run_start",
      payload: { prompt: "hello" },
    } as never;
    const injectedStream = new StreamDigestChain(assignmentId);
    const final = vi.fn(
      async (
        _meta: StreamFrameMeta = {},
        _signal?: AbortSignal,
      ) => injectedStream.final(),
    );
    const createStream = vi.fn(async () => ({
      append: async (
        payload: Parameters<StreamDigestChain["append"]>[0],
        meta?: Parameters<StreamDigestChain["append"]>[1],
      ) => injectedStream.append(payload, meta),
      final,
    }));
    const sealConversationBundle = vi.fn(async () => ({ assignmentId } as SealedBundle));
    const interactions = interactionObserver();
    const ledger = {
      start: vi.fn(async () => ({ started: true })),
      authorizeToolExecution: vi.fn(),
      closePendingInteractionsForRunEnd: vi.fn(async () => 0),
      pendingInteractionMirrorBatch: vi.fn(async () => undefined),
      hasPendingTicketCancellation: vi.fn(async () => false),
      sealConversationBundle,
      acknowledge: vi.fn(async () => undefined),
    } as unknown as ConversationAssignmentLedger;
    const worker = new ConversationAssignmentWorker({
      InProcessAssignmentSubmission,
      ledger,
      runtimeFactory: {
        create: vi.fn(async () => ({
          run: async function* (_messages: unknown, options: {
            onProtocolEvent: (event: never, meta: { lineage?: string }) => void;
          }) {
            options.onProtocolEvent(event, {});
            yield yielded;
            return {
              agentResult: {
                reason: "completed",
                usage: { inputTokens: 1, outputTokens: 1 },
              },
              runRecord: { source: "interactive" },
            };
          },
          dispose: vi.fn(async () => undefined),
        })),
      } as unknown as RuntimeFactory,
      artifacts: {} as ArtifactStore,
      submissionFor: () => ({
        reportStarted: vi.fn(async () => undefined),
        mirrorInteractions: vi.fn(),
        submitBundle: vi.fn(async () => ({ committed: true, commitRevision: 10 })),
        submitCancelProof: vi.fn(),
      }),
      finalizeUsage: vi.fn(async () => ({ reportDigest: "sha256:usage", upToUsageSeq: 0 })),
      interactions,
      createStream,
    });
    worker.accept(envelope);
    await worker.drain();

    const expected = new StreamDigestChain(assignmentId);
    expected.append({ kind: "agent-event", event }, { turnOrigin });
    expected.append({ kind: "agent-yield", yield: yielded }, { turnOrigin });
    expect(createStream).toHaveBeenCalledWith({
      assignmentId,
      ref: {
        execution: "conversation",
        conversationId: envelope.work.conversationId,
        runId: envelope.work.runId,
        ownerEpoch: envelope.work.ownerEpoch,
      },
    });
    expect(interactions.withBinding).toHaveBeenCalledWith(
      expect.objectContaining({ streamMeta: { turnOrigin } }),
      expect.any(Function),
    );
    expect(final).toHaveBeenCalledWith(
      { turnOrigin },
      expect.any(AbortSignal),
    );
    expect(sealConversationBundle).toHaveBeenCalledWith(
      assignmentId,
      expect.objectContaining({ streamFinal: expected.final() }),
    );
  });
});
