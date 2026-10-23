// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：fences。
import type { AssignmentEntry, AuthorityCallContext, AuthorityCapability, CancelProofBody, LedgerEvidencePage, LedgerSnapshot, IngressContext } from "@zhixing/core/contracts";
import { advanceAssignmentLedger, assignmentLedgerSeed, dispatchEnvelopeDigest, protocolDigest, signCancelProof, type ConversationInteractionMirrorBatch } from "@zhixing/core/protocol";
import { InProcessConversationDispatcher, type AssignmentSubmissionAuthorizer } from "@zhixing/owner-kernel/conversation-assignment";
import { ControlAdmissionJournal, channelSurfacePrincipal, createConversationControlEnvelope, createInitialControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { describe, expect, it } from "vitest";
import { InProcessAssignmentSubmission } from "../assignment-ledger.js";
import { NOW, EXPIRY, EXECUTOR_ID, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID, SHA256_ZERO, ABORT_TICKET_DIGEST, DURABLE_IO_TEST_TIMEOUT_MS, allowOnceDecisionDigest, CountingArtifactStore, signedMirrorBatch, submission, createRevocationAwareSubmission, createUnassignedHarness, createHarness, ingress, ownerContext, submissionContext, trustedControlSource, applyResolutionControl, applyCancelControl, replaceAssignmentAfterUncertain, sealDefaultBundle, createAlternativeDispatch, createCancellationSubmission, createBundleSubmission, reopenJournal, withoutSignature, replayFixtureLog } from "./assignment-ledger-fixture.js";

describe("conversation assignment protocol", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("rejects fresh mirror facts outside their state fence and repeated request identities", async () => {
    const mirrorEntry = (ordinal: number, seq: number, requestId: string) => ({
      ordinal,
      seq,
      requestId,
      kind: "allow-once" as const,
      outcome: {
        t: "answered" as const,
        authority: { via: "surface-ticket" as const, ticketId: `${requestId}-ticket` },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest(requestId),
        by: "surface:user-1",
      },
      at: NOW,
    });

    const duplicate = await createHarness();
    const firstBatch = signedMirrorBatch(duplicate.identity, [
      mirrorEntry(1, 1, "mirror-request-reused"),
    ]);
    await duplicate.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      firstBatch,
      submissionContext(duplicate.unsigned),
    );
    const repeatedBatch = signedMirrorBatch(
      duplicate.identity,
      [mirrorEntry(2, 2, "mirror-request-reused")],
      { previousDigest: firstBatch.mirrorDigest },
    );
    await expect(
      duplicate.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        repeatedBatch,
        submissionContext(duplicate.unsigned),
      ),
    ).rejects.toThrow("repeats a durable request identity");
    await replayFixtureLog(duplicate).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "interaction-mirror" as const,
          assignmentId: ASSIGNMENT_ID,
          batch: repeatedBatch,
        },
      },
    ]);
    await expect(reopenJournal(duplicate).currentState(RUN_ID)).rejects.toThrow(
      "request identity is invalid",
    );

    const unfenced = await createHarness();
    await unfenced.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await replayFixtureLog(unfenced).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "interaction-mirror" as const,
          assignmentId: ASSIGNMENT_ID,
          batch: signedMirrorBatch(unfenced.identity, [
            mirrorEntry(1, 1, "mirror-without-cancel-fence"),
          ]),
        },
      },
    ]);
    await expect(reopenJournal(unfenced).currentState(RUN_ID)).rejects.toThrow(
      /outside its authorized state|Interaction mirror has no current audit prefix/,
    );

    const terminal = await createHarness();
    await terminal.ledger.dispatch(
      terminal.dispatch.envelope,
      terminal.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: terminal.ledger,
      owner: terminal.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(terminal.unsigned));
    const bundle = await sealDefaultBundle(terminal.ledger);
    await terminal.journal.submitBundle(bundle, submissionContext(terminal.unsigned));
    await replayFixtureLog(terminal).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "interaction-mirror" as const,
          assignmentId: ASSIGNMENT_ID,
          batch: signedMirrorBatch(terminal.identity, [
            mirrorEntry(1, 1, "mirror-after-terminal"),
          ]),
        },
      },
    ]);
    await expect(reopenJournal(terminal).currentState(RUN_ID)).rejects.toThrow(
      "outside its authorized state",
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("replays only the exact contained cancel proof after a successor attempt exists", async () => {
    const authorization = createRevocationAwareSubmission();
    const harness = await createHarness({ submission: authorization.authorizer });
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
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
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("cancel proof missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    await replaceAssignmentAfterUncertain(
      harness,
      "ledger-unknown",
      "retry-after-contained-proof",
    );
    const beforeReplay = (await harness.log.readAll()).length;
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        proof,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toBeUndefined();
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);

    const { signature: _signature, ...proofPayload } = proof;
    const conflictingProof = signCancelProof(
      { ...proofPayload, issuedAt: "2026-07-13T09:00:01.000Z" },
      harness.identity,
    );
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        conflictingProof,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("different durable termination proof");
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("authenticates and activates every submission before payload or artifact work", async () => {
    let counted: CountingArtifactStore | undefined;
    let authenticationCalls = 0;
    const rejecting: AssignmentSubmissionAuthorizer = {
      authenticate() {
        authenticationCalls += 1;
        throw new Error("base submission authentication failed");
      },
      authorize() {
        throw new Error("result authorization must not run");
      },
    };
    const harness = await createHarness({
      submission: rejecting,
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    counted!.resetReads();
    const context = submissionContext(harness.unsigned);
    await expect(harness.journal.reportStarted(ASSIGNMENT_ID, context)).rejects.toThrow(
      "base submission authentication failed",
    );
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        {} as ConversationInteractionMirrorBatch,
        context,
      ),
    ).rejects.toThrow("base submission authentication failed");
    await expect(
      harness.journal.submitCancelProof(ASSIGNMENT_ID, {} as CancelProofBody, context),
    ).rejects.toThrow("base submission authentication failed");
    await expect(harness.journal.submitBundle({} as SealedBundle, context)).rejects.toThrow(
      "base submission authentication failed",
    );
    expect(authenticationCalls).toBe(4);
    expect(counted!.reads).toBe(0);

    const activated = await createHarness({
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    const validContext = submissionContext(activated.unsigned);
    if (validContext.principal.kind !== "assignment") throw new Error("missing capability");
    const assignedCapability = validContext.principal.capability;
    const assignedPayload = withoutSignature(assignedCapability);
    const sameIdMutations = [
      {
        ...assignedPayload,
        methods: [...assignedPayload.methods].reverse(),
      },
      {
        ...assignedPayload,
        resources: [...assignedPayload.resources, "conversation:other"],
      },
      {
        ...assignedPayload,
        expiry: "2026-07-13T09:30:00.000Z",
      },
    ] as const;
    for (const mutation of sameIdMutations) {
      const context: AuthorityCallContext = {
        ...validContext,
        deadlineAt: mutation.expiry,
        principal: {
          kind: "assignment",
          capability: {
            ...mutation,
            methods: [...mutation.methods],
            resources: [...mutation.resources],
            signature: activated.identity.sign("AuthorityCapability", 1, mutation),
          },
        },
      };
      await expect(
        activated.journal.reportStarted(ASSIGNMENT_ID, context),
      ).rejects.toThrow("does not match the durable dispatch capability");
    }
    const forgedPayload = {
      ...withoutSignature(validContext.principal.capability),
      capId: "unactivated-capability",
    };
    const forgedContext: AuthorityCallContext = {
      ...validContext,
      principal: {
        kind: "assignment",
        capability: {
          ...forgedPayload,
          signature: activated.identity.sign(
            "AuthorityCapability",
            1,
            forgedPayload,
          ),
        },
      },
    };
    counted!.resetReads();
    await expect(
      activated.journal.reportStarted(ASSIGNMENT_ID, forgedContext),
    ).rejects.toThrow("not activated by durable authority state");
    await expect(
      activated.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        {} as ConversationInteractionMirrorBatch,
        forgedContext,
      ),
    ).rejects.toThrow("not activated by durable authority state");
    await expect(
      activated.journal.submitCancelProof(
        ASSIGNMENT_ID,
        {} as CancelProofBody,
        forgedContext,
      ),
    ).rejects.toThrow("not activated by durable authority state");
    await expect(
      activated.journal.submitBundle({} as SealedBundle, forgedContext),
    ).rejects.toThrow("not activated by durable authority state");
    expect(counted!.reads).toBe(0);
  });

  it("allows old-epoch exact replay while rejecting old-epoch fresh submissions", async () => {
    const started = await createHarness();
    await started.ledger.dispatch(
      started.dispatch.envelope,
      started.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await expect(
      reopenJournal(started, { ownerEpoch: 4 }).reportStarted(
        ASSIGNMENT_ID,
        submissionContext(started.unsigned),
      ),
    ).rejects.toThrow("stale owner epoch");
    await started.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(started.unsigned),
    );
    await expect(
      reopenJournal(started, { ownerEpoch: 4 }).reportStarted(
        ASSIGNMENT_ID,
        submissionContext(started.unsigned),
      ),
    ).resolves.toBeUndefined();

    const mirrored = await createHarness();
    const batch = signedMirrorBatch(mirrored.identity, [
      {
        ordinal: 1,
        seq: 1,
        requestId: "old-epoch-mirror",
        kind: "allow-once",
        outcome: {
          t: "answered",
          authority: { via: "surface-ticket", ticketId: "old-epoch-ticket" },
          decision: { allowed: true },
          decisionDigest: allowOnceDecisionDigest("old-epoch-mirror"),
          by: "surface:user-1",
        },
        at: NOW,
      },
    ]);
    await expect(
      reopenJournal(mirrored, { ownerEpoch: 4 }).mirrorInteractions(
        ASSIGNMENT_ID,
        batch,
        submissionContext(mirrored.unsigned),
      ),
    ).rejects.toThrow("stale owner epoch");
    const receipt = await mirrored.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      batch,
      submissionContext(mirrored.unsigned),
    );
    await expect(
      reopenJournal(mirrored, { ownerEpoch: 4 }).mirrorInteractions(
        ASSIGNMENT_ID,
        batch,
        submissionContext(mirrored.unsigned),
      ),
    ).resolves.toEqual(receipt);

    const cancelled = await createHarness();
    await cancelled.ledger.dispatch(
      cancelled.dispatch.envelope,
      cancelled.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const cancellation = await cancelled.journal.cancelRun({
      runId: RUN_ID,
      requestId: "old-epoch-cancel",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await cancelled.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await cancelled.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("cancel proof missing");
    await expect(
      reopenJournal(cancelled, { ownerEpoch: 4 }).submitCancelProof(
        ASSIGNMENT_ID,
        proof,
        submissionContext(cancelled.unsigned),
      ),
    ).rejects.toThrow("stale owner epoch");
    await cancelled.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(cancelled.unsigned),
    );
    await expect(
      reopenJournal(cancelled, { ownerEpoch: 4 }).submitCancelProof(
        ASSIGNMENT_ID,
        proof,
        submissionContext(cancelled.unsigned),
      ),
    ).resolves.toBeUndefined();
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("does no artifact reads for exact bundle replay or stable fence rejection", async () => {
    let counted: CountingArtifactStore | undefined;
    const committed = await createHarness({
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    await committed.ledger.dispatch(
      committed.dispatch.envelope,
      committed.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: committed.ledger,
      owner: committed.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(committed.unsigned));
    const bundle = await sealDefaultBundle(committed.ledger);
    await committed.journal.submitBundle(bundle, submissionContext(committed.unsigned));
    await expect(committed.journal.recentExecutorAffinity()).resolves.toBe(
      EXECUTOR_ID,
    );
    counted = new CountingArtifactStore(committed.artifacts);
    const coldCommitted = reopenJournal(committed, { artifacts: counted });
    await expect(coldCommitted.recentExecutorAffinity()).resolves.toBe(
      EXECUTOR_ID,
    );
    counted.resetReads();
    await expect(
      coldCommitted.submitBundle(bundle, submissionContext(committed.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(counted.reads).toBe(0);
    const transferredCommitted = reopenJournal(committed, {
      ownerEpoch: 4,
      artifacts: counted,
    });
    // 新打开的 owner 先追平认证 canonical 状态中未落盘的尾部（前序实例未正式停止，相当于崩溃后
    // 重开；成本受落盘阈值约束、不随历史增长），与上方冷重开一致；被断言的是重放本身不读制品。
    await expect(transferredCommitted.recentExecutorAffinity()).resolves.toBe(EXECUTOR_ID);
    counted.resetReads();
    await expect(
      transferredCommitted.submitBundle(bundle, submissionContext(committed.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(counted.reads).toBe(0);

    const historical = await createHarness({
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    await replaceAssignmentAfterUncertain(
      historical,
      "ledger-unknown",
      "replace-before-malformed-bundle",
    );
    counted = new CountingArtifactStore(historical.artifacts);
    const coldHistorical = reopenJournal(historical, { artifacts: counted });
    await coldHistorical.recentExecutorAffinity();
    counted.resetReads();
    await expect(
      coldHistorical.submitBundle(
        {} as SealedBundle,
        submissionContext(historical.unsigned),
      ),
    ).resolves.toMatchObject({
      committed: false,
      error: { code: "fence-rejected" },
    });
    expect(counted.reads).toBe(0);

    const conflicted = await createHarness({
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    const alternative = createAlternativeDispatch(conflicted);
    await conflicted.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await conflicted.ledger.dispatch(
      conflicted.dispatch.envelope,
      conflicted.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await conflicted.journal.recordDispatchConflict(conflicted.dispatch, conflict);
    counted = new CountingArtifactStore(conflicted.artifacts);
    const coldConflicted = reopenJournal(conflicted, { artifacts: counted });
    await coldConflicted.recentExecutorAffinity();
    counted.resetReads();
    await expect(
      coldConflicted.submitBundle(
        {} as SealedBundle,
        submissionContext(conflicted.unsigned),
      ),
    ).resolves.toMatchObject({
      committed: false,
      error: { code: "fence-rejected" },
    });
    expect(counted.reads).toBe(0);

    const stale = await createHarness();
    counted = new CountingArtifactStore(stale.artifacts);
    const transferredFresh = reopenJournal(stale, {
      ownerEpoch: 4,
      artifacts: counted,
    });
    await transferredFresh.recentExecutorAffinity();
    counted.resetReads();
    await expect(
      transferredFresh.submitBundle(
        {} as SealedBundle,
        submissionContext(stale.unsigned),
      ),
    ).resolves.toMatchObject({
      committed: false,
      error: { code: "fence-rejected" },
    });
    expect(counted.reads).toBe(0);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects a cold exact replay whose capability epoch does not bind the durable assigned snapshot", async () => {
    const harness = await createHarness();
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
    const bundle = await sealDefaultBundle(harness.ledger);
    await harness.journal.submitBundle(bundle, submissionContext(harness.unsigned));

    const capability = harness.unsigned.capabilities[0]!;
    const forgedPayload = {
      ...withoutSignature(capability),
      ownerEpoch: capability.ownerEpoch + 1,
    };
    const forged = {
      ...forgedPayload,
      signature: harness.identity.sign("AuthorityCapability", 1, forgedPayload),
    } as typeof capability;
    const cold = reopenJournal(harness, { ownerEpoch: capability.ownerEpoch + 1 });
    await expect(
      cold.submitBundle(bundle, {
        principal: { kind: "assignment", capability: forged },
        requestId: "cold-exact-wrong-epoch",
        deadlineAt: EXPIRY,
      }),
    ).rejects.toThrow("not activated by durable authority state");
    await expect(
      cold.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects a self-consistent resolution fact whose ownerEpoch does not bind the durable assignment", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const subject = {
      execution: "conversation" as const,
      runId: RUN_ID,
      conversationId: CONVERSATION_ID,
      ownerEpoch: 4,
      assignmentId: ASSIGNMENT_ID,
    };
    const openedAt = NOW;
    const cause = "ledger-unknown" as const;
    const fact = {
      subject,
      openedAt,
      cause,
      openFactDigest: protocolDigest("UncertainOpenFact", 1, {
        subject,
        openedAt,
        cause,
      }),
    };
    await replayFixtureLog(harness).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: { t: "resolution", runId: RUN_ID, fact },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "uncertain",
          statusRevision: 3,
        },
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "belongs to another authority",
    );
    const cold = reopenJournal(harness);
    await expect(
      cold.submitBundle({} as SealedBundle, submissionContext(harness.unsigned)),
    ).rejects.toThrow("belongs to another authority");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects a second dispatch conflict for an acknowledged assignment in both full and guard replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const alternative = createAlternativeDispatch(harness);
    const first = await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (first.accepted || first.outcome !== "conflicting-redelivery") {
      throw new Error("expected dispatch conflict");
    }
    await expect(
      harness.journal.recordDispatchConflict(alternative, first),
    ).resolves.toBe("acked-original");
    const secondAlternative = createAlternativeDispatch(
      harness,
      "2026-07-13T09:00:02.000Z",
    );
    const second = await harness.ledger.dispatch(
      secondAlternative.envelope,
      secondAlternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (second.accepted || second.outcome !== "conflicting-redelivery") {
      throw new Error("expected second dispatch conflict");
    }
    await replayFixtureLog(harness).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "dispatch-conflict",
          assignmentId: ASSIGNMENT_ID,
          proof: second.proof,
          handling: "acked-original",
        },
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "Dispatch conflict replay contract",
    );
    const cold = reopenJournal(harness);
    await expect(
      cold.submitBundle({} as SealedBundle, submissionContext(harness.unsigned)),
    ).rejects.toThrow("Dispatch conflict replay contract");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects replayed supersede facts that contradict durable started or lack their request", async () => {
    const started = await createHarness();
    await started.ledger.dispatch(
      started.dispatch.envelope,
      started.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const fence = await started.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-after-started",
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: started.ledger,
      owner: started.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(started.unsigned));
    const startedPayload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      decision: "not-started-fenced" as const,
      fence: { fenceSeq: fence.fenceSeq, requestId: fence.requestId },
      lastRecordSeq: 1,
      ledgerDigest: SHA256_ZERO,
    };
    const startedProof = {
      ...startedPayload,
      signature: started.identity.sign("SupersedeProof", 1, startedPayload),
    };
    await replayFixtureLog(started).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "assignment-superseded",
          assignmentId: ASSIGNMENT_ID,
          proof: startedProof,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "queued",
          statusRevision: 4,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked",
          assignmentId: ASSIGNMENT_ID,
          capId: "capability-1",
        },
      },
    ]);
    await expect(started.journal.currentState(RUN_ID)).rejects.toThrow(
      "Assignment supersede replay contract",
    );
    const coldStarted = reopenJournal(started);
    await expect(
      coldStarted.submitBundle({} as SealedBundle, submissionContext(started.unsigned)),
    ).rejects.toThrow("Assignment supersede replay contract");

    const unfenced = await createHarness();
    await unfenced.ledger.dispatch(
      unfenced.dispatch.envelope,
      unfenced.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const unfencedPayload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      decision: "not-started-fenced" as const,
      fence: { fenceSeq: 99, requestId: "missing-request" },
      lastRecordSeq: 1,
      ledgerDigest: SHA256_ZERO,
    };
    const unfencedProof = {
      ...unfencedPayload,
      signature: unfenced.identity.sign("SupersedeProof", 1, unfencedPayload),
    };
    await replayFixtureLog(unfenced).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "assignment-superseded",
          assignmentId: ASSIGNMENT_ID,
          proof: unfencedProof,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "queued",
          statusRevision: 3,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked",
          assignmentId: ASSIGNMENT_ID,
          capId: "capability-1",
        },
      },
    ]);
    await expect(unfenced.journal.currentState(RUN_ID)).rejects.toThrow(
      "Assignment supersede replay contract",
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("writes each capability revocation once across uncertain containment and resolution", async () => {
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
    const open = (await harness.journal.currentResolution(RUN_ID))!;
    await applyResolutionControl(harness, {
      requestId: "resolve-after-cancel-unproven",
      openFactDigest: open.openFactDigest,
      decision: "user-abandoned",
    });

    const records = await harness.log.readStream(`run:${CONVERSATION_ID}`);
    expect(
      records.filter(
        (record) =>
          (record.body as { readonly t?: string }).t === "capability-revoked",
      ),
    ).toHaveLength(1);
  });

  it("requeues a dispatched run only from a signed rejection-before-received proof", async () => {
    const harness = await createHarness();
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      dispatchDigest: dispatchEnvelopeDigest(harness.dispatch.envelope),
      error: {
        code: "missing-base" as const,
        message: "required base is unavailable",
        retryable: true,
      },
      lastRecordSeq: 1,
      ledgerDigest: SHA256_ZERO,
    };
    const proof = {
      ...payload,
      signature: harness.identity.sign("DispatchRejectionProof", 1, payload),
    };

    await expect(
      harness.journal.acceptDispatchRejection({
        v: 1,
        accepted: false,
        outcome: "rejected-before-received",
        error: { ...payload.error, message: "polluted response" },
        proof,
      }),
    ).rejects.toThrow("response does not match");
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");

    await harness.journal.acceptDispatchRejection({
      v: 1,
      accepted: false,
      outcome: "rejected-before-received",
      error: payload.error,
      proof,
    });
    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
  });

  it("accepts an abort-ticket not-started proof after owner cancellation was requested", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "owner-cancel-before-surface-abort",
    });
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    expect(proof).toMatchObject({ cause: "abort-ticket", decision: "not-started" });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("accepts an abort-ticket halted proof after running owner cancellation was requested", async () => {
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
    await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "owner-cancel-before-running-surface-abort",
    });
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    expect(proof).toMatchObject({ cause: "abort-ticket", decision: "halted" });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("moves a requested cancellation to uncertain when an abort leaves an open effect", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "external-call",
      toolName: "calendar.create",
      summary: "create calendar event",
      target: "external-service",
    });
    await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-with-open-abort-effect",
    });
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    expect(await harness.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    expect(await dispatcher.recoverCancellationProofs()).toBe(1);
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
  });

  it("rejects polluted ledger evidence before opening uncertain", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "external-call",
      toolName: "calendar.create",
      summary: "create calendar event",
      target: "external-service",
    });
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const snapshot = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if ("entries" in snapshot) throw new Error("expected ledger snapshot");
    const page = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
    const polluted = { ...page, chainDigest: SHA256_ZERO };
    await expect(
      harness.journal.reconcileCancellationEvidence(
        ASSIGNMENT_ID,
        snapshot,
        (async function* () {
          yield polluted;
        })(),
      ),
    ).rejects.toThrow();
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");

    const pollutedEntries = page.entries.map((entry) => {
      if ("ref" in entry.body || entry.body.t !== "received") return entry;
      return {
        ...entry,
        body: {
          ...entry.body,
          envelope: {
            ref: { ...entry.body.envelope.ref, digest: SHA256_ZERO },
          },
        },
      } as AssignmentEntry;
    });
    let pollutedChain = assignmentLedgerSeed(ASSIGNMENT_ID);
    for (const entry of pollutedEntries) {
      pollutedChain = advanceAssignmentLedger(pollutedChain, entry);
    }
    const pollutedPayload = {
      v: page.v,
      assignmentId: page.assignmentId,
      executorId: page.executorId,
      fromSeq: page.fromSeq,
      toSeq: page.toSeq,
      entries: pollutedEntries,
      chainDigest: pollutedChain,
    };
    const signedPollutedPage: LedgerEvidencePage = {
      ...pollutedPayload,
      signature: harness.identity.sign("LedgerEvidencePage", 1, pollutedPayload),
    };
    await expect(
      harness.journal.reconcileCancellationEvidence(
        ASSIGNMENT_ID,
        snapshot,
        (async function* () {
          yield signedPollutedPage;
        })(),
      ),
    ).rejects.toThrow("does not bind the durable assignment");
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");

    const received = page.entries.find(
      (entry) => !("ref" in entry.body) && entry.body.t === "received",
    );
    if (!received || "ref" in received.body) {
      throw new Error("expected inline received evidence");
    }
    const illegalEntries: AssignmentEntry[] = [
      ...(page.entries as AssignmentEntry[]),
      { recordSeq: page.toSeq + 1, body: received.body },
    ];
    let illegalChain = assignmentLedgerSeed(ASSIGNMENT_ID);
    for (const entry of illegalEntries) {
      illegalChain = advanceAssignmentLedger(illegalChain, entry);
    }
    const illegalPayload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      fromSeq: 1,
      toSeq: illegalEntries.length,
      entries: illegalEntries,
      chainDigest: illegalChain,
    };
    const illegalPage: LedgerEvidencePage = {
      ...illegalPayload,
      signature: harness.identity.sign("LedgerEvidencePage", 1, illegalPayload),
    };
    const illegalSnapshot: LedgerSnapshot = {
      v: 1,
      assignmentId: ASSIGNMENT_ID,
      lastSeq: illegalEntries.length,
      phase: "received",
    };
    await expect(
      harness.journal.reconcileCancellationEvidence(
        ASSIGNMENT_ID,
        illegalSnapshot,
        (async function* () {
          yield illegalPage;
        })(),
      ),
    ).rejects.toThrow("received is not the first record");
    expect(await harness.journal.currentState(RUN_ID)).toBe("dispatched");
  });

  it("rejects pre-received control evidence that does not bind the assigned envelope", async () => {
    const harness = await createHarness();
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "polluted-control-evidence",
    });
    if (cancellation.state !== "cancel-requested") {
      throw new Error("expected cancellation fence");
    }
    const { signature: _, ...lease } = harness.dispatch.envelope.controlLease;
    const leasePayload = {
      ...lease,
      authority: {
        execution: "conversation" as const,
        conversationId: "conversation-other",
        ownerEpoch: 3,
      },
    };
    const entries: AssignmentEntry[] = [
      {
        recordSeq: 1,
        body: {
          v: 1,
          t: "control-lease-renewed",
          lease: {
            ...leasePayload,
            signature: harness.identity.sign("ControlLease", 1, leasePayload),
          },
        },
      },
      {
        recordSeq: 2,
        body: {
          v: 1,
          t: "abort-requested",
          via: "owner-fence",
          refId: cancellation.fence.requestId,
        },
      },
    ];
    let chainDigest = assignmentLedgerSeed(ASSIGNMENT_ID);
    for (const entry of entries) {
      chainDigest = advanceAssignmentLedger(chainDigest, entry);
    }
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      fromSeq: 1,
      toSeq: entries.at(-1)!.recordSeq,
      entries,
      chainDigest,
    };
    const pollutedPage: LedgerEvidencePage = {
      ...payload,
      signature: harness.identity.sign("LedgerEvidencePage", 1, payload),
    };
    const snapshot: LedgerSnapshot = {
      v: 1,
      assignmentId: ASSIGNMENT_ID,
      lastSeq: entries.length,
      phase: "unknown",
    };
    await expect(
      harness.journal.reconcileCancellationEvidence(
        ASSIGNMENT_ID,
        snapshot,
        (async function* () {
          yield pollutedPage;
        })(),
      ),
    ).rejects.toThrow("Control lease evidence does not bind the durable assignment");
  });

  it("treats an owner-fence not-started proof as contradictory after a durable started report", async () => {
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
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "owner-fence-contradiction",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    expect(await harness.journal.assignmentsAwaitingRecovery()).toEqual([]);
    const reopened = await reopenJournal(harness);
    expect(await reopened.pendingCancellations()).toEqual([]);
    expect(await reopened.assignmentsAwaitingRecovery()).toEqual([]);
  });

  it("accepts a halted abort proof while owner still considers the run dispatched", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });

    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("marks a dispatched owner state uncertain when abort cannot close an effect", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "tool-mutation",
      toolName: "write",
      summary: "write workspace file",
      target: "workspace-file",
    });
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    expect(await dispatcher.recoverCancellationProofs()).toBe(1);
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
  });

  it("marks a running owner state uncertain when abort cannot close an effect", async () => {
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
    await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "external-call",
      toolName: "calendar.create",
      summary: "create calendar event",
      target: "external-service",
    });
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    expect(await dispatcher.recoverCancellationProofs()).toBe(1);
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    const snapshot = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if ("entries" in snapshot) throw new Error("expected ledger snapshot");
    const page = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: snapshot.lastSeq, limit: 1 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
    const contradictory = signCancelProof(
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
        surfacePrincipal: "surface:user-1",
        decision: "not-started",
        lastRecordSeq: snapshot.lastSeq,
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        ledgerDigest: page.chainDigest,
        issuedAt: NOW,
      },
      harness.identity,
    );
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictory,
      submissionContext(harness.unsigned),
    );
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictory,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
  });

  it("atomically applies and replays a cancel control request", async () => {
    const harness = await createHarness();
    await expect(applyCancelControl(harness, "cancel-control-1")).resolves.toMatchObject({
      kind: "applied",
      result: {
        status: "ok",
        body: { t: "cancel", runState: "cancel-requested" },
      },
    });
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancel-requested");
    const atomic = (await harness.log.readAll()).find((commit) =>
      commit.entries.some(
        (entry) =>
          entry.stream === "control" &&
          (entry.body as { readonly t?: string; readonly requestId?: string }).t ===
            "applied" &&
          (entry.body as { readonly requestId?: string }).requestId ===
            "cancel-control-1",
      ),
    );
    expect(
      atomic?.entries.map((entry) => ({
        stream: entry.stream,
        t: (entry.body as { readonly t?: string }).t,
      })),
    ).toEqual(
      expect.arrayContaining([
        { stream: `run:${CONVERSATION_ID}`, t: "cancel-fence" },
        { stream: `run:${CONVERSATION_ID}`, t: "state" },
        { stream: "control", t: "applied" },
      ]),
    );
    const beforeReplay = (await harness.log.readAll()).length;
    await expect(applyCancelControl(harness, "cancel-control-1")).resolves.toMatchObject({
      kind: "replayed",
    });
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);
    const source = trustedControlSource();
    await expect(
      harness.control.apply({
        envelope: createInitialControlEnvelope({
          requestId: "session-between-cancel-controls",
          source,
          at: NOW,
          body: { t: "session-create", requestedName: "Another conversation" },
        }),
        source,
        prepare: () => ({
          result: {
            v: 1,
            status: "ok",
            body: { t: "session-create", conversationId: "conversation-2" },
          },
          authorityRevision: 1,
        }),
      }),
    ).resolves.toMatchObject({ kind: "applied" });
    await expect(applyCancelControl(harness, "cancel-control-2")).resolves.toMatchObject({
      kind: "applied",
      result: { status: "rejected", error: { code: "fence-rejected" } },
    });
  });

  it("freezes the cancel-batch candidate set and replays the original batch without re-enumeration", async () => {
    const harness = await createUnassignedHarness();
    const source = trustedControlSource();
    const applyBatch = (
      requestId: string,
      response?: { replyTarget: { channelId: string; to: string } },
    ) =>
      harness.journal.applyControl({
        admission: harness.control,
        envelope: createConversationControlEnvelope({
          requestId,
          source,
          at: NOW,
          body: {
            t: "cancel-batch",
            conversationId: CONVERSATION_ID,
            ownerEpoch: 3,
            ...(response ? { response } : {}),
          },
        }),
        source,
      });

    // 首次批量:queued run 被冻结进候选并直接终态 cancelled
    const first = await applyBatch("cancel-batch-populated");
    expect(first).toMatchObject({
      kind: "applied",
      result: {
        status: "ok",
        body: {
          t: "cancel-batch",
          runs: [
            {
              runId: RUN_ID,
              runState: "cancelled",
              source: "interactive",
              ingressId: "ingress-1",
            },
          ],
        },
      },
    });

    // 候选已空:第二个批量决定携带渠道回执绑定,产出唯一 control-response item
    const empty = await applyBatch("cancel-batch-empty", {
      replyTarget: { channelId: "feishu", to: "chat-1" },
    });
    expect(empty).toMatchObject({
      kind: "applied",
      result: {
        status: "ok",
        body: { t: "cancel-batch", conversationId: CONVERSATION_ID, runs: [] },
      },
    });
    const afterEmpty = await harness.log.readAll();
    const responseEnqueues = afterEmpty.flatMap((envelope) =>
      envelope.entries.filter((entry) => {
        const body = entry.body as { t?: string; keyBody?: { kind?: string } };
        return (
          entry.stream === "delivery" &&
          body.t === "enqueued" &&
          body.keyBody?.kind === "conversation-control-response-delivery"
        );
      }),
    );
    expect(responseEnqueues).toHaveLength(1);

    // 同 requestId 重投:exact replay 返回原批次,零重新枚举、零追加
    const emptyReplay = await applyBatch("cancel-batch-empty", {
      replyTarget: { channelId: "feishu", to: "chat-1" },
    });
    expect(emptyReplay).toMatchObject({
      kind: "replayed",
      result: {
        status: "ok",
        body: { t: "cancel-batch", conversationId: CONVERSATION_ID, runs: [] },
      },
    });
    const populatedReplay = await applyBatch("cancel-batch-populated");
    expect(populatedReplay).toMatchObject({
      kind: "replayed",
      result: {
        status: "ok",
        body: {
          t: "cancel-batch",
          runs: [{ runId: RUN_ID, runState: "cancelled" }],
        },
      },
    });
    expect(await harness.log.readAll()).toHaveLength(afterEmpty.length);
  });

  it.each([false, true])("atomically cancels a channel batch and replays its full notification set (running=%s)", async (running) => {
    const responder = { channelId: "feishu", platformSubject: "user-1", tenant: "tenant-1" };
    const channel: IngressContext = {
      kind: "channel", surfacePrincipal: channelSurfacePrincipal(responder), responder,
      replyTarget: { channelId: "feishu", to: "chat-1" }, deviceId: "device-1",
      ingressId: "channel-batch-first", receivedAt: NOW,
    };
    const harness = await createUnassignedHarness({ ingress: channel });
    if (running) {
      const dispatch = await harness.journal.assign(harness.unsigned);
      await harness.ledger.dispatch(dispatch.envelope, dispatch.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
      const adapter = new InProcessAssignmentSubmission({ ledger: harness.ledger, owner: harness.journal });
      await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
      expect(await harness.journal.runState(RUN_ID)).toBe("running");
    }
    for (const [runId, runIngress] of [
      ["channel-batch-queued", { ...channel, ingressId: "channel-batch-second" }],
      ["first-party-batch-queued", ingress()],
    ] as const) {
      await harness.journal.admit({
        ingressKey: `${runIngress.surfacePrincipal}/${runId}`, runId,
        userInput: { parts: [{ type: "text", text: "queued" }] }, ingress: runIngress,
        invocation: { kind: "agent", source: "interactive" }, queuedPosition: runId === "channel-batch-queued" ? 1 : 2,
      });
    }
    const source = trustedControlSource();
    const envelope = createConversationControlEnvelope({
      requestId: "cancel-channel-batch", source, at: NOW,
      body: { t: "cancel-batch", conversationId: CONVERSATION_ID, ownerEpoch: 3 },
    });
    const result = await harness.journal.applyControl({ admission: harness.control, envelope, source });
    expect(result).toMatchObject({ kind: "applied", result: { status: "ok", body: {
      t: "cancel-batch", runs: expect.arrayContaining([
        { runId: RUN_ID, runState: running ? "cancel-requested" : "cancelled", source: "interactive", ingressId: channel.ingressId },
        expect.objectContaining({ runId: "channel-batch-queued", runState: "cancelled" }),
        expect.objectContaining({ runId: "first-party-batch-queued", runState: "cancelled" }),
      ]),
    } } });
    const commits = await harness.log.readAll();
    const batch = commits.find((commit) => commit.entries.some((entry) =>
      entry.stream === `run:${CONVERSATION_ID}` &&
      (entry.body as { t?: string; runId?: string }).t === "state" &&
      (entry.body as { state?: string }).state === "cancelled" &&
      (entry.body as { runId?: string }).runId === "channel-batch-queued"));
    expect(batch).toBeDefined();
    const notifications = batch!.entries.filter((entry) => entry.stream === "delivery" &&
      (entry.body as { keyBody?: { kind?: string } }).keyBody?.kind === "conversation-status-delivery");
    expect(notifications).toHaveLength(running ? 1 : 2);
    expect(notifications.map((entry) => (entry.body as { keyBody: { runId: string } }).keyBody.runId).sort())
      .toEqual((running ? ["channel-batch-queued"] : [RUN_ID, "channel-batch-queued"]).sort());
    const recovered = reopenJournal(harness);
    expect(await recovered.runState(RUN_ID)).toBe(running ? "cancel-requested" : "cancelled");
    expect(await recovered.runState("channel-batch-queued")).toBe("cancelled");
    expect(await recovered.runState("first-party-batch-queued")).toBe("cancelled");
    const replay = await recovered.applyControl({ admission: new ControlAdmissionJournal(harness.log, harness.artifacts), envelope, source });
    expect(replay).toMatchObject({ kind: "replayed", result: result.result });
    expect(await harness.log.readAll()).toHaveLength(commits.length);
  });

  it("rejects runtime attempts to cross the initial and atomic control entrypoints", async () => {
    const harness = await createHarness();
    const source = trustedControlSource();
    const cancel = createConversationControlEnvelope({
      requestId: "cancel-wrong-entrypoint",
      source,
      at: NOW,
      body: {
        t: "cancel",
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        ownerEpoch: 3,
      },
    });
    await expect(
      harness.control.apply({
        envelope: cancel as never,
        source,
        prepare: () => ({
          result: {
            v: 1,
            status: "ok",
            body: { t: "session-create", conversationId: "conversation-2" },
          },
        }),
      }),
    ).rejects.toThrow("rejects conversation control requests");

    const initial = createInitialControlEnvelope({
      requestId: "initial-wrong-entrypoint",
      source,
      at: NOW,
      body: { t: "session-create", requestedName: "Wrong entrypoint" },
    });
    await expect(
      harness.control.applyAuthority({
        envelope: initial as never,
        source,
        stream: `run:${CONVERSATION_ID}`,
        initial: {},
        reducer: (state) => state,
        decide: () => ({
          result: {
            v: 1,
            status: "ok",
            body: { t: "cancel", runState: "cancel-requested" },
          },
        }),
      }),
    ).rejects.toThrow("rejects session-create control requests");
  });

  it.each(["dispatched", "running"] as const)(
    "persists cancel-requested as a distinct state from %s",
    async (origin) => {
      const harness = await createHarness();
      if (origin === "running") {
        await harness.journal.reportStarted(
          ASSIGNMENT_ID,
          submissionContext(harness.unsigned),
        );
      }

      await expect(
        harness.journal.cancelRun({
          runId: RUN_ID,
          requestId: `cancel-state-${origin}`,
        }),
      ).resolves.toMatchObject({ state: "cancel-requested" });
      expect(await harness.journal.currentState(RUN_ID)).toBe("cancel-requested");
    },
  );

  it("moves a running assignment with unknown ledger outcome to uncertain", async () => {
    const harness = await createHarness();
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );

    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect((await harness.journal.currentResolution(RUN_ID))?.cause).toBe(
      "ledger-unknown",
    );
  });

  it("automatically requeues an uncertain run only after a not-started proof", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });

    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("queued");
    const runRecords = await harness.log.readStream(`run:${CONVERSATION_ID}`);
    expect(
      runRecords.some(
        (record) =>
          (record.body as { readonly t?: string }).t === "cancel-contained",
      ),
    ).toBe(false);
  });

  it("rejects non-halted cancel containment during replay", async () => {
    const harness = await createHarness();
    const fact = await harness.journal.markAssignmentUncertain(
      ASSIGNMENT_ID,
      "ledger-unknown",
    );
    const proof = signCancelProof(
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
        surfacePrincipal: "surface:user-1",
        decision: "not-started",
        lastRecordSeq: 1,
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        ledgerDigest: SHA256_ZERO,
        issuedAt: NOW,
      },
      harness.identity,
    );
    await replayFixtureLog(harness).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "cancel-contained",
          assignmentId: ASSIGNMENT_ID,
          openFactDigest: fact.openFactDigest,
          proof,
        },
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "Cancellation containment is invalid",
    );
  });

  it("opens a mismatched dispatch conflict without treating it as termination", async () => {
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
      harness.journal.recordDispatchConflict(harness.dispatch, conflict),
    ).resolves.toBe("opened-uncertain");
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);
  });
});
