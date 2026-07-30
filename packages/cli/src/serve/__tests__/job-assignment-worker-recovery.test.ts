import type {
  DispatchEnvelope,
  InteractionSettlementStreamProof,
} from "@zhixing/core/contracts";
import type { ConversationAssignmentLedger } from "@zhixing/executor";
import { describe, expect, it, vi } from "vitest";
import {
  JobAssignmentWorker,
  type JobRunStream,
  type JobSubmissionOwner,
} from "../job-assignment-worker.js";

const assignmentId = "assignment:recovery";
const streamProof = {
  v: 2,
  assignmentId,
  executorId: "executor:recovery",
  ticketDigest: `sha256:${"1".repeat(64)}`,
  sourceLastSeq: 4,
  sourceChainDigest: `sha256:${"2".repeat(64)}`,
  targetInteractionRecordSeq: 3,
  projectedRecordSeq: 6,
  upToRecordSeq: 3,
  lastStreamSeq: 2,
  streamDigest: `sha256:${"3".repeat(64)}`,
  ledgerChainDigest: `sha256:${"4".repeat(64)}`,
  issuedAt: "2026-07-29T00:00:00.000Z",
  signature: "signature",
} as InteractionSettlementStreamProof;

const envelope = {
  assignmentId,
  execution: "job",
  work: {
    taskId: "task:recovery",
    jobRunId: "job-run:recovery",
    fence: { anchorEpoch: 1 },
  },
  capabilities: [{ expiry: "2026-07-30T00:00:00.000Z" }],
} as unknown as Extract<DispatchEnvelope, { execution: "job" }>;

describe("job assignment audit-only recovery", () => {
  it("retires only after owner acceptance and the matching local record are durable", async () => {
    const markAccepted = vi.fn(async () => true);
    const ledger = {
      recoverableJobObligations: vi.fn(async () => ({
        entries: [
          {
            envelope,
            execution: false,
            cancellation: true,
            interaction: true,
          },
        ],
      })),
      jobAssignmentForRecovery: vi.fn(async () => envelope),
      recoverInteractions: vi.fn(async () => ({ pending: [] })),
      hasPendingTicketCancellation: vi.fn(async () => true),
      continueTicketCancellation: vi.fn(async () => undefined),
      hasOpenSideEffects: vi.fn(async () => true),
      interactionStreamProjectionEnabled: vi.fn(async () => true),
      interactionSettlementStreamProof: vi.fn(async () => streamProof),
      interactionStreamProjectedUpTo: vi.fn(async () => 3),
      interactionStreamEvents: vi.fn(async () => []),
      markInteractionStreamProjected: vi.fn(async () => undefined),
      markInteractionSettlementOwnerAccepted: markAccepted,
    } as unknown as ConversationAssignmentLedger;
    const completeInteractionSettlement = vi.fn(async () => undefined);
    const owner = {
      completeInteractionSettlement,
    } as unknown as JobSubmissionOwner;
    const markTerminal = vi.fn(async () => undefined);
    const stream = {
      append: vi.fn(async () => ({ seq: 1 })),
      markTerminal,
    } as unknown as JobRunStream;
    class Submission {
      async flushInteractionMirrors() {}
    }
    const createRuntime = vi.fn(async () => {
      throw new Error("recovery must not restart the job runtime");
    });
    const worker = new JobAssignmentWorker({
      ledger,
      runtime: {
        create: createRuntime,
      },
      submissionFor: () => owner,
      finalizeUsage: vi.fn(async () => ({
        reportDigest: `sha256:${"5".repeat(64)}`,
        upToUsageSeq: 0,
      })),
      InProcessAssignmentSubmission: Submission as never,
      createStream: vi.fn(async () => stream),
    });

    await worker.recover();
    await worker.drain();

    expect(completeInteractionSettlement).toHaveBeenCalledWith(
      assignmentId,
      streamProof,
      expect.objectContaining({
        requestId: `submission:${assignmentId}`,
      }),
    );
    expect(markTerminal).toHaveBeenCalledTimes(1);
    expect(markAccepted).toHaveBeenCalledWith(assignmentId, streamProof);
    expect(createRuntime).not.toHaveBeenCalled();
    await worker.close();
  });

  it("pulls recovery pages only after the fixed-capacity queue drains", async () => {
    const envelopes = Array.from({ length: 40 }, (_, index) => ({
      ...envelope,
      assignmentId: `assignment-recovery-${index.toString().padStart(2, "0")}`,
    }));
    const recoverableJobObligations = vi.fn(
      async (input: { readonly continuation?: string }) =>
        input.continuation
          ? {
              entries: envelopes.slice(32).map((entry) => ({
                envelope: entry,
                execution: false,
                cancellation: false,
                interaction: true,
              })),
            }
          : {
              entries: envelopes.slice(0, 32).map((entry) => ({
                envelope: entry,
                execution: false,
                cancellation: false,
                interaction: true,
              })),
              continuation: envelopes[31]!.assignmentId,
            },
    );
    let active = 0;
    let maximumActive = 0;
    let releaseFirstPage!: () => void;
    const firstPageGate = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    class Submission {
      async flushInteractionMirrors() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await firstPageGate;
        active -= 1;
      }
    }
    const ledger = {
      recoverableJobObligations,
      recoverInteractions: vi.fn(async () => ({ pending: [] })),
      hasPendingTicketCancellation: vi.fn(async () => false),
      interactionStreamProjectedUpTo: vi.fn(async () => 0),
      interactionStreamEvents: vi.fn(async () => []),
      markInteractionStreamProjected: vi.fn(async () => undefined),
    } as unknown as ConversationAssignmentLedger;
    const worker = new JobAssignmentWorker({
      ledger,
      runtime: {
        create: vi.fn(async () => {
          throw new Error("interaction recovery must not restart runtime");
        }),
      },
      submissionFor: vi.fn(async () => ({} as JobSubmissionOwner)),
      finalizeUsage: vi.fn(async () => ({
        reportDigest: `sha256:${"5".repeat(64)}`,
        upToUsageSeq: 0,
      })),
      InProcessAssignmentSubmission: Submission as never,
      createStream: vi.fn(async () => ({
        append: vi.fn(async () => ({ seq: 1 })),
      }) as unknown as JobRunStream),
    });

    await expect(worker.recover()).resolves.toBe(32);
    await vi.waitFor(() => {
      expect(maximumActive).toBe(4);
    });
    expect(recoverableJobObligations).toHaveBeenCalledTimes(1);

    releaseFirstPage();
    await worker.drain();

    expect(maximumActive).toBe(4);
    expect(recoverableJobObligations).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        continuation: envelopes[31]!.assignmentId,
      }),
    );
    expect(recoverableJobObligations).toHaveBeenCalledTimes(2);
    await worker.close();
  });

  it("stops reconstructible recovery without aborting an accepted execution before its durable point", async () => {
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let runtimeSignal: AbortSignal | undefined;
    const sealJobBundle = vi.fn(async () => ({
      assignmentId,
    }));
    const ledger = {
      recoverableJobObligations: vi.fn(async () => ({ entries: [] })),
      start: vi.fn(async () => ({ started: true })),
      recoverInteractions: vi.fn(async () => ({ pending: [] })),
      interactionStreamProjectedUpTo: vi.fn(async () => 0),
      interactionStreamEvents: vi.fn(async () => []),
      markInteractionStreamProjected: vi.fn(async () => undefined),
      hasPendingOwnerCancellation: vi.fn(async () => false),
      hasPendingTicketCancellation: vi.fn(async () => false),
      closePendingInteractionsForRunEnd: vi.fn(async () => undefined),
      sealJobBundle,
    } as unknown as ConversationAssignmentLedger;
    class Submission {
      async flushInteractionMirrors() {}
    }
    const owner = {
      reportStarted: vi.fn(async () => undefined),
      submitBundle: vi.fn(async () => new Promise(() => undefined)),
    } as unknown as JobSubmissionOwner;
    const worker = new JobAssignmentWorker({
      ledger,
      runtime: {
        create: vi.fn(async () => ({
          async *run(
            _instruction: unknown,
            options: { readonly abortSignal: AbortSignal },
          ) {
            runtimeSignal = options.abortSignal;
            await runtimeGate;
            return {
              status: "completed" as const,
              summary: "done",
              contentAssets: [],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
          dispose: vi.fn(async () => undefined),
        })),
      },
      submissionFor: vi.fn(async () => owner),
      finalizeUsage: vi.fn(async () => ({
        reportDigest: `sha256:${"5".repeat(64)}`,
        upToUsageSeq: 0,
      })),
      InProcessAssignmentSubmission: Submission as never,
      createStream: vi.fn(async () => ({
        append: vi.fn(async () => ({ seq: 1 })),
        final: vi.fn(async () => ({
          finalSeq: 1,
          streamDigest: `sha256:${"6".repeat(64)}`,
        })),
        markTerminal: vi.fn(async () => undefined),
      }) as unknown as JobRunStream),
    });

    worker.accept(envelope);
    await vi.waitFor(() => {
      expect(runtimeSignal).toBeDefined();
    });
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();

    expect(closed).toBe(false);
    expect(runtimeSignal!.aborted).toBe(false);

    releaseRuntime();
    await closing;

    expect(runtimeSignal!.aborted).toBe(false);
    expect(sealJobBundle).toHaveBeenCalledTimes(1);
    await expect(worker.close()).resolves.toBeUndefined();
  });

  it("cancels a pre-start owner wait at the durable received recovery point", async () => {
    let ownerWaitSignal: AbortSignal | undefined;
    const ledger = {
      recoverableJobObligations: vi.fn(async () => ({ entries: [] })),
      start: vi.fn(async () => ({ started: true })),
    } as unknown as ConversationAssignmentLedger;
    const worker = new JobAssignmentWorker({
      ledger,
      runtime: {
        create: vi.fn(async () => {
          throw new Error("pre-start shutdown must not create a runtime");
        }),
      },
      submissionFor: vi.fn(
        async (_envelope, signal) =>
          new Promise<JobSubmissionOwner>((_resolve, reject) => {
            ownerWaitSignal = signal;
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          }),
      ),
      finalizeUsage: vi.fn(async () => ({
        reportDigest: `sha256:${"5".repeat(64)}`,
        upToUsageSeq: 0,
      })),
      InProcessAssignmentSubmission: class {} as never,
      createStream: vi.fn(),
    });

    worker.accept(envelope);
    await vi.waitFor(() => {
      expect(ownerWaitSignal).toBeDefined();
    });
    await worker.close();

    expect(ownerWaitSignal!.aborted).toBe(true);
    expect(ledger.start).not.toHaveBeenCalled();
  });
});
