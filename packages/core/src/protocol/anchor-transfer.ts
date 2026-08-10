import type {
  AnchorTransferAbort,
  AnchorTransferCommand,
  AnchorTransferCommit,
  AnchorTransferResult,
  ArtifactRef,
  AuthorityCatalog,
  AuthorityCatalogCoverage,
  CheckpointEnvelope,
  DisasterRecoveryAbort,
  DisasterRecoveryBaseline,
  DisasterRecoveryCommand,
  DisasterRecoveryResult,
  Digest,
  HomeTrustEvent,
  HomeTrustRecord,
  RecoveryCheckpointVerification,
  ReadyProof,
  Signature,
  SourceFreezeProof,
  TransferRecord,
} from "../contracts/index.js";
import { byteDigest, canonicalize, compareCanonicalStrings, protocolDigest } from "./canonical.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";
import { assertPrefixedUlid, assertProtocolIdentifier } from "./validation.js";
import {
  sourceFreezeProofDigest,
  validateSourceFreezeProof,
} from "./conversation-transfer.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const COVERAGE: readonly AuthorityCatalogCoverage[] = Object.freeze([
  "conversation-authority",
  "conversation-content",
  "execution-assets",
  "global-authority",
  "pending-obligations",
  "trust-and-anchor",
]);
const FULL_CHECKPOINT_SCOPE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);

type PlannedCommit = Extract<AnchorTransferCommit, { mode: "planned" }>;
type PlannedRecord = Extract<TransferRecord, { mode: "planned" }>;
type DisasterCommit = Extract<AnchorTransferCommit, { mode: "disaster-recovery" }>;
type DisasterRecord = Extract<TransferRecord, { mode: "disaster-recovery" }>;
type WithoutSignature<T> = T extends { signature: Signature } ? Omit<T, "signature"> : never;

export type UnsignedReadyProof = Omit<ReadyProof, "signature" | "issuerPossession">;
export type UnsignedPlannedAnchorTransferCommit = Omit<PlannedCommit, "signature">;
export type UnsignedAnchorTransferAbort = Omit<AnchorTransferAbort, "signature">;
export type UnsignedAnchorTransferCommand = WithoutSignature<AnchorTransferCommand>;
export type UnsignedDisasterRecoveryAbort = Omit<DisasterRecoveryAbort, "signature">;
export type UnsignedDisasterRecoveryCommand = WithoutSignature<DisasterRecoveryCommand>;
export type UnsignedDisasterRecoveryCommit = Omit<DisasterCommit, "signature">;

export interface DisasterRecoveryVerifiers {
  readonly recoveryRoot: ProtocolSignatureVerifier;
  readonly targetDevice: ProtocolSignatureVerifier;
  readonly targetIssuer: ProtocolSignatureVerifier;
}

export type DisasterRecoveryPhase =
  | "prepared"
  | "imported"
  | "committed"
  | "tombstoned"
  | "aborted";

export interface DisasterRecoveryState {
  readonly identity: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
    readonly checkpointTargetId: string;
    readonly homeId: string;
    readonly rootKeyId: string;
    readonly recipientKeyId: string;
    readonly checkpointEnvelopeDigest: Digest;
  };
  readonly phase: DisasterRecoveryPhase;
  readonly prepare: Extract<DisasterRecoveryCommand, { op: "prepare" }>;
  readonly imported?: Extract<DisasterRecoveryCommand, { op: "import" }>;
  readonly commit?: DisasterCommit;
  readonly abort?: DisasterRecoveryAbort;
  readonly recordDigests: Readonly<Record<string, Digest>>;
}

export type PlannedAnchorTransferPhase =
  | "prepared"
  | "fenced"
  | "frozen"
  | "imported"
  | "committed"
  | "tombstoned"
  | "aborted";

export interface PlannedAnchorTransferState {
  readonly identity: {
    readonly requestId: string;
    readonly transferId: string;
    readonly sourceDeviceId: string;
    readonly targetDeviceId: string;
    readonly sourceAnchorEpoch: number;
    readonly nextAnchorEpoch: number;
  };
  readonly phase: PlannedAnchorTransferPhase;
  readonly readyProof: ReadyProof;
  readonly trustTransition: HomeTrustEvent;
  readonly recoveryCheckpointDigest?: Digest;
  readonly checkpoint?: ArtifactRef;
  readonly catalog?: AuthorityCatalog;
  readonly catalogRef?: ArtifactRef;
  readonly proof?: SourceFreezeProof;
  readonly commit?: PlannedCommit;
  readonly abort?: AnchorTransferAbort;
  readonly recordDigests: Readonly<Record<string, Digest>>;
}

export interface PreparedAuthorityCatalog {
  readonly catalog: AuthorityCatalog;
  readonly bytes: Uint8Array;
  readonly ref: ArtifactRef;
}

export function prepareAuthorityCatalog(input: unknown): PreparedAuthorityCatalog {
  const catalog = validateAuthorityCatalog(input);
  const bytes = Buffer.from(canonicalize(catalog), "utf8");
  return { catalog, bytes, ref: { digest: byteDigest(bytes), bytes: bytes.byteLength } };
}

export function validateAuthorityCatalog(input: unknown): AuthorityCatalog {
  const value = clone(input, "Authority catalog");
  exact(value, [
    "authorityRecords", "coverage", "pendingObligations", "retainedArtifacts",
    "source", "sourceAnchorEpoch", "sourceDeviceId", "streams", "targetDeviceId",
    "transferId", "trust", "v",
  ], "Authority catalog");
  version(value.v, "Authority catalog");
  transferId(value.transferId, "Authority catalog transferId");
  identifier(value.sourceDeviceId, "Authority catalog sourceDeviceId");
  identifier(value.targetDeviceId, "Authority catalog targetDeviceId");
  positive(value.sourceAnchorEpoch, "Authority catalog sourceAnchorEpoch");
  object(value.source, "Authority catalog source");
  exact(value.source, ["frameEndOffset", "logId", "lsn", "prefixDigest"], "Authority catalog source");
  identifier(value.source.logId, "Authority catalog source logId");
  nonnegative(value.source.lsn, "Authority catalog source lsn");
  nonnegative(value.source.frameEndOffset, "Authority catalog source frameEndOffset");
  digest(value.source.prefixDigest, "Authority catalog source prefixDigest");
  object(value.trust, "Authority catalog trust");
  exact(value.trust, ["chainHead", "homeId", "issuerDeviceId", "issuerKeyId", "trustEpoch"], "Authority catalog trust");
  identifier(value.trust.homeId, "Authority catalog homeId");
  identifier(value.trust.issuerDeviceId, "Authority catalog issuerDeviceId");
  identifier(value.trust.issuerKeyId, "Authority catalog issuerKeyId");
  positive(value.trust.trustEpoch, "Authority catalog trustEpoch");
  chainHead(value.trust.chainHead, "Authority catalog trust chainHead");
  canonicalStringArray(value.coverage, "Authority catalog coverage", new Set(COVERAGE));
  if (canonicalize(value.coverage) !== canonicalize(COVERAGE)) {
    throw new TypeError("Authority catalog coverage must be the complete canonical set");
  }
  artifact(value.authorityRecords, "Authority catalog authorityRecords");
  artifactArray(value.retainedArtifacts, "Authority catalog retainedArtifacts");
  streams(value.streams, value.source.lsn as number);
  obligations(value.pendingObligations);
  return value as unknown as AuthorityCatalog;
}

export function authorityCatalogDigest(catalog: AuthorityCatalog): Digest {
  return protocolDigest("AuthorityCatalog", 1, validateAuthorityCatalog(catalog));
}

export function createSignedReadyProof(
  input: UnsignedReadyProof,
  deviceSigner: ProtocolSigner,
  issuerSigner: ProtocolSigner,
): ReadyProof {
  const payload = validateUnsignedReadyProof(input);
  return {
    ...payload,
    signature: deviceSigner.sign("ReadyProof", 1, payload),
    issuerPossession: issuerSigner.sign("ReadyProofIssuerPossession", 1, payload),
  };
}

export function validateReadyProof(
  input: unknown,
  deviceVerifier: ProtocolSignatureVerifier,
  issuerVerifier: ProtocolSignatureVerifier,
  now = Date.now(),
): ReadyProof {
  const value = clone(input, "Ready proof");
  exact(value, [
    "assetRevision", "candidateDigest", "configuredCapabilities", "credentialRevision",
    "expiresAt", "homeId", "issuedAt", "issuerPossession", "protocolRevision", "requestId",
    "roles", "secretStore", "serviceRevision",
    "signature", "targetDeviceId", "targetIssuerKeyId", "targetIssuerPublicKey",
    "transferId", "trustChainHead", "trustEpoch", "v",
  ], "Ready proof");
  signature(value.signature, "Ready proof signature");
  signature(value.issuerPossession, "Ready proof issuer possession");
  const { signature: deviceSignature, issuerPossession, ...unsigned } = value;
  const payload = validateUnsignedReadyProof(unsigned as unknown as UnsignedReadyProof);
  deviceVerifier.verify("ReadyProof", 1, payload, deviceSignature);
  issuerVerifier.verify("ReadyProofIssuerPossession", 1, payload, issuerPossession);
  if (deviceSignature.keyId !== payload.targetDeviceId) {
    throw new TypeError("Ready proof is not signed by its target device");
  }
  if (issuerPossession.keyId !== payload.targetIssuerKeyId) {
    throw new TypeError("Ready proof issuer possession uses another key");
  }
  if (Date.parse(payload.issuedAt) > now || Date.parse(payload.expiresAt) <= now) {
    throw new TypeError("Ready proof is not currently active");
  }
  return value as unknown as ReadyProof;
}

export function readyProofDigest(proof: ReadyProof): Digest {
  const { signature: _, issuerPossession: __, ...payload } = proof;
  return protocolDigest("ReadyProof", 1, payload);
}

export function createSignedPlannedAnchorTransferCommit(
  input: UnsignedPlannedAnchorTransferCommit,
  signer: ProtocolSigner,
): PlannedCommit {
  const payload = validateUnsignedPlannedCommit(input);
  return { ...payload, signature: signer.sign("AnchorTransferCommit", 1, payload) };
}

export function validatePlannedAnchorTransferCommit(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): PlannedCommit {
  const value = clone(input, "Planned anchor transfer commit");
  exact(value, [
    "at", "authorityCatalogDigest", "checkpointDigest", "freezeProofDigest", "mode",
    "nextAnchorEpoch", "nextTrustEpoch", "readyProofDigest", "signature", "sourceDeviceId",
    "targetDeviceId", "targetIssuerPublicKey", "transferId", "trustTransitionDigest", "v",
  ], "Planned anchor transfer commit");
  signature(value.signature, "Planned anchor transfer commit signature");
  const { signature: signed, ...unsigned } = value;
  const payload = validateUnsignedPlannedCommit(unsigned as unknown as UnsignedPlannedAnchorTransferCommit);
  verifier.verify("AnchorTransferCommit", 1, payload, signed);
  return value as unknown as PlannedCommit;
}

export function anchorTransferCommitDigest(commit: AnchorTransferCommit): Digest {
  const { signature: _, ...payload } = commit;
  return protocolDigest("AnchorTransferCommit", 1, payload);
}

export function createSignedDisasterRecoveryCommit(
  input: UnsignedDisasterRecoveryCommit,
  signer: ProtocolSigner,
): DisasterCommit {
  const payload = validateUnsignedDisasterCommit(input);
  return { ...payload, signature: signer.sign("AnchorTransferCommit", 1, payload) };
}

export function validateDisasterRecoveryCommit(
  input: unknown,
  recoveryRoot: ProtocolSignatureVerifier,
): DisasterCommit {
  const value = clone(input, "Disaster recovery commit");
  exact(value, [
    "at", "authorityCatalogDigest", "checkpointEnvelopeDigest", "mode",
    "nextAnchorEpoch", "nextTrustEpoch", "readyProofDigest", "signature",
    "targetDeviceId", "targetIssuerPublicKey", "transferId", "trustTransitionDigest", "v",
  ], "Disaster recovery commit");
  signature(value.signature, "Disaster recovery commit signature");
  const { signature: signed, ...unsigned } = value;
  const payload = validateUnsignedDisasterCommit(unsigned as unknown as UnsignedDisasterRecoveryCommit);
  recoveryRoot.verify("AnchorTransferCommit", 1, payload, signed);
  return value as unknown as DisasterCommit;
}

export function createSignedDisasterRecoveryAbort(
  input: UnsignedDisasterRecoveryAbort,
  signer: ProtocolSigner,
): DisasterRecoveryAbort {
  const payload = validateUnsignedDisasterAbort(input);
  return { ...payload, signature: signer.sign("DisasterRecoveryAbort", 1, payload) };
}

export function validateDisasterRecoveryAbort(
  input: unknown,
  recoveryRoot: ProtocolSignatureVerifier,
): DisasterRecoveryAbort {
  const value = clone(input, "Disaster recovery abort");
  exact(value, [
    "at", "checkpointEnvelopeDigest", "checkpointTargetId", "mode", "reason", "requestId", "signature",
    "targetDeviceId", "transferId", "v",
  ], "Disaster recovery abort");
  signature(value.signature, "Disaster recovery abort signature");
  const { signature: signed, ...unsigned } = value;
  const payload = validateUnsignedDisasterAbort(unsigned as unknown as UnsignedDisasterRecoveryAbort);
  recoveryRoot.verify("DisasterRecoveryAbort", 1, payload, signed);
  return value as unknown as DisasterRecoveryAbort;
}

export function disasterRecoveryAbortDigest(abort: DisasterRecoveryAbort): Digest {
  const { signature: _, ...payload } = abort;
  return protocolDigest("DisasterRecoveryAbort", 1, payload);
}

export function createSignedDisasterRecoveryCommand(
  input: UnsignedDisasterRecoveryCommand,
  signer: ProtocolSigner,
): DisasterRecoveryCommand {
  const payload = validateUnsignedDisasterCommand(input);
  return {
    ...payload,
    signature: signer.sign("DisasterRecoveryCommand", 1, payload),
  } as DisasterRecoveryCommand;
}

export function validateDisasterRecoveryCommand(
  input: unknown,
  verifiers: DisasterRecoveryVerifiers,
  now = Date.now(),
): DisasterRecoveryCommand {
  const value = clone(input, "Disaster recovery command");
  signature(value.signature, "Disaster recovery command signature");
  const { signature: signed, ...unsigned } = value;
  const payload = validateUnsignedDisasterCommand(unsigned as unknown as UnsignedDisasterRecoveryCommand);
  verifiers.recoveryRoot.verify("DisasterRecoveryCommand", 1, payload, signed);
  if (payload.op === "prepare") {
    if (signed.keyId !== payload.recoveryRoot.rootKeyId) {
      throw new TypeError("Disaster prepare is not signed by its recovery root");
    }
  } else if (payload.op === "import") {
    validateImportedDisasterFacts(payload, verifiers, now);
  } else if (payload.op === "commit") {
    const commit = validateDisasterRecoveryCommit(payload.commit, verifiers.recoveryRoot);
    if (commit.transferId !== payload.transferId) {
      throw new TypeError("Disaster commit command changes transferId");
    }
  } else if (payload.op === "abort") {
    const abort = validateDisasterRecoveryAbort(payload.abort, verifiers.recoveryRoot);
    if (abort.transferId !== payload.transferId) {
      throw new TypeError("Disaster abort command changes transferId");
    }
  }
  return value as unknown as DisasterRecoveryCommand;
}

export function validateDisasterRecoveryResult(
  input: unknown,
  command: DisasterRecoveryCommand,
  recoveryRoot?: ProtocolSignatureVerifier,
): DisasterRecoveryResult {
  const value = clone(input, "Disaster recovery result");
  version(value.v, "Disaster recovery result");
  identifier(value.requestId, "Disaster recovery result requestId");
  transferId(value.transferId, "Disaster recovery result transferId");
  if (value.requestId !== command.requestId || value.transferId !== command.transferId) {
    throw new TypeError("Disaster recovery result does not bind its originating command");
  }
  if (value.status === "rejected") {
    exact(value, ["error", "requestId", "status", "transferId", "v"], "Disaster recovery rejected result");
    object(value.error, "Disaster recovery result error");
    exact(value.error, ["code", "retryable"], "Disaster recovery result error");
    if (!ERROR_CODES.has(value.error.code as string) || typeof value.error.retryable !== "boolean") {
      throw new TypeError("Disaster recovery result error is invalid");
    }
    return value as unknown as DisasterRecoveryResult;
  }
  if (value.status !== "ok" || !DISASTER_PHASES.has(value.state as DisasterRecoveryPhase)) {
    throw new TypeError("Disaster recovery result status is invalid");
  }
  const state = value.state as DisasterRecoveryPhase;
  const fields = state === "prepared" ? [] : state === "imported" ? ["ref"] :
    state === "committed" || state === "tombstoned" ? ["commit", "trustRecord"] : ["abort"];
  exact(value, ["requestId", ...fields, "state", "status", "transferId", "v"], "Disaster recovery result");
  if (state === "imported") artifact(value.ref, "Disaster recovery result ref");
  if (state === "committed" || state === "tombstoned") {
    if (!recoveryRoot) throw new TypeError("Committed disaster result requires a recovery-root verifier");
    const commit = validateDisasterRecoveryCommit(value.commit, recoveryRoot);
    trustRecord(value.trustRecord, "Disaster recovery result trust record");
    if (command.op === "commit" && canonicalize(commit) !== canonicalize(command.commit)) {
      throw new TypeError("Disaster recovery result changes the originating commit");
    }
  }
  if (state === "aborted") {
    if (!recoveryRoot) throw new TypeError("Aborted disaster result requires a recovery-root verifier");
    const abort = validateDisasterRecoveryAbort(value.abort, recoveryRoot);
    if (command.op === "abort" && canonicalize(abort) !== canonicalize(command.abort)) {
      throw new TypeError("Disaster recovery result changes the originating abort");
    }
  }
  return value as unknown as DisasterRecoveryResult;
}

export function createSignedAnchorTransferAbort(
  input: UnsignedAnchorTransferAbort,
  signer: ProtocolSigner,
): AnchorTransferAbort {
  const payload = validateUnsignedAbort(input);
  return { ...payload, signature: signer.sign("AnchorTransferAbort", 1, payload) };
}

export function validateAnchorTransferAbort(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AnchorTransferAbort {
  const value = clone(input, "Anchor transfer abort");
  exact(value, [
    "at", "reason", "requestId", "signature", "sourceAnchorEpoch", "sourceDeviceId",
    "targetDeviceId", "transferId", "v",
  ], "Anchor transfer abort");
  signature(value.signature, "Anchor transfer abort signature");
  const { signature: signed, ...unsigned } = value;
  const payload = validateUnsignedAbort(unsigned as unknown as UnsignedAnchorTransferAbort);
  verifier.verify("AnchorTransferAbort", 1, payload, signed);
  return value as unknown as AnchorTransferAbort;
}

export function anchorTransferAbortDigest(abort: AnchorTransferAbort): Digest {
  const { signature: _, ...payload } = abort;
  return protocolDigest("AnchorTransferAbort", 1, payload);
}

export function createSignedAnchorTransferCommand(
  input: UnsignedAnchorTransferCommand,
  signer: ProtocolSigner,
): AnchorTransferCommand {
  const payload = validateUnsignedCommand(input);
  return { ...payload, signature: signer.sign("AnchorTransferCommand", 1, payload) } as AnchorTransferCommand;
}

export function validateAnchorTransferCommand(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AnchorTransferCommand {
  const value = clone(input, "Anchor transfer command");
  signature(value.signature, "Anchor transfer command signature");
  const { signature: signed, ...unsigned } = value;
  const payload = validateUnsignedCommand(unsigned as unknown as UnsignedAnchorTransferCommand);
  verifier.verify("AnchorTransferCommand", 1, payload, signed);
  if (payload.op === "freeze") {
    const proof = validateSourceFreezeProof(payload.proof, verifier);
    if (proof.scope !== "anchor" || proof.transferId !== payload.transferId || proof.checkpointDigest !== payload.checkpoint.digest) {
      throw new TypeError("Freeze command proof does not bind its anchor checkpoint");
    }
  } else if (payload.op === "commit") {
    const commit = validatePlannedAnchorTransferCommit(payload.commit, verifier);
    if (commit.transferId !== payload.transferId) throw new TypeError("Commit command changes transferId");
  } else if (payload.op === "abort") {
    const abort = validateAnchorTransferAbort(payload.abort, verifier);
    if (abort.transferId !== payload.transferId) throw new TypeError("Abort command changes transferId");
  }
  return value as unknown as AnchorTransferCommand;
}

export function validateAnchorTransferResult(
  input: unknown,
  command: AnchorTransferCommand,
  verifier?: ProtocolSignatureVerifier,
): AnchorTransferResult {
  const value = clone(input, "Anchor transfer result");
  version(value.v, "Anchor transfer result");
  identifier(value.requestId, "Anchor transfer result requestId");
  transferId(value.transferId, "Anchor transfer result transferId");
  if (value.requestId !== command.requestId || value.transferId !== command.transferId) {
    throw new TypeError("Anchor transfer result does not bind its originating command");
  }
  if (value.status === "range") {
    exact(value, ["data", "offset", "ref", "requestId", "status", "transferId", "v"], "Anchor transfer range result");
    if (command.op !== "read-range") throw new TypeError("Range result is not valid for this command");
    artifact(value.ref, "Anchor transfer range ref");
    nonnegative(value.offset, "Anchor transfer range offset");
    if (canonicalize(value.ref) !== canonicalize(command.ref) || value.offset !== command.offset) {
      throw new TypeError("Range result does not bind its originating range");
    }
    if (typeof value.data !== "string" || !BASE64.test(value.data)) throw new TypeError("Range result data is invalid");
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > command.length || command.offset + bytes.byteLength > command.ref.bytes) {
      throw new TypeError("Range result exceeds its originating range");
    }
  } else if (value.status === "rejected") {
    exact(value, ["error", "requestId", "status", "transferId", "v"], "Anchor transfer rejected result");
    object(value.error, "Anchor transfer result error");
    exact(value.error, ["code", "retryable"], "Anchor transfer result error");
    if (!ERROR_CODES.has(value.error.code as string) || typeof value.error.retryable !== "boolean") {
      throw new TypeError("Anchor transfer result error is invalid");
    }
  } else if (value.status === "ok") {
    if (!PHASES.has(value.state as PlannedAnchorTransferPhase)) throw new TypeError("Anchor transfer result state is invalid");
    const state = value.state as PlannedAnchorTransferPhase;
    const field = state === "prepared" || state === "fenced" ? [] :
      state === "frozen" || state === "imported" ? ["ref"] :
        state === "committed" || state === "tombstoned" ? ["commit", "trustRecord"] : ["abort"];
    exact(value, ["requestId", ...field, "state", "status", "transferId", "v"], "Anchor transfer result");
    if (state === "frozen" || state === "imported") artifact(value.ref, "Anchor transfer result ref");
    if (state === "committed" || state === "tombstoned") {
      if (!verifier) throw new TypeError("Committed result requires a verifier");
      const commit = validatePlannedAnchorTransferCommit(value.commit, verifier);
      object(value.trustRecord, "Anchor transfer result trust record");
      if (command.op === "commit" && canonicalize(commit) !== canonicalize(command.commit)) {
        throw new TypeError("Committed result changes the originating commit");
      }
    }
    if (state === "aborted") {
      if (!verifier) throw new TypeError("Aborted result requires a verifier");
      const abort = validateAnchorTransferAbort(value.abort, verifier);
      if (command.op === "abort" && canonicalize(abort) !== canonicalize(command.abort)) {
        throw new TypeError("Aborted result changes the originating abort");
      }
    }
  } else {
    throw new TypeError("Anchor transfer result status is invalid");
  }
  return value as unknown as AnchorTransferResult;
}

export function reducePlannedAnchorTransfer(
  current: PlannedAnchorTransferState | undefined,
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): PlannedAnchorTransferState {
  const record = plannedRecord(input);
  const recordDigest = protocolDigest("TransferRecord", 1, record);
  const prior = current?.recordDigests[record.t];
  if (prior) {
    if (prior !== recordDigest) throw new TypeError(`Conflicting ${record.t} record`);
    return current!;
  }
  if (current && record.transferId !== current.identity.transferId) throw new TypeError("Anchor transfer identity changed");
  if (record.t === "anchor-prepared") {
    if (current) throw new TypeError("Anchor prepared must be the first record");
    const readyProof = record.readyProof;
    if (
      readyProof.transferId !== record.transferId ||
      readyProof.targetDeviceId !== record.targetDeviceId ||
      record.nextAnchorEpoch !== record.sourceAnchorEpoch + 1 ||
      record.trustTransition.body.t !== "issuer-transition" ||
      record.trustTransition.body.reason !== "migration" ||
      record.trustTransition.body.toDeviceId !== record.targetDeviceId ||
      record.trustTransition.body.toIssuerKeyId !== readyProof.targetIssuerKeyId ||
      record.trustTransition.body.toIssuerPublicKey !== readyProof.targetIssuerPublicKey ||
      record.trustTransition.body.nextTrustEpoch !== readyProof.trustEpoch + 1
    ) throw new TypeError("Anchor prepared identities are inconsistent");
    return {
      identity: pickIdentity(record), phase: "prepared", readyProof,
      trustTransition: record.trustTransition,
      recordDigests: { [record.t]: recordDigest },
    };
  }
  if (!current) throw new TypeError("Anchor transfer has no prepared record");
  if (record.t === "anchor-fenced") {
    phase(current, "prepared", "fenced");
    if (record.sourceAnchorEpoch !== current.identity.sourceAnchorEpoch) throw new TypeError("Anchor fence epoch changed");
    digest(record.recoveryCheckpointDigest, "Anchor fence recovery checkpoint");
    return advance(current, "fenced", record, { recoveryCheckpointDigest: record.recoveryCheckpointDigest });
  }
  if (record.t === "anchor-frozen") {
    phase(current, "fenced", "frozen");
    const catalog = validateAuthorityCatalog(record.catalog);
    const prepared = prepareAuthorityCatalog(catalog);
    if (
      canonicalize(prepared.ref) !== canonicalize(record.catalogRef) ||
      catalog.transferId !== current.identity.transferId ||
      catalog.sourceAnchorEpoch !== current.identity.sourceAnchorEpoch ||
      catalog.source.lsn !== record.proof.lastLsn ||
      record.proof.scope !== "anchor" ||
      record.proof.transferId !== current.identity.transferId ||
      record.proof.checkpointDigest !== record.checkpoint.digest
    ) throw new TypeError("Frozen anchor transfer artifacts are inconsistent");
    return advance(current, "frozen", record, { checkpoint: record.checkpoint, catalog, catalogRef: record.catalogRef, proof: record.proof });
  }
  if (record.t === "anchor-imported") {
    phase(current, "frozen", "imported");
    if (record.checkpointDigest !== current.checkpoint?.digest || record.authorityCatalogDigest !== current.catalogRef?.digest) {
      throw new TypeError("Imported anchor transfer changes frozen artifacts");
    }
    return advance(current, "imported", record);
  }
  if (record.t === "anchor-committed") {
    phase(current, "imported", "committed");
    const commit = validatePlannedAnchorTransferCommit(record.commit, verifier);
    assertCommitBinding(current, commit);
    return advance(current, "committed", record, { commit });
  }
  if (record.t === "anchor-tombstoned") {
    phase(current, "committed", "tombstoned");
    if (!current.commit || record.commitDigest !== anchorTransferCommitDigest(current.commit)) throw new TypeError("Anchor tombstone changes commit identity");
    return advance(current, "tombstoned", record);
  }
  if (record.t === "anchor-aborted") {
    if (current.phase === "committed" || current.phase === "tombstoned" || current.phase === "aborted") {
      throw new TypeError("Committed or terminal anchor transfer cannot abort");
    }
    const abort = validateAnchorTransferAbort(record.abort, verifier);
    if (
      abort.transferId !== current.identity.transferId || abort.requestId !== current.identity.requestId ||
      abort.sourceDeviceId !== current.identity.sourceDeviceId || abort.targetDeviceId !== current.identity.targetDeviceId ||
      abort.sourceAnchorEpoch !== current.identity.sourceAnchorEpoch
    ) throw new TypeError("Anchor abort changes transfer identity");
    return advance(current, "aborted", record, { abort });
  }
  return assertNever(record);
}

export function reduceDisasterRecovery(
  current: DisasterRecoveryState | undefined,
  input: unknown,
  verifiers: DisasterRecoveryVerifiers,
  now = Date.now(),
): DisasterRecoveryState {
  const record = disasterRecord(input);
  const recordDigest = protocolDigest("TransferRecord", 1, record);
  const prior = current?.recordDigests[record.t];
  if (prior) {
    if (prior !== recordDigest) throw new TypeError(`Conflicting ${record.t} disaster record`);
    return current!;
  }
  if (current && record.transferId !== current.identity.transferId) {
    throw new TypeError("Disaster recovery identity changed");
  }
  if (record.t === "anchor-prepared") {
    if (current) throw new TypeError("Disaster prepared must be the first record");
    const prepare = validateDisasterRecoveryCommand(record.prepare, verifiers, now);
    if (prepare.op !== "prepare" || prepare.transferId !== record.transferId) {
      throw new TypeError("Disaster prepared record has another identity");
    }
    return {
      identity: {
        requestId: prepare.requestId,
        transferId: prepare.transferId,
        targetDeviceId: prepare.targetDeviceId,
        checkpointTargetId: prepare.checkpointTargetId,
        homeId: prepare.recoveryRoot.homeId,
        rootKeyId: prepare.recoveryRoot.rootKeyId,
        recipientKeyId: prepare.recoveryRoot.recipientKeyId,
        checkpointEnvelopeDigest: prepare.checkpointEnvelope.digest,
      },
      phase: "prepared",
      prepare,
      recordDigests: { [record.t]: recordDigest },
    };
  }
  if (!current) throw new TypeError("Disaster recovery has no prepared record");
  if (record.t === "anchor-imported") {
    disasterPhase(current, "prepared", "imported");
    const imported = validateDisasterRecoveryCommand(record.imported, verifiers, now);
    if (imported.op !== "import") throw new TypeError("Disaster imported record has no import command");
    assertDisasterImportedBinding(current, imported);
    return advanceDisaster(current, "imported", record, { imported });
  }
  if (record.t === "anchor-committed") {
    disasterPhase(current, "imported", "committed");
    if (!current.imported) throw new TypeError("Disaster recovery has no imported facts");
    const commit = validateDisasterRecoveryCommit(record.commit, verifiers.recoveryRoot);
    assertDisasterCommitBinding(current.imported, commit);
    return advanceDisaster(current, "committed", record, { commit });
  }
  if (record.t === "anchor-tombstoned") {
    disasterPhase(current, "committed", "tombstoned");
    if (!current.commit || record.commitDigest !== anchorTransferCommitDigest(current.commit)) {
      throw new TypeError("Disaster tombstone changes commit identity");
    }
    return advanceDisaster(current, "tombstoned", record);
  }
  if (record.t === "anchor-aborted") {
    if (current.phase === "committed" || current.phase === "tombstoned" || current.phase === "aborted") {
      throw new TypeError("Committed or terminal disaster recovery cannot abort");
    }
    const abort = validateDisasterRecoveryAbort(record.abort, verifiers.recoveryRoot);
    if (
      abort.requestId !== current.identity.requestId ||
      abort.transferId !== current.identity.transferId ||
      abort.targetDeviceId !== current.identity.targetDeviceId ||
      abort.checkpointTargetId !== current.identity.checkpointTargetId ||
      abort.checkpointEnvelopeDigest !== current.identity.checkpointEnvelopeDigest
    ) throw new TypeError("Disaster abort changes candidate identity");
    return advanceDisaster(current, "aborted", record, { abort });
  }
  return assertNeverDisaster(record);
}

function assertDisasterImportedBinding(
  state: DisasterRecoveryState,
  imported: Extract<DisasterRecoveryCommand, { op: "import" }>,
): void {
  if (
    imported.requestId !== state.identity.requestId ||
    imported.transferId !== state.identity.transferId ||
    imported.targetDeviceId !== state.identity.targetDeviceId ||
    imported.checkpointTargetId !== state.identity.checkpointTargetId ||
    imported.checkpointEnvelopeDigest !== state.identity.checkpointEnvelopeDigest ||
    imported.baseline.homeId !== state.identity.homeId ||
    imported.baseline.recoveryRoot.rootKeyId !== state.identity.rootKeyId ||
    imported.baseline.recoveryRoot.recipientKeyId !== state.identity.recipientKeyId
  ) throw new TypeError("Disaster import changes candidate identity");
}

function assertDisasterCommitBinding(
  imported: Extract<DisasterRecoveryCommand, { op: "import" }>,
  commit: DisasterCommit,
): void {
  if (
    commit.transferId !== imported.transferId ||
    commit.targetDeviceId !== imported.targetDeviceId ||
    commit.checkpointEnvelopeDigest !== imported.checkpointEnvelopeDigest ||
    commit.authorityCatalogDigest !== authorityCatalogDigest(imported.catalog) ||
    commit.trustTransitionDigest !== protocolDigest("HomeTrustEvent", 1, unsignedEvent(imported.trustTransition)) ||
    commit.nextAnchorEpoch !== imported.nextAnchorEpoch ||
    commit.nextTrustEpoch !== imported.nextTrustEpoch ||
    commit.targetIssuerPublicKey !== imported.targetIssuerPublicKey ||
    commit.readyProofDigest !== readyProofDigest(imported.readyProof)
  ) throw new TypeError("Disaster commit does not bind imported facts");
}

function validateUnsignedDisasterCommit(
  input: UnsignedDisasterRecoveryCommit,
): UnsignedDisasterRecoveryCommit {
  const value = clone(input, "Unsigned disaster recovery commit");
  exact(value, [
    "at", "authorityCatalogDigest", "checkpointEnvelopeDigest", "mode",
    "nextAnchorEpoch", "nextTrustEpoch", "readyProofDigest", "targetDeviceId",
    "targetIssuerPublicKey", "transferId", "trustTransitionDigest", "v",
  ], "Unsigned disaster recovery commit");
  version(value.v, "Disaster recovery commit");
  if (value.mode !== "disaster-recovery") throw new TypeError("Disaster recovery commit mode is invalid");
  transferId(value.transferId, "Disaster recovery commit transferId");
  identifier(value.targetDeviceId, "Disaster recovery commit targetDeviceId");
  for (const field of ["checkpointEnvelopeDigest", "authorityCatalogDigest", "trustTransitionDigest", "readyProofDigest"] as const) {
    digest(value[field], `Disaster recovery commit ${field}`);
  }
  positive(value.nextAnchorEpoch, "Disaster recovery commit nextAnchorEpoch");
  positive(value.nextTrustEpoch, "Disaster recovery commit nextTrustEpoch");
  if (typeof value.targetIssuerPublicKey !== "string" || !value.targetIssuerPublicKey.startsWith("ed25519:")) {
    throw new TypeError("Disaster recovery issuer public key is invalid");
  }
  time(value.at, "Disaster recovery commit time");
  return value as unknown as UnsignedDisasterRecoveryCommit;
}

function validateUnsignedDisasterAbort(
  input: UnsignedDisasterRecoveryAbort,
): UnsignedDisasterRecoveryAbort {
  const value = clone(input, "Unsigned disaster recovery abort");
  exact(value, [
    "at", "checkpointEnvelopeDigest", "checkpointTargetId", "mode", "reason", "requestId",
    "targetDeviceId", "transferId", "v",
  ], "Unsigned disaster recovery abort");
  version(value.v, "Disaster recovery abort");
  if (value.mode !== "disaster-recovery") throw new TypeError("Disaster recovery abort mode is invalid");
  identifier(value.requestId, "Disaster recovery abort requestId");
  transferId(value.transferId, "Disaster recovery abort transferId");
  identifier(value.targetDeviceId, "Disaster recovery abort targetDeviceId");
  identifier(value.checkpointTargetId, "Disaster recovery abort checkpointTargetId");
  digest(value.checkpointEnvelopeDigest, "Disaster recovery abort checkpointEnvelopeDigest");
  if (!DISASTER_ABORT_REASONS.has(value.reason as string)) {
    throw new TypeError("Disaster recovery abort reason is invalid");
  }
  time(value.at, "Disaster recovery abort time");
  return value as unknown as UnsignedDisasterRecoveryAbort;
}

function validateUnsignedDisasterCommand(
  input: UnsignedDisasterRecoveryCommand,
): UnsignedDisasterRecoveryCommand {
  const value = clone(input, "Unsigned disaster recovery command");
  version(value.v, "Disaster recovery command");
  identifier(value.requestId, "Disaster recovery command requestId");
  transferId(value.transferId, "Disaster recovery command transferId");
  if (value.op === "prepare") {
    exact(value, [
      "checkpointEnvelope", "checkpointTargetId", "op", "recoveryRoot", "requestId", "targetDeviceId", "transferId", "v",
    ], "Disaster prepare command");
    identifier(value.targetDeviceId, "Disaster prepare targetDeviceId");
    identifier(value.checkpointTargetId, "Disaster prepare checkpointTargetId");
    object(value.recoveryRoot, "Disaster prepare recovery root");
    exact(value.recoveryRoot, ["homeId", "recipientKeyId", "rootKeyId"], "Disaster prepare recovery root");
    identifier(value.recoveryRoot.homeId, "Disaster prepare homeId");
    identifier(value.recoveryRoot.rootKeyId, "Disaster prepare rootKeyId");
    identifier(value.recoveryRoot.recipientKeyId, "Disaster prepare recipientKeyId");
    checkpointEnvelope(value.checkpointEnvelope, "Disaster prepare checkpoint envelope");
    if (value.checkpointEnvelope.recipientKeyId !== value.recoveryRoot.recipientKeyId) {
      throw new TypeError("Disaster prepare uses another recovery-root generation");
    }
  } else if (value.op === "import") {
    exact(value, [
      "baseline", "catalog", "catalogRef", "checkpointEnvelopeDigest", "nextAnchorEpoch",
      "nextTrustEpoch", "onsiteVerification", "op", "readyProof", "requestId", "checkpointTargetId",
      "targetDeviceId", "targetIssuerPublicKey", "transferId", "trustTransition", "v",
    ], "Disaster import command");
    identifier(value.targetDeviceId, "Disaster import targetDeviceId");
    identifier(value.checkpointTargetId, "Disaster import checkpointTargetId");
    digest(value.checkpointEnvelopeDigest, "Disaster import checkpointEnvelopeDigest");
    baseline(value.baseline, "Disaster import baseline");
    verification(value.onsiteVerification, "Disaster import onsite verification");
    validateAuthorityCatalog(value.catalog);
    artifact(value.catalogRef, "Disaster import catalog ref");
    if (canonicalize(prepareAuthorityCatalog(value.catalog).ref) !== canonicalize(value.catalogRef)) {
      throw new TypeError("Disaster import catalog ref does not bind catalog bytes");
    }
    object(value.readyProof, "Disaster import ready proof");
    disasterTransition(value.trustTransition, "Disaster import trust transition");
    positive(value.nextAnchorEpoch, "Disaster import nextAnchorEpoch");
    positive(value.nextTrustEpoch, "Disaster import nextTrustEpoch");
    if (typeof value.targetIssuerPublicKey !== "string" || !value.targetIssuerPublicKey.startsWith("ed25519:")) {
      throw new TypeError("Disaster import issuer public key is invalid");
    }
  } else if (value.op === "commit") {
    exact(value, ["commit", "op", "requestId", "transferId", "v"], "Disaster commit command");
    object(value.commit, "Disaster commit payload");
  } else if (value.op === "abort") {
    exact(value, ["abort", "op", "requestId", "transferId", "v"], "Disaster abort command");
    object(value.abort, "Disaster abort payload");
  } else if (value.op === "tombstone") {
    exact(value, ["at", "commitDigest", "op", "requestId", "transferId", "v"], "Disaster tombstone command");
    digest(value.commitDigest, "Disaster tombstone commitDigest");
    time(value.at, "Disaster tombstone time");
  } else if (value.op === "status") {
    exact(value, ["op", "requestId", "transferId", "v"], "Disaster status command");
  } else {
    throw new TypeError("Disaster recovery command operation is invalid");
  }
  return value as unknown as UnsignedDisasterRecoveryCommand;
}

function validateImportedDisasterFacts(
  imported: Extract<UnsignedDisasterRecoveryCommand, { op: "import" }>,
  verifiers: DisasterRecoveryVerifiers,
  now: number,
): void {
  const proof = validateReadyProof(imported.readyProof, verifiers.targetDevice, verifiers.targetIssuer, now);
  verifiers.recoveryRoot.verify(
    "RecoveryCheckpointVerification",
    1,
    unsignedVerification(imported.onsiteVerification),
    imported.onsiteVerification.signature,
  );
  verifiers.recoveryRoot.verify(
    "HomeTrustEvent",
    1,
    unsignedEvent(imported.trustTransition),
    imported.trustTransition.signature,
  );
  const catalog = validateAuthorityCatalog(imported.catalog);
  const baselineValue = imported.baseline;
  const transition = imported.trustTransition;
  if (
    imported.onsiteVerification.envelopeDigest !== imported.checkpointEnvelopeDigest ||
    imported.onsiteVerification.targetId !== imported.checkpointTargetId ||
    catalog.transferId !== imported.transferId ||
    catalog.targetDeviceId !== imported.targetDeviceId ||
    catalog.sourceAnchorEpoch !== baselineValue.anchorEpoch ||
    catalog.trust.homeId !== baselineValue.homeId ||
    catalog.trust.trustEpoch !== baselineValue.trustEpoch ||
    catalog.trust.chainHead.seq !== baselineValue.chainHead.seq ||
    catalog.trust.chainHead.eventDigest !== baselineValue.chainHead.eventDigest ||
    catalog.trust.issuerDeviceId !== baselineValue.issuer.deviceId ||
    catalog.trust.issuerKeyId !== baselineValue.issuer.issuerKeyId ||
    proof.transferId !== imported.transferId ||
    proof.homeId !== baselineValue.homeId ||
    proof.targetDeviceId !== imported.targetDeviceId ||
    proof.trustEpoch !== baselineValue.trustEpoch ||
    proof.trustChainHead.seq !== baselineValue.chainHead.seq ||
    proof.trustChainHead.eventDigest !== baselineValue.chainHead.eventDigest ||
    transition.homeId !== baselineValue.homeId ||
    transition.trustEpoch !== baselineValue.trustEpoch ||
    transition.body.fromIssuerKeyId !== baselineValue.issuer.issuerKeyId ||
    transition.body.toDeviceId !== imported.targetDeviceId ||
    transition.body.toIssuerKeyId !== proof.targetIssuerKeyId ||
    transition.body.toIssuerPublicKey !== imported.targetIssuerPublicKey ||
    transition.body.nextTrustEpoch !== imported.nextTrustEpoch ||
    imported.nextAnchorEpoch !== baselineValue.anchorEpoch + 1 ||
    imported.nextTrustEpoch !== baselineValue.trustEpoch + 1 ||
    imported.targetIssuerPublicKey !== proof.targetIssuerPublicKey
  ) throw new TypeError("Disaster imported facts do not share one recovery identity");
}

function assertCommitBinding(state: PlannedAnchorTransferState, commit: PlannedCommit): void {
  if (
    !state.proof || !state.catalogRef || !state.checkpoint ||
    commit.transferId !== state.identity.transferId ||
    commit.sourceDeviceId !== state.identity.sourceDeviceId ||
    commit.targetDeviceId !== state.identity.targetDeviceId ||
    commit.freezeProofDigest !== sourceFreezeProofDigest(state.proof) ||
    commit.checkpointDigest !== state.checkpoint.digest ||
    commit.authorityCatalogDigest !== state.catalogRef.digest ||
    commit.trustTransitionDigest !== protocolDigest("HomeTrustEvent", 1, unsignedEvent(state.trustTransition)) ||
    commit.nextAnchorEpoch !== state.identity.nextAnchorEpoch ||
    commit.nextTrustEpoch !== state.readyProof.trustEpoch + 1 ||
    commit.targetIssuerPublicKey !== state.readyProof.targetIssuerPublicKey ||
    commit.readyProofDigest !== readyProofDigest(state.readyProof)
  ) throw new TypeError("Anchor transfer commit does not bind prepared and frozen facts");
}

function validateUnsignedReadyProof(input: UnsignedReadyProof): UnsignedReadyProof {
  const value = clone(input, "Unsigned ready proof");
  exact(value, [
    "assetRevision", "candidateDigest", "configuredCapabilities", "credentialRevision",
    "expiresAt", "homeId", "issuedAt", "protocolRevision", "requestId", "roles",
    "secretStore", "serviceRevision", "targetDeviceId",
    "targetIssuerKeyId", "targetIssuerPublicKey", "transferId", "trustChainHead", "trustEpoch", "v",
  ], "Unsigned ready proof");
  version(value.v, "Ready proof");
  transferId(value.transferId, "Ready proof transferId");
  identifier(value.requestId, "Ready proof requestId");
  identifier(value.homeId, "Ready proof homeId");
  digest(value.candidateDigest, "Ready proof candidateDigest");
  identifier(value.targetDeviceId, "Ready proof targetDeviceId");
  identifier(value.targetIssuerKeyId, "Ready proof targetIssuerKeyId");
  if (typeof value.targetIssuerPublicKey !== "string" || !value.targetIssuerPublicKey.startsWith("ed25519:")) throw new TypeError("Ready proof issuer public key is invalid");
  positive(value.trustEpoch, "Ready proof trustEpoch");
  chainHead(value.trustChainHead, "Ready proof trust chainHead");
  canonicalStringArray(value.roles, "Ready proof roles", new Set(["anchor", "executor", "surface"]));
  if (!(value.roles as string[]).includes("anchor")) throw new TypeError("Ready proof target must enable anchor");
  object(value.configuredCapabilities, "Ready proof configured capabilities");
  exact(value.configuredCapabilities, ["channels", "mcpServers", "providers"], "Ready proof configured capabilities");
  canonicalStringArray(value.configuredCapabilities.providers, "Ready proof providers");
  canonicalStringArray(value.configuredCapabilities.mcpServers, "Ready proof MCP servers");
  canonicalStringArray(value.configuredCapabilities.channels, "Ready proof channels");
  identifier(value.protocolRevision, "Ready proof protocolRevision");
  identifier(value.assetRevision, "Ready proof assetRevision");
  identifier(value.serviceRevision, "Ready proof serviceRevision");
  identifier(value.credentialRevision, "Ready proof credentialRevision");
  if (value.secretStore !== "unlocked") throw new TypeError("Ready proof requires an unlocked SecretStore");
  time(value.issuedAt, "Ready proof issuedAt");
  time(value.expiresAt, "Ready proof expiresAt");
  if (Date.parse(value.expiresAt as string) <= Date.parse(value.issuedAt as string)) throw new TypeError("Ready proof expiry must follow issue time");
  return value as unknown as UnsignedReadyProof;
}

function validateUnsignedPlannedCommit(input: UnsignedPlannedAnchorTransferCommit): UnsignedPlannedAnchorTransferCommit {
  const value = clone(input, "Unsigned planned anchor transfer commit");
  exact(value, [
    "at", "authorityCatalogDigest", "checkpointDigest", "freezeProofDigest", "mode",
    "nextAnchorEpoch", "nextTrustEpoch", "readyProofDigest", "sourceDeviceId", "targetDeviceId",
    "targetIssuerPublicKey", "transferId", "trustTransitionDigest", "v",
  ], "Unsigned planned anchor transfer commit");
  version(value.v, "Anchor transfer commit");
  if (value.mode !== "planned") throw new TypeError("Anchor transfer commit mode must be planned");
  transferId(value.transferId, "Anchor transfer commit transferId");
  identifier(value.sourceDeviceId, "Anchor transfer commit sourceDeviceId");
  identifier(value.targetDeviceId, "Anchor transfer commit targetDeviceId");
  if (value.sourceDeviceId === value.targetDeviceId) throw new TypeError("Anchor transfer target must be another device");
  for (const field of ["freezeProofDigest", "checkpointDigest", "authorityCatalogDigest", "trustTransitionDigest", "readyProofDigest"] as const) digest(value[field], `Anchor transfer commit ${field}`);
  positive(value.nextAnchorEpoch, "Anchor transfer commit nextAnchorEpoch");
  positive(value.nextTrustEpoch, "Anchor transfer commit nextTrustEpoch");
  if (typeof value.targetIssuerPublicKey !== "string" || !value.targetIssuerPublicKey.startsWith("ed25519:")) throw new TypeError("Anchor transfer issuer public key is invalid");
  time(value.at, "Anchor transfer commit time");
  return value as unknown as UnsignedPlannedAnchorTransferCommit;
}

function validateUnsignedAbort(input: UnsignedAnchorTransferAbort): UnsignedAnchorTransferAbort {
  const value = clone(input, "Unsigned anchor transfer abort");
  exact(value, ["at", "reason", "requestId", "sourceAnchorEpoch", "sourceDeviceId", "targetDeviceId", "transferId", "v"], "Unsigned anchor transfer abort");
  version(value.v, "Anchor transfer abort");
  identifier(value.requestId, "Anchor transfer abort requestId");
  transferId(value.transferId, "Anchor transfer abort transferId");
  identifier(value.sourceDeviceId, "Anchor transfer abort sourceDeviceId");
  identifier(value.targetDeviceId, "Anchor transfer abort targetDeviceId");
  positive(value.sourceAnchorEpoch, "Anchor transfer abort sourceAnchorEpoch");
  if (!ABORT_REASONS.has(value.reason as string)) throw new TypeError("Anchor transfer abort reason is invalid");
  time(value.at, "Anchor transfer abort time");
  return value as unknown as UnsignedAnchorTransferAbort;
}

function validateUnsignedCommand(input: UnsignedAnchorTransferCommand): UnsignedAnchorTransferCommand {
  const value = clone(input, "Unsigned anchor transfer command");
  version(value.v, "Anchor transfer command");
  identifier(value.requestId, "Anchor transfer command requestId");
  transferId(value.transferId, "Anchor transfer command transferId");
  if (value.op === "prepare") {
    exact(value, ["nextAnchorEpoch", "op", "readyProof", "requestId", "sourceAnchorEpoch", "sourceDeviceId", "targetDeviceId", "transferId", "trustTransition", "v"], "Anchor prepare command");
    identifier(value.sourceDeviceId, "Anchor prepare sourceDeviceId");
    identifier(value.targetDeviceId, "Anchor prepare targetDeviceId");
    positive(value.sourceAnchorEpoch, "Anchor prepare sourceAnchorEpoch");
    positive(value.nextAnchorEpoch, "Anchor prepare nextAnchorEpoch");
    if ((value.nextAnchorEpoch as number) !== (value.sourceAnchorEpoch as number) + 1) throw new TypeError("Anchor prepare must increment anchorEpoch once");
    object(value.readyProof, "Anchor prepare ready proof");
    object(value.trustTransition, "Anchor prepare trust transition");
  } else if (value.op === "freeze") {
    exact(value, ["catalog", "checkpoint", "op", "proof", "recoveryCheckpointDigest", "requestId", "transferId", "v"], "Anchor freeze command");
    digest(value.recoveryCheckpointDigest, "Anchor freeze recovery checkpoint"); artifact(value.checkpoint, "Anchor freeze checkpoint"); artifact(value.catalog, "Anchor freeze catalog"); object(value.proof, "Anchor freeze proof");
  } else if (value.op === "probe") {
    exact(value, ["op", "ref", "requestId", "transferId", "v"], "Anchor probe command"); artifact(value.ref, "Anchor probe ref");
  } else if (value.op === "read-range") {
    exact(value, ["length", "offset", "op", "ref", "requestId", "transferId", "v"], "Anchor read command"); artifact(value.ref, "Anchor read ref"); nonnegative(value.offset, "Anchor read offset"); positive(value.length, "Anchor read length");
    if ((value.offset as number) + (value.length as number) > (value.ref as unknown as ArtifactRef).bytes) throw new TypeError("Anchor read exceeds artifact bounds");
  } else if (value.op === "import") {
    exact(value, ["catalog", "checkpoint", "op", "requestId", "transferId", "v"], "Anchor import command"); artifact(value.checkpoint, "Anchor import checkpoint"); artifact(value.catalog, "Anchor import catalog");
  } else if (value.op === "commit") {
    exact(value, ["commit", "op", "requestId", "transferId", "v"], "Anchor commit command"); object(value.commit, "Anchor commit payload");
  } else if (value.op === "abort") {
    exact(value, ["abort", "op", "requestId", "transferId", "v"], "Anchor abort command"); object(value.abort, "Anchor abort payload");
  } else if (value.op === "status") {
    exact(value, ["op", "requestId", "transferId", "v"], "Anchor status command");
  } else throw new TypeError("Anchor transfer command operation is invalid");
  return value as unknown as UnsignedAnchorTransferCommand;
}

function plannedRecord(input: unknown): PlannedRecord {
  const value = clone(input, "Planned anchor transfer record");
  version(value.v, "Planned anchor transfer record");
  if (value.mode !== "planned") throw new TypeError("Planned anchor transfer record mode is invalid");
  const keys: Record<string, readonly string[]> = {
    "anchor-prepared": ["mode", "nextAnchorEpoch", "readyProof", "requestId", "sourceAnchorEpoch", "sourceDeviceId", "t", "targetDeviceId", "transferId", "trustTransition", "v"],
    "anchor-fenced": ["at", "mode", "recoveryCheckpointDigest", "sourceAnchorEpoch", "t", "transferId", "v"],
    "anchor-frozen": ["catalog", "catalogRef", "checkpoint", "mode", "proof", "t", "transferId", "v"],
    "anchor-imported": ["authorityCatalogDigest", "checkpointDigest", "mode", "t", "transferId", "v"],
    "anchor-committed": ["commit", "mode", "t", "transferId", "v"],
    "anchor-tombstoned": ["at", "commitDigest", "mode", "t", "transferId", "v"],
    "anchor-aborted": ["abort", "mode", "t", "transferId", "v"],
  };
  const expected = keys[value.t as string];
  if (!expected) throw new TypeError("Planned anchor transfer record kind is invalid");
  exact(value, expected, "Planned anchor transfer record");
  transferId(value.transferId, "Planned anchor transfer record transferId");
  return value as unknown as PlannedRecord;
}

function disasterRecord(input: unknown): DisasterRecord {
  const value = clone(input, "Disaster recovery record");
  version(value.v, "Disaster recovery record");
  if (value.mode !== "disaster-recovery") throw new TypeError("Disaster recovery record mode is invalid");
  const keys: Record<string, readonly string[]> = {
    "anchor-prepared": ["mode", "prepare", "t", "transferId", "v"],
    "anchor-imported": ["imported", "mode", "t", "transferId", "v"],
    "anchor-committed": ["commit", "mode", "t", "transferId", "v"],
    "anchor-tombstoned": ["at", "commitDigest", "mode", "t", "transferId", "v"],
    "anchor-aborted": ["abort", "mode", "t", "transferId", "v"],
  };
  const expected = keys[value.t as string];
  if (!expected) throw new TypeError("Disaster recovery record kind is invalid");
  exact(value, expected, "Disaster recovery record");
  transferId(value.transferId, "Disaster recovery record transferId");
  if (value.t === "anchor-tombstoned") {
    digest(value.commitDigest, "Disaster recovery tombstone commitDigest");
    time(value.at, "Disaster recovery tombstone time");
  }
  return value as unknown as DisasterRecord;
}

function advanceDisaster(
  current: DisasterRecoveryState,
  next: DisasterRecoveryPhase,
  record: DisasterRecord,
  fields: Partial<DisasterRecoveryState> = {},
): DisasterRecoveryState {
  return {
    ...current,
    ...fields,
    phase: next,
    recordDigests: {
      ...current.recordDigests,
      [record.t]: protocolDigest("TransferRecord", 1, record),
    },
  };
}

function disasterPhase(
  state: DisasterRecoveryState,
  expected: DisasterRecoveryPhase,
  next: DisasterRecoveryPhase,
): void {
  if (state.phase !== expected) {
    throw new TypeError(`Disaster recovery cannot enter ${next} from ${state.phase}`);
  }
}

function baseline(input: unknown, label: string): asserts input is DisasterRecoveryBaseline {
  object(input, label);
  exact(input, ["anchorEpoch", "chainHead", "homeId", "issuer", "recoveryRoot", "trustEpoch"], label);
  identifier(input.homeId, `${label} homeId`);
  positive(input.anchorEpoch, `${label} anchorEpoch`);
  positive(input.trustEpoch, `${label} trustEpoch`);
  chainHead(input.chainHead, `${label} chainHead`);
  object(input.issuer, `${label} issuer`);
  exact(input.issuer, ["deviceId", "issuerKeyId"], `${label} issuer`);
  identifier(input.issuer.deviceId, `${label} issuer deviceId`);
  identifier(input.issuer.issuerKeyId, `${label} issuer keyId`);
  object(input.recoveryRoot, `${label} recovery root`);
  exact(input.recoveryRoot, ["recipientKeyId", "rootKeyId"], `${label} recovery root`);
  identifier(input.recoveryRoot.rootKeyId, `${label} recovery root keyId`);
  identifier(input.recoveryRoot.recipientKeyId, `${label} recovery recipient keyId`);
}

function verification(input: unknown, label: string): asserts input is RecoveryCheckpointVerification {
  object(input, label);
  exact(input, [
    "checkpointId", "envelopeDigest", "nonceDigest", "purpose", "recipientKeyId",
    "signature", "targetId", "verifiedAt", "v",
  ], label);
  version(input.v, label);
  identifier(input.checkpointId, `${label} checkpointId`);
  identifier(input.recipientKeyId, `${label} recipientKeyId`);
  identifier(input.targetId, `${label} targetId`);
  digest(input.envelopeDigest, `${label} envelopeDigest`);
  digest(input.nonceDigest, `${label} nonceDigest`);
  object(input.purpose, `${label} purpose`);
  if (input.purpose.kind === "periodic") {
    exact(input.purpose, ["kind"], `${label} purpose`);
  } else if (input.purpose.kind === "root-activation") {
    exact(input.purpose, ["activationDigest", "kind"], `${label} purpose`);
    digest(input.purpose.activationDigest, `${label} activationDigest`);
  } else {
    throw new TypeError(`${label} purpose is invalid`);
  }
  time(input.verifiedAt, `${label} verifiedAt`);
  signature(input.signature, `${label} signature`);
}

function disasterTransition(input: unknown, label: string): asserts input is HomeTrustEvent {
  object(input, label);
  exact(input, ["at", "body", "homeId", "prevEventDigest", "seq", "signature", "trustEpoch", "v"], label);
  version(input.v, label);
  identifier(input.homeId, `${label} homeId`);
  nonnegative(input.seq, `${label} seq`);
  digest(input.prevEventDigest, `${label} prevEventDigest`);
  positive(input.trustEpoch, `${label} trustEpoch`);
  time(input.at, `${label} at`);
  signature(input.signature, `${label} signature`);
  object(input.body, `${label} body`);
  exact(input.body, [
    "fromIssuerKeyId", "nextTrustEpoch", "reason", "signedBy", "t", "toDeviceId",
    "toIssuerKeyId", "toIssuerPublicKey",
  ], `${label} body`);
  if (
    input.body.t !== "issuer-transition" ||
    input.body.reason !== "disaster-recovery" ||
    input.body.signedBy !== "recovery-root"
  ) throw new TypeError(`${label} must be a recovery-root disaster transition`);
  identifier(input.body.fromIssuerKeyId, `${label} fromIssuerKeyId`);
  identifier(input.body.toIssuerKeyId, `${label} toIssuerKeyId`);
  identifier(input.body.toDeviceId, `${label} toDeviceId`);
  positive(input.body.nextTrustEpoch, `${label} nextTrustEpoch`);
  if (typeof input.body.toIssuerPublicKey !== "string" || !input.body.toIssuerPublicKey.startsWith("ed25519:")) {
    throw new TypeError(`${label} target issuer public key is invalid`);
  }
}

function checkpointEnvelope(input: unknown, label: string): asserts input is CheckpointEnvelope {
  object(input, label);
  exact(input, [
    "alg", "checkpointId", "chunks", "createdAt", "digest", "enc", "manifest", "nonceBase",
    "recipientKeyId", "signature", "v", "wrappedDek",
  ], label);
  version(input.v, label);
  identifier(input.checkpointId, `${label} checkpointId`);
  time(input.createdAt, `${label} createdAt`);
  identifier(input.recipientKeyId, `${label} recipientKeyId`);
  object(input.alg, `${label} algorithm`);
  exact(input.alg, ["aead", "kem"], `${label} algorithm`);
  if (input.alg.kem !== "X25519-HKDF-SHA256" || input.alg.aead !== "AES-256-GCM") {
    throw new TypeError(`${label} algorithm is unsupported`);
  }
  for (const field of ["enc", "wrappedDek", "nonceBase"] as const) {
    identifier(input[field], `${label} ${field}`);
  }
  object(input.manifest, `${label} manifest`);
  exact(input.manifest, ["domainRevisions", "purpose", "scope", "upToLsn"], `${label} manifest`);
  if (canonicalize(input.manifest.scope) !== canonicalize(FULL_CHECKPOINT_SCOPE)) {
    throw new TypeError(`${label} scope is not the full authority exact-set`);
  }
  object(input.manifest.domainRevisions, `${label} domain revisions`);
  for (const [key, value] of Object.entries(input.manifest.domainRevisions)) {
    identifier(key, `${label} domain revision key`);
    nonnegative(value, `${label} domain revision`);
  }
  nonnegative(input.manifest.upToLsn, `${label} upToLsn`);
  object(input.manifest.purpose, `${label} purpose`);
  if (input.manifest.purpose.kind === "periodic") {
    exact(input.manifest.purpose, ["kind"], `${label} purpose`);
  } else if (input.manifest.purpose.kind === "root-activation") {
    exact(input.manifest.purpose, ["kind", "plan"], `${label} purpose`);
    object(input.manifest.purpose.plan, `${label} activation plan`);
  } else {
    throw new TypeError(`${label} purpose is invalid`);
  }
  if (!Array.isArray(input.chunks) || input.chunks.length === 0) throw new TypeError(`${label} chunks must be non-empty`);
  for (const [index, chunk] of input.chunks.entries()) {
    object(chunk, `${label} chunk ${index}`);
    exact(chunk, ["bytes", "digest", "seq"], `${label} chunk ${index}`);
    nonnegative(chunk.seq, `${label} chunk ${index} seq`);
    positive(chunk.bytes, `${label} chunk ${index} bytes`);
    digest(chunk.digest, `${label} chunk ${index} digest`);
    if (chunk.seq !== index) throw new TypeError(`${label} chunks must be contiguous`);
  }
  digest(input.digest, `${label} digest`);
  signature(input.signature, `${label} signature`);
}

function trustRecord(input: unknown, label: string): asserts input is HomeTrustRecord {
  object(input, label);
  const recordKeys = ["chainHead", "homeId", "issuer", "members", "signature", "trustEpoch", "v"];
  if (Object.hasOwn(input, "recoveryRootPublicKey")) recordKeys.push("recoveryRootPublicKey");
  if (Object.hasOwn(input, "recoveryBackupPublicKey")) recordKeys.push("recoveryBackupPublicKey");
  exact(input, recordKeys, label);
  version(input.v, label);
  identifier(input.homeId, `${label} homeId`);
  positive(input.trustEpoch, `${label} trustEpoch`);
  chainHead(input.chainHead, `${label} chainHead`);
  object(input.issuer, `${label} issuer`);
  const issuerKeys = Object.hasOwn(input.issuer, "issuerPublicKey")
    ? ["deviceId", "issuerKeyId", "issuerPublicKey"]
    : ["deviceId", "issuerKeyId"];
  exact(input.issuer, issuerKeys, `${label} issuer`);
  identifier(input.issuer.deviceId, `${label} issuer deviceId`);
  identifier(input.issuer.issuerKeyId, `${label} issuer keyId`);
  if (input.issuer.issuerPublicKey !== undefined) identifier(input.issuer.issuerPublicKey, `${label} issuer public key`);
  if (input.recoveryRootPublicKey !== undefined) identifier(input.recoveryRootPublicKey, `${label} root public key`);
  if (input.recoveryBackupPublicKey !== undefined) identifier(input.recoveryBackupPublicKey, `${label} backup public key`);
  if (!Array.isArray(input.members)) throw new TypeError(`${label} members must be an array`);
  for (const [index, member] of input.members.entries()) {
    object(member, `${label} member ${index}`);
    exact(member, ["device", "roles", "state"], `${label} member ${index}`);
    object(member.device, `${label} member ${index} device`);
    exact(member.device, ["deviceId", "displayName", "enrolledAt", "platform", "publicKey"], `${label} member ${index} device`);
    for (const field of ["deviceId", "displayName", "platform", "publicKey"] as const) identifier(member.device[field], `${label} member ${index} ${field}`);
    time(member.device.enrolledAt, `${label} member ${index} enrolledAt`);
    canonicalStringArray(member.roles, `${label} member ${index} roles`, new Set(["anchor", "executor", "surface"]));
    if (!new Set(["active", "revoked", "pending-reenroll"]).has(member.state as string)) {
      throw new TypeError(`${label} member ${index} state is invalid`);
    }
  }
  signature(input.signature, `${label} signature`);
}

function unsignedVerification(value: RecoveryCheckpointVerification): unknown {
  const { signature: _, ...unsigned } = value;
  return unsigned;
}

function pickIdentity(record: Extract<PlannedRecord, { t: "anchor-prepared" }>) {
  return {
    requestId: record.requestId, transferId: record.transferId,
    sourceDeviceId: record.sourceDeviceId, targetDeviceId: record.targetDeviceId,
    sourceAnchorEpoch: record.sourceAnchorEpoch, nextAnchorEpoch: record.nextAnchorEpoch,
  };
}

function advance(current: PlannedAnchorTransferState, next: PlannedAnchorTransferPhase, record: PlannedRecord, fields: Partial<PlannedAnchorTransferState> = {}): PlannedAnchorTransferState {
  return { ...current, ...fields, phase: next, recordDigests: { ...current.recordDigests, [record.t]: protocolDigest("TransferRecord", 1, record) } };
}

function phase(state: PlannedAnchorTransferState, expected: PlannedAnchorTransferPhase, next: PlannedAnchorTransferPhase): void {
  if (state.phase !== expected) throw new TypeError(`Anchor transfer cannot enter ${next} from ${state.phase}`);
}

function unsignedEvent(event: HomeTrustEvent): unknown { const { signature: _, ...unsigned } = event; return unsigned; }

function streams(input: unknown, lastLsn: number): void {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError("Authority catalog streams must be non-empty");
  let previous = "";
  for (const [index, value] of input.entries()) {
    object(value, `Authority catalog stream ${index}`);
    exact(value, ["digest", "firstLsn", "lastLsn", "recordCount", "stream"], `Authority catalog stream ${index}`);
    identifier(value.stream, `Authority catalog stream ${index} name`);
    positive(value.firstLsn, `Authority catalog stream ${index} firstLsn`);
    positive(value.lastLsn, `Authority catalog stream ${index} lastLsn`);
    positive(value.recordCount, `Authority catalog stream ${index} recordCount`);
    digest(value.digest, `Authority catalog stream ${index} digest`);
    if ((value.lastLsn as number) > lastLsn || (value.firstLsn as number) > (value.lastLsn as number)) throw new TypeError("Authority catalog stream range is invalid");
    if (compareCanonicalStrings(previous, value.stream as string) >= 0) throw new TypeError("Authority catalog streams must be canonically sorted and unique");
    previous = value.stream as string;
  }
}

function obligations(input: unknown): void {
  if (!Array.isArray(input)) throw new TypeError("Authority catalog pending obligations must be an array");
  let previous = "";
  const kinds = new Set(["assignment", "interaction", "final", "delivery", "intent", "confirmation"]);
  for (const [index, value] of input.entries()) {
    object(value, `Authority catalog obligation ${index}`); exact(value, ["id", "kind"], `Authority catalog obligation ${index}`);
    if (!kinds.has(value.kind as string)) throw new TypeError("Authority catalog obligation kind is invalid");
    identifier(value.id, `Authority catalog obligation ${index} id`);
    const key = canonicalize(value); if (compareCanonicalStrings(previous, key) >= 0) throw new TypeError("Authority catalog obligations must be canonically sorted and unique"); previous = key;
  }
}

function artifactArray(input: unknown, label: string): void {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  let previous = "";
  for (const [index, value] of input.entries()) { artifact(value, `${label} ${index}`); const key = canonicalize(value); if (compareCanonicalStrings(previous, key) >= 0) throw new TypeError(`${label} must be canonically sorted and unique`); previous = key; }
}

function canonicalStringArray(input: unknown, label: string, allowed?: ReadonlySet<string>): void {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  let previous = "";
  for (const value of input) { identifier(value, label); if (allowed && !allowed.has(value as string)) throw new TypeError(`${label} contains an unsupported value`); if (compareCanonicalStrings(previous, value as string) >= 0) throw new TypeError(`${label} must be canonically sorted and unique`); previous = value as string; }
}

function chainHead(input: unknown, label: string): void { object(input, label); exact(input, ["eventDigest", "seq"], label); nonnegative(input.seq, `${label} seq`); digest(input.eventDigest, `${label} digest`); }
function artifact(input: unknown, label: string): asserts input is ArtifactRef { object(input, label); exact(input, ["bytes", "digest"], label); digest(input.digest, `${label} digest`); nonnegative(input.bytes, `${label} bytes`); }
function signature(input: unknown, label: string): asserts input is Signature { object(input, label); exact(input, ["alg", "keyId", "sig"], label); identifier(input.alg, `${label} alg`); identifier(input.keyId, `${label} keyId`); identifier(input.sig, `${label} sig`); }
function digest(input: unknown, label: string): asserts input is Digest { if (typeof input !== "string" || !DIGEST.test(input)) throw new TypeError(`${label} is invalid`); }
function identifier(input: unknown, label: string): asserts input is string { assertProtocolIdentifier(input, label); }
function transferId(input: unknown, label: string): asserts input is string { assertPrefixedUlid(input, "xfer-", label); }
function positive(input: unknown, label: string): void { if (!Number.isSafeInteger(input) || (input as number) <= 0) throw new TypeError(`${label} must be a positive safe integer`); }
function nonnegative(input: unknown, label: string): void { if (!Number.isSafeInteger(input) || (input as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`); }
function version(input: unknown, label: string): void { if (input !== 1) throw new TypeError(`${label} version must be 1`); }
function time(input: unknown, label: string): void { if (typeof input !== "string" || !ISO_TIME.test(input) || new Date(Date.parse(input)).toISOString() !== input) throw new TypeError(`${label} must be canonical ISO time`); }
function object(input: unknown, label: string): asserts input is Record<string, unknown> { if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); }
function exact(input: Record<string, unknown>, keys: readonly string[], label: string): void { if (canonicalize(Object.keys(input).sort()) !== canonicalize([...keys].sort())) throw new TypeError(`${label} fields are incomplete or unknown`); }
function clone(input: unknown, label: string): Record<string, unknown> { try { return JSON.parse(canonicalize(input)) as Record<string, unknown>; } catch (error) { throw new TypeError(`${label} must be canonical JSON data`, { cause: error }); } }
function assertNever(value: never): never { throw new TypeError(`Unknown planned anchor transfer record: ${canonicalize(value)}`); }
function assertNeverDisaster(value: never): never { throw new TypeError(`Unknown disaster recovery record: ${canonicalize(value)}`); }

const PHASES = new Set<PlannedAnchorTransferPhase>(["prepared", "fenced", "frozen", "imported", "committed", "tombstoned", "aborted"]);
const DISASTER_PHASES = new Set<DisasterRecoveryPhase>(["prepared", "imported", "committed", "tombstoned", "aborted"]);
const ERROR_CODES = new Set(["unauthorized", "invalid", "not-found", "conflict", "unavailable", "not-ready", "committed"]);
const ABORT_REASONS = new Set(["source-resumed", "target-rejected", "operator-cancelled"]);
const DISASTER_ABORT_REASONS = new Set(["target-rejected", "operator-cancelled"]);
