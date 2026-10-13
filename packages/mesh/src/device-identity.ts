import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import type { DeviceIdentity, Signature } from "@zhixing/core/contracts";
import type { Crypto, CryptoKey as CertificateCryptoKey } from "@peculiar/webcrypto";
import { protocolBytes } from "./canonical.js";
import { MeshProtocolError } from "./errors.js";

const PUBLIC_KEY_PREFIX = "ed25519:";
// Cache parsing, never trust or signature decisions. Weak ownership follows
// the caller's identity lifetime; changing the wire key invalidates the entry.
const decodedIdentityKeys = new WeakMap<DeviceIdentity, { publicKey: string; fingerprint: string; key: KeyObject }>();
const DEFAULT_TLS_VALIDITY_MS = 24 * 60 * 60_000;
const CERTIFICATE_BACKDATE_MS = 2 * 60_000;
const DEVICE_IDENTITY_NOT_AFTER_MS = Date.parse("9999-12-31T23:59:59.000Z");
// 证书签发栈（ASN.1、X.509 与 WebCrypto 垫片）只在签发证书时加载，不进入宿主启动的模块图；
// 加载失败下次重试。X.509 依赖的元数据垫片须先于它求值。
let certificateToolkit: Promise<{ readonly x509: typeof import("@peculiar/x509"); readonly crypto: Crypto }> | undefined;
function loadCertificateToolkit(): Promise<{ readonly x509: typeof import("@peculiar/x509"); readonly crypto: Crypto }> {
  certificateToolkit ??= (async () => {
    await import("reflect-metadata");
    const [x509, webcrypto] = await Promise.all([import("@peculiar/x509"), import("@peculiar/webcrypto")]);
    return { x509, crypto: new webcrypto.Crypto() };
  })();
  certificateToolkit.catch(() => { certificateToolkit = undefined; });
  return certificateToolkit;
}

interface WebCryptoKeyPair {
  readonly privateKey: CertificateCryptoKey;
  readonly publicKey: CertificateCryptoKey;
}

export interface DeviceKeyMaterial {
  readonly pkcs8: string;
  readonly rootCertificatePem: string;
}

export interface DeviceEnrollmentMetadata {
  readonly displayName: string;
  readonly platform: DeviceIdentity["platform"];
  readonly enrolledAt: string;
}

export interface DeviceTlsCredential {
  readonly deviceId: string;
  readonly privateKeyPem: string;
  readonly certificateChainPem: string;
  readonly expiresAt: string;
}

export interface DeviceKeyGenerationOptions {
  readonly now?: () => number;
  readonly rootValidityMs?: number;
}

export interface DeviceTlsCredentialOptions {
  readonly now?: () => number;
  readonly validityMs?: number;
}

/** Long-lived device key. Enrollment metadata is deliberately created separately. */
export class DeviceKey {
  readonly deviceId: string;
  readonly publicKey: string;
  readonly rootCertificatePem: string;
  readonly rootExpiresAt: string;
  private readonly rootValidFrom: number;
  private readonly rootValidTo: number;

  private constructor(
    private readonly privateKey: KeyObject,
    rootCertificatePem: string,
    validationTime: number,
  ) {
    const certificate = validateRootCertificate(privateKey, rootCertificatePem, validationTime);
    this.rootCertificatePem = ensureTrailingNewline(rootCertificatePem);
    this.rootValidFrom = Date.parse(certificate.validFrom);
    this.rootValidTo = Date.parse(certificate.validTo);
    this.rootExpiresAt = new Date(this.rootValidTo).toISOString();
    this.publicKey = encodePublicKey(certificate.publicKey);
    this.deviceId = deviceIdFromPublicKey(this.publicKey);
    Object.freeze(this);
  }

  static async generate(options: DeviceKeyGenerationOptions = {}): Promise<DeviceKey> {
    const now = options.now ?? Date.now;
    const issuedAt = assertTimestamp(now(), "Device root certificate issue time");
    const rootExpiresAt =
      options.rootValidityMs === undefined
        ? DEVICE_IDENTITY_NOT_AFTER_MS
        : expiryFromDuration(
            issuedAt,
            options.rootValidityMs,
            "device root certificate",
          );
    if (rootExpiresAt <= issuedAt) {
      throw new TypeError("Device identity certificate expiry must follow its issue time");
    }
    const { x509, crypto: certificateCrypto } = await loadCertificateToolkit();
    const keys = (await certificateCrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as WebCryptoKeyPair;
    const publicKey = encodePublicKey(
      createPublicKey({
        key: Buffer.from(await certificateCrypto.subtle.exportKey("spki", keys.publicKey)),
        format: "der",
        type: "spki",
      }),
    );
    const deviceId = deviceIdFromPublicKey(publicKey);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned(
      {
        serialNumber: randomBytes(16).toString("hex"),
        name: rootSubject(deviceId),
        notBefore: new Date(issuedAt - CERTIFICATE_BACKDATE_MS),
        // Revocation belongs to the signed home trust chain; this private CA only binds the
        // stable device key into TLS and therefore follows the identity's lifetime.
        notAfter: new Date(rootExpiresAt),
        signingAlgorithm: { name: "Ed25519" },
        keys,
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign,
            true,
          ),
          await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, certificateCrypto),
        ],
      },
      certificateCrypto,
    );
    const privateKey = createPrivateKey({
      key: Buffer.from(await certificateCrypto.subtle.exportKey("pkcs8", keys.privateKey)),
      format: "der",
      type: "pkcs8",
    });
    return new DeviceKey(privateKey, certificate.toString("pem"), issuedAt);
  }

  static import(material: DeviceKeyMaterial): DeviceKey {
    let privateKey: KeyObject;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(material.pkcs8)) {
        throw new TypeError("Device private key is not canonical base64url");
      }
      const encoded = Buffer.from(material.pkcs8, "base64url");
      if (encoded.toString("base64url") !== material.pkcs8) {
        throw new TypeError("Device private key is not canonical base64url");
      }
      privateKey = createPrivateKey({
        key: encoded,
        format: "der",
        type: "pkcs8",
      });
    } catch (error) {
      throw new TypeError("Invalid Ed25519 PKCS8 device key", { cause: error });
    }
    return new DeviceKey(privateKey, material.rootCertificatePem, Date.now());
  }

  sign(schemaId: string, version: number, payload: unknown): Signature {
    return {
      alg: "ed25519",
      keyId: this.deviceId,
      sig: sign(null, protocolBytes(schemaId, version, payload), this.privateKey).toString(
        "base64url",
      ),
    };
  }

  exportMaterial(): DeviceKeyMaterial {
    return {
      pkcs8: this.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
      rootCertificatePem: this.rootCertificatePem,
    };
  }

  async issueTlsCredential(
    options: DeviceTlsCredentialOptions = {},
  ): Promise<DeviceTlsCredential> {
    const now = options.now ?? Date.now;
    const issuedAt = assertTimestamp(now(), "TLS leaf certificate issue time");
    const validityMs = options.validityMs ?? DEFAULT_TLS_VALIDITY_MS;
    const expiresAtMs = expiryFromDuration(
      issuedAt,
      validityMs,
      "TLS leaf certificate",
    );
    if (issuedAt < this.rootValidFrom || issuedAt > this.rootValidTo) {
      throw new TypeError("Device root certificate is not valid at TLS issuance time");
    }
    if (expiresAtMs > this.rootValidTo) {
      throw new TypeError("TLS leaf certificate cannot outlive its device trust root");
    }
    const { x509, crypto: certificateCrypto } = await loadCertificateToolkit();
    const rootPrivateKey = await certificateCrypto.subtle.importKey(
      "pkcs8",
      this.privateKey.export({ format: "der", type: "pkcs8" }),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const leafKeys = (await certificateCrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as WebCryptoKeyPair;
    const expiresAt = new Date(expiresAtMs);
    const certificate = await x509.X509CertificateGenerator.create(
      {
        serialNumber: randomBytes(16).toString("hex"),
        subject: leafSubject(this.deviceId),
        issuer: rootSubject(this.deviceId),
        notBefore: new Date(issuedAt - CERTIFICATE_BACKDATE_MS),
        notAfter: expiresAt,
        publicKey: leafKeys.publicKey,
        signingKey: rootPrivateKey,
        signingAlgorithm: { name: "Ed25519" },
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension(
            [x509.ExtendedKeyUsage.clientAuth, x509.ExtendedKeyUsage.serverAuth],
            true,
          ),
          await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey, false, certificateCrypto),
        ],
      },
      certificateCrypto,
    );
    const privateKeyDer = await certificateCrypto.subtle.exportKey("pkcs8", leafKeys.privateKey);
    return {
      deviceId: this.deviceId,
      privateKeyPem: encodePem("PRIVATE KEY", privateKeyDer),
      certificateChainPem: `${ensureTrailingNewline(certificate.toString("pem"))}${this.rootCertificatePem}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

Object.freeze(DeviceKey.prototype);

export function enrollDeviceIdentity(
  key: DeviceKey,
  metadata: DeviceEnrollmentMetadata,
): DeviceIdentity {
  if (!metadata.displayName.trim()) throw new TypeError("Device display name is required");
  if (!["windows", "macos", "linux", "headless"].includes(metadata.platform)) {
    throw new TypeError("Device platform is invalid");
  }
  const enrolledAt = new Date(metadata.enrolledAt);
  if (!Number.isFinite(enrolledAt.getTime()) || enrolledAt.toISOString() !== metadata.enrolledAt) {
    throw new TypeError("Device enrollment time must be a canonical ISO timestamp");
  }
  return Object.freeze({
    deviceId: key.deviceId,
    publicKey: key.publicKey,
    displayName: metadata.displayName,
    platform: metadata.platform,
    enrolledAt: metadata.enrolledAt,
  });
}

export function validateDeviceTrustRoot(
  identity: DeviceIdentity,
  rootCertificatePem: string,
  now = Date.now(),
): X509Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(rootCertificatePem);
  } catch (error) {
    throw new TypeError("Invalid device root certificate", { cause: error });
  }
  if (!certificate.ca || !certificate.verify(certificate.publicKey)) {
    throw new TypeError("Device trust root must be a self-signed CA certificate");
  }
  assertCertificateCurrent(certificate, now, "Device trust root");
  const publicKey = encodePublicKey(certificate.publicKey);
  if (
    publicKey !== identity.publicKey ||
    deviceIdFromPublicKey(publicKey) !== identity.deviceId ||
    certificate.subject !== rootSubject(identity.deviceId)
  ) {
    throw new MeshProtocolError(
      "identity-mismatch",
      "Device trust root does not match the enrolled identity",
    );
  }
  return certificate;
}

export function deviceIdFromPublicKey(publicKey: string): string {
  const { der } = decodePublicKey(publicKey);
  return `fp:u${createHash("sha256").update(der).digest("base64url")}`;
}

export function verifyDeviceSignature(
  identity: DeviceIdentity,
  schemaId: string,
  version: number,
  payload: unknown,
  signature: Signature,
): void {
  const { publicKey, deviceId } = identity;
  const { alg, keyId, sig } = signature;
  let parsed = decodedIdentityKeys.get(identity);
  if (!parsed || parsed.publicKey !== publicKey) {
    const { der, key } = decodePublicKey(publicKey);
    parsed = { publicKey, key, fingerprint: `fp:u${createHash("sha256").update(der).digest("base64url")}` };
    decodedIdentityKeys.set(identity, parsed);
  }
  if (parsed.fingerprint !== deviceId) {
    throw new MeshProtocolError(
      "identity-mismatch",
      "Device id does not match its public key",
    );
  }
  if (alg !== "ed25519" || keyId !== deviceId) {
    throw new MeshProtocolError(
      "invalid-signature",
      "Signature algorithm or key id does not match the device identity",
    );
  }
  let valid = false;
  try {
    valid = verify(
      null,
      protocolBytes(schemaId, version, payload),
      parsed.key,
      decodeSignature(sig),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new MeshProtocolError("invalid-signature", "Device signature is invalid");
  }
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Device signature is not canonical base64url");
  }
  const signature = Buffer.from(value, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== value) {
    throw new TypeError("Device signature must be a canonical Ed25519 signature");
  }
  return signature;
}

function validateRootCertificate(
  privateKey: KeyObject,
  rootCertificatePem: string,
  now: number,
): X509Certificate {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Device key must use Ed25519");
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(rootCertificatePem);
  } catch (error) {
    throw new TypeError("Invalid device root certificate", { cause: error });
  }
  if (
    !certificate.ca ||
    !certificate.checkPrivateKey(privateKey) ||
    !certificate.verify(certificate.publicKey)
  ) {
    throw new TypeError("Device root certificate is not bound to its private key");
  }
  assertCertificateCurrent(certificate, now, "Device root certificate");
  const deviceId = deviceIdFromPublicKey(encodePublicKey(certificate.publicKey));
  if (certificate.subject !== rootSubject(deviceId)) {
    throw new TypeError("Device root certificate subject does not match its key fingerprint");
  }
  return certificate;
}

function encodePublicKey(publicKey: KeyObject): string {
  return `${PUBLIC_KEY_PREFIX}${publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url")}`;
}

function decodePublicKey(publicKey: string): { der: Buffer; key: KeyObject } {
  if (!publicKey.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new TypeError("Device public key must use the Ed25519 wire encoding");
  }
  const encoded = publicKey.slice(PUBLIC_KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("Device public key is not canonical base64url");
  }
  const der = Buffer.from(encoded, "base64url");
  if (der.toString("base64url") !== encoded) {
    throw new TypeError("Device public key is not canonical base64url");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (error) {
    throw new TypeError("Invalid Ed25519 device public key", { cause: error });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Device public key must use Ed25519");
  }
  return { der, key };
}

function rootSubject(deviceId: string): string {
  return `CN=${deviceId} root`;
}

function leafSubject(deviceId: string): string {
  return `CN=${deviceId} session`;
}

function assertValidity(validityMs: number, label: string): void {
  if (!Number.isSafeInteger(validityMs) || validityMs <= CERTIFICATE_BACKDATE_MS) {
    throw new TypeError(`${label} validity must be a positive safe duration`);
  }
}

function assertTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError(`${label} must be a valid integer timestamp`);
  }
  return value;
}

function expiryFromDuration(issuedAt: number, validityMs: number, label: string): number {
  assertValidity(validityMs, label);
  const expiresAt = issuedAt + validityMs;
  if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime())) {
    throw new TypeError(`${label} expiry is outside the supported date range`);
  }
  return expiresAt;
}

function encodePem(label: string, value: ArrayBuffer): string {
  const base64 = Buffer.from(value).toString("base64");
  const body = base64.match(/.{1,64}/g)?.join("\n");
  if (!body) throw new TypeError(`Cannot encode empty ${label}`);
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function assertCertificateCurrent(
  certificate: X509Certificate,
  now: number,
  label: string,
): void {
  assertTimestamp(now, `${label} validation time`);
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new TypeError(`${label} is not currently valid`);
  }
}
