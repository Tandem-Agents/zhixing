import {
  createHash,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type {
  ArtifactRef,
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

/** Checkpoint-only bounded reader. Returned bytes are caller-owned and are cleared after consumption. */
export interface CheckpointChunkSource {
  read(
    seq: number,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface CheckpointPackage {
  readonly envelope: CheckpointEnvelope;
  /** Present only for legacy/small in-memory packages. Full checkpoints use `source`. */
  readonly chunks?: readonly EncryptedCheckpointChunk[];
  readonly source?: CheckpointChunkSource;
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

export interface VerifiedFullAuthorityCheckpoint {
  readonly verificationNonce: Buffer;
  readonly payload: FullAuthorityCheckpointPayload;
}

export interface FullAuthorityCheckpointContent {
  readonly kind: "record-page" | "retained-artifact";
  readonly index: number;
  readonly ref: ArtifactRef;
}

/** Transfer-private sink used while a full checkpoint is decrypted and verified. */
export interface FullAuthorityCheckpointSink {
  write(
    content: FullAuthorityCheckpointContent,
    offset: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
}

export async function readCheckpointChunkRange(
  checkpoint: CheckpointPackage,
  seq: number,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const descriptor = checkpoint.envelope.chunks[seq];
  if (
    !descriptor || descriptor.seq !== seq ||
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(limit) || limit <= 0 || offset > descriptor.bytes
  ) {
    throw new TypeError("Checkpoint chunk range is invalid");
  }
  const expected = Math.min(limit, descriptor.bytes - offset);
  let bytes: Buffer;
  if (checkpoint.source) {
    const sourceBytes = await checkpoint.source.read(seq, offset, limit, signal);
    bytes = Buffer.from(sourceBytes);
    Buffer.from(sourceBytes.buffer, sourceBytes.byteOffset, sourceBytes.byteLength).fill(0);
  } else {
    bytes = Buffer.from(checkpoint.chunks?.find((candidate) => candidate.seq === seq)?.bytes ?? [])
      .subarray(offset, offset + expected);
  }
  if (bytes.byteLength !== expected) {
    bytes.fill(0);
    throw new TypeError("Checkpoint chunk source returned an invalid range");
  }
  return bytes;
}

export async function readCheckpointChunk(
  checkpoint: CheckpointPackage,
  seq: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const descriptor = checkpoint.envelope.chunks[seq];
  if (!descriptor || descriptor.seq !== seq) {
    throw new TypeError("Checkpoint chunk sequence is invalid");
  }
  return readCheckpointChunkRange(checkpoint, seq, 0, descriptor.bytes || 1, signal);
}

export function checkpointPackageFromChunks(
  envelope: CheckpointEnvelope,
  chunks: readonly EncryptedCheckpointChunk[],
): CheckpointPackage {
  return Object.freeze({ envelope, chunks: Object.freeze([...chunks]) });
}

/** Creates the canonical identifier used by a newly prepared checkpoint. */
export function createCheckpointId(now = Date.now()): string {
  return createUlid(now);
}

const CHECKPOINT_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deriveCheckpointId(identity: string, time: number): string {
  if (identity.length === 0 || !Number.isFinite(time) || time < 0) {
    throw new TypeError("Checkpoint identity is invalid");
  }
  const bytes = createHash("sha256").update(identity).digest();
  let timestamp = Math.floor(time);
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = CHECKPOINT_BASE32[timestamp % 32]! + head;
    timestamp = Math.floor(timestamp / 32);
  }
  let tail = "";
  let bits = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && tail.length < 16) {
      bitCount -= 5;
      tail += CHECKPOINT_BASE32[(bits >>> bitCount) & 31]!;
      bits &= (1 << bitCount) - 1;
    }
    if (tail.length === 16) break;
  }
  return `${head}${tail}`;
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

/** Encrypts a full checkpoint one fixed plaintext chunk at a time into its existing local CAS. */
export async function createStoredFullAuthorityCheckpoint(input: {
  readonly payload: FullAuthorityCheckpointPayload;
  readonly recipient: CheckpointRecipient;
  readonly issuer: CheckpointSigner;
  readonly plaintextChunks: AsyncIterable<Uint8Array>;
  readonly persistChunk: (seq: number, bytes: Uint8Array) => Promise<void>;
  readonly source: CheckpointChunkSource;
}): Promise<CheckpointPackage> {
  const payload = input.payload;
  assertFullAuthorityCheckpointPayload(payload);
  if (payload.recipientKeyId !== input.recipient.backupKeyId) {
    throw new TypeError("Full checkpoint recipient does not match the recovery root");
  }
  if (payload.issuer.deviceId !== input.issuer.deviceId) {
    throw new TypeError("Full checkpoint issuer does not match the signing device");
  }
  const header = Buffer.from(canonicalize(payload), "utf8");
  if (header.byteLength > FULL_CHECKPOINT_CHUNK_BYTES) {
    throw new TypeError("Full checkpoint payload header exceeds the fixed chunk bound");
  }
  header.fill(0);

  assertCanonicalTime(payload.createdAt, "Checkpoint creation time");
  const manifest = {
    scope: [...payload.coverage.classes],
    domainRevisions: { authority: payload.source.lsn },
    upToLsn: payload.source.lsn,
    purpose: payload.purpose,
  };
  const purpose: RecoveryCheckpointPurpose = payload.purpose.kind === "periodic"
    ? { kind: "periodic" }
    : {
        kind: "root-activation",
        activationDigest: protocolDigest("RecoveryActivationPlan", 1, payload.purpose.plan),
      };
  const identity = input.recipient;
  const dek = randomBytes(32);
  const nonceBase = randomBytes(12);
  const verificationNonce = randomBytes(VERIFICATION_NONCE_BYTES);
  const ephemeral = generateKeyPairSync("x25519");
  const enc = encodeX25519PublicKey(ephemeral.publicKey);
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importEncodedPublicKey(identity.backupPublicKey, "x25519"),
  });
  const kek = deriveKek(sharedSecret, identity.backupKeyId, payload.checkpointId);
  const descriptors: CheckpointEnvelope["chunks"][number][] = [];
  let seq = 0;
  try {
    for await (const inputChunk of input.plaintextChunks) {
      if (seq >= WRAP_COUNTER) throw new TypeError("Checkpoint has too many chunks");
      const plaintext = seq === 0
        ? Buffer.concat([VERIFICATION_HEADER, verificationNonce, Buffer.from(inputChunk)])
        : Buffer.from(inputChunk);
      let encrypted: Buffer | undefined;
      try {
        encrypted = encryptAead(
          dek,
          chunkNonce(nonceBase, seq),
          checkpointAad(payload.checkpointId, identity.backupKeyId, purpose, seq),
          plaintext,
        );
        await input.persistChunk(seq, encrypted);
        descriptors.push({ seq, digest: byteDigest(encrypted), bytes: encrypted.byteLength });
      } finally {
        plaintext.fill(0);
        encrypted?.fill(0);
      }
      seq += 1;
    }
    if (seq === 0) throw new TypeError("Checkpoint requires at least one chunk");
    const wrappedDek = encryptAead(
      kek,
      chunkNonce(nonceBase, WRAP_COUNTER),
      checkpointAad(payload.checkpointId, identity.backupKeyId, purpose, WRAP_COUNTER),
      dek,
    ).toString("base64url");
    const body = {
      v: 1 as const,
      checkpointId: payload.checkpointId,
      createdAt: payload.createdAt,
      alg: { kem: "X25519-HKDF-SHA256" as const, aead: "AES-256-GCM" as const },
      recipientKeyId: identity.backupKeyId,
      enc,
      wrappedDek,
      nonceBase: nonceBase.toString("base64url"),
      manifest,
      chunks: descriptors,
    };
    const digest = protocolDigest("CheckpointEnvelope", 1, body);
    const signed = { ...body, digest };
    const envelope: CheckpointEnvelope = Object.freeze({
      ...signed,
      signature: input.issuer.sign("CheckpointEnvelope", 1, signed),
    });
    return Object.freeze({ envelope, source: input.source });
  } finally {
    dek.fill(0);
    kek.fill(0);
    sharedSecret.fill(0);
    verificationNonce.fill(0);
  }
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
  let verificationNonce: Buffer | undefined;
  let payload: FullAuthorityCheckpointPayload | undefined;
  let declaredContents: Buffer[] | undefined;
  let contentIndex = 0;
  let contentOffset = 0;
  try {
    const opened = visitCheckpointPlaintext(input, (seq, plaintext) => {
      if (seq === 0) {
        const text = plaintext.toString("utf8");
        const value = JSON.parse(text) as unknown;
        if (canonicalize(value) !== text) {
          throw new TypeError("Full checkpoint payload header is not canonical");
        }
        assertFullAuthorityCheckpointPayload(value);
        const envelope = input.package.envelope;
        if (
          value.checkpointId !== envelope.checkpointId ||
          value.createdAt !== envelope.createdAt ||
          value.recipientKeyId !== envelope.recipientKeyId ||
          value.source.lsn !== envelope.manifest.upToLsn ||
          canonicalize(value.purpose) !== canonicalize(envelope.manifest.purpose) ||
          canonicalize(value.coverage.classes) !== canonicalize(envelope.manifest.scope)
        ) {
          throw new TypeError("Full checkpoint payload is not bound to its envelope");
        }
        payload = value;
        declaredContents = [
          ...value.records.pages.map((descriptor) => Buffer.allocUnsafe(descriptor.bytes)),
          ...value.retainedArtifacts.entries.map((descriptor) => Buffer.allocUnsafe(descriptor.bytes)),
        ];
        return;
      }
      if (!declaredContents) throw new TypeError("Full checkpoint payload header is missing");
      let sourceOffset = 0;
      while (sourceOffset < plaintext.byteLength) {
        while (declaredContents[contentIndex]?.byteLength === contentOffset) {
          contentIndex += 1;
          contentOffset = 0;
        }
        const content = declaredContents[contentIndex];
        if (!content) throw new TypeError("Full checkpoint plaintext contains undeclared bytes");
        const take = Math.min(
          plaintext.byteLength - sourceOffset,
          content.byteLength - contentOffset,
        );
        plaintext.copy(content, contentOffset, sourceOffset, sourceOffset + take);
        sourceOffset += take;
        contentOffset += take;
      }
    });
    verificationNonce = opened.verificationNonce;
    if (!payload || !declaredContents) {
      throw new TypeError("Full checkpoint payload header is missing");
    }
    while (declaredContents[contentIndex]?.byteLength === contentOffset) {
      contentIndex += 1;
      contentOffset = 0;
    }
    if (contentIndex !== declaredContents.length || contentOffset !== 0) {
      throw new TypeError("Full checkpoint plaintext is truncated");
    }
    const recordPages = declaredContents.slice(0, payload.records.pages.length);
    const retainedArtifacts = declaredContents.slice(payload.records.pages.length);
    verifyFullPayloadContent(payload, recordPages, retainedArtifacts);
    declaredContents = undefined;
    return {
      verificationNonce,
      payload,
      recordPages: Object.freeze(recordPages),
      retainedArtifacts: Object.freeze(retainedArtifacts),
    };
  } catch (error) {
    for (const content of declaredContents ?? []) content.fill(0);
    verificationNonce?.fill(0);
    throw error;
  }
}

/** Verifies a full checkpoint without materializing its declared record or artifact bodies. */
export async function verifyStoredFullAuthorityCheckpoint(input: {
  package: CheckpointPackage;
  recoveryRoot: RecoveryRoot;
  issuer: DeviceIdentity;
  sink?: FullAuthorityCheckpointSink;
  signal?: AbortSignal;
}): Promise<VerifiedFullAuthorityCheckpoint> {
  const { envelope } = input.package;
  assertEnvelopeShape(envelope);
  const identity = input.recoveryRoot.publicIdentity();
  if (envelope.recipientKeyId !== identity.backupKeyId) {
    throw new TypeError("Checkpoint recipient does not match the recovery root");
  }
  const { signature, digest, ...body } = envelope;
  if (digest !== protocolDigest("CheckpointEnvelope", 1, body)) {
    throw new TypeError("Checkpoint envelope digest is invalid");
  }
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
  const nonceBase = decodeCanonicalBase64Url(envelope.nonceBase, "Checkpoint nonce base");
  if (nonceBase.byteLength !== 12) throw new TypeError("Checkpoint nonce base must be 96 bits");
  const sharedSecret = input.recoveryRoot.decapsulate(envelope.enc);
  const kek = deriveKek(sharedSecret, envelope.recipientKeyId, envelope.checkpointId);
  let dek: Buffer | undefined;
  let verificationNonce: Buffer | undefined;
  let payload: FullAuthorityCheckpointPayload | undefined;
  let declared: readonly FullAuthorityCheckpointContent[] = [];
  let contentIndex = 0;
  let contentOffset = 0;
  let contentHash = createHash("sha256");
  const advanceEmptyContents = async (): Promise<void> => {
    while (declared[contentIndex]?.ref.bytes === 0) {
      const current = declared[contentIndex]!;
      if (`sha256:${contentHash.digest("hex")}` !== current.ref.digest) {
        throw new TypeError("Full checkpoint declared content digest is invalid");
      }
      await input.sink?.write(current, 0, Buffer.alloc(0), input.signal);
      contentIndex += 1;
      contentHash = createHash("sha256");
    }
  };
  try {
    dek = decryptAead(
      kek,
      chunkNonce(nonceBase, WRAP_COUNTER),
      checkpointAad(envelope.checkpointId, envelope.recipientKeyId, purpose, WRAP_COUNTER),
      decodeCanonicalBase64Url(envelope.wrappedDek, "Wrapped checkpoint DEK"),
    );
    if (dek.byteLength !== 32) throw new TypeError("Checkpoint DEK has an invalid length");
    for (let seq = 0; seq < envelope.chunks.length; seq += 1) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Checkpoint verification was cancelled");
      const descriptor = envelope.chunks[seq]!;
      if (descriptor.seq !== seq) throw new TypeError("Checkpoint chunk sequence is not contiguous");
      const encrypted = await readCheckpointChunk(input.package, seq, input.signal);
      let plaintext: Buffer | undefined;
      try {
        if (encrypted.byteLength !== descriptor.bytes || byteDigest(encrypted) !== descriptor.digest) {
          throw new TypeError("Checkpoint chunk content does not match its manifest");
        }
        plaintext = decryptAead(
          dek,
          chunkNonce(nonceBase, seq),
          checkpointAad(envelope.checkpointId, envelope.recipientKeyId, purpose, seq),
          encrypted,
        );
        let content = plaintext;
        if (seq === 0) {
          if (
            plaintext.byteLength < VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES ||
            !plaintext.subarray(0, VERIFICATION_HEADER.byteLength).equals(VERIFICATION_HEADER)
          ) throw new TypeError("Checkpoint verification nonce header is missing");
          verificationNonce = Buffer.from(plaintext.subarray(
            VERIFICATION_HEADER.byteLength,
            VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES,
          ));
          content = plaintext.subarray(VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES);
          const text = content.toString("utf8");
          const value = JSON.parse(text) as unknown;
          if (canonicalize(value) !== text) {
            throw new TypeError("Full checkpoint payload header is not canonical");
          }
          assertFullAuthorityCheckpointPayload(value);
          if (
            value.checkpointId !== envelope.checkpointId ||
            value.createdAt !== envelope.createdAt ||
            value.recipientKeyId !== envelope.recipientKeyId ||
            value.source.lsn !== envelope.manifest.upToLsn ||
            canonicalize(value.purpose) !== canonicalize(envelope.manifest.purpose) ||
            canonicalize(value.coverage.classes) !== canonicalize(envelope.manifest.scope)
          ) throw new TypeError("Full checkpoint payload is not bound to its envelope");
          payload = value;
          declared = [
            ...payload.records.pages.map((page, index) => ({
              kind: "record-page" as const,
              index,
              ref: { digest: page.digest, bytes: page.bytes },
            })),
            ...payload.retainedArtifacts.entries.map((ref, index) => ({
              kind: "retained-artifact" as const,
              index,
              ref,
            })),
          ];
          await advanceEmptyContents();
          continue;
        }
        if (!payload) throw new TypeError("Full checkpoint payload header is missing");
        let offset = 0;
        while (offset < content.byteLength) {
          const current = declared[contentIndex];
          if (!current) throw new TypeError("Full checkpoint plaintext contains undeclared bytes");
          const take = Math.min(content.byteLength - offset, current.ref.bytes - contentOffset);
          const slice = content.subarray(offset, offset + take);
          contentHash.update(slice);
          await input.sink?.write(current, contentOffset, slice, input.signal);
          offset += take;
          contentOffset += take;
          if (contentOffset === current.ref.bytes) {
            if (`sha256:${contentHash.digest("hex")}` !== current.ref.digest) {
              throw new TypeError("Full checkpoint declared content digest is invalid");
            }
            contentIndex += 1;
            contentOffset = 0;
            contentHash = createHash("sha256");
            await advanceEmptyContents();
          }
        }
      } finally {
        encrypted.fill(0);
        plaintext?.fill(0);
      }
    }
    if (!verificationNonce || !payload) {
      throw new TypeError("Full checkpoint payload header is missing");
    }
    await advanceEmptyContents();
    if (contentIndex !== payload.records.pages.length + payload.retainedArtifacts.entries.length || contentOffset !== 0) {
      throw new TypeError("Full checkpoint plaintext is truncated");
    }
    return { verificationNonce, payload };
  } catch (error) {
    verificationNonce?.fill(0);
    throw error;
  } finally {
    sharedSecret.fill(0);
    kek.fill(0);
    dek?.fill(0);
  }
}

function openCheckpoint(input: {
  package: CheckpointPackage;
  recoveryRoot: RecoveryRoot;
  issuer: DeviceIdentity;
}): { verificationNonce: Buffer; plaintextChunks: readonly Buffer[] } {
  const plaintextChunks: Buffer[] = [];
  try {
    const opened = visitCheckpointPlaintext(input, (_seq, plaintext) => {
      plaintextChunks.push(Buffer.from(plaintext));
    });
    return { verificationNonce: opened.verificationNonce, plaintextChunks: Object.freeze(plaintextChunks) };
  } catch (error) {
    for (const plaintext of plaintextChunks) plaintext.fill(0);
    throw error;
  }
}

function visitCheckpointPlaintext(
  input: {
    package: CheckpointPackage;
    recoveryRoot: RecoveryRoot;
    issuer: DeviceIdentity;
  },
  visitor: (seq: number, plaintext: Buffer) => void,
): { verificationNonce: Buffer } {
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
  const materialized = input.package.chunks;
  if (!materialized) {
    throw new TypeError("Synchronous checkpoint opening requires a materialized legacy package");
  }
  const encryptedBySeq = new Map(materialized.map((chunk) => [chunk.seq, chunk]));
  if (
    materialized.length !== envelope.chunks.length ||
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
    let verificationNonce: Buffer | undefined;
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
        const plaintext = decryptAead(
          dek,
          chunkNonce(nonceBase, descriptor.seq),
          checkpointAad(envelope.checkpointId, envelope.recipientKeyId, purpose, descriptor.seq),
          Buffer.from(chunk.bytes),
        );
        try {
          if (expectedSeq === 0) {
            if (
              plaintext.byteLength < VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES ||
              !plaintext.subarray(0, VERIFICATION_HEADER.byteLength).equals(VERIFICATION_HEADER)
            ) {
              throw new TypeError("Checkpoint verification nonce header is missing");
            }
            verificationNonce = Buffer.from(
              plaintext.subarray(
                VERIFICATION_HEADER.byteLength,
                VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES,
              ),
            );
            visitor(
              expectedSeq,
              plaintext.subarray(VERIFICATION_HEADER.byteLength + VERIFICATION_NONCE_BYTES),
            );
          } else {
            visitor(expectedSeq, plaintext);
          }
        } finally {
          plaintext.fill(0);
        }
      }
      if (!verificationNonce) throw new TypeError("Checkpoint verification nonce header is missing");
      return { verificationNonce };
    } catch (error) {
      verificationNonce?.fill(0);
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
