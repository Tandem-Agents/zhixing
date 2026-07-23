import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  AssignmentArtifactTransferGrant,
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentTerminationProof,
  AuthorityEpochRef,
  CancelProofBody,
  ChannelResponderRef,
  ConversationInvocation,
  ControlLease,
  DispatchConflictProof,
  DispatchEnvelope,
  DispatchRejectionProof,
  DispatchResult,
  Digest,
  ExecutionKind,
  InteractionMirrorBatch,
  InteractionMirrorEntry,
  IngressContext,
  LedgerEvidencePage,
  LedgerSnapshot,
  Signature,
  SupersedeProof,
} from "../contracts/index.js";
import {
  MAX_ASSIGNMENT_ARTIFACT_GRANT_BYTES,
  MAX_ASSIGNMENT_ARTIFACT_GRANT_REFS,
  MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS,
} from "../contracts/authorization.js";
import type { ConfirmationDecision } from "../confirmation/types.js";
import {
  MAX_CONVERSATION_QUESTION_BYTES,
  MAX_LEDGER_EVIDENCE_PAGE_BYTES,
  MAX_LEDGER_EVIDENCE_PAGE_ENTRIES,
} from "../contracts/protocol.js";
import { validateAuthorityError as validateAuthorityErrorContract } from "./contract-validation.js";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import { validateStagedMutationRecord } from "./commit.js";
import { validateJobCommitFence } from "./job.js";
import { validateInteractionDisplay } from "./interaction-display.js";
import { validateExecutionManifest } from "./manifest.js";
import { validateReservableResourceLease } from "./resource-governor.js";
import { assertProtocolIdentifier as assertIdentifier } from "./validation.js";
import { validateMessages } from "./values.js";
import {
  validateAuthorityCapability,
  validateControlLease,
  validatePermissionSnapshotLease,
} from "./authority.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

type ConversationEnvelope = Extract<
  DispatchEnvelope,
  { execution: "conversation" }
>;

type JobEnvelope = Extract<DispatchEnvelope, { execution: "job" }>;

export interface ConversationActivationBinding {
  readonly runId: string;
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly dispatchRef: ArtifactRef;
  readonly manifestDigest: Digest;
  readonly permissionLeaseDigest: Digest;
  readonly capIds: readonly string[];
  readonly reservation: {
    readonly reservationId: string;
    readonly attempt: number;
  };
}

export interface JobActivationBinding {
  readonly jobRunId: string;
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly dispatchRef: ArtifactRef;
  readonly manifestDigest: Digest;
  readonly permissionLeaseDigest: Digest;
  readonly capIds: readonly string[];
  readonly reservation: {
    readonly reservationId: string;
    readonly attempt: number;
  };
}

export interface DispatchControlBinding {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly authority: AuthorityEpochRef;
  readonly ownerDeviceId: string;
  readonly controlLease: ControlLease;
}

type UnsignedSupersedeProof = SupersedeProof extends infer Proof
  ? Proof extends unknown
    ? Omit<Proof, "signature">
    : never
  : never;

type UnsignedCancelProof = CancelProofBody extends infer Proof
  ? Proof extends unknown
    ? Omit<Proof, "signature">
    : never
  : never;

export type UnsignedConversationEnvelope = Omit<
  ConversationEnvelope,
  "signature"
>;

export type UnsignedJobEnvelope = Omit<JobEnvelope, "signature">;

export type ConversationInteractionOutcome =
  | {
      readonly t: "answered";
      readonly authority: { readonly via: "surface-ticket"; readonly ticketId: string };
      readonly decision: { readonly allowed: boolean; readonly reason?: string };
      readonly decisionDigest: Digest;
      readonly by: string;
    }
  | Exclude<InteractionMirrorEntry["outcome"], { t: "answered" }>;

export type ConversationInteractionMirrorEntry = Omit<
  InteractionMirrorEntry,
  "outcome"
> & { readonly outcome: ConversationInteractionOutcome };

export type ConversationInteractionMirrorBatch = Omit<
  InteractionMirrorBatch,
  "entries"
> & { readonly entries: ConversationInteractionMirrorEntry[] };

export function confirmationDecisionDigest(
  requestId: string,
  decision: ConfirmationDecision,
): Digest {
  assertIdentifier(requestId, "Confirmation request id");
  return protocolDigest("ConfirmationDecision", 1, { requestId, decision });
}

export interface DispatchEnvelopeArtifact {
  readonly bytes: Uint8Array;
  readonly ref: ArtifactRef;
}

export interface AssignmentLedgerValidationState {
  readonly assignmentId: string;
  lastSeq: number;
  chainDigest: Digest;
  phase: LedgerSnapshot["phase"];
  received: boolean;
  started: boolean;
  control?: {
    readonly authority: AuthorityEpochRef;
    readonly ownerDeviceId: string;
    readonly controlLeaseId: string;
    readonly renewalSeq: number;
  };
  readonly aborts: Set<string>;
  readonly requestedInteractions: Set<string>;
  readonly pendingInteractions: Set<string>;
  readonly unmirroredFinished: Map<
    number,
    { readonly ordinal: number; readonly mirrorDigest: Digest }
  >;
  finishedInteractionCount: number;
  interactionMirrorDigest: Digest;
  mirroredInteractionOrdinal: number;
  stagedMutationCount: number;
  readonly mutationRequestIds: Set<string>;
  sideEffectCount: number;
  readonly openSideEffects: Set<number>;
  mirroredUpTo: number;
}

export function createAssignmentLedgerValidationState(
  assignmentId: string,
): AssignmentLedgerValidationState {
  assertIdentifier(assignmentId, "Assignment id");
  return {
    assignmentId,
    lastSeq: 0,
    chainDigest: assignmentLedgerSeed(assignmentId),
    phase: "unknown",
    received: false,
    started: false,
    aborts: new Set(),
    requestedInteractions: new Set(),
    pendingInteractions: new Set(),
    unmirroredFinished: new Map(),
    finishedInteractionCount: 0,
    interactionMirrorDigest: interactionMirrorSeed(assignmentId),
    mirroredInteractionOrdinal: 0,
    stagedMutationCount: 0,
    mutationRequestIds: new Set(),
    sideEffectCount: 0,
    openSideEffects: new Set(),
    mirroredUpTo: 0,
  };
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

export function createSignedJobEnvelope(
  input: UnsignedJobEnvelope,
  signer: ProtocolSigner,
  verifier: ProtocolSignatureVerifier,
): JobEnvelope {
  const unsigned = snapshot(input, "Dispatch envelope");
  assertJobEnvelope(unsigned, verifier, false);
  const envelope = snapshot(
    {
      ...unsigned,
      signature: signer.sign("DispatchEnvelope", 1, unsigned),
    },
    "Signed dispatch envelope",
  ) as JobEnvelope;
  assertJobEnvelope(envelope, verifier, true);
  return envelope;
}

export function validateJobEnvelope(
  input: JobEnvelope,
  verifier: ProtocolSignatureVerifier,
): JobEnvelope {
  const envelope = snapshot(input, "Dispatch envelope") as JobEnvelope;
  assertJobEnvelope(envelope, verifier, true);
  return envelope;
}

export function validateDispatchControlBinding(
  input: DispatchEnvelope,
  verifier: ProtocolSignatureVerifier,
): DispatchControlBinding {
  const envelope = snapshot(input, "Dispatch control binding") as DispatchEnvelope;
  assertObject(envelope, "Dispatch control binding");
  assertIdentifier(envelope.assignmentId, "Dispatch assignmentId");
  assertIdentifier(envelope.executorId, "Dispatch executorId");
  assertSignature(envelope.signature, "Dispatch signature");
  const controlLease = validateControlLease(envelope.controlLease, verifier);
  if (
    controlLease.assignmentId !== envelope.assignmentId ||
    envelope.signature.keyId !== controlLease.signature.keyId
  ) {
    throw new TypeError("Dispatch signer does not own its control lease");
  }
  verifier.verify(
    "DispatchEnvelope",
    1,
    withoutField(envelope, "signature"),
    envelope.signature,
  );
  return snapshot(
    {
      assignmentId: envelope.assignmentId,
      executorId: envelope.executorId,
      authority: controlLease.authority,
      ownerDeviceId: envelope.signature.keyId,
      controlLease,
    },
    "Dispatch control binding",
  );
}

export function dispatchEnvelopeArtifact(
  envelope: DispatchEnvelope,
): DispatchEnvelopeArtifact {
  const bytes = Buffer.from(canonicalize(envelope), "utf8");
  return {
    bytes,
    ref: { digest: byteDigest(bytes), bytes: bytes.byteLength },
  };
}

export function dispatchEnvelopeDigest(envelope: DispatchEnvelope): Digest {
  return protocolDigest(
    "DispatchEnvelope",
    1,
    withoutField(envelope, "signature"),
  );
}

export function controlLeaseBindsDispatchEnvelope(
  lease: ControlLease,
  envelope: DispatchEnvelope,
): boolean {
  return (
    lease.assignmentId === envelope.assignmentId &&
    lease.controlLeaseId === envelope.controlLease.controlLeaseId &&
    lease.signature.keyId === envelope.controlLease.signature.keyId &&
    canonicalize(lease.authority) === canonicalize(envelope.controlLease.authority)
  );
}

export function permissionSnapshotLeaseDigest(
  envelope: DispatchEnvelope,
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
  const payload = buildConversationActivationPayloadFromBinding({
    binding: {
      runId: envelope.work.runId,
      conversationId: envelope.work.conversationId,
      ownerEpoch: envelope.work.ownerEpoch,
      assignmentId: envelope.assignmentId,
      executorId: envelope.executorId,
      dispatchRef: input.dispatchRef,
      manifestDigest: envelope.manifest.digest,
      permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
      capIds: envelope.capabilities.map((capability) => capability.capId),
      reservation: {
        reservationId: envelope.resourceLease.reservationId,
        attempt: envelope.resourceLease.workload.attempt,
      },
    },
    commit: input.commit,
    issuedAt: input.issuedAt,
  });
  assertActivationPayload(payload, envelope, input.dispatchRef);
  return payload;
}

export function buildConversationActivationPayloadFromBinding(input: {
  readonly binding: ConversationActivationBinding;
  readonly commit: { readonly lsn: number; readonly envelopeDigest: Digest };
  readonly issuedAt: string;
}): AssignmentActivationPayload<"conversation"> {
  const { binding } = input;
  const payload: AssignmentActivationPayload<"conversation"> = {
    v: 1,
    ref: {
      execution: "conversation",
      runId: binding.runId,
      conversationId: binding.conversationId,
      ownerEpoch: binding.ownerEpoch,
    },
    assignmentId: binding.assignmentId,
    executorId: binding.executorId,
    dispatchRef: snapshot(binding.dispatchRef, "Dispatch reference"),
    manifestDigest: binding.manifestDigest,
    permissionLeaseDigest: binding.permissionLeaseDigest,
    capIds: [...binding.capIds],
    reservation: {
      reservationId: binding.reservation.reservationId,
      attempt: binding.reservation.attempt,
    },
    commit: snapshot(input.commit, "Assignment commit"),
    issuedAt: input.issuedAt,
  };
  assertActivationPayloadShape(payload);
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

export function validateAssignmentActivationProof(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AssignmentActivationPayload {
  const activation = snapshot(
    input,
    "Assignment activation proof",
  ) as AssignmentActivationProof;
  assertObject(activation, "Assignment activation proof");
  assertObject(activation.ref, "Activation execution reference");
  assertObject(activation.commit, "Activation commit");
  assertObject(activation.reservation, "Activation reservation");
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
  const payload = withoutField(activation, "signature") as AssignmentActivationPayload;
  if (payload.ref.execution === "conversation") {
    assertActivationPayloadShape(
      payload as AssignmentActivationPayload<"conversation">,
    );
  } else if (payload.ref.execution === "job") {
    assertJobActivationPayloadShape(payload as AssignmentActivationPayload<"job">);
  } else {
    throw new TypeError("Activation execution reference kind is invalid");
  }
  verifier.verify(
    "AssignmentActivationProof",
    1,
    payload,
    activation.signature,
  );
  return snapshot(payload, "Assignment activation payload");
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
  const payload = validateAssignmentActivationProof(
    activation,
    input.verifier,
  ) as AssignmentActivationPayload<"conversation">;
  if (activation.signature.keyId !== input.envelope.signature.keyId) {
    throw new TypeError("Assignment activation signer does not own the dispatch");
  }
  assertActivationPayload(payload, input.envelope, input.dispatchRef);
  return snapshot(payload, "Assignment activation payload");
}

export function buildJobActivationPayload(input: {
  readonly envelope: JobEnvelope;
  readonly dispatchRef: ArtifactRef;
  readonly commit: { readonly lsn: number; readonly envelopeDigest: Digest };
  readonly issuedAt: string;
}): AssignmentActivationPayload<"job"> {
  const { envelope } = input;
  const payload = buildJobActivationPayloadFromBinding({
    binding: {
      jobRunId: envelope.work.jobRunId,
      taskId: envelope.work.taskId,
      anchorEpoch: envelope.work.fence.anchorEpoch,
      assignmentId: envelope.assignmentId,
      executorId: envelope.executorId,
      dispatchRef: input.dispatchRef,
      manifestDigest: envelope.manifest.digest,
      permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
      capIds: envelope.capabilities.map((capability) => capability.capId),
      reservation: {
        reservationId: envelope.resourceLease.reservationId,
        attempt: envelope.resourceLease.workload.attempt,
      },
    },
    commit: input.commit,
    issuedAt: input.issuedAt,
  });
  assertJobActivationPayload(payload, envelope, input.dispatchRef);
  return payload;
}

export function buildJobActivationPayloadFromBinding(input: {
  readonly binding: JobActivationBinding;
  readonly commit: { readonly lsn: number; readonly envelopeDigest: Digest };
  readonly issuedAt: string;
}): AssignmentActivationPayload<"job"> {
  const { binding } = input;
  const payload: AssignmentActivationPayload<"job"> = {
    v: 1,
    ref: {
      execution: "job",
      jobRunId: binding.jobRunId,
      taskId: binding.taskId,
      anchorEpoch: binding.anchorEpoch,
    },
    assignmentId: binding.assignmentId,
    executorId: binding.executorId,
    dispatchRef: snapshot(binding.dispatchRef, "Dispatch reference"),
    manifestDigest: binding.manifestDigest,
    permissionLeaseDigest: binding.permissionLeaseDigest,
    capIds: [...binding.capIds],
    reservation: {
      reservationId: binding.reservation.reservationId,
      attempt: binding.reservation.attempt,
    },
    commit: snapshot(input.commit, "Assignment commit"),
    issuedAt: input.issuedAt,
  };
  assertJobActivationPayloadShape(payload);
  return snapshot(payload, "Assignment activation payload");
}

export function signJobActivation(
  payload: AssignmentActivationPayload<"job">,
  signer: ProtocolSigner,
): AssignmentActivationProof<"job"> {
  const canonicalPayload = snapshot(payload, "Assignment activation payload");
  return snapshot(
    {
      ...canonicalPayload,
      signature: signer.sign("AssignmentActivationProof", 1, canonicalPayload),
    },
    "Assignment activation proof",
  );
}

export function validateJobActivation(input: {
  readonly envelope: JobEnvelope;
  readonly activation: AssignmentActivationProof<"job">;
  readonly dispatchRef: ArtifactRef;
  readonly verifier: ProtocolSignatureVerifier;
}): AssignmentActivationPayload<"job"> {
  const activation = snapshot(
    input.activation,
    "Assignment activation proof",
  ) as AssignmentActivationProof<"job">;
  const payload = validateAssignmentActivationProof(
    activation,
    input.verifier,
  ) as AssignmentActivationPayload<"job">;
  if (activation.signature.keyId !== input.envelope.signature.keyId) {
    throw new TypeError("Assignment activation signer does not own the dispatch");
  }
  assertJobActivationPayload(payload, input.envelope, input.dispatchRef);
  return snapshot(payload, "Assignment activation payload");
}

export function assignmentActivationDigest<E extends ExecutionKind>(
  payload: AssignmentActivationPayload<E>,
): Digest {
  return protocolDigest("AssignmentActivationPayload", 1, payload);
}

export function createSignedAssignmentArtifactTransferGrant(input: {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly capId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly direction: AssignmentArtifactTransferGrant["direction"];
  readonly activationDigest: Digest;
  readonly refs: readonly ArtifactRef[];
  readonly issuedAt: string;
  readonly expiry: string;
  readonly signer: ProtocolSigner;
}): AssignmentArtifactTransferGrant {
  const refs = [...input.refs].sort((left, right) =>
    Buffer.compare(Buffer.from(left.digest, "utf8"), Buffer.from(right.digest, "utf8")) ||
    left.bytes - right.bytes);
  const payload: Omit<AssignmentArtifactTransferGrant, "signature"> = {
    v: 1,
    assignmentId: input.assignmentId,
    executorId: input.executorId,
    capId: input.capId,
    sourceDeviceId: input.sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    direction: input.direction,
    activationDigest: input.activationDigest,
    refs,
    totalBytes: refs.reduce((total, ref) => total + ref.bytes, 0),
    issuedAt: input.issuedAt,
    expiry: input.expiry,
  };
  assertAssignmentArtifactTransferGrantPayload(payload);
  const signature = input.signer.sign("AssignmentArtifactTransferGrant", 1, payload);
  assertSignature(signature, "Assignment artifact transfer grant signature");
  if (signature.keyId !== input.sourceDeviceId) {
    throw new TypeError("Assignment artifact transfer grant signer is not its source device");
  }
  return snapshot({
    ...payload,
    signature,
  }, "Assignment artifact transfer grant");
}

export function validateAssignmentArtifactTransferGrant(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AssignmentArtifactTransferGrant {
  const grant = snapshot(
    input,
    "Assignment artifact transfer grant",
  ) as AssignmentArtifactTransferGrant;
  assertObject(grant, "Assignment artifact transfer grant");
  assertExactKeys(
    grant,
    [
      "activationDigest",
      "assignmentId",
      "capId",
      "direction",
      "executorId",
      "expiry",
      "issuedAt",
      "refs",
      "signature",
      "sourceDeviceId",
      "targetDeviceId",
      "totalBytes",
      "v",
    ],
    "Assignment artifact transfer grant",
  );
  assertSignature(grant.signature, "Assignment artifact transfer grant signature");
  const payload = withoutField(grant, "signature");
  assertAssignmentArtifactTransferGrantPayload(payload);
  verifier.verify(
    "AssignmentArtifactTransferGrant",
    1,
    payload,
    grant.signature,
  );
  if (grant.signature.keyId !== grant.sourceDeviceId) {
    throw new TypeError("Assignment artifact transfer grant signer is not its source device");
  }
  return grant;
}

export function assignmentLedgerSeed(assignmentId: string): Digest {
  assertIdentifier(assignmentId, "Assignment id");
  return protocolDigest("AssignmentLedgerSeed", 1, { assignmentId });
}

export function interactionMirrorSeed(assignmentId: string): Digest {
  assertIdentifier(assignmentId, "Interaction mirror assignment id");
  return protocolDigest("InteractionMirrorSeed", 1, { assignmentId });
}

export function advanceInteractionMirrorDigest(
  previous: Digest,
  entry: Omit<ConversationInteractionMirrorEntry, "at">,
): Digest {
  assertDigest(previous, "Previous interaction mirror digest");
  assertPositiveInteger(entry.ordinal, "Interaction mirror ordinal");
  assertPositiveInteger(entry.seq, "Interaction mirror record sequence");
  assertIdentifier(entry.requestId, "Interaction mirror requestId");
  if (entry.kind !== "allow-once") {
    throw new TypeError("Conversation interaction kind must be allow-once");
  }
  validateConversationInteractionOutcome(entry.outcome);
  return protocolDigest("InteractionMirrorStep", 1, {
    previous,
    entry: snapshot(entry, "Interaction mirror chain entry"),
  });
}

export function createSignedConversationInteractionMirrorBatch(input: {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly previousDigest: Digest;
  readonly entries: readonly ConversationInteractionMirrorEntry[];
  readonly signer: ProtocolSigner;
}): ConversationInteractionMirrorBatch {
  assertIdentifier(input.assignmentId, "Interaction mirror assignment id");
  assertIdentifier(input.executorId, "Interaction mirror executor id");
  assertDigest(input.previousDigest, "Previous interaction mirror digest");
  if (input.entries.length === 0 || input.entries.length > 256) {
    throw new TypeError("Interaction mirror batch must contain between 1 and 256 entries");
  }
  const entries = input.entries.map(validateConversationInteractionMirrorEntry);
  let mirrorDigest = input.previousDigest;
  let previousOrdinal = entries[0]!.ordinal - 1;
  let previousSeq = 0;
  for (const entry of entries) {
    if (entry.ordinal !== previousOrdinal + 1 || entry.seq <= previousSeq) {
      throw new TypeError("Interaction mirror batch is not contiguous and increasing");
    }
    mirrorDigest = advanceInteractionMirrorDigest(
      mirrorDigest,
      withoutField(entry, "at"),
    );
    previousOrdinal = entry.ordinal;
    previousSeq = entry.seq;
  }
  const payload = snapshot(
    {
      v: 1 as const,
      assignmentId: input.assignmentId,
      executorId: input.executorId,
      previousDigest: input.previousDigest,
      entries,
      mirrorDigest,
    },
    "Interaction mirror batch payload",
  );
  const signature = input.signer.sign("InteractionMirrorBatch", 1, payload);
  assertSignature(signature, "Interaction mirror batch signature");
  return snapshot(
    {
      ...payload,
      signature,
    },
    "Signed interaction mirror batch",
  ) as ConversationInteractionMirrorBatch;
}

export function validateConversationInteractionMirrorBatch(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationInteractionMirrorBatch {
  assertObject(input, "Interaction mirror batch");
  if (Array.isArray(input.entries) && input.entries.length > 256) {
    throw new TypeError("Interaction mirror batch exceeds the 256-entry protocol limit");
  }
  const batch = snapshot(input, "Interaction mirror batch") as Record<string, unknown>;
  assertExactKeys(
    batch,
    [
      "assignmentId",
      "entries",
      "executorId",
      "mirrorDigest",
      "previousDigest",
      "signature",
      "v",
    ],
    "Interaction mirror batch",
  );
  assertVersion(batch.v as number, "Interaction mirror batch");
  assertIdentifier(batch.assignmentId, "Interaction mirror assignment id");
  assertIdentifier(batch.executorId, "Interaction mirror executor id");
  assertDigest(batch.previousDigest as string, "Previous interaction mirror digest");
  assertDigest(batch.mirrorDigest as string, "Interaction mirror digest");
  assertSignature(batch.signature as Signature, "Interaction mirror batch signature");
  if (!Array.isArray(batch.entries) || batch.entries.length === 0) {
    throw new TypeError("Interaction mirror batch must contain between 1 and 256 entries");
  }
  const entries = batch.entries.map(validateConversationInteractionMirrorEntry);
  let mirrorDigest = batch.previousDigest as Digest;
  let previousOrdinal = entries[0]!.ordinal - 1;
  let previousSeq = 0;
  for (const entry of entries) {
    if (entry.ordinal !== previousOrdinal + 1 || entry.seq <= previousSeq) {
      throw new TypeError("Interaction mirror batch is not contiguous and increasing");
    }
    mirrorDigest = advanceInteractionMirrorDigest(
      mirrorDigest,
      withoutField(entry, "at"),
    );
    previousOrdinal = entry.ordinal;
    previousSeq = entry.seq;
  }
  if (mirrorDigest !== batch.mirrorDigest) {
    throw new TypeError("Interaction mirror batch digest is invalid");
  }
  const normalized = { ...batch, entries } as unknown as ConversationInteractionMirrorBatch;
  const payload = withoutField(normalized, "signature");
  verifier.verify(
    "InteractionMirrorBatch",
    1,
    payload,
    batch.signature as Signature,
  );
  return { ...payload, signature: batch.signature } as ConversationInteractionMirrorBatch;
}

export function interactionMirrorBatchDigest(
  batch: ConversationInteractionMirrorBatch,
): Digest {
  return protocolDigest(
    "InteractionMirrorBatch",
    1,
    withoutField(batch, "signature"),
  );
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

export function validateAssignmentEntry(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AssignmentEntry {
  const entry = snapshot(input, "Assignment entry") as AssignmentEntry;
  assertExactKeys(entry, ["body", "recordSeq"], "Assignment entry");
  assertPositiveInteger(entry.recordSeq, "Assignment record sequence");
  assertAssignmentRecord(entry.body, verifier);
  return entry;
}

/**
 * Advances the canonical assignment-ledger state machine after the caller has
 * completed entry validation and any local artifact/authority binding checks.
 * Both executor replay and owner evidence recovery use this exact transition
 * function, so a signed evidence prefix cannot describe a state the executor
 * reducer itself would reject.
 */
export function applyValidatedAssignmentEntry(
  state: AssignmentLedgerValidationState,
  entry: AssignmentEntry,
): Digest {
  if (entry.recordSeq !== state.lastSeq + 1) {
    throw new TypeError("Assignment record sequence is not contiguous");
  }
  const body = entry.body;
  switch (body.t) {
    case "received":
      if (state.phase !== "unknown" || state.aborts.size > 0) {
        throw new TypeError("received is not the first record");
      }
      {
        const ref = body.activation.ref;
        const authority: AuthorityEpochRef = ref.execution === "conversation"
          ? {
              execution: "conversation",
              conversationId: ref.conversationId,
              ownerEpoch: ref.ownerEpoch,
            }
          : {
              execution: "job",
              taskId: ref.taskId,
              anchorEpoch: ref.anchorEpoch,
            };
        if (
          state.control === undefined ||
          canonicalize(state.control.authority) !== canonicalize(authority) ||
          state.control.ownerDeviceId !== body.activation.signature.keyId
        ) {
          throw new TypeError("received does not bind durable owner control");
        }
      }
      state.phase = "received";
      state.received = true;
      break;
    case "dispatch-rejected":
      if (
        state.phase !== "unknown" ||
        state.aborts.size > 0 ||
        state.control === undefined
      ) {
        throw new TypeError("dispatch-rejected has no durable owner control prefix");
      }
      state.phase = "dispatch-rejected";
      break;
    case "control-lease-renewed":
      // Owner-control remains renewable for exact retry and ledger recovery.
      // Execution authority is closed independently by phase, fences and aborts.
      if (body.lease.assignmentId !== state.assignmentId) {
        throw new TypeError("control lease belongs to a different assignment");
      }
      if (
        state.control !== undefined &&
        (canonicalize(state.control.authority) !==
          canonicalize(body.lease.authority) ||
          state.control.ownerDeviceId !== body.lease.signature.keyId ||
          state.control.controlLeaseId !== body.lease.controlLeaseId ||
          body.lease.renewalSeq <= state.control.renewalSeq)
      ) {
        throw new TypeError("control lease renewal conflicts with durable authority");
      }
      state.control = {
        authority: snapshot(body.lease.authority, "Control lease authority"),
        ownerDeviceId: body.lease.signature.keyId,
        controlLeaseId: body.lease.controlLeaseId,
        renewalSeq: body.lease.renewalSeq,
      };
      break;
    case "supersede-fenced":
      if (
        (state.phase !== "unknown" && state.phase !== "received") ||
        state.aborts.size > 0 ||
        state.control === undefined
      ) {
        throw new TypeError("supersede-fenced has no controllable assignment prefix");
      }
      state.phase = "supersede-fenced";
      break;
    case "started":
      if (state.phase !== "received" || state.aborts.size > 0) {
        throw new TypeError("started has no unfenced received prefix");
      }
      state.phase = "started";
      state.started = true;
      break;
    case "interaction-requested":
      if (state.phase !== "started" || state.aborts.size > 0) {
        throw new TypeError("interaction request is outside a started assignment");
      }
      if (state.requestedInteractions.has(body.requestId)) {
        throw new TypeError("interaction requestId is duplicated");
      }
      state.requestedInteractions.add(body.requestId);
      state.pendingInteractions.add(body.requestId);
      break;
    case "interaction-finished":
      if (!state.pendingInteractions.delete(body.requestId)) {
        throw new TypeError("interaction result is missing or duplicated");
      }
      state.finishedInteractionCount += 1;
      state.interactionMirrorDigest = advanceInteractionMirrorDigest(
        state.interactionMirrorDigest,
        {
          ordinal: state.finishedInteractionCount,
          seq: entry.recordSeq,
          requestId: body.requestId,
          kind: body.kind,
          outcome: body.outcome as ConversationInteractionOutcome,
        },
      );
      state.unmirroredFinished.set(entry.recordSeq, {
        ordinal: state.finishedInteractionCount,
        mirrorDigest: state.interactionMirrorDigest,
      });
      break;
    case "staged-mutation":
      if (state.phase !== "started" || state.aborts.size > 0) {
        throw new TypeError("staged mutation is outside a started assignment");
      }
      if (
        body.seq !== state.stagedMutationCount + 1 ||
        state.mutationRequestIds.has(body.requestId)
      ) {
        throw new TypeError("staged mutation identity is not contiguous and unique");
      }
      state.stagedMutationCount = body.seq;
      state.mutationRequestIds.add(body.requestId);
      break;
    case "side-effect-started":
      if (
        state.phase !== "started" ||
        state.aborts.size > 0 ||
        body.effectSeq !== state.sideEffectCount + 1
      ) {
        throw new TypeError("side-effect-started is outside the active effect sequence");
      }
      state.sideEffectCount = body.effectSeq;
      state.openSideEffects.add(body.effectSeq);
      break;
    case "side-effect-completed":
      if (!state.openSideEffects.delete(body.effectSeq)) {
        throw new TypeError("side-effect-completed is missing or duplicated");
      }
      break;
    case "abort-requested": {
      if (
        state.phase !== "unknown" &&
        state.phase !== "received" &&
        state.phase !== "started"
      ) {
        throw new TypeError("abort-requested is outside a cancellable assignment");
      }
      if (
        (body.via === "owner-fence" && state.control === undefined) ||
        (body.via === "abort-ticket" && !state.received)
      ) {
        throw new TypeError("abort-requested has no durable authorization prefix");
      }
      const key = `${body.via}\0${body.refId}`;
      if (state.aborts.has(key)) {
        throw new TypeError("abort request is duplicated");
      }
      state.aborts.add(key);
      break;
    }
    case "halted": {
      const proof = body.proof;
      const matchingAbort =
        proof.cause === "owner-fence"
          ? state.aborts.has(`owner-fence\0${proof.fence.requestId}`)
          : state.aborts.has(`abort-ticket\0${proof.ticketDigest}`);
      const closesCancellablePhase =
        proof.decision === "not-started"
          ? !state.started && (state.phase === "unknown" || state.phase === "received")
          : state.started && state.phase === "started";
      if (
        state.aborts.size === 0 ||
        !matchingAbort ||
        !closesCancellablePhase ||
        state.pendingInteractions.size > 0 ||
        state.unmirroredFinished.size > 0 ||
        state.openSideEffects.size > 0 ||
        proof.assignmentId !== state.assignmentId ||
        proof.lastRecordSeq !== entry.recordSeq - 1 ||
        proof.ledgerDigest !== state.chainDigest ||
        (proof.decision === "halted" &&
          proof.lastEffectSeq !== state.sideEffectCount)
      ) {
        throw new TypeError("halted does not close the durable cancellation prefix");
      }
      state.phase = "halted";
      break;
    }
    case "execution-failed":
      if (
        state.phase !== "started" ||
        state.aborts.size > 0 ||
        state.pendingInteractions.size > 0 ||
        state.unmirroredFinished.size > 0 ||
        state.openSideEffects.size > 0
      ) {
        throw new TypeError("execution-failed does not close a clean started assignment");
      }
      state.phase = "failed";
      break;
    case "bundle_sealed":
      if (
        state.phase !== "started" ||
        state.aborts.size > 0 ||
        state.pendingInteractions.size > 0 ||
        state.unmirroredFinished.size > 0 ||
        state.openSideEffects.size > 0
      ) {
        throw new TypeError("bundle_sealed has no started prefix");
      }
      state.phase = "sealed";
      break;
    case "acked":
      if (state.phase !== "sealed") {
        throw new TypeError("acked has no sealed prefix");
      }
      state.phase = "acked";
      break;
    case "mirrored":
      const checkpoint = state.unmirroredFinished.get(body.upTo);
      if (
        body.upTo <= state.mirroredUpTo ||
        body.ordinal <= state.mirroredInteractionOrdinal ||
        !checkpoint ||
        checkpoint.ordinal !== body.ordinal ||
        checkpoint.mirrorDigest !== body.mirrorDigest
      ) {
        throw new TypeError("mirrored watermark has no new finished interaction");
      }
      let released = 0;
      for (const [seq, candidate] of state.unmirroredFinished) {
        if (candidate.ordinal <= body.ordinal) {
          state.unmirroredFinished.delete(seq);
          released += 1;
        }
      }
      if (released !== body.ordinal - state.mirroredInteractionOrdinal) {
        throw new TypeError("mirrored watermark skips an interaction result");
      }
      state.mirroredUpTo = body.upTo;
      state.mirroredInteractionOrdinal = body.ordinal;
      break;
    default:
      throw new TypeError("Assignment record kind is invalid");
  }
  const digest = advanceAssignmentLedger(state.chainDigest, entry);
  state.lastSeq = entry.recordSeq;
  state.chainDigest = digest;
  return digest;
}

export function validateLedgerEvidencePage(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): LedgerEvidencePage {
  const page = snapshot(input, "Ledger evidence page") as LedgerEvidencePage;
  assertExactKeys(
    page,
    [
      "assignmentId",
      "chainDigest",
      "entries",
      "executorId",
      "fromSeq",
      "signature",
      "toSeq",
      "v",
    ],
    "Ledger evidence page",
  );
  assertVersion(page.v, "Ledger evidence page");
  assertIdentifier(page.assignmentId, "Ledger evidence assignmentId");
  assertIdentifier(page.executorId, "Ledger evidence executorId");
  assertPositiveInteger(page.fromSeq, "Ledger evidence fromSeq");
  assertPositiveInteger(page.toSeq, "Ledger evidence toSeq");
  if (page.toSeq < page.fromSeq || page.entries.length !== page.toSeq - page.fromSeq + 1) {
    throw new TypeError("Ledger evidence page range is not a non-empty contiguous prefix");
  }
  if (page.entries.length > MAX_LEDGER_EVIDENCE_PAGE_ENTRIES) {
    throw new TypeError(
      `Ledger evidence page exceeds the ${MAX_LEDGER_EVIDENCE_PAGE_ENTRIES}-entry protocol limit`,
    );
  }
  if (
    Buffer.byteLength(canonicalize(withoutField(page, "signature")), "utf8") >
    MAX_LEDGER_EVIDENCE_PAGE_BYTES
  ) {
    throw new TypeError("Ledger evidence page exceeds the protocol byte limit");
  }
  page.entries.forEach((entry, index) => {
    assertExactKeys(entry, ["body", "recordSeq"], "Ledger evidence entry");
    if (entry.recordSeq !== page.fromSeq + index) {
      throw new TypeError("Ledger evidence entries are not contiguous");
    }
    if (isArtifactRecordReference(entry.body)) {
      assertExactKeys(entry.body, ["ref"], "Ledger evidence artifact entry");
      assertArtifactRef(entry.body.ref, "Ledger evidence artifact reference");
    }
  });
  assertDigest(page.chainDigest, "Ledger evidence chain digest");
  assertSignature(page.signature, "Ledger evidence signature");
  verifier.verify(
    "LedgerEvidencePage",
    1,
    withoutField(page, "signature"),
    page.signature,
  );
  for (const entry of page.entries) {
    if (!isArtifactRecordReference(entry.body)) {
      validateAssignmentEntry(entry, verifier);
    }
  }
  return page;
}

export function signDispatchConflictProof(
  input: Omit<DispatchConflictProof, "signature">,
  signer: ProtocolSigner,
): DispatchConflictProof {
  const payload = snapshot(input, "Dispatch conflict payload");
  assertDispatchConflictPayload(payload);
  return snapshot(
    {
      ...payload,
      signature: signer.sign("DispatchConflictProof", 1, payload),
    },
    "Dispatch conflict proof",
  );
}

export function validateDispatchConflictProof(
  input: DispatchConflictProof,
  verifier: ProtocolSignatureVerifier,
): DispatchConflictProof {
  const proof = snapshot(input, "Dispatch conflict proof");
  assertExactKeys(
    proof,
    [
      "acceptedActivationDigest",
      "acceptedDispatchRef",
      "assignmentId",
      "conflictingActivationDigest",
      "conflictingDispatchRef",
      "error",
      "executorId",
      "receivedLedgerDigest",
      "receivedRecordSeq",
      "signature",
      "v",
    ],
    "Dispatch conflict proof",
  );
  assertSignature(proof.signature, "Dispatch conflict signature");
  const payload = withoutField(proof, "signature");
  assertDispatchConflictPayload(payload);
  verifier.verify("DispatchConflictProof", 1, payload, proof.signature);
  return proof;
}

export function validateDispatchRejectionProof(
  input: DispatchRejectionProof,
  verifier: ProtocolSignatureVerifier,
): DispatchRejectionProof {
  const proof = snapshot(input, "Dispatch rejection proof");
  assertExactKeys(
    proof,
    [
      "assignmentId",
      "dispatchDigest",
      "error",
      "executorId",
      "lastRecordSeq",
      "ledgerDigest",
      "signature",
      "v",
    ],
    "Dispatch rejection proof",
  );
  assertVersion(proof.v, "Dispatch rejection proof");
  assertIdentifier(proof.assignmentId, "Dispatch rejection assignmentId");
  assertIdentifier(proof.executorId, "Dispatch rejection executorId");
  assertDigest(proof.dispatchDigest, "Dispatch rejection dispatch digest");
  assertAuthorityError(proof.error, "Dispatch rejection error");
  assertPositiveInteger(proof.lastRecordSeq, "Dispatch rejection record sequence");
  assertDigest(proof.ledgerDigest, "Dispatch rejection ledger digest");
  assertSignature(proof.signature, "Dispatch rejection signature");
  const payload = withoutField(proof, "signature");
  verifier.verify("DispatchRejectionProof", 1, payload, proof.signature);
  return proof;
}

export function validateDispatchResult(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): DispatchResult {
  const result = snapshot(input, "Dispatch result") as DispatchResult;
  assertObject(result, "Dispatch result");
  assertVersion(result.v, "Dispatch result");
  if (result.accepted === true) {
    assertExactKeys(result, ["accepted", "v"], "Accepted dispatch result");
    return result;
  }
  if (result.accepted !== false) {
    throw new TypeError("Dispatch result accepted flag is invalid");
  }
  assertExactKeys(
    result,
    ["accepted", "error", "outcome", "proof", "v"],
    "Rejected dispatch result",
  );
  assertAuthorityError(result.error, "Dispatch result error");
  if (result.outcome === "rejected-before-received") {
    const proof = validateDispatchRejectionProof(result.proof, verifier);
    if (canonicalize(result.error) !== canonicalize(proof.error)) {
      throw new TypeError("Dispatch rejection response does not match its proof");
    }
    return result;
  }
  if (result.outcome === "conflicting-redelivery") {
    const proof = validateDispatchConflictProof(result.proof, verifier);
    if (
      result.error.code !== proof.error.code ||
      result.error.retryable !== proof.error.retryable
    ) {
      throw new TypeError("Dispatch conflict response does not match its proof");
    }
    return result;
  }
  throw new TypeError("Dispatch result outcome is invalid");
}

export function validateLedgerSnapshot(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): LedgerSnapshot {
  const value = snapshot(input, "Ledger snapshot") as LedgerSnapshot;
  assertObject(value, "Ledger snapshot");
  assertExactKeys(
    value,
    [
      "assignmentId",
      ...(value.acknowledgedCommitRevision === undefined
        ? []
        : ["acknowledgedCommitRevision"]),
      ...(value.cancelProof === undefined ? [] : ["cancelProof"]),
      ...(value.failure === undefined ? [] : ["failure"]),
      "lastSeq",
      "phase",
      ...(value.sealedBundleRef === undefined ? [] : ["sealedBundleRef"]),
      "v",
    ],
    "Ledger snapshot",
  );
  assertVersion(value.v, "Ledger snapshot");
  assertIdentifier(value.assignmentId, "Ledger snapshot assignmentId");
  assertNonNegativeInteger(value.lastSeq, "Ledger snapshot lastSeq");
  const phases: ReadonlySet<LedgerSnapshot["phase"]> = new Set([
    "unknown",
    "received",
    "dispatch-rejected",
    "supersede-fenced",
    "started",
    "halted",
    "failed",
    "sealed",
    "acked",
  ]);
  if (!phases.has(value.phase)) {
    throw new TypeError("Ledger snapshot phase is invalid");
  }
  if (value.lastSeq === 0 && value.phase !== "unknown") {
    throw new TypeError("Ledger snapshot phase and record sequence are inconsistent");
  }
  const isSealed = value.phase === "sealed" || value.phase === "acked";
  if (isSealed !== (value.sealedBundleRef !== undefined)) {
    throw new TypeError("Ledger snapshot sealed phase is missing its bundle reference");
  }
  if (value.sealedBundleRef !== undefined) {
    assertArtifactRef(value.sealedBundleRef, "Ledger snapshot sealed bundle reference");
  }
  if (
    (value.phase === "acked") !==
    (value.acknowledgedCommitRevision !== undefined)
  ) {
    throw new TypeError(
      "Ledger snapshot acknowledged phase is missing its commit revision",
    );
  }
  if (value.acknowledgedCommitRevision !== undefined) {
    assertNonNegativeInteger(
      value.acknowledgedCommitRevision,
      "Ledger snapshot acknowledged commit revision",
    );
  }
  if ((value.phase === "halted") !== (value.cancelProof !== undefined)) {
    throw new TypeError("Ledger snapshot halted phase is missing its cancel proof");
  }
  if (value.cancelProof !== undefined) {
    const proof = validateCancelProof(value.cancelProof, verifier);
    if (proof.assignmentId !== value.assignmentId) {
      throw new TypeError("Ledger snapshot cancel proof names a different assignment");
    }
  }
  if ((value.phase === "failed") !== (value.failure !== undefined)) {
    throw new TypeError("Ledger snapshot failed phase is missing its failure fact");
  }
  if (value.failure !== undefined) {
    assertExactKeys(value.failure, ["reason", "usageFinal"], "Ledger failure fact");
    if (
      typeof value.failure.reason !== "string" ||
      value.failure.reason.length === 0 ||
      Buffer.byteLength(value.failure.reason, "utf8") > 512
    ) {
      throw new TypeError("Ledger failure reason is invalid");
    }
    assertExactKeys(
      value.failure.usageFinal,
      ["reportDigest", "upToUsageSeq"],
      "Ledger failure final usage",
    );
    assertDigest(value.failure.usageFinal.reportDigest, "Ledger failure report digest");
    assertNonNegativeInteger(
      value.failure.usageFinal.upToUsageSeq,
      "Ledger failure usage sequence",
    );
  }
  return value;
}

export function signSupersedeProof(
  input: UnsignedSupersedeProof,
  signer: ProtocolSigner,
): SupersedeProof {
  const payload = snapshot(input, "Supersede payload");
  assertSupersedePayload(payload);
  return snapshot(
    {
      ...payload,
      signature: signer.sign("SupersedeProof", 1, payload),
    },
    "Supersede proof",
  ) as SupersedeProof;
}

export function validateSupersedeProof(
  input: SupersedeProof,
  verifier: ProtocolSignatureVerifier,
): SupersedeProof {
  const proof = snapshot(input, "Supersede proof");
  assertExactKeys(
    proof,
    [
      "assignmentId",
      "decision",
      "executorId",
      "fence",
      "lastRecordSeq",
      "ledgerDigest",
      "signature",
      "v",
    ],
    "Supersede proof",
  );
  assertSignature(proof.signature, "Supersede signature");
  const payload = withoutField(proof, "signature");
  assertSupersedePayload(payload);
  verifier.verify("SupersedeProof", 1, payload, proof.signature);
  return proof;
}

export function signCancelProof(
  input: UnsignedCancelProof,
  signer: ProtocolSigner,
): CancelProofBody {
  const payload = snapshot(input, "Cancel proof payload");
  assertCancelProofPayload(payload);
  return snapshot(
    {
      ...payload,
      signature: signer.sign("CancelProofBody", 1, payload),
    },
    "Cancel proof",
  ) as CancelProofBody;
}

export function validateCancelProof(
  input: CancelProofBody,
  verifier: ProtocolSignatureVerifier,
): CancelProofBody {
  const proof = snapshot(input, "Cancel proof");
  assertSignature(proof.signature, "Cancel proof signature");
  const payload = withoutField(proof, "signature") as UnsignedCancelProof;
  assertCancelProofPayload(payload);
  verifier.verify("CancelProofBody", 1, payload, proof.signature);
  return proof;
}

/** Validates the closed union of proofs that can terminate an assignment before start. */
export function validateAssignmentTerminationProof(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AssignmentTerminationProof {
  assertObject(input, "Assignment termination proof");
  if ("dispatchDigest" in input) {
    return validateDispatchRejectionProof(
      input as unknown as DispatchRejectionProof,
      verifier,
    );
  }
  if (input.decision === "not-started-fenced") {
    return validateSupersedeProof(input as unknown as SupersedeProof, verifier) as Extract<
      SupersedeProof,
      { decision: "not-started-fenced" }
    >;
  }
  const proof = validateCancelProof(input as unknown as CancelProofBody, verifier);
  if (proof.decision !== "not-started") {
    throw new TypeError("Halted cancel proof cannot terminate an assignment for redispatch");
  }
  return proof;
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
        ["authority", "by", "decision", "decisionDigest", "t"],
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
      assertDigest(outcome.decisionDigest as string, "Interaction decision digest");
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
    ["at", "kind", "ordinal", "outcome", "requestId", "seq"],
    "Conversation interaction mirror entry",
  );
  if (!Number.isSafeInteger(entry.ordinal) || (entry.ordinal as number) <= 0) {
    throw new TypeError("Interaction mirror ordinal must be a positive safe integer");
  }
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

function assertAssignmentRecord(
  value: AssignmentRecord,
  verifier: ProtocolSignatureVerifier,
): void {
  assertObject(value, "Assignment record");
  assertVersion(value.v, "Assignment record");
  switch (value.t) {
    case "received":
      assertExactKeys(value, ["activation", "envelope", "t", "v"], "received record");
      assertExactKeys(value.envelope, ["ref"], "received envelope");
      assertArtifactRef(value.envelope.ref, "received envelope reference");
      assertObject(value.activation, "received activation");
      assertExactKeys(
        value.activation,
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
        "received activation",
      );
      assertVersion(value.activation.v, "received activation");
      assertIdentifier(value.activation.assignmentId, "received activation assignmentId");
      assertIdentifier(value.activation.executorId, "received activation executorId");
      assertArtifactRef(value.activation.dispatchRef, "received activation dispatchRef");
      assertDigest(value.activation.manifestDigest, "received activation manifest digest");
      assertDigest(
        value.activation.permissionLeaseDigest,
        "received activation permission digest",
      );
      assertSignature(value.activation.signature, "received activation signature");
      verifier.verify(
        "AssignmentActivationProof",
        1,
        withoutField(value.activation, "signature"),
        value.activation.signature,
      );
      return;
    case "dispatch-rejected":
      assertExactKeys(value, ["dispatchDigest", "reason", "t", "v"], "dispatch-rejected record");
      assertDigest(value.dispatchDigest, "dispatch rejection digest");
      assertAuthorityError(value.reason, "dispatch rejection reason");
      return;
    case "control-lease-renewed":
      assertExactKeys(
        value,
        ["lease", "t", "v"],
        "control-lease-renewed record",
      );
      validateControlLease(value.lease, verifier);
      return;
    case "supersede-fenced":
      assertExactKeys(value, ["fenceSeq", "requestId", "t", "v"], "supersede-fenced record");
      assertPositiveInteger(value.fenceSeq, "supersede fence sequence");
      assertIdentifier(value.requestId, "supersede requestId");
      return;
    case "started":
      assertExactKeys(value, ["t", "v"], "started record");
      return;
    case "interaction-requested":
      assertExactKeys(
        value,
        ["display", "expiresAt", "issuedAt", "kind", "requestId", "t", "toolName", "ttlMs", "v"],
        "interaction-requested record",
      );
      assertIdentifier(value.requestId, "interaction requestId");
      assertIdentifier(value.toolName, "interaction toolName");
      if (value.kind !== "allow-once") throw new TypeError("Interaction kind is invalid");
      validateInteractionDisplay(value.display);
      assertCanonicalTime(value.issuedAt, "interaction issuedAt");
      assertCanonicalTime(value.expiresAt, "interaction expiresAt");
      assertPositiveInteger(value.ttlMs, "interaction ttlMs");
      if (
        Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !== value.ttlMs
      ) {
        throw new TypeError("Interaction request timing or display is invalid");
      }
      return;
    case "interaction-finished":
      assertExactKeys(value, ["kind", "outcome", "requestId", "t", "v"], "interaction-finished record");
      assertIdentifier(value.requestId, "finished interaction requestId");
      if (value.kind !== "allow-once") throw new TypeError("Finished interaction kind is invalid");
      validateConversationInteractionOutcome(value.outcome);
      return;
    case "staged-mutation":
      assertExactKeys(
        value,
        ["domain", ...(value.expected === undefined ? [] : ["expected"]), "mutation", "requestId", "seq", "t", "v"],
        "staged-mutation record",
      );
      validateStagedMutationRecord(value);
      return;
    case "side-effect-started":
      assertExactKeys(
        value,
        ["effectSeq", "kind", "summary", "t", "target", "toolName", "v"],
        "side-effect-started record",
      );
      assertPositiveInteger(value.effectSeq, "side effect sequence");
      assertIdentifier(value.toolName, "side effect toolName");
      if (typeof value.summary !== "string" || value.summary.length > 4_096) {
        throw new TypeError("Side effect summary is invalid");
      }
      if (value.kind !== "tool-mutation" && value.kind !== "external-call") {
        throw new TypeError("Side effect kind is invalid");
      }
      if (
        value.target !== "workspace-file" &&
        value.target !== "external-service" &&
        value.target !== "device-system"
      ) {
        throw new TypeError("Side effect target is invalid");
      }
      return;
    case "side-effect-completed":
      assertExactKeys(
        value,
        ["effectSeq", ...(value.resultDigest === undefined ? [] : ["resultDigest"]), "status", "t", "v"],
        "side-effect-completed record",
      );
      assertPositiveInteger(value.effectSeq, "side effect completion sequence");
      if (value.status !== "ok" && value.status !== "failed" && value.status !== "aborted") {
        throw new TypeError("Side effect completion status is invalid");
      }
      if (value.resultDigest !== undefined) assertDigest(value.resultDigest, "side effect result digest");
      return;
    case "abort-requested":
      assertExactKeys(value, ["refId", "t", "v", "via"], "abort-requested record");
      assertIdentifier(value.refId, "abort request reference");
      if (value.via !== "owner-fence" && value.via !== "abort-ticket") {
        throw new TypeError("Abort request source is invalid");
      }
      return;
    case "halted":
      assertExactKeys(value, ["proof", "t", "v"], "halted record");
      validateCancelProof(value.proof, verifier);
      return;
    case "execution-failed":
      assertExactKeys(
        value,
        ["reason", "t", "usageFinal", "v"],
        "execution-failed record",
      );
      if (
        typeof value.reason !== "string" ||
        value.reason.length === 0 ||
        Buffer.byteLength(value.reason, "utf8") > 512
      ) {
        throw new TypeError("Execution failure reason is invalid");
      }
      assertExactKeys(
        value.usageFinal,
        ["reportDigest", "upToUsageSeq"],
        "Execution failure final usage",
      );
      assertDigest(value.usageFinal.reportDigest, "Execution failure report digest");
      assertNonNegativeInteger(
        value.usageFinal.upToUsageSeq,
        "Execution failure usage sequence",
      );
      return;
    case "bundle_sealed":
      assertExactKeys(
        value,
        ["bundle", ...(value.mutationBatch === undefined ? [] : ["mutationBatch"]), "t", "v"],
        "bundle_sealed record",
      );
      assertExactKeys(value.bundle, ["ref"], "sealed bundle container");
      assertArtifactRef(value.bundle.ref, "sealed bundle reference");
      if (value.mutationBatch !== undefined) {
        assertExactKeys(value.mutationBatch, ["ref"], "mutation batch container");
        assertArtifactRef(value.mutationBatch.ref, "mutation batch reference");
      }
      return;
    case "acked":
      assertExactKeys(value, ["commitRevision", "t", "v"], "acked record");
      assertNonNegativeInteger(value.commitRevision, "commit revision");
      return;
    case "mirrored":
      assertExactKeys(
        value,
        ["mirrorDigest", "ordinal", "t", "upTo", "v"],
        "mirrored record",
      );
      assertPositiveInteger(value.upTo, "mirrored watermark");
      assertPositiveInteger(value.ordinal, "mirrored ordinal");
      assertDigest(value.mirrorDigest, "mirrored digest");
      return;
    default:
      throw new TypeError("Assignment record kind is invalid");
  }
}

function isArtifactRecordReference(
  value: AssignmentRecord | { readonly ref: ArtifactRef },
): value is { readonly ref: ArtifactRef } {
  return "ref" in value;
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
      "controlLease",
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
  validateExecutionManifest(envelope.manifest);
  assertConversationWork(envelope.work);
  const authenticatedControl = verifyEnvelopeSignature
    ? validateDispatchControlBinding(envelope as ConversationEnvelope, verifier)
    : undefined;
  const controlLease = authenticatedControl?.controlLease ??
    validateControlLease(envelope.controlLease, verifier);
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
    permission.executorId !== envelope.executorId ||
    permission.snapshotVersion !== manifest.requires.permissionSnapshotVersion ||
    controlLease.assignmentId !== envelope.assignmentId ||
    controlLease.authority.execution !== "conversation" ||
    controlLease.authority.conversationId !== work.conversationId ||
    controlLease.authority.ownerEpoch !== work.ownerEpoch ||
    permission.controlLeaseId !== controlLease.controlLeaseId ||
    permission.signature.keyId !== controlLease.signature.keyId
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

}

function assertJobEnvelope(
  envelope: UnsignedJobEnvelope | JobEnvelope,
  verifier: ProtocolSignatureVerifier,
  verifyEnvelopeSignature: boolean,
): asserts envelope is JobEnvelope {
  assertExactKeys(
    envelope,
    [
      "assignmentId",
      "capabilities",
      "controlLease",
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
  if (envelope.execution !== "job" || envelope.work.t !== "job") {
    throw new TypeError("Dispatch envelope must contain job work");
  }
  assertIdentifier(envelope.assignmentId, "Dispatch assignmentId");
  assertIdentifier(envelope.executorId, "Dispatch executorId");
  assertCanonicalTime(envelope.issuedAt, "Dispatch issuedAt");
  validateExecutionManifest(envelope.manifest);
  assertJobWork(envelope.work);
  const authenticatedControl = verifyEnvelopeSignature
    ? validateDispatchControlBinding(envelope as JobEnvelope, verifier)
    : undefined;
  const controlLease = authenticatedControl?.controlLease ??
    validateControlLease(envelope.controlLease, verifier);
  assertPermissionLease(envelope.permissionLease, verifier);
  assertCapabilities(envelope.capabilities, verifier);
  assertResourceLease(envelope.resourceLease, verifier);
  assertArtifactRefs(envelope.dependencyArtifacts, "Dispatch dependencies");

  const work = envelope.work;
  if (
    envelope.manifest.baseRef.execution !== "job" ||
    envelope.manifest.baseRef.taskId !== work.taskId ||
    envelope.manifest.baseRef.jobRunId !== work.jobRunId ||
    envelope.manifest.baseRef.taskRevision !== work.fence.taskRevision
  ) {
    throw new TypeError("Dispatch manifest does not bind the job occurrence");
  }
  const permission = envelope.permissionLease;
  if (
    permission.binding.execution !== "job" ||
    permission.binding.jobRunId !== work.jobRunId ||
    permission.binding.taskId !== work.taskId ||
    permission.binding.anchorEpoch !== work.fence.anchorEpoch ||
    permission.assignmentId !== envelope.assignmentId ||
    permission.executorId !== envelope.executorId ||
    permission.snapshotVersion !==
      envelope.manifest.requires.permissionSnapshotVersion ||
    controlLease.assignmentId !== envelope.assignmentId ||
    controlLease.authority.execution !== "job" ||
    controlLease.authority.taskId !== work.taskId ||
    controlLease.authority.anchorEpoch !== work.fence.anchorEpoch ||
    permission.controlLeaseId !== controlLease.controlLeaseId ||
    permission.signature.keyId !== controlLease.signature.keyId
  ) {
    throw new TypeError("Permission lease does not bind the dispatch");
  }
  for (const capability of envelope.capabilities) {
    if (
      capability.scope.execution !== "job" ||
      capability.scope.taskId !== work.taskId ||
      capability.anchorEpoch !== work.fence.anchorEpoch ||
      capability.assignmentId !== envelope.assignmentId ||
      capability.executorId !== envelope.executorId
    ) {
      throw new TypeError("Authority capability does not bind the dispatch");
    }
  }
  const lease = envelope.resourceLease;
  if (
    lease.workload.kind !== "job" ||
    lease.workload.id !== work.jobRunId ||
    lease.scopeBinding.kind !== "job" ||
    lease.scopeBinding.taskId !== work.taskId ||
    lease.scopeBinding.anchorEpoch !== work.fence.anchorEpoch ||
    lease.domain.kind !== "anchor" ||
    lease.domain.anchorEpoch !== work.fence.anchorEpoch ||
    lease.audience.executorId !== envelope.executorId ||
    lease.activation.kind !== "assignment" ||
    lease.activation.assignmentId !== envelope.assignmentId
  ) {
    throw new TypeError("Resource lease does not bind the dispatch");
  }
  if (
    work.fence.assignmentId !== envelope.assignmentId ||
    work.fence.executorId !== envelope.executorId ||
    work.fence.taskId !== work.taskId ||
    work.fence.jobRunId !== work.jobRunId
  ) {
    throw new TypeError("Job commit fence does not bind the dispatch");
  }
  const frozenTools = new Set(envelope.manifest.tools);
  for (const tool of work.instruction.tools ?? []) {
    if (!frozenTools.has(tool)) {
      throw new TypeError("Job execution tool is not frozen in the manifest");
    }
  }
  assertSortedUnique(
    envelope.capabilities.map((capability) => capability.capId),
    "Dispatch capability ids",
  );

}

function assertJobWork(work: JobEnvelope["work"]): void {
  assertExactKeys(work, ["fence", "instruction", "jobRunId", "t", "taskId"], "Job dispatch");
  assertIdentifier(work.jobRunId, "Dispatch jobRunId");
  assertIdentifier(work.taskId, "Dispatch taskId");
  validateJobCommitFence(work.fence);
  assertExactKeys(
    work.instruction,
    ["kind", "model", "prompt", "tools"],
    "Job execution instruction",
    true,
  );
  if (work.instruction.kind !== "agent-turn") {
    throw new TypeError("Job execution instruction kind must be agent-turn");
  }
  if (
    typeof work.instruction.prompt !== "string" ||
    work.instruction.prompt.length === 0 ||
    work.instruction.prompt.length > 65_536
  ) {
    throw new TypeError("Job execution prompt must be a non-empty bounded string");
  }
  if (work.instruction.model !== undefined) {
    assertIdentifier(work.instruction.model, "Job execution model");
  }
  if (work.instruction.tools !== undefined) {
    assertUniqueIdentifiers(work.instruction.tools, "Job execution tools");
  }
}

export function validateIngressContext(input: unknown): IngressContext {
  const ingress = snapshot(input, "Ingress context") as IngressContext;
  assertIngressContext(ingress);
  return ingress;
}

export function validateConversationInvocation(
  input: unknown,
): ConversationInvocation {
  const invocation = snapshot(
    input,
    "Conversation invocation",
  ) as ConversationInvocation;
  assertObject(invocation, "Conversation invocation");
  if (invocation.kind === "agent") {
    assertExactKeys(
      invocation,
      ["advancement", "kind", "source"],
      "Agent conversation invocation",
      true,
    );
    assertTurnSource(invocation.source, "Agent invocation source");
    if (invocation.source === "advancement") {
      assertAdvancementMetadata(invocation.advancement);
    } else if (invocation.advancement !== undefined) {
      throw new TypeError(
        "Only advancement conversation invocations accept advancement metadata",
      );
    }
    return invocation;
  }
  if (invocation.kind === "perspectives") {
    assertExactKeys(
      invocation,
      ["kind", "question", "source"],
      "Perspectives conversation invocation",
    );
    if (invocation.source !== "interactive" && invocation.source !== "channel") {
      throw new TypeError("Perspectives invocation source is invalid");
    }
    if (
      typeof invocation.question !== "string" ||
      invocation.question.trim().length === 0 ||
      Buffer.byteLength(invocation.question, "utf8") > MAX_CONVERSATION_QUESTION_BYTES
    ) {
      throw new TypeError(
        "Perspectives invocation question is empty or exceeds its UTF-8 budget",
      );
    }
    return invocation;
  }
  throw new TypeError("Conversation invocation kind is invalid");
}

function assertTurnSource(
  value: unknown,
  label: string,
): asserts value is import("../transcript/types.js").TurnSource {
  if (
    value !== "interactive" &&
    value !== "scheduler" &&
    value !== "channel" &&
    value !== "advancement"
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertAdvancementMetadata(
  value: unknown,
): asserts value is import("../transcript/types.js").RunRecordAdvancementMetadata {
  assertObject(value, "Advancement invocation metadata");
  assertExactKeys(
    value,
    [
      "proxyMessageId",
      "reviewId",
      "rubricFailureHandlingId",
      "sessionId",
    ],
    "Advancement invocation metadata",
    true,
  );
  assertIdentifier(value.sessionId, "Advancement sessionId");
  if (value.proxyMessageId !== undefined) {
    assertIdentifier(value.proxyMessageId, "Advancement proxyMessageId");
  }
  if (value.reviewId !== undefined) {
    assertIdentifier(value.reviewId, "Advancement reviewId");
  }
  if (value.rubricFailureHandlingId !== undefined) {
    assertIdentifier(
      value.rubricFailureHandlingId,
      "Advancement rubricFailureHandlingId",
    );
  }
}

export function validateChannelResponderRef(input: unknown): ChannelResponderRef {
  const responder = snapshot(input, "Channel responder") as ChannelResponderRef;
  assertChannelResponder(responder);
  return responder;
}

function assertIngressContext(ingress: IngressContext): void {
  assertObject(ingress, "Ingress context");
  const common = [
    "deviceId",
    "ingressId",
    "kind",
    "receivedAt",
    "surfacePrincipal",
    "turnOrigin",
  ];
  if (ingress.kind === "first-party") {
    assertExactKeys(ingress, common, "First-party ingress context", true);
  } else if (ingress.kind === "channel") {
    assertExactKeys(
      ingress,
      [...common, "replyTarget", "responder"],
      "Channel ingress context",
      true,
    );
    assertChannelResponder(ingress.responder);
    assertDeliveryTarget(ingress.replyTarget);
    const expectedPrincipal = `channel:${protocolDigest(
      "ChannelResponderRef",
      1,
      ingress.responder,
    )}`;
    if (ingress.surfacePrincipal !== expectedPrincipal) {
      throw new TypeError("Channel surfacePrincipal is not derived from its responder");
    }
  } else {
    throw new TypeError("Ingress context kind is invalid");
  }
  assertIdentifier(ingress.surfacePrincipal, "Ingress surfacePrincipal");
  assertIdentifier(ingress.deviceId, "Ingress deviceId");
  assertIdentifier(ingress.ingressId, "Ingress ingressId");
  assertCanonicalTime(ingress.receivedAt, "Ingress receivedAt");
  if (ingress.turnOrigin !== undefined) assertTurnOrigin(ingress.turnOrigin);
}

function assertChannelResponder(value: unknown): void {
  assertObject(value, "Channel responder");
  assertExactKeys(
    value,
    ["channelId", "platformSubject", "tenant"],
    "Channel responder",
    true,
  );
  assertIdentifier(value.channelId, "Channel responder channelId");
  assertIdentifier(value.platformSubject, "Channel responder platformSubject");
  if (value.tenant !== undefined) assertIdentifier(value.tenant, "Channel tenant");
}

function assertDeliveryTarget(value: unknown): void {
  assertObject(value, "Delivery target");
  assertExactKeys(value, ["channelId", "threadId", "to"], "Delivery target", true);
  assertIdentifier(value.channelId, "Delivery channelId");
  assertIdentifier(value.to, "Delivery recipient");
  if (value.threadId !== undefined) assertIdentifier(value.threadId, "Delivery threadId");
}

function assertTurnOrigin(value: unknown): void {
  assertObject(value, "Turn origin");
  assertExactKeys(
    value,
    ["channel", "surface", "target", "triggeredBy"],
    "Turn origin",
    true,
  );
  assertIdentifier(value.channel, "Turn origin channel");
  if (value.target !== undefined) assertDeliveryTarget(value.target);
  if (value.triggeredBy !== undefined) {
    assertIdentifier(value.triggeredBy, "Turn origin triggeredBy");
  }
  if (value.surface !== undefined) {
    assertObject(value.surface, "Turn origin surface");
    assertExactKeys(value.surface, ["capabilities"], "Turn origin surface", true);
    if (value.surface.capabilities !== undefined) {
      assertObject(value.surface.capabilities, "Surface capabilities");
      assertExactKeys(
        value.surface.capabilities,
        ["postTurnControl"],
        "Surface capabilities",
        true,
      );
      if (
        value.surface.capabilities.postTurnControl !== undefined &&
        typeof value.surface.capabilities.postTurnControl !== "boolean"
      ) {
        throw new TypeError("postTurnControl capability must be boolean");
      }
    }
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
  assertIngressContext(work.ingress);
  if (work.windowInput.t === "full") {
    assertExactKeys(work.windowInput, ["messages", "t", "windowEpoch"], "Full window");
    assertNonNegativeInteger(work.windowInput.windowEpoch, "Window epoch");
    if (Array.isArray(work.windowInput.messages)) {
      validateMessages(work.windowInput.messages, "Full window messages");
    } else {
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
    validateMessages(work.windowInput.appended, "Delta window messages");
  } else {
    throw new TypeError("Window input kind is invalid");
  }
  if (!Array.isArray(work.controlContext)) {
    throw new TypeError("Control context must be an array");
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
  lease: DispatchEnvelope["permissionLease"],
  verifier: ProtocolSignatureVerifier,
): void {
  validatePermissionSnapshotLease(lease, verifier);
}

function assertCapabilities(
  capabilities: DispatchEnvelope["capabilities"],
  verifier: ProtocolSignatureVerifier,
): void {
  if (capabilities.length === 0) {
    throw new TypeError("Dispatch must carry at least one authority capability");
  }
  for (const capability of capabilities) {
    validateAuthorityCapability(capability, verifier);
  }
}

function assertResourceLease(
  lease: DispatchEnvelope["resourceLease"],
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
  validateReservableResourceLease(lease, verifier);
  if (lease.workload.kind !== "run" && lease.workload.kind !== "job") {
    throw new TypeError("Lease workload kind is invalid");
  }
  if (
    lease.scopeBinding.kind !== "conversation" &&
    lease.scopeBinding.kind !== "job"
  ) {
    throw new TypeError("Lease scope binding kind is invalid");
  }
  assertExactKeys(lease.activation, ["assignmentId", "kind"], "Lease activation");
  if (lease.activation.kind !== "assignment") {
    throw new TypeError("Lease activation kind is invalid");
  }
  assertIdentifier(lease.activation.assignmentId, "Lease activation assignmentId");
}

function assertActivationPayload(
  payload: AssignmentActivationPayload<"conversation">,
  envelope: ConversationEnvelope,
  dispatchRef: ArtifactRef,
): void {
  assertActivationPayloadShape(payload);
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

function assertActivationPayloadShape(
  payload: AssignmentActivationPayload<"conversation">,
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
}

function assertJobActivationPayload(
  payload: AssignmentActivationPayload<"job">,
  envelope: JobEnvelope,
  dispatchRef: ArtifactRef,
): void {
  assertJobActivationPayloadShape(payload);
  const expectedRef = {
    execution: "job" as const,
    jobRunId: envelope.work.jobRunId,
    taskId: envelope.work.taskId,
    anchorEpoch: envelope.work.fence.anchorEpoch,
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

function assertJobActivationPayloadShape(
  payload: AssignmentActivationPayload<"job">,
): void {
  assertVersion(payload.v, "Assignment activation payload");
  assertExactKeys(
    payload.ref,
    ["anchorEpoch", "execution", "jobRunId", "taskId"],
    "Activation execution reference",
  );
  if (payload.ref.execution !== "job") {
    throw new TypeError("Activation execution reference must be a job");
  }
  assertIdentifier(payload.ref.jobRunId, "Activation jobRunId");
  assertIdentifier(payload.ref.taskId, "Activation taskId");
  assertPositiveInteger(payload.ref.anchorEpoch, "Activation anchorEpoch");
  assertIdentifier(payload.assignmentId, "Activation assignmentId");
  assertIdentifier(payload.executorId, "Activation executorId");
  assertDigest(payload.manifestDigest, "Activation manifest digest");
  assertDigest(payload.permissionLeaseDigest, "Activation permission lease digest");
  assertArtifactRef(payload.dispatchRef, "Activation dispatchRef");
  assertExactKeys(payload.commit, ["envelopeDigest", "lsn"], "Activation commit");
  assertExactKeys(payload.reservation, ["attempt", "reservationId"], "Activation reservation");
  assertIdentifier(payload.reservation.reservationId, "Activation reservationId");
  assertNonNegativeInteger(payload.reservation.attempt, "Activation reservation attempt");
  assertCanonicalTime(payload.issuedAt, "Activation issuedAt");
  assertDigest(payload.commit.envelopeDigest, "Activation commit digest");
  if (!Number.isSafeInteger(payload.commit.lsn) || payload.commit.lsn <= 0) {
    throw new TypeError("Activation commit LSN must be a positive safe integer");
  }
  assertSortedUnique(payload.capIds, "Activation capability ids");
}

function assertDispatchConflictPayload(
  payload: Omit<DispatchConflictProof, "signature">,
): void {
  assertExactKeys(
    payload,
    [
      "acceptedActivationDigest",
      "acceptedDispatchRef",
      "assignmentId",
      "conflictingActivationDigest",
      "conflictingDispatchRef",
      "error",
      "executorId",
      "receivedLedgerDigest",
      "receivedRecordSeq",
      "v",
    ],
    "Dispatch conflict payload",
  );
  assertVersion(payload.v, "Dispatch conflict proof");
  assertIdentifier(payload.assignmentId, "Dispatch conflict assignmentId");
  assertIdentifier(payload.executorId, "Dispatch conflict executorId");
  assertArtifactRef(payload.acceptedDispatchRef, "Accepted dispatch reference");
  assertArtifactRef(payload.conflictingDispatchRef, "Conflicting dispatch reference");
  assertDigest(payload.acceptedActivationDigest, "Accepted activation digest");
  assertDigest(payload.conflictingActivationDigest, "Conflicting activation digest");
  if (payload.acceptedActivationDigest === payload.conflictingActivationDigest) {
    throw new TypeError("Dispatch conflict activation digests must differ");
  }
  assertPositiveInteger(payload.receivedRecordSeq, "Received record sequence");
  assertDigest(payload.receivedLedgerDigest, "Received ledger digest");
  assertExactKeys(payload.error, ["code", "retryable"], "Dispatch conflict error");
  if (payload.error.code !== "idempotency-conflict" || payload.error.retryable !== false) {
    throw new TypeError("Dispatch conflict error must be a non-retryable idempotency conflict");
  }
}

function assertSupersedePayload(payload: UnsignedSupersedeProof): void {
  assertExactKeys(
    payload,
    [
      "assignmentId",
      "decision",
      "executorId",
      "fence",
      "lastRecordSeq",
      "ledgerDigest",
      "v",
    ],
    "Supersede payload",
  );
  assertVersion(payload.v, "Supersede proof");
  assertIdentifier(payload.assignmentId, "Supersede assignmentId");
  assertIdentifier(payload.executorId, "Supersede executorId");
  assertExactKeys(payload.fence, ["fenceSeq", "requestId"], "Supersede fence");
  assertPositiveInteger(payload.fence.fenceSeq, "Supersede fence sequence");
  assertIdentifier(payload.fence.requestId, "Supersede requestId");
  if (
    payload.decision !== "not-started-fenced" &&
    payload.decision !== "already-started"
  ) {
    throw new TypeError("Supersede decision is invalid");
  }
  assertPositiveInteger(payload.lastRecordSeq, "Supersede record sequence");
  assertDigest(payload.ledgerDigest, "Supersede ledger digest");
}

function assertCancelProofPayload(
  payload: UnsignedCancelProof,
): void {
  const causeKeys =
    payload.cause === "owner-fence"
      ? ["fence"]
      : payload.cause === "abort-ticket"
        ? ["surfacePrincipal", "ticketDigest"]
        : [];
  const decisionKeys = payload.decision === "halted" ? ["lastEffectSeq"] : [];
  assertExactKeys(
    payload,
    [
      "assignmentId",
      "authority",
      "cause",
      "decision",
      "executorId",
      "issuedAt",
      "lastRecordSeq",
      "ledgerDigest",
      ...causeKeys,
      ...decisionKeys,
      "usageFinal",
      "v",
    ],
    "Cancel proof payload",
  );
  assertVersion(payload.v, "Cancel proof");
  assertIdentifier(payload.assignmentId, "Cancel proof assignmentId");
  assertIdentifier(payload.executorId, "Cancel proof executorId");
  assertAuthorityEpoch(payload.authority);
  assertPositiveInteger(payload.lastRecordSeq, "Cancel proof record sequence");
  assertExactKeys(
    payload.usageFinal,
    ["reportDigest", "upToUsageSeq"],
    "Cancel proof usage final",
  );
  assertDigest(payload.usageFinal.reportDigest, "Cancel proof usage digest");
  assertNonNegativeInteger(payload.usageFinal.upToUsageSeq, "Cancel proof usage sequence");
  assertDigest(payload.ledgerDigest, "Cancel proof ledger digest");
  assertCanonicalTime(payload.issuedAt, "Cancel proof issuedAt");
  if (payload.cause === "owner-fence") {
    assertExactKeys(payload.fence, ["fenceSeq", "requestId"], "Cancel fence");
    assertPositiveInteger(payload.fence.fenceSeq, "Cancel fence sequence");
    assertIdentifier(payload.fence.requestId, "Cancel fence requestId");
  } else if (payload.cause === "abort-ticket") {
    assertDigest(payload.ticketDigest, "Abort ticket digest");
    assertIdentifier(payload.surfacePrincipal, "Abort surface principal");
  } else {
    throw new TypeError("Cancel proof cause is invalid");
  }
  if (payload.decision === "not-started") return;
  if (payload.decision === "halted") {
    assertNonNegativeInteger(payload.lastEffectSeq, "Cancel proof last effect sequence");
    return;
  }
  throw new TypeError("Cancel proof decision is invalid");
}

function assertAuthorityEpoch(
  value: CancelProofBody["authority"],
): void {
  if (value.execution === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "execution", "ownerEpoch"],
      "Conversation authority epoch",
    );
    assertIdentifier(value.conversationId, "Authority conversationId");
    assertNonNegativeInteger(value.ownerEpoch, "Authority owner epoch");
    return;
  }
  if (value.execution === "job") {
    assertExactKeys(value, ["anchorEpoch", "execution", "taskId"], "Job authority epoch");
    assertIdentifier(value.taskId, "Authority taskId");
    assertNonNegativeInteger(value.anchorEpoch, "Authority anchor epoch");
    return;
  }
  throw new TypeError("Cancel proof authority kind is invalid");
}

function assertAuthorityError(
  value: DispatchRejectionProof["error"],
  label: string,
): void {
  validateAuthorityErrorContract(value, label);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertAssignmentArtifactTransferGrantPayload(
  payload: Omit<AssignmentArtifactTransferGrant, "signature">,
): void {
  assertVersion(payload.v, "Assignment artifact transfer grant");
  assertIdentifier(payload.assignmentId, "Artifact grant assignmentId");
  assertIdentifier(payload.executorId, "Artifact grant executorId");
  assertIdentifier(payload.capId, "Artifact grant capId");
  assertIdentifier(payload.sourceDeviceId, "Artifact grant sourceDeviceId");
  assertIdentifier(payload.targetDeviceId, "Artifact grant targetDeviceId");
  if (
    payload.direction !== "owner-to-executor" &&
    payload.direction !== "executor-to-owner"
  ) {
    throw new TypeError("Assignment artifact grant direction is invalid");
  }
  assertDigest(payload.activationDigest, "Artifact grant activation digest");
  if (
    !Array.isArray(payload.refs) ||
    payload.refs.length === 0 ||
    payload.refs.length > MAX_ASSIGNMENT_ARTIFACT_GRANT_REFS
  ) {
    throw new RangeError("Assignment artifact grant reference count is out of range");
  }
  assertArtifactRefs(payload.refs, "Assignment artifact grant references");
  const totalBytes = payload.refs.reduce((total, ref) => total + ref.bytes, 0);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > MAX_ASSIGNMENT_ARTIFACT_GRANT_BYTES ||
    payload.totalBytes !== totalBytes
  ) {
    throw new RangeError("Assignment artifact grant byte budget is invalid");
  }
  assertCanonicalTime(payload.issuedAt, "Artifact grant issuedAt");
  assertCanonicalTime(payload.expiry, "Artifact grant expiry");
  if (Date.parse(payload.expiry) <= Date.parse(payload.issuedAt)) {
    throw new RangeError("Assignment artifact grant expiry must follow issuance");
  }
  if (
    Date.parse(payload.expiry) - Date.parse(payload.issuedAt) >
    MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS
  ) {
    throw new RangeError("Assignment artifact grant TTL exceeds the protocol limit");
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

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}
