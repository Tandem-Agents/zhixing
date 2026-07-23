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
  assertCanonicalTime(input.createdAt, "Checkpoint creation time");
  if (input.plaintextChunks.length === 0) throw new TypeError("Checkpoint requires at least one chunk");
  if (input.plaintextChunks.length >= WRAP_COUNTER) throw new TypeError("Checkpoint has too many chunks");
  assertNonNegativeInteger(input.upToLsn, "Checkpoint LSN");
  const identity = input.recoveryRoot.publicIdentity();
  assertRecoveryRootMatchesPlan(input.plan, input.recoveryRoot);
  const activationDigest = protocolDigest("RecoveryActivationPlan", 1, input.plan);
  const manifest = {
    scope: [...input.scope],
    domainRevisions: { ...input.domainRevisions },
    upToLsn: input.upToLsn,
    purpose: { kind: "root-activation" as const, plan: input.plan },
  };
  const purpose: RecoveryCheckpointPurpose = {
    kind: "root-activation",
    activationDigest,
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
  const activationDigest = protocolDigest(
    "RecoveryActivationPlan",
    1,
    envelope.manifest.purpose.kind === "root-activation"
      ? envelope.manifest.purpose.plan
      : undefined,
  );
  if (purpose.kind !== "root-activation" || purpose.activationDigest !== activationDigest) {
    throw new TypeError("Checkpoint activation plan digest is invalid");
  }
  const encryptedBySeq = new Map(input.package.chunks.map((chunk) => [chunk.seq, chunk]));
  if (encryptedBySeq.size !== envelope.chunks.length) {
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
  const rootEvent = plan.rootEvent;
  if (
    rootEvent.body.t !== "recovery-root" ||
    rootEvent.body.rootPublicKey !== recoveryRoot.rootPublicKey ||
    rootEvent.body.backupPublicKey !== recoveryRoot.backupPublicKey
  ) {
    throw new TypeError("Recovery activation plan does not activate the checkpoint recipient root");
  }
}

function assertEnvelopeShape(envelope: CheckpointEnvelope): void {
  if (
    envelope.v !== 1 ||
    envelope.alg.kem !== "X25519-HKDF-SHA256" ||
    envelope.alg.aead !== "AES-256-GCM" ||
    envelope.manifest.purpose.kind !== "root-activation"
  ) {
    throw new TypeError("Unsupported checkpoint envelope");
  }
  assertCanonicalTime(envelope.createdAt, "Checkpoint creation time");
  if (keyIdForPublicKey(envelope.enc) === envelope.recipientKeyId) {
    throw new TypeError("Checkpoint must use an ephemeral encapsulation key");
  }
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
