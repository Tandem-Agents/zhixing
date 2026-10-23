// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：interaction。
import path from "node:path";
import { rm } from "node:fs/promises";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { AssignmentEntry, DispatchEnvelope, LedgerEvidencePage, PermissionSnapshotLease } from "@zhixing/core/contracts";
import { MAX_LEDGER_EVIDENCE_PAGE_BYTES, MAX_LEDGER_EVIDENCE_PAGE_ENTRIES } from "@zhixing/core/contracts";
import { advanceAssignmentLedger, assignmentLedgerSeed, canonicalize, channelResponderPrincipal, confirmationDecisionDigest, createSignedChannelChallengeToken, createSignedChannelInteractionGrant, interactionDisplayDigest, createSignedTrustRuleSnapshot, dispatchEnvelopeArtifact, dispatchEnvelopeDigest, protocolDigest, type UnsignedConversationEnvelope } from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission, type AssignmentLedgerOptions } from "../assignment-ledger.js";
import { NOW, EXECUTOR_ID, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID, SHA256_ZERO, DURABLE_IO_TEST_TIMEOUT_MS, matchingSnapshotFor, matchingPermissionSnapshotFor, allowOnceDecisionDigest, ConversationEnvelope, TestProtocolIdentity, signedMirrorBatch, mirrorReceipt, ownerControl, createUnassignedHarness, createHarness, createUnsignedEnvelope, ingress, ownerContext, submissionContext, sealDefaultBundle, withoutSignature } from "./assignment-ledger-fixture.js";

describe("conversation assignment protocol", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("durably rejects a manifest mismatch before received", async () => {
    const harness = await createUnassignedHarness({
      snapshotFor(executorId) {
        const value = matchingSnapshotFor(executorId);
        if (!value) return undefined;
        value.inventory.configVersions.policyRev = 2;
        return value;
      },
    });
    const dispatch = await harness.journal.assign(harness.unsigned);

    const result = await harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );

    expect(result).toMatchObject({
      accepted: false,
      error: { code: "revision-conflict", retryable: true },
    });
    expect(
      await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).toMatchObject({ phase: "dispatch-rejected" });
  });

  it("rejects a dispatch from the wrong owner authority before any durable control fact", async () => {
    const harness = await createUnassignedHarness();
    const dispatch = await harness.journal.assign(harness.unsigned);

    await expect(harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch", "conversation-other"),
    )).rejects.toThrow("owner control authorization failed");
    await expect(
      harness.log.readStream(`assignment:${ASSIGNMENT_ID}`),
    ).resolves.toHaveLength(0);
    await expect(harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    )).resolves.toMatchObject({ accepted: true });
  });

  it("binds remote owner-control preflight to the authenticated mesh peer", async () => {
    const harness = await createHarness();
    const request = {
      method: "executor.queryLedger" as const,
      assignmentId: ASSIGNMENT_ID,
      requestId: "mesh-query-1",
      body: { range: null },
    };
    const context = ownerContext(ASSIGNMENT_ID, request.method, {
      requestId: request.requestId,
      body: request.body,
    });

    await expect(
      harness.ledger.preflightOwnerControl(context, request, "untrusted-owner"),
    ).rejects.toThrow("authorization failed");
    await expect(
      harness.ledger.preflightOwnerControl(context, request, "test-owner"),
    ).resolves.toBeUndefined();
  });

  it("does not derive durable owner control from an unverified activation authority", async () => {
    const harness = await createUnassignedHarness();
    const dispatch = await harness.journal.assign(harness.unsigned);
    const unverifiedActivation = {
      ...dispatch.activation,
      ref: {
        ...dispatch.activation.ref,
        conversationId: "conversation-other",
      },
    } as typeof dispatch.activation;

    await expect(harness.ledger.dispatch(
      dispatch.envelope,
      unverifiedActivation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch", "conversation-other"),
    )).rejects.toThrow("owner control authorization failed");
    await expect(
      harness.log.readStream(`assignment:${ASSIGNMENT_ID}`),
    ).resolves.toHaveLength(0);
    await expect(harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    )).resolves.toMatchObject({ accepted: true });
  });

  it("durably rejects a dispatch whose permission snapshot asset is unavailable", async () => {
    const harness = await createUnassignedHarness({
      permissionSnapshotFor: () => undefined,
    });
    const dispatch = await harness.journal.assign(harness.unsigned);

    const result = await harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );

    expect(result).toMatchObject({
      accepted: false,
      error: { code: "capability-gap", retryable: true },
    });
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "dispatch-rejected" });
  });

  it("durably rejects a permission lease outside its accepted clock window", async () => {
    const harness = await createUnassignedHarness();
    const { signature: _, ...permissionPayload } = harness.unsigned.permissionLease;
    const expiredPayload = {
      ...permissionPayload,
      issuedAt: "2026-07-19T21:00:00.000Z",
      expiry: "2026-07-19T22:00:00.000Z",
    };
    const unsigned = {
      ...harness.unsigned,
      permissionLease: {
        ...expiredPayload,
        signature: harness.identity.sign(
          "PermissionSnapshotLease",
          1,
          expiredPayload,
        ),
      },
    };
    const dispatch = await harness.journal.assign(unsigned);

    await expect(harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    )).resolves.toMatchObject({
      accepted: false,
      error: { code: "invalid", retryable: false },
    });
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "dispatch-rejected" });
  });

  it.each(["mismatched", "invalid-signature"] as const)(
    "hard-rejects a %s permission snapshot before received",
    async (kind) => {
      const identity = new TestProtocolIdentity();
      const harness = await createUnassignedHarness({
        permissionSnapshotFor: (digest) => {
          if (kind === "mismatched") {
            return createSignedTrustRuleSnapshot(
              { snapshotVersion: 2, rules: [], generatedAt: NOW },
              identity,
            );
          }
          const snapshot = matchingPermissionSnapshotFor(identity, digest);
          if (snapshot === undefined) return undefined;
          return {
            ...snapshot,
            signature: { ...snapshot.signature, sig: "invalid" },
          };
        },
      });
      const dispatch = await harness.journal.assign(harness.unsigned);

      await expect(
        harness.ledger.dispatch(
          dispatch.envelope,
          dispatch.activation,
          ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
        ),
      ).resolves.toMatchObject({
        accepted: false,
        error: { code: "invalid", retryable: false },
      });
      await expect(
        harness.ledger.queryLedger(
          ASSIGNMENT_ID,
          ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        ),
      ).resolves.toMatchObject({ phase: "dispatch-rejected" });
    },
  );

  it("authorizes tools only from active received permission facts and survives replay", async () => {
    const harness = await createHarness();
    const lease = harness.dispatch.envelope.permissionLease;

    await expect(
      harness.ledger.authorizeToolExecution(ASSIGNMENT_ID, lease),
    ).rejects.toThrow("inactive");
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await expect(
      harness.ledger.authorizeToolExecution(ASSIGNMENT_ID, lease),
    ).rejects.toThrow("inactive");
    await harness.ledger.start(ASSIGNMENT_ID);
    await expect(
      harness.ledger.authorizeToolExecution(ASSIGNMENT_ID, lease),
    ).resolves.toEqual([]);

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
      restarted.authorizeToolExecution(ASSIGNMENT_ID, lease),
    ).resolves.toEqual([]);

    const { signature: _, ...replacementPayload } = {
      ...lease,
      controlLeaseId: "replacement-control-lease",
    };
    const replacement = {
      ...replacementPayload,
      signature: harness.identity.sign(
        "PermissionSnapshotLease",
        1,
        replacementPayload,
      ),
    };
    await expect(
      restarted.authorizeToolExecution(ASSIGNMENT_ID, replacement),
    ).rejects.toThrow("inactive");

    await restarted.cancel(
      ASSIGNMENT_ID,
      { fenceSeq: 1, requestId: "cancel-permission-authority" },
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await expect(
      restarted.authorizeToolExecution(ASSIGNMENT_ID, lease),
    ).rejects.toThrow("inactive");
  });

  it("uses only local monotonic time after accepting a control lease", async () => {
    let wallTime = NOW;
    let monotonicTime = 0;
    const harness = await createHarness({
      clock: () => wallTime,
      monotonicClock: () => monotonicTime,
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await expect(harness.ledger.authorizeToolExecution(
      ASSIGNMENT_ID,
      harness.dispatch.envelope.permissionLease,
    )).resolves.toEqual([]);

    wallTime = "2026-07-13T08:00:00.000Z";
    monotonicTime = 30_000;
    await expect(harness.ledger.authorizeToolExecution(
      ASSIGNMENT_ID,
      harness.dispatch.envelope.permissionLease,
    )).resolves.toEqual([]);

    monotonicTime = 60_001;
    await expect(harness.ledger.authorizeToolExecution(
      ASSIGNMENT_ID,
      harness.dispatch.envelope.permissionLease,
    )).rejects.toThrow("inactive");
  });

  it("renews owner control after sealing so delayed recovery can read the ledger", async () => {
    let wallTime = NOW;
    let monotonicTime = 0;
    const harness = await createHarness({
      clock: () => wallTime,
      monotonicClock: () => monotonicTime,
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await sealDefaultBundle(harness.ledger);

    wallTime = "2026-07-13T09:02:00.000Z";
    monotonicTime = 120_000;
    await expect(harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(
        ASSIGNMENT_ID,
        "executor.queryLedger",
        CONVERSATION_ID,
        {
          renewalSeq: 3,
          issuedAt: wallTime,
          expiry: "2026-07-13T09:03:00.000Z",
        },
      ),
    )).resolves.toMatchObject({ phase: "sealed" });

    const renewals = (await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`))
      .filter((record) => record.body.body.t === "control-lease-renewed");
    expect(renewals.map((record) => record.body.body.lease.renewalSeq)).toEqual([1, 3]);
  });

  it("accepts only monotonic control-lease renewals and rejects an older replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const renewed = ownerContext(
      ASSIGNMENT_ID,
      "executor.queryLedger",
      CONVERSATION_ID,
      {
        renewalSeq: 2,
        issuedAt: "2026-07-13T09:00:30.000Z",
        expiry: "2026-07-13T09:01:30.000Z",
      },
    );
    await expect(
      harness.ledger.queryLedger(ASSIGNMENT_ID, renewed),
    ).resolves.toMatchObject({ phase: "received" });
    await expect(harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    )).rejects.toThrow("renewal sequence regressed");
    const renewals = (await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`))
      .filter((record) => record.body.body.t === "control-lease-renewed");
    expect(renewals.map((record) => record.body.body.lease.renewalSeq)).toEqual([1, 2]);
  });

  it("durably rejects a runtime binding mismatch before received", async () => {
    let calls = 0;
    const harness = await createUnassignedHarness({
      runtimeBindingGuard() {
        calls += 1;
        return {
          code: "revision-conflict",
          message: "assembled runtime changed",
          retryable: true,
        };
      },
    });
    const dispatch = await harness.journal.assign(harness.unsigned);

    await expect(
      harness.ledger.dispatch(
        dispatch.envelope,
        dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ).resolves.toMatchObject({
      accepted: false,
      error: { code: "revision-conflict", retryable: true },
    });
    expect(calls).toBe(1);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "dispatch-rejected" });
  });

  it("bypasses the live runtime guard for exact durable received replay", async () => {
    let currentError: ReturnType<NonNullable<AssignmentLedgerOptions["runtimeBindingGuard"]>>;
    let calls = 0;
    const harness = await createUnassignedHarness({
      runtimeBindingGuard() {
        calls += 1;
        return currentError;
      },
    });
    const dispatch = await harness.journal.assign(harness.unsigned);
    const context = ownerContext(ASSIGNMENT_ID, "executor.dispatch");

    await expect(
      harness.ledger.dispatch(dispatch.envelope, dispatch.activation, context),
    ).resolves.toEqual({ v: 1, accepted: true });
    currentError = {
      code: "revision-conflict",
      message: "live runtime changed after durable receipt",
      retryable: true,
    };
    await expect(
      harness.ledger.dispatch(dispatch.envelope, dispatch.activation, context),
    ).resolves.toEqual({ v: 1, accepted: true });
    expect(calls).toBe(1);
  });

  it("replays an accepted dispatch after the local snapshot advances", async () => {
    let policyRevision = 1;
    const harness = await createUnassignedHarness({
      snapshotFor(executorId) {
        const value = matchingSnapshotFor(executorId);
        if (!value) return undefined;
        value.inventory.configVersions.policyRev = policyRevision;
        return value;
      },
    });
    const dispatch = await harness.journal.assign(harness.unsigned);
    const context = ownerContext(ASSIGNMENT_ID, "executor.dispatch");

    await expect(
      harness.ledger.dispatch(dispatch.envelope, dispatch.activation, context),
    ).resolves.toEqual({ v: 1, accepted: true });
    policyRevision = 2;
    await expect(
      harness.ledger.dispatch(dispatch.envelope, dispatch.activation, context),
    ).resolves.toEqual({ v: 1, accepted: true });
  });

  it("invalidates a failed ledger cursor and rebuilds from authority truth", async () => {
    const harness = await createHarness();
    expect(
      await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).toMatchObject({ phase: "unknown" });
    const peer = new ConversationAssignmentLedger({
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
    await peer.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const artifact = dispatchEnvelopeArtifact(harness.dispatch.envelope);
    await rm(harness.artifacts.pathFor(artifact.ref));
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow();
    expect(await harness.artifacts.put(artifact.bytes)).toEqual(artifact.ref);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "received", lastSeq: 2 });
  });

  it("durably rejects the first invalid dispatch and replays its original proof", async () => {
    const harness = await createHarness();
    const unsignedBad = {
      ...withoutSignature(harness.dispatch.envelope),
      manifest: { ...harness.dispatch.envelope.manifest, digest: SHA256_ZERO },
    };
    const badEnvelope: ConversationEnvelope = {
      ...unsignedBad,
      signature: harness.identity.sign("DispatchEnvelope", 1, unsignedBad),
    };
    const rejected = await harness.ledger.dispatch(
      badEnvelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    expect(rejected).toMatchObject({
      accepted: false,
      outcome: "rejected-before-received",
      proof: {
        dispatchDigest: dispatchEnvelopeDigest(badEnvelope),
        lastRecordSeq: 2,
      },
    });
    if (rejected.accepted || rejected.outcome !== "rejected-before-received") {
      throw new Error("expected a signed dispatch rejection");
    }
    const { signature: rejectionSignature, ...rejectionPayload } = rejected.proof;
    expect(() =>
      harness.identity.verify(
        "DispatchRejectionProof",
        1,
        rejectionPayload,
        rejectionSignature,
      ),
    ).not.toThrow();
    const rejectionPage = (await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 2 },
    )) as LedgerEvidencePage;
    expect(rejected.proof.ledgerDigest).toBe(rejectionPage.chainDigest);
    expect(rejected.proof.ledgerDigest).toBe(
      rejectionPage.entries.reduce(
        (digest, entry) => advanceAssignmentLedger(digest, entry),
        assignmentLedgerSeed(ASSIGNMENT_ID),
      ),
    );
    const replayed = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    expect(replayed).toMatchObject({
      ...rejected,
      proof: withoutSignature(rejected.proof),
    });
    if (replayed.accepted || rejected.accepted) throw new Error("expected rejection");
    expect(withoutSignature(replayed.proof)).toEqual(
      withoutSignature(rejected.proof),
    );
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(2);
  });

  it("recovers interaction truth, mirrors terminal outcomes, and preserves the ledger chain", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "interaction-1",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
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
    expect(await restarted.recoverInteractions(ASSIGNMENT_ID, NOW)).toMatchObject({
      pending: [{ requestId: "interaction-1" }],
      resolved: [],
    });
    const finished = await adapter.finishAndMirror(
      ASSIGNMENT_ID,
      "interaction-1",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "ticket-1" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("interaction-1"),
        by: "surface:user-1",
      },
      submissionContext(harness.unsigned),
    );
    expect(finished.outcome).toMatchObject({ t: "answered" });
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
    const exactBatch = signedMirrorBatch(harness.identity, [finished]);
    expect(
      await harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        exactBatch,
        submissionContext(harness.unsigned),
      ),
    ).toEqual(mirrorReceipt(exactBatch));
    // mirror 已耐久即回放可查:surface 丢响应/重启后按此单源回放原结果
    await expect(
      harness.journal.interactionOutcome("interaction-1"),
    ).resolves.toEqual({
      t: "answered",
      decisionDigest: allowOnceDecisionDigest("interaction-1"),
    });
    await expect(
      harness.journal.interactionOutcome("interaction-never-finished"),
    ).resolves.toBeUndefined();
    const conflictingBatch = signedMirrorBatch(harness.identity, [
      { ...finished, outcome: { t: "expired" } },
    ]);
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        conflictingBatch,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("does not continue the durable audit prefix");

    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "interaction-expired",
      toolName: "external-call",
      display: { title: "Call service", lines: [] },
      issuedAt: NOW,
      ttlMs: 1_000,
      expiresAt: "2026-07-13T09:00:01.000Z",
    });
    const recovered = await restarted.recoverInteractions(
      ASSIGNMENT_ID,
      "2026-07-13T09:00:02.000Z",
    );
    expect(recovered.resolved).toContainEqual(
      expect.objectContaining({
        requestId: "interaction-expired",
        outcome: { t: "expired" },
      }),
    );
    expect(
      await adapter.flushInteractionMirrors(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).toBe(1);

    const runEndRequest = {
      requestId: "interaction-run-end",
      toolName: "delete-file",
      display: { title: "Delete file", lines: [] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    } as const;
    const runEndRecord = await harness.ledger.requestInteraction(
      ASSIGNMENT_ID,
      runEndRequest,
    );
    const sealInput = {
      runRecord: {
        type: "run" as const,
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    };
    await expect(
      adapter.prepareForRunEnd(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toEqual({ closed: 1, mirrored: 1 });
    await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, sealInput);
    expect(
      await harness.ledger.requestInteraction(ASSIGNMENT_ID, runEndRequest),
    ).toEqual(runEndRecord);
    await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, sealInput);
    await expect(
      harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
        ...sealInput,
        usage: { ...sealInput.usage, outputTokens: 2 },
      }),
    ).rejects.toThrow("different bundle payload");
    await harness.ledger.acknowledge(ASSIGNMENT_ID, 42);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({
      phase: "acked",
      acknowledgedCommitRevision: 42,
    });
    expect(
      await adapter.flushInteractionMirrors(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).toBe(0);

    const page = (await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    )) as LedgerEvidencePage;
    let chain = assignmentLedgerSeed(ASSIGNMENT_ID);
    for (const value of page.entries) {
      chain = advanceAssignmentLedger(chain, value as AssignmentEntry);
    }
    expect(chain).toBe(page.chainDigest);
    const { signature, ...payload } = page;
    expect(() =>
      harness.identity.verify("LedgerEvidencePage", 1, payload, signature),
    ).not.toThrow();
    expect(page.entries.map((entry) => entry.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: "interaction-finished",
          requestId: "interaction-run-end",
          outcome: { t: "cancelled", via: "run-end" },
        }),
        expect.objectContaining({ t: "bundle_sealed" }),
        expect.objectContaining({ t: "acked", commitRevision: 42 }),
      ]),
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("returns the largest bounded ledger evidence prefix and resumes without gaps", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    for (let index = 0; index < 20; index += 1) {
      await harness.ledger.stageMutation(ASSIGNMENT_ID, {
        domain: "session",
        requestId: `large-page-mutation-${index}`,
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [{
                id: `large-page-task-${index}`,
                content: "x".repeat(28 * 1024),
                status: "pending",
              }],
            },
          },
        },
      });
    }
    const snapshot = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if ("entries" in snapshot) throw new Error("expected ledger snapshot");

    const recordSeqs: number[] = [];
    let fromSeq = 1;
    let pageCount = 0;
    while (fromSeq <= snapshot.lastSeq) {
      const page = await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        { fromSeq, limit: MAX_LEDGER_EVIDENCE_PAGE_ENTRIES },
      );
      if (!("entries" in page)) throw new Error("expected ledger evidence page");
      const { signature: _, ...payload } = page;
      expect(Buffer.byteLength(canonicalize(payload), "utf8")).toBeLessThanOrEqual(
        MAX_LEDGER_EVIDENCE_PAGE_BYTES,
      );
      recordSeqs.push(...page.entries.map((entry) => entry.recordSeq));
      fromSeq = page.toSeq + 1;
      pageCount += 1;
    }
    expect(recordSeqs).toEqual(
      Array.from({ length: snapshot.lastSeq }, (_, index) => index + 1),
    );
    expect(pageCount).toBeGreaterThan(1);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects absent dispatch dependencies and assignment-id reuse across runs", async () => {
    const missingHarness = await createUnassignedHarness();
    const missing = {
      digest: `sha256:${"f".repeat(64)}`,
      bytes: 23,
    } as const;
    const windowRef = await missingHarness.artifacts.put(Buffer.from(canonicalize([{
      role: "user",
      content: [{
        type: "tool_use",
        id: "missing-input",
        name: "read",
        input: { attachment: missing },
      }],
    }]), "utf8"));
    await expect(
      missingHarness.journal.assign({
        ...missingHarness.unsigned,
        dependencyArtifacts: [missing],
        work: {
          ...missingHarness.unsigned.work,
          windowInput: {
            t: "full",
            windowEpoch: 1,
            messages: { ref: windowRef },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "artifact-missing" });

    const harness = await createHarness();
    const secondRunId = "run-2";
    await harness.journal.admit({
      ingressKey: "surface:user-1/ingress-2",
      runId: secondRunId,
      userInput: { parts: [{ type: "text", text: "second" }] },
      ingress: ingress(),
      invocation: { kind: "agent", source: "interactive" },
      queuedPosition: 1,
    });
    await expect(
      harness.journal.assign(
        createUnsignedEnvelope(harness.identity, {
          runId: secondRunId,
          assignmentId: ASSIGNMENT_ID,
        }),
      ),
    ).rejects.toThrow("Assignment id already belongs to a different run");
    const beforeSecondAssignment = (
      await harness.log.readStream(`run:${CONVERSATION_ID}`)
    ).length;
    await expect(
      harness.journal.assign(
        createUnsignedEnvelope(harness.identity, {
          runId: secondRunId,
          assignmentId: "assignment-2",
        }),
      ),
    ).rejects.toThrow("Conversation already has an active assignment");
    expect(await harness.log.readStream(`run:${CONVERSATION_ID}`)).toHaveLength(
      beforeSecondAssignment,
    );
  });

  it("retains the complete dispatch artifact closure from both durable roots", async () => {
    const harness = await createUnassignedHarness();
    const dependencyBytes = Buffer.from("durable-transitive-dependency", "utf8");
    const dependencyRef = await harness.artifacts.put(dependencyBytes);
    const windowBytes = Buffer.from(canonicalize([{
      role: "user",
      content: [{
        type: "tool_use",
        id: "durable-input",
        name: "read",
        input: { attachment: dependencyRef },
      }],
    }]), "utf8");
    const windowRef = await harness.artifacts.put(windowBytes);
    const unsigned: UnsignedConversationEnvelope = {
      ...harness.unsigned,
      dependencyArtifacts: [dependencyRef],
      work: {
        ...harness.unsigned.work,
        windowInput: {
          t: "full",
          windowEpoch: 1,
          messages: { ref: windowRef },
        },
      },
    };
    const dispatch = await harness.journal.assign(unsigned);

    await expect(
      harness.log.collectGarbage({
        unreferencedBefore: "2099-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ scanned: 3, retained: 3, deleted: 0 });
    await expect(harness.artifacts.has(windowRef)).resolves.toBe(true);
    await expect(harness.artifacts.has(dependencyRef)).resolves.toBe(true);

    const executorArtifacts = new FileArtifactStore(
      path.join(harness.root, "executor-artifacts"),
      { lockWaitMs: 2_000 },
    );
    const executorLog = new FileAuthorityCommitLog(
      path.join(harness.root, "executor-authority"),
      executorArtifacts,
      { clock: () => NOW, lockWaitMs: 2_000 },
    );
    expect(await executorArtifacts.put(windowBytes)).toEqual(windowRef);
    expect(await executorArtifacts.put(dependencyBytes)).toEqual(dependencyRef);
    const executorLedger = new ConversationAssignmentLedger({
      log: executorLog,
      artifacts: executorArtifacts,
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
      executorLedger.dispatch(
        dispatch.envelope,
        dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ).resolves.toEqual({ v: 1, accepted: true });
    await expect(
      executorLog.collectGarbage({
        unreferencedBefore: "2099-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ scanned: 3, retained: 3, deleted: 0 });
    await expect(executorArtifacts.has(windowRef)).resolves.toBe(true);
    await expect(executorArtifacts.has(dependencyRef)).resolves.toBe(true);

    const orphan = await harness.artifacts.put(Buffer.from("eligible-orphan", "utf8"));
    await rm(harness.artifacts.pathFor(dependencyRef));
    // 保留关系改由耐久派生索引在 append 期建立,GC 不再为了求闭包去读工件,
    // 因此物理缺失的引用不会再把整轮 GC 打断。要守住的性质不是"缺件即中止",
    // 而是"缺件不得导致任何仍被保留的工件被删":缺的那个不在扫描集里,
    // 真正被删的只有确实无人引用的孤儿。
    await expect(
      harness.log.collectGarbage({
        unreferencedBefore: "2099-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ scanned: 3, retained: 2, deleted: 1 });
    await expect(harness.artifacts.has(orphan)).resolves.toBe(false);
    await expect(harness.artifacts.has(windowRef)).resolves.toBe(true);
  });

  it("never commits a dispatch whose nested artifacts lose a GC race", async () => {
    const harness = await createUnassignedHarness();
    const dependencyRef = await harness.artifacts.put(
      Buffer.from("racing-dependency", "utf8"),
    );
    const windowRef = await harness.artifacts.put(Buffer.from(canonicalize([{
      role: "user",
      content: [{
        type: "tool_use",
        id: "racing-input",
        name: "read",
        input: { attachment: dependencyRef },
      }],
    }]), "utf8"));
    const unsigned: UnsignedConversationEnvelope = {
      ...harness.unsigned,
      dependencyArtifacts: [dependencyRef],
      work: {
        ...harness.unsigned.work,
        windowInput: {
          t: "full",
          windowEpoch: 1,
          messages: { ref: windowRef },
        },
      },
    };

    const [assignment, garbageCollection] = await Promise.allSettled([
      harness.journal.assign(unsigned),
      harness.log.collectGarbage({
        unreferencedBefore: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const assigned = (
      await harness.log.readStream<{ readonly t: string }>(`run:${CONVERSATION_ID}`)
    ).filter(({ body }) => body.t === "assigned");
    expect(garbageCollection.status).toBe("fulfilled");
    if (assigned.length === 1) {
      await expect(harness.artifacts.has(windowRef)).resolves.toBe(true);
      await expect(harness.artifacts.has(dependencyRef)).resolves.toBe(true);
      await expect(harness.journal.pendingDispatches()).resolves.toHaveLength(1);
    } else {
      expect(assigned).toHaveLength(0);
      expect(assignment.status).toBe("rejected");
      if (assignment.status !== "rejected") {
        throw new Error("GC won without rejecting the competing assignment");
      }
      expect(assignment.reason).toBeInstanceOf(Error);
      expect((assignment.reason as Error).message).toContain("not present");
    }
  });

  it("assigns only the earliest queued run and rejects duplicate active positions", async () => {
    const harness = await createUnassignedHarness();
    await harness.journal.admit({
      ingressKey: "surface:user-1/ingress-2",
      runId: "run-2",
      userInput: { parts: [{ type: "text", text: "second" }] },
      ingress: ingress(),
      invocation: { kind: "agent", source: "interactive" },
      queuedPosition: 1,
    });
    await expect(
      harness.journal.assign(
        createUnsignedEnvelope(harness.identity, {
          runId: "run-2",
          assignmentId: "assignment-2",
        }),
      ),
    ).rejects.toThrow("Only the earliest queued run can be assigned");
    await expect(
      harness.journal.admit({
        ingressKey: "surface:user-1/ingress-3",
        runId: "run-3",
        userInput: { parts: [{ type: "text", text: "third" }] },
        ingress: ingress(),
        invocation: { kind: "agent", source: "interactive" },
        queuedPosition: 1,
      }),
    ).rejects.toThrow("Queued position already belongs to an active run");
    await expect(harness.journal.assign(harness.unsigned)).resolves.toMatchObject({
      assignmentId: ASSIGNMENT_ID,
    });
  });

  it("externalizes an oversized interaction display and replays its artifact", async () => {
    const harness = await createHarness({ maxPendingInteractions: 16 });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const disposition = await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
        requestId: "oversized",
        toolName: "write-file",
        display: {
          title: "Write",
          lines: Array.from({ length: 20 }, () => "x".repeat(1_800)),
        },
        issuedAt: NOW,
        ttlMs: 60_000,
        expiresAt: "2026-07-13T09:01:00.000Z",
      });
    expect(disposition).toMatchObject({ accepted: true });
    const requested = (await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`))
      .find((entry) => entry.body.body.t === "interaction-requested");
    expect(requested?.body.body).toMatchObject({
      t: "interaction-requested",
      display: { ref: { bytes: expect.any(Number), digest: expect.stringMatching(/^sha256:/u) } },
    });
    expect(disposition.display).toEqual(requested?.body.body.display);
    const recovered = await harness.ledger.recoverInteractions(ASSIGNMENT_ID, NOW);
    expect(recovered.pending[0]?.display).toEqual(requested?.body.body.display);
    const display = recovered.pending[0]?.display;
    if (!display || !("ref" in display)) throw new Error("expected externalized display");
    const materialized = JSON.parse(
      Buffer.from(await harness.artifacts.get(display.ref)).toString("utf8"),
    ) as { readonly lines: readonly string[] };
    expect(materialized.lines).toHaveLength(20);

    await rm(harness.artifacts.pathFor(display.ref), { force: true });
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
      restarted.recoverInteractions(ASSIGNMENT_ID, NOW),
    ).rejects.toThrow(/artifact/i);
  });

  it("rejects a fully valid channel grant at the durable write entry of a conversation", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const requestId = "cross-domain-request";
    const display = { title: "Approve?", lines: ["run"] };
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId,
      toolName: "bash",
      display,
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const jobRef = {
      execution: "job" as const,
      taskId: "task-cross-domain",
      jobRunId: "job-run-cross-domain",
      anchorEpoch: 3,
    };
    const route = { channelId: "feishu", to: "chat-1" };
    const responder = { channelId: "feishu", platformSubject: "user-1" };
    const decision = { allowed: true };
    const challengeToken = createSignedChannelChallengeToken(
      {
        v: 1,
        challengeId: "challenge-cross-domain",
        ref: jobRef,
        assignmentId: ASSIGNMENT_ID,
        interactionRequestId: requestId,
        route,
        displayDigest: interactionDisplayDigest("bash", display),
        issuedAt: NOW,
        expiry: "2026-07-13T09:01:00.000Z",
      },
      harness.identity,
    );
    const grant = createSignedChannelInteractionGrant(
      {
        v: 1,
        grantId: protocolDigest("ChannelInteractionGrantIdentity", 1, {
          challengeId: challengeToken.challengeId,
        }),
        ref: jobRef,
        assignmentId: ASSIGNMENT_ID,
        interactionRequestId: requestId,
        challengeToken,
        route,
        responder,
        decision,
        issuedAt: NOW,
        expiry: challengeToken.expiry,
      },
      harness.identity,
      harness.identity,
    );
    const beforeCrossDomain = (
      await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)
    ).length;
    // 结构、签名与全绑定都合法,唯一不合法的是该 assignment 的 execution 域;
    // 最终耐久写入口必须自己拒绝,不能依赖上游 prepare 是否被正确调用过。
    await expect(
      harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
        t: "answered",
        authority: { via: "channel-grant", grant },
        decision,
        decisionDigest: confirmationDecisionDigest(requestId, {
          kind: "allow-once",
        }),
        by: channelResponderPrincipal(responder),
      }),
    ).rejects.toThrow(
      "Channel interaction grant has no durable pending job request",
    );
    expect(
      await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`),
    ).toHaveLength(beforeCrossDomain);
  });
});
