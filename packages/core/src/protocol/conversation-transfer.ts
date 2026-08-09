import type {
  ArtifactRef,
  ConversationTransferAbort,
  ConversationTransferCommand,
  ConversationTransferCommit,
  ConversationTransferManifest,
  ConversationTransferResult,
  Digest,
  Signature,
  SourceFreezeProof,
  TransferRecord,
} from "../contracts/index.js";
import { byteDigest, canonicalize, compareCanonicalStrings, protocolDigest } from "./canonical.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";
import { assertPrefixedUlid, assertProtocolIdentifier } from "./validation.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type WithoutSignature<T> = T extends { signature: Signature }
  ? Omit<T, "signature">
  : never;

export type UnsignedSourceFreezeProof = Omit<SourceFreezeProof, "signature">;
export type UnsignedConversationTransferCommit = Omit<
  ConversationTransferCommit,
  "signature"
>;
export type UnsignedConversationTransferAbort = Omit<
  ConversationTransferAbort,
  "signature"
>;
export type UnsignedConversationTransferCommand = WithoutSignature<
  ConversationTransferCommand
>;

export type ConversationTransferPhase =
  | "prepared"
  | "frozen"
  | "imported"
  | "committed"
  | "tombstoned"
  | "aborted";

type ConversationTransferRecord = Extract<
  TransferRecord,
  { t: "prepared" | "frozen" | "imported" | "committed" | "tombstoned" | "aborted" }
>;
type TransferRecordKind = ConversationTransferRecord["t"];

export interface ConversationTransferIdentity {
  readonly requestId: string;
  readonly transferId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly conversationId: string;
  readonly sourceOwnerEpoch: number;
  readonly nextOwnerEpoch: number;
}

export interface ConversationTransferState {
  readonly identity: ConversationTransferIdentity;
  readonly phase: ConversationTransferPhase;
  readonly manifest?: ArtifactRef;
  readonly proof?: SourceFreezeProof;
  readonly importedRecordBase?: ArtifactRef;
  readonly commit?: ConversationTransferCommit;
  readonly abort?: ConversationTransferAbort;
  readonly recordDigests: Readonly<Partial<Record<TransferRecordKind, Digest>>>;
}

export interface PreparedConversationTransferManifest {
  readonly manifest: ConversationTransferManifest;
  readonly bytes: Uint8Array;
  readonly ref: ArtifactRef;
}

export function prepareConversationTransferManifest(
  input: unknown,
): PreparedConversationTransferManifest {
  const manifest = validateConversationTransferManifest(input);
  const bytes = Buffer.from(canonicalize(manifest), "utf8");
  return {
    manifest,
    bytes,
    ref: { digest: byteDigest(bytes), bytes: bytes.byteLength },
  };
}

export function validateConversationTransferManifest(
  input: unknown,
): ConversationTransferManifest {
  const value = clone(input, "Conversation transfer manifest");
  assertExactKeys(
    value,
    [
      "authorityBase",
      "contentAssets",
      "conversationId",
      "lastLsn",
      "nextOwnerEpoch",
      "requestId",
      "sourceDeviceId",
      "sourceOwnerEpoch",
      "streams",
      "targetDeviceId",
      "transferId",
      "v",
    ],
    "Conversation transfer manifest",
  );
  assertVersion(value.v, "Conversation transfer manifest");
  assertTransferId(value.transferId, "Conversation transfer manifest transferId");
  assertProtocolIdentifier(value.requestId, "Conversation transfer manifest requestId");
  assertProtocolIdentifier(value.sourceDeviceId, "Conversation transfer manifest sourceDeviceId");
  assertProtocolIdentifier(value.targetDeviceId, "Conversation transfer manifest targetDeviceId");
  assertProtocolIdentifier(value.conversationId, "Conversation transfer manifest conversationId");
  assertEpochPair(value.sourceOwnerEpoch, value.nextOwnerEpoch);
  assertNonNegativeInteger(value.lastLsn, "Conversation transfer manifest lastLsn");
  assertAuthorityBase(value.authorityBase, value.lastLsn as number);
  assertStreamRanges(value.streams, value.lastLsn as number);
  assertArtifactRefs(value.contentAssets, "Conversation transfer content assets");
  return value as unknown as ConversationTransferManifest;
}

export function createSignedSourceFreezeProof(
  input: UnsignedSourceFreezeProof,
  signer: ProtocolSigner,
): SourceFreezeProof {
  const payload = validateUnsignedSourceFreezeProof(input);
  return {
    ...payload,
    signature: signer.sign("SourceFreezeProof", 1, payload),
  };
}

export function validateSourceFreezeProof(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): SourceFreezeProof {
  const value = clone(input, "Source freeze proof");
  assertExactKeys(
    value,
    [
      "checkpointDigest",
      "lastLsn",
      "scope",
      "signature",
      "sourceEpoch",
      "subject",
      "transferId",
      "v",
    ],
    "Source freeze proof",
  );
  assertSignature(value.signature, "Source freeze proof signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedSourceFreezeProof(
    unsigned as UnsignedSourceFreezeProof,
  );
  verifier.verify("SourceFreezeProof", 1, payload, signature);
  return value as unknown as SourceFreezeProof;
}

export function sourceFreezeProofDigest(proof: SourceFreezeProof): Digest {
  const { signature: _, ...payload } = proof;
  return protocolDigest("SourceFreezeProof", 1, payload);
}

export function assertConversationFreezeProofBinding(
  proof: SourceFreezeProof,
  manifest: ConversationTransferManifest,
  manifestRef: ArtifactRef,
): void {
  if (
    proof.scope !== "conversation" ||
    proof.transferId !== manifest.transferId ||
    proof.subject !== manifest.conversationId ||
    proof.sourceEpoch !== manifest.sourceOwnerEpoch ||
    proof.lastLsn !== manifest.lastLsn ||
    proof.checkpointDigest !== manifestRef.digest
  ) {
    throw new TypeError("Source freeze proof does not bind the conversation manifest");
  }
}

export function createSignedConversationTransferCommit(
  input: UnsignedConversationTransferCommit,
  signer: ProtocolSigner,
): ConversationTransferCommit {
  const payload = validateUnsignedConversationTransferCommit(input);
  return {
    ...payload,
    signature: signer.sign("ConversationTransferCommit", 1, payload),
  };
}

export function validateConversationTransferCommit(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationTransferCommit {
  const value = clone(input, "Conversation transfer commit");
  assertExactKeys(
    value,
    [
      "at",
      "checkpointDigest",
      "conversationId",
      "freezeProofDigest",
      "nextOwnerEpoch",
      "signature",
      "sourceDeviceId",
      "sourceOwnerEpoch",
      "targetDeviceId",
      "transferId",
      "v",
    ],
    "Conversation transfer commit",
  );
  assertSignature(value.signature, "Conversation transfer commit signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedConversationTransferCommit(
    unsigned as UnsignedConversationTransferCommit,
  );
  verifier.verify("ConversationTransferCommit", 1, payload, signature);
  return value as unknown as ConversationTransferCommit;
}

export function conversationTransferCommitDigest(
  commit: ConversationTransferCommit,
): Digest {
  const { signature: _, ...payload } = commit;
  return protocolDigest("ConversationTransferCommit", 1, payload);
}

export function createSignedConversationTransferAbort(
  input: UnsignedConversationTransferAbort,
  signer: ProtocolSigner,
): ConversationTransferAbort {
  const payload = validateUnsignedConversationTransferAbort(input);
  return {
    ...payload,
    signature: signer.sign("ConversationTransferAbort", 1, payload),
  };
}

export function validateConversationTransferAbort(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationTransferAbort {
  const value = clone(input, "Conversation transfer abort");
  assertExactKeys(
    value,
    [
      "at",
      "conversationId",
      "reason",
      "requestId",
      "signature",
      "sourceDeviceId",
      "sourceOwnerEpoch",
      "targetDeviceId",
      "transferId",
      "v",
    ],
    "Conversation transfer abort",
  );
  assertSignature(value.signature, "Conversation transfer abort signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedConversationTransferAbort(
    unsigned as UnsignedConversationTransferAbort,
  );
  verifier.verify("ConversationTransferAbort", 1, payload, signature);
  return value as unknown as ConversationTransferAbort;
}

export function conversationTransferAbortDigest(
  abort: ConversationTransferAbort,
): Digest {
  const { signature: _, ...payload } = abort;
  return protocolDigest("ConversationTransferAbort", 1, payload);
}

export function createSignedConversationTransferCommand(
  input: UnsignedConversationTransferCommand,
  signer: ProtocolSigner,
): ConversationTransferCommand {
  const payload = validateUnsignedConversationTransferCommand(input);
  return {
    ...payload,
    signature: signer.sign("ConversationTransferCommand", 1, payload),
  } as ConversationTransferCommand;
}

export function validateConversationTransferCommand(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationTransferCommand {
  const value = clone(input, "Conversation transfer command");
  assertSignature(value.signature, "Conversation transfer command signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedConversationTransferCommand(
    unsigned as UnsignedConversationTransferCommand,
  );
  verifier.verify("ConversationTransferCommand", 1, payload, signature);
  if (payload.op === "freeze") {
    const proof = validateSourceFreezeProof(payload.proof, verifier);
    if (proof.transferId !== payload.transferId) {
      throw new TypeError("Freeze command proof does not bind transferId");
    }
  } else if (payload.op === "commit") {
    const commit = validateConversationTransferCommit(payload.commit, verifier);
    if (commit.transferId !== payload.transferId) {
      throw new TypeError("Commit command does not bind transferId");
    }
  } else if (payload.op === "abort") {
    const abort = validateConversationTransferAbort(payload.abort, verifier);
    if (abort.transferId !== payload.transferId) {
      throw new TypeError("Abort command does not bind transferId");
    }
  }
  return value as unknown as ConversationTransferCommand;
}

export function validateConversationTransferResult(
  input: unknown,
  verifier?: ProtocolSignatureVerifier,
): ConversationTransferResult {
  const value = clone(input, "Conversation transfer result");
  assertVersion(value.v, "Conversation transfer result");
  assertProtocolIdentifier(value.requestId, "Conversation transfer result requestId");
  assertTransferId(value.transferId, "Conversation transfer result transferId");
  if (value.status === "ok") {
    const state = value.state as ConversationTransferPhase;
    if (!TRANSFER_PHASES.has(state)) {
      throw new TypeError("Conversation transfer result state is invalid");
    }
    const stateKeys =
      state === "prepared"
        ? []
        : state === "frozen" || state === "imported"
          ? ["ref"]
          : state === "committed" || state === "tombstoned"
            ? ["commit"]
            : ["abort"];
    assertExactKeys(
      value,
      [
        "requestId",
        ...stateKeys,
        "state",
        "status",
        "transferId",
        "v",
      ],
      "Conversation transfer result",
    );
    if (state === "frozen" || state === "imported") {
      assertArtifactRef(value.ref, "Conversation transfer result ref");
    } else if (state === "committed" || state === "tombstoned") {
      if (!verifier) {
        throw new TypeError("Conversation transfer commit result requires a verifier");
      }
      validateConversationTransferCommit(value.commit, verifier);
    } else if (state === "aborted") {
      if (!verifier) {
        throw new TypeError("Conversation transfer abort result requires a verifier");
      }
      validateConversationTransferAbort(value.abort, verifier);
    }
  } else if (value.status === "range") {
    assertExactKeys(
      value,
      ["data", "offset", "ref", "requestId", "status", "transferId", "v"],
      "Conversation transfer range result",
    );
    assertArtifactRef(value.ref, "Conversation transfer range ref");
    assertNonNegativeInteger(value.offset, "Conversation transfer range offset");
    if (typeof value.data !== "string" || !BASE64_PATTERN.test(value.data)) {
      throw new TypeError("Conversation transfer range data must be canonical base64");
    }
    const bytes = Buffer.from(value.data, "base64");
    const ref = value.ref as unknown as ArtifactRef;
    if (bytes.byteLength === 0 || (value.offset as number) + bytes.byteLength > ref.bytes) {
      throw new TypeError("Conversation transfer range data exceeds its ref");
    }
  } else if (value.status === "rejected") {
    assertExactKeys(
      value,
      ["error", "requestId", "status", "transferId", "v"],
      "Conversation transfer rejected result",
    );
    assertPlainObject(value.error, "Conversation transfer result error");
    assertExactKeys(value.error, ["code", "retryable"], "Conversation transfer result error");
    if (!TRANSFER_ERROR_CODES.has(value.error.code as string)) {
      throw new TypeError("Conversation transfer result error code is invalid");
    }
    if (typeof value.error.retryable !== "boolean") {
      throw new TypeError("Conversation transfer result retryable must be boolean");
    }
  } else {
    throw new TypeError("Conversation transfer result status is invalid");
  }
  return value as unknown as ConversationTransferResult;
}

export function reduceConversationTransfer(
  current: ConversationTransferState | undefined,
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationTransferState {
  const record = validateTransferRecordShape(input);
  const digest = protocolDigest("TransferRecord", 1, record);
  if (current !== undefined) {
    const existing = current.recordDigests[record.t];
    if (existing !== undefined) {
      if (existing !== digest) {
        throw new TypeError(`Conflicting ${record.t} transfer record`);
      }
      return current;
    }
    if (record.transferId !== current.identity.transferId) {
      throw new TypeError("Transfer record changes transfer identity");
    }
  }

  if (record.t === "prepared") {
    if (current !== undefined) {
      throw new TypeError("Prepared transfer must be the first record");
    }
    assertPreparedRecord(record);
    const identity = preparedIdentity(record);
    return {
      identity,
      phase: "prepared",
      recordDigests: { prepared: digest },
    };
  }
  if (current === undefined) {
    throw new TypeError("Transfer must be prepared before later records");
  }

  assertRecordIdentity(current.identity, record);
  if (record.t === "frozen") {
    assertPhase(current, "prepared", "frozen");
    assertArtifactRef(record.manifest, "Frozen transfer manifest ref");
    const proof = validateSourceFreezeProof(record.proof, verifier);
    if (
      proof.scope !== "conversation" ||
      proof.transferId !== current.identity.transferId ||
      proof.subject !== current.identity.conversationId ||
      proof.sourceEpoch !== current.identity.sourceOwnerEpoch ||
      proof.checkpointDigest !== record.manifest.digest
    ) {
      throw new TypeError("Frozen proof does not bind prepared transfer");
    }
    return advanceState(current, "frozen", digest, {
      manifest: record.manifest,
      proof,
    });
  }
  if (record.t === "imported") {
    assertPhase(current, "frozen", "imported");
    assertDigest(record.manifestDigest, "Imported manifest digest");
    assertArtifactRef(record.importedRecordBase, "Imported record base");
    if (record.manifestDigest !== current.manifest?.digest) {
      throw new TypeError("Imported record does not bind frozen manifest");
    }
    return advanceState(current, "imported", digest, {
      importedRecordBase: record.importedRecordBase,
    });
  }
  if (record.t === "committed") {
    assertPhase(current, "imported", "committed");
    const commit = validateConversationTransferCommit(record.commit, verifier);
    if (
      commit.transferId !== current.identity.transferId ||
      commit.conversationId !== current.identity.conversationId ||
      commit.sourceDeviceId !== current.identity.sourceDeviceId ||
      commit.targetDeviceId !== current.identity.targetDeviceId ||
      commit.sourceOwnerEpoch !== current.identity.sourceOwnerEpoch ||
      commit.nextOwnerEpoch !== current.identity.nextOwnerEpoch ||
      commit.checkpointDigest !== current.manifest?.digest ||
      commit.freezeProofDigest !== sourceFreezeProofDigest(current.proof!)
    ) {
      throw new TypeError("Commit does not bind imported transfer");
    }
    return advanceState(current, "committed", digest, { commit });
  }
  if (record.t === "tombstoned") {
    assertPhase(current, "committed", "tombstoned");
    assertDigest(record.commitDigest, "Tombstone commit digest");
    assertCanonicalTime(record.at, "Tombstone time");
    if (record.commitDigest !== conversationTransferCommitDigest(current.commit!)) {
      throw new TypeError("Tombstone does not bind committed transfer");
    }
    return advanceState(current, "tombstoned", digest);
  }
  if (record.t === "aborted") {
    if (current.phase === "committed" || current.phase === "tombstoned" || current.phase === "aborted") {
      throw new TypeError("Committed or terminal transfer cannot be aborted");
    }
    const abort = validateConversationTransferAbort(record.abort, verifier);
    if (
      abort.requestId !== current.identity.requestId ||
      abort.transferId !== current.identity.transferId ||
      abort.sourceDeviceId !== current.identity.sourceDeviceId ||
      abort.targetDeviceId !== current.identity.targetDeviceId ||
      abort.conversationId !== current.identity.conversationId ||
      abort.sourceOwnerEpoch !== current.identity.sourceOwnerEpoch
    ) {
      throw new TypeError("Abort does not bind prepared transfer");
    }
    return advanceState(current, "aborted", digest, { abort });
  }
  return assertNever(record);
}

function validateUnsignedSourceFreezeProof(
  input: UnsignedSourceFreezeProof,
): UnsignedSourceFreezeProof {
  const value = clone(input, "Unsigned source freeze proof");
  assertExactKeys(
    value,
    ["checkpointDigest", "lastLsn", "scope", "sourceEpoch", "subject", "transferId", "v"],
    "Unsigned source freeze proof",
  );
  assertVersion(value.v, "Source freeze proof");
  assertTransferId(value.transferId, "Source freeze proof transferId");
  if (value.scope !== "conversation" && value.scope !== "anchor") {
    throw new TypeError("Source freeze proof scope is invalid");
  }
  assertProtocolIdentifier(value.subject, "Source freeze proof subject");
  assertPositiveInteger(value.sourceEpoch, "Source freeze proof sourceEpoch");
  assertDigest(value.checkpointDigest, "Source freeze proof checkpointDigest");
  assertNonNegativeInteger(value.lastLsn, "Source freeze proof lastLsn");
  return value as unknown as UnsignedSourceFreezeProof;
}

function validateUnsignedConversationTransferCommit(
  input: UnsignedConversationTransferCommit,
): UnsignedConversationTransferCommit {
  const value = clone(input, "Unsigned conversation transfer commit");
  assertExactKeys(
    value,
    [
      "at",
      "checkpointDigest",
      "conversationId",
      "freezeProofDigest",
      "nextOwnerEpoch",
      "sourceDeviceId",
      "sourceOwnerEpoch",
      "targetDeviceId",
      "transferId",
      "v",
    ],
    "Unsigned conversation transfer commit",
  );
  assertVersion(value.v, "Conversation transfer commit");
  assertTransferId(value.transferId, "Conversation transfer commit transferId");
  assertProtocolIdentifier(value.conversationId, "Conversation transfer commit conversationId");
  assertProtocolIdentifier(value.sourceDeviceId, "Conversation transfer commit sourceDeviceId");
  assertProtocolIdentifier(value.targetDeviceId, "Conversation transfer commit targetDeviceId");
  assertDigest(value.freezeProofDigest, "Conversation transfer commit freezeProofDigest");
  assertDigest(value.checkpointDigest, "Conversation transfer commit checkpointDigest");
  assertEpochPair(value.sourceOwnerEpoch, value.nextOwnerEpoch);
  assertCanonicalTime(value.at, "Conversation transfer commit time");
  return value as unknown as UnsignedConversationTransferCommit;
}

function validateUnsignedConversationTransferAbort(
  input: UnsignedConversationTransferAbort,
): UnsignedConversationTransferAbort {
  const value = clone(input, "Unsigned conversation transfer abort");
  assertExactKeys(
    value,
    [
      "at",
      "conversationId",
      "reason",
      "requestId",
      "sourceDeviceId",
      "sourceOwnerEpoch",
      "targetDeviceId",
      "transferId",
      "v",
    ],
    "Unsigned conversation transfer abort",
  );
  assertVersion(value.v, "Conversation transfer abort");
  assertProtocolIdentifier(value.requestId, "Conversation transfer abort requestId");
  assertTransferId(value.transferId, "Conversation transfer abort transferId");
  assertProtocolIdentifier(value.conversationId, "Conversation transfer abort conversationId");
  assertProtocolIdentifier(value.sourceDeviceId, "Conversation transfer abort sourceDeviceId");
  assertProtocolIdentifier(value.targetDeviceId, "Conversation transfer abort targetDeviceId");
  assertPositiveInteger(value.sourceOwnerEpoch, "Conversation transfer abort sourceOwnerEpoch");
  if (
    value.reason !== "source-resumed" &&
    value.reason !== "target-rejected" &&
    value.reason !== "operator-cancelled"
  ) {
    throw new TypeError("Conversation transfer abort reason is invalid");
  }
  assertCanonicalTime(value.at, "Conversation transfer abort time");
  return value as unknown as UnsignedConversationTransferAbort;
}

function validateUnsignedConversationTransferCommand(
  input: UnsignedConversationTransferCommand,
): UnsignedConversationTransferCommand {
  const value = clone(input, "Unsigned conversation transfer command");
  assertVersion(value.v, "Conversation transfer command");
  assertProtocolIdentifier(value.requestId, "Conversation transfer command requestId");
  assertTransferId(value.transferId, "Conversation transfer command transferId");
  if (value.op === "prepare") {
    assertExactKeys(value, ["conversationId", "nextOwnerEpoch", "op", "requestId", "sourceDeviceId", "sourceOwnerEpoch", "targetDeviceId", "transferId", "v"], "Prepare transfer command");
    assertProtocolIdentifier(value.sourceDeviceId, "Prepare transfer sourceDeviceId");
    assertProtocolIdentifier(value.targetDeviceId, "Prepare transfer targetDeviceId");
    assertProtocolIdentifier(value.conversationId, "Prepare transfer conversationId");
    assertEpochPair(value.sourceOwnerEpoch, value.nextOwnerEpoch);
  } else if (value.op === "freeze") {
    assertExactKeys(value, ["manifest", "op", "proof", "requestId", "transferId", "v"], "Freeze transfer command");
    assertArtifactRef(value.manifest, "Freeze transfer manifest");
    assertPlainObject(value.proof, "Freeze transfer proof");
  } else if (value.op === "probe") {
    assertExactKeys(value, ["op", "ref", "requestId", "transferId", "v"], "Probe transfer command");
    assertArtifactRef(value.ref, "Probe transfer ref");
  } else if (value.op === "read-range") {
    assertExactKeys(value, ["length", "offset", "op", "ref", "requestId", "transferId", "v"], "Read transfer command");
    assertArtifactRef(value.ref, "Read transfer ref");
    assertNonNegativeInteger(value.offset, "Read transfer offset");
    assertPositiveInteger(value.length, "Read transfer length");
    if ((value.offset as number) + (value.length as number) > (value.ref as unknown as ArtifactRef).bytes) {
      throw new TypeError("Read transfer range exceeds artifact bounds");
    }
  } else if (value.op === "import") {
    assertExactKeys(value, ["manifest", "op", "requestId", "transferId", "v"], "Import transfer command");
    assertArtifactRef(value.manifest, "Import transfer manifest");
  } else if (value.op === "commit") {
    assertExactKeys(value, ["commit", "op", "requestId", "transferId", "v"], "Commit transfer command");
    assertPlainObject(value.commit, "Commit transfer payload");
  } else if (value.op === "abort") {
    assertExactKeys(value, ["abort", "op", "requestId", "transferId", "v"], "Abort transfer command");
    assertPlainObject(value.abort, "Abort transfer payload");
  } else if (value.op === "status") {
    assertExactKeys(value, ["op", "requestId", "transferId", "v"], "Status transfer command");
  } else {
    throw new TypeError("Conversation transfer command operation is invalid");
  }
  return value as unknown as UnsignedConversationTransferCommand;
}

function validateTransferRecordShape(input: unknown): ConversationTransferRecord {
  const value = clone(input, "Transfer record");
  assertVersion(value.v, "Transfer record");
  if (value.t === "prepared") {
    assertExactKeys(value, ["conversationId", "nextOwnerEpoch", "requestId", "sourceDeviceId", "sourceOwnerEpoch", "t", "targetDeviceId", "transferId", "v"], "Prepared transfer record");
  } else if (value.t === "frozen") {
    assertExactKeys(value, ["manifest", "proof", "t", "transferId", "v"], "Frozen transfer record");
  } else if (value.t === "imported") {
    assertExactKeys(value, ["importedRecordBase", "manifestDigest", "t", "transferId", "v"], "Imported transfer record");
  } else if (value.t === "committed") {
    assertExactKeys(value, ["commit", "t", "transferId", "v"], "Committed transfer record");
  } else if (value.t === "tombstoned") {
    assertExactKeys(value, ["at", "commitDigest", "t", "transferId", "v"], "Tombstoned transfer record");
  } else if (value.t === "aborted") {
    assertExactKeys(value, ["abort", "t", "transferId", "v"], "Aborted transfer record");
  } else {
    throw new TypeError("Transfer record state is invalid");
  }
  assertTransferId(value.transferId, "Transfer record transferId");
  return value as unknown as ConversationTransferRecord;
}

function assertPreparedRecord(record: Extract<ConversationTransferRecord, { t: "prepared" }>): void {
  assertProtocolIdentifier(record.requestId, "Prepared transfer requestId");
  assertProtocolIdentifier(record.sourceDeviceId, "Prepared transfer sourceDeviceId");
  assertProtocolIdentifier(record.targetDeviceId, "Prepared transfer targetDeviceId");
  assertProtocolIdentifier(record.conversationId, "Prepared transfer conversationId");
  assertEpochPair(record.sourceOwnerEpoch, record.nextOwnerEpoch);
}

function preparedIdentity(
  record: Extract<ConversationTransferRecord, { t: "prepared" }>,
): ConversationTransferIdentity {
  return {
    requestId: record.requestId,
    transferId: record.transferId,
    sourceDeviceId: record.sourceDeviceId,
    targetDeviceId: record.targetDeviceId,
    conversationId: record.conversationId,
    sourceOwnerEpoch: record.sourceOwnerEpoch,
    nextOwnerEpoch: record.nextOwnerEpoch,
  };
}

function assertRecordIdentity(identity: ConversationTransferIdentity, record: ConversationTransferRecord): void {
  if (record.t === "frozen") {
    return;
  }
  if (record.t === "imported" || record.t === "committed" || record.t === "tombstoned" || record.t === "aborted") {
    return;
  }
  if (record.transferId !== identity.transferId) {
    throw new TypeError("Transfer record identity drifted");
  }
}

function assertPhase(
  state: ConversationTransferState,
  expected: ConversationTransferPhase,
  target: ConversationTransferPhase,
): void {
  if (state.phase !== expected) {
    throw new TypeError(`Transfer cannot enter ${target} from ${state.phase}`);
  }
}

function advanceState(
  current: ConversationTransferState,
  phase: ConversationTransferPhase,
  digest: Digest,
  fields: Partial<ConversationTransferState> = {},
): ConversationTransferState {
  return {
    ...current,
    ...fields,
    phase,
    recordDigests: { ...current.recordDigests, [phase]: digest },
  };
}

function assertAuthorityBase(input: unknown, lastLsn: number): void {
  assertPlainObject(input, "Conversation transfer authority base");
  assertExactKeys(input, ["checkpoint", "records", "reducerVersion", "sessionState"], "Conversation transfer authority base");
  assertPlainObject(input.checkpoint, "Conversation transfer checkpoint");
  assertExactKeys(input.checkpoint, ["frameEndOffset", "logId", "lsn", "prefixDigest"], "Conversation transfer checkpoint");
  assertProtocolIdentifier(input.checkpoint.logId, "Conversation transfer checkpoint logId");
  assertNonNegativeInteger(input.checkpoint.lsn, "Conversation transfer checkpoint lsn");
  assertNonNegativeInteger(input.checkpoint.frameEndOffset, "Conversation transfer checkpoint frameEndOffset");
  assertDigest(input.checkpoint.prefixDigest, "Conversation transfer checkpoint prefixDigest");
  if (input.checkpoint.lsn !== lastLsn) {
    throw new TypeError("Conversation transfer checkpoint lsn must equal lastLsn");
  }
  assertArtifactRef(input.records, "Conversation transfer authority records");
  assertArtifactRef(input.sessionState, "Conversation transfer SessionState snapshot");
  assertProtocolIdentifier(input.reducerVersion, "Conversation transfer reducerVersion");
}

function assertStreamRanges(input: unknown, lastLsn: number): void {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("Conversation transfer streams must be non-empty");
  }
  let previous = "";
  for (const [index, entry] of input.entries()) {
    const label = `Conversation transfer stream ${index}`;
    assertPlainObject(entry, label);
    assertExactKeys(entry, ["digest", "firstLsn", "lastLsn", "recordCount", "stream"], label);
    assertProtocolIdentifier(entry.stream, `${label} name`);
    assertPositiveInteger(entry.firstLsn, `${label} firstLsn`);
    assertPositiveInteger(entry.lastLsn, `${label} lastLsn`);
    assertPositiveInteger(entry.recordCount, `${label} recordCount`);
    assertDigest(entry.digest, `${label} digest`);
    if ((entry.lastLsn as number) < (entry.firstLsn as number) || (entry.lastLsn as number) > lastLsn) {
      throw new TypeError(`${label} range is invalid`);
    }
    if ((entry.recordCount as number) > (entry.lastLsn as number) - (entry.firstLsn as number) + 1) {
      throw new TypeError(`${label} record count exceeds its LSN range`);
    }
    if (compareCanonicalStrings(previous, entry.stream as string) >= 0) {
      throw new TypeError("Conversation transfer streams must be unique and canonically sorted");
    }
    previous = entry.stream as string;
  }
}

function assertArtifactRefs(input: unknown, label: string): void {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  let previous = "";
  for (const [index, entry] of input.entries()) {
    assertArtifactRef(entry, `${label} ${index}`);
    const key = canonicalize(entry);
    if (compareCanonicalStrings(previous, key) >= 0) {
      throw new TypeError(`${label} must be unique and canonically sorted`);
    }
    previous = key;
  }
}

function assertArtifactRef(input: unknown, label: string): asserts input is ArtifactRef {
  assertPlainObject(input, label);
  assertExactKeys(input, ["bytes", "digest"], label);
  assertDigest(input.digest, `${label} digest`);
  assertNonNegativeInteger(input.bytes, `${label} bytes`);
}

function assertEpochPair(source: unknown, next: unknown): void {
  assertPositiveInteger(source, "Conversation transfer sourceOwnerEpoch");
  assertPositiveInteger(next, "Conversation transfer nextOwnerEpoch");
  if ((next as number) !== (source as number) + 1) {
    throw new TypeError("Conversation transfer nextOwnerEpoch must equal sourceOwnerEpoch + 1");
  }
}

function assertTransferId(value: unknown, label: string): asserts value is string {
  assertPrefixedUlid(value, "xfer-", label);
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertSignature(value: unknown, label: string): asserts value is Signature {
  assertPlainObject(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertProtocolIdentifier(value.alg, `${label} algorithm`);
  assertProtocolIdentifier(value.keyId, `${label} keyId`);
  assertProtocolIdentifier(value.sig, `${label} bytes`);
}

function assertVersion(value: unknown, label: string): void {
  if (value !== 1) throw new TypeError(`${label} version must be 1`);
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertCanonicalTime(value: unknown, label: string): void {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function clone(input: unknown, label: string): Record<string, unknown> {
  try {
    return JSON.parse(canonicalize(input)) as Record<string, unknown>;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON data`, { cause: error });
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown transfer record: ${canonicalize(value)}`);
}

const TRANSFER_PHASES = new Set<ConversationTransferPhase>([
  "prepared",
  "frozen",
  "imported",
  "committed",
  "tombstoned",
  "aborted",
]);

const TRANSFER_ERROR_CODES = new Set([
  "unauthorized",
  "invalid",
  "not-found",
  "conflict",
  "unavailable",
]);
