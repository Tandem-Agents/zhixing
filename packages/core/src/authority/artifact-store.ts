import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dir } from "node:fs";
import {
  open,
  opendir,
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
  durablyRemoveDirectory,
  durablyRemoveFile,
  durablyRemoveFiles,
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/index.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";
import {
  byteDigest,
  createByteDigestAccumulator,
} from "../protocol/index.js";
import { claimDeviceCapacity } from "../resources/index.js";
import { artifactDigestHex, assertArtifactRef } from "./artifact-references.js";
import { AuthorityStorageError } from "./errors.js";
import type {
  ArtifactDeletionResult,
  ArtifactGarbageCollectionResult,
  ArtifactReferenceCursor,
  ArtifactRetentionSnapshot,
  MutableArtifactStore,
  PhysicalStorageStepRunner,
} from "./interfaces.js";

export interface ArtifactGarbageCollectionOptions {
  readonly unreferencedBefore: IsoTime;
  readonly loadRetainedReferences: (
    candidates: readonly ArtifactRef[],
  ) => Promise<readonly ArtifactRef[]>;
}

export const collectArtifactGarbage = Symbol("collectArtifactGarbage");

export interface FileArtifactStoreOptions {
  readonly lockStaleMs?: number;
  readonly lockWaitMs?: number;
}

export class FileArtifactStore implements MutableArtifactStore {
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
    runPhysicalStep: PhysicalStorageStepRunner = (operation) => operation(),
  ): Promise<void> {
    assertArtifactRef(ref);
    return this.#withExclusive(() => runPhysicalStep(async () => {
      const target = this.pathFor(ref);
      if (await exists(target)) {
        await this.#verifyStoredReference(ref);
        return;
      }

      const parent = path.dirname(target);
      await ensureDurableDirectory(parent);
      const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      const digestAccumulator = createByteDigestAccumulator();
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
          digestAccumulator.update(chunk);
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
        const digest = digestAccumulator.digest();
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
    }));
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
      return this.#sweep(options.loadRetainedReferences, cutoff);
    });
  }

  async #assertPresent(references: readonly ArtifactRef[]): Promise<void> {
    for (const ref of deduplicateReferences(references)) {
      await this.#verifyStoredReference(ref);
    }
  }

  async delete(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    return this.#withExclusive(async () => {
      return this.#deleteVerified(ref);
    });
  }

  async discard(
    ref: ArtifactRef,
    runPhysicalStep: PhysicalStorageStepRunner = (operation) => operation(),
  ): Promise<boolean> {
    assertArtifactRef(ref);
    // 先取得排他段,再在真正的 unlink 前执行调用方给的准入包装——顺序不可反:
    // 反过来会先持容量等锁,单槽设备上形成"占着容量等锁、持锁者等容量"。
    return this.#withExclusive(async () =>
      runPhysicalStep(() => durablyRemoveFile(this.pathFor(ref))),
    );
  }

  async list(): Promise<readonly ArtifactRef[]> {
    const references: ArtifactRef[] = [];
    await this.visitReferences((ref) => {
      references.push(ref);
    });
    return references;
  }

  async visitReferences(
    visitor: (ref: ArtifactRef) => void | Promise<void>,
  ): Promise<void> {
    return this.#withExclusive(async () => {
      const algorithmRoot = path.join(this.rootDir, "sha256");
      let prefixes;
      try {
        prefixes = await opendir(algorithmRoot);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return;
        throw error;
      }
      for await (const prefix of prefixes) {
        if (
          !prefix.isDirectory() ||
          !/^[a-f0-9]{2}$/u.test(prefix.name)
        ) {
          continue;
        }
        const directory = path.join(algorithmRoot, prefix.name);
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
          const metadata = await stat(path.join(directory, entry.name));
          await visitor({
            digest: `sha256:${entry.name}`,
            bytes: metadata.size,
          });
        }
      }
    });
  }

  openReferenceCursor(
    runPhysicalStep: PhysicalStorageStepRunner = (operation) => operation(),
  ): ArtifactReferenceCursor {
    return new FileArtifactReferenceCursor(
      path.join(this.rootDir, "sha256"),
      (operation) => this.#withExclusive(operation),
      runPhysicalStep,
    );
  }

  /**
   * Deletes an artifact only while holding the same store lock used by commit
   * admission, after the caller has reloaded every authority's retained set.
   */
  async deleteIfUnreferenced(
    ref: ArtifactRef,
    loadRetainedReferences: (
      candidates: readonly ArtifactRef[],
    ) => Promise<ArtifactRetentionSnapshot>,
  ): Promise<boolean> {
    const [result] = await this.deleteIfUnreferencedBatch(
      [ref],
      loadRetainedReferences,
    );
    return result?.disposition === "deleted";
  }

  /**
   * Classifies and deletes a candidate set under one store lock and one
   * retained-reference snapshot. Callers can distinguish an absent artifact
   * from one protected by a concurrent authority commit.
   */
  async deleteIfUnreferencedBatch(
    refs: readonly ArtifactRef[],
    loadRetainedReferences: (
      candidates: readonly ArtifactRef[],
    ) => Promise<ArtifactRetentionSnapshot>,
    /**
     * 物理删除段的资源治理包装。保留判定要读权威投影、可能自行取得治理容量,
     * 把它包进来会形成嵌套准入,故只包这一段纯 unlink。缺省不治理。
     */
    governDeletion?: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<readonly ArtifactDeletionResult[]> {
    const candidates = deduplicateReferences(refs);
    return this.#withExclusive(async () => {
      const snapshot = await loadRetainedReferences(candidates);
      if (snapshot.status === "deferred") {
        return candidates.map((ref) => ({ ref, disposition: "deferred" }));
      }
      const retained = new Set(
        deduplicateReferences(snapshot.retained).map(
          (reference) => reference.digest,
        ),
      );
      const run = governDeletion ?? (<T>(operation: () => Promise<T>) => operation());
      return run(async () => {
        const results: ArtifactDeletionResult[] = [];
        for (const ref of candidates) {
          if (retained.has(ref.digest)) {
            await this.#verifyStoredReference(ref);
            results.push({ ref, disposition: "retained" });
            continue;
          }
          const removed = await this.#deleteVerified(ref);
          results.push({ ref, disposition: removed ? "deleted" : "missing" });
        }
        return results as readonly ArtifactDeletionResult[];
      });
    });
  }

  /**
   * 在场则先校验内容,随后无条件走耐久删除原语:目标缺失同样要完成目录屏障,
   * 否则重试路径会把"前次 unlink 已生效但未落盘"误当成删除已完成。
   */
  async #deleteVerified(ref: ArtifactRef): Promise<boolean> {
    const target = this.pathFor(ref);
    if (await exists(target)) {
      await this.#verifyStoredReference(ref);
    }
    return durablyRemoveFile(target);
  }

  async #verifyStoredReference(ref: ArtifactRef): Promise<void> {
    assertArtifactRef(ref);
    claimDeviceCapacity("readBytes", ref.bytes);
    claimDeviceCapacity("ioOperations", 1);
    const digestAccumulator = createByteDigestAccumulator();
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(this.pathFor(ref))) {
        bytes += chunk.length;
        digestAccumulator.update(chunk);
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
    if (bytes !== ref.bytes || digestAccumulator.digest() !== ref.digest) {
      throw new AuthorityStorageError(
        "artifact-corrupt",
        `Artifact content does not match its reference: ${ref.digest}`,
      );
    }
  }

  async #readVerified(ref: ArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    claimDeviceCapacity("readBytes", ref.bytes);
    claimDeviceCapacity("ioOperations", 1);
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
    loadRetainedReferences: (
      candidates: readonly ArtifactRef[],
    ) => Promise<readonly ArtifactRef[]>,
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
    // 删除计数是调用方可见的结论,因此每批删除都必须在计入前完成目录屏障。
    const removeCandidates = async (
      candidates: readonly {
        readonly ref: ArtifactRef;
        readonly file: string;
        readonly eligible: boolean;
      }[],
    ): Promise<void> => {
      if (candidates.length === 0) return;
      const retainedReferences = deduplicateReferences(
        await loadRetainedReferences(candidates.map(({ ref }) => ref)),
      );
      const retained = new Set(
        retainedReferences.map((reference) => reference.digest),
      );
      const removals: string[] = [];
      for (const { ref, file, eligible } of candidates) {
        if (retained.has(ref.digest)) {
          await this.#verifyStoredReference(ref);
          kept += 1;
          continue;
        }
        if (!eligible) continue;
        removals.push(file);
      }
      deleted += await durablyRemoveFiles(removals);
    };
    let abandoned: string[] = [];
    const removeAbandoned = async (): Promise<void> => {
      if (abandoned.length === 0) return;
      const batch = abandoned;
      abandoned = [];
      deleted += await durablyRemoveFiles(batch);
    };

    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      const directory = path.join(algorithmRoot, prefix.name);
      const entries = await readdir(directory, { withFileTypes: true });
      let candidates: Array<{
        readonly ref: ArtifactRef;
        readonly file: string;
        readonly eligible: boolean;
      }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const file = path.join(directory, entry.name);
        if (/^[a-f0-9]{64}$/u.test(entry.name)) {
          scanned += 1;
          const metadata = await stat(file);
          candidates.push({
            ref: {
              digest: `sha256:${entry.name}`,
              bytes: metadata.size,
            },
            file,
            eligible: metadata.mtimeMs <= cutoff,
          });
          if (candidates.length === 64) {
            await removeCandidates(candidates);
            candidates = [];
          }
          continue;
        }
        if (!entry.name.includes(".tmp-")) continue;
        const metadata = await stat(file);
        if (metadata.mtimeMs <= cutoff) {
          abandoned.push(file);
          if (abandoned.length === 64) await removeAbandoned();
        }
      }
      await removeCandidates(candidates);
      await removeAbandoned();
      // 空前缀目录的回收不计入删除结论,也没有下游状态依赖它;失败只留空目录,
      // 不得让整次扫描失败。
      await durablyRemoveDirectory(directory).catch(() => undefined);
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

class FileArtifactReferenceCursor implements ArtifactReferenceCursor {
  #prefixes: Dir | undefined;
  #entries: Dir | undefined;
  #done = false;

  constructor(
    private readonly algorithmRoot: string,
    private readonly runExclusive: <T>(
      operation: () => Promise<T>,
    ) => Promise<T>,
    private readonly runPhysicalStep: PhysicalStorageStepRunner,
  ) {}

  async next(limit: number): Promise<{
    readonly references: readonly ArtifactRef[];
    readonly done: boolean;
  }> {
    assertPositiveSafeInteger(limit, "Artifact reference cursor limit");
    if (this.#done) return { references: [], done: true };
    return this.runExclusive(() => this.runPhysicalStep(async () => {
      const references: ArtifactRef[] = [];
      let inspected = 0;
      if (!this.#prefixes) {
        claimDeviceCapacity("ioOperations", 1);
        try {
          this.#prefixes = await opendir(this.algorithmRoot);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          this.#done = true;
          return { references, done: true };
        }
      }
      while (inspected < limit && !this.#done) {
        if (this.#entries) {
          claimDeviceCapacity("ioOperations", 1);
          const entry = await this.#entries.read();
          inspected += 1;
          if (!entry) {
            await this.#entries.close();
            this.#entries = undefined;
            continue;
          }
          if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
            continue;
          }
          const file = path.join(this.#entries.path, entry.name);
          claimDeviceCapacity("ioOperations", 1);
          let metadata;
          try {
            metadata = await stat(file);
          } catch (error) {
            if (isNodeError(error, "ENOENT")) continue;
            throw error;
          }
          references.push({
            digest: `sha256:${entry.name}`,
            bytes: metadata.size,
          });
          continue;
        }
        claimDeviceCapacity("ioOperations", 1);
        const prefix = await this.#prefixes.read();
        inspected += 1;
        if (!prefix) {
          await this.#prefixes.close();
          this.#prefixes = undefined;
          this.#done = true;
          break;
        }
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) {
          continue;
        }
        claimDeviceCapacity("ioOperations", 1);
        try {
          this.#entries = await opendir(
            path.join(this.algorithmRoot, prefix.name),
          );
        } catch (error) {
          if (isNodeError(error, "ENOENT")) continue;
          throw error;
        }
      }
      return { references, done: this.#done };
    }));
  }

  async close(): Promise<void> {
    this.#done = true;
    await this.#entries?.close().catch(() => undefined);
    await this.#prefixes?.close().catch(() => undefined);
    this.#entries = undefined;
    this.#prefixes = undefined;
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
