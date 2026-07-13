import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { MasterKeyProvider } from "./master-key.js";
import { acquireFileLock } from "./file-lock.js";

const VAULT_AAD = Buffer.from("zhixing-secret-vault:v1", "utf8");
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const SECRET_KINDS = new Set<SecretRef["kind"]>([
  "provider",
  "channel",
  "mcp",
  "device-key",
  "webhook",
]);

interface VaultEnvelope {
  v: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface VaultPayload {
  v: 1;
  entries: Record<string, string>;
}

export interface EncryptedVaultSecretStoreOptions {
  readonly vaultPath: string;
  readonly masterKey: MasterKeyProvider;
  readonly now?: () => number;
}

export class EncryptedVaultSecretStore implements SecretStorePort {
  private readonly vaultPath: string;
  private readonly lockPath: string;
  private readonly exclusiveLockPath: string;
  private readonly masterKey: MasterKeyProvider;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: EncryptedVaultSecretStoreOptions) {
    if (!path.isAbsolute(options.vaultPath)) {
      throw new TypeError("Secret vault path must be absolute");
    }
    this.vaultPath = options.vaultPath;
    this.lockPath = `${options.vaultPath}.lock`;
    this.exclusiveLockPath = `${options.vaultPath}.exclusive.lock`;
    this.masterKey = options.masterKey;
    this.now = options.now ?? Date.now;
  }

  async put(ref: SecretRef, value: string): Promise<void> {
    assertSecretRef(ref);
    if (typeof value !== "string") throw new TypeError("Secret value must be a string");
    await this.mutate((payload) => {
      payload.entries[encodeRef(ref)] = value;
    });
  }

  async get(ref: SecretRef): Promise<string | null> {
    assertSecretRef(ref);
    return this.serialized(async () => {
      const key = await this.requireKey();
      try {
        const payload = await this.readPayload(key);
        return payload.entries[encodeRef(ref)] ?? null;
      } finally {
        key.fill(0);
      }
    });
  }

  async delete(ref: SecretRef): Promise<void> {
    assertSecretRef(ref);
    await this.mutate((payload) => {
      delete payload.entries[encodeRef(ref)];
    });
  }

  async list(prefix: string): Promise<SecretRef[]> {
    if (typeof prefix !== "string") throw new TypeError("Secret prefix must be a string");
    return this.serialized(async () => {
      const key = await this.requireKey();
      try {
        const payload = await this.readPayload(key);
        return Object.keys(payload.entries)
          .map(decodeRef)
          .filter((ref) => canonicalRef(ref).startsWith(prefix))
          .sort((left, right) => canonicalRef(left).localeCompare(canonicalRef(right)));
      } finally {
        key.fill(0);
      }
    });
  }

  async unlockState(): Promise<"unlocked" | "locked" | "unavailable"> {
    const state = await this.masterKey.state();
    if (state !== "unlocked") return state;
    return this.serialized(async () => {
      let key: Buffer | undefined;
      try {
        key = await this.masterKey.loadOrCreate();
        if (key.byteLength !== 32) return "unavailable";
        await this.readPayload(key);
        return "unlocked";
      } catch {
        return "unavailable";
      } finally {
        key?.fill(0);
      }
    });
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(this.exclusiveLockPath, {
      staleMs: 120_000,
      waitMs: 30_000,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async mutate(change: (payload: VaultPayload) => void): Promise<void> {
    await this.serialized(async () => {
      const key = await this.requireKey();
      const release = await this.acquireLock();
      try {
        const payload = await this.readPayload(key);
        change(payload);
        await this.writePayload(payload, key);
      } finally {
        key.fill(0);
        await release();
      }
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let releaseQueue!: () => void;
    this.queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      releaseQueue();
    }
  }

  private async requireKey(): Promise<Buffer> {
    const state = await this.masterKey.state();
    if (state !== "unlocked") throw new Error(`SecretStore is ${state}`);
    const key = await this.masterKey.loadOrCreate();
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new Error("SecretStore master key has an invalid length");
    }
    return key;
  }

  private async readPayload(key: Buffer): Promise<VaultPayload> {
    let raw: string;
    try {
      raw = await readFile(this.vaultPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { v: 1, entries: {} };
      throw error;
    }
    let envelope: VaultEnvelope;
    try {
      envelope = JSON.parse(raw) as VaultEnvelope;
      assertEnvelope(envelope);
    } catch (error) {
      throw new Error("Secret vault envelope is invalid", { cause: error });
    }
    try {
      const nonce = decodeFixed(envelope.nonce, 12, "nonce");
      const tag = decodeFixed(envelope.tag, 16, "authentication tag");
      const ciphertext = decodeCanonical(envelope.ciphertext, "ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(VAULT_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        const payload = JSON.parse(plaintext.toString("utf8")) as VaultPayload;
        assertPayload(payload);
        return payload;
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      throw new Error("Secret vault cannot be authenticated or decrypted", { cause: error });
    }
  }

  private async writePayload(payload: VaultPayload, key: Buffer): Promise<void> {
    await mkdir(path.dirname(this.vaultPath), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    let ciphertext: Buffer;
    let tag: Buffer;
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(VAULT_AAD);
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      tag = cipher.getAuthTag();
    } finally {
      plaintext.fill(0);
    }
    const envelope: VaultEnvelope = {
      v: 1,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url"),
    };
    const temporary = `${this.vaultPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.vaultPath);
      await chmod(this.vaultPath, 0o600);
      await syncDirectory(path.dirname(this.vaultPath));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    return acquireFileLock(this.lockPath, {
      staleMs: LOCK_STALE_MS,
      waitMs: LOCK_WAIT_MS,
      now: this.now,
    });
  }
}

function assertSecretRef(ref: SecretRef): void {
  if (!SECRET_KINDS.has(ref.kind) || typeof ref.bindingId !== "string") {
    throw new TypeError("Secret reference is invalid");
  }
  if (
    ref.bindingId.length === 0 ||
    ref.bindingId.length > 512 ||
    ref.bindingId.trim() !== ref.bindingId ||
    /[\u0000-\u001f\u007f]/u.test(ref.bindingId)
  ) {
    throw new TypeError("Secret binding id is invalid");
  }
}

function canonicalRef(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}

function encodeRef(ref: SecretRef): string {
  return `${ref.kind}:${Buffer.from(ref.bindingId, "utf8").toString("base64url")}`;
}

function decodeRef(value: string): SecretRef {
  const separator = value.indexOf(":");
  if (separator <= 0) throw new Error("Secret vault contains an invalid reference");
  const kind = value.slice(0, separator) as SecretRef["kind"];
  const encoded = value.slice(separator + 1);
  const binding = decodeCanonical(encoded, "binding id");
  if (binding.toString("base64url") !== encoded) {
    throw new Error("Secret vault contains a non-canonical reference");
  }
  const ref: SecretRef = { kind, bindingId: binding.toString("utf8") };
  assertSecretRef(ref);
  if (encodeRef(ref) !== value) throw new Error("Secret vault contains an invalid reference");
  return ref;
}

function assertEnvelope(value: VaultEnvelope): void {
  if (
    value?.v !== 1 ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string" ||
    Object.keys(value).some((key) => !["v", "nonce", "ciphertext", "tag"].includes(key))
  ) {
    throw new TypeError("Secret vault envelope schema is invalid");
  }
}

function assertPayload(value: VaultPayload): void {
  if (value?.v !== 1 || !isPlainObject(value.entries)) {
    throw new TypeError("Secret vault payload schema is invalid");
  }
  for (const [key, secret] of Object.entries(value.entries)) {
    decodeRef(key);
    if (typeof secret !== "string") throw new TypeError("Secret vault value is invalid");
  }
}

function decodeCanonical(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError(`Secret vault ${label} is invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError(`Secret vault ${label} is not canonical`);
  }
  return decoded;
}

function decodeFixed(value: string, bytes: number, label: string): Buffer {
  const decoded = decodeCanonical(value, label);
  if (decoded.byteLength !== bytes) throw new TypeError(`Secret vault ${label} has wrong length`);
  return decoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync().catch((error: unknown) => {
      if (process.platform === "win32" && (isNodeError(error, "EPERM") || isNodeError(error, "EINVAL"))) {
        return;
      }
      throw error;
    });
  } finally {
    await directory.close();
  }
}
