// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：bundles。
import { rm } from "node:fs/promises";
import { FileAuthorityCommitLog, MAX_INLINE_LOGICAL_RECORD_BYTES } from "@zhixing/core/authority";
import type { TranscriptRunRecord } from "@zhixing/core/contracts";
import { canonicalize, createConversationSealedBundle, createMutationBatch, mutationBatchArtifact, sealedBundleArtifact } from "@zhixing/core/protocol";
import { ConversationRunJournal, InProcessConversationDispatcher, type ConversationCommitAuthority, type ConversationCommitProjection, type ConversationCommitProjectionInput, type ConversationMutationPublisher } from "@zhixing/owner-kernel/conversation-assignment";
import { describe, expect, it, vi } from "vitest";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission, type InteractionOutcome } from "../assignment-ledger.js";
import { NOW, EXECUTOR_ID, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID, SHA256_ZERO, ABORT_TICKET_DIGEST, DURABLE_IO_TEST_TIMEOUT_MS, matchingSnapshotFor, matchingPermissionSnapshotFor, allowOnceDecisionDigest, deliveryParticipant, CountingArtifactStore, signedMirrorBatch, ownerControl, submission, createUnassignedHarness, createHarness, createUnsignedEnvelope, ingress, ownerContext, submissionContext, sealDefaultBundle, createCancellationSubmission, createBundleSubmission, reopenJournal, withoutSignature, replayFixtureLog } from "./assignment-ledger-fixture.js";

describe("conversation assignment protocol", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("bounds interaction records and backlog while draining mirrors in finite batches", async () => {
    const harness = await createHarness({ maxPendingInteractions: 16 });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);

    for (let index = 0; index < 17; index += 1) {
      await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
        requestId: `bounded-${index}`,
        toolName: "write-file",
        display: { title: "Write", lines: [`workspace/file-${index}.md`] },
        issuedAt: NOW,
        ttlMs: index === 0 ? 2 * 24 * 60 * 60_000 : 60_000,
        expiresAt:
          index === 0
            ? "2026-07-15T09:00:00.000Z"
            : "2026-07-13T09:01:00.000Z",
      });
    }
    const beforeInvalidOutcome = (
      await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)
    ).length;
    await expect(
      harness.ledger.finishInteraction(ASSIGNMENT_ID, "bounded-0", {
        t: "answered",
        authority: { via: "channel-grant", grant: {} },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("bounded-0"),
        by: "channel:test",
      } as unknown as InteractionOutcome),
    ).rejects.toThrow("Channel interaction grant fields are incomplete or unknown");
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(
      beforeInvalidOutcome,
    );
    const executorOnlyOutcome = {
      t: "answered" as const,
      authority: { via: "surface-ticket" as const, ticketId: "ticket-edge" },
      decision: { allowed: true, reason: "" },
      decisionDigest: allowOnceDecisionDigest("bounded-0"),
      by: "surface:user-1",
    };
    const executorOnlyBody = {
      v: 1 as const,
      t: "interaction-finished" as const,
      requestId: "bounded-0",
      kind: "allow-once" as const,
      outcome: executorOnlyOutcome,
    };
    const executorWrapperBytes = Buffer.byteLength(
      canonicalize({ recordSeq: Number.MAX_SAFE_INTEGER, body: executorOnlyBody }),
      "utf8",
    );
    executorOnlyOutcome.decision.reason = "r".repeat(
      MAX_INLINE_LOGICAL_RECORD_BYTES - executorWrapperBytes,
    );
    await expect(
      harness.ledger.finishInteraction(
        ASSIGNMENT_ID,
        "bounded-0",
        executorOnlyOutcome,
      ),
    ).rejects.toThrow("cannot fit in a durable mirror record");
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(
      beforeInvalidOutcome,
    );
    await expect(
      harness.ledger.finishInteraction(ASSIGNMENT_ID, "bounded-0", {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "ticket-oversized" },
        decision: { allowed: true, reason: "r".repeat(40_000) },
        decisionDigest: allowOnceDecisionDigest("bounded-0"),
        by: "surface:user-1",
      }),
    ).rejects.toThrow("exceeds the durable protocol limit");
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(
      beforeInvalidOutcome,
    );

    for (let index = 0; index < 16; index += 1) {
      await harness.ledger.finishInteraction(ASSIGNMENT_ID, `bounded-${index}`, {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: `ticket-${index}` },
        decision: { allowed: true, reason: "r".repeat(2_000) },
        decisionDigest: allowOnceDecisionDigest(`bounded-${index}`),
        by: "surface:user-1",
      });
    }
    expect(await harness.ledger.recoverInteractions(ASSIGNMENT_ID, NOW)).toEqual({
      pending: [],
      resolved: [],
    });
    const firstBatch = await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID);
    expect(firstBatch.length).toBeGreaterThan(0);
    expect(firstBatch.length).toBeLessThan(17);
    const oversizedBatch = signedMirrorBatch(
      harness.identity,
      Array.from({ length: 20 }, (_, index) => ({
          ordinal: index + 1,
          seq: index + 1,
          requestId: `oversized-mirror-${index}`,
          kind: "allow-once" as const,
          outcome: {
            t: "answered" as const,
            authority: {
              via: "surface-ticket" as const,
              ticketId: `oversized-ticket-${index}`,
            },
            decision: { allowed: true, reason: "r".repeat(2_000) },
            decisionDigest: allowOnceDecisionDigest(`oversized-mirror-${index}`),
            by: "surface:user-1",
          },
          at: NOW,
        })),
    );
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        oversizedBatch,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("exceeds the durable record limit");
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    expect(
      await adapter.flushInteractionMirrors(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).toBe(17);
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rebuilds incremental interaction indexes and resumes a partial mirror watermark", async () => {
    const harness = await createHarness({ maxPendingInteractions: 2 });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);

    const finished = [];
    for (let index = 0; index < 6; index += 1) {
      const requestId = `indexed-${index}`;
      await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
        requestId,
        toolName: "write-file",
        display: { title: "Write", lines: [`workspace/indexed-${index}.md`] },
        issuedAt: NOW,
        ttlMs: 60_000,
        expiresAt: "2026-07-13T09:01:00.000Z",
      });
      finished.push(
        await harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
          t: "answered",
          authority: { via: "surface-ticket", ticketId: `indexed-ticket-${index}` },
          decision: { allowed: true },
          decisionDigest: allowOnceDecisionDigest(requestId),
          by: "surface:user-1",
        }),
      );
    }
    expect(
      (await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).map(
        (entry) => entry.seq,
      ),
    ).toEqual(finished.map((entry) => entry.seq));
    const partialBatch = signedMirrorBatch(
      harness.identity,
      finished.slice(0, 3),
    );
    const partialReceipt = await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      partialBatch,
      submissionContext(harness.unsigned),
    );
    await harness.ledger.markInteractionsMirrored(ASSIGNMENT_ID, partialReceipt);

    const restarted = new ConversationAssignmentLedger({
      log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
      clock: () => NOW,
      maxPendingInteractions: 2,
    });
    expect(
      (await restarted.pendingInteractionMirrors(ASSIGNMENT_ID)).map(
        (entry) => entry.seq,
      ),
    ).toEqual(finished.slice(3).map((entry) => entry.seq));
    expect(await restarted.recoverInteractions(ASSIGNMENT_ID, NOW)).toEqual({
      pending: [],
      resolved: [],
    });

    await restarted.requestInteraction(ASSIGNMENT_ID, {
      requestId: "indexed-after-restart",
      toolName: "write-file",
      display: { title: "Write", lines: ["workspace/indexed-after-restart.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const afterRestart = await restarted.finishInteraction(
      ASSIGNMENT_ID,
      "indexed-after-restart",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "indexed-ticket-after-restart" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("indexed-after-restart"),
        by: "surface:user-1",
      },
    );
    expect(
      (await restarted.pendingInteractionMirrors(ASSIGNMENT_ID)).map(
        (entry) => entry.seq,
      ),
    ).toEqual([...finished.slice(3).map((entry) => entry.seq), afterRestart.seq]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rebuilds staged-mutation indexes without prefix revalidation", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);

    for (let index = 0; index < 32; index += 1) {
      await harness.ledger.stageMutation(ASSIGNMENT_ID, {
        domain: "session",
        requestId: `indexed-mutation-${index}`,
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [
                {
                  id: `task-${index}`,
                  content: `mutation-${index}`,
                  status: "pending",
                },
              ],
            },
          },
        },
      });
    }

    const restarted = new ConversationAssignmentLedger({
      log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
      clock: () => NOW,
    });
    await expect(
      restarted.stageMutation(ASSIGNMENT_ID, {
        domain: "session",
        requestId: "indexed-mutation-0",
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [
                { id: "task-0", content: "mutation-0", status: "pending" },
              ],
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      kind: "assignment-mutation-staged",
      requestId: "indexed-mutation-0",
      recordSeq: 1,
      mutationDigest: expect.any(String),
    });
    await expect(
      restarted.stageMutation(ASSIGNMENT_ID, {
        domain: "session",
        requestId: "indexed-mutation-32",
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [
                { id: "task-32", content: "mutation-32", status: "pending" },
              ],
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      kind: "assignment-mutation-staged",
      requestId: "indexed-mutation-32",
      recordSeq: 33,
      mutationDigest: expect.any(String),
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("commits a sealed conversation exactly once and recovers publish and final response loss", async () => {
    const applied: Array<Parameters<ConversationMutationPublisher["apply"]>[0]> = [];
    let failSecondPublish = true;
    const publisher: ConversationMutationPublisher = {
      decideGlobalBatchAtPrefix(input) {
        return input.records.map((record) => ({
          seq: record.seq,
          outcome: { t: "granted", targetRevision: 100 + record.seq },
        }));
      },
      async apply(input) {
        if (input.seq === 2 && failSecondPublish) {
          failSecondPublish = false;
          throw new Error("simulated publish crash");
        }
        if (!applied.some((item) => item.assignmentId === input.assignmentId && item.seq === input.seq)) {
          applied.push(input);
        }
      },
    };
    const harness = await createHarness({ publisher });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(await harness.journal.statusHistory(RUN_ID, 0)).toEqual([
      {
        v: 1,
        ref: {
          execution: "conversation",
          conversationId: CONVERSATION_ID,
          runId: RUN_ID,
          ownerEpoch: 3,
        },
        state: "queued",
        statusRevision: 1,
        actions: [],
        at: NOW,
      },
      expect.objectContaining({ state: "dispatched", statusRevision: 2, at: NOW }),
      expect.objectContaining({ state: "running", statusRevision: 3, at: NOW }),
    ]);
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "mutation-1",
      expected: { anchorEpoch: 9 },
      mutation: {
        kind: "schedule-delete",
        taskId: "focus-one",
        taskRevision: 1,
      },
    });
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "mutation-2",
      expected: { anchorEpoch: 9 },
      mutation: {
        kind: "schedule-delete",
        taskId: "focus-two",
        taskRevision: 1,
      },
    });
    const runRecord: TranscriptRunRecord = {
      type: "run",
      runId: RUN_ID,
      runIndex: 8,
      timestamp: NOW,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };
    const contentRef = await harness.artifacts.put(Buffer.from("durable-result", "utf8"));
    const contentAsset = { ...contentRef, kind: "file" as const };
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord,
      contentAssets: [contentAsset],
      streamFinal: { finalSeq: 2, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 3, outputTokens: 4, toolCalls: 1 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 1 },
    });
    expect(await harness.journal.pendingFinalFrames()).toEqual([]);
    await expect(
      adapter.submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
    expect(harness.projected.get(ASSIGNMENT_ID)).toBeUndefined();
    expect(await harness.journal.pendingFinalFrames()).toEqual([
      {
        v: 1,
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        commitRevision: 8,
        digest: bundle.digest,
      },
    ]);

    const recoveredJournal = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 3,
      log: harness.log,
      artifacts: harness.artifacts,
      signer: harness.identity,
      verifier: harness.identity,
      delivery: deliveryParticipant(harness.log),
      clock: () => NOW,
      submission,
      authority: harness.authority,
      projection: harness.projection,
      publisher,
    });
    await expect(recoveredJournal.resumeCommittedProjections()).resolves.toBe(1);
    expect(harness.projected.get(ASSIGNMENT_ID)).toMatchObject({
      conversationId: CONVERSATION_ID,
      commitRevision: 8,
      digest: bundle.digest,
      runRecord,
    });
    await expect(recoveredJournal.resumePendingPublishing()).rejects.toThrow(
      "simulated publish crash",
    );
    await expect(recoveredJournal.resumePendingPublishing()).resolves.toBe(1);
    await expect(recoveredJournal.resumePendingPublishing()).resolves.toBe(0);
    expect(applied).toEqual([
      {
        assignmentId: ASSIGNMENT_ID,
        seq: 1,
        domain: "global",
        requestId: "mutation-1",
        mutation: {
          kind: "schedule-delete",
          taskId: "focus-one",
          taskRevision: 1,
        },
        targetRevision: 101,
      },
      {
        assignmentId: ASSIGNMENT_ID,
        seq: 2,
        domain: "global",
        requestId: "mutation-2",
        mutation: {
          kind: "schedule-delete",
          taskId: "focus-two",
          taskRevision: 1,
        },
        targetRevision: 102,
      },
    ]);
    const committedBeforeReplay = (
      await harness.log.readStream<{ t?: string }>(`run:${CONVERSATION_ID}`)
    ).filter((record) => record.body.t === "committed").length;
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(
      (
        await harness.log.readStream<{ t?: string }>(`run:${CONVERSATION_ID}`)
      ).filter((record) => record.body.t === "committed"),
    ).toHaveLength(committedBeforeReplay);

    let failFinal = true;
    await expect(
      harness.journal.publishPendingFinals(async () => {
        if (failFinal) {
          failFinal = false;
          throw new Error("simulated final response loss");
        }
      }),
    ).rejects.toThrow("simulated final response loss");
    expect(await harness.journal.pendingFinalFrames()).toHaveLength(1);
    expect(await harness.journal.publishPendingFinals(async () => undefined)).toBe(1);
    expect(await harness.journal.pendingFinalFrames()).toEqual([]);
    const history = await harness.journal.finalHistory(7);
    expect(history).toHaveLength(1);
    expect(history[0]?.bundle.body.runRecord).toEqual(runRecord);
    expect(history[0]?.bundle.body.contentAssets).toEqual([contentAsset]);
    expect(await harness.journal.finalHistory(8)).toEqual([]);
    await expect(
      harness.log.collectGarbage({ unreferencedBefore: "2099-01-01T00:00:00.000Z" }),
    ).resolves.toMatchObject({ deleted: 0 });
    await expect(harness.artifacts.has(contentRef)).resolves.toBe(true);
    expect(await harness.journal.expirePublishedFinals("2026-07-14T09:00:00.001Z")).toBe(1);
    expect(await harness.journal.expirePublishedFinals("2026-07-15T09:00:00.001Z")).toBe(0);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("retries a conversation bundle after the owner commit response is lost and durably closes the ACK outbox", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const submissionAdapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await submissionAdapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    const bundle = await sealDefaultBundle(harness.ledger);

    await expect(
      harness.journal.submitBundle(
        bundle,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toMatchObject({ committed: true, commitRevision: 8 });
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "sealed" });

    const restarted = reopenJournal(harness);
    const query = vi.spyOn(harness.ledger, "queryLedger");
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: restarted,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, restarted),
      bundleSubmission: createBundleSubmission(harness, restarted),
    });

    await expect(dispatcher.recoverAssignments()).resolves.toBe(1);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({
      phase: "acked",
      acknowledgedCommitRevision: 8,
    });
    expect(
      (await harness.log.readStream<{ t?: string }>(`run:${CONVERSATION_ID}`))
        .filter((entry) => entry.body.t === "bundle-ack-observed"),
    ).toHaveLength(1);
    await expect(
      restarted.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toMatchObject({ committed: true, commitRevision: 8 });

    query.mockClear();
    await expect(dispatcher.recoverAssignments()).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("returns the committed disposition when the executor ACK write fails and recovers the ACK outbox", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const submissionAdapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await submissionAdapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await sealDefaultBundle(harness.ledger);

    const acknowledge = vi
      .spyOn(harness.ledger, "acknowledge")
      .mockRejectedValueOnce(new Error("simulated executor ACK write failure"));
    await expect(
      submissionAdapter.submitSealedBundle(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "sealed" });
    await expect(harness.journal.assignmentsAwaitingRecovery()).resolves.toEqual([
      expect.objectContaining({ assignmentId: ASSIGNMENT_ID, state: "committed" }),
    ]);
    await expect(
      harness.ledger.sealedConversationAssignmentsAwaitingAcknowledgement(),
    ).resolves.toEqual([harness.dispatch.envelope]);
    await expect(
      harness.ledger.recoverableConversationAssignments(),
    ).resolves.toEqual([harness.dispatch.envelope]);
    await expect(
      harness.ledger.sealedBundleForRecovery(ASSIGNMENT_ID),
    ).resolves.toMatchObject({ kind: "sealed" });

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    await expect(dispatcher.recoverAssignments()).resolves.toBe(1);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({
      phase: "acked",
      acknowledgedCommitRevision: 8,
    });
    await expect(
      harness.ledger.sealedConversationAssignmentsAwaitingAcknowledgement(),
    ).resolves.toEqual([]);
    await expect(harness.ledger.recoverableConversationAssignments()).resolves.toEqual([]);
    await expect(harness.journal.assignmentsAwaitingRecovery()).resolves.toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("recovers received conversations only before execution starts", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );

    await expect(harness.ledger.recoverableConversationAssignments()).resolves.toEqual([
      harness.dispatch.envelope,
    ]);
    await expect(
      harness.ledger.sealedBundleForRecovery(ASSIGNMENT_ID),
    ).resolves.toEqual({ kind: "not-sealed" });

    await expect(harness.ledger.start(ASSIGNMENT_ID)).resolves.toEqual({ started: true });
    await expect(harness.ledger.recoverableConversationAssignments()).resolves.toEqual([]);
  });

  it("observes an existing executor ACK without resubmitting the conversation bundle", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const submissionAdapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await submissionAdapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await sealDefaultBundle(harness.ledger);
    await expect(
      submissionAdapter.submitSealedBundle(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toMatchObject({ committed: true, commitRevision: 8 });

    const restarted = reopenJournal(harness);
    const submitSealedBundle = vi.fn(createBundleSubmission(harness, restarted).submitSealedBundle);
    const query = vi.spyOn(harness.ledger, "queryLedger");
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: restarted,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, restarted),
      bundleSubmission: { submitSealedBundle },
    });

    await expect(dispatcher.recoverAssignments()).resolves.toBe(1);
    expect(submitSealedBundle).not.toHaveBeenCalled();
    expect(
      (await harness.log.readStream<{ t?: string }>(`run:${CONVERSATION_ID}`))
        .filter((entry) => entry.body.t === "bundle-ack-observed"),
    ).toHaveLength(1);

    query.mockClear();
    await expect(dispatcher.recoverAssignments()).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it.each(["wrong-bundle", "wrong-revision", "duplicate"] as const)(
    "rejects a %s conversation bundle acknowledgement in both replay projections",
    async (kind) => {
      const harness = await createHarness();
      await harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      const submissionAdapter = new InProcessAssignmentSubmission({
        ledger: harness.ledger,
        owner: harness.journal,
      });
      await submissionAdapter.startAndReport(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      );
      const bundle = await sealDefaultBundle(harness.ledger);
      await harness.journal.submitBundle(bundle, submissionContext(harness.unsigned));
      const committedBundleRef = sealedBundleArtifact(bundle).ref;
      const wrongBundleRef = await harness.artifacts.put(
        Buffer.from("not-the-committed-conversation-bundle", "utf8"),
      );
      const acknowledgement = {
        t: "bundle-ack-observed" as const,
        assignmentId: ASSIGNMENT_ID,
        bundleRef: kind === "wrong-bundle" ? wrongBundleRef : committedBundleRef,
        commitRevision: kind === "wrong-revision" ? 9 : 8,
      };
      await replayFixtureLog(harness).append([
        { stream: `run:${CONVERSATION_ID}`, body: acknowledgement },
        ...(kind === "duplicate"
          ? [{ stream: `run:${CONVERSATION_ID}`, body: acknowledgement }]
          : []),
      ]);

      await expect(reopenJournal(harness).currentState(RUN_ID)).rejects.toThrow(
        /Bundle acknowledgement observation does not bind one committed conversation bundle|Submission guard bundle acknowledgement is invalid or duplicated/,
      );
      await expect(
        reopenJournal(harness).submitBundle(bundle, submissionContext(harness.unsigned)),
      ).rejects.toThrow(/Bundle acknowledgement observation does not bind one committed conversation bundle|Submission guard bundle acknowledgement is invalid or duplicated/);
    },
    15_000,
  );

  it("partitions publish recovery and final revisions across conversations", async () => {
    const secondConversationId = "conversation-2";
    const secondRunId = "run-2";
    const secondAssignmentId = "assignment-2";
    let blockPublishing = true;
    const applied: string[] = [];
    const publisher: ConversationMutationPublisher = {
      decideGlobalBatchAtPrefix(input) {
        return input.records.map((record) => ({
          seq: record.seq,
          outcome: { t: "granted", targetRevision: 100 + record.seq },
        }));
      },
      async apply(input) {
        if (blockPublishing) throw new Error("hold publish recovery open");
        applied.push(input.assignmentId);
      },
    };
    const first = await createHarness({ publisher });
    await first.ledger.dispatch(
      first.dispatch.envelope,
      first.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const firstAdapter = new InProcessAssignmentSubmission({
      ledger: first.ledger,
      owner: first.journal,
    });
    await firstAdapter.startAndReport(ASSIGNMENT_ID, submissionContext(first.unsigned));
    await first.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "first-partitioned-mutation",
      expected: { anchorEpoch: 9 },
      mutation: {
        kind: "schedule-delete",
        taskId: "first-partition",
        taskRevision: 1,
      },
    });
    const firstBundle = await sealDefaultBundle(first.ledger);
    await expect(
      firstAdapter.submitSealedBundle(ASSIGNMENT_ID, submissionContext(first.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });

    const secondAuthority: ConversationCommitAuthority = {
      decideAtPrefix(input) {
        if (
          input.conversationId !== secondConversationId ||
          input.ownerEpoch !== 3 ||
          input.baseRevision !== 7 ||
          input.runRecord.runIndex !== 8
        ) {
          return {
            committed: false,
            error: {
              code: "revision-conflict",
              message: "stale second conversation base",
              retryable: false,
            },
          };
        }
        return { committed: true, commitRevision: 8 };
      },
    };
    const secondProjection: ConversationCommitProjection = {
      async project() {},
    };
    const secondJournal = new ConversationRunJournal({
      conversationId: secondConversationId,
      ownerEpoch: 3,
      log: first.log,
      artifacts: first.artifacts,
      signer: first.identity,
      verifier: first.identity,
      delivery: deliveryParticipant(first.log),
      clock: () => NOW,
      submission,
      authority: secondAuthority,
      projection: secondProjection,
      publisher,
    });
    await secondJournal.admit({
      ingressKey: "surface:user-2/ingress-2",
      runId: secondRunId,
      userInput: { parts: [{ type: "text", text: "second" }] },
      ingress: ingress(),
      invocation: { kind: "agent", source: "interactive" },
      queuedPosition: 0,
    });
    const secondUnsigned = createUnsignedEnvelope(first.identity, {
      runId: secondRunId,
      assignmentId: secondAssignmentId,
      conversationId: secondConversationId,
    });
    const secondDispatch = await secondJournal.assign(secondUnsigned);
    const secondLedger = new ConversationAssignmentLedger({
      log: first.log,
      artifacts: first.artifacts,
      executorId: EXECUTOR_ID,
      signer: first.identity,
      verifier: first.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(first.identity, digest),
      clock: () => NOW,
    });
    await secondLedger.dispatch(
      secondDispatch.envelope,
      secondDispatch.activation,
      ownerContext(secondAssignmentId, "executor.dispatch", secondConversationId),
    );
    const secondAdapter = new InProcessAssignmentSubmission({
      ledger: secondLedger,
      owner: secondJournal,
    });
    await secondAdapter.startAndReport(
      secondAssignmentId,
      submissionContext(secondUnsigned),
    );
    await secondLedger.stageMutation(secondAssignmentId, {
      domain: "global",
      requestId: "second-partitioned-mutation",
      expected: { anchorEpoch: 9 },
      mutation: {
        kind: "schedule-delete",
        taskId: "second-partition",
        taskRevision: 1,
      },
    });
    const secondBundle = await secondLedger.sealConversationBundle(secondAssignmentId, {
      runRecord: {
        type: "run",
        runId: secondRunId,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      secondAdapter.submitSealedBundle(
        secondAssignmentId,
        submissionContext(secondUnsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });

    await expect(first.journal.pendingFinalFrames()).resolves.toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        commitRevision: 8,
        digest: firstBundle.digest,
      }),
    ]);
    await expect(secondJournal.pendingFinalFrames()).resolves.toEqual([
      expect.objectContaining({
        conversationId: secondConversationId,
        runId: secondRunId,
        commitRevision: 8,
        digest: secondBundle.digest,
      }),
    ]);

    blockPublishing = false;
    await expect(first.journal.resumePendingPublishing()).resolves.toBe(1);
    expect(applied).toEqual([ASSIGNMENT_ID]);
    await expect(secondJournal.resumePendingPublishing()).resolves.toBe(1);
    expect(applied).toEqual([ASSIGNMENT_ID, secondAssignmentId]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("commits global publish conflicts while exposing durable summary and detail", async () => {
    const publisher: ConversationMutationPublisher = {
      decideGlobalBatchAtPrefix(input) {
        return input.records.map((record) => ({
          seq: record.seq,
          outcome: {
            t: "conflicted" as const,
            error: {
              code: "revision-conflict" as const,
              message: "workscene changed",
              retryable: false,
            },
          },
        }));
      },
      async apply() {
        throw new Error("conflicted mutations must not be applied");
      },
    };
    const harness = await createHarness({ publisher });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "mutation-global-1",
      expected: { anchorEpoch: 9 },
      mutation: { kind: "workscene-create", name: "Focus" },
    });
    const runRecord: TranscriptRunRecord = {
      type: "run",
      runId: RUN_ID,
      runIndex: 8,
      timestamp: NOW,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    const runRecordRef = await harness.artifacts.put(
      Buffer.from(canonicalize(runRecord), "utf8"),
    );
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: { ref: runRecordRef },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      adapter.submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(await harness.journal.pendingFinalFrames()).toEqual([
      {
        v: 1,
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        commitRevision: 8,
        digest: bundle.digest,
        publishConflicts: 1,
      },
    ]);
    expect(await harness.journal.publishConflicts(ASSIGNMENT_ID)).toEqual({
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      commitRevision: 8,
      conflicts: [
        {
          seq: 1,
          mutation: { kind: "workscene-create", name: "Focus" },
          error: {
            code: "revision-conflict",
            message: "相关内容已被其他修改更新。查看最新内容后重试，放弃这项修改。",
            retryable: false,
          },
        },
      ],
    });
    const [history] = await harness.journal.finalHistory(7);
    expect(history?.frame.publishConflicts).toBe(1);
    expect(history?.publishResults).toEqual([
      {
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        commitRevision: 8,
        assignmentId: ASSIGNMENT_ID,
        seq: 1,
        mutation: { kind: "workscene-create", name: "Focus" },
        decision: {
          t: "conflicted",
          error: {
            code: "revision-conflict",
            message: "相关内容已被其他修改更新。查看最新内容后重试，放弃这项修改。",
            retryable: false,
          },
        },
      },
    ]);
    const publishedResults: unknown[] = [];
    await expect(harness.journal.publishPendingFinals(async (_frame, results) => {
      publishedResults.push(results);
    })).resolves.toBe(1);
    expect(publishedResults).toEqual([history?.publishResults]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("commits from dispatched when the started report is lost and absorbs a late report", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    await expect(
      harness.journal.reportStarted(ASSIGNMENT_ID, submissionContext(harness.unsigned)),
    ).resolves.toBeUndefined();
    const ledgerSnapshot = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if ("entries" in ledgerSnapshot) throw new Error("Expected compact ledger snapshot");
    await expect(
      harness.journal.reconcileStarted(ASSIGNMENT_ID, ledgerSnapshot),
    ).resolves.toBeUndefined();
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
  });

  it("rejects a stale owner instance and a transcript sequence not accepted by session authority", async () => {
    const wrongIndex = await createHarness();
    await wrongIndex.ledger.dispatch(
      wrongIndex.dispatch.envelope,
      wrongIndex.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: wrongIndex.ledger,
      owner: wrongIndex.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(wrongIndex.unsigned));
    const wrongIndexBundle = await wrongIndex.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 9,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      wrongIndex.journal.submitBundle(
        wrongIndexBundle,
        submissionContext(wrongIndex.unsigned),
      ),
    ).resolves.toMatchObject({ committed: false, error: { code: "revision-conflict" } });

    const staleArtifacts = new CountingArtifactStore(wrongIndex.artifacts);
    const staleOwner = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 4,
      log: wrongIndex.log,
      artifacts: staleArtifacts,
      signer: wrongIndex.identity,
      verifier: wrongIndex.identity,
      delivery: deliveryParticipant(wrongIndex.log),
      clock: () => NOW,
      submission,
      authority: wrongIndex.authority,
      projection: wrongIndex.projection,
    });
    staleArtifacts.resetReads();
    await expect(
      staleOwner.submitBundle(wrongIndexBundle, submissionContext(wrongIndex.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "fence-rejected" } });
    expect(staleArtifacts.reads).toBe(0);
  });

  it("rebuilds a committed conversation projection after a crash without duplicating it", async () => {
    let failProjection = true;
    const projected = new Map<string, ConversationCommitProjectionInput>();
    const projection: ConversationCommitProjection = {
      async project(input) {
        if (failProjection) {
          failProjection = false;
          throw new Error("simulated projection crash");
        }
        const previous = projected.get(input.assignmentId);
        if (previous && canonicalize(previous) !== canonicalize(input)) {
          throw new Error("projection identity conflict");
        }
        projected.set(input.assignmentId, input);
      },
    };
    const harness = await createHarness({ projection });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      adapter.submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
    await expect(harness.journal.resumeCommittedProjections()).rejects.toThrow(
      "simulated projection crash",
    );
    await expect(harness.journal.resumeCommittedProjections()).resolves.toBe(1);
    await expect(harness.journal.resumeCommittedProjections()).resolves.toBe(0);
    expect(projected.get(ASSIGNMENT_ID)?.runRecord.runId).toBe(RUN_ID);
  });

  it("rejects publish progress that skips a granted mutation", async () => {
    const harness = await createHarness({
      publisher: {
        decideGlobalBatchAtPrefix(input) {
          return input.records.map((record) => ({
            seq: record.seq,
            outcome: {
              t: "granted" as const,
              targetRevision: record.seq,
            },
          }));
        },
        async apply() {
          throw new Error("pause before publish progress");
        },
      },
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    for (const index of [0, 1]) {
      await harness.ledger.stageMutation(ASSIGNMENT_ID, {
        domain: "global",
        requestId: `mutation-${index + 1}`,
        expected: { anchorEpoch: 9 },
        mutation: {
          kind: "schedule-delete",
          taskId: `batch-${index + 1}`,
          taskRevision: 1,
        },
      });
    }
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    await harness.log.append([
      {
        stream: "publish",
        body: {
          t: "publish-progress" as const,
          assignmentId: ASSIGNMENT_ID,
          domain: "global" as const,
          upToSeq: 2,
          state: "settled" as const,
        },
      },
    ]);
    await expect(harness.journal.resumePendingPublishing()).rejects.toThrow(
      "skips or misstates",
    );
  });

  it("fails closed when publish or final sidecars are not bound to their committed bundle", async () => {
    const publishHarness = await createHarness({
      publisher: {
        decideGlobalBatchAtPrefix() {
          throw new Error("global decision is not expected");
        },
        async apply() {},
      },
    });
    await publishHarness.ledger.dispatch(
      publishHarness.dispatch.envelope,
      publishHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const publishAdapter = new InProcessAssignmentSubmission({
      ledger: publishHarness.ledger,
      owner: publishHarness.journal,
    });
    await publishAdapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(publishHarness.unsigned),
    );
    const publishBundle = await publishHarness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await publishHarness.journal.submitBundle(
      publishBundle,
      submissionContext(publishHarness.unsigned),
    );
    // 注册根校验会在 append 期按 schema 解引用 `batch.ref`,拿 bundle 顶替过不去;
    // 这里要验的是 resume 期“必须恰好绑定一次已提交 run”,因此给一份内容合法、
    // 但不绑定该已提交 run 的真实 MutationBatch。
    const unboundBatch = mutationBatchArtifact(
      createMutationBatch(ASSIGNMENT_ID, [{
        v: 1 as const,
        t: "staged-mutation" as const,
        seq: 1,
        domain: "global" as const,
        requestId: "unbound-publish-batch",
        expected: { anchorEpoch: 1 },
        mutation: { kind: "workscene-create" as const, name: "Unbound" },
      }]),
    );
    await publishHarness.artifacts.put(unboundBatch.bytes);
    await publishHarness.log.append([
      {
        stream: "publish",
        body: {
          t: "publish-decision" as const,
          assignmentId: ASSIGNMENT_ID,
          batch: { ref: unboundBatch.ref },
          sessionCount: 1,
          globalCount: 0,
          outcomes: [{ seq: 1, outcome: { t: "granted" as const, targetRevision: 8 } }],
        },
      },
    ]);
    await expect(publishHarness.journal.resumePendingPublishing()).rejects.toThrow(
      "bind exactly one committed run",
    );

    const finalHarness = await createHarness();
    await finalHarness.ledger.dispatch(
      finalHarness.dispatch.envelope,
      finalHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const finalAdapter = new InProcessAssignmentSubmission({
      ledger: finalHarness.ledger,
      owner: finalHarness.journal,
    });
    await finalAdapter.startAndReport(ASSIGNMENT_ID, submissionContext(finalHarness.unsigned));
    const finalBundle = await finalHarness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await finalHarness.journal.submitBundle(
      finalBundle,
      submissionContext(finalHarness.unsigned),
    );
    await finalHarness.log.append([
      {
        stream: "final-outbox",
        body: {
          t: "final" as const,
          conversationId: CONVERSATION_ID,
          runId: RUN_ID,
          commitRevision: 8,
          digest: SHA256_ZERO,
          state: "published" as const,
        },
      },
    ]);
    await expect(finalHarness.journal.pendingFinalFrames()).rejects.toThrow(
      "transition is invalid",
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects polluted, stale, and incomplete conversation bundles without a second commit", async () => {
    const publisher: ConversationMutationPublisher = {
      decideGlobalBatchAtPrefix() {
        throw new Error("global decision is not expected");
      },
      async apply() {},
    };
    const harness = await createHarness({ publisher });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await expect(
      harness.ledger.stageMutation(ASSIGNMENT_ID, {
        domain: "global",
        requestId: "polluted-mutation",
        expected: { anchorEpoch: 9 },
        mutation: {
          kind: "workscene-create",
          name: "Focus",
          authorityClaim: "attacker-controlled",
        } as unknown as import("@zhixing/core/contracts").GlobalStagedMutation,
      }),
    ).rejects.toThrow("unknown field");
    await expect(
      harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
        runRecord: {
          type: "run",
          runId: RUN_ID,
          runIndex: 8,
          timestamp: NOW,
          messages: [],
        },
        contentAssets: [],
        streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      }),
    ).rejects.toThrow("originating user message");
    await expect(
      harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
        runRecord: {
          type: "run",
          runId: RUN_ID,
          runIndex: 8,
          timestamp: NOW,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "forged origin" }] },
          ],
        },
        contentAssets: [],
        streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      }),
    ).rejects.toThrow("must begin");
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    const polluted = { ...bundle, ownerEpoch: 3 } as unknown as typeof bundle;
    await expect(
      harness.journal.submitBundle(polluted, submissionContext(harness.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "invalid" } });

    const { v: _version, digest: _digest, ...bundlePayload } = bundle;
    expect(() =>
      createConversationSealedBundle({
        ...bundlePayload,
        body: {
          ...bundle.body,
          windowCompact: {
            summary: "summary",
            pairsCompacted: 1,
            tokensBefore: 10,
            tokensAfter: 5,
            authorityClaim: "attacker-controlled",
          } as unknown as import("@zhixing/core/contracts").WindowCompactInstruction,
        },
      }),
    ).toThrow("unknown field");
    const stale = createConversationSealedBundle({
      ...bundlePayload,
      body: {
        ...bundle.body,
        baseRevision: 6,
      },
    });
    const staleArtifact = sealedBundleArtifact(stale);
    await harness.artifacts.put(staleArtifact.bytes);
    await expect(
      harness.journal.submitBundle(stale, submissionContext(harness.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "fence-rejected" } });
    expect(await harness.journal.pendingFinalFrames()).toEqual([]);

    const orphanRef = await harness.artifacts.put(Buffer.from("orphan", "utf8"));
    const overDeclared = createConversationSealedBundle({
      ...bundlePayload,
      dependencyArtifacts: [orphanRef],
    });
    await harness.artifacts.put(sealedBundleArtifact(overDeclared).bytes);
    await expect(
      harness.journal.submitBundle(overDeclared, submissionContext(harness.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "invalid" } });
    expect(await harness.journal.pendingFinalFrames()).toEqual([]);

    const missingContent = createConversationSealedBundle({
      ...bundlePayload,
      body: {
        ...bundle.body,
        contentAssets: [{ digest: SHA256_ZERO, bytes: 1, kind: "file" }],
      },
    });
    await harness.artifacts.put(sealedBundleArtifact(missingContent).bytes);
    await expect(
      harness.journal.submitBundle(missingContent, submissionContext(harness.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "missing-base" } });
    expect(await harness.journal.pendingFinalFrames()).toEqual([]);

    await rm(harness.artifacts.pathFor(sealedBundleArtifact(bundle).ref));
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "missing-base" } });
    expect(await harness.journal.currentState(RUN_ID)).toBe("running");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("cancels a queued run without creating assignment-side governance", async () => {
    const harness = await createUnassignedHarness();

    await expect(
      harness.journal.cancelRun({ runId: RUN_ID, requestId: "cancel-queued" }),
    ).resolves.toEqual({ state: "cancelled" });
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingDispatches()).toEqual([]);
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("persists one supersede fence before dispatch and safely requeues from its proof", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-timeout",
    );
    expect(await harness.journal.pendingSupersedes()).toEqual([
      { assignmentId: ASSIGNMENT_ID, fence },
    ]);

    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    expect(proof.decision).toBe("not-started-fenced");
    await harness.journal.acceptSupersedeProof(proof);
    await harness.journal.acceptSupersedeProof(proof);

    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    await expect(
      harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ).rejects.toThrow("durably fenced");
  });

  it("recovers the same durable supersede fence after response loss", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-recover",
    );
    const first = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    const replay = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );

    expect(withoutSignature(replay)).toEqual(withoutSignature(first));
    await expect(
      harness.journal.requestSupersede(ASSIGNMENT_ID, "different-request"),
    ).rejects.toThrow("different supersede request");
    await harness.journal.acceptSupersedeProof(replay);
    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
  });

  it("finishes a later cancel from an earlier not-started supersede proof", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-before-cancel",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-supersede",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await expect(
      harness.ledger.cancel(
        ASSIGNMENT_ID,
        cancellation.fence,
        ownerContext(ASSIGNMENT_ID, "executor.cancel"),
      ),
    ).resolves.toBeUndefined();
    expect(await harness.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();
    expect(await harness.journal.pendingSupersedes()).toEqual([
      { assignmentId: ASSIGNMENT_ID, fence },
    ]);

    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("continues a supersede through uncertain and resolves only a not-started proof", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-uncertain-not-started",
    );
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    expect(await harness.journal.pendingSupersedes()).toEqual([
      { assignmentId: ASSIGNMENT_ID, fence },
    ]);
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    expect(proof.decision).toBe("not-started-fenced");
    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
  });

  it("durably stops uncertain supersede redrive after already-started proof", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-uncertain-started",
    );
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    expect(proof.decision).toBe("already-started");
    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    expect(await reopenJournal(harness).pendingSupersedes()).toEqual([]);
    expect(
      (await harness.log.readStream(`run:${CONVERSATION_ID}`)).some(
        (record) =>
          (record.body as { readonly t?: string }).t ===
          "supersede-started-observed",
      ),
    ).toBe(true);
  });

  it("rejects cancel and supersede not-started proofs after durable started without cross-stopping recovery", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const supersedeFence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-before-owner-started",
    );
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-owner-started",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const cancelProof = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    expect(cancelProof.decision).toBe("not-started");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      cancelProof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    expect(await harness.journal.pendingSupersedes()).toEqual([
      { assignmentId: ASSIGNMENT_ID, fence: supersedeFence },
    ]);

    const supersedePayload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      fence: supersedeFence,
      decision: "not-started-fenced" as const,
      lastRecordSeq: cancelProof.lastRecordSeq,
      ledgerDigest: cancelProof.ledgerDigest,
    };
    const supersedeProof = {
      ...supersedePayload,
      signature: harness.identity.sign("SupersedeProof", 1, supersedePayload),
    };
    await harness.journal.acceptSupersedeProof(supersedeProof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    expect(await reopenJournal(harness).pendingSupersedes()).toEqual([]);
  });
});
