import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef, IsoTime } from "../contracts/index.js";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/index.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";
import { byteDigest } from "../protocol/index.js";
import { artifactDigestHex, assertArtifactRef } from "./artifact-references.js";
import { AuthorityStorageError } from "./errors.js";
import type {
  ArtifactGarbageCollectionResult,
  ArtifactStore,
} from "./interfaces.js";

export interface ArtifactGarbageCollectionOptions {
  readonly unreferencedBefore: IsoTime;
  readonly loadRetainedReferences: () => Promise<readonly ArtifactRef[]>;
}

export const collectArtifactGarbage = Symbol("collectArtifactGarbage");

export interface FileArtifactStoreOptions {
  readonly lockStaleMs?: number;
  readonly lockWaitMs?: number;
}

export class FileArtifactStore implements ArtifactStore {
  readonly rootDir: string;
  readonly #lockPath: string;
  readonly #lockStaleMs: number;
  readonly #lockWaitMs: number;
  readonly #operations = new SerialTaskQueue();

  constructor(rootDir: string, options: FileArtifactStoreOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.#lockPath = path.join(this.rootDir, ".artifact-store.lock");
    this.#lockStaleMs = options.lockStaleMs ?? 30_000;
    this.#lockWaitMs = options.lockWaitMs ?? 10_000;
  }

  async put(bytes: Uint8Array): Promise<ArtifactRef> {
    const snapshot = Buffer.from(bytes);
    const ref = { digest: byteDigest(snapshot), bytes: snapshot.byteLength };
    return this.#withExclusive(async () => {
      const target = this.pathFor(ref);
      if (await exists(target)) {
        await this.#verifyStoredReference(ref);
        return ref;
      }

      const parent = path.dirname(target);
      await ensureDurableDirectory(parent);
      const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(snapshot);
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          await rename(temporary, target);
        } catch (error) {
          if (!(await exists(target))) throw error;
          await this.#verifyStoredReference(ref);
          await rm(temporary, { force: true });
        }
        await syncDirectory(parent);
        await this.#verifyStoredReference(ref);
        return ref;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    return this.#readVerified(ref);
  }

  async putVerifiedStream(
    ref: ArtifactRef,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    assertArtifactRef(ref);
    return this.#withExclusive(async () => {
      const target = this.pathFor(ref);
      if (await exists(target)) {
        await this.#verifyStoredReference(ref);
        return;
      }

      const parent = path.dirname(target);
      await ensureDurableDirectory(parent);
      const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      const hash = createHash("sha256");
      let receivedBytes = 0;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        for await (const chunk of chunks) {
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("Artifact stream chunks must be bytes");
          }
          receivedBytes += chunk.byteLength;
          if (receivedBytes > ref.bytes) {
            throw new AuthorityStorageError(
              "artifact-corrupt",
              "Artifact stream exceeds its declared byte length",
            );
          }
          hash.update(chunk);
          let written = 0;
          while (written < chunk.byteLength) {
            const result = await handle.write(
              chunk,
              written,
              chunk.byteLength - written,
              null,
            );
            if (result.bytesWritten === 0) {
              throw new Error("Artifact stream write made no progress");
            }
            written += result.bytesWritten;
          }
        }
        const digest = `sha256:${hash.digest("hex")}`;
        if (receivedBytes !== ref.bytes || digest !== ref.digest) {
          throw new AuthorityStorageError(
            "artifact-corrupt",
            "Artifact stream does not match its declared reference",
          );
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          await rename(temporary, target);
        } catch (error) {
          if (!(await exists(target))) throw error;
          await this.#verifyStoredReference(ref);
          await rm(temporary, { force: true });
        }
        await syncDirectory(parent);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }

  async readRange(ref: ArtifactRef, offset: number, limit: number): Promise<Uint8Array> {
    assertArtifactRef(ref);
    assertNonNegativeSafeInteger(offset, "Artifact range offset");
    assertPositiveSafeInteger(limit, "Artifact range limit");
    if (offset > ref.bytes) {
      throw new RangeError("Artifact range starts beyond its byte length");
    }
    let handle;
    try {
      handle = await open(this.pathFor(ref), "r");
      const metadata = await handle.stat();
      if (metadata.size !== ref.bytes) {
        throw new AuthorityStorageError(
          "artifact-corrupt",
          `Artifact content does not match its reference: ${ref.digest}`,
        );
      }
      const length = Math.min(limit, ref.bytes - offset);
      const bytes = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(bytes, read, length - read, offset + read);
        if (result.bytesRead === 0) {
          throw new AuthorityStorageError(
            "artifact-corrupt",
            `Artifact content does not match its reference: ${ref.digest}`,
          );
        }
        read += result.bytesRead;
      }
      return bytes;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new AuthorityStorageError(
          "artifact-missing",
          `Artifact is not present: ${ref.digest}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    try {
      await this.#verifyStoredReference(ref);
      return true;
    } catch (error) {
      if (error instanceof AuthorityStorageError && error.code === "artifact-missing") {
        return false;
      }
      throw error;
    }
  }

  pathFor(ref: ArtifactRef): string {
    const hex = artifactDigestHex(ref);
    return path.join(this.rootDir, "sha256", hex.slice(0, 2), hex);
  }

  async withPresentReferences<T>(
    references: readonly ArtifactRef[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#withExclusive(async () => {
      await this.#assertPresent(references);
      return operation();
    });
  }

  async [collectArtifactGarbage](
    options: ArtifactGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult> {
    const cutoff = parseCanonicalTime(options.unreferencedBefore);
    return this.#withExclusive(async () => {
      const retainedReferences = deduplicateReferences(
        await options.loadRetainedReferences(),
      );
      await this.#assertPresent(retainedReferences);
      const retained = new Set(retainedReferences.map((ref) => ref.digest));
      return this.#sweep(retained, cutoff);
    });
  }

  async #assertPresent(references: readonly ArtifactRef[]): Promise<void> {
    for (const ref of deduplicateReferences(references)) {
      await this.#verifyStoredReference(ref);
    }
  }

  async #verifyStoredReference(ref: ArtifactRef): Promise<void> {
    assertArtifactRef(ref);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(this.pathFor(ref))) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new AuthorityStorageError(
          "artifact-missing",
          `Artifact is not present: ${ref.digest}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (bytes !== ref.bytes || `sha256:${hash.digest("hex")}` !== ref.digest) {
      throw new AuthorityStorageError(
        "artifact-corrupt",
        `Artifact content does not match its reference: ${ref.digest}`,
      );
    }
  }

  async #readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(ref));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new AuthorityStorageError(
          "artifact-missing",
          `Artifact is not present: ${ref.digest}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (bytes.byteLength !== ref.bytes || byteDigest(bytes) !== ref.digest) {
      throw new AuthorityStorageError(
        "artifact-corrupt",
        `Artifact content does not match its reference: ${ref.digest}`,
      );
    }
    return bytes;
  }

  async #sweep(
    retained: ReadonlySet<string>,
    cutoff: number,
  ): Promise<ArtifactGarbageCollectionResult> {
    const algorithmRoot = path.join(this.rootDir, "sha256");
    const prefixes = await readdir(algorithmRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      },
    );
    let scanned = 0;
    let kept = 0;
    let deleted = 0;

    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      const directory = path.join(algorithmRoot, prefix.name);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const file = path.join(directory, entry.name);
        const digest = /^[a-f0-9]{64}$/u.test(entry.name)
          ? `sha256:${entry.name}`
          : null;
        if (digest) {
          scanned += 1;
          if (retained.has(digest)) {
            kept += 1;
            continue;
          }
        } else if (!entry.name.includes(".tmp-")) {
          continue;
        }
        const metadata = await stat(file);
        if (metadata.mtimeMs > cutoff) continue;
        await rm(file, { force: true });
        deleted += 1;
      }
      await rm(directory, { recursive: false }).catch(() => undefined);
    }
    return { scanned, retained: kept, deleted };
  }

  async #withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.run(async () => {
      await ensureDurableDirectory(this.rootDir);
      const release = await acquireFileLock(this.#lockPath, {
        staleMs: this.#lockStaleMs,
        waitMs: this.#lockWaitMs,
        resourceName: "ArtifactStore",
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }
}

function deduplicateReferences(references: readonly ArtifactRef[]): ArtifactRef[] {
  const byDigest = new Map<string, ArtifactRef>();
  for (const ref of references) {
    assertArtifactRef(ref);
    const current = byDigest.get(ref.digest);
    if (current && current.bytes !== ref.bytes) {
      throw new TypeError("The same artifact digest cannot declare different byte counts");
    }
    byDigest.set(ref.digest, ref);
  }
  return [...byDigest.values()];
}

function parseCanonicalTime(value: IsoTime): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError("Artifact GC cutoff must be a canonical ISO timestamp");
  }
  return timestamp;
}

async function exists(file: string): Promise<boolean> {
  return stat(file)
    .then(() => true)
    .catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}
