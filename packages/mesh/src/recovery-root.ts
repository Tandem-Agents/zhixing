import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { Signature } from "@zhixing/core/contracts";
import { protocolBytes } from "./canonical.js";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const MASTER_SECRET_BYTES = 32;

export interface RecoveryRootPublicIdentity {
  readonly rootPublicKey: string;
  readonly rootKeyId: string;
  readonly backupPublicKey: string;
  readonly backupKeyId: string;
}

export class RecoveryRoot {
  readonly rootPublicKey: string;
  readonly rootKeyId: string;
  readonly backupPublicKey: string;
  readonly backupKeyId: string;

  private constructor(
    private readonly masterSecret: Buffer,
    private readonly signingKey: KeyObject,
    private readonly backupKey: KeyObject,
  ) {
    this.rootPublicKey = encodePublicKey("ed25519", createPublicKey(signingKey));
    this.rootKeyId = keyIdForPublicKey(this.rootPublicKey);
    this.backupPublicKey = encodePublicKey("x25519", createPublicKey(backupKey));
    this.backupKeyId = keyIdForPublicKey(this.backupPublicKey);
    Object.freeze(this);
  }

  static generate(): RecoveryRoot {
    return RecoveryRoot.importSecret(randomBytes(MASTER_SECRET_BYTES).toString("base64url"));
  }

  static importSecret(encoded: string): RecoveryRoot {
    const secret = decodeCanonicalBase64Url(encoded, "Recovery master secret");
    if (secret.byteLength !== MASTER_SECRET_BYTES || secret.every((byte) => byte === 0)) {
      throw new TypeError("Recovery master secret must contain 256 bits of entropy");
    }
    const signingSeed = deriveSeed(secret, "signing-ed25519");
    const backupSeed = deriveSeed(secret, "backup-x25519");
    try {
      return new RecoveryRoot(
        Buffer.from(secret),
        privateKeyFromSeed(ED25519_PKCS8_PREFIX, signingSeed),
        privateKeyFromSeed(X25519_PKCS8_PREFIX, backupSeed),
      );
    } finally {
      secret.fill(0);
      signingSeed.fill(0);
      backupSeed.fill(0);
    }
  }

  publicIdentity(): RecoveryRootPublicIdentity {
    return Object.freeze({
      rootPublicKey: this.rootPublicKey,
      rootKeyId: this.rootKeyId,
      backupPublicKey: this.backupPublicKey,
      backupKeyId: this.backupKeyId,
    });
  }

  exportSecret(): string {
    return this.masterSecret.toString("base64url");
  }

  sign(schemaId: string, version: number, payload: unknown): Signature {
    return {
      alg: "ed25519",
      keyId: this.rootKeyId,
      sig: sign(null, protocolBytes(schemaId, version, payload), this.signingKey).toString(
        "base64url",
      ),
    };
  }

  decapsulate(ephemeralPublicKey: string): Buffer {
    return diffieHellman({
      privateKey: this.backupKey,
      publicKey: importEncodedPublicKey(ephemeralPublicKey, "x25519"),
    });
  }
}

export function keyIdForPublicKey(encoded: string): string {
  const { der } = decodePublicKey(encoded);
  return `fp:u${createHash("sha256").update(der).digest("base64url")}`;
}

export function importEncodedPublicKey(
  encoded: string,
  expected: "ed25519" | "x25519",
): KeyObject {
  const decoded = decodePublicKey(encoded);
  if (decoded.algorithm !== expected) {
    throw new TypeError(`Expected ${expected} public key`);
  }
  const key = createPublicKey({ key: decoded.der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== expected) {
    throw new TypeError(`Encoded key is not ${expected}`);
  }
  return key;
}

export function encodeX25519PublicKey(key: KeyObject): string {
  if (key.asymmetricKeyType !== "x25519") throw new TypeError("Expected X25519 key");
  return encodePublicKey("x25519", key);
}

export function verifyRecoverySignature(
  publicKey: string,
  schemaId: string,
  version: number,
  payload: unknown,
  signature: Signature,
): void {
  const keyId = keyIdForPublicKey(publicKey);
  if (signature.alg !== "ed25519" || signature.keyId !== keyId) {
    throw new TypeError("Recovery signature algorithm or key id is invalid");
  }
  const encoded = decodeCanonicalBase64Url(signature.sig, "Recovery signature");
  if (
    encoded.byteLength !== 64 ||
    !verify(
      null,
      protocolBytes(schemaId, version, payload),
      importEncodedPublicKey(publicKey, "ed25519"),
      encoded,
    )
  ) {
    throw new TypeError("Recovery signature is invalid");
  }
}

export function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return decoded;
}

function deriveSeed(secret: Uint8Array, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.from("zhixing-recovery-root-v1", "utf8"),
      Buffer.from(purpose, "utf8"),
      32,
    ),
  );
}

function privateKeyFromSeed(prefix: Buffer, seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function encodePublicKey(algorithm: "ed25519" | "x25519", key: KeyObject): string {
  return `${algorithm}:${key.export({ format: "der", type: "spki" }).toString("base64url")}`;
}

function decodePublicKey(encoded: string): {
  algorithm: "ed25519" | "x25519";
  der: Buffer;
} {
  const separator = encoded.indexOf(":");
  const algorithm = encoded.slice(0, separator);
  if (algorithm !== "ed25519" && algorithm !== "x25519") {
    throw new TypeError("Unsupported recovery public key encoding");
  }
  return {
    algorithm,
    der: decodeCanonicalBase64Url(encoded.slice(separator + 1), "Recovery public key"),
  };
}
