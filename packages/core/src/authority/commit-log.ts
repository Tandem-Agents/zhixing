import { randomBytes } from "node:crypto";
import {
  link,
  open,
  readFile,
  rename,
  stat,
  unlink,
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
import {
  claimDeviceCapacity,
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  runInMaintenanceContext,
  runStorageMaintenanceStep,
  maintenanceRetryDelayMs,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  waitForMaintenanceRetry,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";
import { collectArtifactRefs } from "./artifact-references.js";
import {
  classifyRegisteredArtifactReferences,
  classifyRetainedRecordReferences,
  collectRegisteredArtifactRoots,
  deletedConversationOf,
  isRetainingAuthorityRecord,
} from "./artifact-retention.js";
import { collectArtifactGarbage, FileArtifactStore } from "./artifact-store.js";
import {
  bindDurableProjectionMutations,
  createBoundDurableProjectionReadContext,
  durableProjectionDirectoryName,
  DurableProjectionStorageError,
  FileDurableProjectionIndex,
  type DurableProjectionCheckpoints,
  type DurableProjectionDefinition,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type RebuildableDurableProjectionIndex,
} from "./durable-projection-index.js";
import { AuthorityStorageError } from "./errors.js";
import type {
  ArtifactGarbageCollectionResult,
  AuthorityCommitLog,
  AuthorityLogSnapshot,
  AuthorityGarbageCollectionOptions,
  DurableLogCheckpoint,
  PhysicalStorageStepRunner,
  ProjectionReplayOptions,
  ProjectionReducer,
  ProjectionCursor,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
  ProjectionTransactionOptions,
  ProjectionTransactionResult,
  ProjectionTransactionReducer,
} from "./interfaces.js";
import {
  AUTHORITY_WAL_FILE_HEADER_BYTES,
  type AuthorityWalReader,
  decodeAuthorityWalFileHeader,
  encodeAuthorityWalFileHeader,
  encodeAuthorityWalFrame,
  scanAuthorityWalFrames,
  verifyAuthorityWalFrameBoundary,
} from "./wal-frame.js";

export const MAX_INLINE_LOGICAL_RECORD_BYTES = 32 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STREAM_PATTERN =
  /^(?:control|publish|governor|final-outbox|trust|exposure|delivery|pairing|checkpoint|(?:run|job|transfer|intent|assignment|executor|session-activity):[^\u0000-\u001f\u007f]{1,480})$/u;
const LOG_ID_BYTES = 32;
const RETAINED_REFERENCE_PROJECTION_ID = "authority-retained-references";
const RETAINED_REFERENCE_PREFIX = "retention/reference/";
const RETAINED_UNCONDITIONAL_PREFIX = "retention/unconditional/";
const RETAINED_LEAF_PREFIX = "retention/leaf/";
const RETAINED_DEAD_PREFIX = "retention/dead/";
const RETAINED_ROOT_PREFIX = "retention/root/";
const RETAINED_SCAN_PAGE_SIZE = 256;

export interface FileAuthorityCommitLogOptions {
  readonly clock?: () => IsoTime;
  readonly lockStaleMs?: number;
  readonly lockWaitMs?: number;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

export interface RetainedReferenceQueryOptions {
  /**
   * 额外的会话删除 tombstone(来自持有削除事实的权威日志):内容叶所有权
   * 单源在会话权威,不持有该事实的日志由调用方传入并集判定。
   */
  readonly deadConversations?: ReadonlySet<string>;
}

interface VerifiedLogTail {
  readonly logId: string;
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
  readonly stopped?: true;
}

class FileProjectionCursor implements ProjectionCursor {
  constructor(
    readonly lsn: number,
    readonly logId: string,
    readonly logPath: string,
    readonly device: number | undefined,
    readonly inode: number | undefined,
    readonly byteOffset: number,
    readonly modifiedAt: number | undefined,
    readonly changedAt: number | undefined,
    readonly prefixDigest: string,
  ) {}
}

interface RegisteredDurableProjection {
  readonly state: FileDurableProjectionIndex;
  readonly read: DurableProjectionReadContext;
  readonly reduce: DurableProjectionDefinition<JsonValue>["reduce"];
}

export class FileAuthorityCommitLog implements AuthorityCommitLog {
  readonly rootDir: string;
  readonly logPath: string;
  readonly identityPath: string;
  readonly quarantineDir: string;
  readonly artifactStore: FileArtifactStore;
  readonly #lockPath: string;
  readonly #clock: () => IsoTime;
  readonly #lockStaleMs: number;
  readonly #lockWaitMs: number;
  readonly #operations = new SerialTaskQueue();
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  readonly #durableProjections = new Map<string, RegisteredDurableProjection>();
  readonly #retainedReferenceIndex: RebuildableDurableProjectionIndex;
  #verifiedTail: VerifiedLogTail | undefined;
  #logId: string | undefined;
  #logFormat: "legacy" | "versioned" | undefined;

  constructor(
    rootDir: string,
    artifactStore: FileArtifactStore,
    options: FileAuthorityCommitLogOptions = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.logPath = path.join(this.rootDir, "authority.log");
    this.identityPath = path.join(this.rootDir, "authority.log.identity");
    this.quarantineDir = path.join(this.rootDir, "bad-tail");
    this.artifactStore = artifactStore;
    this.#lockPath = path.join(this.rootDir, ".commit-log.lock");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#lockStaleMs = options.lockStaleMs ?? 30_000;
    this.#lockWaitMs = options.lockWaitMs ?? 10_000;
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#storageMaintenance = options.storageMaintenance;
    this.#retainedReferenceIndex = this.durableProjection({
      projectionId: RETAINED_REFERENCE_PROJECTION_ID,
      reducerVersion: 3,
      reduce: (envelope, current) =>
        reduceRetainedReferenceIndex(envelope, current, this.artifactStore),
    });
  }

  async append<Body>(
    entries: readonly LogicalRecord<Body>[],
  ): Promise<CommitEnvelope<Body>> {
    if (entries.length === 0) {
      throw new TypeError(
        "A commit envelope must contain at least one logical record",
      );
    }
    const normalizedEntries = normalizeEntries(entries);
    const references = collectRetainedArtifactRefs(normalizedEntries);
    const appendOperation = () =>
      this.#withLogLock(() => this.#append(normalizedEntries));
    return references.length === 0
      ? appendOperation()
      : this.artifactStore.withPresentReferences(references, appendOperation);
  }

  async readAll<Body = JsonValue>(): Promise<Array<CommitEnvelope<Body>>> {
    return [...(await this.readSnapshot<Body>()).commits];
  }

  async readSnapshot<Body = JsonValue>(): Promise<AuthorityLogSnapshot<Body>> {
    return this.#withLogLock(async () => {
      const envelopes: Array<CommitEnvelope<JsonValue>> = [];
      const lastLsn = await this.#readAndRecover((envelope) => {
        envelopes.push(envelope);
      });
      return {
        commits: envelopes as Array<CommitEnvelope<Body>>,
        cursor: this.#projectionCursor(lastLsn),
      };
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

  durableProjection<Body = JsonValue>(
    definition: DurableProjectionDefinition<Body>,
  ): RebuildableDurableProjectionIndex {
    const existing = this.#durableProjections.get(definition.projectionId);
    if (existing) {
      if (existing.state.reducerVersion !== definition.reducerVersion) {
        throw new TypeError(
          "Durable projection reducer version is inconsistent",
        );
      }
      return this.#boundProjection(existing);
    }
    const state = new FileDurableProjectionIndex({
      rootDir: path.join(
        this.rootDir,
        "projections",
        durableProjectionDirectoryName(definition.projectionId),
      ),
      projectionId: definition.projectionId,
      reducerVersion: definition.reducerVersion,
      storageMaintenance: this.#storageMaintenance,
    });
    const registered: RegisteredDurableProjection = {
      state,
      read: createBoundDurableProjectionReadContext(state),
      reduce: definition.reduce as RegisteredDurableProjection["reduce"],
    };
    this.#durableProjections.set(definition.projectionId, registered);
    return this.#boundProjection(registered);
  }

  async checkpoint(): Promise<DurableLogCheckpoint> {
    return this.#withLogLock(async () => {
      const lastLsn = await this.#loadLastLsn();
      return this.#durableCheckpoint(lastLsn);
    });
  }

  async originCheckpoint(): Promise<DurableLogCheckpoint> {
    return this.#withLogLock(async () => this.#durableCheckpoint(0));
  }

  /** 进程停机时取消日志迁移及该日志所拥有的全部投影维护义务。 */
  stopStorageMaintenance(): void {
    this.#maintenanceRunner.stop();
    for (const projection of this.#durableProjections.values()) {
      projection.state.stopStorageMaintenance();
    }
  }

  async readTail<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
    limit: number,
    runPhysicalStep: PhysicalStorageStepRunner = async (operation) =>
      operation(),
  ): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[];
    readonly checkpoint: DurableLogCheckpoint;
    readonly hasMore: boolean;
  }> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
      throw new RangeError("Authority log tail limit must be 1-256");
    }
    return this.#withLogLock(() =>
      runPhysicalStep(async () => {
        await this.#validateDurableCheckpoint(checkpoint);
        const commits: Array<CommitEnvelope<JsonValue>> = [];
        const scanned = await this.#scanLogFrom(
          checkpoint.frameEndOffset,
          checkpoint.lsn,
          checkpoint.prefixDigest,
          (envelope) => {
            commits.push(envelope);
            return commits.length < limit;
          },
        );
        if (scanned.incompleteTail) {
          await this.#quarantineTail(
            scanned.incompleteTail,
            scanned.validBytes,
          );
        }
        await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest);
        return {
          commits: commits as Array<CommitEnvelope<Body>>,
          checkpoint: this.#durableCheckpoint(scanned.lastLsn),
          hasMore: scanned.stopped === true,
        };
      }),
    );
  }

  async readEnvelopeAt<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
  ): Promise<CommitEnvelope<Body>> {
    if (checkpoint.lsn === 0) {
      throw new TypeError("An empty log checkpoint has no authority envelope");
    }
    return this.#withLogLock(async () => {
      await this.#validateDurableCheckpoint(checkpoint);
      const handle = await open(this.logPath, "r");
      try {
        const metadata = await handle.stat();
        const boundary = await verifyAuthorityWalFrameBoundary(
          fileReader(handle, metadata.size),
          checkpoint.frameEndOffset,
        );
        const frameBytes =
          checkpoint.frameEndOffset - boundary.frameStartOffset;
        let result: CommitEnvelope<JsonValue> | undefined;
        const scanned = await scanAuthorityWalFrames(
          fileReader(handle, frameBytes, boundary.frameStartOffset),
          (payload, _offset, frameMetadata, nextOffset) => {
            const envelope = parseEnvelope(payload);
            // legacy 帧不携带帧级锚点,此时以信封自身的 lsn 作唯一身份依据;
            // versioned 帧则两者都必须与 checkpoint 吻合。
            if (
              result !== undefined ||
              nextOffset !== frameBytes ||
              (frameMetadata !== undefined &&
                (frameMetadata.lsn !== checkpoint.lsn ||
                  frameMetadata.prefixDigest !== checkpoint.prefixDigest)) ||
              envelope.lsn !== checkpoint.lsn
            ) {
              throw new AuthorityStorageError(
                "commit-log-corrupt",
                "Authority envelope does not match its durable source checkpoint",
              );
            }
            result = envelope;
          },
        );
        if (
          result === undefined ||
          scanned.validBytes !== frameBytes ||
          scanned.incompleteTail !== undefined
        ) {
          throw new AuthorityStorageError(
            "commit-log-corrupt",
            "Authority source checkpoint does not contain one complete envelope",
          );
        }
        return result as CommitEnvelope<Body>;
      } finally {
        await handle.close();
      }
    });
  }

  async rebuildProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options: ProjectionReplayOptions = {},
  ): Promise<State> {
    const selectedStreams = validateProjectionStreams(options);
    const afterLsn = options.afterLsn ?? 0;
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
          if (
            selectedStreams === undefined ||
            selectedStreams.has(record.stream)
          ) {
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
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options: ProjectionTransactionOptions = {},
  ): Promise<ProjectionTransactionResult<State, Body, Value>> {
    const selectedStreams = validateProjectionStreams(options);
    if (
      options.cursor !== undefined &&
      options.afterLsn !== undefined &&
      options.cursor.lsn !== options.afterLsn
    ) {
      throw new TypeError(
        "Projection cursor and afterLsn must identify the same prefix",
      );
    }
    const afterLsn = options.cursor?.lsn ?? options.afterLsn ?? 0;
    assertReplayLsn(afterLsn);
    const readProjectionIds = [...new Set(options.readProjectionIds ?? [])]
      .map(validateDurableProjectionId)
      .sort((left, right) => left.localeCompare(right, "en-US"));

    const candidateReferences = collectArtifactRefs(
      options.candidateReferences ?? [],
    );
    const candidateDigests = new Map(
      candidateReferences.map((reference) => [
        reference.digest,
        reference.bytes,
      ]),
    );
    const runPhysicalStep =
      options.runPhysicalStep ??
      (async <T>(operation: () => Promise<T>) => operation());
    const operation = () =>
      this.#withLogLock(() =>
        runPhysicalStep(async () => {
          const readProjections = new Map<string, DurableProjectionReadContext>();
          for (const projectionId of readProjectionIds) {
            const projection = this.#durableProjections.get(projectionId);
            if (!projection) {
              throw new TypeError(
                `Durable projection is not registered: ${projectionId}`,
              );
            }
            await this.#withDurableProjectionRecovery(projection, () =>
              this.#synchronizeDurableProjection(projection),
            );
            readProjections.set(projectionId, projection.read);
          }
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
                if (
                  selectedStreams === undefined ||
                  selectedStreams.has(record.stream)
                ) {
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
          const at = this.#clock();
          assertCanonicalTime(at);
          const decision = await decide(
            state,
            projectionTransactionContext(lastLsn, at, readProjections),
          );
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
            collectRetainedArtifactRefs(entries),
            candidateDigests,
          );
          const candidate = createCommitEnvelope(lastLsn + 1, at, entries);
          let nextState = state;
          for (const record of candidate.entries) {
            if (
              selectedStreams === undefined ||
              selectedStreams.has(record.stream)
            ) {
              nextState = await reducer(nextState, record, candidate);
            }
          }
          const commit = await this.#append(entries, at, candidate);
          state = nextState;
          return {
            value: decision.value,
            state,
            lastLsn: commit.lsn,
            cursor: this.#projectionCursor(commit.lsn),
            commit,
          };
        }),
      );

    return candidateReferences.length === 0
      ? operation()
      : this.artifactStore.withPresentReferences(
          candidateReferences,
          operation,
        );
  }

  async transactDurableProjection<Body = JsonValue, Value = void>(
    projectionId: string,
    decide: (
      current: DurableProjectionReadContext,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options: Pick<ProjectionTransactionOptions, "candidateReferences"> = {},
  ): Promise<{
    readonly value: Value;
    readonly commit?: CommitEnvelope<Body>;
  }> {
    const projection = this.#durableProjections.get(projectionId);
    if (!projection) {
      throw new TypeError(
        `Durable projection is not registered: ${projectionId}`,
      );
    }
    const candidateReferences = collectArtifactRefs(
      options.candidateReferences ?? [],
    );
    const candidateDigests = new Map(
      candidateReferences.map((reference) => [
        reference.digest,
        reference.bytes,
      ]),
    );
    const operation = () =>
      this.#withLogLock(async () => {
        await this.#withDurableProjectionRecovery(projection, () =>
          this.#synchronizeDurableProjection(projection),
        );
        const lastLsn = await this.#loadLastLsn();
        const at = this.#clock();
        assertCanonicalTime(at);
        const decision = await decide(
          projection.read,
          projectionTransactionContext(
            lastLsn,
            at,
            new Map([[projectionId, projection.read]]),
          ),
        );
        if (decision.kind === "return") return { value: decision.value };
        const entries = normalizeEntries(decision.entries);
        assertTransactionReferencesProtected(
          collectRetainedArtifactRefs(entries),
          candidateDigests,
        );
        const candidate = createCommitEnvelope(lastLsn + 1, at, entries);
        const commit = await this.#append(entries, at, candidate);
        return {
          value: decision.value,
          commit: commit as CommitEnvelope<Body>,
        };
      });
    return candidateReferences.length === 0
      ? operation()
      : this.artifactStore.withPresentReferences(
          candidateReferences,
          operation,
        );
  }

  async collectGarbage(
    options: AuthorityGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult> {
    return this.artifactStore[collectArtifactGarbage]({
      unreferencedBefore: options.unreferencedBefore,
      loadRetainedReferences: (candidates) =>
        this.retainedArtifactReferences(candidates),
    });
  }

  async retainedArtifactReferences(
    candidates?: readonly ArtifactRef[],
    options: RetainedReferenceQueryOptions = {},
  ): Promise<readonly ArtifactRef[]> {
    return this.#withRetainedProjectionValueRecovery(async () => {
      if (candidates === undefined) {
        const retained: ArtifactRef[] = [];
        await this.#scanRetainedPrefix(
          RETAINED_REFERENCE_PREFIX,
          async ({ key, value }) => {
            const ref = retainedArtifactRef(value, key);
            if (await this.#isRetainedReference(ref.digest, options)) {
              retained.push(ref);
            }
          },
        );
        return retained;
      }
      const unique = new Map<string, ArtifactRef>();
      for (const ref of candidates) retainReference(unique, ref);
      const retained: ArtifactRef[] = [];
      for (const candidate of unique.values()) {
        const key = retainedReferenceKey(candidate.digest);
        const stored = await this.#retainedReferenceIndex.get(key);
        if (stored === undefined) continue;
        const ref = retainedArtifactRef(stored, key);
        if (ref.digest !== candidate.digest || ref.bytes !== candidate.bytes) {
          throw new AuthorityStorageError(
            "invalid-authority-record",
            `Artifact ${candidate.digest} declares conflicting byte counts`,
          );
        }
        if (await this.#isRetainedReference(candidate.digest, options)) {
          retained.push(ref);
        }
      }
      return retained;
    });
  }

  /** 当前日志已耐久的会话删除 tombstone 快照(内容叶所有权削除单源)。 */
  async deadConversations(): Promise<ReadonlySet<string>> {
    return this.#withRetainedProjectionValueRecovery(async () => {
      const dead = new Set<string>();
      await this.#scanRetainedPrefix(
        RETAINED_DEAD_PREFIX,
        async ({ key, value }) => {
          dead.add(retainedConversationId(value, key));
        },
      );
      return dead;
    });
  }

  /**
   * 全部所有者均已删除的内容叶引用:恢复路径以此重建回收候选,
   * 保证"释放→崩溃→重启"不会使已接管资产脱离回收周期。
   */
  async releasedLeafReferences(): Promise<readonly ArtifactRef[]> {
    return this.#withRetainedProjectionValueRecovery(async () => {
      const released: ArtifactRef[] = [];
      let currentDigest: string | undefined;
      let currentRef: ArtifactRef | undefined;
      let currentAllDead = true;
      const finishCurrent = (): void => {
        if (currentRef !== undefined && currentAllDead) {
          released.push(currentRef);
        }
      };
      await this.#scanRetainedPrefix(
        RETAINED_LEAF_PREFIX,
        async ({ key, value }) => {
          const leaf = await resolveRetainedLeaf(
            this.#retainedReferenceIndex,
            value,
            key,
          );
          if (leaf.ref.digest !== currentDigest) {
            finishCurrent();
            currentDigest = leaf.ref.digest;
            currentRef = leaf.ref;
            currentAllDead = true;
          } else if (currentRef?.bytes !== leaf.ref.bytes) {
            throw invalidRetainedProjection(
              `Artifact ${leaf.ref.digest} declares conflicting byte counts`,
            );
          }
          if (
            currentAllDead &&
            !(await this.#isConversationDead(leaf.conversationId))
          ) {
            currentAllDead = false;
          }
        },
      );
      finishCurrent();
      return released;
    });
  }

  async #withRetainedProjectionValueRecovery<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RetainedReferenceProjectionValueError)) {
        throw error;
      }
      await this.#retainedReferenceIndex.rebuild();
      return operation();
    }
  }

  async #isRetainedReference(
    digest: string,
    options: RetainedReferenceQueryOptions,
  ): Promise<boolean> {
    if (
      await this.#retainedReferenceIndex
        .get(retainedUnconditionalKey(digest))
        .then((value) => {
          if (value === undefined) return false;
          retainedUnconditionalDigest(value, retainedUnconditionalKey(digest));
          return true;
        })
    ) {
      return true;
    }
    let retained = false;
    await this.#scanRetainedPrefix(
      retainedLeafPrefix(digest),
      async ({ key, value }) => {
        if (retained) return;
        const leaf = await resolveRetainedLeaf(
          this.#retainedReferenceIndex,
          value,
          key,
        );
        if (
          !(options.deadConversations?.has(leaf.conversationId) ?? false) &&
          !(await this.#isConversationDead(leaf.conversationId))
        ) {
          retained = true;
        }
      },
    );
    return retained;
  }

  async #isConversationDead(conversationId: string): Promise<boolean> {
    const key = retainedDeadKey(conversationId);
    const value = await this.#retainedReferenceIndex.get(key);
    if (value === undefined) return false;
    retainedConversationId(value, key);
    return true;
  }

  async #scanRetainedPrefix(
    prefix: string,
    visit: (entry: {
      readonly key: string;
      readonly value: JsonValue;
    }) => Promise<void>,
  ): Promise<void> {
    let continuation: string | undefined;
    do {
      const page = await this.#retainedReferenceIndex.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        RETAINED_SCAN_PAGE_SIZE,
        continuation,
      );
      for (const entry of page.entries) {
        await visit(entry);
      }
      continuation = page.continuation;
    } while (continuation !== undefined);
  }

  #boundProjection(
    projection: RegisteredDurableProjection,
  ): RebuildableDurableProjectionIndex {
    return {
      get: (key) =>
        this.#withLogLock(() =>
          this.#withDurableProjectionRecovery(projection, async () => {
            await this.#synchronizeDurableProjection(projection);
            return await projection.read.get(key);
          }),
        ),
      scan: (range, limit, continuation) =>
        this.#withLogLock(() =>
          this.#withDurableProjectionRecovery(
            projection,
            async () => {
              await this.#synchronizeDurableProjection(projection);
              return projection.read.scan(range, limit, continuation);
            },
            continuation === undefined
              ? undefined
              : () => projection.read.scan(range, limit, continuation),
          ),
        ),
      checkpoints: () =>
        this.#withLogLock(() =>
          this.#withDurableProjectionRecovery(projection, async () => {
            await this.#synchronizeDurableProjection(projection);
            return projection.state.checkpoints();
          }),
        ),
      rebuild: () =>
        this.#withLogLock(() => this.#rebuildDurableProjection(projection)),
    };
  }

  async #withDurableProjectionRecovery<Result>(
    projection: RegisteredDurableProjection,
    operation: () => Promise<Result>,
    afterRebuild: () => Promise<Result> = operation,
  ): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof DurableProjectionStorageError)) throw error;
      await this.#rebuildDurableProjection(projection);
      return afterRebuild();
    }
  }

  async #rebuildDurableProjection(
    projection: RegisteredDurableProjection,
  ): Promise<void> {
    await projection.state.reset({
      authority: this.#durableCheckpoint(0),
    });
    await this.#synchronizeDurableProjection(projection);
  }

  async #synchronizeDurableProjection(
    projection: RegisteredDurableProjection,
  ): Promise<void> {
    const emptyCheckpoint = this.#durableCheckpoint(0);
    await projection.state.initialize({ authority: emptyCheckpoint });
    let checkpoint = projection.state.checkpoints().authority;
    if (!checkpoint) {
      await projection.state.reset({ authority: emptyCheckpoint });
      checkpoint = emptyCheckpoint;
    }
    try {
      await this.#validateDurableCheckpoint(checkpoint);
    } catch (error) {
      if (!(error instanceof AuthorityStorageError)) throw error;
      await projection.state.reset({ authority: emptyCheckpoint });
      checkpoint = emptyCheckpoint;
    }
    const scanned = await this.#scanLogFrom(
      checkpoint.frameEndOffset,
      checkpoint.lsn,
      checkpoint.prefixDigest,
      async (envelope, envelopeCheckpoint) => {
        const mutations = await projection.reduce(envelope, projection.read, {
          checkpoint: envelopeCheckpoint,
        });
        const prepared = await projection.state.prepare(
          bindDurableProjectionMutations(mutations),
        );
        projection.state.publish(prepared, {
          authority: envelopeCheckpoint,
        });
      },
    );
    if (scanned.incompleteTail) {
      await this.#quarantineTail(scanned.incompleteTail, scanned.validBytes);
    }
    await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest);
  }

  async #append<Body>(
    entries: Array<LogicalRecord<Body>>,
    committedAt?: IsoTime,
    preparedEnvelope?: CommitEnvelope<Body>,
  ): Promise<CommitEnvelope<Body>> {
    for (const projection of this.#durableProjections.values()) {
      await this.#withDurableProjectionRecovery(projection, () =>
        this.#synchronizeDurableProjection(projection),
      );
    }
    const previousLsn = await this.#loadLastLsn();
    const lsn = previousLsn + 1;
    if (!Number.isSafeInteger(lsn)) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Commit log LSN exhausted the safe integer range",
      );
    }
    const at = committedAt ?? this.#clock();
    const envelope = preparedEnvelope ?? createCommitEnvelope(lsn, at, entries);
    if (
      envelope.lsn !== lsn ||
      envelope.at !== at ||
      canonicalize(envelope.entries) !== canonicalize(entries)
    ) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Prepared commit envelope no longer matches the authority log head",
      );
    }
    const previousPrefixDigest =
      previousLsn === 0
        ? emptyLogPrefix(this.#requireLogId())
        : this.#requireVerifiedPrefix(previousLsn);
    const prefixDigest = advanceProjectionPrefix(
      this.#requireLogId(),
      previousPrefixDigest,
      envelope,
    );
    const bytes = Buffer.from(canonicalize(envelope), "utf8");
    const frame = encodeAuthorityWalFrame(
      bytes,
      this.#requireLogFormat() === "versioned"
        ? { lsn, prefixDigest }
        : undefined,
    );
    const previousTail = this.#verifiedTail;
    if (!previousTail || previousTail.lastLsn !== previousLsn) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Authority log append requires a verified prior tail",
      );
    }
    const frameEndOffset = previousTail.bytes + frame.byteLength;
    const checkpoint: DurableLogCheckpoint = {
      logId: this.#requireLogId(),
      lsn,
      frameEndOffset,
      prefixDigest,
    };
    const preparedProjections: Array<{
      readonly projection: RegisteredDurableProjection;
      readonly prepared: Awaited<
        ReturnType<FileDurableProjectionIndex["prepare"]>
      >;
      readonly checkpoints: DurableProjectionCheckpoints;
    }> = [];
    for (const projection of this.#durableProjections.values()) {
      const prepared = await this.#withDurableProjectionRecovery(
        projection,
        async () => {
          const mutations = await projection.reduce(
            envelope as unknown as CommitEnvelope<JsonValue>,
            projection.read,
            { checkpoint },
          );
          return projection.state.prepare(
            bindDurableProjectionMutations(mutations),
          );
        },
      );
      preparedProjections.push({
        projection,
        prepared,
        checkpoints: { authority: checkpoint },
      });
    }
    for (const { projection, prepared } of preparedProjections) {
      if (prepared.owner !== projection.state) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Prepared projection delta belongs to another projection",
        );
      }
    }

    const handle = await open(this.logPath, "a", 0o600);
    let committed = false;
    let nextTail: VerifiedLogTail | undefined;
    try {
      const metadata = await handle.stat();
      if (
        metadata.dev !== previousTail.device ||
        metadata.ino !== previousTail.inode ||
        metadata.size !== previousTail.bytes
      ) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Authority log changed before append",
        );
      }
      nextTail = {
        logId: checkpoint.logId,
        device: metadata.dev,
        inode: metadata.ino,
        bytes: checkpoint.frameEndOffset,
        modifiedAt: Number.NaN,
        changedAt: Number.NaN,
        lastLsn: checkpoint.lsn,
        prefixDigest: checkpoint.prefixDigest,
      };
      await handle.writeFile(frame);
      await handle.sync();
      committed = true;
      this.#verifiedTail = nextTail;
      for (const { projection, prepared, checkpoints } of preparedProjections) {
        projection.state.publish(prepared, checkpoints);
      }
    } finally {
      if (committed) {
        await handle.close().catch(() => undefined);
      } else {
        await handle.close();
      }
    }
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
    if (
      this.#verifiedTail &&
      Number.isNaN(this.#verifiedTail.modifiedAt) &&
      this.#verifiedTail.device === metadata.dev &&
      this.#verifiedTail.inode === metadata.ino &&
      this.#verifiedTail.bytes === metadata.size
    ) {
      if (this.#requireLogFormat() === "legacy") {
        return this.#readAndRecover();
      }
      const expected = this.#verifiedTail;
      const handle = await open(this.logPath, "r");
      try {
        const boundary = await verifyAuthorityWalFrameBoundary(
          fileReader(handle, metadata.size),
          expected.bytes,
        );
        // 此处 legacy 已在上方早退,versioned 帧必须带锚点;缺失即为损坏。
        if (
          !boundary.metadata ||
          boundary.metadata.lsn !== expected.lastLsn ||
          boundary.metadata.prefixDigest !== expected.prefixDigest
        ) {
          throw new AuthorityStorageError(
            "commit-log-corrupt",
            "Authority log tail changed after commit",
          );
        }
      } finally {
        await handle.close();
      }
      this.#verifiedTail = {
        ...expected,
        modifiedAt: metadata.mtimeMs,
        changedAt: metadata.ctimeMs,
      };
      return expected.lastLsn;
    }
    return this.#readAndRecover();
  }

  async #readAndRecover(
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => void | Promise<void> = () => undefined,
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
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => void | Promise<void>,
  ): Promise<{ readonly lastLsn: number; readonly cursor: ProjectionCursor }> {
    if (cursor !== undefined && !(cursor instanceof FileProjectionCursor)) {
      throw new TypeError(
        "Projection cursor was not issued by this commit log",
      );
    }
    const metadata = await stat(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!metadata) {
      this.#verifiedTail = undefined;
      return { lastLsn: 0, cursor: this.#projectionCursor(0) };
    }

    if (
      cursor &&
      canResumeProjectionCursor(
        cursor,
        this.logPath,
        this.#requireLogId(),
        metadata,
      )
    ) {
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

    const logId = this.#requireLogId();
    let observedPrefixDigest = emptyLogPrefix(logId);
    let prefixMatches =
      cursor?.lsn === 0 &&
      cursor.logId === logId &&
      cursor.prefixDigest === observedPrefixDigest;
    const lastLsn = await this.#readAndRecover(async (envelope, checkpoint) => {
      observedPrefixDigest = advanceProjectionPrefix(
        logId,
        observedPrefixDigest,
        envelope,
      );
      if (cursor && envelope.lsn === cursor.lsn) {
        prefixMatches =
          cursor.logId === logId &&
          observedPrefixDigest === cursor.prefixDigest;
      }
      if (envelope.lsn > afterLsn) await visit(envelope, checkpoint);
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
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => void | Promise<void> = () => undefined,
  ): Promise<ScannedLog> {
    return this.#scanLogFrom(
      this.#logDataStartOffset(),
      0,
      emptyLogPrefix(this.#requireLogId()),
      visit,
    );
  }

  async #scanLogFrom(
    startOffset: number,
    previousLsn: number,
    previousPrefixDigest: string,
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => boolean | void | Promise<boolean | void> = () => undefined,
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
      const logId = this.#requireLogId();
      const scanned = await scanAuthorityWalFrames(
        fileReader(handle, metadata.size - startOffset, startOffset),
        async (payload, offset, frameMetadata, nextOffset) => {
          const envelope = parseEnvelope(payload);
          if (envelope.lsn !== expectedLsn) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Commit log LSN ${envelope.lsn} does not follow ${expectedLsn - 1}`,
            );
          }
          expectedLsn += 1;
          prefixDigest = advanceProjectionPrefix(logId, prefixDigest, envelope);
          const frameProofIsValid =
            this.#requireLogFormat() === "versioned"
              ? frameMetadata?.lsn === envelope.lsn &&
                frameMetadata.prefixDigest === prefixDigest
              : frameMetadata === undefined;
          if (!frameProofIsValid) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Authority WAL frame proof is invalid at byte ${startOffset + offset}`,
            );
          }
          return visit(envelope, {
            logId,
            lsn: envelope.lsn,
            frameEndOffset: startOffset + nextOffset,
            prefixDigest,
          });
        },
      );
      return {
        lastLsn: expectedLsn - 1,
        validBytes: startOffset + scanned.validBytes,
        prefixDigest,
        ...(scanned.stopped ? { stopped: true as const } : {}),
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

  async #recordVerifiedTail(
    lastLsn: number,
    prefixDigest: string,
  ): Promise<void> {
    const metadata = await stat(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    this.#verifiedTail = metadata
      ? {
          logId: this.#requireLogId(),
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
        tail.logId,
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
        this.#requireLogId(),
        this.logPath,
        undefined,
        undefined,
        0,
        undefined,
        undefined,
        emptyLogPrefix(this.#requireLogId()),
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

  #requireLogId(): string {
    if (this.#logId === undefined) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Authority commit log identity is not initialized",
      );
    }
    return this.#logId;
  }

  #requireLogFormat(): "legacy" | "versioned" {
    if (this.#logFormat === undefined) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Authority commit log format is not initialized",
      );
    }
    return this.#logFormat;
  }

  #logDataStartOffset(): number {
    return this.#requireLogFormat() === "versioned"
      ? AUTHORITY_WAL_FILE_HEADER_BYTES
      : 0;
  }

  #durableCheckpoint(lastLsn: number): DurableLogCheckpoint {
    if (lastLsn === 0) {
      return {
        logId: this.#requireLogId(),
        lsn: 0,
        frameEndOffset: this.#logDataStartOffset(),
        prefixDigest: emptyLogPrefix(this.#requireLogId()),
      };
    }
    const tail = this.#verifiedTail;
    if (tail?.lastLsn !== lastLsn) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Authority log checkpoint requires a verified tail",
      );
    }
    return {
      logId: tail.logId,
      lsn: tail.lastLsn,
      frameEndOffset: tail.bytes,
      prefixDigest: tail.prefixDigest,
    };
  }

  async #validateDurableCheckpoint(
    checkpoint: DurableLogCheckpoint,
  ): Promise<void> {
    const dataStartOffset = this.#logDataStartOffset();
    if (
      checkpoint.logId !== this.#requireLogId() ||
      !Number.isSafeInteger(checkpoint.lsn) ||
      checkpoint.lsn < 0 ||
      !Number.isSafeInteger(checkpoint.frameEndOffset) ||
      checkpoint.frameEndOffset < dataStartOffset ||
      !DIGEST_PATTERN.test(checkpoint.prefixDigest)
    ) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Durable log checkpoint is invalid or belongs to another log",
      );
    }
    if (checkpoint.lsn === 0) {
      if (
        checkpoint.frameEndOffset !== dataStartOffset ||
        checkpoint.prefixDigest !== emptyLogPrefix(checkpoint.logId)
      ) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Empty durable log checkpoint is invalid",
        );
      }
      return;
    }
    if (this.#requireLogFormat() === "legacy") {
      const scanned = await this.#scanLogFrom(
        0,
        0,
        emptyLogPrefix(this.#requireLogId()),
        (_envelope, observed) =>
          observed.lsn === checkpoint.lsn ? false : undefined,
      );
      if (
        scanned.lastLsn !== checkpoint.lsn ||
        scanned.validBytes !== checkpoint.frameEndOffset ||
        scanned.prefixDigest !== checkpoint.prefixDigest
      ) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Legacy durable log checkpoint does not match its WAL boundary",
        );
      }
      return;
    }
    const handle = await open(this.logPath, "r");
    try {
      const metadata = await handle.stat();
      const boundary = await verifyAuthorityWalFrameBoundary(
        fileReader(handle, metadata.size),
        checkpoint.frameEndOffset,
      );
      // legacy 帧没有帧级 lsn 与前缀摘要,只能校验到边界本身;versioned 帧才能
      // 复验 checkpoint 与帧身份一致。旧日志上的这一层降级是有意接受的兼容代价。
      if (
        boundary.metadata &&
        (boundary.metadata.lsn !== checkpoint.lsn ||
          boundary.metadata.prefixDigest !== checkpoint.prefixDigest)
      ) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Durable log checkpoint does not match its WAL boundary",
        );
      }
    } finally {
      await handle.close();
    }
  }

  async #ensureInitialized(): Promise<void> {
    const metadata = await stat(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!metadata) {
      await this.#installEmptyLog();
      return;
    }
    if (metadata.size >= AUTHORITY_WAL_FILE_HEADER_BYTES) {
      const handle = await open(this.logPath, "r");
      try {
        const header = Buffer.alloc(AUTHORITY_WAL_FILE_HEADER_BYTES);
        const { bytesRead } = await handle.read(
          header,
          0,
          header.byteLength,
          0,
        );
        if (bytesRead === header.byteLength) {
          try {
            this.#logId = decodeAuthorityWalFileHeader(header).logId;
            this.#logFormat = "versioned";
            return;
          } catch {
            // A non-header prefix may be the supported legacy frame format.
          }
        }
      } finally {
        await handle.close();
      }
    }
    this.#logId = await this.#loadOrCreateLegacyLogId();
    this.#logFormat = "legacy";
  }

  async #installEmptyLog(): Promise<void> {
    const orphanedIdentity = await stat(this.identityPath).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    if (orphanedIdentity) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Authority WAL is missing while its legacy identity remains",
      );
    }
    const temporaryPath = path.join(
      this.rootDir,
      `.authority-${randomBytes(8).toString("hex")}.tmp`,
    );
    // 新建日志写带版本头的格式:逐帧前缀链与日志身份是常数级追尾和 checkpoint
    // 帧级复验的载体,legacy 帧没有它们。既有 legacy 日志不在此路径,仍按原格式
    // 读写、不主动迁移,旧二进制因此始终能继续服务它自己创建的日志。
    const logIdBytes = randomBytes(LOG_ID_BYTES);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(encodeAuthorityWalFileHeader(logIdBytes));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.logPath);
      await syncDirectory(this.rootDir);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (isNodeError(error, "EEXIST")) {
        this.#logId = undefined;
        this.#logFormat = undefined;
        await this.#ensureInitialized();
        return;
      }
      throw error;
    }
    this.#logId = logIdBytes.toString("base64url");
    this.#logFormat = "versioned";
    await this.#recordVerifiedTail(0, emptyLogPrefix(this.#logId));
  }

  async #loadOrCreateLegacyLogId(): Promise<string> {
    const existing = await readFile(this.identityPath).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    if (existing) {
      return decodeAuthorityWalFileHeader(existing).logId;
    }
    const inputIdentity = { sourceFormat: "legacy", identity: "missing" };
    return this.#maintenanceRunner.run(
      storageMaintenanceObligation(
        "log-migration",
        this.rootDir,
        inputIdentity,
        { owner: "authority-commit-log", obligation: "committed" },
      ),
      currentMaintenanceAbortSignal(),
      () =>
        runStorageMaintenanceStep(
          this.#storageMaintenance,
          storageMaintenanceRequest(
            "log-migration",
            this.rootDir,
            inputIdentity,
            { obligation: "committed" },
          ),
          () => this.#createLegacyLogId(),
        ),
    );
  }

  async #createLegacyLogId(): Promise<string> {
    claimDeviceCapacity("temporaryBytes", AUTHORITY_WAL_FILE_HEADER_BYTES);
    claimDeviceCapacity("readBytes", AUTHORITY_WAL_FILE_HEADER_BYTES * 2);
    claimDeviceCapacity("writeBytes", AUTHORITY_WAL_FILE_HEADER_BYTES);
    claimDeviceCapacity("ioOperations", 8);
    const concurrentIdentity = await readFile(this.identityPath).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    if (concurrentIdentity) {
      return decodeAuthorityWalFileHeader(concurrentIdentity).logId;
    }
    const logIdBytes = randomBytes(LOG_ID_BYTES);
    const temporaryPath = path.join(
      this.rootDir,
      `.authority-identity-${randomBytes(8).toString("hex")}.tmp`,
    );
    const target = await open(temporaryPath, "wx", 0o600);
    try {
      await target.writeFile(encodeAuthorityWalFileHeader(logIdBytes));
      await target.sync();
    } catch (error) {
      await target.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await target.close();
    try {
      await link(temporaryPath, this.identityPath);
      await syncDirectory(this.rootDir);
      return logIdBytes.toString("base64url");
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        return decodeAuthorityWalFileHeader(await readFile(this.identityPath))
          .logId;
      }
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Atomic legacy WAL identity publication failed",
        { cause: error },
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #withLogLock<T>(operation: () => Promise<T>): Promise<T> {
    const maintenanceDeadline = Date.now() + 5_000;
    for (;;) {
      try {
        return await this.#operations.run(async () => {
          await ensureDurableDirectory(this.rootDir);
          const release = await acquireFileLock(this.#lockPath, {
            staleMs: this.#lockStaleMs,
            waitMs: this.#lockWaitMs,
            resourceName: "AuthorityCommitLog",
          });
          try {
            // 持有日志锁期间恒有权威操作在等待,故为前台。互斥区不在这里声明:
            // 外层 `#operations` 串行队列已单点标记,内层维护准入随之零等待——
            // 排队会把锁的持有时间拉到准入超时,阻塞全部其他持锁者。背压由本方法
            // 的锁外重试兜住。
            return await runInMaintenanceContext("foreground", async () => {
              await this.#ensureInitialized();
              return await operation();
            });
          } finally {
            await release();
          }
        });
      } catch (error) {
        // 可重试判据由 resources 层单点给出,这里不再内联。
        const retryAfterMs = maintenanceRetryDelayMs(error);
        // 内层日志锁已释放不代表调用栈已离开全部互斥区。若外层设施仍持有
        // 串行权，等待后重试会把容量背压扩散成整条设施队列阻塞；交给最外层
        // 所有者在退出其互斥区后重驱。
        if (
          retryAfterMs === undefined ||
          isHoldingMaintenanceExclusion() ||
          Date.now() >= maintenanceDeadline
        ) {
          throw error;
        }
        await waitForMaintenanceRetry(
          Math.min(retryAfterMs, Math.max(0, maintenanceDeadline - Date.now())),
        );
      }
    }
  }
}

function validateProjectionStreams(
  options: ProjectionReplayOptions,
): ReadonlySet<string> | undefined {
  if (options.stream !== undefined && options.streams !== undefined) {
    throw new TypeError(
      "Projection stream and streams options are mutually exclusive",
    );
  }
  const values =
    options.streams ??
    (options.stream === undefined ? undefined : [options.stream]);
  if (values === undefined) return undefined;
  if (values.length === 0) {
    throw new TypeError("Projection streams cannot be empty");
  }
  const unique = new Set<string>();
  for (const stream of values) {
    assertStream(stream);
    if (unique.has(stream)) {
      throw new TypeError("Projection streams cannot contain duplicates");
    }
    unique.add(stream);
  }
  return unique;
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

async function reduceRetainedReferenceIndex(
  envelope: CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
  artifactStore: FileArtifactStore,
): Promise<readonly DurableProjectionMutation[]> {
  try {
    const mutations = new RetainedReferenceMutationBuffer(current);
    for (const record of envelope.entries) {
      const deadConversation = deletedConversationOf(record);
      if (deadConversation !== undefined) {
        mutations.put(
          retainedDeadKey(deadConversation),
          retainedProjectionValue({ conversationId: deadConversation }),
        );
      }
      if (!isRetainingAuthorityRecord(record)) continue;
      const classified = classifyRetainedRecordReferences(record);
      for (const ref of classified.unconditional) {
        await mutations.retainUnconditional(ref);
      }
      for (const leaf of classified.conversationLeaves) {
        await mutations.retainLeaf(leaf.ref, leaf.conversationId);
      }
      for (const root of collectRegisteredArtifactRoots([record])) {
        const key = retainedRootKey(root);
        const existing = await mutations.get(key);
        if (existing !== undefined) {
          retainedRootMarker(existing, key);
          continue;
        }
        const bytes = await artifactStore.get(root.ref);
        const resolved = classifyRegisteredArtifactReferences(root, bytes);
        for (const ref of resolved.unconditional) {
          await mutations.retainUnconditional(ref);
        }
        for (const leaf of resolved.conversationLeaves) {
          await mutations.retainLeaf(leaf.ref, leaf.conversationId);
        }
        mutations.put(key, retainedProjectionValue({ key }));
      }
    }
    return mutations.values();
  } catch (error) {
    if (!(error instanceof RetainedReferenceProjectionValueError)) throw error;
    throw new DurableProjectionStorageError(
      "Retained reference reducer read invalid derived state",
      { cause: error },
    );
  }
}

class RetainedReferenceMutationBuffer {
  readonly #mutations = new Map<string, DurableProjectionMutation>();

  constructor(private readonly current: DurableProjectionReadContext) {}

  async get(key: string): Promise<JsonValue | undefined> {
    const mutation = this.#mutations.get(key);
    if (mutation !== undefined) {
      return mutation.kind === "put" ? mutation.value : undefined;
    }
    return this.current.get(key);
  }

  put(key: string, value: JsonValue): void {
    this.#mutations.set(key, { kind: "put", key, value });
  }

  async retainUnconditional(ref: ArtifactRef): Promise<void> {
    await this.#retainIdentity(ref);
    const key = retainedUnconditionalKey(ref.digest);
    this.put(key, retainedProjectionValue({ digest: ref.digest }));
  }

  async retainLeaf(ref: ArtifactRef, conversationId: string): Promise<void> {
    await this.#retainIdentity(ref);
    const key = retainedLeafKey(ref.digest, conversationId);
    const existing = await this.get(key);
    if (existing !== undefined) {
      const leaf = await resolveRetainedLeaf(this, existing, key);
      if (
        leaf.conversationId !== conversationId ||
        leaf.ref.digest !== ref.digest ||
        leaf.ref.bytes !== ref.bytes
      ) {
        throw invalidRetainedProjection(
          `Artifact ${ref.digest} has a conflicting retained leaf`,
        );
      }
      return;
    }
    this.put(
      key,
      retainedProjectionValue({ digest: ref.digest, conversationId }),
    );
  }

  values(): readonly DurableProjectionMutation[] {
    return [...this.#mutations.values()];
  }

  async #retainIdentity(ref: ArtifactRef): Promise<void> {
    const key = retainedReferenceKey(ref.digest);
    const existing = await this.get(key);
    if (existing !== undefined) {
      const stored = retainedArtifactRef(existing, key);
      if (stored.digest !== ref.digest || stored.bytes !== ref.bytes) {
        throw invalidRetainedProjection(
          `Artifact ${ref.digest} declares conflicting byte counts`,
        );
      }
      return;
    }
    this.put(key, retainedProjectionValue(ref));
  }
}

function retainedReferenceKey(digest: string): string {
  return `${RETAINED_REFERENCE_PREFIX}${digest}`;
}

function retainedUnconditionalKey(digest: string): string {
  return `${RETAINED_UNCONDITIONAL_PREFIX}${digest}`;
}

function retainedLeafPrefix(digest: string): string {
  return `${RETAINED_LEAF_PREFIX}${digest}/`;
}

function retainedLeafKey(digest: string, conversationId: string): string {
  return `${retainedLeafPrefix(digest)}${Buffer.from(
    conversationId,
    "utf8",
  ).toString("base64url")}`;
}

function retainedDeadKey(conversationId: string): string {
  return `${RETAINED_DEAD_PREFIX}${Buffer.from(conversationId, "utf8").toString(
    "base64url",
  )}`;
}

function retainedRootKey(root: unknown): string {
  return `${RETAINED_ROOT_PREFIX}${protocolDigest(
    "AuthorityRetainedReferenceRoot",
    1,
    root,
  )}`;
}

function retainedProjectionValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}

function retainedArtifactRef(value: JsonValue, key?: string): ArtifactRef {
  if (
    !isPlainRecord(value) ||
    typeof value.digest !== "string" ||
    !DIGEST_PATTERN.test(value.digest) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0
  ) {
    throw invalidRetainedProjection(
      "Retained artifact projection value is invalid",
    );
  }
  const ref = {
    digest: value.digest,
    bytes: value.bytes as number,
  };
  if (key !== undefined && retainedReferenceKey(ref.digest) !== key) {
    throw invalidRetainedProjection(
      "Retained artifact projection is not bound to its key",
    );
  }
  return ref;
}

function retainedLeafLocator(
  value: JsonValue,
  key: string,
): { readonly digest: string; readonly conversationId: string } {
  if (
    !isPlainRecord(value) ||
    typeof value.digest !== "string" ||
    !DIGEST_PATTERN.test(value.digest) ||
    typeof value.conversationId !== "string" ||
    value.conversationId.length === 0 ||
    Object.keys(value).length !== 2
  ) {
    throw invalidRetainedProjection(
      "Retained leaf projection value is invalid",
    );
  }
  const leaf = {
    digest: value.digest,
    conversationId: value.conversationId,
  };
  if (retainedLeafKey(leaf.digest, leaf.conversationId) !== key) {
    throw invalidRetainedProjection(
      "Retained leaf projection is not bound to its key",
    );
  }
  return leaf;
}

async function resolveRetainedLeaf(
  current: Pick<DurableProjectionReadContext, "get">,
  value: JsonValue,
  key: string,
): Promise<{ readonly ref: ArtifactRef; readonly conversationId: string }> {
  const leaf = retainedLeafLocator(value, key);
  const primaryKey = retainedReferenceKey(leaf.digest);
  const primary = await current.get(primaryKey);
  if (primary === undefined) {
    throw invalidRetainedProjection(
      `Retained leaf ${key} has no canonical artifact record`,
    );
  }
  return {
    ref: retainedArtifactRef(primary, primaryKey),
    conversationId: leaf.conversationId,
  };
}

function retainedConversationId(value: JsonValue, key: string): string {
  const record = isPlainRecord(value) ? value : undefined;
  if (
    typeof record?.conversationId !== "string" ||
    record.conversationId.length === 0 ||
    retainedDeadKey(record.conversationId) !== key
  ) {
    throw invalidRetainedProjection(
      "Retained conversation projection value is invalid",
    );
  }
  return record.conversationId;
}

function retainedUnconditionalDigest(value: JsonValue, key: string): string {
  const record = isPlainRecord(value) ? value : undefined;
  if (
    typeof record?.digest !== "string" ||
    !DIGEST_PATTERN.test(record.digest) ||
    retainedUnconditionalKey(record.digest) !== key
  ) {
    throw invalidRetainedProjection(
      "Retained unconditional projection is not bound to its key",
    );
  }
  return record.digest;
}

function retainedRootMarker(value: JsonValue, key: string): void {
  const record = isPlainRecord(value) ? value : undefined;
  if (record?.key !== key || Object.keys(record).length !== 1) {
    throw invalidRetainedProjection(
      "Retained root projection is not bound to its key",
    );
  }
}

function invalidRetainedProjection(
  message: string,
): RetainedReferenceProjectionValueError {
  return new RetainedReferenceProjectionValueError(message);
}

class RetainedReferenceProjectionValueError extends DurableProjectionStorageError {
  constructor(message: string) {
    super(message);
    this.name = "RetainedReferenceProjectionValueError";
  }
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
    if (!isPlainRecord(entry))
      throw invalidEnvelope("Logical record must be an object");
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
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new TypeError(
      "Commit envelope time must be a canonical ISO timestamp",
    );
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

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
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

function retainingAuthorityRecords<Body>(
  records: readonly LogicalRecord<Body>[],
): LogicalRecord<Body>[] {
  return records.filter((record) => isRetainingAuthorityRecord(record));
}

function collectRetainedArtifactRefs<Body>(
  records: readonly LogicalRecord<Body>[],
): ArtifactRef[] {
  return collectArtifactRefs(retainingAuthorityRecords(records));
}

function invalidEnvelope(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function assertReplayLsn(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "Projection replay LSN must be a non-negative safe integer",
    );
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

function createCommitEnvelope<Body>(
  lsn: number,
  at: IsoTime,
  entries: Array<LogicalRecord<Body>>,
): CommitEnvelope<Body> {
  if (!Number.isSafeInteger(lsn) || lsn <= 0) {
    throw new AuthorityStorageError(
      "commit-log-corrupt",
      "Commit log LSN exhausted the safe integer range",
    );
  }
  assertCanonicalTime(at);
  const payload = { v: 1 as const, lsn, at, entries };
  return {
    ...payload,
    envelopeDigest: protocolDigest("CommitEnvelope", 1, payload),
  };
}

function advanceProjectionPrefix(
  logId: string,
  previousDigest: string,
  envelope: CommitEnvelope<unknown>,
): string {
  return protocolDigest("AuthorityLogPrefix", 1, {
    logId,
    previousDigest,
    lsn: envelope.lsn,
    envelopeDigest: envelope.envelopeDigest,
  });
}

function emptyLogPrefix(logId: string): string {
  return protocolDigest("AuthorityLogPrefix", 1, { logId });
}

function validateDurableProjectionId(projectionId: string): string {
  durableProjectionDirectoryName(projectionId);
  return projectionId;
}

function projectionTransactionContext(
  lastLsn: number,
  at: IsoTime,
  readProjections: ReadonlyMap<string, DurableProjectionReadContext>,
): ProjectionTransactionContext {
  return {
    lastLsn,
    nextLsn: lastLsn + 1,
    at,
    readProjection(projectionId) {
      const projection = readProjections.get(projectionId);
      if (!projection) {
        throw new TypeError(
          `Durable projection was not selected for this transaction: ${projectionId}`,
        );
      }
      return projection;
    },
  };
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
  logId: string,
  metadata: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    cursor.logId === logId &&
    cursor.logPath === logPath &&
    cursor.device === metadata.dev &&
    cursor.inode === metadata.ino &&
    cursor.byteOffset >= 0 &&
    cursor.byteOffset === metadata.size &&
    cursor.modifiedAt === metadata.mtimeMs &&
    cursor.changedAt === metadata.ctimeMs
  );
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

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
