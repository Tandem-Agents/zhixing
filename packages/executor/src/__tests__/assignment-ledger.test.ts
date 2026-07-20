import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  AuthorityStorageError,
  FileArtifactStore,
  FileAuthorityCommitLog,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type ArtifactStore,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core";
import type {
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AuthorityCallContext,
  AuthorityCapability,
  CancelProofBody,
  DispatchEnvelope,
  LedgerEvidencePage,
  LedgerSnapshot,
  IngressContext,
  PermissionSnapshotLease,
  Signature,
  TranscriptRunRecord,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import {
  advanceAssignmentLedger,
  assignmentActivationDigest,
  assignmentLedgerSeed,
  buildConversationActivationPayload,
  canonicalize,
  confirmationDecisionDigest,
  createSignedConversationEnvelope,
  createSignedTrustRuleSnapshot,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  protocolBytes,
  protocolDigest,
  createConversationSealedBundle,
  createSignedConversationInteractionMirrorBatch,
  interactionMirrorSeed,
  permissionSnapshotLeaseDigest,
  sealedBundleArtifact,
  signCancelProof,
  signConversationActivation,
  signSupersedeProof,
  validateCancelProof,
  validateAssignmentEntry,
  validateConversationEnvelope,
  validateDispatchConflictProof,
  validateNonEmptyUserTurnInput,
  validateStagedMutationRecord,
  validateSupersedeProof,
  validateTranscriptRunRecord,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type ConversationInteractionMirrorBatch,
  type ConversationInteractionMirrorEntry,
  type ExecutorCapabilitySnapshot,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";
import {
  CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
  CONVERSATION_RUN_RECORD_SHAPES,
  ConversationRunJournal,
  InProcessConversationDispatcher,
  type AssignmentSubmissionAuthorizer,
  type ConversationCommitAuthority,
  type ConversationCommitProjection,
  type ConversationCommitProjectionInput,
  type ConversationMutationPublisher,
  type ConversationRunRecordType,
} from "@zhixing/owner-kernel/conversation-assignment";
import {
  ControlAdmissionJournal,
  channelSurfacePrincipal,
  createConversationControlEnvelope,
  createInitialControlEnvelope,
} from "@zhixing/owner-kernel/control-admission";
import { OwnerDeliveryParticipant } from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
  type AssignmentLedgerOptions,
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
const ABORT_TICKET_DIGEST = `sha256:${"a".repeat(64)}`;

function matchingSnapshotFor(executorId: string): ExecutorCapabilitySnapshot | undefined {
  if (executorId !== EXECUTOR_ID) return undefined;
  const signature = { alg: "test", keyId: "test", sig: "test" };
  return {
    descriptor: {
      v: 1,
      executorId,
      revision: 1,
      protocolVersion: "1",
      workspaces: [],
      tools: [],
      mcpServers: [],
      credentialBindings: [],
      evidenceCapabilities: [],
      at: NOW,
      signature,
    },
    inventory: {
      v: 1,
      executorId,
      inventoryRevision: 1,
      capabilityRevision: 1,
      configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
      assetVersions: {
        skillsRev: 1,
        rubricsRev: 1,
        promptAssetsRev: 1,
      },
      permissionSnapshotHighWater: 1,
      credentialBindingRevisions: [],
      at: NOW,
      signature,
    },
  };
}

function matchingPermissionSnapshotFor(
  identity: TestProtocolIdentity,
  digest: string,
): TrustRuleSnapshot | undefined {
  const snapshot = createSignedTrustRuleSnapshot(
    { snapshotVersion: 1, rules: [], generatedAt: NOW },
    identity,
  );
  return snapshot.digest === digest ? snapshot : undefined;
}

function allowOnceDecisionDigest(requestId: string): string {
  return confirmationDecisionDigest(requestId, { kind: "allow-once" });
}

function deliveryParticipant(log: FileAuthorityCommitLog): OwnerDeliveryParticipant {
  return new OwnerDeliveryParticipant({
    authority: new DeliveryAuthority({ log, anchorEpoch: 3 }),
  });
}

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

class CountingArtifactStore implements ArtifactStore {
  readonly #delegate: ArtifactStore;
  puts = 0;
  gets = 0;
  hasChecks = 0;

  constructor(delegate: ArtifactStore) {
    this.#delegate = delegate;
  }

  put(bytes: Uint8Array) {
    this.puts += 1;
    return this.#delegate.put(bytes);
  }

  get(ref: Parameters<ArtifactStore["get"]>[0]) {
    this.gets += 1;
    return this.#delegate.get(ref);
  }

  has(ref: Parameters<ArtifactStore["has"]>[0]) {
    this.hasChecks += 1;
    return this.#delegate.has(ref);
  }

  resetReads(): void {
    this.gets = 0;
    this.hasChecks = 0;
  }

  resetWrites(): void {
    this.puts = 0;
  }

  get reads(): number {
    return this.gets + this.hasChecks;
  }

  get writes(): number {
    return this.puts;
  }
}

class FaultingArtifactStore implements ArtifactStore {
  readonly #delegate: ArtifactStore;
  failDigest?: string;

  constructor(delegate: ArtifactStore) {
    this.#delegate = delegate;
  }

  put(bytes: Uint8Array) {
    return this.#delegate.put(bytes);
  }

  get(ref: Parameters<ArtifactStore["get"]>[0]) {
    if (ref.digest === this.failDigest) {
      throw new Error("simulated transient delivery content read failure");
    }
    return this.#delegate.get(ref);
  }

  has(ref: Parameters<ArtifactStore["has"]>[0]) {
    return this.#delegate.has(ref);
  }
}

function signedMirrorBatch(
  identity: TestProtocolIdentity,
  entries: readonly ConversationInteractionMirrorEntry[],
  options: {
    readonly assignmentId?: string;
    readonly executorId?: string;
    readonly previousDigest?: string;
  } = {},
): ConversationInteractionMirrorBatch {
  const assignmentId = options.assignmentId ?? ASSIGNMENT_ID;
  return createSignedConversationInteractionMirrorBatch({
    assignmentId,
    executorId: options.executorId ?? EXECUTOR_ID,
    previousDigest: options.previousDigest ?? interactionMirrorSeed(assignmentId),
    entries,
    signer: identity,
  });
}

function mirrorReceipt(batch: ConversationInteractionMirrorBatch) {
  const last = batch.entries.at(-1);
  if (!last) throw new Error("test mirror batch is empty");
  return {
    mirroredUpTo: last.seq,
    ordinal: last.ordinal,
    mirrorDigest: batch.mirrorDigest,
  };
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
  authenticate(context, identity) {
    if (
      context.principal.kind !== "assignment" ||
      context.principal.capability.assignmentId !== identity.assignmentId ||
      !context.principal.capability.methods.includes(identity.method)
    ) {
      throw new Error("assignment submission authentication failed");
    }
  },
  authorize(context, authorization) {
    submission.authenticate(context, authorization);
  },
};

function createRevocationAwareSubmission() {
  const revoked = new Set<string>();
  const authorizer: AssignmentSubmissionAuthorizer = {
    authenticate(context, identity) {
      submission.authenticate(context, identity);
    },
    authorize(context, authorization) {
      submission.authorize(context, authorization);
      if (revoked.has(authorization.assignmentId) && authorization.mode === "active") {
        throw new Error("revoked capability cannot perform an active submission");
      }
    },
  };
  return {
    authorizer,
    revoke(assignmentId: string) {
      revoked.add(assignmentId);
    },
  };
}

async function createUnassignedHarness(
  options: {
    maxPendingInteractions?: number;
    authority?: ConversationCommitAuthority;
    projection?: ConversationCommitProjection;
    publisher?: ConversationMutationPublisher;
    submission?: AssignmentSubmissionAuthorizer;
    ownerArtifacts?: (artifacts: FileArtifactStore) => ArtifactStore;
    ingress?: IngressContext;
    snapshotFor?: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
    permissionSnapshotFor?: (digest: string) => TrustRuleSnapshot | undefined;
    runtimeBindingGuard?: AssignmentLedgerOptions["runtimeBindingGuard"];
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
  const control = new ControlAdmissionJournal(log, artifacts);
  const ownerArtifacts = options.ownerArtifacts?.(artifacts) ?? artifacts;
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
    artifacts: ownerArtifacts,
    signer: identity,
    verifier: identity,
    delivery: deliveryParticipant(log),
    submission: options.submission ?? submission,
    authority,
    projection,
    publisher: options.publisher,
    abortTickets: {
      authorize(input) {
        if (
          input.assignmentId !== ASSIGNMENT_ID ||
          input.executorId !== EXECUTOR_ID ||
          input.ticketDigest !== ABORT_TICKET_DIGEST ||
          input.surfacePrincipal !== "surface:user-1"
        ) {
          throw new Error("abort ticket authorization failed");
        }
      },
    },
  });
  const ledger = new ConversationAssignmentLedger({
    log,
    artifacts,
    executorId: EXECUTOR_ID,
    signer: identity,
    verifier: identity,
    ownerControl,
    snapshotFor: options.snapshotFor ?? matchingSnapshotFor,
    permissionSnapshotFor: options.permissionSnapshotFor ??
      ((digest) => matchingPermissionSnapshotFor(identity, digest)),
    runtimeBindingGuard: options.runtimeBindingGuard,
    clock: () => NOW,
    maxPendingInteractions: options.maxPendingInteractions,
    surfaceAbort: {
      authorize(assignmentId, input) {
        if (
          assignmentId !== ASSIGNMENT_ID ||
          input.ticketDigest !== ABORT_TICKET_DIGEST ||
          input.surfacePrincipal !== "surface:user-1"
        ) {
          throw new Error("surface abort authorization failed");
        }
      },
    },
  });
  await journal.admit({
    ingressKey: "surface:user-1/ingress-1",
    runId: RUN_ID,
    userInput: { parts: [{ type: "text", text: "hello" }] },
    ingress: options.ingress ?? ingress(),
    invocation: { kind: "agent", source: "interactive" },
    queuedPosition: 0,
  });
  const unsigned = createUnsignedEnvelope(
    identity,
    options.ingress ? { ingress: options.ingress } : {},
  );
  return {
    root,
    artifacts,
    log,
    identity,
    control,
    journal,
    ledger,
    unsigned,
    authority,
    projection,
    projected,
    ownerArtifacts,
  };
}

async function createHarness(
  options: {
    maxPendingInteractions?: number;
    authority?: ConversationCommitAuthority;
    projection?: ConversationCommitProjection;
    publisher?: ConversationMutationPublisher;
    submission?: AssignmentSubmissionAuthorizer;
    ownerArtifacts?: (artifacts: FileArtifactStore) => ArtifactStore;
    ingress?: IngressContext;
    snapshotFor?: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
    permissionSnapshotFor?: (digest: string) => TrustRuleSnapshot | undefined;
    runtimeBindingGuard?: AssignmentLedgerOptions["runtimeBindingGuard"];
  } = {},
) {
  const harness = await createUnassignedHarness(options);
  const { journal, unsigned } = harness;
  const dispatch = await journal.assign(unsigned);
  return { ...harness, dispatch };
}

describe("conversation assignment protocol", () => {
  it("atomically derives final and staged deliveries without intermediate status noise", async () => {
    const responder = {
      channelId: "feishu",
      platformSubject: "user-1",
      tenant: "tenant-1",
    };
    const channelIngress: IngressContext = {
      kind: "channel",
      surfacePrincipal: channelSurfacePrincipal(responder),
      responder,
      replyTarget: { channelId: "feishu", to: "chat-1" },
      deviceId: "device-1",
      ingressId: "ingress-channel-1",
      receivedAt: NOW,
    };
    const harness = await createHarness({ ingress: channelIngress });
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
      requestId: "deliver-staged-result",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: { target: { kind: "turn-origin" }, content: "staged result" },
      },
    });
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [
          { role: "user", content: [{ type: "text", text: "work" }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });

    const commits = await harness.log.readAll();
    const committed = commits.find((commit) =>
      commit.entries.some(
        (entry) =>
          entry.stream === `run:${CONVERSATION_ID}` &&
          (entry.body as { readonly t?: string }).t === "committed",
      ),
    );
    const commitDeliveryKinds = committed?.entries
      .filter((entry) => entry.stream === "delivery")
      .map(
        (entry) =>
          (entry.body as { readonly keyBody: { readonly kind: string } }).keyBody.kind,
      );
    expect(commitDeliveryKinds).toEqual([
      "conversation-final-delivery",
      "staged-delivery",
    ]);
    expect(
      committed?.entries.some(
        (entry) =>
          entry.stream === "publish" &&
          (entry.body as { readonly t?: string }).t === "publish-decision",
      ),
    ).toBe(true);
    expect(
      committed?.entries.some(
        (entry) =>
          entry.stream === "publish" &&
          (entry.body as { readonly t?: string }).t === "publish-progress",
      ),
    ).toBe(false);
    expect(
      commits.some((commit) =>
        commit.entries.some(
          (entry) =>
            entry.stream === "delivery" &&
            (entry.body as { readonly keyBody?: { readonly kind?: string } }).keyBody
              ?.kind === "conversation-status-delivery",
        ),
      ),
    ).toBe(false);
  }, 15_000);

  it("does not write delivery content for an unroutable final or during committed replay", async () => {
    let counted: CountingArtifactStore | undefined;
    const firstParty = await createHarness({
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    await firstParty.ledger.dispatch(
      firstParty.dispatch.envelope,
      firstParty.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: firstParty.ledger,
      owner: firstParty.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(firstParty.unsigned));
    const unroutable = await sealDefaultBundle(
      firstParty.ledger,
      "x".repeat(MAX_INLINE_LOGICAL_RECORD_BYTES),
    );
    counted!.resetWrites();
    await expect(
      firstParty.journal.submitBundle(
        unroutable,
        submissionContext(firstParty.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(counted!.writes).toBe(0);

    const channel = await createHarness({
      ingress: {
        kind: "channel",
        surfacePrincipal: channelSurfacePrincipal({
          channelId: "feishu",
          platformSubject: "user-1",
        }),
        responder: { channelId: "feishu", platformSubject: "user-1" },
        replyTarget: { channelId: "feishu", to: "chat-1" },
        deviceId: "device-1",
        ingressId: "ingress-replay",
        receivedAt: NOW,
      },
    });
    await channel.ledger.dispatch(
      channel.dispatch.envelope,
      channel.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: channel.ledger,
      owner: channel.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(channel.unsigned));
    const routed = await sealDefaultBundle(
      channel.ledger,
      "y".repeat(MAX_INLINE_LOGICAL_RECORD_BYTES),
    );
    await channel.journal.submitBundle(routed, submissionContext(channel.unsigned));
    counted = new CountingArtifactStore(channel.artifacts);
    const cold = reopenJournal(channel, { artifacts: counted });
    counted.resetWrites();
    await expect(cold.currentState(RUN_ID)).resolves.toBe("committed");
    expect(counted.writes).toBe(0);
  }, 15_000);

  it("retries a conversation commit after transient staged-content storage failure", async () => {
    let faulting: FaultingArtifactStore | undefined;
    const harness = await createHarness({
      ownerArtifacts(store) {
        faulting = new FaultingArtifactStore(store);
        return faulting;
      },
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const content = await harness.artifacts.put(
      Buffer.from(canonicalize({ text: "staged", markdown: "staged" }), "utf8"),
    );
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "transient-conversation-staged-content",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: { ref: content },
        },
      },
    });
    const bundle = await sealDefaultBundle(harness.ledger);
    const before = (await harness.log.readAll()).length;
    faulting!.failDigest = content.digest;

    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).rejects.toThrow("simulated transient delivery content read failure");
    expect((await harness.log.readAll()).length).toBe(before);

    faulting!.failDigest = undefined;
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
  }, 15_000);

  it("commits and cold-replays a conversation with invalid staged delivery content", async () => {
    const harness = await createHarness({
      publisher: {
        decideGlobalBatchAtPrefix() {
          throw new Error("global decision is not expected");
        },
        async apply() {},
      },
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const invalid = await harness.artifacts.put(
      Buffer.from("not canonical delivery content", "utf8"),
    );
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "invalid-conversation-staged-content",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: { ref: invalid },
        },
      },
    });

    await expect(
      harness.journal.submitBundle(
        await sealDefaultBundle(harness.ledger),
        submissionContext(harness.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    await expect(reopenJournal(harness).currentState(RUN_ID)).resolves.toBe(
      "committed",
    );
  }, 15_000);

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
      delivery: deliveryParticipant(harness.log),
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
      cancellationSubmission: createCancellationSubmission(
        harness,
        restartedJournal,
      ),
      bundleSubmission: createBundleSubmission(harness, restartedJournal),
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
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
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
    ).resolves.toMatchObject({ phase: "received", lastSeq: 1 });
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
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
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
  }, 20_000);

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
    });
    await expect(
      restarted.recoverInteractions(ASSIGNMENT_ID, NOW),
    ).rejects.toThrow(/artifact/i);
  });

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
    ).rejects.toThrow("Interaction answer authority");
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
  }, 15_000);

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
  }, 15_000);

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
    ).resolves.toEqual({ seq: 1 });
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
    ).resolves.toEqual({ seq: 33 });
  }, 15_000);

  it("commits a sealed conversation exactly once and recovers publish and final response loss", async () => {
    const applied: Array<Parameters<ConversationMutationPublisher["apply"]>[0]> = [];
    let failSecondPublish = true;
    const publisher: ConversationMutationPublisher = {
      decideGlobalBatchAtPrefix() {
        throw new Error("global decision is not expected");
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
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "session",
      requestId: "mutation-2",
      mutation: {
        kind: "task-list-op",
        op: {
          op: "set",
          state: {
            items: [{ id: "task-2", content: "ship", status: "completed" }],
          },
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
      {
        assignmentId: ASSIGNMENT_ID,
        seq: 2,
        domain: "session",
        requestId: "mutation-2",
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [{ id: "task-2", content: "ship", status: "completed" }],
            },
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
  }, 15_000);

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
  }, 15_000);

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
    await expect(harness.journal.assignmentsAwaitingRecovery()).resolves.toEqual([]);
  }, 15_000);

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
  }, 15_000);

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
      await harness.log.append([
        { stream: `run:${CONVERSATION_ID}`, body: acknowledgement },
        ...(kind === "duplicate"
          ? [{ stream: `run:${CONVERSATION_ID}`, body: acknowledgement }]
          : []),
      ]);

      await expect(reopenJournal(harness).currentState(RUN_ID)).rejects.toThrow(
        "Bundle acknowledgement observation does not bind one committed conversation bundle",
      );
      await expect(
        reopenJournal(harness).submitBundle(bundle, submissionContext(harness.unsigned)),
      ).rejects.toThrow("Submission guard bundle acknowledgement is invalid or duplicated");
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
      decideGlobalBatchAtPrefix() {
        throw new Error("global decision is not expected");
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
      domain: "session",
      requestId: "first-partitioned-mutation",
      mutation: {
        kind: "task-list-op",
        op: { op: "set", state: { items: [] } },
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
      domain: "session",
      requestId: "second-partitioned-mutation",
      mutation: {
        kind: "task-list-op",
        op: { op: "set", state: { items: [] } },
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
  }, 15_000);

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

    const staleArtifacts = new CountingArtifactStore(wrongIndex.artifacts);
    const staleOwner = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 4,
      log: wrongIndex.log,
      artifacts: staleArtifacts,
      signer: wrongIndex.identity,
      verifier: wrongIndex.identity,
      delivery: deliveryParticipant(wrongIndex.log),
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
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
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
  }, 20_000);

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

  it("rejects dispatch not-started proof after durable started and stops only dispatch recovery", async () => {
    const harness = await createHarness();
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
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
    await harness.journal.acceptDispatchRejection({
      v: 1,
      accepted: false,
      outcome: "rejected-before-received",
      error: payload.error,
      proof,
    });

    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.assignmentsAwaitingRecovery()).toEqual([]);
    expect(await reopenJournal(harness).assignmentsAwaitingRecovery()).toEqual([]);
  });

  it("treats an already-started supersede proof as the durable started report", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-after-start",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );

    expect(proof.decision).toBe("already-started");
    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("running");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
  });

  it("keeps a later cancel when an in-flight supersede proves already-started", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-started-before-cancel",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-started-supersede",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );

    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancel-requested");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("replays a durable owner cancellation and accepts its not-started proof", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-before-start",
    });
    expect(cancelled.state).toBe("cancel-requested");
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    expect(await harness.journal.pendingCancellations()).toEqual([
      { assignmentId: ASSIGNMENT_ID, fence: cancelled.fence },
    ]);

    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof?.decision).toBe("not-started");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    const accepted = (await harness.log.readStream(`run:${CONVERSATION_ID}`)).filter(
      (record) =>
        (record.body as { readonly t?: string }).t === "cancel-proof-accepted",
    );
    expect(accepted).toHaveLength(1);

    const beforeReplay = (await harness.log.readAll()).length;
    const reopened = reopenJournal(harness);
    await reopened.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);

    const conflictingPayload = {
      ...withoutSignature(proof!),
      issuedAt: "2026-07-13T09:00:01.000Z",
    };
    const conflicting = signCancelProof(conflictingPayload, harness.identity);
    await expect(
      reopened.submitCancelProof(
        ASSIGNMENT_ID,
        conflicting,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("different durable termination proof");
  });

  it("rejects non-atomic owner termination facts during replay", async () => {
    const bareState = await createHarness();
    await bareState.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "cancelled",
          statusRevision: 3,
        },
      },
    ]);
    await expect(bareState.journal.currentState(RUN_ID)).rejects.toThrow(
      "not atomic with its termination proof",
    );

    const bareAccepted = await createHarness();
    await bareAccepted.ledger.dispatch(
      bareAccepted.dispatch.envelope,
      bareAccepted.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await bareAccepted.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    await bareAccepted.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "cancel-proof-accepted",
          assignmentId: ASSIGNMENT_ID,
          proof: (await bareAccepted.ledger.cancelProof(ASSIGNMENT_ID))!,
        },
      },
    ]);
    await expect(bareAccepted.journal.currentState(RUN_ID)).rejects.toThrow(
      "Accepted cancel proof replay contract",
    );

    const bareSupersede = await createHarness();
    const fence = await bareSupersede.journal.requestSupersede(
      ASSIGNMENT_ID,
      "bare-supersede-proof",
    );
    const proof = await bareSupersede.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await bareSupersede.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: { t: "assignment-superseded", assignmentId: ASSIGNMENT_ID, proof },
      },
    ]);
    await expect(bareSupersede.journal.currentState(RUN_ID)).rejects.toThrow(
      "Assignment supersede replay contract",
    );
  }, 15_000);

  it("rejects non-atomic initial facts, cross-conversation dispatches, and non-head assignments", async () => {
    const admittedOnly = await createUnassignedHarness();
    await admittedOnly.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "admitted",
          ingressKey: "surface:user-1/split-admission",
          runId: "run-split-admission",
          input: { parts: [{ type: "text", text: "split" }] },
          ingress: ingress(),
          invocation: { kind: "agent", source: "interactive" },
          queuedPosition: 1,
        },
      },
    ]);
    await expect(admittedOnly.journal.currentState("run-split-admission")).rejects.toThrow(
      "not atomic with its initial queued state",
    );

    const assignedOnly = await createUnassignedHarness();
    const bareAssignment = await storedAssignmentFact(
      assignedOnly,
      assignedOnly.unsigned,
    );
    await assignedOnly.log.append([
      { stream: `run:${CONVERSATION_ID}`, body: bareAssignment.record },
    ]);
    await expect(
      assignedOnly.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(assignedOnly.unsigned),
      ),
    ).rejects.toThrow("not atomic with dispatched state");
    await expect(assignedOnly.journal.currentState(RUN_ID)).rejects.toThrow(
      "not atomic with dispatched state",
    );

    const crossConversation = await createUnassignedHarness();
    const foreignUnsigned = createUnsignedEnvelope(crossConversation.identity, {
      conversationId: "conversation-foreign",
    });
    const foreignAssignment = await storedAssignmentFact(
      crossConversation,
      foreignUnsigned,
    );
    await crossConversation.log.append([
      { stream: `run:${CONVERSATION_ID}`, body: foreignAssignment.record },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "dispatched",
          statusRevision: 2,
        },
      },
    ]);
    await expect(crossConversation.journal.pendingDispatches()).rejects.toThrow(
      "does not match its dispatch artifact",
    );

    const nonHead = await createUnassignedHarness();
    await nonHead.journal.admit({
      ingressKey: "surface:user-1/queued-second",
      runId: "run-second",
      userInput: { parts: [{ type: "text", text: "second" }] },
      ingress: ingress(),
      invocation: { kind: "agent", source: "interactive" },
      queuedPosition: 1,
    });
    const secondUnsigned = createUnsignedEnvelope(nonHead.identity, {
      runId: "run-second",
      assignmentId: "assignment-second",
    });
    const secondAssignment = await storedAssignmentFact(nonHead, secondUnsigned);
    await nonHead.log.append([
      { stream: `run:${CONVERSATION_ID}`, body: secondAssignment.record },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: "run-second",
          assignmentId: "assignment-second",
          state: "dispatched",
          statusRevision: 2,
        },
      },
    ]);
    await expect(nonHead.journal.currentState("run-second")).rejects.toThrow(
      "Run assignment is duplicated, misplaced, or not atomic with dispatched state",
    );
  });

  it("rejects unknown fields in durable owner run records", async () => {
    const harness = await createHarness();
    await harness.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked",
          assignmentId: ASSIGNMENT_ID,
          capId: harness.unsigned.capabilities[0]!.capId,
          futureField: true,
        } as never,
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "fields are incomplete or unknown",
    );
  });

  it("rejects invalid durable admission values before they reach queue indexes", async () => {
    const harness = await createHarness();
    await harness.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "admitted",
          ingressKey: "surface:user-2/ingress-invalid",
          runId: "run-invalid",
          input: { parts: [{ type: "text", text: "invalid" }] },
          ingress: ingress(),
          invocation: { kind: "agent", source: "interactive" },
          queuedPosition: "1",
        } as never,
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "Admitted queued position",
    );
    await expect(
      harness.journal.admit({
        ingressKey: "surface:user-2/ingress-invalid-source",
        runId: "run-invalid-source",
        userInput: { parts: [{ type: "text", text: "invalid" }] },
        ingress: { ...ingress(), receivedAt: "not-a-time" },
        invocation: { kind: "agent", source: "interactive" },
        queuedPosition: 2,
      }),
    ).rejects.toThrow("canonical ISO timestamp");
  });

  it("fails closed across nested wire, durable, manifest, message, and optional schemas", async () => {
    const harness = await createHarness();
    const pollutedInput = {
      parts: [
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image", future: true },
        },
      ],
    };
    expect(() => validateNonEmptyUserTurnInput(pollutedInput)).toThrow(
      "unknown",
    );
    await expect(
      harness.journal.admit({
        ingressKey: "surface:user-2/ingress-polluted-input",
        runId: "run-polluted-input",
        userInput: pollutedInput as never,
        ingress: ingress(),
        invocation: { kind: "agent", source: "interactive" },
        queuedPosition: 2,
      }),
    ).rejects.toThrow("unknown");

    const pollutedMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello", future: true }],
    };
    expect(() =>
      createSignedConversationEnvelope(
        {
          ...harness.unsigned,
          work: {
            ...harness.unsigned.work,
            windowInput: {
              t: "full",
              windowEpoch: 1,
              messages: [pollutedMessage],
            },
          },
        } as never,
        harness.identity,
        harness.identity,
      ),
    ).toThrow("unknown");
    expect(() =>
      createSignedConversationEnvelope(
        {
          ...harness.unsigned,
          work: {
            ...harness.unsigned.work,
            windowInput: {
              t: "delta",
              baseEpoch: 1,
              targetEpoch: 2,
              baseDigest: SHA256_ZERO,
              targetDigest: SHA256_ZERO,
              appended: [pollutedMessage],
            },
          },
        } as never,
        harness.identity,
        harness.identity,
      ),
    ).toThrow("unknown");
    expect(() =>
      createSignedConversationEnvelope(
        {
          ...harness.unsigned,
          manifest: {
            ...harness.unsigned.manifest,
            environment: {
              credentialBindings: [
                { service: "calendar", bindingId: "binding-1", future: true },
              ],
            },
          },
        } as never,
        harness.identity,
        harness.identity,
      ),
    ).toThrow("unknown");

    expect(() =>
      validateTranscriptRunRecord({
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [pollutedMessage],
      } as never),
    ).toThrow("unknown");
    expect(() =>
      validateTranscriptRunRecord({
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-use-noncanonical",
                name: "write-file",
                input: { nested: new Date(NOW) },
              },
            ],
          },
        ],
      } as never),
    ).toThrow("canonical JSON");
    expect(() =>
      validateStagedMutationRecord({
        v: 1,
        t: "staged-mutation",
        seq: 1,
        domain: "global",
        requestId: "polluted-workscene",
        mutation: { kind: "workscene-create", name: "scene", workspace: false },
      }),
    ).toThrow("plain object");
    expect(() =>
      createConversationSealedBundle({
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        dependencyArtifacts: [],
        body: {
          t: "conversation",
          runId: RUN_ID,
          conversationId: CONVERSATION_ID,
          ownerEpoch: 3,
          baseRevision: 7,
          runRecord: {
            type: "run",
            runId: RUN_ID,
            runIndex: 8,
            timestamp: NOW,
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          },
          contentAssets: [],
          mutationBatch: false,
        } as never,
      }),
    ).toThrow("Mutation batch summary");
    expect(() =>
      validateAssignmentEntry(
        {
          recordSeq: 1,
          body: {
            v: 1,
            t: "bundle_sealed",
            bundle: { ref: dispatchEnvelopeArtifact(harness.dispatch.envelope).ref },
            mutationBatch: false,
          } as never,
        },
        harness.identity,
      ),
    ).toThrow("mutation batch container");
    expect(() =>
      validateConversationEnvelope(harness.dispatch.envelope, harness.identity),
    ).not.toThrow();
  });

  it("fails closed on wrong-version or polluted executor ledger and response contracts", async () => {
    const validationHarness = await createHarness();
    expect(() =>
      validateAssignmentEntry(
        {
          recordSeq: 1,
          body: {
            v: 1,
            t: "staged-mutation",
            seq: 1,
            domain: "session",
            requestId: "invalid-nested-mutation",
            mutation: { kind: "future-session-mutation" },
          },
        },
        validationHarness.identity,
      ),
    ).toThrow("closed union");
    for (const invalidBody of [
      { v: 2, t: "started" },
      {
        v: 1,
        t: "supersede-fenced",
        fenceSeq: 1,
        requestId: "future-request",
        futureField: true,
      },
    ]) {
      const executorReplay = await createHarness();
      await executorReplay.log.append([
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: { recordSeq: 1, body: invalidBody } as never,
        },
      ]);
      await expect(
        executorReplay.ledger.queryLedger(
          ASSIGNMENT_ID,
          ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        ),
      ).rejects.toThrow();
    }

    const owner = await createHarness();
    expect(() =>
      owner.journal.validateExecutorDispatchResult({
        v: 1,
        accepted: true,
        futureField: true,
      } as never),
    ).toThrow("Accepted dispatch result");
    expect(() =>
      owner.journal.validateExecutorDispatchResult({
        v: 2,
        accepted: true,
      } as never),
    ).toThrow("version must be 1");
    await expect(
      owner.journal.reconcileStarted(ASSIGNMENT_ID, {
        v: 1,
        assignmentId: ASSIGNMENT_ID,
        phase: "started",
        lastSeq: 2,
        futureField: true,
      } as never),
    ).rejects.toThrow("Ledger snapshot");
    expect(await owner.journal.currentState(RUN_ID)).toBe("dispatched");
  });

  it("rejects every incomplete atomic closure for conflict and uncertain resolution", async () => {
    const ackedConflict = await createHarness();
    const ackedAlternative = createAlternativeDispatch(ackedConflict);
    await ackedConflict.ledger.dispatch(
      ackedConflict.dispatch.envelope,
      ackedConflict.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const ackedResult = await ackedConflict.ledger.dispatch(
      ackedAlternative.envelope,
      ackedAlternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (ackedResult.accepted || ackedResult.outcome !== "conflicting-redelivery") {
      throw new Error("expected owner-authoritative conflict");
    }
    await ackedConflict.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "dispatch-conflict",
          assignmentId: ASSIGNMENT_ID,
          proof: ackedResult.proof,
          handling: "acked-original",
        },
      },
    ]);
    await expect(ackedConflict.journal.currentState(RUN_ID)).rejects.toThrow(
      "incomplete",
    );

    const openedConflict = await createHarness();
    const openedAlternative = createAlternativeDispatch(openedConflict);
    await openedConflict.ledger.dispatch(
      openedAlternative.envelope,
      openedAlternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const openedResult = await openedConflict.ledger.dispatch(
      openedConflict.dispatch.envelope,
      openedConflict.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (openedResult.accepted || openedResult.outcome !== "conflicting-redelivery") {
      throw new Error("expected mismatched conflict");
    }
    await openedConflict.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "dispatch-conflict",
          assignmentId: ASSIGNMENT_ID,
          proof: openedResult.proof,
          handling: "opened-uncertain",
        },
      },
    ]);
    await expect(openedConflict.journal.currentState(RUN_ID)).rejects.toThrow(
      "incomplete",
    );

    for (const decision of [
      {
        kind: "proven-not-started-redispatched" as const,
        by: EXECUTOR_ID,
        state: "queued" as const,
        expected: "missing its atomic authority facts",
      },
      {
        kind: "user-abandoned" as const,
        by: "surface:user-1",
        state: "cancelled" as const,
        expected: "missing its atomic authority facts",
      },
    ]) {
      const incompleteResolution = await createHarness();
      const fact = await incompleteResolution.journal.markAssignmentUncertain(
        ASSIGNMENT_ID,
        "ledger-unknown",
      );
      const resolution = {
        kind: decision.kind,
        by: decision.by,
        at: NOW,
        factDigest: protocolDigest("UncertainResolutionDecision", 1, {
          openFactDigest: fact.openFactDigest,
          kind: decision.kind,
          by: decision.by,
          at: NOW,
        }),
      };
      await incompleteResolution.log.append([
        {
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "resolution",
            runId: RUN_ID,
            fact: { ...fact, resolution },
          },
        },
        ...incompleteResolution.unsigned.capabilities.map((capability) => ({
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "capability-revoked" as const,
            capId: capability.capId,
            assignmentId: ASSIGNMENT_ID,
          },
        })),
        {
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "state",
            runId: RUN_ID,
            assignmentId: ASSIGNMENT_ID,
            state: decision.state,
            statusRevision: 4,
          },
        },
      ]);
      await expect(
        incompleteResolution.journal.currentState(RUN_ID),
      ).rejects.toThrow(decision.expected);
    }

    const wrongApplied = await createHarness();
    const fact = await wrongApplied.journal.markAssignmentUncertain(
      ASSIGNMENT_ID,
      "ledger-unknown",
    );
    const resolution = {
      kind: "user-abandoned" as const,
      by: "surface:user-1",
      at: NOW,
      factDigest: protocolDigest("UncertainResolutionDecision", 1, {
        openFactDigest: fact.openFactDigest,
        kind: "user-abandoned",
        by: "surface:user-1",
        at: NOW,
      }),
    };
    const authorityRevision =
      ((await wrongApplied.log.readAll()).at(-1)?.lsn ?? 0) + 1;
    await wrongApplied.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "resolution",
          runId: RUN_ID,
          fact: { ...fact, resolution },
        },
      },
      ...wrongApplied.unsigned.capabilities.map((capability) => ({
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked" as const,
          capId: capability.capId,
          assignmentId: ASSIGNMENT_ID,
        },
      })),
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "cancelled",
          statusRevision: 4,
        },
      },
      {
        stream: "control",
        body: {
          t: "applied",
          requestId: "unrelated-resolution",
          authorityRevision,
          result: {
            v: 1,
            status: "ok",
            body: {
              t: "uncertain-resolve",
              state: "cancelled",
              factDigest: fact.openFactDigest,
            },
          },
        },
      },
    ]);
    await expect(wrongApplied.journal.currentState(RUN_ID)).rejects.toThrow(
      "missing its atomic authority facts",
    );
  }, 15_000);

  it("requires complete sidecars and capability revocations for conversation commit", async () => {
    const incomplete = await createHarness();
    await incomplete.ledger.dispatch(
      incomplete.dispatch.envelope,
      incomplete.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await incomplete.ledger.start(ASSIGNMENT_ID);
    const incompleteBundle = await sealDefaultBundle(incomplete.ledger);
    await incomplete.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "committed",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          bundle: { ref: sealedBundleArtifact(incompleteBundle).ref },
          commitRevision: incompleteBundle.body.baseRevision + 1,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "committed",
          statusRevision: 3,
        },
      },
    ]);
    await expect(
      incomplete.journal.submitBundle(
        incompleteBundle,
        submissionContext(incomplete.unsigned),
      ),
    ).rejects.toThrow("Committed run replay contract");
    await expect(incomplete.journal.currentState(RUN_ID)).rejects.toThrow(
      "Committed run replay contract",
    );

    const missingBaseSidecars = await createHarness();
    await missingBaseSidecars.ledger.dispatch(
      missingBaseSidecars.dispatch.envelope,
      missingBaseSidecars.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await missingBaseSidecars.ledger.start(ASSIGNMENT_ID);
    const sidecarlessBundle = await sealDefaultBundle(missingBaseSidecars.ledger);
    await missingBaseSidecars.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "committed",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          bundle: { ref: sealedBundleArtifact(sidecarlessBundle).ref },
          commitRevision: sidecarlessBundle.body.baseRevision + 1,
        },
      },
      ...missingBaseSidecars.unsigned.capabilities.map((capability) => ({
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked" as const,
          capId: capability.capId,
          assignmentId: ASSIGNMENT_ID,
        },
      })),
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "committed",
          statusRevision: 3,
        },
      },
    ]);
    await expect(
      missingBaseSidecars.journal.submitBundle(
        sidecarlessBundle,
        submissionContext(missingBaseSidecars.unsigned),
      ),
    ).rejects.toThrow("content sidecar");
    await expect(
      missingBaseSidecars.journal.currentState(RUN_ID),
    ).rejects.toThrow("missing its content, publish, or final sidecars");

    const missingPublish = await createHarness();
    await missingPublish.ledger.dispatch(
      missingPublish.dispatch.envelope,
      missingPublish.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await missingPublish.ledger.start(ASSIGNMENT_ID);
    await missingPublish.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "session",
      requestId: "missing-publish-sidecars",
      mutation: {
        kind: "task-list-op",
        op: {
          op: "set",
          state: {
            items: [{ id: "task-sidecar", content: "ship", status: "pending" }],
          },
        },
      },
    });
    const missingPublishBundle = await sealDefaultBundle(missingPublish.ledger);
    const missingPublishRevision = missingPublishBundle.body.baseRevision + 1;
    await missingPublish.log.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "committed",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          bundle: { ref: sealedBundleArtifact(missingPublishBundle).ref },
          commitRevision: missingPublishRevision,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          kind: "content-asset-index",
          entries: missingPublishBundle.body.contentAssets,
        },
      },
      ...missingPublish.unsigned.capabilities.map((capability) => ({
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked" as const,
          capId: capability.capId,
          assignmentId: ASSIGNMENT_ID,
        },
      })),
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "committed",
          statusRevision: 3,
        },
      },
      {
        stream: "final-outbox",
        body: {
          t: "final",
          conversationId: CONVERSATION_ID,
          runId: RUN_ID,
          commitRevision: missingPublishRevision,
          digest: missingPublishBundle.digest,
          state: "pending",
        },
      },
    ]);
    await expect(
      missingPublish.journal.submitBundle(
        missingPublishBundle,
        submissionContext(missingPublish.unsigned),
      ),
    ).rejects.toThrow("durable sidecars");
    await expect(missingPublish.journal.currentState(RUN_ID)).rejects.toThrow(
      "missing its content, publish, or final sidecars",
    );

    const complete = await createHarness();
    await complete.ledger.dispatch(
      complete.dispatch.envelope,
      complete.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await complete.ledger.start(ASSIGNMENT_ID);
    const bundle = await sealDefaultBundle(complete.ledger);
    await expect(
      complete.journal.submitBundle(bundle, submissionContext(complete.unsigned)),
    ).resolves.toMatchObject({ committed: true });
    const committed = (await complete.log.readAll()).find((envelope) =>
      envelope.entries.some(
        (entry) =>
          entry.stream === `run:${CONVERSATION_ID}` &&
          (entry.body as { readonly t?: string }).t === "committed",
      ),
    );
    expect(
      committed?.entries.some(
        (entry) =>
          entry.stream === `run:${CONVERSATION_ID}` &&
          (entry.body as { readonly t?: string }).t === "capability-revoked",
      ),
    ).toBe(true);
  }, 15_000);

  it("rejects incomplete historical commit fences and conflict late-bundle closures", async () => {
    for (const variant of ["executor", "owner-epoch"] as const) {
      const harness = await createHarness();
      await harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      await harness.ledger.start(ASSIGNMENT_ID);
      const valid = await sealDefaultBundle(harness.ledger);
      const { v: _version, digest: _digest, ...payload } = valid;
      const invalid = createConversationSealedBundle({
        ...payload,
        ...(variant === "executor" ? { executorId: "executor-foreign" } : {}),
        body: {
          ...valid.body,
          ...(variant === "owner-epoch" ? { ownerEpoch: 4 } : {}),
        },
      });
      await harness.artifacts.put(sealedBundleArtifact(invalid).bytes);
      await appendCompleteConversationCommit(harness, invalid, 3, true);

      await expect(
        reopenJournal(harness).submitBundle(
          invalid,
          submissionContext(harness.unsigned),
        ),
      ).rejects.toThrow("durable assignment fence");
      await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
        "historical assignment fence",
      );
    }

    const conflicted = await createHarness();
    const alternative = createAlternativeDispatch(conflicted);
    await conflicted.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await conflicted.ledger.start(ASSIGNMENT_ID);
    const conflict = await conflicted.ledger.dispatch(
      conflicted.dispatch.envelope,
      conflicted.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected mismatched conflict");
    }
    await conflicted.journal.recordDispatchConflict(conflicted.dispatch, conflict);
    const bundle = await sealDefaultBundle(conflicted.ledger);
    const fact = await conflicted.journal.currentResolution(RUN_ID);
    if (!fact || fact.cause !== "dispatch-conflict") {
      throw new Error("dispatch conflict resolution fact missing");
    }
    const resolution = {
      kind: "late-bundle-committed" as const,
      by: EXECUTOR_ID,
      at: NOW,
      factDigest: protocolDigest("UncertainResolutionDecision", 1, {
        openFactDigest: fact.openFactDigest,
        kind: "late-bundle-committed",
        by: EXECUTOR_ID,
        at: NOW,
      }),
    };
    await appendCompleteConversationCommit(conflicted, bundle, 4, false, {
      ...fact,
      resolution,
    });
    await expect(
      reopenJournal(conflicted).submitBundle(
        bundle,
        submissionContext(conflicted.unsigned),
      ),
    ).rejects.toThrow("Committed run replay contract");
    await expect(conflicted.journal.currentState(RUN_ID)).rejects.toThrow(
      "Committed run replay contract",
    );
  }, 15_000);

  it("recovers a cancelled run from a dispatch rejection whose response was lost", async () => {
    const harness = await createHarness();
    const badPayload = {
      ...withoutSignature(harness.dispatch.activation),
      manifestDigest: SHA256_ZERO,
    };
    const badActivation: AssignmentActivationProof<"conversation"> = {
      ...badPayload,
      signature: harness.identity.sign("AssignmentActivationProof", 1, badPayload),
    };
    const rejected = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      badActivation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    expect(rejected).toMatchObject({
      accepted: false,
      outcome: "rejected-before-received",
    });
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-dispatch-rejection",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await expect(
      harness.ledger.cancel(
        ASSIGNMENT_ID,
        cancellation.fence,
        ownerContext(ASSIGNMENT_ID, "executor.cancel"),
      ),
    ).resolves.toBeUndefined();

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    expect(await dispatcher.recoverCancellationProofs()).toBe(1);
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("halts a running assignment only after every side effect closes", async () => {
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
    const effect = await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "external-call",
      toolName: "calendar.create",
      summary: "create calendar event",
      target: "external-service",
    });
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-running",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    expect(await harness.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();
    await expect(
      harness.ledger.startSideEffect(ASSIGNMENT_ID, {
        kind: "external-call",
        toolName: "calendar.delete",
        summary: "delete calendar event",
        target: "external-service",
      }),
    ).rejects.toThrow("active, unfenced");

    await harness.ledger.completeSideEffect(ASSIGNMENT_ID, effect.effectSeq, {
      status: "ok",
      resultDigest: SHA256_ZERO,
    });
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({ decision: "halted", lastEffectSeq: 1 });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("replays completed interaction and mutation requests after cancellation fences new work", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "interaction-before-cancel",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const outcome = {
      t: "answered" as const,
      authority: { via: "surface-ticket" as const, ticketId: "ticket-before-cancel" },
      decision: { allowed: true },
      decisionDigest: allowOnceDecisionDigest("interaction-before-cancel"),
      by: "surface:user-1",
    };
    const finished = await harness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "interaction-before-cancel",
      outcome,
    );
    const mutation = {
      domain: "session" as const,
      requestId: "mutation-before-cancel",
      mutation: {
        kind: "task-list-op" as const,
        op: {
          op: "set" as const,
          state: { items: [{ id: "task-before-cancel", content: "ship", status: "pending" as const }] },
        },
      },
    };
    const staged = await harness.ledger.stageMutation(ASSIGNMENT_ID, mutation);
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-results",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );

    await expect(
      harness.ledger.finishInteraction(
        ASSIGNMENT_ID,
        "interaction-before-cancel",
        outcome,
      ),
    ).resolves.toEqual(finished);
    await expect(harness.ledger.stageMutation(ASSIGNMENT_ID, mutation)).resolves.toEqual(staged);
  });

  it("rejects sealing while a side effect is open in both producer and replay", async () => {
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
    await expect(sealDefaultBundle(harness.ledger)).rejects.toThrow(
      "open side effect",
    );

    const corruptBundle = await harness.artifacts.put(Buffer.from("corrupt-bundle"));
    await harness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: 4,
          body: {
            v: 1,
            t: "bundle_sealed",
            bundle: { ref: corruptBundle },
          },
        },
      },
    ]);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("bundle_sealed has no started prefix");
  });

  it.each(["received", "dispatch-rejected"] as const)(
    "rejects a late %s record after an abort fence during replay",
    async (kind) => {
      const harness = await createHarness();
      const cancellation = await harness.journal.cancelRun({
        runId: RUN_ID,
        requestId: `abort-before-${kind}`,
      });
      if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
      const artifact = dispatchEnvelopeArtifact(harness.dispatch.envelope);
      const lateBody: AssignmentEntry["body"] =
        kind === "received"
          ? {
              v: 1,
              t: "received",
              envelope: { ref: artifact.ref },
              activation: harness.dispatch.activation,
            }
          : {
              v: 1,
              t: "dispatch-rejected",
              dispatchDigest: dispatchEnvelopeDigest(harness.dispatch.envelope),
              reason: {
                code: "fence-rejected",
                retryable: false,
                message: "Dispatch was fenced before receipt",
              },
            };
      await harness.log.append<AssignmentEntry>([
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: {
            recordSeq: 1,
            body: {
              v: 1,
              t: "abort-requested",
              via: "owner-fence",
              refId: cancellation.fence.requestId,
            },
          },
        },
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: { recordSeq: 2, body: lateBody },
        },
      ]);

      await expect(
        harness.ledger.queryLedger(
          ASSIGNMENT_ID,
          ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        ),
      ).rejects.toThrow("is not the first record");
    },
  );

  it("rejects sealing with a pending interaction during replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "pending-at-seal",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await expect(sealDefaultBundle(harness.ledger)).rejects.toThrow(
      "before every pending interaction is closed",
    );
    const corruptBundle = await harness.artifacts.put(Buffer.from("pending-bundle"));
    await harness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: 4,
          body: { v: 1, t: "bundle_sealed", bundle: { ref: corruptBundle } },
        },
      },
    ]);

    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("bundle_sealed has no started prefix");
  });

  it("rejects terminal records until every finished interaction is mirrored", async () => {
    const sealHarness = await createHarness();
    await sealHarness.ledger.dispatch(
      sealHarness.dispatch.envelope,
      sealHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await sealHarness.ledger.start(ASSIGNMENT_ID);
    await sealHarness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "unmirrored-at-seal",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await sealHarness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "unmirrored-at-seal",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "seal-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("unmirrored-at-seal"),
        by: "surface:user-1",
      },
    );
    await expect(sealDefaultBundle(sealHarness.ledger)).rejects.toThrow(
      "before every finished interaction is mirrored",
    );
    const corruptBundle = await sealHarness.artifacts.put(
      Buffer.from("unmirrored-bundle"),
    );
    await sealHarness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: 5,
          body: { v: 1, t: "bundle_sealed", bundle: { ref: corruptBundle } },
        },
      },
    ]);
    await expect(
      sealHarness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("bundle_sealed has no started prefix");

    const haltHarness = await createHarness();
    await haltHarness.ledger.dispatch(
      haltHarness.dispatch.envelope,
      haltHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await haltHarness.ledger.start(ASSIGNMENT_ID);
    await haltHarness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "unmirrored-at-halt",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await haltHarness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "unmirrored-at-halt",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "halt-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("unmirrored-at-halt"),
        by: "surface:user-1",
      },
    );
    const cancellation = await haltHarness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "halt-with-unmirrored-interaction",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await expect(
      haltHarness.ledger.cancel(
        ASSIGNMENT_ID,
        cancellation.fence,
        ownerContext(ASSIGNMENT_ID, "executor.cancel"),
      ),
    ).resolves.toBeUndefined();
    await expect(haltHarness.ledger.cancelProof(ASSIGNMENT_ID)).resolves.toBeUndefined();
    const page = await haltHarness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
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
        cause: "owner-fence",
        fence: cancellation.fence,
        decision: "halted",
        lastEffectSeq: 0,
        lastRecordSeq: page.toSeq,
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        ledgerDigest: page.chainDigest,
        issuedAt: NOW,
      },
      haltHarness.identity,
    );
    await haltHarness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: page.toSeq + 1,
          body: { v: 1, t: "halted", proof },
        },
      },
    ]);
    await expect(
      haltHarness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("halted does not close the durable cancellation prefix");
  });

  it("rejects halting with a pending interaction during replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "pending-at-halt",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "halt-with-pending-interaction",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
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
        via: "owner-fence",
        refId: cancellation.fence.requestId,
      },
    };
    const abortDigest = advanceAssignmentLedger(page.chainDigest, abort);
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
        cause: "owner-fence",
        fence: cancellation.fence,
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
          body: { v: 1, t: "halted", proof },
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

  it("rejects a second freshly signed halted terminal during replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "duplicate-halted-terminal",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const original = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!original) throw new Error("cancel proof missing");
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
    const duplicate = signCancelProof(
      {
        ...withoutSignature(original),
        lastRecordSeq: snapshot.lastSeq,
        ledgerDigest: page.chainDigest,
      },
      harness.identity,
    );
    await harness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: snapshot.lastSeq + 1,
          body: { v: 1, t: "halted", proof: duplicate },
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

  it("keeps a late halted proof as evidence when cancellation was already uncertain", async () => {
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
    const effect = await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "tool-mutation",
      toolName: "write",
      summary: "write workspace file",
      target: "workspace-file",
    });
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-unproven",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "cancel-unproven");
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);

    await harness.ledger.completeSideEffect(ASSIGNMENT_ID, effect.effectSeq, {
      status: "aborted",
    });
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const contradictory = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictory,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictory,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("accepts an abort-ticket not-started proof during owner recovery", async () => {
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
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({ cause: "abort-ticket", decision: "not-started" });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("accepts an abort-ticket halted proof for a running assignment", async () => {
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
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({ cause: "abort-ticket", decision: "halted" });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
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
    await harness.log.append([
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
  }, 20_000);

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
  });

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
    await harness.log.append([
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
    ).rejects.toThrow("revoked capability cannot perform an active submission");
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
  });

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
  }, 15_000);

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
    });
    expect(await restarted.pendingInteractionMirrors(ASSIGNMENT_ID)).toEqual([]);
    expect(firstReceipt).toEqual(mirrorReceipt(firstBatch));
  }, 15_000);

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
    await duplicate.log.append([
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
    await unfenced.log.append([
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
      "outside its authorized state",
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
    await terminal.log.append([
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
  }, 15_000);

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
  }, 15_000);

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
    const forgedContext: AuthorityCallContext = {
      ...validContext,
      principal: {
        kind: "assignment",
        capability: {
          ...validContext.principal.capability,
          capId: "unactivated-capability",
        },
      },
    };
    counted!.resetReads();
    await expect(
      activated.journal.reportStarted(ASSIGNMENT_ID, forgedContext),
    ).rejects.toThrow("not activated by the durable assignment");
    await expect(
      activated.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        {} as ConversationInteractionMirrorBatch,
        forgedContext,
      ),
    ).rejects.toThrow("not activated by the durable assignment");
    await expect(
      activated.journal.submitCancelProof(
        ASSIGNMENT_ID,
        {} as CancelProofBody,
        forgedContext,
      ),
    ).rejects.toThrow("not activated by the durable assignment");
    await expect(
      activated.journal.submitBundle({} as SealedBundle, forgedContext),
    ).rejects.toThrow("not activated by the durable assignment");
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
  }, 15_000);

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
    counted = new CountingArtifactStore(committed.artifacts);
    const coldCommitted = reopenJournal(committed, { artifacts: counted });
    counted.resetReads();
    await expect(
      coldCommitted.submitBundle(bundle, submissionContext(committed.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(counted.reads).toBe(0);
    const transferredCommitted = reopenJournal(committed, {
      ownerEpoch: 4,
      artifacts: counted,
    });
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
  }, 15_000);

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
    ).rejects.toThrow("does not match its durable assignment fence");
    await expect(
      cold.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
  }, 15_000);

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
    await harness.log.append([
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
  }, 15_000);

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
    await harness.log.append([
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
  }, 15_000);

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
    await started.log.append([
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
    await unfenced.log.append([
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
  }, 15_000);

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

    const pollutedEntries = page.entries.map((entry, index) => {
      if (index !== 0 || "ref" in entry.body || entry.body.t !== "received") return entry;
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
    await harness.log.append([
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

function createUnsignedEnvelope(
  identity: TestProtocolIdentity,
  ids: {
    readonly runId?: string;
    readonly assignmentId?: string;
    readonly conversationId?: string;
    readonly ingress?: IngressContext;
  } = {},
): UnsignedConversationEnvelope {
  const runId = ids.runId ?? RUN_ID;
  const assignmentId = ids.assignmentId ?? ASSIGNMENT_ID;
  const conversationId = ids.conversationId ?? CONVERSATION_ID;
  const manifestWithoutDigest = {
    v: 1 as const,
    baseRef: {
      execution: "conversation" as const,
      conversationId,
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
    protocolVersion: "1",
    tools: [],
    mcpServers: [],
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
    snapshotDigest: createSignedTrustRuleSnapshot(
      { snapshotVersion: 1, rules: [], generatedAt: NOW },
      identity,
    ).digest,
    binding: {
      execution: "conversation" as const,
      runId,
      conversationId,
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
    scope: { execution: "conversation" as const, conversationId },
    ownerEpoch: 3,
    methods: [
      "submission.mirrorInteractions",
      "submission.reportStarted",
      "submission.submitBundle",
      "submission.submitCancelProof",
    ] as AuthorityCapability<"conversation">["methods"],
    resources: [`conversation:${conversationId}`] as AuthorityCapability<"conversation">["resources"],
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
      conversationId,
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
      conversationId,
      ownerEpoch: 3,
      baseRevision: 7,
      ingress: ids.ingress ?? ingress(),
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
  method:
    | "executor.dispatch"
    | "executor.queryLedger"
    | "executor.cancel"
    | "executor.supersede",
  conversationId: string = CONVERSATION_ID,
): AuthorityCallContext {
  return {
    principal: {
      kind: "owner-control",
      grant: {
        v: 1,
        assignmentId,
        scope: { execution: "conversation", conversationId, ownerEpoch: 3 },
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

function trustedControlSource() {
  return {
    principal: {
      surfacePrincipal: "surface:user-1",
      deviceId: "device-1",
      connectionId: "connection-1",
    },
  };
}

async function applyResolutionControl(
  harness: Awaited<ReturnType<typeof createHarness>>,
  input: {
    readonly requestId: string;
    readonly openFactDigest: string;
    readonly decision:
      | "user-verified-side-effects"
      | "user-abandoned"
      | "user-retry-acknowledged";
  },
) {
  const source = trustedControlSource();
  const envelope = createConversationControlEnvelope({
    requestId: input.requestId,
    source,
    at: NOW,
    body: {
      t: "uncertain-resolve",
      ref: {
        execution: "conversation",
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        ownerEpoch: 3,
      },
      openFactDigest: input.openFactDigest,
      decision: input.decision,
    },
  });
  return harness.journal.applyControl({
    admission: harness.control,
    envelope,
    source,
  });
}

async function applyCancelControl(
  harness: Awaited<ReturnType<typeof createHarness>>,
  requestId: string,
) {
  const source = trustedControlSource();
  const envelope = createConversationControlEnvelope({
    requestId,
    source,
    at: NOW,
    body: {
      t: "cancel",
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      ownerEpoch: 3,
    },
  });
  return harness.journal.applyControl({
    admission: harness.control,
    envelope,
    source,
  });
}

async function replaceAssignmentAfterUncertain(
  harness: Awaited<ReturnType<typeof createHarness>>,
  cause: "ledger-unknown" | "cancel-unproven",
  requestId: string,
) {
  const fact = await harness.journal.markAssignmentUncertain(
    ASSIGNMENT_ID,
    cause,
  );
  await applyResolutionControl(harness, {
    requestId,
    openFactDigest: fact.openFactDigest,
    decision: "user-retry-acknowledged",
  });
  const unsigned = createUnsignedEnvelope(harness.identity, {
    assignmentId: "assignment-2",
  });
  const dispatch = await harness.journal.assign(unsigned);
  return { unsigned, dispatch };
}

async function storedAssignmentFact(
  harness: Awaited<ReturnType<typeof createUnassignedHarness>>,
  unsigned: UnsignedConversationEnvelope,
) {
  const envelope = createSignedConversationEnvelope(
    unsigned,
    harness.identity,
    harness.identity,
  );
  const artifact = dispatchEnvelopeArtifact(envelope);
  const stored = await harness.artifacts.put(artifact.bytes);
  expect(stored).toEqual(artifact.ref);
  return {
    envelope,
    record: {
      t: "assigned" as const,
      runId: envelope.work.runId,
      assignmentId: envelope.assignmentId,
      executorId: envelope.executorId,
      ownerEpoch: envelope.work.ownerEpoch,
      baseRevision: envelope.work.baseRevision,
      dispatchDigest: dispatchEnvelopeDigest(envelope),
      manifestDigest: envelope.manifest.digest,
      dispatchRef: artifact.ref,
      permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
      capIds: envelope.capabilities.map((capability) => capability.capId),
      reservation: {
        reservationId: envelope.resourceLease.reservationId,
        attempt: envelope.resourceLease.workload.attempt,
      },
    },
  };
}

async function appendCompleteConversationCommit(
  harness: Awaited<ReturnType<typeof createHarness>>,
  bundle: ReturnType<typeof createConversationSealedBundle>,
  statusRevision: number,
  revokeCapabilities: boolean,
  resolutionFact?: NonNullable<
    Awaited<ReturnType<ConversationRunJournal["currentResolution"]>>
  >,
) {
  const commitRevision = bundle.body.baseRevision + 1;
  await harness.log.append([
    {
      stream: `run:${CONVERSATION_ID}`,
      body: {
        t: "committed",
        runId: RUN_ID,
        assignmentId: ASSIGNMENT_ID,
        bundle: { ref: sealedBundleArtifact(bundle).ref },
        commitRevision,
      },
    },
    {
      stream: `run:${CONVERSATION_ID}`,
      body: { kind: "content-asset-index", entries: bundle.body.contentAssets },
    },
    ...(revokeCapabilities
      ? harness.unsigned.capabilities.map((capability) => ({
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "capability-revoked" as const,
            assignmentId: ASSIGNMENT_ID,
            capId: capability.capId,
          },
        }))
      : []),
    {
      stream: `run:${CONVERSATION_ID}`,
      body: {
        t: "state",
        runId: RUN_ID,
        assignmentId: ASSIGNMENT_ID,
        state: "committed",
        statusRevision,
      },
    },
    ...(resolutionFact
      ? [
          {
            stream: `run:${CONVERSATION_ID}`,
            body: { t: "resolution" as const, runId: RUN_ID, fact: resolutionFact },
          },
        ]
      : []),
    {
      stream: "final-outbox",
      body: {
        t: "final",
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        commitRevision,
        digest: bundle.digest,
        state: "pending",
      },
    },
  ]);
}

async function sealDefaultBundle(
  ledger: ConversationAssignmentLedger,
  assistantText?: string,
) {
  return ledger.sealConversationBundle(ASSIGNMENT_ID, {
    runRecord: {
      type: "run",
      runId: RUN_ID,
      runIndex: 8,
      timestamp: NOW,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        ...(assistantText === undefined
          ? []
          : [{ role: "assistant" as const, content: [{ type: "text" as const, text: assistantText }] }]),
      ],
    },
    contentAssets: [],
    streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
  });
}

function createAlternativeDispatch(
  harness: Awaited<ReturnType<typeof createHarness>>,
  issuedAt = "2026-07-13T09:00:01.000Z",
) {
  const envelope = createSignedConversationEnvelope(
    {
      ...harness.unsigned,
      issuedAt,
    },
    harness.identity,
    harness.identity,
  );
  const expectedPayload = withoutSignature(harness.dispatch.activation);
  const payload = buildConversationActivationPayload({
    envelope,
    dispatchRef: dispatchEnvelopeArtifact(envelope).ref,
    commit: expectedPayload.commit,
    issuedAt: expectedPayload.issuedAt,
  });
  return {
    assignmentId: ASSIGNMENT_ID,
    envelope,
    activation: signConversationActivation(payload, harness.identity),
  };
}

function createCancellationSubmission(
  harness: Awaited<ReturnType<typeof createHarness>>,
  journal: ConversationRunJournal = harness.journal,
) {
  const adapter = new InProcessAssignmentSubmission({
    ledger: harness.ledger,
    owner: journal,
  });
  return {
    submitCancellation(assignmentId: string) {
      return adapter.submitCancellation(
        assignmentId,
        submissionContext(harness.unsigned),
      );
    },
  };
}

function createBundleSubmission(
  harness: Awaited<ReturnType<typeof createHarness>>,
  journal: ConversationRunJournal = harness.journal,
) {
  const adapter = new InProcessAssignmentSubmission({
    ledger: harness.ledger,
    owner: journal,
  });
  return {
    submitSealedBundle(assignmentId: string) {
      return adapter.submitSealedBundle(
        assignmentId,
        submissionContext(harness.unsigned),
      );
    },
  };
}

function reopenJournal(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: {
    readonly ownerEpoch?: number;
    readonly artifacts?: ArtifactStore;
    readonly submission?: AssignmentSubmissionAuthorizer;
  } = {},
): ConversationRunJournal {
  const artifacts = options.artifacts ?? harness.artifacts;
  return new ConversationRunJournal({
    conversationId: CONVERSATION_ID,
    ownerEpoch: options.ownerEpoch ?? 3,
    log: new FileAuthorityCommitLog(harness.log.rootDir, artifacts, {
      clock: () => NOW,
      lockWaitMs: 2_000,
    }),
    artifacts,
    signer: harness.identity,
    verifier: harness.identity,
    delivery: deliveryParticipant(harness.log),
    submission: options.submission ?? submission,
    authority: harness.authority,
    projection: harness.projection,
    abortTickets: {
      authorize(input) {
        if (
          input.assignmentId !== ASSIGNMENT_ID ||
          input.executorId !== EXECUTOR_ID ||
          input.ticketDigest !== ABORT_TICKET_DIGEST ||
          input.surfacePrincipal !== "surface:user-1"
        ) {
          throw new Error("abort ticket authorization failed");
        }
      },
    },
  });
}

function withoutSignature<T extends { signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return JSON.parse(canonicalize(payload)) as Omit<T, "signature">;
}

type ConversationBehaviorRecordType =
  | ConversationRunRecordType
  | (typeof CONVERSATION_RUN_INTERNAL_RECORD_TYPES)[number];

type ConversationBehaviorScenarioId =
  | "commit"
  | "sessionLifecycle"
  | "mirror"
  | "cancelHalted"
  | "cancelUncertainContained"
  | "supersedeStarted"
  | "supersedeNotStarted"
  | "conflictContained"
  | "conflictAcked"
  | "uncertainRejected"
  | "commitProjection";

interface ConversationBehaviorHarness {
  readonly log: FileAuthorityCommitLog;
  readonly fullProbe: () => Promise<unknown>;
  readonly guardProbe?: () => Promise<unknown>;
}

interface ConversationRecordBehaviorSpec {
  readonly scenario: ConversationBehaviorScenarioId;
  readonly corrupt?: (body: Record<string, unknown>) => Record<string, unknown>;
  readonly recovery: ConversationRecoveryExpectation;
}

function conversationBehaviorHarness(
  harness: Awaited<ReturnType<typeof createHarness>>,
): ConversationBehaviorHarness {
  return {
    log: harness.log,
    fullProbe: () => reopenJournal(harness).currentState(RUN_ID),
    guardProbe: () =>
      reopenJournal(harness).reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
  };
}

async function receiveConversation(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  await harness.ledger.dispatch(
    harness.dispatch.envelope,
    harness.dispatch.activation,
    ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
  );
}

async function startConversation(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  await receiveConversation(harness);
  await harness.ledger.start(ASSIGNMENT_ID);
  await harness.journal.reportStarted(
    ASSIGNMENT_ID,
    submissionContext(harness.unsigned),
  );
}

const CONVERSATION_BEHAVIOR_SCENARIOS: Record<
  ConversationBehaviorScenarioId,
  () => Promise<ConversationBehaviorHarness>
> = {
  async sessionLifecycle() {
    const harness = await createHarness();
    await startConversation(harness);
    await sealDefaultBundle(harness.ledger);
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const source = trustedControlSource();
    const authority = await harness.journal.authorityState();
    const outcome = await harness.journal.applyControl({
      admission: harness.control,
      envelope: createConversationControlEnvelope({
        requestId: "matrix-session-clear",
        source,
        at: NOW,
        body: {
          t: "session-write",
          conversationId: CONVERSATION_ID,
          mutation: { kind: "window-op", op: "clear" },
          ownerEpoch: 3,
          domainRevision: authority.domainRevision,
        },
      }),
      source,
    });
    if (outcome.kind !== "applied" || outcome.result.status !== "ok") {
      throw new Error("matrix session lifecycle control was rejected");
    }
    await harness.journal.resumeLifecycleProjections(async () => undefined);
    return conversationBehaviorHarness(harness);
  },
  async commit() {
    const harness = await createHarness();
    await startConversation(harness);
    await sealDefaultBundle(harness.ledger);
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, harness.journal),
      bundleSubmission: createBundleSubmission(harness, harness.journal),
    });
    await dispatcher.recoverAssignments();
    return conversationBehaviorHarness(harness);
  },
  async mirror() {
    const harness = await createHarness();
    await startConversation(harness);
    const requestId = "matrix-interaction";
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId,
      toolName: "write",
      display: { title: "confirm", lines: ["write result"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
      t: "auto-resolved",
      decision: "denied",
      reason: "no-interactive-surface",
    });
    const batch = await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID);
    if (!batch) throw new Error("matrix interaction mirror is missing");
    await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      batch,
      submissionContext(harness.unsigned),
    );
    return conversationBehaviorHarness(harness);
  },
  async cancelHalted() {
    const harness = await createHarness();
    await startConversation(harness);
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "matrix-cancel-halted",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix cancel proof missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    return conversationBehaviorHarness(harness);
  },
  async cancelUncertainContained() {
    const harness = await createHarness();
    await startConversation(harness);
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "matrix-cancel-contained",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "cancel-unproven");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix contained proof missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    return conversationBehaviorHarness(harness);
  },
  async supersedeStarted() {
    const harness = await createHarness();
    await receiveConversation(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "matrix-supersede-started",
    );
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.ledger.start(ASSIGNMENT_ID);
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    return conversationBehaviorHarness(harness);
  },
  async supersedeNotStarted() {
    const harness = await createHarness();
    await receiveConversation(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "matrix-supersede-fresh",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    return conversationBehaviorHarness(harness);
  },
  async conflictContained() {
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
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    await harness.ledger.start(ASSIGNMENT_ID);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("matrix conflict fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix conflict proof missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    return conversationBehaviorHarness(harness);
  },
  async conflictAcked() {
    const harness = await createHarness();
    await receiveConversation(harness);
    const alternative = createAlternativeDispatch(harness);
    const conflict = await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.recordDispatchConflict(alternative, conflict);
    return conversationBehaviorHarness(harness);
  },
  async uncertainRejected() {
    const harness = await createHarness();
    await receiveConversation(harness);
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix rejection proof missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    return conversationBehaviorHarness(harness);
  },
  async commitProjection() {
    const harness = await createHarness();
    await startConversation(harness);
    await sealDefaultBundle(harness.ledger);
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    await reopenJournal(harness).resumeCommittedProjections();
    return conversationBehaviorHarness(harness);
  },
};

const CONVERSATION_RECOVERY_PROBES = {
  async dispatchOutbox() {
    const harness = await createHarness();
    expect(await harness.journal.pendingDispatches()).toHaveLength(1);
    await startConversation(harness);
    await expect(reopenJournal(harness).pendingDispatches()).resolves.toEqual([]);
  },
  async cancellationOutbox() {
    const harness = await createHarness();
    await startConversation(harness);
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "matrix-recovery-cancel",
    });
    if (cancelled.state !== "cancel-requested") {
      throw new Error("matrix recovery cancel fence is missing");
    }
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix recovery cancel proof is missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    await expect(reopenJournal(harness).pendingCancellations()).resolves.toEqual([]);
  },
  async conflictCancellation() {
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
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("matrix recovery conflict fence is missing");
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix recovery conflict proof is missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    await expect(reopenJournal(harness).pendingCancellations()).resolves.toEqual([]);
  },
  async supersedeOutbox() {
    const harness = await createHarness();
    await receiveConversation(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "matrix-recovery-supersede",
    );
    expect(await harness.journal.pendingSupersedes()).toHaveLength(1);
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.ledger.start(ASSIGNMENT_ID);
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    await expect(reopenJournal(harness).pendingSupersedes()).resolves.toEqual([]);
  },
  async bundleAcknowledgementOutbox() {
    const harness = await createHarness();
    await startConversation(harness);
    await sealDefaultBundle(harness.ledger);
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(
      (await harness.journal.assignmentsAwaitingRecovery()).some(
        (candidate) => candidate.assignmentId === ASSIGNMENT_ID,
      ),
    ).toBe(true);
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness, harness.journal),
      bundleSubmission: createBundleSubmission(harness, harness.journal),
    });
    await dispatcher.recoverAssignments();
    expect(
      (await reopenJournal(harness).assignmentsAwaitingRecovery()).some(
        (candidate) => candidate.assignmentId === ASSIGNMENT_ID,
      ),
    ).toBe(false);
  },
  async contradictoryProofStop() {
    const harness = await createHarness();
    await receiveConversation(harness);
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("matrix recovery rejection proof is missing");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    await expect(reopenJournal(harness).assignmentsAwaitingRecovery()).resolves.toEqual([]);
  },
  async commitProjection() {
    let failProjection = true;
    const projection: ConversationCommitProjection = {
      async project() {
        if (failProjection) {
          failProjection = false;
          throw new Error("matrix projection crash");
        }
      },
    };
    const harness = await createHarness({ projection });
    await startConversation(harness);
    await sealDefaultBundle(harness.ledger);
    await expect(
      new InProcessAssignmentSubmission({
        ledger: harness.ledger,
        owner: harness.journal,
      }).submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    await expect(harness.journal.resumeCommittedProjections()).rejects.toThrow(
      "matrix projection crash",
    );
    await expect(harness.journal.resumeCommittedProjections()).resolves.toBe(1);
    await expect(harness.journal.resumeCommittedProjections()).resolves.toBe(0);
  },
  async lifecycleProjection() {
    const harness = await createHarness();
    await startConversation(harness);
    await sealDefaultBundle(harness.ledger);
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).submitSealedBundle(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const source = trustedControlSource();
    const authority = await harness.journal.authorityState();
    const outcome = await harness.journal.applyControl({
      admission: harness.control,
      envelope: createConversationControlEnvelope({
        requestId: "matrix-lifecycle-recovery",
        source,
        at: NOW,
        body: {
          t: "session-write",
          conversationId: CONVERSATION_ID,
          mutation: { kind: "window-op", op: "clear" },
          ownerEpoch: 3,
          domainRevision: authority.domainRevision,
        },
      }),
      source,
    });
    if (outcome.kind !== "applied" || outcome.result.status !== "ok") {
      throw new Error("matrix lifecycle recovery control was rejected");
    }
    let failProjection = true;
    await expect(
      harness.journal.resumeLifecycleProjections(async () => {
        if (failProjection) {
          failProjection = false;
          throw new Error("matrix lifecycle projection crash");
        }
      }),
    ).rejects.toThrow("matrix lifecycle projection crash");
    await expect(
      reopenJournal(harness).resumeLifecycleProjections(async () => undefined),
    ).resolves.toBe(1);
    await expect(
      reopenJournal(harness).resumeLifecycleProjections(async () => undefined),
    ).resolves.toBe(0);
  },
} as const;

type ConversationRecoveryProbeId = keyof typeof CONVERSATION_RECOVERY_PROBES;
type ConversationRecoveryExpectation =
  | { readonly kind: "probe"; readonly id: ConversationRecoveryProbeId }
  | { readonly kind: "not-applicable"; readonly reason: string };

const conversationRecovery = (
  id: ConversationRecoveryProbeId,
): ConversationRecoveryExpectation => ({ kind: "probe", id });

const noConversationRecovery = (reason: string): ConversationRecoveryExpectation => ({
  kind: "not-applicable",
  reason,
});

// conversation 域与 job 域同一引擎:每类记录绑定真实生产场景、恢复合同或
// 事实化 N/A 与对抗向量；精确重放被协议幂等吸收的类型使用同身份异载荷/
// ghost 向量。生产事实注记:
// commit/lifecycle projection 均由耐久恢复投影器生产；其生产场景显式执行
// 对应 resume 消费者，不以在线提交副作用冒充耐久生产路径。
const CONVERSATION_RECORD_BEHAVIOR = {
  "session-lifecycle": {
    scenario: "sessionLifecycle",
    recovery: conversationRecovery("lifecycleProjection"),
  },
  admitted: {
    scenario: "commit",
    recovery: noConversationRecovery("admission is consumed by normal state replay only"),
    corrupt: (body) => ({ ...body, queuedPosition: 7 }),
  },
  assigned: {
    scenario: "commit",
    recovery: conversationRecovery("dispatchOutbox"),
    corrupt: (body) => ({ ...body, manifestDigest: SHA256_ZERO }),
  },
  "dispatch-acked": {
    scenario: "conflictAcked",
    recovery: conversationRecovery("dispatchOutbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  "dispatch-conflict": {
    scenario: "conflictContained",
    recovery: conversationRecovery("conflictCancellation"),
  },
  "dispatch-conflict-contained": {
    scenario: "conflictContained",
    recovery: conversationRecovery("conflictCancellation"),
  },
  "assignment-superseded": {
    scenario: "supersedeNotStarted",
    recovery: conversationRecovery("supersedeOutbox"),
  },
  "supersede-requested": {
    scenario: "supersedeStarted",
    recovery: conversationRecovery("supersedeOutbox"),
    corrupt: (body) => ({ ...body, requestId: "matrix-conflicting-supersede" }),
  },
  "supersede-started-observed": {
    scenario: "supersedeStarted",
    recovery: conversationRecovery("supersedeOutbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  "cancel-fence": {
    scenario: "cancelHalted",
    recovery: conversationRecovery("cancellationOutbox"),
  },
  "capability-revoked": {
    scenario: "commit",
    recovery: noConversationRecovery("capability revocation is consumed by authorization guards"),
    corrupt: (body) => ({ ...body, capId: "capability-ghost" }),
  },
  "interaction-mirror": {
    scenario: "mirror",
    recovery: noConversationRecovery("mirrored interaction ordinals have no owner outbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  state: { scenario: "commit", recovery: conversationRecovery("dispatchOutbox") },
  committed: {
    scenario: "commit",
    recovery: conversationRecovery("bundleAcknowledgementOutbox"),
  },
  "bundle-ack-observed": {
    scenario: "commit",
    recovery: conversationRecovery("bundleAcknowledgementOutbox"),
  },
  resolution: {
    scenario: "cancelUncertainContained",
    recovery: noConversationRecovery(
      "resolution closes authority state without a separate recovery outbox",
    ),
  },
  "cancel-contained": {
    scenario: "cancelUncertainContained",
    recovery: conversationRecovery("cancellationOutbox"),
  },
  "cancel-proof-accepted": {
    scenario: "cancelHalted",
    recovery: conversationRecovery("cancellationOutbox"),
  },
  "not-started-rejected": {
    scenario: "uncertainRejected",
    recovery: conversationRecovery("contradictoryProofStop"),
  },
  "content-asset-index": {
    scenario: "commit",
    recovery: noConversationRecovery("asset sidecars are replayed by the full reducer only"),
    corrupt: (body) => ({ ...body, entries: [{ bogus: true }] }),
  },
  "conversation-commit-projection": {
    scenario: "commitProjection",
    recovery: conversationRecovery("commitProjection"),
    corrupt: (body) => ({ ...body, digest: SHA256_ZERO }),
  },
  "conversation-lifecycle-projection": {
    scenario: "sessionLifecycle",
    recovery: conversationRecovery("lifecycleProjection"),
    corrupt: (body) => ({ ...body, requestId: "matrix-lifecycle-ghost" }),
  },
} as const satisfies Record<ConversationBehaviorRecordType, ConversationRecordBehaviorSpec>;

async function expectConversationRejected(probe: () => Promise<unknown>): Promise<void> {
  try {
    await probe();
  } catch (error) {
    if (error instanceof AuthorityStorageError || error instanceof TypeError) return;
    throw new Error(
      `behavior probe failed outside the corruption contract: ${String(error)}`,
    );
  }
  throw new Error("behavior probe accepted a corrupted conversation log");
}

async function expectConversationGuardReplayAccepted(
  probe: () => Promise<unknown>,
): Promise<void> {
  try {
    await probe();
  } catch (error) {
    if (error instanceof AuthorityStorageError) {
      throw new Error(
        `behavior probe rejected a legal conversation log: ${String(error)}`,
      );
    }
    // The guard has accepted and loaded the journal; the requested business action may
    // still be stably rejected by the already-replayed terminal state.
  }
}

describe("conversation record execution-point behavior matrix", () => {
  it("binds every conversation record type to a producing scenario", () => {
    expect(Object.keys(CONVERSATION_RECORD_BEHAVIOR).sort()).toEqual(
      [
        ...Object.keys(CONVERSATION_RUN_RECORD_SHAPES),
        ...CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
      ].sort(),
    );
    const referencedRecoveryProbes = new Set<ConversationRecoveryProbeId>();
    for (const [recordType, spec] of Object.entries(CONVERSATION_RECORD_BEHAVIOR)) {
      if (spec.recovery.kind === "not-applicable") {
        expect(spec.recovery.reason.length, recordType).toBeGreaterThan(20);
      } else {
        referencedRecoveryProbes.add(spec.recovery.id);
      }
    }
    expect([...referencedRecoveryProbes].sort()).toEqual(
      Object.keys(CONVERSATION_RECOVERY_PROBES).sort(),
    );
  });

  it.each(Object.entries(CONVERSATION_RECOVERY_PROBES))(
    "recovery contract %s executes its real consumer",
    async (_id, probe) => probe(),
    20_000,
  );

  it.each(Object.keys(CONVERSATION_RECORD_BEHAVIOR) as ConversationBehaviorRecordType[])(
    "%s: real production, full/guard acceptance, adversarial-vector rejection",
    async (recordType) => {
      const spec = CONVERSATION_RECORD_BEHAVIOR[
        recordType
      ] as ConversationRecordBehaviorSpec;
      const behavior = await CONVERSATION_BEHAVIOR_SCENARIOS[spec.scenario]();
      const records = await behavior.log.readStream<Record<string, unknown>>(
        `run:${CONVERSATION_ID}`,
      );
      const produced = records.filter((record) => {
        const body = record.body as { t?: string; kind?: string };
        return body.t === recordType || body.kind === recordType;
      });
      expect(produced.length, recordType).toBeGreaterThan(0);
      await behavior.fullProbe();
      if (behavior.guardProbe) {
        await expectConversationGuardReplayAccepted(behavior.guardProbe);
      }
      const target = produced[produced.length - 1];
      if (!target) throw new Error("matrix target record is missing");
      const vector = spec.corrupt
        ? spec.corrupt(structuredClone(target.body) as Record<string, unknown>)
        : structuredClone(target.body);
      await behavior.log.append([{ stream: `run:${CONVERSATION_ID}`, body: vector }]);
      await expectConversationRejected(behavior.fullProbe);
      if (behavior.guardProbe) await expectConversationRejected(behavior.guardProbe);
    },
    20_000,
  );
});
