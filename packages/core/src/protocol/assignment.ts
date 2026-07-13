import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  DispatchEnvelope,
  Digest,
  InteractionMirrorEntry,
  Signature,
} from "../contracts/index.js";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

type ConversationEnvelope = Extract<
  DispatchEnvelope,
  { execution: "conversation" }
>;

export type UnsignedConversationEnvelope = Omit<
  ConversationEnvelope,
  "signature"
>;

export type ConversationInteractionOutcome =
  | {
      readonly t: "answered";
      readonly authority: { readonly via: "surface-ticket"; readonly ticketId: string };
      readonly decision: { readonly allowed: boolean; readonly reason?: string };
      readonly by: string;
    }
  | Exclude<InteractionMirrorEntry["outcome"], { t: "answered" }>;

export type ConversationInteractionMirrorEntry = Omit<
  InteractionMirrorEntry,
  "outcome"
> & { readonly outcome: ConversationInteractionOutcome };

export interface ProtocolSigner {
  sign(schemaId: string, version: number, payload: unknown): Signature;
}

export interface ProtocolSignatureVerifier {
  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: Signature,
  ): void;
}

export interface DispatchEnvelopeArtifact {
  readonly bytes: Uint8Array;
  readonly ref: ArtifactRef;
}

export function createSignedConversationEnvelope(
  input: UnsignedConversationEnvelope,
  signer: ProtocolSigner,
  verifier: ProtocolSignatureVerifier,
): ConversationEnvelope {
  const unsigned = snapshot(input, "Dispatch envelope");
  assertConversationEnvelope(unsigned, verifier, false);
  const envelope = snapshot(
    {
      ...unsigned,
      signature: signer.sign("DispatchEnvelope", 1, unsigned),
    },
    "Signed dispatch envelope",
  ) as ConversationEnvelope;
  assertConversationEnvelope(envelope, verifier, true);
  return envelope;
}

export function validateConversationEnvelope(
  input: ConversationEnvelope,
  verifier: ProtocolSignatureVerifier,
): ConversationEnvelope {
  const envelope = snapshot(input, "Dispatch envelope") as ConversationEnvelope;
  assertConversationEnvelope(envelope, verifier, true);
  return envelope;
}

export function dispatchEnvelopeArtifact(
  envelope: ConversationEnvelope,
): DispatchEnvelopeArtifact {
  const bytes = Buffer.from(canonicalize(envelope), "utf8");
  return {
    bytes,
    ref: { digest: byteDigest(bytes), bytes: bytes.byteLength },
  };
}

export function dispatchEnvelopeDigest(envelope: ConversationEnvelope): Digest {
  return protocolDigest(
    "DispatchEnvelope",
    1,
    withoutField(envelope, "signature"),
  );
}

export function permissionSnapshotLeaseDigest(
  envelope: ConversationEnvelope,
): Digest {
  return protocolDigest(
    "PermissionSnapshotLease",
    1,
    withoutField(envelope.permissionLease, "signature"),
  );
}

export function buildConversationActivationPayload(input: {
  readonly envelope: ConversationEnvelope;
  readonly dispatchRef: ArtifactRef;
  readonly commit: { readonly lsn: number; readonly envelopeDigest: Digest };
  readonly issuedAt: string;
}): AssignmentActivationPayload<"conversation"> {
  const { envelope } = input;
  const payload: AssignmentActivationPayload<"conversation"> = {
    v: 1,
    ref: {
      execution: "conversation",
      runId: envelope.work.runId,
      conversationId: envelope.work.conversationId,
      ownerEpoch: envelope.work.ownerEpoch,
    },
    assignmentId: envelope.assignmentId,
    executorId: envelope.executorId,
    dispatchRef: snapshot(input.dispatchRef, "Dispatch reference"),
    manifestDigest: envelope.manifest.digest,
    permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
    capIds: envelope.capabilities.map((capability) => capability.capId),
    reservation: {
      reservationId: envelope.resourceLease.reservationId,
      attempt: envelope.resourceLease.workload.attempt,
    },
    commit: snapshot(input.commit, "Assignment commit"),
    issuedAt: input.issuedAt,
  };
  assertActivationPayload(payload, envelope, input.dispatchRef);
  return snapshot(payload, "Assignment activation payload");
}

export function signConversationActivation(
  payload: AssignmentActivationPayload<"conversation">,
  signer: ProtocolSigner,
): AssignmentActivationProof<"conversation"> {
  const canonicalPayload = snapshot(payload, "Assignment activation payload");
  return snapshot(
    {
      ...canonicalPayload,
      signature: signer.sign("AssignmentActivationProof", 1, canonicalPayload),
    },
    "Assignment activation proof",
  );
}

export function validateConversationActivation(input: {
  readonly envelope: ConversationEnvelope;
  readonly activation: AssignmentActivationProof<"conversation">;
  readonly dispatchRef: ArtifactRef;
  readonly verifier: ProtocolSignatureVerifier;
}): AssignmentActivationPayload<"conversation"> {
  const activation = snapshot(
    input.activation,
    "Assignment activation proof",
  ) as AssignmentActivationProof<"conversation">;
  assertExactKeys(
    activation,
    [
      "assignmentId",
      "capIds",
      "commit",
      "dispatchRef",
      "executorId",
      "issuedAt",
      "manifestDigest",
      "permissionLeaseDigest",
      "ref",
      "reservation",
      "signature",
      "v",
    ],
    "Assignment activation proof",
  );
  assertSignature(activation.signature, "Assignment activation signature");
  const payload = withoutField(
    activation,
    "signature",
  ) as AssignmentActivationPayload<"conversation">;
  input.verifier.verify(
    "AssignmentActivationProof",
    1,
    payload,
    activation.signature,
  );
  assertActivationPayload(payload, input.envelope, input.dispatchRef);
  return snapshot(payload, "Assignment activation payload");
}

export function assignmentActivationDigest(
  payload: AssignmentActivationPayload,
): Digest {
  return protocolDigest("AssignmentActivationPayload", 1, payload);
}

export function assignmentLedgerSeed(assignmentId: string): Digest {
  assertIdentifier(assignmentId, "Assignment id");
  return protocolDigest("AssignmentLedgerSeed", 1, { assignmentId });
}

export function advanceAssignmentLedger(
  previous: Digest,
  entry: AssignmentEntry,
): Digest {
  assertDigest(previous, "Previous assignment ledger digest");
  if (!Number.isSafeInteger(entry.recordSeq) || entry.recordSeq <= 0) {
    throw new TypeError("Assignment record sequence must be a positive safe integer");
  }
  return protocolDigest("AssignmentLedgerStep", 1, {
    previous,
    entry: snapshot(entry, "Assignment entry"),
  });
}

export function validateConversationInteractionOutcome(
  input: unknown,
): ConversationInteractionOutcome {
  const outcome = snapshot(input, "Conversation interaction outcome") as Record<
    string,
    unknown
  >;
  assertObject(outcome, "Conversation interaction outcome");
  switch (outcome.t) {
    case "answered": {
      assertExactKeys(
        outcome,
        ["authority", "by", "decision", "t"],
        "Answered interaction outcome",
      );
      assertObject(outcome.authority, "Interaction answer authority");
      assertExactKeys(
        outcome.authority,
        ["ticketId", "via"],
        "Interaction answer authority",
      );
      if (outcome.authority.via !== "surface-ticket") {
        throw new TypeError("Conversation interactions require a surface ticket");
      }
      assertIdentifier(outcome.authority.ticketId, "Interaction ticketId");
      assertObject(outcome.decision, "Interaction decision");
      assertExactKeys(
        outcome.decision,
        ["allowed", ...(outcome.decision.reason === undefined ? [] : ["reason"])],
        "Interaction decision",
      );
      if (typeof outcome.decision.allowed !== "boolean") {
        throw new TypeError("Interaction decision allowed must be boolean");
      }
      if (outcome.decision.reason !== undefined) {
        if (typeof outcome.decision.reason !== "string") {
          throw new TypeError("Interaction decision reason must be a string");
        }
      }
      assertIdentifier(outcome.by, "Interaction responder");
      break;
    }
    case "auto-resolved":
      assertExactKeys(
        outcome,
        ["decision", "reason", "t"],
        "Auto-resolved interaction outcome",
      );
      if (
        outcome.decision !== "denied" ||
        (outcome.reason !== "no-interactive-surface" &&
          outcome.reason !== "policy-fail-closed")
      ) {
        throw new TypeError("Auto-resolved interaction outcome is invalid");
      }
      break;
    case "cancelled":
      assertExactKeys(outcome, ["t", "via"], "Cancelled interaction outcome");
      if (
        outcome.via !== "cancel-fence" &&
        outcome.via !== "abort-ticket" &&
        outcome.via !== "run-end" &&
        outcome.via !== "backpressure"
      ) {
        throw new TypeError("Cancelled interaction outcome is invalid");
      }
      break;
    case "expired":
      assertExactKeys(outcome, ["t"], "Expired interaction outcome");
      break;
    default:
      throw new TypeError("Conversation interaction outcome kind is invalid");
  }
  return outcome as ConversationInteractionOutcome;
}

export function validateConversationInteractionMirrorEntry(
  input: unknown,
): ConversationInteractionMirrorEntry {
  const entry = snapshot(input, "Conversation interaction mirror entry") as Record<
    string,
    unknown
  >;
  assertObject(entry, "Conversation interaction mirror entry");
  assertExactKeys(
    entry,
    ["at", "kind", "outcome", "requestId", "seq"],
    "Conversation interaction mirror entry",
  );
  if (!Number.isSafeInteger(entry.seq) || (entry.seq as number) <= 0) {
    throw new TypeError("Interaction mirror sequence must be a positive safe integer");
  }
  assertIdentifier(entry.requestId, "Interaction requestId");
  if (entry.kind !== "allow-once") {
    throw new TypeError("Conversation interaction kind must be allow-once");
  }
  validateConversationInteractionOutcome(entry.outcome);
  assertCanonicalTime(entry.at, "Interaction mirror time");
  return entry as ConversationInteractionMirrorEntry;
}

function assertConversationEnvelope(
  envelope: UnsignedConversationEnvelope | ConversationEnvelope,
  verifier: ProtocolSignatureVerifier,
  verifyEnvelopeSignature: boolean,
): asserts envelope is ConversationEnvelope {
  assertExactKeys(
    envelope,
    [
      "assignmentId",
      "capabilities",
      "dependencyArtifacts",
      "execution",
      "executorId",
      "issuedAt",
      "manifest",
      "permissionLease",
      "resourceLease",
      ...(verifyEnvelopeSignature ? ["signature"] : []),
      "v",
      "work",
    ],
    "Dispatch envelope",
  );
  assertVersion(envelope.v, "Dispatch envelope");
  if (envelope.execution !== "conversation" || envelope.work.t !== "conversation") {
    throw new TypeError("Dispatch envelope must contain conversation work");
  }
  assertIdentifier(envelope.assignmentId, "Dispatch assignmentId");
  assertIdentifier(envelope.executorId, "Dispatch executorId");
  assertCanonicalTime(envelope.issuedAt, "Dispatch issuedAt");
  assertManifest(envelope.manifest);
  assertConversationWork(envelope.work);
  assertPermissionLease(envelope.permissionLease, verifier);
  assertCapabilities(envelope.capabilities, verifier);
  assertResourceLease(envelope.resourceLease, verifier);
  assertArtifactRefs(envelope.dependencyArtifacts, "Dispatch dependencies");

  const work = envelope.work;
  const manifest = envelope.manifest;
  if (
    manifest.baseRef.execution !== "conversation" ||
    manifest.baseRef.conversationId !== work.conversationId ||
    manifest.baseRef.baseRevision !== work.baseRevision
  ) {
    throw new TypeError("Dispatch manifest does not bind the conversation baseline");
  }
  const permission = envelope.permissionLease;
  if (
    permission.binding.execution !== "conversation" ||
    permission.binding.runId !== work.runId ||
    permission.binding.conversationId !== work.conversationId ||
    permission.binding.ownerEpoch !== work.ownerEpoch ||
    permission.assignmentId !== envelope.assignmentId ||
    permission.executorId !== envelope.executorId
  ) {
    throw new TypeError("Permission lease does not bind the dispatch");
  }
  for (const capability of envelope.capabilities) {
    if (
      capability.scope.execution !== "conversation" ||
      capability.scope.conversationId !== work.conversationId ||
      capability.ownerEpoch !== work.ownerEpoch ||
      capability.assignmentId !== envelope.assignmentId ||
      capability.executorId !== envelope.executorId
    ) {
      throw new TypeError("Authority capability does not bind the dispatch");
    }
  }
  const lease = envelope.resourceLease;
  if (
    lease.workload.kind !== "run" ||
    lease.workload.id !== work.runId ||
    lease.scopeBinding.kind !== "conversation" ||
    lease.scopeBinding.conversationId !== work.conversationId ||
    lease.scopeBinding.ownerEpoch !== work.ownerEpoch ||
    lease.audience.executorId !== envelope.executorId ||
    lease.activation.kind !== "assignment" ||
    lease.activation.assignmentId !== envelope.assignmentId
  ) {
    throw new TypeError("Resource lease does not bind the dispatch");
  }
  const capIds = envelope.capabilities.map((capability) => capability.capId);
  assertSortedUnique(capIds, "Dispatch capability ids");

  if (verifyEnvelopeSignature) {
    const signed = envelope as ConversationEnvelope;
    assertSignature(signed.signature, "Dispatch signature");
    verifier.verify(
      "DispatchEnvelope",
      1,
      withoutField(signed, "signature"),
      signed.signature,
    );
  }
}

function assertManifest(manifest: ConversationEnvelope["manifest"]): void {
  assertExactKeys(
    manifest,
    ["baseRef", "credentialBindings", "digest", "environment", "requires", "v"],
    "Execution manifest",
  );
  assertVersion(manifest.v, "Execution manifest");
  assertExactKeys(
    manifest.baseRef,
    ["baseRevision", "conversationId", "execution"],
    "Manifest base reference",
  );
  if (manifest.baseRef.execution !== "conversation") {
    throw new TypeError("Manifest base reference must be a conversation");
  }
  assertIdentifier(manifest.baseRef.conversationId, "Manifest conversationId");
  assertNonNegativeInteger(manifest.baseRef.baseRevision, "Manifest baseRevision");
  assertExactKeys(
    manifest.requires,
    [
      "modelProfileRev",
      "permissionSnapshotVersion",
      "policyRev",
      "promptAssetsRev",
      "rubricsRev",
      "runtimeConfigRev",
      "skillsRev",
    ],
    "Manifest requirements",
  );
  for (const value of Object.values(manifest.requires)) {
    assertNonNegativeInteger(value, "Manifest requirement revision");
  }
  assertExactKeys(
    manifest.environment,
    ["credentialBindings", "deviceId", "evidenceKinds", "workspace"],
    "Manifest environment",
    true,
  );
  if (manifest.environment.deviceId !== undefined) {
    assertIdentifier(manifest.environment.deviceId, "Environment deviceId");
  }
  if (manifest.environment.workspace !== undefined) {
    assertExactKeys(
      manifest.environment.workspace,
      ["bindingRef", "deviceId", "workspaceBindingRevision"],
      "Manifest workspace",
    );
    assertIdentifier(manifest.environment.workspace.deviceId, "Workspace deviceId");
    assertIdentifier(manifest.environment.workspace.bindingRef, "Workspace bindingRef");
    assertNonNegativeInteger(
      manifest.environment.workspace.workspaceBindingRevision,
      "Workspace binding revision",
    );
  }
  for (const binding of manifest.credentialBindings) {
    assertExactKeys(binding, ["bindingId", "revision", "service"], "Credential binding");
    assertIdentifier(binding.service, "Credential service");
    assertIdentifier(binding.bindingId, "Credential bindingId");
    assertNonNegativeInteger(binding.revision, "Credential binding revision");
  }
  const expected = protocolDigest(
    "ExecutionManifest",
    1,
    withoutField(manifest, "digest"),
  );
  if (manifest.digest !== expected) {
    throw new TypeError("Execution manifest digest is invalid");
  }
}

function assertConversationWork(work: ConversationEnvelope["work"]): void {
  assertExactKeys(
    work,
    [
      "baseRevision",
      "controlContext",
      "conversationId",
      "ingress",
      "ownerEpoch",
      "runId",
      "t",
      "windowInput",
    ],
    "Conversation dispatch",
  );
  assertIdentifier(work.runId, "Dispatch runId");
  assertIdentifier(work.conversationId, "Dispatch conversationId");
  assertNonNegativeInteger(work.ownerEpoch, "Dispatch ownerEpoch");
  assertNonNegativeInteger(work.baseRevision, "Dispatch baseRevision");
  const ingressKeys =
    work.ingress.kind === "channel"
      ? [
          "deviceId",
          "ingressId",
          "kind",
          "receivedAt",
          "replyTarget",
          "responder",
          "surfacePrincipal",
          "turnOrigin",
        ]
      : [
          "deviceId",
          "ingressId",
          "kind",
          "receivedAt",
          "surfacePrincipal",
          "turnOrigin",
        ];
  assertExactKeys(work.ingress, ingressKeys, "Dispatch ingress", true);
  if (work.ingress.kind !== "first-party" && work.ingress.kind !== "channel") {
    throw new TypeError("Dispatch ingress kind is invalid");
  }
  assertIdentifier(work.ingress.surfacePrincipal, "Ingress surfacePrincipal");
  assertIdentifier(work.ingress.deviceId, "Ingress deviceId");
  assertIdentifier(work.ingress.ingressId, "Ingress ingressId");
  assertCanonicalTime(work.ingress.receivedAt, "Ingress receivedAt");
  if (work.ingress.kind === "channel") {
    assertExactKeys(
      work.ingress.responder,
      ["channelId", "platformSubject", "tenant"],
      "Channel responder",
      true,
    );
    assertExactKeys(
      work.ingress.replyTarget,
      ["channelId", "threadId", "to"],
      "Channel reply target",
      true,
    );
  }
  if (work.windowInput.t === "full") {
    assertExactKeys(work.windowInput, ["messages", "t", "windowEpoch"], "Full window");
    assertNonNegativeInteger(work.windowInput.windowEpoch, "Window epoch");
    if (!Array.isArray(work.windowInput.messages)) {
      assertExactKeys(work.windowInput.messages, ["ref"], "Window artifact container");
      assertArtifactRef(work.windowInput.messages.ref, "Window artifact");
    }
  } else if (work.windowInput.t === "delta") {
    assertExactKeys(
      work.windowInput,
      ["appended", "baseDigest", "baseEpoch", "t", "targetDigest", "targetEpoch"],
      "Delta window",
    );
    assertNonNegativeInteger(work.windowInput.baseEpoch, "Window base epoch");
    assertNonNegativeInteger(work.windowInput.targetEpoch, "Window target epoch");
    assertDigest(work.windowInput.baseDigest, "Window base digest");
    assertDigest(work.windowInput.targetDigest, "Window target digest");
  } else {
    throw new TypeError("Window input kind is invalid");
  }
  for (const block of work.controlContext) {
    assertExactKeys(block, ["block", "source"], "Control context block");
    assertIdentifier(block.source, "Control context source");
    if (typeof block.block !== "string") {
      throw new TypeError("Control context block must be a string");
    }
  }
}

function assertPermissionLease(
  lease: ConversationEnvelope["permissionLease"],
  verifier: ProtocolSignatureVerifier,
): void {
  assertExactKeys(
    lease,
    [
      "assignmentId",
      "binding",
      "controlLeaseId",
      "executorId",
      "expiry",
      "issuedAt",
      "signature",
      "snapshotDigest",
      "snapshotVersion",
      "v",
    ],
    "Permission snapshot lease",
  );
  assertVersion(lease.v, "Permission snapshot lease");
  assertExactKeys(
    lease.binding,
    ["conversationId", "execution", "ownerEpoch", "runId"],
    "Permission binding",
  );
  assertNonNegativeInteger(lease.snapshotVersion, "Permission snapshotVersion");
  assertDigest(lease.snapshotDigest, "Permission snapshotDigest");
  assertIdentifier(lease.controlLeaseId, "Permission controlLeaseId");
  assertCanonicalTime(lease.issuedAt, "Permission issuedAt");
  assertCanonicalTime(lease.expiry, "Permission expiry");
  assertSignature(lease.signature, "Permission signature");
  verifier.verify(
    "PermissionSnapshotLease",
    1,
    withoutField(lease, "signature"),
    lease.signature,
  );
}

function assertCapabilities(
  capabilities: ConversationEnvelope["capabilities"],
  verifier: ProtocolSignatureVerifier,
): void {
  if (capabilities.length === 0) {
    throw new TypeError("Dispatch must carry at least one authority capability");
  }
  for (const capability of capabilities) {
    assertExactKeys(
      capability,
      [
        "assignmentId",
        "capId",
        "executorId",
        "expiry",
        "issuedAt",
        "methods",
        "ownerEpoch",
        "resources",
        "scope",
        "signature",
        "v",
      ],
      "Authority capability",
    );
    assertVersion(capability.v, "Authority capability");
    assertExactKeys(capability.scope, ["conversationId", "execution"], "Capability scope");
    assertIdentifier(capability.capId, "Capability capId");
    assertCanonicalTime(capability.issuedAt, "Capability issuedAt");
    assertCanonicalTime(capability.expiry, "Capability expiry");
    assertUniqueIdentifiers(capability.methods, "Capability methods");
    assertUniqueIdentifiers(capability.resources, "Capability resources");
    assertSignature(capability.signature, "Capability signature");
    verifier.verify(
      "AuthorityCapability",
      1,
      withoutField(capability, "signature"),
      capability.signature,
    );
  }
}

function assertResourceLease(
  lease: ConversationEnvelope["resourceLease"],
  verifier: ProtocolSignatureVerifier,
): void {
  assertExactKeys(
    lease,
    [
      "activation",
      "admissionClass",
      "audience",
      "budget",
      "delegation",
      "digest",
      "domain",
      "expiry",
      "issuedAt",
      "reservationId",
      "scopeBinding",
      "signature",
      "v",
      "workload",
    ],
    "Assignment resource lease",
    true,
  );
  assertVersion(lease.v, "Assignment resource lease");
  assertExactKeys(lease.workload, ["attempt", "id", "kind"], "Lease workload");
  assertExactKeys(
    lease.scopeBinding,
    ["conversationId", "kind", "ownerEpoch"],
    "Lease scope binding",
  );
  assertExactKeys(lease.audience, ["executorId", "model", "provider"], "Lease audience", true);
  assertExactKeys(lease.budget, ["maxCalls", "maxCostMinor", "maxTokens"], "Lease budget", true);
  assertExactKeys(lease.activation, ["assignmentId", "kind"], "Lease activation");
  assertIdentifier(lease.reservationId, "Lease reservationId");
  assertNonNegativeInteger(lease.workload.attempt, "Lease workload attempt");
  assertCanonicalTime(lease.issuedAt, "Lease issuedAt");
  assertCanonicalTime(lease.expiry, "Lease expiry");
  assertDigest(lease.digest, "Lease digest");
  const expected = protocolDigest(
    "ResourceLease",
    1,
    withoutFields(lease, ["digest", "signature"]),
  );
  if (lease.digest !== expected) {
    throw new TypeError("Assignment resource lease digest is invalid");
  }
  assertSignature(lease.signature, "Lease signature");
  verifier.verify(
    "ResourceLease",
    1,
    withoutField(lease, "signature"),
    lease.signature,
  );
}

function assertActivationPayload(
  payload: AssignmentActivationPayload<"conversation">,
  envelope: ConversationEnvelope,
  dispatchRef: ArtifactRef,
): void {
  assertVersion(payload.v, "Assignment activation payload");
  assertExactKeys(
    payload.ref,
    ["conversationId", "execution", "ownerEpoch", "runId"],
    "Activation execution reference",
  );
  assertArtifactRef(payload.dispatchRef, "Activation dispatchRef");
  assertExactKeys(payload.commit, ["envelopeDigest", "lsn"], "Activation commit");
  assertExactKeys(payload.reservation, ["attempt", "reservationId"], "Activation reservation");
  assertCanonicalTime(payload.issuedAt, "Activation issuedAt");
  assertDigest(payload.commit.envelopeDigest, "Activation commit digest");
  if (!Number.isSafeInteger(payload.commit.lsn) || payload.commit.lsn <= 0) {
    throw new TypeError("Activation commit LSN must be a positive safe integer");
  }
  assertSortedUnique(payload.capIds, "Activation capability ids");
  const expectedRef = {
    execution: "conversation" as const,
    runId: envelope.work.runId,
    conversationId: envelope.work.conversationId,
    ownerEpoch: envelope.work.ownerEpoch,
  };
  if (canonicalize(payload.ref) !== canonicalize(expectedRef)) {
    throw new TypeError("Activation execution reference does not bind the dispatch");
  }
  if (
    payload.assignmentId !== envelope.assignmentId ||
    payload.executorId !== envelope.executorId ||
    canonicalize(payload.dispatchRef) !== canonicalize(dispatchRef) ||
    payload.manifestDigest !== envelope.manifest.digest ||
    payload.permissionLeaseDigest !== permissionSnapshotLeaseDigest(envelope) ||
    canonicalize(payload.capIds) !==
      canonicalize(envelope.capabilities.map((capability) => capability.capId)) ||
    payload.reservation.reservationId !== envelope.resourceLease.reservationId ||
    payload.reservation.attempt !== envelope.resourceLease.workload.attempt
  ) {
    throw new TypeError("Assignment activation payload does not bind the dispatch");
  }
}

function assertArtifactRefs(values: readonly ArtifactRef[], label: string): void {
  const digests = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    assertArtifactRef(value, label);
    if (digests.has(value.digest)) {
      throw new TypeError(`${label} must not contain duplicate digests`);
    }
    digests.add(value.digest);
    const previous = values[index - 1];
    if (
      previous &&
      (previous.digest > value.digest ||
        (previous.digest === value.digest && previous.bytes >= value.bytes))
    ) {
      throw new TypeError(`${label} must be sorted by digest and byte count`);
    }
  }
}

function assertArtifactRef(value: ArtifactRef, label: string): void {
  assertExactKeys(value, ["bytes", "digest"], label);
  assertDigest(value.digest, `${label} digest`);
  assertNonNegativeInteger(value.bytes, `${label} bytes`);
}

function assertSignature(value: Signature, label: string): void {
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertIdentifier(value.alg, `${label} algorithm`);
  assertIdentifier(value.keyId, `${label} keyId`);
  assertIdentifier(value.sig, `${label} bytes`);
}

function assertVersion(value: number, label: string): void {
  if (value !== 1) throw new TypeError(`${label} version must be 1`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertDigest(value: string, label: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (const value of values) assertIdentifier(value, label);
  for (let index = 1; index < values.length; index += 1) {
    if (
      Buffer.compare(
        Buffer.from(values[index - 1]!, "utf8"),
        Buffer.from(values[index]!, "utf8"),
      ) >= 0
    ) {
      throw new TypeError(`${label} must be byte-sorted with no duplicates`);
    }
  }
}

function assertUniqueIdentifiers(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertIdentifier(value, label);
    if (seen.has(value)) {
      throw new TypeError(`${label} must not contain duplicates`);
    }
    seen.add(value);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
  optional = false,
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (optional) {
    if (keys.some((key) => !allowed.includes(key))) {
      throw new TypeError(`${label} contains an unknown field`);
    }
    return;
  }
  if (canonicalize(keys) !== canonicalize(allowed)) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function withoutField<T extends object, K extends keyof T>(
  value: T,
  field: K,
): Omit<T, K> {
  const output = { ...value };
  delete output[field];
  return output;
}

function withoutFields<T extends object, K extends keyof T>(
  value: T,
  fields: readonly K[],
): Omit<T, K> {
  const output = { ...value };
  for (const field of fields) delete output[field];
  return output;
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}
