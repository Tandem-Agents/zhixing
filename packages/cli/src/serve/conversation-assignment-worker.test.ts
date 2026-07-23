import {
  AuthorityStorageError,
  type ArtifactStore,
} from "@zhixing/core/authority";
import type {
  AuthorityCapability,
  DispatchEnvelope,
  SealedBundle,
} from "@zhixing/core/contracts";
import {
  InProcessAssignmentSubmission,
  type ConversationAssignmentLedger,
} from "@zhixing/executor";
import type { RuntimeFactory } from "@zhixing/owner-kernel";
import { MeshProtocolError } from "@zhixing/mesh/errors";
import { StreamDigestChain } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConversationAssignmentWorker } from "./conversation-assignment-worker.js";
import type { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";

function interactionObserver(): DurableConversationInteractionObserver {
  return {
    withBinding: vi.fn((_binding: unknown, operation: () => Promise<unknown>) => operation()),
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
      failExecution,
    } as unknown as ConversationAssignmentLedger;
    const runtimeFailure = new Error("runtime factory unavailable");
    const onError = vi.fn();
    const finalizeUsage = vi.fn()
      .mockRejectedValueOnce(new MeshProtocolError("service-failed", "Mesh service failed"))
      .mockResolvedValueOnce({ reportDigest: "sha256:usage", upToUsageSeq: 0 });
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
      interactions: interactionObserver(),
      onError,
    });

    worker.accept(envelope);
    await worker.drain();

    expect(failExecution).toHaveBeenCalledWith(assignmentId, {
      reason: runtimeFailure.message,
      usageFinal: { reportDigest: "sha256:usage", upToUsageSeq: 0 },
    });
    expect(finalizeUsage).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(assignmentId, runtimeFailure);
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
      interactions: interactionObserver(),
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
      channelId: "channel-test",
      messageId: "message-test",
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
    const yielded = { type: "text_delta", delta: "hello" } as never;
    const event = { type: "model_start" } as never;
    const sealConversationBundle = vi.fn(async () => ({ assignmentId } as SealedBundle));
    const interactions = interactionObserver();
    const ledger = {
      start: vi.fn(async () => ({ started: true })),
      authorizeToolExecution: vi.fn(),
      closePendingInteractionsForRunEnd: vi.fn(async () => 0),
      pendingInteractionMirrorBatch: vi.fn(async () => undefined),
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
    });
    worker.accept(envelope);
    await worker.drain();

    const expected = new StreamDigestChain(assignmentId);
    expected.append({ kind: "agent-event", event }, { turnOrigin });
    expected.append({ kind: "agent-yield", yield: yielded }, { turnOrigin });
    expect(interactions.withBinding).toHaveBeenCalledWith(
      expect.objectContaining({ streamMeta: { turnOrigin } }),
      expect.any(Function),
    );
    expect(sealConversationBundle).toHaveBeenCalledWith(
      assignmentId,
      expect.objectContaining({ streamFinal: expected.final() }),
    );
  });
});
