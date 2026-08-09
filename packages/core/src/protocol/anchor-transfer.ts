import type {
  AnchorTransferAbort,
  AnchorTransferCommand,
  AnchorTransferCommit,
  AnchorTransferResult,
  ArtifactRef,
  AuthorityCatalog,
  AuthorityCatalogCoverage,
  Digest,
  HomeTrustEvent,
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

type PlannedCommit = Extract<AnchorTransferCommit, { mode: "planned" }>;
type PlannedRecord = Extract<TransferRecord, { mode: "planned" }>;
type WithoutSignature<T> = T extends { signature: Signature } ? Omit<T, "signature"> : never;

export type UnsignedReadyProof = Omit<ReadyProof, "signature" | "issuerPossession">;
export type UnsignedPlannedAnchorTransferCommit = Omit<PlannedCommit, "signature">;
export type UnsignedAnchorTransferAbort = Omit<AnchorTransferAbort, "signature">;
export type UnsignedAnchorTransferCommand = WithoutSignature<AnchorTransferCommand>;

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
    "assetRevision", "configuredCapabilities", "expiresAt", "homeId", "issuedAt",
    "issuerPossession", "protocolRevision", "roles", "secretStore", "serviceRevision",
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

export function anchorTransferCommitDigest(commit: PlannedCommit): Digest {
  const { signature: _, ...payload } = commit;
  return protocolDigest("AnchorTransferCommit", 1, payload);
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
        state === "committed" || state === "tombstoned" ? ["commit"] : ["abort"];
    exact(value, ["requestId", ...field, "state", "status", "transferId", "v"], "Anchor transfer result");
    if (state === "frozen" || state === "imported") artifact(value.ref, "Anchor transfer result ref");
    if (state === "committed" || state === "tombstoned") {
      if (!verifier) throw new TypeError("Committed result requires a verifier");
      const commit = validatePlannedAnchorTransferCommit(value.commit, verifier);
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
    "assetRevision", "configuredCapabilities", "expiresAt", "homeId", "issuedAt",
    "protocolRevision", "roles", "secretStore", "serviceRevision", "targetDeviceId",
    "targetIssuerKeyId", "targetIssuerPublicKey", "transferId", "trustChainHead", "trustEpoch", "v",
  ], "Unsigned ready proof");
  version(value.v, "Ready proof");
  transferId(value.transferId, "Ready proof transferId");
  identifier(value.homeId, "Ready proof homeId");
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

const PHASES = new Set<PlannedAnchorTransferPhase>(["prepared", "fenced", "frozen", "imported", "committed", "tombstoned", "aborted"]);
const ERROR_CODES = new Set(["unauthorized", "invalid", "not-found", "conflict", "unavailable", "not-ready", "committed"]);
const ABORT_REASONS = new Set(["source-resumed", "target-rejected", "operator-cancelled"]);
