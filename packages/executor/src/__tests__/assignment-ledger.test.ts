import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
} from "@zhixing/core/authority";
import type {
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AuthorityCallContext,
  AuthorityCapability,
  DispatchEnvelope,
  LedgerEvidencePage,
  PermissionSnapshotLease,
  Signature,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  advanceAssignmentLedger,
  assignmentActivationDigest,
  assignmentLedgerSeed,
  canonicalize,
  dispatchEnvelopeDigest,
  protocolBytes,
  protocolDigest,
  createConversationSealedBundle,
  sealedBundleArtifact,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";
import {
  ConversationRunJournal,
  InProcessConversationDispatcher,
  type AssignmentSubmissionAuthorizer,
  type ConversationCommitAuthority,
  type ConversationCommitProjection,
  type ConversationCommitProjectionInput,
  type ConversationMutationPublisher,
} from "@zhixing/owner-kernel/conversation-assignment";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
  type InteractionOutcome,
  type OwnerControlAuthorizer,
} from "../assignment-ledger.js";

const NOW = "2026-07-13T09:00:00.000Z";
const EXPIRY = "2026-07-13T10:00:00.000Z";
const EXECUTOR_ID = "executor-1";
const CONVERSATION_ID = "conversation-1";
const RUN_ID = "run-1";
const ASSIGNMENT_ID = "assignment-1";
const SHA256_ZERO = `sha256:${"0".repeat(64)}`;

type ConversationEnvelope = Extract<
  DispatchEnvelope,
  { execution: "conversation" }
>;

class TestProtocolIdentity implements ProtocolSigner, ProtocolSignatureVerifier {
  readonly #key = Buffer.from("unit-11-protocol-identity", "utf8");
  #nonce = 0;

  sign(schemaId: string, version: number, payload: unknown): Signature {
    const nonce = String(++this.#nonce);
    const mac = createHmac("sha256", this.#key)
      .update(protocolBytes(schemaId, version, payload))
      .update("\0")
      .update(nonce)
      .digest("base64url");
    return { alg: "test-hmac-sha256", keyId: "test-owner", sig: `${nonce}.${mac}` };
  }

  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: Signature,
  ): void {
    if (signature.alg !== "test-hmac-sha256" || signature.keyId !== "test-owner") {
      throw new Error("test signature identity mismatch");
    }
    const [nonce, encoded, extra] = signature.sig.split(".");
    if (!nonce || !encoded || extra !== undefined) throw new Error("test signature malformed");
    const expected = createHmac("sha256", this.#key)
      .update(protocolBytes(schemaId, version, payload))
      .update("\0")
      .update(nonce)
      .digest();
    const actual = Buffer.from(encoded, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("test signature invalid");
    }
  }
}

const ownerControl: OwnerControlAuthorizer = {
  authorize(context, method, assignmentId) {
    if (
      context.principal.kind !== "owner-control" ||
      context.principal.grant.assignmentId !== assignmentId ||
      !context.principal.grant.methods.includes(method)
    ) {
      throw new Error("owner control authorization failed");
    }
  },
};

const submission: AssignmentSubmissionAuthorizer = {
  authorize(context, method, assignmentId) {
    if (
      context.principal.kind !== "assignment" ||
      context.principal.capability.assignmentId !== assignmentId ||
      !context.principal.capability.methods.includes(method)
    ) {
      throw new Error("assignment submission authorization failed");
    }
  },
};

async function createUnassignedHarness(
  options: {
    maxPendingInteractions?: number;
    authority?: ConversationCommitAuthority;
    projection?: ConversationCommitProjection;
    publisher?: ConversationMutationPublisher;
  } = {},
) {
  const root = await createTempDir("conversation-assignment");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  const identity = new TestProtocolIdentity();
  const projected = new Map<string, ConversationCommitProjectionInput>();
  const authority: ConversationCommitAuthority =
    options.authority ??
    {
      decideAtPrefix(input) {
        if (
          input.conversationId !== CONVERSATION_ID ||
          input.ownerEpoch !== 3 ||
          input.baseRevision !== 7 ||
          input.runRecord.runIndex !== 8
        ) {
          return {
            committed: false,
            error: { code: "revision-conflict", message: "stale conversation base", retryable: false },
          };
        }
        return { committed: true, commitRevision: 8 };
      },
    };
  const projection: ConversationCommitProjection =
    options.projection ??
    {
      async project(input) {
        const previous = projected.get(input.assignmentId);
        if (previous && canonicalize(previous) !== canonicalize(input)) {
          throw new Error("projection identity conflict");
        }
        projected.set(input.assignmentId, input);
      },
    };
  const journal = new ConversationRunJournal({
    conversationId: CONVERSATION_ID,
    ownerEpoch: 3,
    log,
    artifacts,
    signer: identity,
    verifier: identity,
    submission,
    authority,
    projection,
    publisher: options.publisher,
  });
  const ledger = new ConversationAssignmentLedger({
    log,
    artifacts,
    executorId: EXECUTOR_ID,
    signer: identity,
    verifier: identity,
    ownerControl,
    clock: () => NOW,
    maxPendingInteractions: options.maxPendingInteractions,
  });
  await journal.admit({
    ingressKey: "surface:user-1/ingress-1",
    runId: RUN_ID,
    userInput: { parts: [{ type: "text", text: "hello" }] },
    ingress: ingress(),
    queuedPosition: 0,
  });
  const unsigned = createUnsignedEnvelope(identity);
  return {
    root,
    artifacts,
    log,
    identity,
    journal,
    ledger,
    unsigned,
    authority,
    projection,
    projected,
  };
}

async function createHarness(
  options: {
    maxPendingInteractions?: number;
    authority?: ConversationCommitAuthority;
    projection?: ConversationCommitProjection;
    publisher?: ConversationMutationPublisher;
  } = {},
) {
  const harness = await createUnassignedHarness(options);
  const { journal, unsigned } = harness;
  const dispatch = await journal.assign(unsigned);
  return { ...harness, dispatch };
}

describe("conversation assignment protocol", () => {
  it("requires durable receipt before start and recovers a lost started report", async () => {
    const harness = await createHarness();
    const disabled = new InProcessConversationDispatcher({
      enabled: false,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
    });
    expect(await disabled.dispatchPending()).toEqual([]);
    await expect(harness.ledger.start(ASSIGNMENT_ID)).rejects.toThrow(
      "before a durable received record",
    );

    const restartedJournal = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 3,
      log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts: harness.artifacts,
      signer: harness.identity,
      verifier: harness.identity,
      submission,
      authority: harness.authority,
      projection: harness.projection,
    });
    expect(await restartedJournal.pendingDispatches()).toHaveLength(1);
    const enabled = new InProcessConversationDispatcher({
      enabled: true,
      journal: restartedJournal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
    });
    expect(await enabled.dispatchPending()).toEqual([{ v: 1, accepted: true }]);
    expect(await restartedJournal.pendingDispatches()).toEqual([]);

    await harness.ledger.start(ASSIGNMENT_ID);
    expect(await restartedJournal.currentState(RUN_ID)).toBe("dispatched");
    expect(await enabled.recoverStarted()).toBe(1);
    expect(await restartedJournal.currentState(RUN_ID)).toBe("running");

    const lostAckHarness = await createHarness();
    await lostAckHarness.ledger.dispatch(
      lostAckHarness.dispatch.envelope,
      lostAckHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const submissionAdapter = new InProcessAssignmentSubmission({
      ledger: lostAckHarness.ledger,
      owner: lostAckHarness.journal,
    });
    await submissionAdapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(lostAckHarness.unsigned),
    );
    expect(await lostAckHarness.journal.pendingDispatches()).toEqual([]);
  });

  it("linearizes duplicate dispatch, accepts a re-sign, and proves conflicts without appending", async () => {
    const harness = await createHarness();
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
    });
    const [first, duplicate] = await Promise.all([
      harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
      peer.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ]);
    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(true);
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(1);

    const reissued = await harness.journal.assign(harness.unsigned);
    expect(reissued.envelope).toEqual(harness.dispatch.envelope);
    expect(reissued.activation.signature.sig).not.toBe(
      harness.dispatch.activation.signature.sig,
    );
    expect(
      await harness.ledger.dispatch(
        reissued.envelope,
        reissued.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ).toEqual({ v: 1, accepted: true });

    const changedPayload = {
      ...withoutSignature(reissued.activation),
      commit: {
        ...reissued.activation.commit,
        lsn: reissued.activation.commit.lsn + 1,
      },
    } satisfies AssignmentActivationPayload<"conversation">;
    const conflicting: AssignmentActivationProof<"conversation"> = {
      ...changedPayload,
      signature: harness.identity.sign(
        "AssignmentActivationProof",
        1,
        changedPayload,
      ),
    };
    const conflict = await harness.ledger.dispatch(
      reissued.envelope,
      conflicting,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    expect(conflict).toMatchObject({
      accepted: false,
      outcome: "conflicting-redelivery",
      error: { code: "idempotency-conflict", retryable: false },
      proof: {
        receivedRecordSeq: 1,
        error: { code: "idempotency-conflict", retryable: false },
      },
    });
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected a signed dispatch conflict");
    }
    const { signature: conflictSignature, ...conflictPayload } = conflict.proof;
    expect(() =>
      harness.identity.verify(
        "DispatchConflictProof",
        1,
        conflictPayload,
        conflictSignature,
      ),
    ).not.toThrow();
    expect(conflict.proof.acceptedActivationDigest).toBe(
      assignmentActivationDigest(withoutSignature(harness.dispatch.activation)),
    );
    expect(conflict.proof.conflictingActivationDigest).toBe(
      assignmentActivationDigest(changedPayload),
    );
    const receivedPage = (await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 1 },
    )) as LedgerEvidencePage;
    expect(conflict.proof.receivedLedgerDigest).toBe(receivedPage.chainDigest);
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(1);
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
        lastRecordSeq: 1,
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
      { fromSeq: 1, limit: 1 },
    )) as LedgerEvidencePage;
    expect(rejected.proof.ledgerDigest).toBe(rejectionPage.chainDigest);
    expect(rejected.proof.ledgerDigest).toBe(
      advanceAssignmentLedger(
        assignmentLedgerSeed(ASSIGNMENT_ID),
        rejectionPage.entries[0] as AssignmentEntry,
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
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(1);
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
        by: "surface:user-1",
      },
      submissionContext(harness.unsigned),
    );
    expect(finished.outcome).toMatchObject({ t: "answered" });
    expect(await harness.ledger.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
    expect(
      await harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        [finished],
        submissionContext(harness.unsigned),
      ),
    ).toEqual({ mirroredUpTo: finished.seq });
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        [{ ...finished, outcome: { t: "expired" } }],
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("conflicting payloads");

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
    expect(
      await adapter.flushInteractionMirrors(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).toBe(1);

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
  });

  it("rejects absent dispatch dependencies and assignment-id reuse across runs", async () => {
    const missingHarness = await createUnassignedHarness();
    const missing = {
      digest: `sha256:${"f".repeat(64)}`,
      bytes: 23,
    } as const;
    await expect(
      missingHarness.journal.assign({
        ...missingHarness.unsigned,
        dependencyArtifacts: [missing],
      }),
    ).rejects.toThrow(`Dispatch dependency is not present: ${missing.digest}`);

    const harness = await createHarness();
    const secondRunId = "run-2";
    await harness.journal.admit({
      ingressKey: "surface:user-1/ingress-2",
      runId: secondRunId,
      userInput: { parts: [{ type: "text", text: "second" }] },
      ingress: ingress(),
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
    const windowBytes = Buffer.from("durable-window-input", "utf8");
    const dependencyBytes = Buffer.from("durable-transitive-dependency", "utf8");
    const windowRef = await harness.artifacts.put(windowBytes);
    const dependencyRef = await harness.artifacts.put(dependencyBytes);
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
    await expect(
      harness.log.collectGarbage({
        unreferencedBefore: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "artifact-missing" });
    await expect(harness.artifacts.has(orphan)).resolves.toBe(true);
  });

  it("never commits a dispatch whose nested artifacts lose a GC race", async () => {
    const harness = await createUnassignedHarness();
    const windowRef = await harness.artifacts.put(Buffer.from("racing-window", "utf8"));
    const dependencyRef = await harness.artifacts.put(
      Buffer.from("racing-dependency", "utf8"),
    );
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
        queuedPosition: 1,
      }),
    ).rejects.toThrow("Queued position already belongs to an active run");
    await expect(harness.journal.assign(harness.unsigned)).resolves.toMatchObject({
      assignmentId: ASSIGNMENT_ID,
    });
  });

  it("bounds interaction records and backlog while draining mirrors in finite batches", async () => {
    const harness = await createHarness({ maxPendingInteractions: 16 });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const beforeOversized = (
      await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)
    ).length;
    await expect(
      harness.ledger.requestInteraction(ASSIGNMENT_ID, {
        requestId: "oversized",
        toolName: "write-file",
        display: {
          title: "Write",
          lines: Array.from({ length: 20 }, () => "x".repeat(1_800)),
        },
        issuedAt: NOW,
        ttlMs: 60_000,
        expiresAt: "2026-07-13T09:01:00.000Z",
      }),
    ).rejects.toThrow("exceeds the durable protocol limit");
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(
      beforeOversized,
    );

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
        by: "channel:test",
      } as unknown as InteractionOutcome),
    ).rejects.toThrow("Interaction answer authority");
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(
      beforeInvalidOutcome,
    );
    const executorOnlyOutcome = {
      t: "answered" as const,
      authority: { via: "surface-ticket" as const, ticketId: "ticket-edge" },
      decision: { allowed: true, reason: "" },
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
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        Array.from({ length: 20 }, (_, index) => ({
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
            by: "surface:user-1",
          },
          at: NOW,
        })),
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
  });

  it("commits a sealed conversation exactly once and recovers publish and final response loss", async () => {
    const applied: Array<Parameters<ConversationMutationPublisher["apply"]>[0]> = [];
    let failFirstPublish = true;
    const publisher: ConversationMutationPublisher = {
      decideGlobalBatchAtPrefix() {
        throw new Error("global decision is not expected");
      },
      async apply(input) {
        if (failFirstPublish) {
          failFirstPublish = false;
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
      domain: "session",
      requestId: "mutation-1",
      mutation: {
        kind: "task-list-op",
        op: {
          op: "set",
          state: { items: [{ id: "task-1", content: "ship", status: "in_progress" }] },
        },
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
    ).rejects.toThrow("simulated publish crash");
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
    expect(harness.projected.get(ASSIGNMENT_ID)).toMatchObject({
      conversationId: CONVERSATION_ID,
      commitRevision: 8,
      digest: bundle.digest,
      runRecord,
    });
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
      submission,
      authority: harness.authority,
      projection: harness.projection,
      publisher,
    });
    await expect(recoveredJournal.resumePendingPublishing()).resolves.toBe(1);
    await expect(recoveredJournal.resumePendingPublishing()).resolves.toBe(0);
    expect(applied).toEqual([
      {
        assignmentId: ASSIGNMENT_ID,
        seq: 1,
        domain: "session",
        requestId: "mutation-1",
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: { items: [{ id: "task-1", content: "ship", status: "in_progress" }] },
          },
        },
        targetRevision: 8,
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
  });

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
            message: "workscene changed",
            retryable: false,
          },
        },
      ],
    });
    expect((await harness.journal.finalHistory(7))[0]?.frame.publishConflicts).toBe(1);
  });

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

    const staleOwner = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 4,
      log: wrongIndex.log,
      artifacts: wrongIndex.artifacts,
      signer: wrongIndex.identity,
      verifier: wrongIndex.identity,
      submission,
      authority: wrongIndex.authority,
      projection: wrongIndex.projection,
    });
    await expect(
      staleOwner.submitBundle(wrongIndexBundle, submissionContext(wrongIndex.unsigned)),
    ).resolves.toMatchObject({ committed: false, error: { code: "fence-rejected" } });
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
    ).rejects.toThrow("simulated projection crash");
    expect(await harness.journal.currentState(RUN_ID)).toBe("committed");
    await expect(harness.journal.resumeCommittedProjections()).resolves.toBe(1);
    await expect(harness.journal.resumeCommittedProjections()).resolves.toBe(0);
    expect(projected.get(ASSIGNMENT_ID)?.runRecord.runId).toBe(RUN_ID);
  });

  it("rejects publish progress that skips a granted mutation", async () => {
    const harness = await createHarness({
      publisher: {
        decideGlobalBatchAtPrefix() {
          throw new Error("global decision is not expected");
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
    for (const [index, content] of ["one", "two"].entries()) {
      await harness.ledger.stageMutation(ASSIGNMENT_ID, {
        domain: "session",
        requestId: `mutation-${index + 1}`,
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [{ id: `task-${index + 1}`, content, status: "pending" }],
            },
          },
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
    ).rejects.toThrow("pause before publish progress");
    await harness.log.append([
      {
        stream: "publish",
        body: {
          t: "publish-progress" as const,
          assignmentId: ASSIGNMENT_ID,
          domain: "session" as const,
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
    await publishHarness.log.append([
      {
        stream: "publish",
        body: {
          t: "publish-decision" as const,
          assignmentId: ASSIGNMENT_ID,
          batch: { ref: sealedBundleArtifact(publishBundle).ref },
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
  });

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
  });
});

function createUnsignedEnvelope(
  identity: TestProtocolIdentity,
  ids: { readonly runId?: string; readonly assignmentId?: string } = {},
): UnsignedConversationEnvelope {
  const runId = ids.runId ?? RUN_ID;
  const assignmentId = ids.assignmentId ?? ASSIGNMENT_ID;
  const manifestWithoutDigest = {
    v: 1 as const,
    baseRef: {
      execution: "conversation" as const,
      conversationId: CONVERSATION_ID,
      baseRevision: 7,
    },
    requires: {
      runtimeConfigRev: 1,
      modelProfileRev: 1,
      policyRev: 1,
      skillsRev: 1,
      rubricsRev: 1,
      promptAssetsRev: 1,
      permissionSnapshotVersion: 1,
    },
    environment: {},
    credentialBindings: [],
  };
  const manifest = {
    ...manifestWithoutDigest,
    digest: protocolDigest("ExecutionManifest", 1, manifestWithoutDigest),
  };
  const permissionPayload = {
    v: 1 as const,
    snapshotVersion: 1,
    snapshotDigest: protocolDigest("TrustRuleSnapshot", 1, { revision: 1 }),
    binding: {
      execution: "conversation" as const,
      runId,
      conversationId: CONVERSATION_ID,
      ownerEpoch: 3,
    },
    assignmentId,
    executorId: EXECUTOR_ID,
    controlLeaseId: "control-lease-1",
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const permissionLease: PermissionSnapshotLease<"conversation"> = {
    ...permissionPayload,
    signature: identity.sign("PermissionSnapshotLease", 1, permissionPayload),
  };
  const capabilityPayload = {
    v: 1 as const,
    capId: "capability-1",
    executorId: EXECUTOR_ID,
    scope: { execution: "conversation" as const, conversationId: CONVERSATION_ID },
    ownerEpoch: 3,
    methods: [
      "submission.mirrorInteractions",
      "submission.reportStarted",
      "submission.submitBundle",
    ] as AuthorityCapability<"conversation">["methods"],
    resources: [`conversation:${CONVERSATION_ID}`] as AuthorityCapability<"conversation">["resources"],
    assignmentId,
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const capability: AuthorityCapability<"conversation"> = {
    ...capabilityPayload,
    signature: identity.sign("AuthorityCapability", 1, capabilityPayload),
  };
  const leaseWithoutDigest = {
    v: 1 as const,
    reservationId: "reservation-1",
    admissionClass: "interactive" as const,
    workload: { kind: "run" as const, id: runId, attempt: 1 },
    scopeBinding: {
      kind: "conversation" as const,
      conversationId: CONVERSATION_ID,
      ownerEpoch: 3,
    },
    audience: { executorId: EXECUTOR_ID },
    budget: { maxCalls: 20, maxTokens: 10_000 },
    domain: {
      kind: "local" as const,
      localDomainId: "local:device-1",
      localGovernorEpoch: 1,
    },
    activation: { kind: "assignment" as const, assignmentId },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const leaseWithDigest = {
    ...leaseWithoutDigest,
    digest: protocolDigest("ResourceLease", 1, leaseWithoutDigest),
  };
  const resourceLease = {
    ...leaseWithDigest,
    signature: identity.sign("ResourceLease", 1, leaseWithDigest),
  };
  return {
    v: 1,
    execution: "conversation",
    assignmentId,
    executorId: EXECUTOR_ID,
    manifest,
    permissionLease,
    capabilities: [capability],
    resourceLease,
    dependencyArtifacts: [],
    issuedAt: NOW,
    work: {
      t: "conversation",
      runId,
      conversationId: CONVERSATION_ID,
      ownerEpoch: 3,
      baseRevision: 7,
      ingress: ingress(),
      windowInput: { t: "full", windowEpoch: 1, messages: [] },
      controlContext: [],
    },
  };
}

function ingress() {
  return {
    kind: "first-party" as const,
    surfacePrincipal: "surface:user-1",
    deviceId: "device-1",
    ingressId: "ingress-1",
    receivedAt: NOW,
  };
}

function ownerContext(
  assignmentId: string,
  method: "executor.dispatch" | "executor.queryLedger",
): AuthorityCallContext {
  return {
    principal: {
      kind: "owner-control",
      grant: {
        v: 1,
        assignmentId,
        scope: { execution: "conversation", conversationId: CONVERSATION_ID, ownerEpoch: 3 },
        methods: [method],
        callerDeviceId: "device-1",
        requestId: `owner-${method}-${assignmentId}`,
        issuedAt: NOW,
        expiry: EXPIRY,
        signature: { alg: "test", keyId: "test-owner", sig: "context" },
      },
    },
    requestId: `request-${method}-${assignmentId}`,
    deadlineAt: EXPIRY,
  };
}

function submissionContext(
  envelope: UnsignedConversationEnvelope,
): AuthorityCallContext {
  return {
    principal: { kind: "assignment", capability: envelope.capabilities[0]! },
    requestId: "submission-request",
    deadlineAt: EXPIRY,
  };
}

function withoutSignature<T extends { signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return JSON.parse(canonicalize(payload)) as Omit<T, "signature">;
}
