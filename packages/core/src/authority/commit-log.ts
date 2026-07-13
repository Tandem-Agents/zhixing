import { randomBytes } from "node:crypto";
import {
  open,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  CommitEnvelope,
  IsoTime,
  JsonValue,
  LogicalRecord,
} from "../contracts/index.js";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/index.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import { collectArtifactRefs } from "./artifact-references.js";
import {
  collectRegisteredArtifactReferences,
  collectRegisteredArtifactRoots,
  type RegisteredArtifactRoot,
} from "./artifact-retention.js";
import {
  collectArtifactGarbage,
  FileArtifactStore,
} from "./artifact-store.js";
import { AuthorityStorageError } from "./errors.js";
import type {
  ArtifactGarbageCollectionResult,
  AuthorityCommitLog,
  AuthorityGarbageCollectionOptions,
  ProjectionReplayOptions,
  ProjectionReducer,
  ProjectionCursor,
  ProjectionTransactionDecision,
  ProjectionTransactionOptions,
  ProjectionTransactionResult,
  ProjectionTransactionReducer,
} from "./interfaces.js";
import {
  type AuthorityWalReader,
  encodeAuthorityWalFrame,
  scanAuthorityWalFrames,
} from "./wal-frame.js";

export const MAX_INLINE_LOGICAL_RECORD_BYTES = 32 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STREAM_PATTERN = /^(?:control|publish|governor|final-outbox|trust|exposure|delivery|pairing|checkpoint|(?:run|job|transfer|intent|assignment):[^\u0000-\u001f\u007f]{1,480})$/u;
const EMPTY_PROJECTION_PREFIX_DIGEST = protocolDigest("AuthorityProjectionPrefix", 1, {});

export interface FileAuthorityCommitLogOptions {
  readonly clock?: () => IsoTime;
  readonly lockStaleMs?: number;
  readonly lockWaitMs?: number;
}

interface VerifiedLogTail {
  readonly device: number;
  readonly inode: number;
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly changedAt: number;
  readonly lastLsn: number;
  readonly prefixDigest: string;
}

interface ScannedLog {
  readonly lastLsn: number;
  readonly validBytes: number;
  readonly prefixDigest: string;
  readonly incompleteTail?: Buffer;
}

class FileProjectionCursor implements ProjectionCursor {
  constructor(
    readonly lsn: number,
    readonly logPath: string,
    readonly device: number | undefined,
    readonly inode: number | undefined,
    readonly byteOffset: number,
    readonly modifiedAt: number | undefined,
    readonly changedAt: number | undefined,
    readonly prefixDigest: string,
  ) {}
}

export class FileAuthorityCommitLog implements AuthorityCommitLog {
  readonly rootDir: string;
  readonly logPath: string;
  readonly quarantineDir: string;
  readonly artifactStore: FileArtifactStore;
  readonly #lockPath: string;
  readonly #clock: () => IsoTime;
  readonly #lockStaleMs: number;
  readonly #lockWaitMs: number;
  readonly #operations = new SerialTaskQueue();
  #verifiedTail: VerifiedLogTail | undefined;

  constructor(
    rootDir: string,
    artifactStore: FileArtifactStore,
    options: FileAuthorityCommitLogOptions = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.logPath = path.join(this.rootDir, "authority.log");
    this.quarantineDir = path.join(this.rootDir, "bad-tail");
    this.artifactStore = artifactStore;
    this.#lockPath = path.join(this.rootDir, ".commit-log.lock");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#lockStaleMs = options.lockStaleMs ?? 30_000;
    this.#lockWaitMs = options.lockWaitMs ?? 10_000;
  }

  async append<Body>(
    entries: readonly LogicalRecord<Body>[],
  ): Promise<CommitEnvelope<Body>> {
    if (entries.length === 0) {
      throw new TypeError("A commit envelope must contain at least one logical record");
    }
    const normalizedEntries = normalizeEntries(entries);
    const references = collectArtifactRefs(normalizedEntries);
    const appendOperation = () => this.#withLogLock(() => this.#append(normalizedEntries));
    return references.length === 0
      ? appendOperation()
      : this.artifactStore.withPresentReferences(references, appendOperation);
  }

  async readAll<Body = JsonValue>(): Promise<Array<CommitEnvelope<Body>>> {
    return this.#withLogLock(async () => {
      const envelopes: Array<CommitEnvelope<JsonValue>> = [];
      await this.#readAndRecover((envelope) => envelopes.push(envelope));
      return envelopes as Array<CommitEnvelope<Body>>;
    });
  }

  async readStream<Body = JsonValue>(
    stream: string,
  ): Promise<Array<{ lsn: number; at: IsoTime; body: Body }>> {
    assertStream(stream);
    return this.#withLogLock(async () => {
      const records: Array<{ lsn: number; at: IsoTime; body: Body }> = [];
      await this.#readAndRecover((envelope) => {
        for (const entry of envelope.entries) {
          if (entry.stream === stream) {
            records.push({
              lsn: envelope.lsn,
              at: envelope.at,
              body: entry.body as Body,
            });
          }
        }
      });
      return records;
    });
  }

  async rebuildProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options: ProjectionReplayOptions = {},
  ): Promise<State> {
    const { stream } = options;
    const afterLsn = options.afterLsn ?? 0;
    if (stream !== undefined) assertStream(stream);
    assertReplayLsn(afterLsn);
    return this.#withLogLock(async () => {
      const lastLsn = await this.#readAndRecover();
      if (afterLsn > lastLsn) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          `Projection cursor ${afterLsn} is ahead of commit log LSN ${lastLsn}`,
        );
      }
      if (afterLsn === lastLsn) return initial;

      let state = initial;
      await this.#scanLog((envelope) => {
        if (envelope.lsn <= afterLsn) return;
        for (const record of envelope.entries) {
          if (stream === undefined || record.stream === stream) {
            state = reducer(
              state,
              record as LogicalRecord<Body>,
              envelope as CommitEnvelope<Body>,
            );
          }
        }
      });
      return state;
    });
  }

  async transactProjection<State, Body = JsonValue, Value = void>(
    initial: State,
    reducer: ProjectionTransactionReducer<State, Body>,
    decide: (
      state: State,
      context: { readonly lastLsn: number; readonly nextLsn: number },
    ) => ProjectionTransactionDecision<Body, Value>,
    options: ProjectionTransactionOptions = {},
  ): Promise<ProjectionTransactionResult<State, Body, Value>> {
    const { stream } = options;
    if (
      options.cursor !== undefined &&
      options.afterLsn !== undefined &&
      options.cursor.lsn !== options.afterLsn
    ) {
      throw new TypeError("Projection cursor and afterLsn must identify the same prefix");
    }
    const afterLsn = options.cursor?.lsn ?? options.afterLsn ?? 0;
    if (stream !== undefined) assertStream(stream);
    assertReplayLsn(afterLsn);

    const candidateReferences = collectArtifactRefs(
      options.candidateReferences ?? [],
    );
    const candidateDigests = new Map(
      candidateReferences.map((reference) => [reference.digest, reference.bytes]),
    );
    const operation = () =>
      this.#withLogLock(async () => {
        const replay: Array<{
          record: LogicalRecord<Body>;
          envelope: CommitEnvelope<Body>;
        }> = [];
        const replayTail = await this.#readProjectionTail(
          options.cursor,
          afterLsn,
          (rawEnvelope) => {
          const envelope = rawEnvelope as unknown as CommitEnvelope<Body>;
          for (const record of envelope.entries) {
            if (stream === undefined || record.stream === stream) {
              replay.push({ record, envelope });
            }
          }
          },
        );
        const { lastLsn } = replayTail;
        if (afterLsn > lastLsn) {
          throw new AuthorityStorageError(
            "commit-log-corrupt",
            `Projection cursor ${afterLsn} is ahead of commit log LSN ${lastLsn}`,
          );
        }

        let state = initial;
        for (const item of replay) {
          state = await reducer(state, item.record, item.envelope);
        }
        const decision = decide(state, {
          lastLsn,
          nextLsn: lastLsn + 1,
        });
        if (decision.kind === "return") {
          return {
            value: decision.value,
            state,
            lastLsn,
            cursor: replayTail.cursor,
          };
        }

        const entries = normalizeEntries(decision.entries);
        assertTransactionReferencesProtected(
          collectArtifactRefs(entries),
          candidateDigests,
        );
        const commit = await this.#append(entries);
        for (const record of commit.entries) {
          if (stream === undefined || record.stream === stream) {
            state = await reducer(state, record, commit);
          }
        }
        return {
          value: decision.value,
          state,
          lastLsn: commit.lsn,
          cursor: this.#projectionCursor(commit.lsn),
          commit,
        };
      });

    return candidateReferences.length === 0
      ? operation()
      : this.artifactStore.withPresentReferences(candidateReferences, operation);
  }

  async collectGarbage(
    options: AuthorityGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult> {
    return this.artifactStore[collectArtifactGarbage]({
      unreferencedBefore: options.unreferencedBefore,
      loadRetainedReferences: async () => {
        return this.#withLogLock(async () => {
          const references = new Map<string, ArtifactRef>();
          const registeredRoots: RegisteredArtifactRoot[] = [];
          await this.#readAndRecover((envelope) => {
            for (const ref of collectArtifactRefs(envelope.entries)) {
              retainReference(references, ref);
            }
            registeredRoots.push(...collectRegisteredArtifactRoots(envelope.entries));
          });
          for (const root of registeredRoots) {
            const bytes = await this.artifactStore.get(root.ref);
            for (const ref of collectRegisteredArtifactReferences(root, bytes)) {
              retainReference(references, ref);
            }
          }
          return [...references.values()];
        });
      },
    });
  }

  async #append<Body>(
    entries: Array<LogicalRecord<Body>>,
  ): Promise<CommitEnvelope<Body>> {
    const previousLsn = await this.#loadLastLsn();
    const lsn = previousLsn + 1;
    if (!Number.isSafeInteger(lsn)) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Commit log LSN exhausted the safe integer range",
      );
    }
    const at = this.#clock();
    assertCanonicalTime(at);
    const payload = { v: 1 as const, lsn, at, entries };
    const envelope: CommitEnvelope<Body> = {
      ...payload,
      envelopeDigest: protocolDigest("CommitEnvelope", 1, payload),
    };
    const previousPrefixDigest =
      previousLsn === 0
        ? EMPTY_PROJECTION_PREFIX_DIGEST
        : this.#requireVerifiedPrefix(previousLsn);
    const prefixDigest = advanceProjectionPrefix(previousPrefixDigest, envelope);
    const bytes = Buffer.from(canonicalize(envelope), "utf8");
    const frame = encodeAuthorityWalFrame(bytes);

    await ensureDurableDirectory(this.rootDir);
    const existed = await fileExists(this.logPath);
    const handle = await open(this.logPath, "a", 0o600);
    try {
      await handle.writeFile(frame);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!existed) await syncDirectory(this.rootDir);
    await this.#recordVerifiedTail(lsn, prefixDigest);
    return envelope;
  }

  async #loadLastLsn(): Promise<number> {
    const metadata = await stat(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!metadata) {
      this.#verifiedTail = undefined;
      return 0;
    }
    if (this.#verifiedTail && tailMatches(this.#verifiedTail, metadata)) {
      return this.#verifiedTail.lastLsn;
    }
    return this.#readAndRecover();
  }

  async #readAndRecover(
    visit: (envelope: CommitEnvelope<JsonValue>) => void = () => undefined,
  ): Promise<number> {
    const scanned = await this.#scanLog(visit);
    if (scanned.incompleteTail) {
      await this.#quarantineTail(scanned.incompleteTail, scanned.validBytes);
    }
    await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest);
    return scanned.lastLsn;
  }

  async #readProjectionTail(
    cursor: ProjectionCursor | undefined,
    afterLsn: number,
    visit: (envelope: CommitEnvelope<JsonValue>) => void,
  ): Promise<{ readonly lastLsn: number; readonly cursor: ProjectionCursor }> {
    if (cursor !== undefined && !(cursor instanceof FileProjectionCursor)) {
      throw new TypeError("Projection cursor was not issued by this commit log");
    }
    const metadata = await stat(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!metadata) {
      this.#verifiedTail = undefined;
      return { lastLsn: 0, cursor: this.#projectionCursor(0) };
    }

    if (cursor && canResumeProjectionCursor(cursor, this.logPath, metadata)) {
      const scanned = await this.#scanLogFrom(
        cursor.byteOffset,
        cursor.lsn,
        cursor.prefixDigest,
        visit,
      );
      if (scanned.incompleteTail) {
        await this.#quarantineTail(scanned.incompleteTail, scanned.validBytes);
      }
      await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest);
      return {
        lastLsn: scanned.lastLsn,
        cursor: this.#projectionCursor(scanned.lastLsn),
      };
    }

    let observedPrefixDigest = EMPTY_PROJECTION_PREFIX_DIGEST;
    let prefixMatches =
      cursor?.lsn === 0 && cursor.prefixDigest === EMPTY_PROJECTION_PREFIX_DIGEST;
    const lastLsn = await this.#readAndRecover((envelope) => {
      observedPrefixDigest = advanceProjectionPrefix(observedPrefixDigest, envelope);
      if (cursor && envelope.lsn === cursor.lsn) {
        prefixMatches = observedPrefixDigest === cursor.prefixDigest;
      }
      if (envelope.lsn > afterLsn) visit(envelope);
    });
    if (cursor && cursor.lsn <= lastLsn && !prefixMatches) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Projection cursor prefix does not match the current commit log",
      );
    }
    return { lastLsn, cursor: this.#projectionCursor(lastLsn) };
  }

  async #scanLog(
    visit: (envelope: CommitEnvelope<JsonValue>) => void = () => undefined,
  ): Promise<ScannedLog> {
    return this.#scanLogFrom(0, 0, EMPTY_PROJECTION_PREFIX_DIGEST, visit);
  }

  async #scanLogFrom(
    startOffset: number,
    previousLsn: number,
    previousPrefixDigest: string,
    visit: (envelope: CommitEnvelope<JsonValue>) => void = () => undefined,
  ): Promise<ScannedLog> {
    let handle: FileHandle;
    try {
      handle = await open(this.logPath, "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return {
          lastLsn: previousLsn,
          validBytes: startOffset,
          prefixDigest: previousPrefixDigest,
        };
      }
      throw error;
    }

    let expectedLsn = previousLsn + 1;
    let prefixDigest = previousPrefixDigest;
    try {
      const metadata = await handle.stat();
      if (startOffset > metadata.size) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Projection cursor is beyond the end of the commit log",
        );
      }
      const scanned = await scanAuthorityWalFrames(
        fileReader(handle, metadata.size - startOffset, startOffset),
        (payload) => {
          const envelope = parseEnvelope(payload);
          if (envelope.lsn !== expectedLsn) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Commit log LSN ${envelope.lsn} does not follow ${expectedLsn - 1}`,
            );
          }
          expectedLsn += 1;
          prefixDigest = advanceProjectionPrefix(prefixDigest, envelope);
          visit(envelope);
        },
      );
      return {
        lastLsn: expectedLsn - 1,
        validBytes: startOffset + scanned.validBytes,
        prefixDigest,
        ...(scanned.incompleteTail
          ? { incompleteTail: scanned.incompleteTail }
          : {}),
      };
    } finally {
      await handle.close();
    }
  }

  async #quarantineTail(bytes: Buffer, validBytes: number): Promise<void> {
    if (bytes.byteLength === 0) return;
    await ensureDurableDirectory(this.quarantineDir);
    const quarantinePath = path.join(
      this.quarantineDir,
      `authority-${Date.now()}-${randomBytes(8).toString("hex")}.bin`,
    );
    const quarantine = await open(quarantinePath, "wx", 0o600);
    try {
      await quarantine.writeFile(bytes);
      await quarantine.sync();
    } finally {
      await quarantine.close();
    }
    await syncDirectory(this.quarantineDir);
    await syncDirectory(this.rootDir);

    const log = await open(this.logPath, "r+");
    try {
      await log.truncate(validBytes);
      await log.sync();
    } finally {
      await log.close();
    }
  }

  async #recordVerifiedTail(lastLsn: number, prefixDigest: string): Promise<void> {
    const metadata = await stat(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    this.#verifiedTail = metadata
      ? {
          device: metadata.dev,
          inode: metadata.ino,
          bytes: metadata.size,
          modifiedAt: metadata.mtimeMs,
          changedAt: metadata.ctimeMs,
          lastLsn,
          prefixDigest,
        }
      : undefined;
  }

  #projectionCursor(lastLsn: number): ProjectionCursor {
    const tail = this.#verifiedTail;
    if (tail?.lastLsn === lastLsn) {
      return new FileProjectionCursor(
        lastLsn,
        this.logPath,
        tail.device,
        tail.inode,
        tail.bytes,
        tail.modifiedAt,
        tail.changedAt,
        tail.prefixDigest,
      );
    }
    if (lastLsn === 0) {
      return new FileProjectionCursor(
        0,
        this.logPath,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        EMPTY_PROJECTION_PREFIX_DIGEST,
      );
    }
    throw new AuthorityStorageError(
      "commit-log-corrupt",
      "Cannot issue a projection cursor without a verified log prefix",
    );
  }

  #requireVerifiedPrefix(lastLsn: number): string {
    if (this.#verifiedTail?.lastLsn !== lastLsn) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Commit log tail is missing its verified prefix digest",
      );
    }
    return this.#verifiedTail.prefixDigest;
  }

  async #withLogLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.#operations.run(async () => {
      await ensureDurableDirectory(this.rootDir);
      const release = await acquireFileLock(this.#lockPath, {
        staleMs: this.#lockStaleMs,
        waitMs: this.#lockWaitMs,
        resourceName: "AuthorityCommitLog",
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }
}

function retainReference(
  references: Map<string, ArtifactRef>,
  ref: ArtifactRef,
): void {
  const existing = references.get(ref.digest);
  if (existing && existing.bytes !== ref.bytes) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `Artifact ${ref.digest} declares conflicting byte counts`,
    );
  }
  references.set(ref.digest, ref);
}

function normalizeEntries<Body>(
  entries: readonly LogicalRecord<Body>[],
): Array<LogicalRecord<Body>> {
  const normalized: unknown = JSON.parse(canonicalize(entries));
  if (!Array.isArray(normalized) || normalized.length === 0) {
    throw new TypeError("A commit envelope must contain logical records");
  }
  for (const entry of normalized) {
    if (!isPlainRecord(entry)) {
      throw new TypeError("Logical records must be plain objects");
    }
    assertExactKeys(entry, ["body", "stream"]);
    if (typeof entry.stream !== "string") {
      throw new TypeError("Logical record stream must be a string");
    }
    assertStream(entry.stream);
    assertInlineBody(entry.body);
  }
  return normalized as Array<LogicalRecord<Body>>;
}

function parseEnvelope(bytes: Uint8Array): CommitEnvelope<JsonValue> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      "Commit envelope is not valid JSON",
      { cause: error },
    );
  }
  if (!isPlainRecord(value)) {
    throw invalidEnvelope("Commit envelope must be an object");
  }
  assertExactKeys(value, ["at", "entries", "envelopeDigest", "lsn", "v"]);
  if (
    value.v !== 1 ||
    !Number.isSafeInteger(value.lsn) ||
    (value.lsn as number) <= 0 ||
    typeof value.at !== "string" ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    typeof value.envelopeDigest !== "string" ||
    !DIGEST_PATTERN.test(value.envelopeDigest)
  ) {
    throw invalidEnvelope("Commit envelope fields are invalid");
  }
  assertCanonicalTime(value.at);
  for (const entry of value.entries) {
    if (!isPlainRecord(entry)) throw invalidEnvelope("Logical record must be an object");
    assertExactKeys(entry, ["body", "stream"]);
    if (typeof entry.stream !== "string") {
      throw invalidEnvelope("Logical record stream must be a string");
    }
    assertStream(entry.stream);
    assertInlineBody(entry.body);
  }
  const unsigned = {
    v: value.v,
    lsn: value.lsn,
    at: value.at,
    entries: value.entries,
  };
  if (protocolDigest("CommitEnvelope", 1, unsigned) !== value.envelopeDigest) {
    throw invalidEnvelope("Commit envelope digest is invalid");
  }
  if (canonicalize(value) !== Buffer.from(bytes).toString("utf8")) {
    throw invalidEnvelope("Commit envelope bytes are not canonical");
  }
  return value as unknown as CommitEnvelope<JsonValue>;
}

function assertStream(stream: string): void {
  if (!STREAM_PATTERN.test(stream)) {
    throw new TypeError(`Invalid authority logical stream: ${stream}`);
  }
}

function assertCanonicalTime(value: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError("Commit envelope time must be a canonical ISO timestamp");
  }
}

function assertInlineBody(body: unknown): void {
  const inlineBytes = Buffer.byteLength(canonicalize(body), "utf8");
  if (inlineBytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
    throw new TypeError(
      `Logical record body exceeds the ${MAX_INLINE_LOGICAL_RECORD_BYTES}-byte inline limit`,
    );
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidEnvelope("Commit envelope contains unknown or missing fields");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalidEnvelope(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function assertReplayLsn(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Projection replay LSN must be a non-negative safe integer");
  }
}

function assertTransactionReferencesProtected(
  references: readonly ArtifactRef[],
  candidateDigests: ReadonlyMap<string, number>,
): void {
  for (const reference of references) {
    const protectedBytes = candidateDigests.get(reference.digest);
    if (protectedBytes === undefined) {
      throw new TypeError(
        `Transaction introduced an undeclared artifact reference: ${reference.digest}`,
      );
    }
    if (protectedBytes !== reference.bytes) {
      throw new TypeError(
        `Transaction changed the byte count for artifact reference: ${reference.digest}`,
      );
    }
  }
}

function advanceProjectionPrefix(
  previousDigest: string,
  envelope: CommitEnvelope<unknown>,
): string {
  return protocolDigest("AuthorityProjectionPrefix", 1, {
    previousDigest,
    lsn: envelope.lsn,
    envelopeDigest: envelope.envelopeDigest,
  });
}

function fileReader(
  handle: FileHandle,
  size: number,
  baseOffset = 0,
): AuthorityWalReader {
  return {
    size,
    async read(offset, length) {
      const buffer = Buffer.allocUnsafe(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          length - total,
          baseOffset + offset + total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return buffer.subarray(0, total);
    },
  };
}

function canResumeProjectionCursor(
  cursor: FileProjectionCursor,
  logPath: string,
  metadata: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    cursor.logPath === logPath &&
    cursor.device === metadata.dev &&
    cursor.inode === metadata.ino &&
    cursor.byteOffset >= 0 &&
    cursor.byteOffset === metadata.size &&
    cursor.modifiedAt === metadata.mtimeMs &&
    cursor.changedAt === metadata.ctimeMs
  );
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file)
    .then(() => true)
    .catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    });
}

function tailMatches(
  tail: VerifiedLogTail,
  metadata: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    tail.device === metadata.dev &&
    tail.inode === metadata.ino &&
    tail.bytes === metadata.size &&
    tail.modifiedAt === metadata.mtimeMs &&
    tail.changedAt === metadata.ctimeMs
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
