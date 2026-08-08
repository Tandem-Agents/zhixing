import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type {
  CheckpointEnvelope,
  DeviceIdentity,
  FullAuthorityCheckpointPayload,
  RecoveryActivationPlan,
  RecoveryCheckpointPurpose,
  RecoveryCheckpointVerification,
  Signature,
} from "@zhixing/core/contracts";
import {
  byteDigest,
  canonicalize,
  protocolBytes,
  protocolDigest,
} from "./canonical.js";
import { verifyDeviceSignature } from "./device-identity.js";
import {
  decodeCanonicalBase64Url,
  encodeX25519PublicKey,
  importEncodedPublicKey,
  keyIdForPublicKey,
  RecoveryRoot,
  verifyRecoverySignature,
} from "./recovery-root.js";
import { createUlid } from "./identifiers.js";

const VERIFICATION_HEADER = Buffer.from("ZXCP1", "ascii");
const VERIFICATION_NONCE_BYTES = 32;
const GCM_TAG_BYTES = 16;
const WRAP_COUNTER = 0xffffffff;
const FULL_CHECKPOINT_CHUNK_BYTES = 1024 * 1024;
const FULL_CHECKPOINT_COVERAGE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);

export interface CheckpointSigner {
  readonly deviceId: string;
  sign(schemaId: string, version: number, payload: unknown): Signature;
}

export interface EncryptedCheckpointChunk {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

export interface CheckpointPackage {
  readonly envelope: CheckpointEnvelope;
  readonly chunks: readonly EncryptedCheckpointChunk[];
}

export interface CheckpointRecipient {
  readonly backupPublicKey: string;
  readonly backupKeyId: string;
}

export interface FullAuthorityCheckpointSource {
  readonly payload: FullAuthorityCheckpointPayload;
  readonly recordPages: readonly Uint8Array[];
  readonly retainedArtifacts: readonly Uint8Array[];
}

export interface OpenedFullAuthorityCheckpoint {
  readonly verificationNonce: Buffer;
  readonly payload: FullAuthorityCheckpointPayload;
  readonly recordPages: readonly Buffer[];
  readonly retainedArtifacts: readonly Buffer[];
}

/** Creates the canonical identifier used by a newly prepared checkpoint. */
export function createCheckpointId(now = Date.now()): string {
  return createUlid(now);
}

export function createRootActivationCheckpoint(input: {
  checkpointId: string;
  createdAt: string;
  plan: RecoveryActivationPlan;
  recoveryRoot: RecoveryRoot;
  issuer: CheckpointSigner;
  scope: readonly string[];
  domainRevisions: Readonly<Record<string, number>>;
  upToLsn: number;
  plaintextChunks: readonly Uint8Array[];
}): CheckpointPackage {
  const recipient = input.recoveryRoot.publicIdentity();
  assertRecoveryRecipientMatchesPlan(input.plan, recipient);
  return createCheckpoint({
    checkpointId: input.checkpointId,
    createdAt: input.createdAt,
    manifestPurpose: { kind: "root-activation", plan: input.plan },
    recipient,
    issuer: input.issuer,
    scope: input.scope,
    domainRevisions: input.domainRevisions,
    upToLsn: input.upToLsn,
    plaintextChunks: input.plaintextChunks,
  });
}

export function createFullAuthorityCheckpoint(input: {
  source: FullAuthorityCheckpointSource;
  recipient: CheckpointRecipient;
  issuer: CheckpointSigner;
}): CheckpointPackage {
  const { payload } = input.source;
  assertFullAuthorityCheckpointPayload(payload);
  if (payload.recipientKeyId !== input.recipient.backupKeyId) {
    throw new TypeError("Full checkpoint recipient does not match the recovery root");
  }
  if (payload.issuer.deviceId !== input.issuer.deviceId) {
    throw new TypeError("Full checkpoint issuer does not match the signing device");
  }
  if (input.source.recordPages.length !== payload.records.pages.length) {
    throw new TypeError("Full checkpoint record page set is incomplete");
  }
  if (input.source.retainedArtifacts.length !== payload.retainedArtifacts.entries.length) {
    throw new TypeError("Full checkpoint retained artifact set is incomplete");
  }
  verifyFullPayloadContent(payload, input.source.recordPages, input.source.retainedArtifacts);
  const header = Buffer.from(canonicalize(payload), "utf8");
  if (header.byteLength > FULL_CHECKPOINT_CHUNK_BYTES) {
    throw new TypeError("Full checkpoint payload header exceeds the fixed chunk bound");
  }
  const plaintextChunks = [
    header,
    ...chunkPlaintext([...input.source.recordPages, ...input.source.retainedArtifacts]),
  ];
  return createCheckpoint({
    checkpointId: payload.checkpointId,
    createdAt: payload.createdAt,
    manifestPurpose: payload.purpose,
    recipient: input.recipient,
    issuer: input.issuer,
    scope: [...payload.coverage.classes],
    domainRevisions: { authority: payload.source.lsn },
    upToLsn: payload.source.lsn,
    plaintextChunks,
  });
}

function createCheckpoint(input: {
  checkpointId: string;
  createdAt: string;
  manifestPurpose: CheckpointEnvelope["manifest"]["purpose"];
  recipient: CheckpointRecipient;
  issuer: CheckpointSigner;
  scope: readonly string[];
  domainRevisions: Readonly<Record<string, number>>;
  upToLsn: number;
  plaintextChunks: readonly Uint8Array[];
}): CheckpointPackage {
  assertCanonicalTime(input.createdAt, "Checkpoint creation time");
  if (input.plaintextChunks.length === 0) throw new TypeError("Checkpoint requires at least one chunk");
  if (input.plaintextChunks.length >= WRAP_COUNTER) throw new TypeError("Checkpoint has too many chunks");
  assertNonNegativeInteger(input.upToLsn, "Checkpoint LSN");
  const identity = input.recipient;
  if (input.manifestPurpose.kind === "root-activation") {
    assertRecoveryRecipientMatchesPlan(input.manifestPurpose.plan, identity);
  }
  const manifest = {
    scope: [...input.scope],
    domainRevisions: { ...input.domainRevisions },
    upToLsn: input.upToLsn,
    purpose: input.manifestPurpose,
  };
  const purpose: RecoveryCheckpointPurpose = input.manifestPurpose.kind === "periodic"
    ? { kind: "periodic" }
    : {
        kind: "root-activation",
        activationDigest: protocolDigest(
          "RecoveryActivationPlan",
          1,
          input.manifestPurpose.plan,
        ),
      };
  const dek = randomBytes(32);
  const nonceBase = randomBytes(12);
  const verificationNonce = randomBytes(VERIFICATION_NONCE_BYTES);
  const ephemeral = generateKeyPairSync("x25519");
  const enc = encodeX25519PublicKey(ephemeral.publicKey);
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importEncodedPublicKey(identity.backupPublicKey, "x25519"),
  });
  const kek = deriveKek(sharedSecret, identity.backupKeyId, input.checkpointId);
  const chunks: EncryptedCheckpointChunk[] = [];
  try {
    for (let seq = 0; seq < input.plaintextChunks.length; seq += 1) {
      const plaintext =
        seq === 0
          ? Buffer.concat([
              VERIFICATION_HEADER,
              verificationNonce,
              Buffer.from(input.plaintextChunks[seq]!),
            ])
          : Buffer.from(input.plaintextChunks[seq]!);
      try {
        chunks.push(
          Object.freeze({
            seq,
            bytes: encryptAead(
              dek,
              chunkNonce(nonceBase, seq),
              checkpointAad(input.checkpointId, identity.backupKeyId, purpose, seq),
              plaintext,
            ),
          }),
        );
      } finally {
        plaintext.fill(0);
      }
    }
    const wrappedDek = encryptAead(
      kek,
      chunkNonce(nonceBase, WRAP_COUNTER),
      checkpointAad(input.checkpointId, identity.backupKeyId, purpose, WRAP_COUNTER),
      dek,
    ).toString("base64url");
    const body = {
      v: 1 as const,
      checkpointId: input.checkpointId,
      createdAt: input.createdAt,
      alg: { kem: "X25519-HKDF-SHA256" as const, aead: "AES-256-GCM" as const },
      recipientKeyId: identity.backupKeyId,
      enc,
      wrappedDek,
      nonceBase: nonceBase.toString("base64url"),
      manifest,
      chunks: chunks.map((chunk) => ({
        seq: chunk.seq,
        digest: byteDigest(chunk.bytes),
        bytes: chunk.bytes.byteLength,
      })),
    };
    const digest = protocolDigest("CheckpointEnvelope", 1, body);
    const signed = { ...body, digest };
    const envelope: CheckpointEnvelope = Object.freeze({
      ...signed,
      signature: input.issuer.sign("CheckpointEnvelope", 1, signed),
    });
    return Object.freeze({ envelope, chunks: Object.freeze(chunks) });
  } finally {
    dek.fill(0);
    kek.fill(0);
    sharedSecret.fill(0);
    verificationNonce.fill(0);
  }
}

export function openRootActivationCheckpoint(input: {
  package: CheckpointPackage;
  recoveryRoot: RecoveryRoot;
  issuer: DeviceIdentity;
}): { verificationNonce: Buffer; plaintextChunks: readonly Buffer[] } {
  const opened = openCheckpoint(input);
  const purpose = checkpointPurpose(input.package.envelope);
  if (purpose.kind !== "root-activation") {
    clearOpened(opened);
    throw new TypeError("Checkpoint is not a root activation checkpoint");
  }
  return opened;
}

export function openFullAuthorityCheckpoint(input: {
  package: CheckpointPackage;
  recoveryRoot: RecoveryRoot;
  issuer: DeviceIdentity;
}): OpenedFullAuthorityCheckpoint {
  const opened = openCheckpoint(input);
  let assembledBody: Buffer | undefined;
  try {
    const header = opened.plaintextChunks[0];
    if (!header) throw new TypeError("Full checkpoint payload header is missing");
    const text = header.toString("utf8");
    const value = JSON.parse(text) as unknown;
    if (canonicalize(value) !== text) {
      throw new TypeError("Full checkpoint payload header is not canonical");
    }
    assertFullAuthorityCheckpointPayload(value);
    const payload = value;
    const envelope = input.package.envelope;
    if (
      payload.checkpointId !== envelope.checkpointId ||
      payload.createdAt !== envelope.createdAt ||
      payload.recipientKeyId !== envelope.recipientKeyId ||
      payload.source.lsn !== envelope.manifest.upToLsn ||
      canonicalize(payload.purpose) !== canonicalize(envelope.manifest.purpose) ||
      canonicalize(payload.coverage.classes) !== canonicalize(envelope.manifest.scope)
    ) {
      throw new TypeError("Full checkpoint payload is not bound to its envelope");
    }
    const body = Buffer.concat(opened.plaintextChunks.slice(1));
    assembledBody = body;
    const recordPages: Buffer[] = [];
    const retainedArtifacts: Buffer[] = [];
    let offset = 0;
    for (const descriptor of payload.records.pages) {
      recordPages.push(Buffer.from(body.subarray(offset, offset + descriptor.bytes)));
      offset += descriptor.bytes;
    }
    for (const descriptor of payload.retainedArtifacts.entries) {
      retainedArtifacts.push(Buffer.from(body.subarray(offset, offset + descriptor.bytes)));
      offset += descriptor.bytes;
    }
    if (offset !== body.byteLength) {
      throw new TypeError("Full checkpoint plaintext contains undeclared bytes");
    }
    verifyFullPayloadContent(payload, recordPages, retainedArtifacts);
    body.fill(0);
    assembledBody = undefined;
    for (const chunk of opened.plaintextChunks) chunk.fill(0);
    return {
      verificationNonce: opened.verificationNonce,
      payload,
      recordPages: Object.freeze(recordPages),
      retainedArtifacts: Object.freeze(retainedArtifacts),
    };
  } catch (error) {
    assembledBody?.fill(0);
    clearOpened(opened);
    throw error;
  }
}

function openCheckpoint(input: {
  package: CheckpointPackage;
  recoveryRoot: RecoveryRoot;
  issuer: DeviceIdentity;
}): { verificationNonce: Buffer; plaintextChunks: readonly Buffer[] } {
  const { envelope } = input.package;
  assertEnvelopeShape(envelope);
  const identity = input.recoveryRoot.publicIdentity();
  if (envelope.recipientKeyId !== identity.backupKeyId) {
    throw new TypeError("Checkpoint recipient does not match the recovery root");
  }
  const { signature, digest, ...body } = envelope;
  const expectedDigest = protocolDigest("CheckpointEnvelope", 1, body);
  if (digest !== expectedDigest) throw new TypeError("Checkpoint envelope digest is invalid");
  verifyDeviceSignature(input.issuer, "CheckpointEnvelope", 1, { ...body, digest }, signature);
  const purpose = checkpointPurpose(envelope);
  if (purpose.kind === "root-activation") {
    const activationDigest = protocolDigest(
      "RecoveryActivationPlan",
      1,
      envelope.manifest.purpose.kind === "root-activation"
        ? envelope.manifest.purpose.plan
        : undefined,
    );
    if (purpose.activationDigest !== activationDigest) {
      throw new TypeError("Checkpoint activation plan digest is invalid");
    }
  }
  const encryptedBySeq = new Map(input.package.chunks.map((chunk) => [chunk.seq, chunk]));
  if (
    input.package.chunks.length !== envelope.chunks.length ||
    encryptedBySeq.size !== envelope.chunks.length
  ) {
    throw new TypeError("Checkpoint package chunk set is incomplete or duplicated");
  }
  const nonceBase = decodeCanonicalBase64Url(envelope.nonceBase, "Checkpoint nonce base");
  if (nonceBase.byteLength !== 12) throw new TypeError("Checkpoint nonce base must be 96 bits");
  const sharedSecret = input.recoveryRoot.decapsulate(envelope.enc);
  const kek = deriveKek(sharedSecret, envelope.recipientKeyId, envelope.checkpointId);
  let dek: Buffer | undefined;
  try {
    dek = decryptAead(
      kek,
      chunkNonce(nonceBase, WRAP_COUNTER),
      checkpointAad(envelope.checkpointId, envelope.recipientKeyId, purpose, WRAP_COUNTER),
      decodeCanonicalBase64Url(envelope.wrappedDek, "Wrapped checkpoint DEK"),
    );
    if (dek.byteLength !== 32) throw new TypeError("Checkpoint DEK has an invalid length");
    const plaintextChunks: Buffer[] = [];
    try {
      for (let expectedSeq = 0; expectedSeq < envelope.chunks.length; expectedSeq += 1) {
        const descriptor = envelope.chunks[expectedSeq]!;
        if (descriptor.seq !== expectedSeq) {
          throw new TypeError("Checkpoint chunk sequence is not contiguous");
        }
        const chunk = encryptedBySeq.get(descriptor.seq);
        if (
          !chunk ||
          chunk.bytes.byteLength !== descriptor.bytes ||
          byteDigest(chunk.bytes) !== descriptor.digest
        ) {
          throw new TypeError("Checkpoint chunk content does not match its manifest");
        }
        plaintextChunks.push(
          decryptAead(
            dek,
            chunkNonce(nonceBase, descriptor.seq),
            checkpointAad(envelope.checkpointId, envelope.recipientKeyId, purpose, descriptor.seq),
            Buffer.from(chunk.bytes),
          ),
        );
      }
      const first = plaintextChunks[0]!;
      if (
        first.byteLength < VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES ||
        !first.subarray(0, VERIFICATION_HEADER.byteLength).equals(VERIFICATION_HEADER)
      ) {
        throw new TypeError("Checkpoint verification nonce header is missing");
      }
      const verificationNonce = Buffer.from(
        first.subarray(
          VERIFICATION_HEADER.byteLength,
          VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES,
        ),
      );
      plaintextChunks[0] = Buffer.from(
        first.subarray(VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES),
      );
      first.fill(0);
      return { verificationNonce, plaintextChunks: Object.freeze(plaintextChunks) };
    } catch (error) {
      for (const plaintext of plaintextChunks) plaintext.fill(0);
      throw error;
    }
  } finally {
    sharedSecret.fill(0);
    kek.fill(0);
    dek?.fill(0);
  }
}

export function createRecoveryCheckpointVerification(input: {
  envelope: CheckpointEnvelope;
  targetId: string;
  verificationNonce: Uint8Array;
  verifiedAt: string;
  recoveryRoot: RecoveryRoot;
}): RecoveryCheckpointVerification {
  assertCanonicalTime(input.verifiedAt, "Checkpoint verification time");
  if (input.verificationNonce.byteLength !== VERIFICATION_NONCE_BYTES) {
    throw new TypeError("Checkpoint verification nonce must be 256 bits");
  }
  const unsigned = {
    v: 1 as const,
    checkpointId: input.envelope.checkpointId,
    recipientKeyId: input.envelope.recipientKeyId,
    targetId: input.targetId,
    purpose: checkpointPurpose(input.envelope),
    envelopeDigest: input.envelope.digest,
    nonceDigest: byteDigest(input.verificationNonce),
    verifiedAt: input.verifiedAt,
  };
  return { ...unsigned, signature: input.recoveryRoot.sign("RecoveryCheckpointVerification", 1, unsigned) };
}

export function verifyRecoveryCheckpointVerification(input: {
  verification: RecoveryCheckpointVerification;
  envelope: CheckpointEnvelope;
  targetId: string;
  verificationNonce: Uint8Array;
  recoveryRootPublicKey: string;
}): void {
  assertExactKeys(input.verification as unknown as Record<string, unknown>, [
    "checkpointId",
    "envelopeDigest",
    "nonceDigest",
    "purpose",
    "recipientKeyId",
    "signature",
    "targetId",
    "v",
    "verifiedAt",
  ]);
  const { signature, ...unsigned } = input.verification;
  assertCanonicalTime(unsigned.verifiedAt, "Checkpoint verification time");
  if (
    unsigned.v !== 1 ||
    unsigned.checkpointId !== input.envelope.checkpointId ||
    unsigned.recipientKeyId !== input.envelope.recipientKeyId ||
    unsigned.targetId !== input.targetId ||
    unsigned.envelopeDigest !== input.envelope.digest ||
    canonicalize(unsigned.purpose) !== canonicalize(checkpointPurpose(input.envelope)) ||
    unsigned.nonceDigest !== byteDigest(input.verificationNonce)
  ) {
    throw new TypeError("Checkpoint verification does not match the replicated envelope");
  }
  verifyRecoverySignature(
    input.recoveryRootPublicKey,
    "RecoveryCheckpointVerification",
    1,
    unsigned,
    signature,
  );
}

export function checkpointPurpose(envelope: CheckpointEnvelope): RecoveryCheckpointPurpose {
  if (envelope.manifest.purpose.kind === "periodic") return { kind: "periodic" };
  return {
    kind: "root-activation",
    activationDigest: protocolDigest(
      "RecoveryActivationPlan",
      1,
      envelope.manifest.purpose.plan,
    ),
  };
}

export function checkpointEnvelopeArtifact(envelope: CheckpointEnvelope): {
  digest: string;
  bytes: number;
} {
  const bytes = Buffer.from(canonicalize(envelope), "utf8");
  return { digest: byteDigest(bytes), bytes: bytes.byteLength };
}

export function assertRecoveryRootMatchesPlan(
  plan: RecoveryActivationPlan,
  recoveryRoot: RecoveryRoot,
): void {
  assertRecoveryRecipientMatchesPlan(plan, recoveryRoot.publicIdentity());
}

function assertRecoveryRecipientMatchesPlan(
  plan: RecoveryActivationPlan,
  recipient: CheckpointRecipient,
): void {
  const rootEvent = plan.rootEvent;
  if (
    rootEvent.body.t !== "recovery-root" ||
    rootEvent.body.backupPublicKey !== recipient.backupPublicKey ||
    keyIdForPublicKey(rootEvent.body.backupPublicKey) !== recipient.backupKeyId
  ) {
    throw new TypeError("Recovery activation plan does not activate the checkpoint recipient root");
  }
}

function assertEnvelopeShape(envelope: CheckpointEnvelope): void {
  if (!isRecord(envelope)) throw new TypeError("Checkpoint envelope must be an object");
  assertExactKeys(envelope, [
    "alg",
    "checkpointId",
    "chunks",
    "createdAt",
    "digest",
    "enc",
    "manifest",
    "nonceBase",
    "recipientKeyId",
    "signature",
    "v",
    "wrappedDek",
  ]);
  if (!isRecord(envelope.alg) || !isRecord(envelope.manifest)) {
    throw new TypeError("Checkpoint envelope header is invalid");
  }
  assertExactKeys(envelope.alg, ["aead", "kem"]);
  assertExactKeys(envelope.manifest, ["domainRevisions", "purpose", "scope", "upToLsn"]);
  if (!isRecord(envelope.manifest.purpose) || !isRecord(envelope.manifest.domainRevisions)) {
    throw new TypeError("Checkpoint manifest is invalid");
  }
  assertExactKeys(
    envelope.manifest.purpose,
    envelope.manifest.purpose.kind === "periodic" ? ["kind"] : ["kind", "plan"],
  );
  if (
    envelope.v !== 1 ||
    typeof envelope.checkpointId !== "string" ||
    typeof envelope.recipientKeyId !== "string" ||
    typeof envelope.enc !== "string" ||
    typeof envelope.wrappedDek !== "string" ||
    typeof envelope.nonceBase !== "string" ||
    typeof envelope.digest !== "string" ||
    !isRecord(envelope.signature) ||
    envelope.alg.kem !== "X25519-HKDF-SHA256" ||
    envelope.alg.aead !== "AES-256-GCM" ||
    !Array.isArray(envelope.manifest.scope) ||
    envelope.manifest.scope.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(envelope.manifest.scope).size !== envelope.manifest.scope.length ||
    !isNonNegativeInteger(envelope.manifest.upToLsn) ||
    Object.values(envelope.manifest.domainRevisions).some((revision) =>
      !isNonNegativeInteger(revision)) ||
    !Array.isArray(envelope.chunks) ||
    (envelope.manifest.purpose.kind !== "root-activation" &&
      envelope.manifest.purpose.kind !== "periodic")
  ) {
    throw new TypeError("Unsupported checkpoint envelope");
  }
  assertCanonicalTime(envelope.createdAt, "Checkpoint creation time");
  if (keyIdForPublicKey(envelope.enc) === envelope.recipientKeyId) {
    throw new TypeError("Checkpoint must use an ephemeral encapsulation key");
  }
  envelope.chunks.forEach((chunk, seq) => {
    if (!isRecord(chunk)) throw new TypeError("Checkpoint chunk descriptor is invalid");
    assertExactKeys(chunk, ["bytes", "digest", "seq"]);
    if (
      chunk.seq !== seq ||
      typeof chunk.digest !== "string" ||
      !isNonNegativeInteger(chunk.bytes) ||
      chunk.bytes < GCM_TAG_BYTES
    ) throw new TypeError("Checkpoint chunk descriptors are not a contiguous exact-set");
  });
}

/** Validates the finite wire shape without opening or authenticating encrypted contents. */
export function assertCheckpointEnvelopeShape(
  value: unknown,
): asserts value is CheckpointEnvelope {
  assertEnvelopeShape(value as CheckpointEnvelope);
}

function assertFullAuthorityCheckpointPayload(
  value: unknown,
): asserts value is FullAuthorityCheckpointPayload {
  if (!isRecord(value)) throw new TypeError("Full checkpoint payload must be an object");
  assertExactKeys(value, [
    "checkpointId",
    "createdAt",
    "coverage",
    "homeId",
    "issuer",
    "purpose",
    "recipientKeyId",
    "records",
    "retainedArtifacts",
    "source",
    "trustChainHead",
    "v",
  ]);
  if (value.v !== 1) {
    throw new TypeError("Full checkpoint payload version is unsupported");
  }
  if (
    typeof value.checkpointId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.homeId !== "string" ||
    typeof value.recipientKeyId !== "string" ||
    !isRecord(value.issuer) ||
    !isRecord(value.source) ||
    !isRecord(value.trustChainHead) ||
    !isRecord(value.coverage) ||
    !isRecord(value.records) ||
    !isRecord(value.retainedArtifacts) ||
    !isRecord(value.purpose)
  ) {
    throw new TypeError("Full checkpoint payload header is invalid");
  }
  assertCanonicalTime(value.createdAt, "Full checkpoint creation time");
  assertExactKeys(value.issuer, ["deviceId", "keyId"]);
  assertExactKeys(value.source, ["frameEndOffset", "logId", "lsn", "prefixDigest"]);
  assertExactKeys(value.trustChainHead, ["eventDigest", "seq"]);
  assertExactKeys(value.coverage, ["classes", "version"]);
  assertExactKeys(value.records, ["bytes", "count", "digest", "pages"]);
  assertExactKeys(value.retainedArtifacts, ["bytes", "count", "digest", "entries"]);
  const purposeKeys = value.purpose.kind === "periodic" ? ["kind"] : ["kind", "plan"];
  assertExactKeys(value.purpose, purposeKeys);
  if (
    typeof value.issuer.deviceId !== "string" ||
    typeof value.issuer.keyId !== "string" ||
    typeof value.source.logId !== "string" ||
    typeof value.source.prefixDigest !== "string" ||
    !isNonNegativeInteger(value.source.lsn) ||
    !isNonNegativeInteger(value.source.frameEndOffset) ||
    typeof value.trustChainHead.eventDigest !== "string" ||
    !isNonNegativeInteger(value.trustChainHead.seq) ||
    value.coverage.version !== 1 ||
    !Array.isArray(value.coverage.classes) ||
    canonicalize(value.coverage.classes) !== canonicalize(FULL_CHECKPOINT_COVERAGE) ||
    !Array.isArray(value.records.pages) ||
    !Array.isArray(value.retainedArtifacts.entries) ||
    !isNonNegativeInteger(value.records.count) ||
    !isNonNegativeInteger(value.records.bytes) ||
    typeof value.records.digest !== "string" ||
    !isNonNegativeInteger(value.retainedArtifacts.count) ||
    !isNonNegativeInteger(value.retainedArtifacts.bytes) ||
    typeof value.retainedArtifacts.digest !== "string" ||
    (value.purpose.kind !== "periodic" && value.purpose.kind !== "root-activation")
  ) {
    throw new TypeError("Full checkpoint payload fields are invalid");
  }
  let previousLsn = -1;
  value.records.pages.forEach((page, seq) => {
    if (!isRecord(page)) throw new TypeError("Full checkpoint record page is invalid");
    assertExactKeys(page, ["bytes", "digest", "firstLsn", "lastLsn", "recordCount", "seq"]);
    if (
      page.seq !== seq ||
      !isNonNegativeInteger(page.firstLsn) ||
      !isNonNegativeInteger(page.lastLsn) ||
      page.firstLsn > page.lastLsn ||
      page.firstLsn <= previousLsn ||
      !isNonNegativeInteger(page.recordCount) ||
      !isNonNegativeInteger(page.bytes) ||
      typeof page.digest !== "string"
    ) {
      throw new TypeError("Full checkpoint record pages are not canonical");
    }
    previousLsn = page.lastLsn;
  });
  let previousRef = "";
  value.retainedArtifacts.entries.forEach((entry) => {
    if (!isRecord(entry)) throw new TypeError("Full checkpoint artifact entry is invalid");
    assertExactKeys(entry, ["bytes", "digest"]);
    const identity = `${String(entry.digest)}:${String(entry.bytes).padStart(20, "0")}`;
    if (
      typeof entry.digest !== "string" ||
      !isNonNegativeInteger(entry.bytes) ||
      identity <= previousRef
    ) {
      throw new TypeError("Full checkpoint artifact directory is not canonical");
    }
    previousRef = identity;
  });
}

function verifyFullPayloadContent(
  payload: FullAuthorityCheckpointPayload,
  recordPages: readonly Uint8Array[],
  retainedArtifacts: readonly Uint8Array[],
): void {
  const pageDescriptors = recordPages.map((bytes, seq) => ({
    seq,
    bytes: bytes.byteLength,
    digest: byteDigest(bytes),
    firstLsn: payload.records.pages[seq]?.firstLsn,
    lastLsn: payload.records.pages[seq]?.lastLsn,
    recordCount: payload.records.pages[seq]?.recordCount,
  }));
  const artifactDescriptors = retainedArtifacts.map((bytes) => ({
    bytes: bytes.byteLength,
    digest: byteDigest(bytes),
  }));
  if (
    canonicalize(pageDescriptors) !== canonicalize(payload.records.pages) ||
    canonicalize(artifactDescriptors) !== canonicalize(payload.retainedArtifacts.entries) ||
    payload.records.count !== payload.records.pages.reduce((sum, page) => sum + page.recordCount, 0) ||
    payload.records.bytes !== payload.records.pages.reduce((sum, page) => sum + page.bytes, 0) ||
    payload.records.digest !== protocolDigest("FullAuthorityCheckpointRecordDirectory", 1, payload.records.pages) ||
    payload.retainedArtifacts.count !== payload.retainedArtifacts.entries.length ||
    payload.retainedArtifacts.bytes !== payload.retainedArtifacts.entries.reduce((sum, entry) => sum + entry.bytes, 0) ||
    payload.retainedArtifacts.digest !== protocolDigest("FullAuthorityCheckpointArtifactDirectory", 1, payload.retainedArtifacts.entries)
  ) {
    throw new TypeError("Full checkpoint payload content does not match its directories");
  }
}

function chunkPlaintext(parts: readonly Uint8Array[]): Buffer[] {
  const chunks: Buffer[] = [];
  let pending = Buffer.alloc(0);
  for (const part of parts) {
    let offset = 0;
    while (offset < part.byteLength) {
      const available = FULL_CHECKPOINT_CHUNK_BYTES - pending.byteLength;
      const take = Math.min(available, part.byteLength - offset);
      pending = Buffer.concat([pending, Buffer.from(part.subarray(offset, offset + take))]);
      offset += take;
      if (pending.byteLength === FULL_CHECKPOINT_CHUNK_BYTES) {
        chunks.push(pending);
        pending = Buffer.alloc(0);
      }
    }
  }
  if (pending.byteLength > 0) chunks.push(pending);
  return chunks;
}

function clearOpened(opened: { verificationNonce: Buffer; plaintextChunks: readonly Buffer[] }): void {
  opened.verificationNonce.fill(0);
  for (const chunk of opened.plaintextChunks) chunk.fill(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new TypeError("Checkpoint value contains missing or unknown fields");
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function deriveKek(sharedSecret: Uint8Array, recipientKeyId: string, checkpointId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(recipientKeyId, "utf8"),
      protocolBytes("CheckpointKek", 1, { checkpointId, recipientKeyId }),
      32,
    ),
  );
}

function checkpointAad(
  checkpointId: string,
  recipientKeyId: string,
  purpose: RecoveryCheckpointPurpose,
  seq: number,
): Buffer {
  return protocolBytes("CheckpointCiphertext", 1, { checkpointId, recipientKeyId, purpose, seq });
}

function chunkNonce(nonceBase: Uint8Array, counter: number): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > WRAP_COUNTER) {
    throw new TypeError("Checkpoint nonce counter is invalid");
  }
  const nonce = Buffer.from(nonceBase);
  if (nonce.byteLength !== 12) throw new TypeError("Checkpoint nonce base must be 96 bits");
  nonce.writeUInt32BE(counter, 8);
  return nonce;
}

function encryptAead(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function decryptAead(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Buffer {
  if (sealed.byteLength < GCM_TAG_BYTES) throw new TypeError("Checkpoint ciphertext is truncated");
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(bytes.byteLength - GCM_TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.byteLength - GCM_TAG_BYTES)),
      decipher.final(),
    ]);
  } catch (error) {
    throw new TypeError("Checkpoint ciphertext authentication failed", { cause: error });
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be non-negative`);
}

function assertCanonicalTime(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO`);
  }
}
