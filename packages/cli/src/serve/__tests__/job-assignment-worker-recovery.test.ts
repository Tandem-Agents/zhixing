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
      recoverableJobAssignments: vi.fn(async () => []),
      recoverableJobCancellations: vi.fn(async () => [envelope]),
      recoverableJobInteractionAssignments: vi.fn(async () => []),
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
});
