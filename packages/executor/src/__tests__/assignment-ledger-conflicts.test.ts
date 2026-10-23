// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：conflicts。
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { AssignmentEntry, CancelProofBody } from "@zhixing/core/contracts";
import { advanceAssignmentLedger, createConversationSealedBundle, sealedBundleArtifact, signCancelProof, signSupersedeProof, validateCancelProof, validateDispatchConflictProof, validateSupersedeProof } from "@zhixing/core/protocol";
import { ConversationRunJournal, InProcessConversationDispatcher } from "@zhixing/owner-kernel/conversation-assignment";
import { describe, expect, it, vi } from "vitest";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission } from "../assignment-ledger.js";
import { NOW, EXECUTOR_ID, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID, SHA256_ZERO, ABORT_TICKET_DIGEST, DURABLE_IO_TEST_TIMEOUT_MS, matchingSnapshotFor, matchingPermissionSnapshotFor, allowOnceDecisionDigest, deliveryParticipant, signedMirrorBatch, mirrorReceipt, ownerControl, submission, createRevocationAwareSubmission, createUnassignedHarness, createHarness, createUnsignedEnvelope, ownerContext, submissionContext, applyResolutionControl, replaceAssignmentAfterUncertain, sealDefaultBundle, createAlternativeDispatch, createCancellationSubmission, createBundleSubmission, reopenJournal, withoutSignature, replayFixtureLog } from "./assignment-ledger-fixture.js";

describe("conversation assignment protocol", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("rejects an abort-ticket halted proof bound to a different surface", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const page = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
    const abort: AssignmentEntry = {
      recordSeq: page.toSeq + 1,
      body: {
        v: 1,
        t: "abort-requested",
        via: "abort-ticket",
        refId: ABORT_TICKET_DIGEST,
        surfacePrincipal: "surface:user-1",
      },
    };
    const abortDigest = advanceAssignmentLedger(page.chainDigest, abort);
    const wrongSurface = signCancelProof(
      {
        v: 1,
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        authority: {
          execution: "conversation",
          conversationId: CONVERSATION_ID,
          ownerEpoch: 3,
        },
        cause: "abort-ticket",
        ticketDigest: ABORT_TICKET_DIGEST,
        surfacePrincipal: "surface:other",
        decision: "halted",
        lastEffectSeq: 0,
        lastRecordSeq: abort.recordSeq,
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        ledgerDigest: abortDigest,
        issuedAt: NOW,
      },
      harness.identity,
    );
    await harness.log.append<AssignmentEntry>([
      { stream: `assignment:${ASSIGNMENT_ID}`, body: abort },
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: abort.recordSeq + 1,
          body: { v: 1, t: "halted", proof: wrongSurface },
        },
      },
    ]);

    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("halted does not close the durable cancellation prefix");
  });

  it("moves a contradictory not-started proof to uncertain instead of redispatching", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect((await harness.journal.currentResolution(RUN_ID))?.cause).toBe(
      "cancel-unproven",
    );
  });

  it("commits when bundle sealing won before the owner cancellation fence", async () => {
    const harness = await createHarness();
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
    const bundle = await sealDefaultBundle(harness.ledger);
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-seal",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    expect(await harness.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
  });

  it("rejects bundle sealing when a cancellation fence won first", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-before-seal",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await expect(sealDefaultBundle(harness.ledger)).rejects.toThrow("before started");
  });

  it.each([
    ["sealed", "owner-fence", "abort-ticket"],
    ["sealed", "abort-ticket", "owner-fence"],
    ["owner-fence", "sealed", "abort-ticket"],
    ["owner-fence", "abort-ticket", "sealed"],
    ["abort-ticket", "sealed", "owner-fence"],
    ["abort-ticket", "owner-fence", "sealed"],
  ] as const)(
    "linearizes the three-way cancellation race in order %s → %s → %s",
    async (...order) => {
      const harness = await createHarness();
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
      let bundle: Awaited<ReturnType<typeof sealDefaultBundle>> | undefined;
      for (const actor of order) {
        if (actor === "sealed") {
          try {
            bundle = await sealDefaultBundle(harness.ledger);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
          }
        } else if (actor === "owner-fence") {
          const cancelled = await harness.journal.cancelRun({
            runId: RUN_ID,
            requestId: "race-owner-fence",
          });
          if (cancelled.state !== "cancel-requested") {
            throw new Error("race cancellation fence missing");
          }
          await harness.ledger.cancel(
            ASSIGNMENT_ID,
            cancelled.fence,
            ownerContext(ASSIGNMENT_ID, "executor.cancel"),
          );
        } else {
          await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
            ticketDigest: ABORT_TICKET_DIGEST,
            surfacePrincipal: "surface:user-1",
          });
        }
      }

      if (order[0] === "sealed") {
        expect(bundle).toBeDefined();
        await expect(
          harness.journal.submitBundle(
            bundle!,
            submissionContext(harness.unsigned),
          ),
        ).resolves.toEqual({ committed: true, commitRevision: 8 });
        expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
      } else {
        expect(bundle).toBeUndefined();
        const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
        expect(proof?.decision).toBe("halted");
        await harness.journal.submitCancelProof(
          ASSIGNMENT_ID,
          proof!,
          submissionContext(harness.unsigned),
        );
        expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
      }
    },
  );

  it("recovers acknowledgement after a legal late bundle commits from uncertainty", async () => {
    const harness = await createHarness();
    const liveNotices: Awaited<ReturnType<typeof harness.journal.statusHistory>> = [];
    harness.journal.onStatus(() => {
      throw new Error("simulated status consumer failure");
    });
    harness.journal.onStatus((notice) => {
      liveNotices.push(notice);
    });
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
    const bundle = await sealDefaultBundle(harness.ledger);
    const fact = await harness.journal.markAssignmentUncertain(
      ASSIGNMENT_ID,
      "ledger-unknown",
    );

    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
    expect((await harness.journal.currentResolution(RUN_ID))?.resolution?.kind).toBe(
      "late-bundle-committed",
    );
    const uncertainNotices = (await harness.journal.statusHistory(RUN_ID, 0)).filter(
      (notice) => notice.state === "uncertain" || notice.state === "uncertain-closed",
    );
    expect(uncertainNotices).toEqual([
      expect.objectContaining({
        state: "uncertain",
        openFactDigest: fact.openFactDigest,
      }),
      expect.objectContaining({
        state: "uncertain-closed",
        openFactDigest: fact.openFactDigest,
        closedBy: "late-bundle-committed",
        resultingState: "committed",
      }),
    ]);
    await vi.waitFor(() =>
      expect(
        liveNotices.filter(
          (notice) =>
            notice.state === "uncertain" || notice.state === "uncertain-closed",
        ),
      ).toEqual(uncertainNotices),
    );
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "sealed" });
    const restarted = reopenJournal(harness);
    await expect(restarted.statusHistory(RUN_ID, 0)).resolves.toEqual(
      await harness.journal.statusHistory(RUN_ID, 0),
    );
    expect(await restarted.assignmentsAwaitingRecovery()).toEqual([
      expect.objectContaining({ assignmentId: ASSIGNMENT_ID, state: "committed" }),
    ]);

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: restarted,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, restarted),
      bundleSubmission: createBundleSubmission(harness, restarted),
    });
    expect(await dispatcher.recoverAssignments()).toBe(1);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({
      phase: "acked",
      acknowledgedCommitRevision: 8,
    });
    const secondRestart = reopenJournal(harness);
    expect(await secondRestart.assignmentsAwaitingRecovery()).toEqual([]);
    const query = vi.spyOn(harness.ledger, "queryLedger");
    const secondDispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: secondRestart,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, secondRestart),
      bundleSubmission: createBundleSubmission(harness, secondRestart),
    });
    expect(await secondDispatcher.recoverAssignments()).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["user-verified-side-effects", "failed"],
    ["user-abandoned", "cancelled"],
    ["user-retry-acknowledged", "queued"],
  ] as const)("applies uncertain decision %s exactly once", async (decision, state) => {
    const harness = await createHarness();
    const liveNotices: Awaited<ReturnType<typeof harness.journal.statusHistory>> = [];
    harness.journal.onStatus((notice) => {
      liveNotices.push(notice);
    });
    const fact = await harness.journal.markAssignmentUncertain(
      ASSIGNMENT_ID,
      "ledger-unknown",
    );
    const requestId = `resolve-${decision}`;
    await expect(
      applyResolutionControl(harness, {
        requestId,
        openFactDigest: fact.openFactDigest,
        decision,
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      result: {
        status: "ok",
        body: { t: "uncertain-resolve", state },
      },
    });
    expect(await harness.journal.currentState(RUN_ID)).toBe(state);
    const uncertainNotices = (await harness.journal.statusHistory(RUN_ID, 0)).filter(
      (notice) => notice.state === "uncertain" || notice.state === "uncertain-closed",
    );
    expect(uncertainNotices).toEqual([
      expect.objectContaining({
        state: "uncertain",
        openFactDigest: fact.openFactDigest,
      }),
      expect.objectContaining({
        state: "uncertain-closed",
        openFactDigest: fact.openFactDigest,
        closedBy: decision,
        resultingState: state,
      }),
    ]);
    await vi.waitFor(() => expect(liveNotices).toEqual(uncertainNotices));

    const atomic = (await harness.log.readAll()).find((commit) =>
      commit.entries.some(
        (entry) =>
          entry.stream === "control" &&
          (entry.body as { readonly t?: string; readonly requestId?: string }).t ===
            "applied" &&
          (entry.body as { readonly requestId?: string }).requestId === requestId,
      ),
    );
    expect(
      atomic?.entries.map((entry) => ({
        stream: entry.stream,
        t: (entry.body as { readonly t?: string }).t,
      })),
    ).toEqual(
      expect.arrayContaining([
        { stream: `run:${CONVERSATION_ID}`, t: "resolution" },
        { stream: `run:${CONVERSATION_ID}`, t: "state" },
        { stream: "control", t: "applied" },
      ]),
    );
    const beforeReplay = (await harness.log.readAll()).length;
    await expect(
      applyResolutionControl(harness, {
        requestId,
        openFactDigest: fact.openFactDigest,
        decision,
      }),
    ).resolves.toMatchObject({ kind: "replayed" });
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);
    await expect(
      applyResolutionControl(harness, {
        requestId: `different-${decision}`,
        openFactDigest: fact.openFactDigest,
        decision,
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      result: { status: "rejected", error: { code: "fence-rejected" } },
    });
  });

  it("keeps a successor attempt authoritative over delayed started and mirror events", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "historical-interaction",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/old-attempt.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const finished = await harness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "historical-interaction",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "historical-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("historical-interaction"),
        by: "surface:user-1",
      },
    );
    const snapshot = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if (!("phase" in snapshot)) throw new Error("expected ledger snapshot");
    const successor = await replaceAssignmentAfterUncertain(
      harness,
      "ledger-unknown",
      "replace-before-delayed-started",
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");
    const before = (await harness.log.readAll()).length;

    await expect(
      harness.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("invalid for the current run state");
    await expect(
      harness.journal.reconcileStarted(ASSIGNMENT_ID, snapshot),
    ).rejects.toThrow("invalid for the current run state");
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        signedMirrorBatch(harness.identity, [finished]),
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("historical assignment");
    expect(await harness.log.readAll()).toHaveLength(before);
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");

    const history = await harness.journal.statusHistory(RUN_ID, 0);
    await replayFixtureLog(harness).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state" as const,
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "running" as const,
          statusRevision: history.at(-1)!.statusRevision + 1,
        },
      },
    ]);
    await expect(reopenJournal(harness).currentState(RUN_ID)).rejects.toThrow(
      "does not bind its assignment",
    );
    expect(successor.dispatch.assignmentId).toBe("assignment-2");
  });

  it("allows only exact historical replay and rejects fresh A1 terminal facts after A2", async () => {
    const started = await createHarness();
    await started.ledger.dispatch(
      started.dispatch.envelope,
      started.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await started.ledger.start(ASSIGNMENT_ID);
    await started.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(started.unsigned),
    );
    const startedSnapshot = await started.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if (!("phase" in startedSnapshot)) throw new Error("expected ledger snapshot");
    await replaceAssignmentAfterUncertain(
      started,
      "ledger-unknown",
      "replace-after-durable-started",
    );
    const beforeStartedReplay = (await started.log.readAll()).length;
    await expect(
      started.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(started.unsigned),
      ),
    ).resolves.toBeUndefined();
    await expect(
      started.journal.reconcileStarted(ASSIGNMENT_ID, startedSnapshot),
    ).resolves.toBeUndefined();
    expect(await started.log.readAll()).toHaveLength(beforeStartedReplay);
    expect(await started.journal.currentState(RUN_ID)).toBe("dispatched");

    const bundled = await createHarness();
    await bundled.ledger.dispatch(
      bundled.dispatch.envelope,
      bundled.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await bundled.ledger.start(ASSIGNMENT_ID);
    await bundled.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(bundled.unsigned),
    );
    const oldBundle = await sealDefaultBundle(bundled.ledger);
    await replaceAssignmentAfterUncertain(
      bundled,
      "ledger-unknown",
      "replace-before-delayed-bundle",
    );
    await expect(
      bundled.journal.submitBundle(
        oldBundle,
        submissionContext(bundled.unsigned),
      ),
    ).resolves.toMatchObject({
      committed: false,
      error: { code: "fence-rejected" },
    });
    expect(await bundled.journal.currentState(RUN_ID)).toBe("dispatched");

    const cancelled = await createHarness();
    await cancelled.ledger.dispatch(
      cancelled.dispatch.envelope,
      cancelled.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await cancelled.ledger.start(ASSIGNMENT_ID);
    await cancelled.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(cancelled.unsigned),
    );
    const cancellation = await cancelled.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-before-attempt-replacement",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await cancelled.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const oldCancelProof = await cancelled.ledger.cancelProof(ASSIGNMENT_ID);
    if (!oldCancelProof) throw new Error("cancel proof missing");
    await replaceAssignmentAfterUncertain(
      cancelled,
      "cancel-unproven",
      "replace-before-delayed-cancel-proof",
    );
    await expect(
      cancelled.journal.submitCancelProof(
        ASSIGNMENT_ID,
        oldCancelProof,
        submissionContext(cancelled.unsigned),
      ),
    ).rejects.toThrow("historical assignment");
    expect(await cancelled.journal.currentState(RUN_ID)).toBe("dispatched");

    const superseded = await createHarness();
    await superseded.ledger.dispatch(
      superseded.dispatch.envelope,
      superseded.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const fence = await superseded.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-before-attempt-replacement",
    );
    const oldTerminationProof = await superseded.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await replaceAssignmentAfterUncertain(
      superseded,
      "ledger-unknown",
      "replace-before-delayed-termination-proof",
    );
    await expect(
      superseded.journal.acceptSupersedeProof(oldTerminationProof),
    ).rejects.toThrow("historical assignment");
    expect(await superseded.journal.currentState(RUN_ID)).toBe("dispatched");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("idempotently accepts a conflict whose accepted side is owner-authoritative", async () => {
    const harness = await createHarness();
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const result = await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await expect(
      harness.journal.recordDispatchConflict(alternative, result),
    ).resolves.toBe("acked-original");
    await expect(
      harness.journal.recordDispatchConflict(alternative, result),
    ).resolves.toBe("acked-original");
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");
    expect(await harness.journal.pendingDispatches()).toEqual([]);
  });

  it("opens and contains a mismatched dispatch conflict without automatic redispatch", async () => {
    const harness = await createHarness();
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const result = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await expect(
      harness.journal.recordDispatchConflict(harness.dispatch, result),
    ).resolves.toBe("opened-uncertain");
    await expect(
      harness.journal.recordDispatchConflict(harness.dispatch, result),
    ).resolves.toBe("opened-uncertain");
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingDispatches()).toEqual([]);
    const [pending] = await harness.journal.pendingCancellations();
    expect(pending).toBeDefined();
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending!.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("requeues a mismatched dispatch only after a not-started containment proof", async () => {
    const harness = await createHarness();
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const result = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await harness.journal.recordDispatchConflict(harness.dispatch, result);
    const open = await harness.journal.currentResolution(RUN_ID);
    if (!open || open.resolution) throw new Error("dispatch conflict did not open uncertainty");
    const [pending] = await harness.journal.pendingCancellations();
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending!.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
    expect((await harness.journal.currentResolution(RUN_ID))?.resolution?.kind).toBe(
      "proven-not-started-redispatched",
    );
    expect((await harness.journal.statusHistory(RUN_ID, 0)).at(-1)).toMatchObject({
      state: "uncertain-closed",
      openFactDigest: open.openFactDigest,
      closedBy: "proven-not-started-redispatched",
      resultingState: "queued",
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it.each([
    ["not-started", false, "queued"],
    ["halted", true, "uncertain"],
  ] as const)(
    "contains a dispatch conflict when an abort-ticket %s proof wins before the owner fence",
    async (decision, started, expectedState) => {
      const harness = await createHarness();
      const alternative = createAlternativeDispatch(harness);
      await harness.ledger.dispatch(
        alternative.envelope,
        alternative.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      if (started) await harness.ledger.start(ASSIGNMENT_ID);
      const result = await harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      if (result.accepted || result.outcome !== "conflicting-redelivery") {
        throw new Error("expected dispatch conflict");
      }
      await harness.journal.recordDispatchConflict(harness.dispatch, result);
      await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
        ticketDigest: ABORT_TICKET_DIGEST,
        surfacePrincipal: "surface:user-1",
      });
      const firstProof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
      expect(firstProof).toMatchObject({ cause: "abort-ticket", decision });
      const [pending] = await harness.journal.pendingCancellations();
      if (!pending || !firstProof) throw new Error("conflict cancellation is not pending");
      const beforeRedrive = await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      );
      if ("entries" in beforeRedrive) throw new Error("expected ledger snapshot");
      await harness.ledger.cancel(
        ASSIGNMENT_ID,
        pending.fence,
        ownerContext(ASSIGNMENT_ID, "executor.cancel"),
      );
      const afterRedrive = await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      );
      if ("entries" in afterRedrive) throw new Error("expected ledger snapshot");
      expect(afterRedrive.lastSeq).toBe(beforeRedrive.lastSeq);
      expect(withoutSignature((await harness.ledger.cancelProof(ASSIGNMENT_ID))!)).toEqual(
        withoutSignature(firstProof),
      );

      await harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        firstProof,
        submissionContext(harness.unsigned),
      );
      expect(await harness.journal.currentState(RUN_ID)).toBe(expectedState);
      expect(await harness.journal.pendingCancellations()).toEqual([]);
      const containment = (await harness.log.readStream(`run:${CONVERSATION_ID}`)).find(
        (record) =>
          (record.body as { readonly t?: string }).t === "dispatch-conflict-contained",
      );
      expect(containment?.body).toMatchObject({
        proof: { cause: "abort-ticket", decision },
      });
      const reopened = reopenJournal(harness);
      expect(await reopened.currentState(RUN_ID)).toBe(expectedState);
      expect(await reopened.pendingCancellations()).toEqual([]);
    },
  );

  it("atomically contains a dispatch conflict with a strictly later supersede proof", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-conflicting-dispatch",
    );
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const result = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await harness.journal.recordDispatchConflict(harness.dispatch, result);
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    expect(proof).toMatchObject({
      decision: "not-started-fenced",
      lastRecordSeq: result.proof.receivedRecordSeq + 1,
    });

    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    const records = await harness.log.readStream(`run:${CONVERSATION_ID}`);
    expect(
      records.some(
        (record) =>
          (record.body as { readonly t?: string }).t ===
          "dispatch-conflict-contained",
      ),
    ).toBe(true);
  });

  it("rejects standalone not-started conflict containment during replay", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "non-atomic-conflict-containment",
    );
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const result = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await harness.journal.recordDispatchConflict(harness.dispatch, result);
    const fact = (await harness.journal.currentResolution(RUN_ID))!;
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await replayFixtureLog(harness).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "dispatch-conflict-contained",
          assignmentId: ASSIGNMENT_ID,
          openFactDigest: fact.openFactDigest,
          proof,
        },
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "containment is invalid",
    );
  });

  it.each(["failed", "expired"] as const)(
    "closes an unassigned queued run as %s without creating assignment governance",
    async (outcome) => {
      const harness = await createUnassignedHarness();
      await harness.journal.closeQueuedRun(RUN_ID, outcome);
      await harness.journal.closeQueuedRun(RUN_ID, outcome);

      expect(await harness.journal.currentState(RUN_ID)).toBe(outcome);
      expect(await harness.journal.pendingDispatches()).toEqual([]);
      expect(await harness.journal.pendingCancellations()).toEqual([]);
    },
  );

  it.each(["temporary-capacity", "offline-explicit-target"] as const)(
    "keeps a recoverable queued condition durable without fabricating an assignment: %s",
    async () => {
      const harness = await createUnassignedHarness();
      const restarted = new ConversationRunJournal({
        conversationId: CONVERSATION_ID,
        ownerEpoch: 3,
        log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
          clock: () => NOW,
          lockWaitMs: 2_000,
        }),
        artifacts: harness.artifacts,
        signer: harness.identity,
        verifier: harness.identity,
        delivery: deliveryParticipant(harness.log),
        clock: () => NOW,
        submission,
        authority: harness.authority,
        projection: harness.projection,
      });

      expect(await restarted.currentState(RUN_ID)).toBe("queued");
      expect(await restarted.pendingDispatches()).toEqual([]);
    },
  );

  it("drives a durable owner cancellation proof through the in-process adapter", async () => {
    const harness = await createHarness();
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    await dispatcher.dispatchPending();

    await expect(
      dispatcher.cancelRun({ runId: RUN_ID, requestId: "cancel-through-adapter" }),
    ).resolves.toMatchObject({ state: "cancel-requested" });
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("recovers an abort-ticket proof after executor durability but before owner submission", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const restarted = reopenJournal(harness);
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: restarted,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, restarted),
      bundleSubmission: createBundleSubmission(harness, restarted),
    });

    await expect(dispatcher.recoverCancellationProofs()).resolves.toBe(1);
    expect(await restarted.currentState(RUN_ID)).toBe("cancelled");
    await expect(dispatcher.recoverCancellationProofs()).resolves.toBe(0);
  });

  it("never redispatches an uncertain assignment without a termination proof", async () => {
    const harness = await createHarness();
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const replacement = createUnsignedEnvelope(harness.identity, {
      assignmentId: "assignment-2",
    });

    await expect(harness.journal.assign(replacement)).rejects.toThrow(
      "different durable assignment",
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
  });

  it("rejects re-signed supersede and cancel proofs that do not bind durable fences", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const supersedeFence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-proof-binding",
    );
    const supersede = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      supersedeFence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    const wrongSupersede = signSupersedeProof(
      {
        ...withoutSignature(supersede),
        fence: { ...supersede.fence, fenceSeq: supersede.fence.fenceSeq + 1 },
      },
      harness.identity,
    );
    await expect(harness.journal.acceptSupersedeProof(wrongSupersede)).rejects.toThrow(
      "does not bind a durable assignment",
    );

    const cancelHarness = await createHarness();
    await cancelHarness.ledger.dispatch(
      cancelHarness.dispatch.envelope,
      cancelHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const cancellation = await cancelHarness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-proof-binding",
    });
    if (cancellation.state !== "cancel-requested") {
      throw new Error("cancel fence missing");
    }
    await cancelHarness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const cancel = (await cancelHarness.ledger.cancelProof(
      ASSIGNMENT_ID,
    )) as Extract<CancelProofBody, { cause: "owner-fence" }>;
    const wrongCancel = signCancelProof(
      {
        ...withoutSignature(cancel),
        fence: { ...cancel.fence, fenceSeq: cancel.fence.fenceSeq + 1 },
      },
      cancelHarness.identity,
    );
    await expect(
      cancelHarness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        wrongCancel,
        submissionContext(cancelHarness.unsigned),
      ),
    ).rejects.toThrow("does not bind the durable assignment authority");
    expect(await cancelHarness.journal.currentState(RUN_ID)).toBe(
      "cancel-requested",
    );
  });

  it("rejects signed cancel payload pollution before it reaches an owner consumer", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-pollution",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    const pollutedPayload = {
      ...withoutSignature(proof),
      ticketDigest: ABORT_TICKET_DIGEST,
    };
    const polluted = {
      ...pollutedPayload,
      signature: harness.identity.sign("CancelProofBody", 1, pollutedPayload),
    } as CancelProofBody;

    expect(() => validateCancelProof(polluted, harness.identity)).toThrow(
      "fields are incomplete or unknown",
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancel-requested");
  });

  it("rejects polluted supersede proofs and contradictory conflict proofs", async () => {
    const harness = await createHarness();
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-pollution",
    );
    const supersede = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    const pollutedSupersedePayload = {
      ...withoutSignature(supersede),
      ticketDigest: ABORT_TICKET_DIGEST,
    };
    const pollutedSupersede = {
      ...pollutedSupersedePayload,
      signature: harness.identity.sign(
        "SupersedeProof",
        1,
        pollutedSupersedePayload,
      ),
    } as typeof supersede;
    expect(() =>
      validateSupersedeProof(pollutedSupersede, harness.identity),
    ).toThrow("fields are incomplete or unknown");

    const conflictHarness = await createHarness();
    const alternative = createAlternativeDispatch(conflictHarness);
    await conflictHarness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await conflictHarness.ledger.dispatch(
      conflictHarness.dispatch.envelope,
      conflictHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    const contradictoryPayload = {
      ...withoutSignature(conflict.proof),
      acceptedActivationDigest: conflict.proof.conflictingActivationDigest,
    };
    const contradictory = {
      ...contradictoryPayload,
      signature: conflictHarness.identity.sign(
        "DispatchConflictProof",
        1,
        contradictoryPayload,
      ),
    };
    expect(() =>
      validateDispatchConflictProof(contradictory, conflictHarness.identity),
    ).toThrow("activation digests must differ");
  });

  it("rejects a conflict proof replayed against a different attempted dispatch", async () => {
    const harness = await createHarness();
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }

    await expect(
      harness.journal.recordDispatchConflict(alternative, conflict),
    ).rejects.toThrow("attempted dispatch");
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");
  });

  it("separates revoked submission settlement and exact replay from active writes", async () => {
    const terminalAuthorization = createRevocationAwareSubmission();
    const terminal = await createHarness({
      submission: terminalAuthorization.authorizer,
    });
    await terminal.ledger.dispatch(
      terminal.dispatch.envelope,
      terminal.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: terminal.ledger,
      owner: terminal.journal,
    });
    await adapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(terminal.unsigned),
    );
    await terminal.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "mirrored-before-terminal",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const finished = await adapter.finishAndMirror(
      ASSIGNMENT_ID,
      "mirrored-before-terminal",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "terminal-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("mirrored-before-terminal"),
        by: "surface:user-1",
      },
      submissionContext(terminal.unsigned),
    );
    const bundle = await sealDefaultBundle(terminal.ledger);
    await expect(
      terminal.journal.submitBundle(
        bundle,
        submissionContext(terminal.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    const { v: _version, digest: _digest, ...bundlePayload } = bundle;
    const conflictingBundle = createConversationSealedBundle({
      ...bundlePayload,
      usage: { ...bundle.usage, outputTokens: bundle.usage.outputTokens + 1 },
    });
    await terminal.artifacts.put(sealedBundleArtifact(conflictingBundle).bytes);
    await expect(
      terminal.journal.submitBundle(
        conflictingBundle,
        submissionContext(terminal.unsigned),
      ),
    ).rejects.toThrow("expired or revoked");
    terminalAuthorization.revoke(ASSIGNMENT_ID);

    const exactMirrorBatch = signedMirrorBatch(terminal.identity, [finished]);

    await expect(
      terminal.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(terminal.unsigned),
      ),
    ).resolves.toBeUndefined();
    await expect(
      terminal.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        exactMirrorBatch,
        submissionContext(terminal.unsigned),
      ),
    ).resolves.toEqual(mirrorReceipt(exactMirrorBatch));
    await expect(
      terminal.journal.submitBundle(
        bundle,
        submissionContext(terminal.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    const freshAfterTerminal = signedMirrorBatch(
      terminal.identity,
      [
        {
          ...finished,
          ordinal: finished.ordinal + 1,
          seq: finished.seq + 1,
          requestId: "fresh-after-terminal",
        },
      ],
      { previousDigest: exactMirrorBatch.mirrorDigest },
    );
    await expect(
      terminal.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        freshAfterTerminal,
        submissionContext(terminal.unsigned),
      ),
    ).rejects.toThrow("historical assignment");

    const settlementAuthorization = createRevocationAwareSubmission();
    const settlement = await createHarness({
      submission: settlementAuthorization.authorizer,
    });
    const alternative = createAlternativeDispatch(settlement);
    await settlement.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await settlement.ledger.dispatch(
      settlement.dispatch.envelope,
      settlement.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await settlement.journal.recordDispatchConflict(settlement.dispatch, conflict);
    settlementAuthorization.revoke(ASSIGNMENT_ID);
    const [pending] = await settlement.journal.pendingCancellations();
    await settlement.ledger.cancel(
      ASSIGNMENT_ID,
      pending!.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await settlement.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("cancel proof missing");
    await expect(
      settlement.journal.submitCancelProof(
        ASSIGNMENT_ID,
        proof,
        submissionContext(settlement.unsigned),
      ),
    ).resolves.toBeUndefined();
    expect(await settlement.journal.currentState(RUN_ID)).toBe("queued");
    await expect(
      settlement.journal.submitCancelProof(
        ASSIGNMENT_ID,
        proof,
        submissionContext(settlement.unsigned),
      ),
    ).resolves.toBeUndefined();
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("settles conflict interaction audit after revocation before producing containment proof", async () => {
    const authorization = createRevocationAwareSubmission();
    const harness = await createHarness({ submission: authorization.authorizer });
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "finished-before-conflict",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/finished.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await harness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "finished-before-conflict",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "finished-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("finished-before-conflict"),
        by: "surface:user-1",
      },
    );
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "pending-at-conflict",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/pending.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const conflict = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    authorization.revoke(ASSIGNMENT_ID);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("conflict cancellation is not pending");

    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    expect(await harness.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    expect(
      await adapter.flushInteractionMirrors(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).toBe(2);
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    expect(
      await adapter.submitCancellation(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).toBe(true);
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
    expect(await reopenJournal(harness).pendingCancellations()).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("binds mirror replay to exact signed batches across lost acknowledgements", async () => {
    const authorization = createRevocationAwareSubmission();
    const harness = await createHarness({ submission: authorization.authorizer });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    for (let index = 0; index < 3; index += 1) {
      const requestId = `mirror-chain-${index}`;
      await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
        requestId,
        toolName: "write-file",
        display: { title: "Write file", lines: [`workspace/chain-${index}.md`] },
        issuedAt: NOW,
        ttlMs: 60_000,
        expiresAt: "2026-07-13T09:01:00.000Z",
      });
      await harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: `chain-ticket-${index}` },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest(requestId),
        by: "surface:user-1",
      });
    }
    const entries = await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID);
    const firstBatch = signedMirrorBatch(harness.identity, entries.slice(0, 1));
    const firstReceipt = await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      firstBatch,
      submissionContext(harness.unsigned),
    );
    const secondBatch = signedMirrorBatch(harness.identity, entries.slice(1), {
      previousDigest: firstBatch.mirrorDigest,
    });
    const secondReceipt = await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      secondBatch,
      submissionContext(harness.unsigned),
    );
    const repeatedRequest = signedMirrorBatch(
      harness.identity,
      [
        {
          ...entries[0]!,
          ordinal: entries.at(-1)!.ordinal + 1,
          seq: entries.at(-1)!.seq + 1,
        },
      ],
      { previousDigest: secondBatch.mirrorDigest },
    );
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        repeatedRequest,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("repeats a durable request identity");
    authorization.revoke(ASSIGNMENT_ID);
    const beforeReplay = (await harness.log.readAll()).length;
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        secondBatch,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toEqual(secondReceipt);
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);

    const subset = signedMirrorBatch(harness.identity, entries.slice(1, 2), {
      previousDigest: firstBatch.mirrorDigest,
    });
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        subset,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("does not continue the durable audit prefix");
    const crossBatch = signedMirrorBatch(harness.identity, entries.slice(0, 2));
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        crossBatch,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("does not continue the durable audit prefix");

    await harness.ledger.markInteractionsMirrored(ASSIGNMENT_ID, secondReceipt);
    const beforeCoveredReceipt = (
      await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)
    ).length;
    await harness.ledger.markInteractionsMirrored(ASSIGNMENT_ID, firstReceipt);
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(
      beforeCoveredReceipt,
    );
    await expect(
      harness.ledger.markInteractionsMirrored(ASSIGNMENT_ID, {
        ...firstReceipt,
        mirrorDigest: SHA256_ZERO,
      }),
    ).rejects.toThrow("exceeds durable finished records");
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
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
    expect(await restarted.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
    expect(firstReceipt).toEqual(mirrorReceipt(firstBatch));
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});
