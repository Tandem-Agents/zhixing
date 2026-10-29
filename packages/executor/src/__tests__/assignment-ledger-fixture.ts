// assignment-ledger.test.ts 拆分后的共享常量与助手。
import path from "node:path";
import { ExecutorResourceGovernor } from "../resource-governor.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthorityCacheIntegrity, AuthorityStorageError, FileArtifactStore, FileAuthorityCommitLog, type ArtifactStore } from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import type { AuthorityCallContext, AuthorityCapability, DispatchEnvelope, IngressContext, PermissionSnapshotLease, Signature, StreamFrame, TrustRuleSnapshot } from "@zhixing/core/contracts";
import { buildConversationActivationPayload, canonicalize, confirmationDecisionDigest, createSignedConversationEnvelope, createSignedTrustRuleSnapshot, dispatchEnvelopeArtifact, dispatchEnvelopeDigest, protocolBytes, protocolDigest, createConversationSealedBundle, createSignedConversationInteractionMirrorBatch, interactionMirrorSeed, ownerControlRequestDigest, permissionSnapshotLeaseDigest, sealedBundleArtifact, signConversationActivation, type ProtocolSignatureVerifier, type ProtocolSigner, type ConversationInteractionMirrorBatch, type ConversationInteractionMirrorEntry, type ExecutorCapabilitySnapshot, type UnsignedConversationEnvelope } from "@zhixing/core/protocol";
import { CONVERSATION_RUN_INTERNAL_RECORD_TYPES, ConversationRunJournal, InProcessConversationDispatcher, type AssignmentSubmissionAuthorizer, type ConversationCommitAuthority, type ConversationCommitProjection, type ConversationCommitProjectionInput, type ConversationMutationPublisher, type ConversationRunRecordType } from "@zhixing/owner-kernel/conversation-assignment";
import { ControlAdmissionJournal, channelSurfacePrincipal, createConversationControlEnvelope, createInitialControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { createOwnerDeliveryParticipant, type OwnerDeliveryParticipant } from "@zhixing/owner-kernel/delivery";
import { createTempDir } from "@zhixing/test-utils";
import { type ConversationTransferStaging, type ConversationTransferStagingArea } from "@zhixing/owner-kernel/conversation-transfer";
import { expect, onTestFinished } from "vitest";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission, type AssignmentLedgerOptions, type OwnerControlAuthorizer } from "../assignment-ledger.js";

export const NOW = "2026-07-13T09:00:00.000Z";

export const EXPIRY = "2026-07-13T10:00:00.000Z";

export const CONTROL_EXPIRY = "2026-07-13T09:01:00.000Z";

export const EXECUTOR_ID = "executor-1";

export const CONVERSATION_ID = "conversation-1";

export const RUN_ID = "run-1";

export const ASSIGNMENT_ID = "assignment-1";

export const SHA256_ZERO = `sha256:${"0".repeat(64)}`;

export const ABORT_TICKET_DIGEST = `sha256:${"a".repeat(64)}`;

export const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

export function memoryStagingArea(): {
  readonly port: ConversationTransferStagingArea;
  readonly count: (transferId: string) => number;
} {
  const sessions = new Map<string, {
    readonly artifacts: Map<string, Uint8Array>;
    readonly partials: Map<string, Uint8Array>;
    readonly projection: ConversationTransferStaging;
  }>();
  const keyFor = (ref: ArtifactRef) => `${ref.digest}:${ref.bytes}`;
  const forTransfer = (transferId: string): ConversationTransferStaging => {
    const current = sessions.get(transferId);
    if (current) return current.projection;
    const artifacts = new Map<string, Uint8Array>();
    const partials = new Map<string, Uint8Array>();
    const projection = Object.freeze({
      artifacts: Object.freeze({
        get: async (ref: ArtifactRef) => {
          const value = artifacts.get(keyFor(ref));
          if (!value) throw new Error("Artifact does not exist");
          return value.slice();
        },
        readRange: async (ref: ArtifactRef, offset: number, limit: number) => {
          const value = artifacts.get(keyFor(ref));
          if (!value) throw new Error("Artifact does not exist");
          return value.slice(offset, offset + limit);
        },
        has: async (ref: ArtifactRef) => artifacts.has(keyFor(ref)),
      }),
      receiver: Object.freeze({
        progress: async (ref: ArtifactRef, runPhysicalStep = (_identity, operation) => operation()) =>
          runPhysicalStep({ step: "progress", digest: ref.digest }, async () => {
            const complete = artifacts.has(keyFor(ref));
            return {
              receivedBytes: complete ? ref.bytes : (partials.get(keyFor(ref))?.byteLength ?? 0),
              complete,
            };
          }),
        append: async (
          ref: ArtifactRef,
          offset: number,
          bytes: Uint8Array,
          runPhysicalStep = (_identity, operation) => operation(),
        ) => runPhysicalStep({ step: "append", digest: ref.digest }, async () => {
          const key = keyFor(ref);
          if (artifacts.has(key)) return { receivedBytes: ref.bytes, complete: true };
          const prefix = partials.get(key) ?? new Uint8Array();
          if (offset !== prefix.byteLength) {
            throw new RangeError("Artifact chunk does not continue the durable prefix");
          }
          const next = Buffer.concat([prefix, bytes]);
          if (next.byteLength > ref.bytes) {
            throw new RangeError("Artifact chunk exceeds the declared byte length");
          }
          if (next.byteLength === ref.bytes) {
            artifacts.set(key, next);
            partials.delete(key);
            return { receivedBytes: ref.bytes, complete: true };
          }
          partials.set(key, next);
          return { receivedBytes: next.byteLength, complete: false };
        }),
      }),
      cleanup: async () => {
        const removed = artifacts.size;
        sessions.delete(transferId);
        return removed;
      },
    }) satisfies ConversationTransferStaging;
    sessions.set(transferId, { artifacts, partials, projection });
    return projection;
  };
  return {
    port: Object.freeze({ forTransfer }),
    count: (transferId) => sessions.get(transferId)?.artifacts.size ?? 0,
  };
}

export function matchingSnapshotFor(executorId: string): ExecutorCapabilitySnapshot | undefined {
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

export function matchingPermissionSnapshotFor(
  identity: TestProtocolIdentity,
  digest: string,
): TrustRuleSnapshot | undefined {
  const snapshot = createSignedTrustRuleSnapshot(
    { snapshotVersion: 1, rules: [], generatedAt: NOW },
    identity,
  );
  return snapshot.digest === digest ? snapshot : undefined;
}

export function allowOnceDecisionDigest(requestId: string): string {
  return confirmationDecisionDigest(requestId, { kind: "allow-once" });
}

export function deliveryParticipant(log: FileAuthorityCommitLog): OwnerDeliveryParticipant {
  return createOwnerDeliveryParticipant({
    authority: new DeliveryAuthority({ log, anchorEpoch: 3 }),
  });
}

export type ConversationEnvelope = Extract<
  DispatchEnvelope,
  { execution: "conversation" }
>;

export class TestProtocolIdentity implements ProtocolSigner, ProtocolSignatureVerifier {
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

export class CountingArtifactStore implements ArtifactStore {
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

  putVerifiedStream(...args: Parameters<ArtifactStore["putVerifiedStream"]>) {
    this.puts += 1;
    return this.#delegate.putVerifiedStream(...args);
  }

  get(ref: Parameters<ArtifactStore["get"]>[0]) {
    this.gets += 1;
    return this.#delegate.get(ref);
  }

  readRange(...args: Parameters<ArtifactStore["readRange"]>) {
    this.gets += 1;
    return this.#delegate.readRange(...args);
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

export class FaultingArtifactStore implements ArtifactStore {
  readonly #delegate: ArtifactStore;
  failDigest?: string;

  constructor(delegate: ArtifactStore) {
    this.#delegate = delegate;
  }

  put(bytes: Uint8Array) {
    return this.#delegate.put(bytes);
  }

  putVerifiedStream(...args: Parameters<ArtifactStore["putVerifiedStream"]>) {
    return this.#delegate.putVerifiedStream(...args);
  }

  get(ref: Parameters<ArtifactStore["get"]>[0]) {
    if (ref.digest === this.failDigest) {
      throw new Error("simulated transient delivery content read failure");
    }
    return this.#delegate.get(ref);
  }

  readRange(...args: Parameters<ArtifactStore["readRange"]>) {
    if (args[0].digest === this.failDigest) {
      throw new Error("simulated transient delivery content read failure");
    }
    return this.#delegate.readRange(...args);
  }

  has(ref: Parameters<ArtifactStore["has"]>[0]) {
    return this.#delegate.has(ref);
  }
}

export function signedMirrorBatch(
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

export function mirrorReceipt(batch: ConversationInteractionMirrorBatch) {
  const last = batch.entries.at(-1);
  if (!last) throw new Error("test mirror batch is empty");
  return {
    mirroredUpTo: last.seq,
    ordinal: last.ordinal,
    mirrorDigest: batch.mirrorDigest,
  };
}

export const ownerControl: OwnerControlAuthorizer = {
  authorize(context, request, authenticatedCallerDeviceId) {
    if (
      context.principal.kind !== "owner-control" ||
      context.principal.grant.assignmentId !== request.assignmentId ||
      context.principal.grant.callerDeviceId !== authenticatedCallerDeviceId ||
      !context.principal.grant.methods.includes(request.method) ||
      (request.authority !== undefined &&
        canonicalize(context.principal.grant.scope) !== canonicalize(request.authority))
    ) {
      throw new Error("owner control authorization failed");
    }
    return {
      authority: structuredClone(context.principal.grant.scope),
      ownerDeviceId: context.principal.grant.callerDeviceId,
      controlLease: structuredClone(context.principal.grant.controlLease),
    };
  },
};

export const submission: AssignmentSubmissionAuthorizer = {
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

export function createRevocationAwareSubmission() {
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

export async function createUnassignedHarness(
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
    clock?: () => string;
    monotonicClock?: () => number;
    assignmentRecordV2Writes?: boolean;
    integrity?: AuthorityCacheIntegrity;
  } = {},
) {
  const root = await createTempDir("conversation-assignment");
  let log: FileAuthorityCommitLog | undefined;
  onTestFinished(() => log?.stopStorageMaintenance());
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const clock = options.clock ?? (() => NOW);
  log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock,
    lockWaitMs: 2_000,
    ...(options.integrity ? { integrity: options.integrity } : {}),
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
    clock,
    submission: options.submission ?? submission,
    authority,
    projection,
    publisher: options.publisher,
    legacyAbortTickets: {
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
    clock,
    monotonicClock: options.monotonicClock,
    maxPendingInteractions: options.maxPendingInteractions,
    ...(options.assignmentRecordV2Writes === undefined ? {} : { assignmentRecordV2Writes: options.assignmentRecordV2Writes }),
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

export async function createHarness(
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
    clock?: () => string;
    monotonicClock?: () => number;
    assignmentRecordV2Writes?: boolean;
    integrity?: AuthorityCacheIntegrity;
  } = {},
) {
  const harness = await createUnassignedHarness(options);
  const { journal, unsigned } = harness;
  const dispatch = await journal.assign(unsigned);
  return { ...harness, dispatch };
}

export async function createFormalReceiptHarness(options: { clock?: () => string; monotonicClock?: () => number; shortPermission?: boolean; startupProofs?: boolean } = {}) {
  const h = await createHarness(options);
  const clock = options.clock ?? (() => NOW);
  const { digest: _digest, signature: _signature, ...root } = h.unsigned.resourceLease;
  const payload = { ...root, reservationId: `reservation:${ASSIGNMENT_ID}`,
    domain: { kind: "anchor" as const, anchorEpoch: 3 },
    delegation: { executorId: EXECUTOR_ID, maxDepth: 1, maxBudget: root.budget } };
  const digested = { ...payload, digest: protocolDigest("ResourceLease", 1, payload) };
  const lease = { ...digested, signature: h.identity.sign("ResourceLease", 1, digested) };
  const { signature: _permissionSignature, ...permissionPayload } = h.unsigned.permissionLease;
  const permissionBody = { ...permissionPayload, expiry: options.shortPermission ? CONTROL_EXPIRY : permissionPayload.expiry };
  const permissionLease = { ...permissionBody, signature: h.identity.sign("PermissionSnapshotLease", 1, permissionBody) };
  const envelope = createSignedConversationEnvelope({ ...h.unsigned, permissionLease, resourceLease: lease }, h.identity, h.identity);
  const activation = signConversationActivation(buildConversationActivationPayload({ envelope,
    dispatchRef: dispatchEnvelopeArtifact(envelope).ref, commit: h.dispatch.activation.commit, issuedAt: NOW }), h.identity);
  const log = new FileAuthorityCommitLog(path.join(h.root, "formal-executor"), h.artifacts, { clock,
    ...(options.startupProofs === true ? { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 5)) } : {}) });
  onTestFinished(() => log.stopStorageMaintenance());
  const reopen = () => {
    const governor = new ExecutorResourceGovernor({ log, signer: h.identity, verifier: h.identity, guard: { assert() {} },
      executorId: EXECUTOR_ID, localDomainId: "local:device-1", localGovernorEpoch: 1, maxActiveRoots: 1, clock, monotonicClock: options.monotonicClock });
    const ledger = new ConversationAssignmentLedger({ log, artifacts: h.artifacts, executorId: EXECUTOR_ID,
      signer: h.identity, verifier: h.identity, ownerControl, snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: digest => matchingPermissionSnapshotFor(h.identity, digest), resources: governor, clock, monotonicClock: options.monotonicClock });
    return { governor, ledger };
  };
  return { ...h, ...reopen(), log, reopen, envelope, activation, lease };
}

export function createUnsignedEnvelope(
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
  const controlPayload = {
    v: 1 as const,
    controlLeaseId: "control-lease-1",
    assignmentId,
    authority: {
      execution: "conversation" as const,
      conversationId,
      ownerEpoch: 3,
    },
    renewalSeq: 1,
    issuedAt: NOW,
    expiry: CONTROL_EXPIRY,
  };
  const controlLease = {
    ...controlPayload,
    signature: identity.sign("ControlLease", 1, controlPayload),
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
    controlLease,
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
      contentAssets: [],
      controlContext: [],
    },
  };
}

export function ingress() {
  return {
    kind: "first-party" as const,
    surfacePrincipal: "surface:user-1",
    deviceId: "device-1",
    ingressId: "ingress-1",
    receivedAt: NOW,
  };
}

export function ownerContext(
  assignmentId: string,
  method:
    | "executor.dispatch"
    | "executor.queryLedger"
    | "executor.cancel"
    | "executor.supersede",
  conversationIdOrRequest:
    | string
    | { readonly requestId: string; readonly body: unknown } = CONVERSATION_ID,
  controlLeaseOverrides: Partial<{
    readonly controlLeaseId: string;
    readonly renewalSeq: number;
    readonly issuedAt: string;
    readonly expiry: string;
  }> = {},
): AuthorityCallContext {
  const conversationId = typeof conversationIdOrRequest === "string"
    ? conversationIdOrRequest
    : CONVERSATION_ID;
  const request = typeof conversationIdOrRequest === "string"
    ? {
        requestId: `request-${method}-${assignmentId}`,
        body: {},
      }
    : conversationIdOrRequest;
  const scope = { execution: "conversation" as const, conversationId, ownerEpoch: 3 };
  const controlPayload = {
    v: 1 as const,
    controlLeaseId: controlLeaseOverrides.controlLeaseId ?? "control-lease-1",
    assignmentId,
    authority: scope,
    renewalSeq: controlLeaseOverrides.renewalSeq ?? 1,
    issuedAt: controlLeaseOverrides.issuedAt ?? NOW,
    expiry: controlLeaseOverrides.expiry ?? CONTROL_EXPIRY,
  };
  const controlLease = {
    ...controlPayload,
    signature: new TestProtocolIdentity().sign("ControlLease", 1, controlPayload),
  };
  const requestId = request.requestId;
  return {
    principal: {
      kind: "owner-control",
      grant: {
        v: 1,
        assignmentId,
        scope,
        methods: [method],
        callerDeviceId: "test-owner",
        requestId,
        requestDigest: ownerControlRequestDigest({
          method,
          assignmentId,
          authority: scope,
          requestId,
          body: request.body,
        }),
        controlLease,
        issuedAt: controlPayload.issuedAt,
        expiry: controlPayload.expiry,
        signature: { alg: "test", keyId: "test-owner", sig: "context" },
      },
    },
    requestId,
    deadlineAt: controlPayload.expiry,
  };
}

export function submissionContext(
  envelope: UnsignedConversationEnvelope,
): AuthorityCallContext {
  return {
    principal: { kind: "assignment", capability: envelope.capabilities[0]! },
    requestId: "submission-request",
    deadlineAt: EXPIRY,
  };
}

export function trustedControlSource() {
  return {
    principal: {
      surfacePrincipal: "surface:user-1",
      deviceId: "device-1",
      connectionId: "connection-1",
    },
  };
}

export async function applyResolutionControl(
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

export async function applyCancelControl(
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

export async function replaceAssignmentAfterUncertain(
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

export async function storedAssignmentFact(
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

export async function appendCompleteConversationCommit(
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

/**
 * 真实且规范的 SealedBundle 工件引用。
 *
 * 注册根校验在 append 期就会把 `bundle_sealed` 的引用解出来、按注册 schema 核对,
 * 占位字节过不去。但下面这些用例要验的是重放顺序与前缀约束,与 bundle 内容无关,
 * 所以走生产路径真封一份,连同它引用的 run record 一起搬进目标存储。
 */

export async function putRealSealedBundleRef(
  target: Awaited<ReturnType<typeof createHarness>>,
): Promise<ArtifactRef> {
  const source = await createHarness();
  await source.ledger.dispatch(
    source.dispatch.envelope,
    source.dispatch.activation,
    ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
  );
  await source.ledger.start(ASSIGNMENT_ID);
  const bundle = await sealDefaultBundle(source.ledger);
  const artifact = sealedBundleArtifact(bundle);
  // run record 小到一定阈值会内联,只有外置时才需要一起搬。
  const runRecord = bundle.body.runRecord as { ref?: ArtifactRef };
  if (runRecord.ref !== undefined) {
    await target.artifacts.put(await source.artifacts.get(runRecord.ref));
  }
  await target.artifacts.put(artifact.bytes);
  return artifact.ref;
}

export async function sealDefaultBundle(
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

export function createAlternativeDispatch(
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

export function createCancellationSubmission(
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

export function createBundleSubmission(
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

export function reopenJournal(
  harness: Awaited<ReturnType<typeof createUnassignedHarness>>,
  options: {
    readonly ownerEpoch?: number;
    readonly artifacts?: ArtifactStore;
    readonly submission?: AssignmentSubmissionAuthorizer;
    readonly clock?: () => string;
  } = {},
): ConversationRunJournal {
  const artifacts = options.artifacts ?? harness.artifacts;
  const clock = options.clock ?? (() => NOW);
  return new ConversationRunJournal({
    conversationId: CONVERSATION_ID,
    ownerEpoch: options.ownerEpoch ?? 3,
    log: new FileAuthorityCommitLog(harness.log.rootDir, artifacts, {
      clock,
      lockWaitMs: 2_000,
    }),
    artifacts,
    signer: harness.identity,
    verifier: harness.identity,
    delivery: deliveryParticipant(harness.log),
    clock,
    submission: options.submission ?? submission,
    authority: harness.authority,
    projection: harness.projection,
    legacyAbortTickets: {
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

export function withoutSignature<T extends { signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return JSON.parse(canonicalize(payload)) as Omit<T, "signature">;
}

export type ConversationBehaviorRecordType =
  | ConversationRunRecordType
  | (typeof CONVERSATION_RUN_INTERNAL_RECORD_TYPES)[number];

export type ConversationBehaviorScenarioId =
  | "runInput"
  | "commit"
  | "advancementSession"
  | "worksceneSession"
  | "sessionControl"
  | "sessionLifecycle"
  | "channelLifecycle"
  | "mirror"
  | "cancelHalted"
  | "cancelUncertainContained"
  | "supersedeStarted"
  | "supersedeNotStarted"
  | "conflictContained"
  | "conflictAcked"
  | "uncertainRejected"
  | "commitProjection"
  | "ticketLifecycle";

export interface ConversationBehaviorHarness {
  readonly log: FileAuthorityCommitLog;
  readonly conversationId: string;
  readonly fullProbe: () => Promise<unknown>;
  readonly guardProbe?: () => Promise<unknown>;
}

export interface ConversationRecordBehaviorSpec {
  readonly scenario: ConversationBehaviorScenarioId;
  readonly stream?: "run" | "session-activity";
  readonly corruptStream?: "run" | "session-activity";
  readonly corrupt?: (body: Record<string, unknown>) => Record<string, unknown>;
  readonly recovery: ConversationRecoveryExpectation;
}

export function conversationBehaviorHarness(
  harness: Awaited<ReturnType<typeof createHarness>>,
  clock: () => string = () => NOW,
): ConversationBehaviorHarness {
  return {
    log: harness.log,
    conversationId: CONVERSATION_ID,
    fullProbe: () => reopenJournal(harness, { clock }).currentState(RUN_ID),
    guardProbe: () =>
      reopenJournal(harness, { clock }).reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
  };
}

export async function receiveConversation(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  await harness.ledger.dispatch(
    harness.dispatch.envelope,
    harness.dispatch.activation,
    ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
  );
}

export async function startConversation(
  harness: Awaited<ReturnType<typeof createHarness>>,
) {
  await receiveConversation(harness);
  await harness.ledger.start(ASSIGNMENT_ID);
  await harness.journal.reportStarted(
    ASSIGNMENT_ID,
    submissionContext(harness.unsigned),
  );
}

export async function createConversationChannelLifecycle() {
  const responder = {
    channelId: "feishu",
    platformSubject: "matrix-user",
    tenant: "matrix-tenant",
  };
  const harness = await createHarness({
    ingress: {
      kind: "channel",
      surfacePrincipal: channelSurfacePrincipal(responder),
      responder,
      replyTarget: { channelId: "feishu", to: "matrix-chat" },
      deviceId: "matrix-device",
      ingressId: "matrix-channel-lifecycle",
      receivedAt: NOW,
    },
  });
  await startConversation(harness);
  const ref = {
    execution: "conversation" as const,
    conversationId: CONVERSATION_ID,
    runId: RUN_ID,
    ownerEpoch: 3,
  };
  const requestId = "matrix-channel-interaction";
  const requested: StreamFrame = {
    v: 1,
    ref,
    assignmentId: ASSIGNMENT_ID,
    streamEpoch: 1,
    seq: 1,
    payload: {
      kind: "interaction",
      event: {
        t: "requested",
        requestId,
        toolName: "write",
        display: { title: "Approve?", lines: ["write result"] },
        issuedAt: NOW,
        ttlMs: 60_000,
        expiresAt: "2026-07-13T09:01:00.000Z",
      },
    },
    meta: {},
  };
  const adoption = await harness.journal.adoptConversationChannelFrame(requested);
  if (!adoption.prepared) {
    throw new Error("matrix conversation channel challenge is missing");
  }
  await harness.journal.recordChannelChallengeDelivered({
    challengeId: adoption.prepared.token.challengeId,
    receipt: { acceptedAt: NOW },
  });
  const finish = () =>
    harness.journal.adoptConversationChannelFrame({
      v: 1,
      ref,
      assignmentId: ASSIGNMENT_ID,
      streamEpoch: 2,
      seq: 2,
      payload: {
        kind: "interaction",
        event: { t: "finished", requestId, outcome: "cancelled" },
      },
      meta: {},
    });
  return {
    harness,
    challengeId: adoption.prepared.token.challengeId,
    finish,
  };
}

export const CONVERSATION_BEHAVIOR_SCENARIOS: Record<
  ConversationBehaviorScenarioId,
  () => Promise<ConversationBehaviorHarness>
> = {
  async runInput() {
    const harness = await createHarness();
    await startConversation(harness);
    const port = await harness.journal.openRunInput(RUN_ID, ASSIGNMENT_ID);
    const source = { ...trustedControlSource(), ingress: { ...ingress(), ingressId: 'matrix-followup',
      turnOrigin: { channel: 'rpc', messageIdentity: { id: 'matrix-message', source: { kind: 'conversation' as const, conversationId: CONVERSATION_ID } } } } };
    const outcome = await harness.journal.applyInputControl({ admission: harness.control, source, runId: 'unused-queued-id',
      envelope: createInitialControlEnvelope({ requestId: 'matrix-input', at: NOW, source, body: {
        t: 'input', conversationId: CONVERSATION_ID, ownerEpoch: 3,
        ingress: { ingressId: 'matrix-followup', source: 'first-party' },
        input: { parts: [{ type: 'text', text: 'followup' }] }, invocation: { kind: 'agent', source: 'interactive' },
      } }),
    });
    expect(outcome).toMatchObject({ kind: 'applied', result: { status: 'ok', body: { runId: RUN_ID } } });
    expect(await port.receive({ boundary: 1, closing: false })).toHaveLength(1);
    await port.close();
    return conversationBehaviorHarness(harness);
  },
  async sessionControl() {
    const harness = await createHarness();
    const source = trustedControlSource();
    const authority = await harness.journal.authorityState();
    const outcome = await harness.journal.applyControl({
      admission: harness.control,
      envelope: createConversationControlEnvelope({
        requestId: "matrix-session-control",
        source,
        at: NOW,
        body: {
          t: "session-write",
          conversationId: CONVERSATION_ID,
          mutation: { kind: "task-list-op", op: { op: "set", state: { items: [] } } },
          ownerEpoch: 3,
          domainRevision: authority.domainRevision,
        },
      }),
      source,
    });
    if (outcome.kind !== "applied" || outcome.result.status !== "ok") {
      throw new Error("matrix session control was rejected");
    }
    return conversationBehaviorHarness(harness);
  },
  async advancementSession() {
    const harness = await createHarness();
    await harness.journal.applyAdvancementEvents({
      requestId: "matrix-advancement-event",
      events: [
        {
          type: "session_created",
          timestamp: NOW,
          sessionId: "matrix-advancement-session",
          conversationId: CONVERSATION_ID,
          originalUserTask: {
            parts: [{ type: "text", text: "continue the accepted work" }],
          },
          pendingRubricDraft: {
            draftId: "matrix-rubric-draft",
            originalTurnId: "matrix-turn",
            source: "generated",
            candidateRubricIds: [],
            title: "Completion rubric",
            description: "Confirm the accepted work is complete.",
            content: {
              passCriteria: ["The accepted work is complete."],
              failureHandling: [
                {
                  id: "continue",
                  scenario: "The work is incomplete.",
                  reply: "Continue the accepted work.",
                },
              ],
            },
            createdAt: NOW,
          },
        },
      ],
    });
    return conversationBehaviorHarness(harness);
  },
  async worksceneSession() {
    const root = await createTempDir("conversation-workscene-session-matrix");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
      lockWaitMs: 2_000,
    });
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => NOW,
      lockWaitMs: 2_000,
    });
    const identity = new TestProtocolIdentity();
    const conversationId = "ws:matrix-scene:primary";
    const createJournal = () =>
      new ConversationRunJournal({
        conversationId,
        ownerEpoch: 3,
        log,
        artifacts,
        signer: identity,
        verifier: identity,
        delivery: deliveryParticipant(log),
        clock: () => NOW,
        submission,
        authority: {
          decideAtPrefix: () => ({ committed: true, commitRevision: 1 }),
        },
        projection: { async project() {} },
      });
    await createJournal().touchWorksceneSession({
      requestId: "matrix-session-create",
      sceneId: "matrix-scene",
      at: NOW,
    });
    return {
      log,
      conversationId,
      fullProbe: () => createJournal().authorityState(),
    };
  },
  async channelLifecycle() {
    const lifecycle = await createConversationChannelLifecycle();
    await lifecycle.finish();
    return conversationBehaviorHarness(lifecycle.harness);
  },
  async ticketLifecycle() {
    let nowMs = Date.parse(NOW);
    const clock = () => new Date(nowMs).toISOString();
    const harness = await createHarness({ clock });
    await receiveConversation(harness);
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const ticket = await harness.journal.issueDataPlaneTicket({
      ticketId: "matrix-observer-ticket",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:observer-1",
      kind: "run-observe",
      ttlMs: 60_000,
    });
    await harness.journal.revokeDataPlaneTicket(ticket.ticketId);
    nowMs += 4 * 60 * 1_000;
    await harness.journal.dataPlaneTicketFacts();
    return conversationBehaviorHarness(harness, clock);
  },
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

export const CONVERSATION_RECOVERY_PROBES = {
  async channelChallengeOutbox() {
    const lifecycle = await createConversationChannelLifecycle();
    await expect(
      reopenJournal(lifecycle.harness).pendingChannelChallenges(),
    ).resolves.toMatchObject([
      {
        prepared: {
          token: { challengeId: lifecycle.challengeId },
        },
        delivered: { challengeId: lifecycle.challengeId },
      },
    ]);
    await lifecycle.finish();
    await expect(
      reopenJournal(lifecycle.harness).pendingChannelChallenges(),
    ).resolves.toEqual([]);
  },
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

export type ConversationRecoveryProbeId = keyof typeof CONVERSATION_RECOVERY_PROBES;

export type ConversationRecoveryExpectation =
  | { readonly kind: "probe"; readonly id: ConversationRecoveryProbeId }
  | { readonly kind: "not-applicable"; readonly reason: string };

export const conversationRecovery = (
  id: ConversationRecoveryProbeId,
): ConversationRecoveryExpectation => ({ kind: "probe", id });

export const noConversationRecovery = (reason: string): ConversationRecoveryExpectation => ({
  kind: "not-applicable",
  reason,
});

// conversation 域与 job 域同一引擎:每类记录绑定真实生产场景、恢复合同或
// 事实化 N/A 与对抗向量；精确重放被协议幂等吸收的类型使用同身份异载荷/
// ghost 向量。生产事实注记:
// commit/lifecycle projection 均由耐久恢复投影器生产；其生产场景显式执行
// 对应 resume 消费者，不以在线提交副作用冒充耐久生产路径。

export const CONVERSATION_RECORD_BEHAVIOR = {
  "run-input-opened": {
    scenario: "runInput",
    recovery: noConversationRecovery("input consumption is replayed by the assignment input port and full run reducer"),
    corrupt: (body) => ({ ...body, runId: "ghost-run" }),
  },
  "run-input-appended": {
    scenario: "runInput",
    recovery: noConversationRecovery("input consumption is replayed by the assignment input port and full run reducer"),
    corrupt: (body) => ({ ...body, runId: "ghost-run" }),
  },
  "run-input-consumed": {
    scenario: "runInput",
    recovery: noConversationRecovery("input consumption is replayed by the assignment input port and full run reducer"),
    corrupt: (body) => ({ ...body, runId: "ghost-run" }),
  },
  "run-input-closed": {
    scenario: "runInput",
    recovery: noConversationRecovery("input consumption is replayed by the assignment input port and full run reducer"),
    corrupt: (body) => ({ ...body, runId: "ghost-run" }),
  },
  "channel-challenge-prepared": {
    scenario: "channelLifecycle",
    recovery: conversationRecovery("channelChallengeOutbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  "channel-challenge-delivered": {
    scenario: "channelLifecycle",
    recovery: conversationRecovery("channelChallengeOutbox"),
    corrupt: (body) => ({ ...body, challengeId: "challenge-ghost" }),
  },
  "channel-challenge-closed": {
    scenario: "channelLifecycle",
    recovery: conversationRecovery("channelChallengeOutbox"),
    corrupt: (body) => ({ ...body, challengeId: "challenge-ghost" }),
  },
  "session-lifecycle": {
    scenario: "sessionLifecycle",
    recovery: conversationRecovery("lifecycleProjection"),
  },
  "session-control": {
    scenario: "sessionControl",
    recovery: noConversationRecovery(
      "session control is consumed by conversation-owner authority replay",
    ),
    corrupt: (body) => ({ ...body, domainRevision: 0 }),
  },
  "session-meta": {
    scenario: "worksceneSession",
    recovery: noConversationRecovery(
      "session metadata is replayed as conversation-owner authority state",
    ),
  },
  "advancement-event": {
    scenario: "advancementSession",
    recovery: noConversationRecovery(
      "advancement events are replayed as conversation-owner authority state",
    ),
    corrupt: (body) => ({ ...body, eventsDigest: SHA256_ZERO }),
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
  "ticket-issued": {
    scenario: "ticketLifecycle",
    recovery: noConversationRecovery("ticket delivery is driven by the owner ticket-fact synchronizer"),
  },
  "ticket-revoked": {
    scenario: "ticketLifecycle",
    recovery: noConversationRecovery("ticket revocation is driven by the owner ticket-fact synchronizer"),
  },
  "ticket-sync-frontier": {
    scenario: "ticketLifecycle",
    recovery: noConversationRecovery("ticket synchronization advances only when facts are queried"),
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
  "session-activity": {
    scenario: "worksceneSession",
    stream: "session-activity",
    corruptStream: "run",
    recovery: noConversationRecovery(
      "session activity is replayed from its conversation-scoped authority stream",
    ),
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
} as const satisfies Record<
  ConversationBehaviorRecordType,
  ConversationRecordBehaviorSpec
>;

export async function expectConversationRejected(probe: () => Promise<unknown>): Promise<void> {
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

export async function expectConversationGuardReplayAccepted(
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

export function replayFixtureLog(harness: { log: FileAuthorityCommitLog }): FileAuthorityCommitLog {
  const log = new FileAuthorityCommitLog(harness.log.rootDir, harness.log.artifactStore, { clock: () => NOW, lockWaitMs: 2_000 });
  onTestFinished(() => log.stopStorageMaintenance());
  return log;
}
