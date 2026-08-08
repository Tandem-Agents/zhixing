import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import type { Dir } from "node:fs";
import { open, opendir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  DispatchEnvelope,
  MutationBatch,
  SealedBundle,
  TranscriptRunRecord,
} from "../contracts/index.js";
import {
  canonicalize,
  validateMessages,
  validateMutationBatch,
  validateSealedBundle,
  validateTranscriptRunRecord,
} from "../protocol/index.js";
import {
  durablyRemoveFile,
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/index.js";
import {
  claimDeviceCapacity,
  runHoldingMaintenanceExclusion,
} from "../resources/index.js";
import {
  assertArtifactRef,
  artifactDigestHex,
  collectArtifactRefs,
} from "./artifact-references.js";
import type {
  ArtifactReferenceCursor,
  ArtifactStore,
  PhysicalStorageStepRunner,
} from "./interfaces.js";
import { AuthorityStorageError } from "./errors.js";

export type AssignmentArtifactSchema =
  | "window-input"
  | "transcript-run-record"
  | "mutation-batch"
  | "opaque";

export interface AssignmentArtifactDescriptor {
  readonly ref: ArtifactRef;
  readonly schema: AssignmentArtifactSchema;
}

export interface AssignmentArtifactClosure {
  readonly roots: readonly ArtifactRef[];
  readonly dependencies: readonly ArtifactRef[];
  readonly transfer: readonly ArtifactRef[];
}

export interface ArtifactReceiveProgress {
  readonly receivedBytes: number;
  readonly complete: boolean;
}

export type IdentifiedPhysicalStepRunner = <T>(
  inputIdentity: unknown,
  operation: () => Promise<T>,
) => Promise<T>;

export interface FileResumableArtifactReceiverOptions {
  readonly maxArtifactBytes: number;
  readonly maxChunkBytes?: number;
}

export const DEFAULT_ARTIFACT_CHUNK_BYTES = 256 * 1024;

export async function resolveDispatchArtifactClosure(
  envelope: DispatchEnvelope,
  artifacts: ArtifactStore,
): Promise<AssignmentArtifactClosure> {
  const described = describeDispatchArtifactClosure(envelope);
  return resolveClosure(
    dispatchRootDescriptors(envelope, described.roots),
    described.dependencies,
    artifacts,
  );
}

export function describeDispatchArtifactClosure(
  envelope: DispatchEnvelope,
): AssignmentArtifactClosure {
  const { dependencyArtifacts, ...body } = envelope;
  const roots = normalizedArtifactRefs(collectArtifactRefs(body));
  return describeClosure(roots, dependencyArtifacts);
}

export async function resolveSealedBundleArtifactClosure(
  value: SealedBundle,
  artifacts: ArtifactStore,
): Promise<AssignmentArtifactClosure> {
  const bundle = validatedSealedBundle(value);
  const described = describeSealedBundleArtifactClosure(bundle);
  return resolveClosure(
    sealedBundleRootDescriptors(bundle, described.roots),
    described.dependencies,
    artifacts,
  );
}

export function describeSealedBundleArtifactClosure(
  value: SealedBundle,
): AssignmentArtifactClosure {
  const bundle = validatedSealedBundle(value);
  const { dependencyArtifacts, ...body } = bundle;
  const roots = normalizedArtifactRefs(collectArtifactRefs(body));
  return describeClosure(roots, dependencyArtifacts);
}

function validatedSealedBundle(value: SealedBundle): SealedBundle {
  return validateSealedBundle(value);
}

function dispatchRootDescriptors(
  envelope: DispatchEnvelope,
  roots: readonly ArtifactRef[],
): AssignmentArtifactDescriptor[] {
  return roots.map((ref): AssignmentArtifactDescriptor => ({
    ref,
    schema:
      envelope.execution === "conversation" &&
      envelope.work.windowInput.t === "full" &&
      "ref" in envelope.work.windowInput.messages &&
      envelope.work.windowInput.messages.ref.digest === ref.digest
        ? "window-input"
        : "opaque",
  }));
}

function sealedBundleRootDescriptors(
  bundle: SealedBundle,
  roots: readonly ArtifactRef[],
): AssignmentArtifactDescriptor[] {
  return roots.map((ref): AssignmentArtifactDescriptor => {
    if (
      bundle.body.t === "conversation" &&
      "ref" in bundle.body.runRecord &&
      bundle.body.runRecord.ref.digest === ref.digest
    ) {
      return { ref, schema: "transcript-run-record" };
    }
    if (bundle.body.mutationBatch?.ref.digest === ref.digest) {
      return { ref, schema: "mutation-batch" };
    }
    return { ref, schema: "opaque" };
  });
}

export function normalizedArtifactRefs(
  references: readonly ArtifactRef[],
): ArtifactRef[] {
  const byDigest = new Map<string, ArtifactRef>();
  for (const reference of references) {
    assertArtifactRef(reference);
    const existing = byDigest.get(reference.digest);
    if (existing && existing.bytes !== reference.bytes) {
      throw new TypeError("The same artifact digest cannot declare different byte counts");
    }
    byDigest.set(reference.digest, { ...reference });
  }
  return [...byDigest.values()].sort(compareArtifactRefs);
}

export function assertCanonicalArtifactRefs(
  references: readonly ArtifactRef[],
  label: string,
): void {
  if (!Array.isArray(references)) throw new TypeError(`${label} must be an array`);
  const normalized = normalizedArtifactRefs(references);
  if (
    normalized.length !== references.length ||
    normalized.some(
      (reference, index) =>
        reference.digest !== references[index]?.digest ||
        reference.bytes !== references[index]?.bytes,
    )
  ) {
    throw new TypeError(`${label} must be sorted by digest and bytes without duplicates`);
  }
}

export async function readArtifactRange(
  artifacts: ArtifactStore,
  ref: ArtifactRef,
  offset: number,
  limit: number,
): Promise<{ readonly bytes: Uint8Array; readonly complete: boolean }> {
  assertArtifactRef(ref);
  assertRangeInteger(offset, "Artifact range offset");
  assertRangeInteger(limit, "Artifact range limit", false);
  if (offset > ref.bytes) throw new RangeError("Artifact range starts beyond its byte length");
  const bytes = await artifacts.readRange(ref, offset, limit);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > limit ||
    bytes.byteLength > ref.bytes - offset ||
    (offset < ref.bytes && bytes.byteLength === 0)
  ) {
    throw new TypeError("Artifact store returned an invalid range");
  }
  const end = offset + bytes.byteLength;
  return {
    bytes,
    complete: end === ref.bytes,
  };
}

export function validateArtifactReceiveProgress(
  input: unknown,
  ref: ArtifactRef,
): ArtifactReceiveProgress {
  assertArtifactRef(ref);
  assertPlainRecord(input, "Artifact progress");
  assertExactKeys(input, ["complete", "receivedBytes"], "Artifact progress");
  if (
    typeof input.complete !== "boolean" ||
    typeof input.receivedBytes !== "number" ||
    !Number.isSafeInteger(input.receivedBytes) ||
    input.receivedBytes < 0 ||
    input.receivedBytes > ref.bytes ||
    (input.complete && input.receivedBytes !== ref.bytes)
  ) {
    throw new TypeError("Artifact progress is invalid");
  }
  return {
    complete: input.complete,
    receivedBytes: input.receivedBytes,
  };
}

export function validateArtifactReadResponse(
  bytes: unknown,
  ref: ArtifactRef,
  offset: number,
  limit: number,
): Uint8Array {
  assertArtifactRef(ref);
  assertRangeInteger(offset, "Artifact range offset");
  assertRangeInteger(limit, "Artifact range limit", false);
  if (offset > ref.bytes) {
    throw new RangeError("Artifact range starts beyond its byte length");
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > limit ||
    bytes.byteLength > ref.bytes - offset ||
    (offset < ref.bytes && bytes.byteLength === 0)
  ) {
    throw new TypeError("Artifact range response is invalid");
  }
  return bytes;
}

export class FileResumableArtifactReceiver {
  readonly #maxArtifactBytes: number;
  readonly #maxChunkBytes: number;
  readonly #operations = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ArtifactStore,
    private readonly rootDir: string,
    options: FileResumableArtifactReceiverOptions,
  ) {
    this.#maxArtifactBytes = options.maxArtifactBytes;
    this.#maxChunkBytes =
      options.maxChunkBytes ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
    assertRangeInteger(this.#maxArtifactBytes, "Maximum artifact bytes");
    assertRangeInteger(this.#maxChunkBytes, "Maximum artifact chunk bytes", false);
  }

  async progress(
    ref: ArtifactRef,
    runPhysicalStep: IdentifiedPhysicalStepRunner = (_identity, operation) =>
      operation(),
  ): Promise<ArtifactReceiveProgress> {
    this.#assertAcceptable(ref);
    return this.#serial(ref.digest, async () => {
      const progress = await runPhysicalStep(
        { step: "temporary-progress-probe", digest: ref.digest, bytes: ref.bytes },
        async () => {
          if (await this.store.has(ref)) {
            return { receivedBytes: ref.bytes, complete: true };
          }
          const receivedBytes = await this.#partialSize(ref);
          return { receivedBytes, complete: false };
        },
      );
      if (
        !progress.complete &&
        ref.bytes > 0 &&
        progress.receivedBytes === ref.bytes
      ) {
        return this.#finalizePartial(ref, runPhysicalStep);
      }
      return progress;
    });
  }

  async append(
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
    runPhysicalStep: IdentifiedPhysicalStepRunner = (_identity, operation) =>
      operation(),
  ): Promise<ArtifactReceiveProgress> {
    this.#assertAcceptable(ref);
    assertRangeInteger(offset, "Artifact chunk offset");
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Artifact chunk must be bytes");
    }
    if (bytes.byteLength > this.#maxChunkBytes) {
      throw new RangeError("Artifact chunk exceeds the configured byte limit");
    }
    if (bytes.byteLength === 0 && offset !== ref.bytes) {
      throw new RangeError("An empty artifact chunk may only finalize a complete prefix");
    }
    return this.#serial(ref.digest, async () => runPhysicalStep(
      {
        step: "temporary-append",
        digest: ref.digest,
        bytes: bytes.byteLength,
      },
      async () => {
      if (await this.store.has(ref)) {
        return { receivedBytes: ref.bytes, complete: true };
      }
      await ensureDurableDirectory(this.rootDir);
      const partialPath = this.#partialPath(ref);
      const current = await this.#partialSize(ref);
      if (offset < current) {
        if (offset + bytes.byteLength > current) {
          throw new RangeError("Artifact chunk overlaps the durable prefix");
        }
        const durable = await readFileRange(partialPath, offset, bytes.byteLength);
        if (!Buffer.from(durable).equals(bytes)) {
          throw new TypeError("Replayed artifact chunk differs from the durable prefix");
        }
        return current === ref.bytes
          ? this.#finalizePartial(ref)
          : { receivedBytes: current, complete: false };
      }
      if (offset !== current) {
        throw new RangeError("Artifact chunk does not continue the durable prefix");
      }
      if (current + bytes.byteLength > ref.bytes) {
        throw new RangeError("Artifact chunk exceeds the declared byte length");
      }
      const handle = await open(partialPath, "a+");
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            null,
          );
          if (result.bytesWritten === 0) {
            throw new TypeError("Artifact chunk write made no progress");
          }
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (current === 0) await syncDirectory(this.rootDir);
      const receivedBytes = current + bytes.byteLength;
      if (receivedBytes !== ref.bytes) {
        return { receivedBytes, complete: false };
      }
      return this.#finalizePartial(ref);
      },
    ));
  }

  async discardPartialsBefore(cutoff: Date): Promise<number> {
    const cutoffMs = cutoff.getTime();
    if (!Number.isFinite(cutoffMs)) throw new TypeError("Artifact partial cutoff is invalid");
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.([0-9]+)\.part$/u.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const digest = match[1]!;
      await this.#serial(digest, async () => {
        const partialPath = path.join(this.rootDir, entry.name);
        let metadata;
        try {
          metadata = await stat(partialPath);
        } catch (error) {
          if (isMissingFile(error)) return;
          throw error;
        }
        if (metadata.mtimeMs >= cutoffMs) return;
        if (await this.#removePartial(partialPath)) removed += 1;
      });
    }
    return removed;
  }

  async partialReferences(): Promise<readonly ArtifactRef[]> {
    const references: ArtifactRef[] = [];
    await this.visitPartialReferences((ref) => {
      references.push(ref);
    });
    return references;
  }

  async visitPartialReferences(
    visitor: (ref: ArtifactRef) => void | Promise<void>,
  ): Promise<void> {
    let entries;
    try {
      entries = await opendir(this.rootDir);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    for await (const entry of entries) {
      const match = /^([a-f0-9]{64})\.([0-9]+)\.part$/u.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const bytes = Number(match[2]);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new AuthorityStorageError(
          "artifact-corrupt",
          "Artifact partial declares an invalid byte count",
        );
      }
      const size = (await stat(path.join(this.rootDir, entry.name))).size;
      if (size > bytes) {
        throw new AuthorityStorageError(
          "artifact-corrupt",
          "Artifact partial exceeds its declared byte count",
        );
      }
      await visitor({
        digest: `sha256:${match[1]}`,
        bytes,
      });
    }
  }

  openPartialReferenceCursor(
    runPhysicalStep: PhysicalStorageStepRunner = (operation) => operation(),
  ): ArtifactReferenceCursor {
    return new FilePartialReferenceCursor(this.rootDir, runPhysicalStep);
  }

  async discard(
    ref: ArtifactRef,
    runPhysicalStep: PhysicalStorageStepRunner = (operation) => operation(),
  ): Promise<boolean> {
    this.#assertAcceptable(ref);
    // 先取得按 digest 的串行权,再在真正的 unlink 前执行调用方给的准入包装——
    // 顺序不可反:反过来会先持容量等串行段,单槽设备上形成自锁。
    return this.#serial(ref.digest, async () =>
      runPhysicalStep(() => this.#removePartial(this.#partialPath(ref))),
    );
  }

  #assertAcceptable(ref: ArtifactRef): void {
    assertArtifactRef(ref);
    if (ref.bytes > this.#maxArtifactBytes) {
      throw new RangeError("Artifact exceeds the configured byte limit");
    }
  }

  async #partialSize(ref: ArtifactRef): Promise<number> {
    try {
      const size = (await stat(this.#partialPath(ref))).size;
      if (!Number.isSafeInteger(size) || size < 0 || size > ref.bytes) {
        throw new TypeError("Durable artifact prefix has an invalid byte length");
      }
      return size;
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
  }

  #partialPath(ref: ArtifactRef): string {
    return path.join(this.rootDir, `${artifactDigestHex(ref)}.${ref.bytes}.part`);
  }

  async #finalizePartial(
    ref: ArtifactRef,
    runPhysicalStep: IdentifiedPhysicalStepRunner = (_identity, operation) =>
      operation(),
  ): Promise<ArtifactReceiveProgress> {
    const partialPath = this.#partialPath(ref);
    try {
      await this.store.putVerifiedStream(
        ref,
        readFileChunks(partialPath),
        (operation) =>
          runPhysicalStep(
            { step: "temporary-finalize", digest: ref.digest, bytes: ref.bytes },
            operation,
          ),
      );
    } catch (error) {
      if (
        error instanceof AuthorityStorageError &&
        error.code === "artifact-corrupt"
      ) {
        await runPhysicalStep(
          { step: "temporary-remove-corrupt-partial", digest: ref.digest },
          () => this.#removePartial(partialPath),
        );
      }
      throw error;
    }
    await runPhysicalStep(
      { step: "temporary-remove-finalized-partial", digest: ref.digest },
      () => this.#removePartial(partialPath),
    );
    return { receivedBytes: ref.bytes, complete: true };
  }

  async #removePartial(partialPath: string): Promise<boolean> {
    return durablyRemoveFile(partialPath);
  }

  async #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#operations.set(key, queued);
    await previous;
    try {
      // 按 digest 的串行段同样是互斥区:段内的容量准入必须零等待,谓词由建立
      // 互斥的原语单点给出,不依赖调用方恰好已在别的互斥区里。
      return await runHoldingMaintenanceExclusion(operation);
    } finally {
      release();
      if (this.#operations.get(key) === queued) this.#operations.delete(key);
    }
  }
}

class FilePartialReferenceCursor implements ArtifactReferenceCursor {
  #entries: Dir | undefined;
  #done = false;

  constructor(
    private readonly rootDir: string,
    private readonly runPhysicalStep: PhysicalStorageStepRunner,
  ) {}

  async next(limit: number): Promise<{
    readonly references: readonly ArtifactRef[];
    readonly done: boolean;
  }> {
    assertRangeInteger(limit, "Partial reference cursor limit", false);
    if (this.#done) return { references: [], done: true };
    return this.runPhysicalStep(async () => {
      const references: ArtifactRef[] = [];
      if (!this.#entries) {
        claimDeviceCapacity("ioOperations", 1);
        try {
          this.#entries = await opendir(this.rootDir);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          this.#done = true;
          return { references, done: true };
        }
      }
      let inspected = 0;
      while (inspected < limit) {
        claimDeviceCapacity("ioOperations", 1);
        const entry = await this.#entries.read();
        inspected += 1;
        if (!entry) {
          await this.#entries.close();
          this.#entries = undefined;
          this.#done = true;
          break;
        }
        const match = /^([a-f0-9]{64})\.([0-9]+)\.part$/u.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        const bytes = Number(match[2]);
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          throw new AuthorityStorageError(
            "artifact-corrupt",
            "Artifact partial declares an invalid byte count",
          );
        }
        claimDeviceCapacity("ioOperations", 1);
        let metadata;
        try {
          metadata = await stat(path.join(this.rootDir, entry.name));
        } catch (error) {
          if (isMissingFile(error)) continue;
          throw error;
        }
        if (metadata.size > bytes) {
          throw new AuthorityStorageError(
            "artifact-corrupt",
            "Artifact partial exceeds its declared byte count",
          );
        }
        references.push({
          digest: `sha256:${match[1]}`,
          bytes,
        });
      }
      return { references, done: this.#done };
    });
  }

  async close(): Promise<void> {
    this.#done = true;
    await this.#entries?.close().catch(() => undefined);
    this.#entries = undefined;
  }
}

async function* readFileChunks(filePath: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(filePath)) {
    yield chunk as Uint8Array;
  }
}

async function readFileRange(
  file: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, offset + read);
      if (result.bytesRead === 0) {
        throw new TypeError("Durable artifact prefix ended before the replayed range");
      }
      read += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function resolveClosure(
  roots: readonly AssignmentArtifactDescriptor[],
  declaredDependencies: readonly ArtifactRef[],
  artifacts: ArtifactStore,
): Promise<AssignmentArtifactClosure> {
  assertCanonicalArtifactRefs(declaredDependencies, "Assignment artifact dependencies");
  const normalizedRoots = normalizedArtifactRefs(roots.map(({ ref }) => ref));
  const rootDigests = new Set(normalizedRoots.map(({ digest }) => digest));
  const dependencies: ArtifactRef[] = [];
  for (const descriptor of roots) {
    if (descriptor.schema === "opaque") {
      await assertArtifactPresent(artifacts, descriptor.ref);
      continue;
    }
    const bytes = await artifacts.get(descriptor.ref);
    dependencies.push(...extractRegisteredDependencies(descriptor, bytes));
  }
  const expectedDependencies = normalizedArtifactRefs([
    ...normalizedRoots,
    ...dependencies,
  ]).filter(({ digest }) => !rootDigests.has(digest));
  if (
    expectedDependencies.length !== declaredDependencies.length ||
    expectedDependencies.some(
      (reference, index) =>
        reference.digest !== declaredDependencies[index]?.digest ||
        reference.bytes !== declaredDependencies[index]?.bytes,
    )
  ) {
    throw new TypeError("Assignment artifact dependency closure is not exact");
  }
  for (const dependency of declaredDependencies) {
    await assertArtifactPresent(artifacts, dependency);
  }
  return {
    roots: normalizedRoots,
    dependencies: declaredDependencies.map((reference) => ({ ...reference })),
    transfer: normalizedArtifactRefs([...normalizedRoots, ...declaredDependencies]),
  };
}

async function assertArtifactPresent(
  artifacts: ArtifactStore,
  ref: ArtifactRef,
): Promise<void> {
  if (!(await artifacts.has(ref))) {
    throw new AuthorityStorageError(
      "artifact-missing",
      `Assignment artifact is not present: ${ref.digest}`,
    );
  }
}

function describeClosure(
  roots: readonly ArtifactRef[],
  declaredDependencies: readonly ArtifactRef[],
): AssignmentArtifactClosure {
  assertCanonicalArtifactRefs(declaredDependencies, "Assignment artifact dependencies");
  const normalizedRoots = normalizedArtifactRefs(roots);
  const rootDigests = new Set(normalizedRoots.map(({ digest }) => digest));
  if (declaredDependencies.some(({ digest }) => rootDigests.has(digest))) {
    throw new TypeError("Assignment artifact cannot appear in both root and dependency layers");
  }
  return {
    roots: normalizedRoots,
    dependencies: declaredDependencies.map((reference) => ({ ...reference })),
    transfer: normalizedArtifactRefs([...normalizedRoots, ...declaredDependencies]),
  };
}

function extractRegisteredDependencies(
  descriptor: AssignmentArtifactDescriptor,
  bytes: Uint8Array,
): ArtifactRef[] {
  if (descriptor.schema === "opaque") return [];
  const value = parseCanonicalArtifact(bytes);
  if (descriptor.schema === "window-input") {
    validateMessages(value);
    return collectArtifactRefs(value);
  }
  if (descriptor.schema === "transcript-run-record") {
    return collectArtifactRefs(validateTranscriptRunRecord(value as TranscriptRunRecord));
  }
  return collectArtifactRefs(validateMutationBatch(value as MutationBatch));
}

function parseCanonicalArtifact(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError("Registered assignment artifact must contain JSON", { cause: error });
  }
  if (canonicalize(value) !== text) {
    throw new TypeError("Registered assignment artifact must use canonical JSON bytes");
  }
  return value;
}

function compareArtifactRefs(left: ArtifactRef, right: ArtifactRef): number {
  const digest = left.digest.localeCompare(right.digest);
  return digest === 0 ? left.bytes - right.bytes : digest;
}

function assertRangeInteger(value: number, label: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${label} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
}

function assertPlainRecord(
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
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...expected].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
