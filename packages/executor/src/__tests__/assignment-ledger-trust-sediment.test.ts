// 信任沉淀随交互镜像链回到 owner：真实执行端台账＋真实 owner 对话日志。
import { FileAuthorityCommitLog } from "@zhixing-ai/core/authority";
import type { TrustSedimentFact } from "@zhixing-ai/core/contracts";
import { describe, expect, it } from "vitest";
import type { ConversationTrustSedimentPort } from "@zhixing-ai/owner-kernel/conversation-assignment";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission } from "../assignment-ledger.js";
import {
  ASSIGNMENT_ID,
  DURABLE_IO_TEST_TIMEOUT_MS,
  EXECUTOR_ID,
  NOW,
  allowOnceDecisionDigest,
  createHarness,
  matchingPermissionSnapshotFor,
  matchingSnapshotFor,
  ownerContext,
  ownerControl,
  submissionContext,
} from "./assignment-ledger-fixture.js";

const sediment = (requestId: string): TrustSedimentFact => ({
  pattern: { tool: "bash", argument: "npm install *" },
  riskLevel: "medium",
  operation: { tool: "bash", arguments: { command: "npm install left-pad" } },
  contributors: [
    { origin: "user", timestamp: 1, requestId },
    { origin: "steward", timestamp: 2 },
    { origin: "steward", timestamp: 3 },
  ],
});

function recordingPort(options: { failPrepare?: number } = {}) {
  const calls: string[] = [];
  let failures = options.failPrepare ?? 0;
  const answered: boolean[] = [];
  const port: ConversationTrustSedimentPort = {
    async prepare(input) {
      calls.push(`prepare:${input.entry.requestId}`);
      answered.push(...await Promise.all(
        input.entry.sediment.contributors.flatMap((entry) => entry.requestId ? [input.answered(entry.requestId)] : []),
      ));
      if (failures > 0) {
        failures -= 1;
        throw new Error("permission store unavailable");
      }
    },
    async accept(input) {
      calls.push(`accept:${input.entry.requestId}`);
    },
  };
  return { port, calls, answered };
}

async function startedHarness(port: ConversationTrustSedimentPort) {
  const harness = await createHarness({ trustSediments: port });
  await harness.ledger.dispatch(
    harness.dispatch.envelope,
    harness.dispatch.activation,
    ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
  );
  await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
  const adapter = new InProcessAssignmentSubmission({ ledger: harness.ledger, owner: harness.journal });
  await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
  await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
    requestId: "interaction-1",
    toolName: "bash",
    display: { title: "Run", lines: ["npm install left-pad"] },
    issuedAt: NOW,
    ttlMs: 60_000,
    expiresAt: "2026-07-13T09:01:00.000Z",
  });
  await adapter.finishAndMirror(ASSIGNMENT_ID, "interaction-1", {
    t: "answered",
    authority: { via: "surface-ticket", ticketId: "ticket-1" },
    decision: { allowed: true },
    decisionDigest: allowOnceDecisionDigest("interaction-1"),
    by: "surface:user-1",
  }, submissionContext(harness.unsigned));
  return { harness, adapter };
}

describe("trust sediment mirror lane", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("rides the interaction mirror chain: prepared before the owner commit, accepted after, replay idempotent", async () => {
    const { port, calls, answered } = recordingPort();
    const { harness, adapter } = await startedHarness(port);

    const recorded = await harness.ledger.recordTrustSediment(ASSIGNMENT_ID, sediment("interaction-1"));
    expect(recorded.requestId).toBe("trust-sediment:1");
    const batch = await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID);
    expect(batch?.entries).toMatchObject([{ kind: "trust-sediment", requestId: "trust-sediment:1" }]);

    await adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(calls).toEqual(["prepare:trust-sediment:1", "accept:trust-sediment:1"]);
    expect(answered).toEqual([true]);
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
    await expect(harness.journal.trustSedimentMirrored(ASSIGNMENT_ID, "trust-sediment:1")).resolves.toBe(true);
    // 沉淀不是交互：不出现在交互结果查询里
    await expect(harness.journal.interactionOutcome("trust-sediment:1")).resolves.toBeUndefined();
    await expect(harness.journal.interactionOutcome("interaction-1")).resolves.toMatchObject({ t: "answered" });

    // 同一批重放：日志返回原回执，不重新准备，只再做幂等接纳
    await expect(harness.journal.mirrorInteractions(ASSIGNMENT_ID, batch!, submissionContext(harness.unsigned)))
      .resolves.toMatchObject({ mirroredUpTo: batch!.entries[0]!.seq });
    expect(calls).toEqual(["prepare:trust-sediment:1", "accept:trust-sediment:1", "accept:trust-sediment:1"]);

    // 重开台账：校验链回放接受沉淀记录，镜像水位不倒退
    const restarted = new ConversationAssignmentLedger({
      log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, { clock: () => NOW, lockWaitMs: 2_000 }),
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) => matchingPermissionSnapshotFor(harness.identity, digest),
      clock: () => NOW,
    });
    await expect(restarted.pendingInteractionMirrors(ASSIGNMENT_ID)).resolves.toEqual([]);
    await expect(restarted.recordTrustSediment(ASSIGNMENT_ID, sediment("interaction-1")))
      .resolves.toMatchObject({ requestId: "trust-sediment:2" });
  });

  it("does not accept the batch when preparing its sediment fails; the executor's next flush delivers it", async () => {
    const { port, calls } = recordingPort({ failPrepare: 1 });
    const { harness, adapter } = await startedHarness(port);
    await harness.ledger.recordTrustSediment(ASSIGNMENT_ID, sediment("interaction-1"));

    await expect(adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned)))
      .rejects.toThrow("permission store unavailable");
    await expect(harness.journal.trustSedimentMirrored(ASSIGNMENT_ID, "trust-sediment:1")).resolves.toBe(false);
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toHaveLength(1);

    await adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(calls).toEqual(["prepare:trust-sediment:1", "prepare:trust-sediment:1", "accept:trust-sediment:1"]);
    await expect(harness.journal.trustSedimentMirrored(ASSIGNMENT_ID, "trust-sediment:1")).resolves.toBe(true);
  });

  it("rejects sediments from an assignment that has not started", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await expect(harness.ledger.recordTrustSediment(ASSIGNMENT_ID, sediment("interaction-1")))
      .rejects.toThrow(/started assignment/u);
  });
});
