import { closeArtifactJsonIndex } from "./artifact-json-index.js";
import { createHash, randomBytes, type Hash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldToIo } from "node:timers/promises";
import type { LogRecordPort } from "../logging/contracts.js";
import { authorityObservationRefs, AuthorityWorkObserver, type AuthorityWork } from "./logging.js";
import {
  link,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
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
import type { AuthorityAppendAdmissionGuard, AuthorityTailConsumer } from "./interfaces.js";
import {
  createFileLockAcquirer,
  ensureDurableDirectory,
  syncDirectory,
  FileLockBusyError,
} from "../persistence/index.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";
import { canonicalize, protocolDigest, protocolDigestOfCanonicalParts, verifyProtocolStep } from "../protocol/index.js";
import {
  claimDeviceCapacity,
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  runDetachedMaintenanceContext,
  runInMaintenanceContext,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
  DeviceCapacityAdmissionError,
  DeviceCapacityStepError,
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
  isNormalizedProjectionMutations,
  projectionMutationKeyCount,
  type NormalizedProjectionMutations,
  createBoundDurableProjectionReadContext,
  durableProjectionDirectoryName,
  durableProjectionVersionDirectoryName,
  DurableProjectionStorageError,
  FileDurableProjectionIndex,
  type DurableProjectionCheckpoints,
  type DurableProjectionDefinition,
  type DurableProjectionInputs,
  type FileDurableProjectionIndexOptions,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type DurableProjectionScanRange,
  type DurableProjectionScanPage,
  type RebuildableDurableProjectionIndex,
} from "./durable-projection-index.js";
import { freezeProjectionInputs, projectionConsumes } from "./projection-inputs.js";
import { AUTHORITY_RECOVERY_BUDGET, AuthorityPreparationRequired, AuthorityProjectionUnavailable, authorityTailNeedsFlush, authorityTailWithinInlineBudget, maximumAuthorityRecoveryTailBytes, type AuthorityPreparedWatermark } from "./recovery-work.js";
import { AuthorityStorageError } from "./errors.js";
import { ProtocolIdentityNotLoaded, untrustedProtocolSignature } from "../protocol/verification-identities.js";
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
  AUTHORITY_WAL_HEADER_BYTES,
  AUTHORITY_WAL_SCAN_SLICE_MS,
  decodeAuthorityWalFileHeader,
  encodeAuthorityWalFileHeader,
  encodeAuthorityWalFrame,
  scanAuthorityWalFrames,
  decodeAuthorityWalFrame,
  verifyAuthorityWalFrameBoundary,
} from "./wal-frame.js";
import { fileReader } from "./wal-file-reader.js";
import { durablyRemoveDirectory, durablyRemoveFiles } from "../persistence/durable-removal.js";
import {
  VERIFIED_WAL_FRAME_RETAINED_BYTES,
  matchesWalVersion,
  readWalVersion,
  type WalFileVersion,
  verifiedWalViews,
  type VerifiedWalFrame,
  type VerifiedWalTail as VerifiedLogTail,
  type VerifiedWalView,
  DEFAULT_VERIFIED_WAL_VIEW_LIMITS,
  type VerifiedWalViewLimits,
  extendVerifiedWalView,
  verifiedViewPayload,
} from "./verified-wal-view.js";
import {
  AuthorityCacheIntegrity,
  DEFAULT_HOST_AUTHORITY_LOG_PROFILE,
  type HostAuthorityLogProfile,
  decodeProjectionCheckpoint,
  encodeProjectionCheckpoint,
  peekProjectionCheckpointKey,
} from "./startup-proofs.js";
import {
  AuthenticatedFrameIndex,
  FrameIndexUnavailableError,
  decodeFrameIndexRow,
  frameIndexRowStreams,
  frameStreamBloomMask,
  frameStreamTag,
  type FrameIndexRow,
} from "./frame-index.js";

export const MAX_INLINE_LOGICAL_RECORD_BYTES = 32 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STREAM_PATTERN =
  /^(?:control|publish|governor|final-outbox|trust|exposure|delivery|pairing|checkpoint|device-lifecycle|extensions|member-connection|home-route-material|superseded-trust|discovery-progress|(?:run|job|transfer|intent|assignment|executor|session-activity):[^\u0000-\u001f\u007f]{1,480})$/u;
const LOG_ID_BYTES = 32;
const RETAINED_REFERENCE_PROJECTION_ID = "authority-retained-references";
const RETAINED_REFERENCE_PREFIX = "retention/reference/";
const RETAINED_UNCONDITIONAL_PREFIX = "retention/unconditional/";
const RETAINED_LEAF_PREFIX = "retention/leaf/";
const RETAINED_DEAD_PREFIX = "retention/dead/";
const RETAINED_ROOT_PREFIX = "retention/root/";
const RETAINED_SCAN_PAGE_SIZE = 256;
/** 相邻操作之间保留写者锁的空闲时长：覆盖同一调用链上前后相接的 await，不让其他进程久等。 */
const LOCK_SESSION_LINGER_MS = 20;
/** 单次连续持锁的上限；到期在操作边界释放，让其他写者有机会进入。 */
const LOCK_SESSION_MAX_HOLD_MS = 500;
/** 同一进程内处于空闲保留期的写者锁会话；其他实例需要同一把锁时立即收回，不必等保留期结束。 */
const idleLockSessions = new Map<string, () => Promise<void>>();

/** 跨连续操作持有的写者锁：省去逐次取锁、放锁的文件往返，不改变每次操作的字节核验。 */
interface CommitLogLockSession {
  readonly release: () => Promise<void>;
  readonly acquiredAt: number;
  readonly close: () => Promise<void>;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** 本会话内逐次字节核验共用的读取缓冲。 */
  comparison?: Buffer;
}

export interface FileAuthorityCommitLogOptions {
  /** Read authority facts without creating or repairing persistent state. */
  readonly readOnly?: boolean;
  /** Only the lifecycle owner may keep physical read views between calls. */
  readonly owner?: boolean;
  readonly integrity?: AuthorityCacheIntegrity;
  readonly hostLogProfile?: HostAuthorityLogProfile;
  readonly records?: LogRecordPort;
  readonly clock?: () => IsoTime;
  readonly lockStaleMs?: number;
  readonly lockWaitMs?: number;
  /** 连续操作之间保留写者锁的空闲时长；0 表示每次操作结束即释放。 */
  readonly lockSessionLingerMs?: number;
  /** 单次连续持锁的上限；到期在操作边界释放。 */
  readonly lockSessionMaxHoldMs?: number;
  /**
   * 为本日志保存与使用启动证明（已核验帧证明、投影检查点）。只对长期存在、启动时
   * 必经的主日志开启；仍需宿主登记代码身份后才生效。
   */
  readonly startupProofs?: boolean;
  /**
   * 文件身份与时间戳均未变时，两次整份字节比对之间的最短间隔（毫秒）。未给出时：
   * 开启启动证明且宿主已登记的日志取宿主参数，其余为 0，即每次操作都比对。大于 0
   * 时，保留时间戳的带外原地改写最迟在该间隔后的下一次操作被发现；任何元数据变化
   * 仍立即触发比对。
   */
  readonly walReverifyIntervalMs?: number;
  /** 本日志已核验视图的保留上限；未给出时取法同上，默认沿用全局上限。 */
  readonly verifiedViewLimits?: VerifiedWalViewLimits;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  /** Caller data reads have a leaf budget separate from workload occupancy. */
  readonly runProjectionReadStep?: FileDurableProjectionIndexOptions["runReadStep"];
  /** 派生投影从权威源重建时内存中保留的状态上限；未给出取默认的固定上限。 */
  readonly projectionRebuildOverlayBytes?: number;
}

export interface PlannedAnchorPrefixInstallation<Body> {
  readonly source: AsyncIterable<CommitEnvelope<Body>>;
  readonly sourceHead: DurableLogCheckpoint;
  readonly installationEntries: readonly LogicalRecord<Body>[];
  readonly candidateReferences: readonly ArtifactRef[];
}

export interface RetainedReferenceQueryOptions {
  /**
   * 额外的会话删除 tombstone(来自持有削除事实的权威日志):内容叶所有权
   * 单源在会话权威,不持有该事实的日志由调用方传入并集判定。
   */
  readonly deadConversations?: ReadonlySet<string>;
}

interface ScannedLog {
  readonly lastLsn: number;
  readonly validBytes: number;
  readonly prefixDigest: string;
  readonly incompleteTail?: Buffer;
  readonly stopped?: true;
  readonly physicalHash?: Hash;
  readonly reused?: true;
}

interface VerifiedEnvelopeProof {
  readonly lsn: number;
  readonly envelopeDigest: string;
  readonly logId: string;
  readonly previousPrefix: string;
  readonly prefixDigest: string;
  /** Present only when every record in these validated bytes belongs to one stream. */
  readonly singleStream?: string;
}

type EnvelopeSelection = (proof: {
  readonly lsn: number;
  readonly singleStream?: string;
  readonly streamTag?: bigint;
  readonly streamBloom?: bigint;
}) => boolean;

function projectionEnvelopeSelection(streams: ReadonlySet<string> | undefined, requiredLsn?: number): EnvelopeSelection | undefined {
  if (!streams) return undefined;
  // 认证帧索引只给出流标记：标记相同才可能属于所选流（碰撞只会多读一帧，不会漏读）。
  // 多流信封只有布隆位图：所选任一流的位全在位图中才可能涉及该流。
  const tags = new Set([...streams].map(frameStreamTag));
  const masks = [...streams].map(frameStreamBloomMask);
  return proof => proof.lsn === requiredLsn || (
    proof.singleStream !== undefined ? streams.has(proof.singleStream)
      : proof.streamTag !== undefined ? tags.has(proof.streamTag)
        : proof.streamBloom !== undefined ? masks.some((mask) => (proof.streamBloom! & mask) === mask) : true);
}

// Validation is a pure function of the bytes, independent of a log instance.
// Digest proofs also accelerate scans after a file version changes. A bounded
// verified WAL view separately shares one proven version, never reducer objects.
const validatedEnvelopes = new Map<string, VerifiedEnvelopeProof>();
const VALIDATED_ENVELOPE_LIMIT = 65_536;
// 每个已核验视图最近一次整份字节比对的时刻；追加延伸出的视图继承它。
const viewComparedAt = new WeakMap<VerifiedWalView, number>();
/** 认证模式下帧索引写盘的空闲延迟；崩溃只让下次启动多续扫这段时间内追加的尾部。 */
const FRAME_INDEX_FLUSH_DELAY_MS = 1_000;
/** 认证模式下的历史帧巡检：打开后延迟首次进行，此后按周期重复。 */
const FRAME_INDEX_AUDIT_DELAY_MS = 120_000;
const FRAME_INDEX_AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/** 一次持锁巡检的帧数上限，批间让出日志锁。 */
const FRAME_INDEX_AUDIT_BATCH = 256;
const FRAME_INDEX_AUDIT_PAUSE_MS = 20;
/** 认证读取的单个读窗口上限（单帧超出时独占一个窗口）。 */
const AUTHENTICATED_READ_WINDOW_BYTES = 1024 * 1024;
/** 两个被选中帧之间允许顺带读过的最大间隔。 */
const AUTHENTICATED_READ_GAP_BYTES = 128 * 1024;
/** 认证读取一次筛出并解码的行数上限：读取在其中途停止时不为其后的行付出解码成本。 */
const AUTHENTICATED_ROW_BATCH = 1024;
/** 等待完整性密钥的上限；超时的实例在本次生命周期内按严格模式运行。 */

/** 派生缓存文件只需整体替换：写入临时文件再改名，读者要么看到旧版要么看到新版。 */
async function writeReplacing(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

class FileProjectionCursor implements ProjectionCursor {
  constructor(
    readonly lsn: number,
    readonly logId: string,
    readonly logPath: string,
    readonly device: bigint | undefined,
    readonly inode: bigint | undefined,
    readonly byteOffset: number,
    readonly modifiedAt: bigint | undefined,
    readonly changedAt: bigint | undefined,
    readonly prefixDigest: string,
    readonly physicalDigest?: string,
  ) {}
}

interface RegisteredDurableProjection {
  synchronized?: true;
  opened?: true;
  failure?: unknown;
  recoveryReset?: true;
  readonly authenticated: boolean;
  readonly startAtSource: boolean;
  readonly state: FileDurableProjectionIndex;
  readonly read: DurableProjectionReadContext & Pick<RebuildableDurableProjectionIndex, "getMany">;
  readonly reduce: DurableProjectionDefinition<JsonValue>["reduce"];
  readonly inputs: DurableProjectionInputs | undefined;
}

/** 持日志锁期间可用的源读取（与 readStreamEnvelopes / readEnvelopeAt 相同，但不再加锁）。 */
export interface LockedSourceReader {
  readStreamEnvelopes<Body = JsonValue>(streams: readonly string[], afterLsn: number, throughLsn: number, limit?: number): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[]; readonly checkpoints: readonly DurableLogCheckpoint[]; readonly lastLsn: number; readonly hasMore: boolean;
  }>;
  readEnvelopeAt<Body = JsonValue>(checkpoint: DurableLogCheckpoint): Promise<CommitEnvelope<Body>>;
}

export class FileAuthorityCommitLog implements AuthorityCommitLog {
  readonly #sourceScope = new AsyncLocalStorage<{ active: boolean }>();
  readonly #readOnly: boolean;
  readonly #owner: boolean;
  #readOnlyLegacyId: string | undefined;
  readonly #acquireFileLock = createFileLockAcquirer();
  readonly #records: LogRecordPort | undefined;
  readonly #workObserver: AuthorityWorkObserver;
  readonly #checkpointViews = new WeakMap<DurableLogCheckpoint, FileProjectionCursor>();
  #work: AuthorityWork | undefined;
  /** One verified snapshot per exclusive operation; never survives the operation. */
  #operationView: VerifiedWalView | undefined;
  #lockSession: CommitLogLockSession | undefined;
  #lockSessionClosing: Promise<void> | undefined;
  /** 已进入本日志串行队列（排队或执行中）的加锁操作数。 */
  #lockedOperations = 0;
  readonly rootDir: string;
  readonly logPath: string;
  readonly identityPath: string;
  readonly quarantineDir: string;
  readonly artifactStore: FileArtifactStore;
  readonly #lockPath: string;
  readonly #clock: () => IsoTime;
  readonly #lockStaleMs: number;
  readonly #lockWaitMs: number;
  readonly #lockSessionLingerMs: number;
  readonly #lockSessionMaxHoldMs: number;
  readonly #projectionRebuildOverlayBytes: number | undefined;
  readonly #startupProofs: boolean;
  readonly #integrity: AuthorityCacheIntegrity | undefined;
  readonly #walReverifyIntervalMs: number;
  readonly #viewLimits: VerifiedWalViewLimits;
  readonly #operations = new SerialTaskQueue();
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  readonly #runProjectionReadStep: FileAuthorityCommitLogOptions["runProjectionReadStep"];
  readonly #durableProjections = new Map<string, RegisteredDurableProjection>();
  readonly #artifactProjections = new Map<string, { readonly state: FileDurableProjectionIndex; readonly cache: import('./interfaces.js').ArtifactProjectionCache }>();
  readonly #artifactPreparationAbort = new AbortController();
  readonly #artifactPreparations = new Set<Promise<unknown>>();
  readonly #refreshedProjections = new Set<RegisteredDurableProjection>();
  #stopMaintenance: Promise<void> | undefined;
  readonly #appendAdmissionGuards = new Set<AuthorityAppendAdmissionGuard>();
  readonly #tailConsumers = new Set<AuthorityTailConsumer>();
  // Only byte-validation proofs, never shared mutable envelopes or business state.
  #verifiedTail: VerifiedLogTail | undefined;
  #logId: string | undefined;
  #logFormat: "legacy" | "versioned" | undefined;
  /** 认证模式（开启启动证明、带版本头的日志、完整性密钥就绪）；每个实例判定一次。 */
  /** 认证模式下本日志的帧索引，与 #verifiedTail 覆盖到同一个尾部。 */
  #frameIndex: AuthenticatedFrameIndex | undefined;
  #readOnlyIndexUsable: boolean | undefined;
  #readOnlyIndexLogId: string | undefined;
  #frameIndexFlushTimer: ReturnType<typeof setTimeout> | undefined;
  #frameIndexAuditTimer: ReturnType<typeof setTimeout> | undefined;
  #frameIndexAudit: Promise<unknown> | undefined;
  readonly #frameIndexAuditAbort = new AbortController();
  /** 停止维护之后不再安排任何后台写盘或巡检。 */
  #maintenanceStopped = false;

  constructor(
    rootDir: string,
    artifactStore: FileArtifactStore,
    options: FileAuthorityCommitLogOptions = {},
  ) {
    const records = options.records;
    this.#records = records ? { record(draft) { try { records.record(draft); } catch { /* Observation never changes a durable business outcome. */ } } } : undefined;
    this.#workObserver = new AuthorityWorkObserver(options.records, () => this.#logId);
    this.rootDir = path.resolve(rootDir);
    this.logPath = path.join(this.rootDir, "authority.log");
    this.identityPath = path.join(this.rootDir, "authority.log.identity");
    this.quarantineDir = path.join(this.rootDir, "bad-tail");
    this.artifactStore = artifactStore;
    this.#lockPath = path.join(this.rootDir, ".commit-log.lock");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#lockStaleMs = options.lockStaleMs ?? 30_000;
    this.#lockWaitMs = options.lockWaitMs ?? 10_000;
    this.#lockSessionLingerMs = options.lockSessionLingerMs ?? LOCK_SESSION_LINGER_MS;
    if (!Number.isFinite(this.#lockSessionLingerMs) || this.#lockSessionLingerMs < 0) {
      throw new TypeError("Authority lock session linger must be a non-negative finite duration");
    }
    this.#lockSessionMaxHoldMs = options.lockSessionMaxHoldMs ?? LOCK_SESSION_MAX_HOLD_MS;
    this.#projectionRebuildOverlayBytes = options.projectionRebuildOverlayBytes;
    if (!Number.isFinite(this.#lockSessionMaxHoldMs) || this.#lockSessionMaxHoldMs < 0) {
      throw new TypeError("Authority lock session hold limit must be a non-negative finite duration");
    }
    this.#integrity = options.integrity;
    this.#readOnly = options.readOnly === true;
    this.#owner = options.owner !== false;
    this.#startupProofs = options.startupProofs ?? options.integrity !== undefined;
    const profile = this.#startupProofs ? options.hostLogProfile ?? DEFAULT_HOST_AUTHORITY_LOG_PROFILE : undefined;
    // 严格模式默认每次操作都整份比对；按间隔复用只在调用方显式给出时生效。
    this.#walReverifyIntervalMs = options.walReverifyIntervalMs ?? 0;
    if (!Number.isFinite(this.#walReverifyIntervalMs) || this.#walReverifyIntervalMs < 0) {
      throw new TypeError("Authority WAL reverify interval must be a non-negative finite duration");
    }
    this.#viewLimits = options.verifiedViewLimits ?? profile?.verifiedViewLimits ?? DEFAULT_VERIFIED_WAL_VIEW_LIMITS;
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#storageMaintenance = options.storageMaintenance;
    this.#runProjectionReadStep = options.runProjectionReadStep;
    this.durableProjection({
      projectionId: RETAINED_REFERENCE_PROJECTION_ID,
      reducerVersion: 4,
      reduce: (envelope, current) =>
        reduceRetainedReferenceIndex(envelope, current, this.artifactStore),
    });
  }

  /**
   * 回收一个已被替代、只可能由旧二进制打开的投影版本目录（即旧版本的无后缀目录）。调用方
   * 必须先证明旧读者已经原生退出；这里只负责确认该目录确属这个投影的被替代版本、不是本实例
   * 正在使用的目录，然后逐页先取资源再进日志锁耐久删除，可重入接续，以目录消失为完成。
   * 停止维护时在页边界停下，留待下次启动接续。
   */
  async reclaimRetiredProjectionVersion(projectionId: string, retiredVersion: number,
    layout: "legacy" | "versioned" = "legacy"): Promise<"absent" | "removed" | "stopped"> {
    if (this.#readOnly) throw new TypeError("Authority log is read-only");
    const directory = path.join(this.rootDir, "projections", layout === "legacy"
      ? durableProjectionDirectoryName(projectionId) : durableProjectionVersionDirectoryName(projectionId, retiredVersion));
    const current = this.#durableProjections.get(projectionId);
    if (current && (current.state.reducerVersion === retiredVersion ||
        path.resolve(current.state.rootDir) === path.resolve(directory))) {
      throw new TypeError("A projection version in use cannot be reclaimed");
    }
    const checkVersion = async () => {
    const manifest = await readFile(path.join(directory, "manifest.json"), "utf8").then(
      (text) => JSON.parse(text) as { projectionId?: unknown; reducerVersion?: unknown },
      (error: unknown) => { if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined; throw error; },
    );
    if (manifest && (manifest.projectionId !== projectionId || manifest.reducerVersion !== retiredVersion)) {
      throw new AuthorityStorageError("commit-log-corrupt", "Projection directory does not hold the retired version");
    }
    };
    const inputIdentity = { projectionId, retiredVersion, layout };
    let removedAny = false;
    let retryDeadline = Date.now() + 5_000;
    for (;;) {
      if (this.#maintenanceStopped) return "stopped";
      let page: "absent" | "page" | "removed";
      try { page = await this.#maintenanceRunner.run(
        storageMaintenanceObligation("projection-compaction", directory, inputIdentity,
          { owner: "durable-projection-index", obligation: "committed" }),
        currentMaintenanceAbortSignal(),
        () => runStorageMaintenanceStep(this.#storageMaintenance,
          storageMaintenanceRequest("projection-compaction", directory, inputIdentity, { obligation: "committed" }),
          () => this.#withLogLock("projection.retire", async () => {
            await checkVersion();
            return reclaimDirectoryPage(directory);
          }, true)),
      ); } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || Date.now() >= retryDeadline) throw error;
        // The rejected step released its resource permit and source fence.
        await waitForMaintenanceRetry(Math.min(delay, Math.max(0, retryDeadline - Date.now())));
        continue;
      }
      retryDeadline = Date.now() + 5_000;
      if (page === "absent") return removedAny ? "removed" : "absent";
      removedAny = true;
      if (page === "removed") return "removed";
      await yieldToIo();
    }
  }

  /** 当前异步调用链是否正处在本日志的某个持锁操作之内（日志锁不可重入）。 */
  holdsOperation(): boolean {
    return this.#sourceScope.getStore()?.active === true;
  }

  /** Identity of the source last verified by this owner, never a second fact. */
  sourceIdentity(): string | undefined {
    const tail = this.#verifiedTail;
    return tail ? `${tail.logId}:${tail.device}:${tail.inode}` : this.#logId;
  }

  /** Exact dependent read. Reuses an already-held source fence or attempts it
   * without waiting, so a verifier cannot invert two logs' lock order. */
  async readPreparedProjection<Value>(projectionId: string,
    read: (current: DurableProjectionReadContext, context: ProjectionTransactionContext) => Promise<Value>): Promise<Value> {
    const operation = async () => {
      const projection = this.#durableProjections.get(projectionId);
      if (!projection) throw new TypeError(`Durable projection is not registered: ${projectionId}`);
      const head = this.#durableCheckpoint(await this.#loadLastLsn());
      await this.#openDurableProjection(projection, head);
      if (projection.failure !== undefined) throw projection.failure;
      if (!projection.synchronized && projection.state.readiness() === "ready" &&
          authorityTailWithinInlineBudget(projection.state.checkpoints().authority!, head)) {
        await this.#catchUpInline([projectionId], []);
      }
      if (!projection.synchronized) throw new AuthorityPreparationRequired([projectionId]);
      return read(projection.read, this.#transactionContext(head.lsn, this.#clock(), new Map([[projectionId, projection.read]])));
    };
    return this.holdsOperation() ? operation() : this.#withLogLock("projection.get", operation, true);
  }

  async append<Body>(
    entries: readonly LogicalRecord<Body>[],
  ): Promise<CommitEnvelope<Body>> {
    if (this.#readOnly) throw new TypeError("Authority log is read-only");
    if (entries.length === 0) {
      throw new TypeError(
        "A commit envelope must contain at least one logical record",
      );
    }
    const normalizedEntries = normalizeEntries(entries);
    const references = collectRetainedArtifactRefs(normalizedEntries);
    const appendOperation = () =>
      this.#withLogLock("append", () => this.#append(normalizedEntries));
    return references.length === 0
      ? appendOperation()
      : this.artifactStore.withPresentReferences(references, appendOperation);
  }

  async readAll<Body = JsonValue>(): Promise<Array<CommitEnvelope<Body>>> {
    return [...(await this.readSnapshot<Body>()).commits];
  }

  async readSnapshot<Body = JsonValue>(): Promise<AuthorityLogSnapshot<Body>> {
    return this.#withLogLock("readSnapshot", async () => {
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
    return this.#withLogLock("readStream", async () => {
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
      }, 0, projectionEnvelopeSelection(new Set([stream])));
      return records;
    });
  }

  durableProjection<Body = JsonValue>(
    definition: DurableProjectionDefinition<Body>,
  ): RebuildableDurableProjectionIndex {
    const inputs = freezeProjectionInputs(definition.inputs);
    for (const stream of inputs?.streams ?? []) assertStream(stream);
    const existing = this.#durableProjections.get(definition.projectionId);
    if (existing) {
      if (existing.state.reducerVersion !== definition.reducerVersion ||
          existing.startAtSource !== (definition.startAtSource !== undefined && definition.startAtSource !== false) ||
          JSON.stringify(existing.inputs) !== JSON.stringify(inputs) ||
          (definition.authenticated !== undefined && existing.authenticated !== definition.authenticated)) {
        throw new TypeError(
          "Durable projection reducer version is inconsistent",
        );
      }
      return this.#boundProjection(existing);
    }
    const state = new FileDurableProjectionIndex({
      authenticated: this.#readOnly || definition.authenticated,
      integrity: this.#integrity,
      rootDir: path.join(
        this.rootDir,
        "projections",
        durableProjectionVersionDirectoryName(definition.projectionId, definition.reducerVersion),
      ),
      legacyRootDir: path.join(this.rootDir, "projections", durableProjectionDirectoryName(definition.projectionId)),
      readOnly: this.#readOnly,
      managedRecovery: true,
      allowSegmentReclamation: this.#owner,
      withSourceLock: (operation, abort) => this.#sourceScope.getStore()?.active
        ? operation() : this.#withLogLock("projection.checkpoint", operation,
          isHoldingMaintenanceExclusion(), abort ?? currentMaintenanceAbortSignal()),
      runDetached: operation => this.#sourceScope.exit(operation),
      projectionId: definition.projectionId,
      reducerVersion: definition.reducerVersion,
      ...(definition.startAtSource ? { startAtSource: definition.startAtSource } : {}),
      ...(definition.seedAtSource ? { seedAtSource: definition.seedAtSource } : {}),
      storageMaintenance: this.#storageMaintenance,
      runReadStep: this.#runProjectionReadStep,
      ...(this.#projectionRebuildOverlayBytes === undefined ? {} : { rebuildOverlayBytes: this.#projectionRebuildOverlayBytes }),
    });
    const registered: RegisteredDurableProjection = {
      inputs,
      authenticated: definition.authenticated === true,
      startAtSource: definition.startAtSource !== undefined && definition.startAtSource !== false,
      // Replayed derived rows stay in the existing bounded overlay. prepare()
      // spills before its original bounds; reading a short suffix alone does
      // not manufacture a new delta and force a full historical compaction.
      state,
      read: createBoundDurableProjectionReadContext(state),
      reduce: definition.reduce as RegisteredDurableProjection["reduce"],
    };
    this.#durableProjections.set(definition.projectionId, registered);
    return this.#boundProjection(registered);
  }

  async checkpoint(previous?: DurableLogCheckpoint): Promise<DurableLogCheckpoint> {
    const proof = previous && this.#checkpointViews.get(previous);
    if (previous && proof && previous.logId === proof.logId && previous.lsn === proof.lsn &&
        previous.frameEndOffset === proof.byteOffset && previous.prefixDigest === proof.prefixDigest &&
        await this.#hasUnchangedReadView("checkpoint", proof)) return previous;
    return this.#withLogLock("checkpoint", async () => {
      const lastLsn = await this.#loadLastLsn();
      const checkpoint = Object.freeze(this.#durableCheckpoint(lastLsn));
      this.#checkpointViews.set(checkpoint, this.#projectionCursor(lastLsn));
      return checkpoint;
    });
  }

  artifactProjection(binding: { readonly projectionId: string; readonly reducerVersion: number;
    readonly artifact: ArtifactRef; readonly ownerCheckpoint: DurableLogCheckpoint }): import('./interfaces.js').ArtifactProjectionCache {
    const { ownerCheckpoint, ...identityBinding } = binding;
    if (ownerCheckpoint.logId !== this.#requireLogId()) throw new TypeError('Artifact projection belongs to another authority owner');
    const key = canonicalize({ ...identityBinding, ownerLogId: ownerCheckpoint.logId }), existing = this.#artifactProjections.get(key);
    if (existing) return existing.cache;
    const identity = createHash('sha256').update(canonicalize(identityBinding)).digest('hex');
    const checkpoints = { owner: ownerCheckpoint };
    const locked = <T>(operation: () => Promise<T>, abort?: AbortSignal) => this.#sourceScope.getStore()?.active
      ? operation() : this.#withLogLock('projection.prepare', operation,
        isHoldingMaintenanceExclusion(), abort ?? currentMaintenanceAbortSignal());
    const state = new FileDurableProjectionIndex({
      projectionId: binding.projectionId, reducerVersion: binding.reducerVersion, authenticated: true,
      integrity: this.#integrity, readOnly: this.#readOnly, managedRecovery: false,
      rootDir: path.join(this.rootDir, 'projections', durableProjectionVersionDirectoryName(binding.projectionId, binding.reducerVersion), identity),
      allowSegmentReclamation: this.#owner, withSourceLock: locked,
      runDetached: operation => this.#sourceScope.exit(operation), storageMaintenance: this.#storageMaintenance,
      runReadStep: this.#runProjectionReadStep,
    });
    const open = async () => { await state.initialize(checkpoints); await state.refreshPublishedState(); };
    // 续读不保留读视图：消费方按键续读，保留下来的旧代际视图会把这份投影的回收挡到租期结束。
    // 续读位置只绑定区间与上一页末键，与日志投影的逻辑续读相同。
    const view = createBoundDurableProjectionReadContext({
      get: key => state.get(key),
      getMany: keys => state.getMany(keys),
      scan: async (range, limit, continuation) => {
        const rangeIdentity = canonicalize(range);
        let resumed: DurableProjectionScanRange = range;
        if (continuation !== undefined) {
          const token = JSON.parse(Buffer.from(continuation, 'base64url').toString('utf8')) as { range?: unknown; after?: unknown };
          if (token.range !== rangeIdentity || typeof token.after !== 'string') throw new TypeError('Artifact projection continuation is invalid');
          const { gte: _gte, gt: _gt, ...rest } = range;
          resumed = { ...rest, gt: token.after };
        }
        const page = await state.scan(resumed, limit);
        if (!page.continuation) return page;
        state.releaseContinuation(page.continuation);
        return { entries: page.entries, continuation: Buffer.from(JSON.stringify({ range: rangeIdentity, after: page.entries.at(-1)!.key })).toString('base64url') };
      },
    });
    const cache: import('./interfaces.js').ArtifactProjectionCache = {
      prepare: operation => {
        if (this.#maintenanceStopped) return Promise.reject(new StorageMaintenanceCancelledError());
        const pending = this.#sourceScope.exit(() => runDetachedMaintenanceContext('recovery', () => operation(this.#artifactPreparationAbort.signal)));
        this.#artifactPreparations.add(pending);
        void pending.finally(() => this.#artifactPreparations.delete(pending)).catch(() => undefined);
        return pending;
      },
      read: operation => locked(async () => { await open(); return operation(view); }),
      update: operation => locked(async () => {
        if (this.#readOnly) throw new TypeError('Read-only authority cannot publish artifact-derived pages');
        await open();
        const result = await operation(view);
        state.publish(await state.prepare(bindDurableProjectionMutations(result.mutations)), checkpoints);
        // A completed bounded page and its progress marker become durable
        // together. The source artifact remains the sole rebuilding source.
        await state.flush({ compact: false });
        return result.value;
      }),
      reset: () => locked(async () => { await state.reset(checkpoints); }),
    };
    this.#artifactProjections.set(key, { state, cache });
    return cache;
  }

  /**
   * Publishes one frozen source prefix and its target-side install decision as one
   * physical WAL replacement. The imported envelopes keep their source LSN and
   * envelope digest; only this log's frame-prefix chain is rebuilt.
   */
  async installPlannedAnchorPrefix<Body>(
    input: PlannedAnchorPrefixInstallation<Body>,
  ): Promise<CommitEnvelope<Body>> {
    if (this.#readOnly) throw new TypeError("Authority log is read-only");
    const installationEntries = normalizeEntries(input.installationEntries);
    if (installationEntries.length === 0) {
      throw new TypeError("Planned anchor installation requires a publication entry");
    }
    const candidateReferences = deduplicateReferences(input.candidateReferences);
    const protectedReferences = new Map(
      candidateReferences.map((reference) => [reference.digest, reference.bytes]),
    );
    const operation = () => this.#withLogLock("installPlannedAnchorPrefix", async () => {
      for (const guard of this.#appendAdmissionGuards) {
        guard(installationEntries as Array<LogicalRecord<unknown>>);
      }

      let replay: CommitEnvelope<Body> | undefined;
      await this.#readAndRecover((envelope) => {
        if (
          envelope.lsn === input.sourceHead.lsn + 1 &&
          canonicalize(envelope.entries) === canonicalize(installationEntries)
        ) {
          replay = envelope as CommitEnvelope<Body>;
        }
      });
      if (replay) return replay;

      const logId = this.#requireLogId();
      const temporaryPath = path.join(
        this.rootDir,
        `.authority-planned-${randomBytes(8).toString("hex")}.tmp`,
      );
      const target = await open(temporaryPath, "wx", 0o600);
      let sourcePrefix = emptyLogPrefix(input.sourceHead.logId);
      let targetPrefix = emptyLogPrefix(logId);
      let lastLsn = 0;
      let frameEndOffset = AUTHORITY_WAL_FILE_HEADER_BYTES;
      const installedPhysicalHash = createHash("sha256");
      try {
        await target.writeFile(encodeAuthorityWalFileHeader(
          Buffer.from(logId, "base64url"),
        ));
        for await (const imported of input.source) {
          const envelope = parseEnvelope(
            Buffer.from(canonicalize(imported), "utf8"),
          ) as CommitEnvelope<Body>;
          if (envelope.lsn !== lastLsn + 1 || envelope.lsn > input.sourceHead.lsn) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              "Planned anchor source prefix is not contiguous",
            );
          }
          assertTransactionReferencesProtected(
            collectRetainedArtifactRefs(envelope.entries),
            protectedReferences,
          );
          sourcePrefix = advanceProjectionPrefix(
            input.sourceHead.logId,
            sourcePrefix,
            envelope,
          );
          targetPrefix = advanceProjectionPrefix(logId, targetPrefix, envelope);
          const frame = encodeAuthorityWalFrame(
            Buffer.from(canonicalize(envelope), "utf8"),
            { lsn: envelope.lsn, prefixDigest: targetPrefix },
          );
          await target.writeFile(frame);
          installedPhysicalHash.update(frame);
          frameEndOffset += frame.byteLength;
          lastLsn = envelope.lsn;
        }
        if (
          lastLsn !== input.sourceHead.lsn ||
          sourcePrefix !== input.sourceHead.prefixDigest
        ) {
          throw new AuthorityStorageError(
            "commit-log-corrupt",
            "Planned anchor source prefix does not match its frozen checkpoint",
          );
        }
        const installation = createCommitEnvelope(
          lastLsn + 1,
          this.#clock(),
          installationEntries,
        );
        assertTransactionReferencesProtected(
          collectRetainedArtifactRefs(installation.entries),
          protectedReferences,
        );
        targetPrefix = advanceProjectionPrefix(logId, targetPrefix, installation);
        const installationFrame = encodeAuthorityWalFrame(
          Buffer.from(canonicalize(installation), "utf8"),
          { lsn: installation.lsn, prefixDigest: targetPrefix },
        );
        await target.writeFile(installationFrame);
        installedPhysicalHash.update(installationFrame);
        frameEndOffset += installationFrame.byteLength;
        await target.sync();
        const installedMetadata = await readWalVersion(target);
        await target.close();

        // Prepare every fallible derived reset before publishing the new fact.
        // If admission/reset fails, the old WAL remains authoritative and these
        // empty projections can recover from it. A committed install is never
        // reported as uncommitted just because a derived cache is unavailable.
        const origin = this.#durableCheckpoint(0);
        const installedHead = { logId, lsn: installation.lsn, frameEndOffset, prefixDigest: targetPrefix };
        for (const projection of this.#durableProjections.values()) {
          await projection.state.reset({ authority: origin }, { authority: installedHead });
          delete projection.synchronized;
          delete projection.failure;
          delete projection.recoveryReset;
        }
        // 外部消费者（如跨日志的资产生命周期索引）不归本日志重置：通知它覆盖位置已失效，由它整段重建。
        for (const consumer of this.#tailConsumers) consumer.sourceReplaced?.();
        await AuthenticatedFrameIndex.discard(this.rootDir);
        this.#frameIndex = undefined;
        await rename(temporaryPath, this.logPath);
        verifiedWalViews.delete(this.logPath);
        this.#operationView = undefined;
        this.#refreshedProjections.clear();
        this.#logFormat = "versioned";
        this.#verifiedTail = { logId, device: installedMetadata.dev, inode: installedMetadata.ino,
          bytes: frameEndOffset, lastLsn: installation.lsn, prefixDigest: targetPrefix,
          modifiedAt: undefined, changedAt: undefined, physicalHash: installedPhysicalHash };
        await syncDirectory(this.rootDir);
        return installation;
      } catch (error) {
        await target.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    return candidateReferences.length === 0
      ? operation()
      : this.artifactStore.withPresentReferences(candidateReferences, operation);
  }

  registerAppendAdmissionGuard(guard: AuthorityAppendAdmissionGuard): () => void {
    if (typeof guard !== "function") {
      throw new TypeError("Authority append admission guard must be callable");
    }
    this.#appendAdmissionGuards.add(guard);
    return () => this.#appendAdmissionGuards.delete(guard);
  }

  /**
   * 登记消费本日志尾部的外部派生索引：此后每次追加都按同一恢复欠账预算核它的覆盖位置，使它
   * 落后的量与本日志自己的固定投影一样受硬界约束，不靠空闲维护碰巧追平。
   */
  registerTailConsumer(consumer: AuthorityTailConsumer): () => void {
    this.#tailConsumers.add(consumer);
    return () => this.#tailConsumers.delete(consumer);
  }

  async installAppendAdmissionGuard(
    guard: AuthorityAppendAdmissionGuard,
  ): Promise<() => void> {
    if (typeof guard !== "function") {
      throw new TypeError("Authority append admission guard must be callable");
    }
    return this.#withLogLock("installAppendAdmissionGuard", async () => {
      this.#appendAdmissionGuards.add(guard);
      return () => this.#appendAdmissionGuards.delete(guard);
    });
  }

  /**
   * 读取与本日志当前已核验前缀一致的投影检查点。未开启、密钥未就绪、不存在、键不同、状态
   * 摘要或认证不符，或其边界不在本日志的已核验帧链上时一律返回 undefined，由调用方完整
   * 回放。返回的游标不携带文件身份，首次续读必然从该 LSN 起核对边界后再续扫。
   */
  async loadProjectionCheckpoint<State>(
    key: string,
  ): Promise<{ readonly state: State; readonly cursor: ProjectionCursor } | undefined> {
    if (!this.#startupProofs) return undefined;
    try {
      if (!this.#integrity) return undefined;
      const bytes = await readFile(this.#checkpointPath(key)).catch(() => undefined);
      const decoded = bytes && decodeProjectionCheckpoint(bytes, key, this.#integrity);
      if (!decoded) return undefined;
      const boundary = decoded.boundary;
      const valid = await this.#withLogLock("checkpoint", async () => {
        const lastLsn = await this.#loadLastLsn();
        if (boundary.logId !== this.#requireLogId() || boundary.lsn > lastLsn) return false;
        await this.#validateDurableCheckpoint(boundary);
        return true;
      }).catch(() => false);
      if (!valid) return undefined;
      return {
        state: decoded.state as State,
        cursor: new FileProjectionCursor(boundary.lsn, boundary.logId, this.logPath, undefined, undefined,
          boundary.frameEndOffset, undefined, undefined, boundary.prefixDigest),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 以本日志签发的游标保存投影检查点；未开启、游标不属于本日志、密钥尚未就绪或超限时不写，
   * 失败不影响调用方。状态在第一次等待之前同步序列化：调用方随后可以原地推进同一份状态，
   * 写下的始终是与游标对应的那一刻。
   */
  async saveProjectionCheckpoint(key: string, cursor: ProjectionCursor, state: unknown): Promise<void> {
    try {
      if (this.#readOnly || !this.#startupProofs || !this.#integrity || !(cursor instanceof FileProjectionCursor) ||
          cursor.lsn <= 0 || cursor.logPath !== this.logPath || cursor.logId !== this.#logId) return;
      const bytes = encodeProjectionCheckpoint(key, {
        logId: cursor.logId, lsn: cursor.lsn, frameEndOffset: cursor.byteOffset, prefixDigest: cursor.prefixDigest,
      }, state, this.#integrity);
      if (!bytes) return;
      await mkdir(path.dirname(this.#checkpointPath(key)), { recursive: true });
      await writeReplacing(this.#checkpointPath(key), bytes);
    } catch {
      // 检查点只是缓存；写不成下次完整回放。
    }
  }

  /**
   * 列出键以 prefix 开头的投影检查点。只读文件头、不作认证，规模是检查点文件数而不是历史；
   * 取得的键必须再经 loadProjectionCheckpoint 认证（MAC 与已核验帧链边界）后才能使用。
   */
  async listProjectionCheckpointKeys(prefix: string): Promise<readonly string[]> {
    if (!this.#startupProofs) return [];
    const directory = path.join(this.rootDir, "checkpoints");
    const keys: string[] = [];
    const entries = await opendir(directory).catch(() => undefined);
    if (!entries) return keys;
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;
      const file = path.join(directory, entry.name);
      const handle = await open(file, "r").catch(() => undefined);
      if (!handle) continue;
      try {
        const head = Buffer.alloc(64 * 1024 + 16);
        const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
        const key = peekProjectionCheckpointKey(head.subarray(0, bytesRead));
        if (key?.startsWith(prefix) && this.#checkpointPath(key) === file) keys.push(key);
      } catch {
        // 读不了的检查点视同不存在。
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    return keys.sort();
  }

  /** 丢弃不再需要的投影检查点（例如已删除的会话）；检查点只是缓存，失败不影响调用方。 */
  async deleteProjectionCheckpoint(key: string): Promise<void> {
    if (this.#readOnly) return;
    await durablyRemoveFiles([this.#checkpointPath(key)]).catch(() => undefined);
  }

  #checkpointPath(key: string): string {
    return path.join(this.rootDir, "checkpoints", `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.bin`);
  }

  async originCheckpoint(): Promise<DurableLogCheckpoint> {
    return this.#withLogLock("originCheckpoint", async () => this.#durableCheckpoint(0));
  }

  readonly #checkpointFlushes = new Set<() => Promise<unknown> | unknown>();

  /** 登记正式停止前补存检查点的回调；返回注销函数。 */
  registerCheckpointFlush(flush: () => Promise<unknown> | unknown): () => void {
    this.#checkpointFlushes.add(flush);
    return () => { this.#checkpointFlushes.delete(flush); };
  }

  /** 进程停机时取消日志迁移及该日志所拥有的全部投影维护义务。 */
  stopStorageMaintenance(): Promise<void> {
    return this.#stopMaintenance ??= this.#stopStorageMaintenance();
  }

  async #stopStorageMaintenance(): Promise<void> {
    this.#maintenanceStopped = true;
    this.#artifactPreparationAbort.abort();
    await Promise.allSettled([...this.#artifactPreparations]);
    // 正式停止前补存各投影的检查点：重启后只需续算很短的尾部。检查点只是缓存，失败不影响停止。
    if (this.#startupProofs) {
      await Promise.allSettled([...this.#checkpointFlushes].map(async (flush) => flush()));
    }
    // Save only already prepared, bounded overlays. Never open an unused index
    // or replay history during shutdown, and leave historical compaction alone.
    for (const projection of this.#durableProjections.values()) {
      if (hasUnpublishedProgress(projection)) {
        await this.#withLogLock("projection.checkpoint", () => projection.state.flushCheckpoint()).catch(() => undefined);
      }
    }
    // 停止后不再有巡检或索引写盘在后台运行：撤销计时、中止并等进行中的巡检停下，再在锁内写出索引。
    this.#maintenanceStopped = true;
    clearTimeout(this.#frameIndexFlushTimer);
    this.#frameIndexFlushTimer = undefined;
    clearTimeout(this.#frameIndexAuditTimer);
    this.#frameIndexAuditTimer = undefined;
    this.#frameIndexAuditAbort.abort();
    await this.#frameIndexAudit?.catch(() => undefined);
    if (this.#frameIndex?.dirty) {
      await this.#withLogLock("maintainFrameIndex", () => this.#flushFrameIndex()).catch(() => undefined);
    }
    await this.#maintenanceRunner.stop();
    for (const projection of this.#durableProjections.values()) {
      await projection.state.stopStorageMaintenance();
    }
    for (const projection of this.#artifactProjections.values()) await projection.state.stopStorageMaintenance();
    this.#workObserver.flush();
    await closeArtifactJsonIndex(this.artifactStore);
  }

  async readTail<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
    limit: number,
    runPhysicalStep: PhysicalStorageStepRunner = async (operation) =>
      operation(),
  ): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[];
    readonly checkpoints: readonly DurableLogCheckpoint[];
    readonly checkpoint: DurableLogCheckpoint;
    readonly hasMore: boolean;
  }> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
      throw new RangeError("Authority log tail limit must be 1-256");
    }
    return this.#withLogLock("readTail", () =>
      runPhysicalStep(async () => {
        await this.#validateDurableCheckpoint(checkpoint);
        const commits: Array<CommitEnvelope<JsonValue>> = [];
        const checkpoints: DurableLogCheckpoint[] = [];
        const scanned = await this.#scanLogFrom(
          checkpoint.frameEndOffset,
          checkpoint.lsn,
          checkpoint.prefixDigest,
          (envelope, boundary) => {
            commits.push(envelope);
            checkpoints.push(boundary);
            return commits.length < limit;
          },
        );
        if (scanned.incompleteTail) {
          await this.#quarantineTail(
            scanned.incompleteTail,
            scanned.validBytes,
          );
        }
        if (!scanned.stopped) {
          await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest, scanned.physicalHash);
        }
        return {
          commits: commits as Array<CommitEnvelope<Body>>,
          checkpoints,
          checkpoint: scanned.stopped
            ? {
              logId: this.#requireLogId(),
              lsn: scanned.lastLsn,
              frameEndOffset: scanned.validBytes,
              prefixDigest: scanned.prefixDigest,
            }
            : this.#durableCheckpoint(scanned.lastLsn),
          hasMore: scanned.stopped === true,
        };
      }),
    );
  }

  /**
   * 按流分页读取 (afterLsn, throughLsn] 内涉及所选流的信封及各自的已核验位置。认证帧索引按流标记
   * 跳过无关帧，不读其他流的正文；每页至多 limit 个信封，之后释放日志锁，调用方从 lastLsn 续读。
   */
  async readStreamEnvelopes<Body = JsonValue>(
    streams: readonly string[],
    afterLsn: number,
    throughLsn: number,
    limit = 256,
  ): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[];
    readonly checkpoints: readonly DurableLogCheckpoint[];
    readonly lastLsn: number;
    readonly hasMore: boolean;
  }> {
    if (streams.length === 0) throw new TypeError("Stream read requires at least one stream");
    for (const stream of streams) assertStream(stream);
    assertReplayLsn(afterLsn);
    assertReplayLsn(throughLsn);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) throw new RangeError("Stream read limit must be 1-256");
    return this.#withLogLock("readStream", () => this.#readStreamEnvelopes<Body>(streams, afterLsn, throughLsn, limit));
  }

  async #readStreamEnvelopes<Body>(streams: readonly string[], afterLsn: number, throughLsn: number, limit: number) {
    const selected = new Set(streams);
    {
      const commits: Array<CommitEnvelope<JsonValue>> = [];
      const checkpoints: DurableLogCheckpoint[] = [];
      let lastLsn = afterLsn, hasMore = false;
      if (afterLsn >= throughLsn) return { commits: [], checkpoints: [], lastLsn, hasMore };
      const scanned = await this.#scanLogFrom(this.#logDataStartOffset(), 0, emptyLogPrefix(this.#requireLogId()), (envelope, boundary) => {
        if (envelope.lsn > throughLsn) return false;
        if (commits.length >= limit) { hasMore = true; return false; }
        if (selected.size === 0 || envelope.entries.some(entry => selected.has(entry.stream))) { commits.push(envelope); checkpoints.push(boundary); }
        lastLsn = envelope.lsn;
        return true;
      // 截止位置之后的第一帧也选中：回调读到它即停止，扫描不再走到日志末尾。
      }, afterLsn + 1, undefined, selected.size === 0 ? undefined : projectionEnvelopeSelection(selected, throughLsn + 1));
      if (scanned.incompleteTail) await this.#quarantineTail(scanned.incompleteTail, scanned.validBytes);
      if (!hasMore) lastLsn = Math.max(lastLsn, Math.min(throughLsn, scanned.lastLsn));
      return { commits: commits as Array<CommitEnvelope<Body>>, checkpoints, lastLsn, hasMore };
    }
  }

  /**
   * 在当前已核验位置为所选投影写入一批不来自新事实的行（旧资料按分区迁移的结果）。持日志锁：
   * 投影先追平到头部；compute 在锁内读取各投影并返回各自的变更，只能做有界工作，不能等待。
   * 写入不推进投影位置。落盘在放开日志锁之后进行：锁内准入只能零等待，大批写入之后设备采样可能
   * 尚未刷新，锁外则可等待准入。落盘前崩溃则这批行连同其分区标记一起丢失，下次重新迁移；落盘未成时
   * 由此后的落盘或正式停止时的检查点带上。
   */
  async publishProjectionRows(
    ids: readonly string[],
    compute: (head: DurableLogCheckpoint, read: (projectionId: string) => DurableProjectionReadContext, source: LockedSourceReader) =>
      Promise<ReadonlyMap<string, readonly DurableProjectionMutation[] | NormalizedProjectionMutations>>,
    options: {
      readonly deferFlush?: boolean;
      /** 发布前后落盘若带出段整理，在步与步之间调用（后台迁移据此给前台让路）。 */
      readonly betweenSteps?: () => Promise<void>;
    } = {},
  ): Promise<DurableLogCheckpoint> {
    const projections = [...new Set(ids)].map(id => {
      const projection = this.#durableProjections.get(id);
      if (!projection) throw new TypeError(`Durable projection is not registered: ${id}`);
      return projection;
    });
    // 大批写入会让覆盖层超出上限：若此时还有未落盘的部分，锁内只能先做零等待准入的提交前落盘，
    // 长时间整理变更之后设备采样可能已过期而被拒，整段锁内工作随之反复重做。先在锁外落盘（可等待准入）。
    // 推迟落盘的小批写入（可重新推导的行）只在覆盖层过半时先落盘，其余由此后的落盘一并带上。
    for (const projection of projections) {
      if (!projection.opened || !projection.state.isPersistent()) continue;
      if (options.deferFlush && !projection.state.overlayAtLeastHalfFull()) continue;
      try { await projection.state.flush({ compact: false, ...(options.betweenSteps ? { betweenSteps: options.betweenSteps } : {}) }); }
      catch (error) { if (maintenanceRetryDelayMs(error) === undefined) throw error; }
    }
    const published = new Set<RegisteredDurableProjection>();
    const head = await this.#withLogLock("projection.publishRows", async () => {
      published.clear();
      for (const projection of projections) await this.#synchronizeDurableProjection(projection);
      const head = this.#durableCheckpoint(await this.#loadLastLsn());
      // 锁内只能用同一锁会话的读取：日志锁不可重入。
      const source: LockedSourceReader = {
        readStreamEnvelopes: async <Body>(streams: readonly string[], afterLsn: number, throughLsn: number, limit = 256) => {
          for (const stream of streams) assertStream(stream);
          if (throughLsn > head.lsn) throw new RangeError("Locked stream read is beyond the published head");
          return this.#readStreamEnvelopes<Body>(streams, afterLsn, throughLsn, limit);
        },
        readEnvelopeAt: checkpoint => this.#readEnvelopeAt(checkpoint),
      };
      const changes = await compute(head, id => {
        const projection = this.#durableProjections.get(id);
        if (!projection || !projections.includes(projection)) throw new TypeError(`Projection is outside this publication: ${id}`);
        return projection.read;
      }, source);
      for (const [id, mutations] of changes) {
        const projection = this.#durableProjections.get(id);
        if (!projection || !projections.includes(projection)) throw new TypeError(`Projection is outside this publication: ${id}`);
        if (!projectionMutationKeyCount(mutations)) continue;
        // 预先规范化的批在锁外已完成逐值计算，锁内只合并。
        const prepared = await projection.state.prepare(isNormalizedProjectionMutations(mutations) ? mutations : bindDurableProjectionMutations(mutations));
        projection.state.publish(prepared, projection.state.checkpoints());
        published.add(projection);
      }
      return head;
    });
    if (options.deferFlush) return head;
    for (const projection of published) {
      if (!projection.state.isPersistent()) continue;
      // 行已在内存中发布、后续读写据此进行；暂时的准入背压不使发布失败，由此后的落盘带上。
      try { await projection.state.flush({ compact: false, ...(options.betweenSteps ? { betweenSteps: options.betweenSteps } : {}) }); }
      catch (error) { if (maintenanceRetryDelayMs(error) === undefined) throw error; }
    }
    return head;
  }

  async readEnvelopeAt<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
  ): Promise<CommitEnvelope<Body>> {
    return this.#withLogLock("readEnvelopeAt", () => this.#readEnvelopeAt<Body>(checkpoint));
  }

  async #readEnvelopeAt<Body = JsonValue>(checkpoint: DurableLogCheckpoint): Promise<CommitEnvelope<Body>> {
    if (checkpoint.lsn === 0) {
      throw new TypeError("An empty log checkpoint has no authority envelope");
    }
      const indexed = await this.#validateDurableCheckpoint(checkpoint);
      const handle = await open(this.logPath, "r");
      try {
        if (indexed) {
          const start = indexed.payloadOffset - AUTHORITY_WAL_HEADER_BYTES;
          const bytes = await this.#readExactAt(handle, start, indexed.frameEndOffset - start);
          const envelope = this.#verifyIndexedFrame(indexed, bytes, 0) ??
            parseEnvelope(bytes.subarray(AUTHORITY_WAL_HEADER_BYTES, AUTHORITY_WAL_HEADER_BYTES + indexed.payloadBytes));
          if (envelope.lsn !== checkpoint.lsn) {
            throw new AuthorityStorageError("commit-log-corrupt", "Authority envelope does not match its durable source checkpoint");
          }
          return envelope as CommitEnvelope<Body>;
        }
        const metadata = await readWalVersion(handle);
        const boundary = await verifyAuthorityWalFrameBoundary(
          this.#walReader(handle, metadata.size),
          checkpoint.frameEndOffset,
        );
        const frameBytes =
          checkpoint.frameEndOffset - boundary.frameStartOffset;
        let result: CommitEnvelope<JsonValue> | undefined;
        const scanned = await scanAuthorityWalFrames(
          this.#walReader(handle, frameBytes, boundary.frameStartOffset),
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
  }

  async readEnvelopesAt<Body = JsonValue>(
    checkpoints: readonly DurableLogCheckpoint[],
  ): Promise<readonly CommitEnvelope<Body>[]> {
    if (checkpoints.length > 64 || checkpoints.some((item, index) =>
      !Number.isSafeInteger(item.lsn) || item.lsn <= (checkpoints[index - 1]?.lsn ?? 0))) {
      throw new TypeError("Authority envelope batch requires up to 64 ordered nonempty checkpoints");
    }
    if (!checkpoints.length) return [];
    return this.#withLogLock("readEnvelopeAt", async () => {
      const wanted = new Map(checkpoints.map(checkpoint => [checkpoint.lsn, checkpoint]));
      const result: CommitEnvelope<Body>[] = [];
      // The same physical prefix proof serves this bounded read. Domain reducers
      // run only after returning, outside the writer/maintenance exclusion.
      await this.#readAndRecover((envelope, observed) => {
        const checkpoint = wanted.get(envelope.lsn)!;
        if (checkpoint.logId !== observed.logId || checkpoint.frameEndOffset !== observed.frameEndOffset ||
            checkpoint.prefixDigest !== observed.prefixDigest) {
          throw new AuthorityStorageError("commit-log-corrupt", "Authority envelope batch checkpoint does not match its verified source");
        }
        result.push(envelope as CommitEnvelope<Body>);
      }, checkpoints[0]!.lsn, proof => wanted.has(proof.lsn));
      if (result.length !== checkpoints.length) {
        throw new AuthorityStorageError("commit-log-corrupt", "Authority envelope batch source is incomplete");
      }
      return result;
    });
  }

  async rebuildProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options: ProjectionReplayOptions & { readonly createState?: () => State } = {},
  ): Promise<State> {
    const selectedStreams = validateProjectionStreams(options);
    const afterLsn = options.afterLsn ?? 0;
    assertReplayLsn(afterLsn);
    return this.#withLogLock("rebuildProjection", async () => {
      // Reuse only the byte-verified prefix in this exclusive operation. Changed files
      // still take full recovery before any reducer is called.
      const lastLsn = await this.#loadLastLsn();
      if (afterLsn > lastLsn) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          `Projection cursor ${afterLsn} is ahead of commit log LSN ${lastLsn}`,
        );
      }
      if (afterLsn === lastLsn) return initial;

      let state = options.createState ? options.createState() : initial;
      await this.#scanLog(async (envelope) => {
        if (envelope.lsn <= afterLsn) return;
        for (const record of envelope.entries) {
          if (
            selectedStreams === undefined ||
            selectedStreams.has(record.stream)
          ) {
            state = await reducer(
              state,
              record as LogicalRecord<Body>,
              envelope as CommitEnvelope<Body>,
            );
          }
        }
      }, afterLsn + 1, projectionEnvelopeSelection(selectedStreams));
      return state;
    });
  }

  async readProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionTransactionReducer<State, Body>,
    options: ProjectionReplayOptions & { readonly cursor?: ProjectionCursor; readonly createState?: () => State } = {},
  ): Promise<Pick<ProjectionTransactionResult<State, Body, never>, "state" | "lastLsn" | "cursor">> {
    validateProjectionStreams(options);
    const cursor = options.cursor;
    if (cursor !== undefined && !(cursor instanceof FileProjectionCursor)) {
      throw new TypeError("Projection cursor was not issued by this commit log");
    }
    if (cursor && options.afterLsn !== undefined && cursor.lsn !== options.afterLsn) {
      throw new TypeError("Projection cursor and afterLsn must identify the same prefix");
    }
    assertReplayLsn(cursor?.lsn ?? options.afterLsn ?? 0);
    if (cursor && await this.#hasUnchangedReadView("readProjection", cursor as FileProjectionCursor)) {
      return { state: initial, cursor, lastLsn: cursor.lsn };
    }
    return this.transactProjection(initial, reducer, () => ({ kind: "return", value: undefined }), options);
  }

  /** Reuses only a caller's existing read view; never admits new bytes or a write. */
  async #hasUnchangedReadView(kind: "readProjection" | "checkpoint", cursor: FileProjectionCursor): Promise<boolean> {
    const observation = this.#workObserver.begin(kind);
    const queued = performance.now();
    let failure: [] | [unknown] = [];
    let unchanged: boolean;
    try {
      unchanged = await this.#operations.run(async () => {
        observation.data.queueMs += performance.now() - queued;
        const started = performance.now();
        observation.stage("verify-read-view");
        this.#work = observation.data;
        try {
          if (!this.#logId) return false;
          const metadata = await readWalVersion(this.logPath).catch((error: unknown) => {
            if (isNodeError(error, "ENOENT")) return undefined;
            throw error;
          });
          // Preserve the caller's already validated read view when its file
          // version is unchanged. No bytes or decisions are adopted here;
          // materializing new data and every write still verify actual bytes.
          return metadata !== undefined && canResumeProjectionCursor(cursor, this.logPath, this.#logId, metadata);
        } finally {
          this.#operationView = undefined;
          this.#work = undefined;
          observation.data.executionMs += performance.now() - started;
        }
      });
    } catch (error) { failure = [error]; throw error; }
    finally { observation.finish(...failure); }
    return unchanged;
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
    options: ProjectionTransactionOptions & { readonly createState?: () => State } = {},
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
    const runPhysicalStep = this.#physicalStepAfterSynchronization(options.runPhysicalStep);
    const operation = () =>
      this.#withLogLock("transactProjection", observation =>
        runPhysicalStep(async () => {
          observation.stage('projection-dependencies');
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
          observation.stage('projection-read-tail');
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
            selectedStreams,
          );
          const { lastLsn } = replayTail;
          if (options.requiredPrefix) {
            const required = await this.#readProjectionTail(options.requiredPrefix, options.requiredPrefix.lsn, () => {});
            if (options.requiredPrefix.lsn > required.lastLsn) throw new AuthorityStorageError("commit-log-corrupt", "Required projection prefix is ahead of the log");
          }
          if (afterLsn > lastLsn) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Projection cursor ${afterLsn} is ahead of commit log LSN ${lastLsn}`,
            );
          }

          let state = options.createState ? options.createState() : initial;
          observation.stage('projection-replay-reduce');
          for (const item of replay) {
            state = await reducer(state, item.record, item.envelope);
          }
          const at = this.#clock();
          assertCanonicalTime(at);
          observation.stage('projection-decide');
          const decision = await this.#decideWithProjectionRecovery(
            readProjectionIds.map(id => this.#durableProjections.get(id)!),
            () => Promise.resolve(decide(state, this.#transactionContext(lastLsn, at, readProjections))),
          );
          if (decision.kind === "return") {
            return {
              value: decision.value,
              state,
              lastLsn,
              cursor: replayTail.cursor,
            };
          }

          observation.stage('projection-candidate-validate');
          const entries = normalizeEntries(decision.entries);
          assertTransactionReferencesProtected(
            collectRetainedArtifactRefs(entries),
            candidateDigests,
          );
          const candidate = createCommitEnvelope(lastLsn + 1, at, entries);
          let nextState = state;
          observation.stage('projection-candidate-reduce');
          for (const record of candidate.entries) {
            if (
              selectedStreams === undefined ||
              selectedStreams.has(record.stream)
            ) {
              nextState = await reducer(nextState, record, candidate);
            }
          }
          observation.stage('projection-append');
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
    options: Pick<ProjectionTransactionOptions, "candidateReferences" | "readProjectionIds" | "runPhysicalStep"> = {},
  ): Promise<{
    readonly value: Value;
    readonly cursor: ProjectionCursor;
    readonly commit?: CommitEnvelope<Body>;
  }> {
    const projection = this.#durableProjections.get(projectionId);
    if (!projection) {
      throw new TypeError(
        `Durable projection is not registered: ${projectionId}`,
      );
    }
    const readProjections = [...new Set([projectionId, ...(options.readProjectionIds ?? [])])].sort().map(id => {
      const dependency = this.#durableProjections.get(id);
      if (!dependency) throw new TypeError(`Durable read dependency is not registered: ${id}`);
      return [id, dependency] as const;
    });
    const candidateReferences = collectArtifactRefs(
      options.candidateReferences ?? [],
    );
    const candidateDigests = new Map(
      candidateReferences.map((reference) => [
        reference.digest,
        reference.bytes,
      ]),
    );
    const runPhysicalStep = this.#physicalStepAfterSynchronization(options.runPhysicalStep);
    const operation = () =>
      this.#withLogLock("transactDurableProjection", () => runPhysicalStep(async () => {
        for (const [, dependency] of readProjections) {
          await this.#withDurableProjectionRecovery(dependency, () => this.#synchronizeDurableProjection(dependency));
        }
        const lastLsn = await this.#loadLastLsn();
        const at = this.#clock();
        assertCanonicalTime(at);
        const decision = await this.#decideWithProjectionRecovery(readProjections.map(([, dependency]) => dependency), () => Promise.resolve(decide(
          projection.read,
          this.#transactionContext(lastLsn, at, new Map(readProjections.map(([id, dependency]) => [id, dependency.read]))),
        )));
        if (decision.kind === "return") return { value: decision.value, cursor: this.#projectionCursor(lastLsn) };
        const entries = normalizeEntries(decision.entries);
        assertTransactionReferencesProtected(
          collectRetainedArtifactRefs(entries),
          candidateDigests,
        );
        const candidate = createCommitEnvelope(lastLsn + 1, at, entries);
        const commit = await this.#append(entries, at, candidate);
        return {
          value: decision.value,
          cursor: this.#projectionCursor(commit.lsn),
          commit: commit as CommitEnvelope<Body>,
        };
      }));
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
    if (this.#readOnly) throw new TypeError("Authority log is read-only");
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
    return this.#withRetainedProjectionValueRecovery(async (reader) => {
      if (candidates === undefined) {
        const retained: ArtifactRef[] = [];
        await this.#scanRetainedPrefix(
      reader,
          RETAINED_REFERENCE_PREFIX,
          async ({ key, value }) => {
            const ref = retainedArtifactRef(value, key);
            if (await this.#isRetainedReference(reader, ref.digest, options)) {
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
        const stored = await reader.get(key);
        if (stored === undefined) continue;
        const ref = retainedArtifactRef(stored, key);
        if (ref.digest !== candidate.digest || ref.bytes !== candidate.bytes) {
          throw new AuthorityStorageError(
            "invalid-authority-record",
            `Artifact ${candidate.digest} declares conflicting byte counts`,
            { validation: 'artifact-byte-conflict' },
          );
        }
        if (await this.#isRetainedReference(reader, candidate.digest, options)) {
          retained.push(ref);
        }
      }
      return retained;
    });
  }

  /** 当前日志已耐久的会话删除 tombstone 快照(内容叶所有权削除单源)。 */
  async deadConversations(): Promise<ReadonlySet<string>> {
    return this.#withRetainedProjectionValueRecovery(async (reader) => {
      const dead = new Set<string>();
      await this.#scanRetainedPrefix(
      reader,
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
    return this.#withRetainedProjectionValueRecovery(async (reader) => {
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
      reader,
        RETAINED_LEAF_PREFIX,
        async ({ key, value }) => {
          const leaf = await resolveRetainedLeaf(
            reader,
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
            !(await this.#isConversationDead(reader, leaf.conversationId))
          ) {
            currentAllDead = false;
          }
        },
      );
      finishCurrent();
      return released;
    });
  }

  /** One logical reference query uses one strictly verified WAL view. */
  async #withRetainedProjectionValueRecovery<Result>(
    operation: (reader: DurableProjectionReadContext) => Promise<Result>,
  ): Promise<Result> {
    const projection = this.#durableProjections.get(RETAINED_REFERENCE_PROJECTION_ID)!;
    return this.#withLogLock("projection.retainedReferences", () =>
      this.#withDurableProjectionRecovery(projection, async () => {
        await this.#synchronizeDurableProjection(projection);
        try {
          return await operation(projection.read);
        } catch (error) {
          if (!(error instanceof RetainedReferenceProjectionValueError)) throw error;
          await this.#rebuildDurableProjection(projection);
          return operation(projection.read);
        }
      }),
    );
  }

  async #isRetainedReference(
    reader: DurableProjectionReadContext,
    digest: string,
    options: RetainedReferenceQueryOptions,
  ): Promise<boolean> {
    if (
      await reader
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
      reader,
      retainedLeafPrefix(digest),
      async ({ key, value }) => {
        if (retained) return;
        const leaf = await resolveRetainedLeaf(
          reader,
          value,
          key,
        );
        if (
          !(options.deadConversations?.has(leaf.conversationId) ?? false) &&
          !(await this.#isConversationDead(reader, leaf.conversationId))
        ) {
          retained = true;
        }
      },
    );
    return retained;
  }

  async #isConversationDead(reader: DurableProjectionReadContext, conversationId: string): Promise<boolean> {
    const key = retainedDeadKey(conversationId);
    const value = await reader.get(key);
    if (value === undefined) return false;
    retainedConversationId(value, key);
    return true;
  }

  async #scanRetainedPrefix(
    reader: DurableProjectionReadContext,
    prefix: string,
    visit: (entry: {
      readonly key: string;
      readonly value: JsonValue;
    }) => Promise<void>,
  ): Promise<void> {
    let continuation: string | undefined;
    do {
      const page = await reader.scan(
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
      flushCheckpoint: () => this.#withLogLock("projection.checkpoint", async () => {
        await this.#withDurableProjectionRecovery(projection, async () => {
          await this.#synchronizeDurableProjection(projection);
          await projection.state.flushCheckpoint();
        });
      }),
      get: (key) =>
        this.#withLogLock("projection.get", () =>
          this.#withDurableProjectionRecovery(projection, async () => {
            await this.#synchronizeDurableProjection(projection);
            return await projection.read.get(key);
          }),
        ),
      getMany: async (keys) => {
        if (!Array.isArray(keys) || keys.length > 256) {
          throw new TypeError("Projection multi-key read requires at most 256 string keys");
        }
        const selected = [...keys];
        if (selected.some(key => typeof key !== "string")) throw new TypeError("Projection multi-key read requires string keys");
        if (!selected.length) return [];
        return this.#withLogLock("projection.getMany", () =>
          this.#withDurableProjectionRecovery(projection, async () => {
            await this.#synchronizeDurableProjection(projection);
            return await projection.read.getMany(selected);
          }),
        );
      },
      scan: (range, limit, continuation) =>
        this.#withLogLock("projection.scan", () =>
          this.#withDurableProjectionRecovery(
            projection,
            async () => {
              await this.#synchronizeDurableProjection(projection);
              return this.#owner ? projection.read.scan(range, limit, continuation)
                : this.#scanLogicalProjection(projection, range, limit, continuation);
            },
            continuation === undefined || !this.#owner
              ? undefined
              : () => projection.read.scan(range, limit, continuation),
          ),
        ),
      checkpoints: () =>
        this.#withLogLock("projection.checkpoints", () =>
          this.#withDurableProjectionRecovery(projection, async () => {
            await this.#synchronizeDurableProjection(projection);
            return projection.state.checkpoints();
          }),
        ),
      // 重置只做一次；随后的同步可在锁外分页准备并重跑，重跑不会再次重置。
      rebuild: async () => {
        await this.#withLogLock("projection.rebuild", () => this.#resetDurableProjection(projection));
        await this.#withLogLock("projection.rebuild", () => this.#synchronizeDurableProjection(projection));
      },
    };
  }

  #transactionContext(lastLsn: number, at: IsoTime, reads: ReadonlyMap<string, DurableProjectionReadContext>): ProjectionTransactionContext {
    const scope = this.#sourceScope.getStore();
    return { ...projectionTransactionContext(lastLsn, at, reads), checkpoint: this.#durableCheckpoint(lastLsn),
      originCheckpoint: this.#durableCheckpoint(0), readEnvelopeAt: checkpoint => {
      if (!scope?.active || this.#sourceScope.getStore() !== scope || checkpoint.lsn > lastLsn) {
        throw new TypeError("Source locator is outside its authority transaction");
      }
      return this.#readEnvelopeAt(checkpoint);
    } };
  }

  #projectionSource(checkpoint: DurableLogCheckpoint, envelope: CommitEnvelope<unknown>, candidate = false): import('./durable-projection-index.js').DurableProjectionSource {
    const scope = this.#sourceScope.getStore();
    return { checkpoint, originCheckpoint: this.#durableCheckpoint(0), ...(candidate ? { candidate: true as const } : {}),
      readPreparedProjection: id => {
        if (!scope?.active || this.#sourceScope.getStore() !== scope) throw new TypeError('Projection dependency escaped its source scope');
        const projection = this.#durableProjections.get(id);
        if (!projection) throw new TypeError(`Durable projection dependency is not registered: ${id}`);
        if (projection.failure !== undefined) throw projection.failure;
        if (!projection.opened) throw new AuthorityPreparationRequired([id]);
        const point = projection.state.checkpoints().authority;
        if (!point || point.logId !== checkpoint.logId || point.lsn < checkpoint.lsn - Number(candidate)) throw new AuthorityPreparationRequired([id]);
        const assertActive = () => { if (!scope.active || this.#sourceScope.getStore() !== scope) throw new TypeError('Projection dependency escaped its source scope'); };
        return {
          get: key => { assertActive(); return projection.read.get(key); },
          scan: (range, limit, continuation) => { assertActive(); return projection.read.scan(range, limit, continuation); },
        };
      }, readEnvelopeAt: async location => {
      if (!scope?.active || this.#sourceScope.getStore() !== scope || location.lsn > checkpoint.lsn) {
        throw new TypeError('Source locator is outside its projection reduction');
      }
      if (location.lsn === checkpoint.lsn) {
        if (location.logId !== checkpoint.logId || location.prefixDigest !== checkpoint.prefixDigest || location.frameEndOffset !== checkpoint.frameEndOffset) {
          throw new TypeError('Projection source locator does not bind its current envelope');
        }
        return envelope;
      }
      return this.#readEnvelopeAt(location);
    } };
  }

  async #scanLogicalProjection(projection: RegisteredDurableProjection, range: DurableProjectionScanRange,
    limit: number, continuation?: string): Promise<DurableProjectionScanPage> {
    const checkpoint = projection.state.checkpoints().authority!;
    const rangeIdentity = canonicalize(range);
    let after: string | undefined;
    if (continuation !== undefined) {
      const token = JSON.parse(Buffer.from(continuation, "base64url").toString("utf8")) as {
        projection?: unknown; range?: unknown; checkpoint?: DurableLogCheckpoint; after?: unknown;
      };
      if (token.projection !== projection.state.projectionId || token.range !== rangeIdentity || typeof token.after !== "string") {
        throw new TypeError("Projection continuation is invalid");
      }
      if (!sameDurableCheckpoint(token.checkpoint, checkpoint)) throw new Error("Durable projection continuation is stale");
      after = token.after;
    }
    // 续读以上一页末键为开区间下界，替换原下界（区间不能同时带 gte 与 gt）
    const { gte: _gte, gt: _gt, ...upper } = range;
    const page = await projection.read.scan(after === undefined ? range : { ...upper, gt: after }, limit);
    if (!page.continuation) return page;
    projection.state.releaseContinuation(page.continuation);
    return { entries: page.entries, continuation: Buffer.from(JSON.stringify({
      projection: projection.state.projectionId, range: rangeIdentity, checkpoint, after: page.entries.at(-1)!.key,
    })).toString("base64url") };
  }

  /** 同一写栅栏内只重建一次派生依赖；纯决定尚未提交，不重跑已完成的目标归约。 */
  async #decideWithProjectionRecovery<Result>(
    projections: readonly RegisteredDurableProjection[],
    decide: () => Promise<Result>,
  ): Promise<Result> {
    try { return await verifyProtocolStep(decide); }
    catch (error) {
      if (!(error instanceof DurableProjectionStorageError) || projections.length === 0) throw error;
      for (const projection of projections) await this.#rebuildDurableProjection(projection);
      return verifyProtocolStep(decide);
    }
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
    await this.#resetDurableProjection(projection);
    await this.#synchronizeDurableProjection(projection);
  }

  async #resetDurableProjection(projection: RegisteredDurableProjection): Promise<void> {
    const head = this.#durableCheckpoint(await this.#loadLastLsn());
    await projection.state.reset({ authority: this.#durableCheckpoint(0) }, { authority: head });
    delete projection.failure;
    delete projection.synchronized;
    projection.opened = true;
  }

  async #openDurableProjection(projection: RegisteredDurableProjection, head: DurableLogCheckpoint): Promise<void> {
    if (projection.failure !== undefined) return;
    const origin = { authority: this.#durableCheckpoint(0) };
    try {
      const reopening = projection.opened === true;
      await projection.state.initialize(origin, { authority: head });
      // 其他实例只能持锁发布：只有本实例新取得锁会话时，才需要采用他们已发布的清单；
      // 发布前的维护步骤另在源锁内刷新，避免旧清单覆盖其他实例。
      if (reopening && !this.#refreshedProjections.has(projection)) await projection.state.refreshPublishedState();
      this.#refreshedProjections.add(projection);
      projection.opened = true;
      const checkpoints = [projection.state.checkpoints().authority,
        ...(projection.state.readiness() === "building"
          ? [projection.state.recoveryTarget()?.authority, projection.state.unrelatedThrough().authority] : [])];
      for (const checkpoint of checkpoints) {
        if (!checkpoint) throw new DurableProjectionStorageError("Projection source checkpoint is missing");
        if (!sameDurableCheckpoint(checkpoint, head)) await this.#validateDurableCheckpoint(checkpoint);
      }
      if (projection.state.readiness() === "building" &&
          sameDurableCheckpoint(projection.state.checkpoints().authority, head)) {
        await projection.state.finishRebuild({ authority: head });
      }
      if (projection.state.readiness() === "ready" && sameDurableCheckpoint(projection.state.checkpoints().authority, head)) {
        projection.synchronized = true;
      } else delete projection.synchronized;
    } catch (error) {
      if (isTransientProjectionError(error)) throw error;
      if (!(error instanceof DurableProjectionStorageError || error instanceof AuthorityStorageError)) {
        // 读取派生存储的 I/O 失败不等于缓存不存在，也不是投影永久故障：本次操作失败，
        // 已发布的派生状态原样保留，下次操作重新打开。
        delete projection.synchronized;
        throw error;
      }
      // The source head was verified before opening the derived checkpoint.
      // A foreign or damaged derived boundary starts a new non-ready root.
      await projection.state.reset(origin, { authority: head });
      projection.opened = true;
      delete projection.synchronized;
    }
  }

  async #synchronizeDurableProjection(
    projection: RegisteredDurableProjection,
  ): Promise<void> {
    const head = this.#durableCheckpoint(await this.#loadLastLsn());
    await this.#openDurableProjection(projection, head);
    if (projection.failure !== undefined) throw projection.failure;
    if (projection.synchronized) return;
    // 健康但落后且在硬界之内：锁内追平（与 C8 首次使用时点一致）；其余在锁外分页准备。
    // 只存在于内存的派生状态（无密钥或只读）没有可持久的分页进度，分页只会让严格模式
    // 每页重复整份核验，因此与 C8 严格模式一样在本次操作内一次追平。
    if (!projection.state.isPersistent() || (projection.state.readiness() === "ready" &&
        authorityTailWithinInlineBudget(projection.state.checkpoints().authority!, head))) {
      await this.#catchUpInline([projection.state.projectionId], []);
      if (projection.failure !== undefined) throw projection.failure;
      if (projection.synchronized) return;
    }
    throw new AuthorityPreparationRequired([projection.state.projectionId]);
  }

  /** 锁内逐页追平有界尾部；故障留在各自投影上，由调用方按依赖决定是否拒绝。 */
  /**
   * 写入前的日志同步：已登记的健康投影在硬界之内的落后量锁内追平（含闲置投影），超出硬界、
   * 新建或重建中的相关投影在锁外分页准备；无关的候选只推进覆盖位置，故障投影只拒绝相关写。
   *
   * 不给 affected 即预同步：打开、采纳其他实例的发布与硬界内追平是日志自身的工作，成本随
   * 登记的投影数增长，不得记在调用方按业务估算的物理计划上，故写入口在进入调用方步骤之前
   * 先做一遍。预同步不拒绝任何写，故障与超界原样留给追加时按相关性处理。
   */
  async #synchronizeRegisteredProjections(
    previousCheckpoint: DurableLogCheckpoint,
    affected?: readonly RegisteredDurableProjection[],
  ): Promise<void> {
    const related = (projection: RegisteredDurableProjection) => affected?.includes(projection) === true;
    const inline: string[] = [], inlineCoverage: string[] = [], pending: string[] = [], coverage: string[] = [];
    for (const projection of this.#durableProjections.values()) {
      try {
        await this.#openDurableProjection(projection, previousCheckpoint);
      } catch (error) {
        if (related(projection) || isTransientProjectionError(error)) throw error;
        continue;
      }
      if (projection.failure !== undefined) {
        if (related(projection)) throw projection.failure;
        continue;
      }
      if (projection.synchronized) continue;
      const id = projection.state.projectionId;
      if (!projection.state.isPersistent()) {
        // 内存派生状态：本次操作内一次追平（见 #synchronizeDurableProjection）。
        (projection.state.readiness() === "ready" || related(projection) ? inline : inlineCoverage).push(id);
      } else if (projection.state.readiness() === "ready") {
        (authorityTailWithinInlineBudget(projection.state.checkpoints().authority!, previousCheckpoint) ? inline : pending).push(id);
      } else if (related(projection)) {
        pending.push(id);
      } else {
        const covered = projection.state.unrelatedThrough().authority!;
        if (!sameDurableCheckpoint(covered, previousCheckpoint)) {
          (authorityTailWithinInlineBudget(covered, previousCheckpoint) ? inlineCoverage : coverage).push(id);
        }
      }
    }
    if (pending.length || coverage.length) {
      if (!affected) return;
      const preparation = new AuthorityPreparationRequired(pending, false, coverage);
      preparation.isolateFailures = true;
      preparation.requiredProjections = affected.map(projection => projection.state.projectionId);
      throw preparation;
    }
    if (inline.length || inlineCoverage.length) {
      await this.#catchUpInline(inline, inlineCoverage);
      for (const projection of affected ?? []) {
        if (projection.failure !== undefined) throw projection.failure;
        if (!projection.synchronized) throw new AuthorityPreparationRequired([projection.state.projectionId]);
      }
    }
  }

  /** 调用方给出物理步骤时，在锁内、进入该步骤之前完成日志同步（见 #synchronizeRegisteredProjections）。 */
  #physicalStepAfterSynchronization(runPhysicalStep: PhysicalStorageStepRunner | undefined): PhysicalStorageStepRunner {
    if (!runPhysicalStep) return async (operation) => operation();
    return async (operation) => {
      if (!this.#readOnly) {
        await this.#synchronizeRegisteredProjections(this.#durableCheckpoint(await this.#loadLastLsn()));
      }
      return runPhysicalStep(operation);
    };
  }

  async #catchUpInline(ids: readonly string[], coverage: readonly string[]): Promise<void> {
    // 同一次持锁操作内源头不会变化，投影也已在首页打开并校验：后续页复用首页的头部，
    // 不再逐页重新核验 WAL 或检查点（严格模式下那是整份核验）。
    let head: DurableLogCheckpoint | undefined;
    while (!await this.#recoverProjectionPage(ids, coverage, true, head)) {
      head ??= this.#durableCheckpoint(this.#verifiedTail!.lastLsn);
    }
  }

  /**
   * 显式就绪准备：所选投影在同一个已验位置全部就绪后返回该位置。准备工作在日志锁之间分页
   * 进行，不依赖启动恰好发生写入。给出 boundary 时按日志记录这个就绪位置，供判定就绪之后
   * 是否还在回补该位置之前的帧。
   */
  async prepareProjections(ids?: readonly string[], boundary?: string): Promise<AuthorityPreparedWatermark> {
    const started = performance.now();
    // 未指定时准备全部已登记投影：一个投影的永久故障不升级为全局阻塞，它被排除在水位集合外，
    // 相关读写仍由其自身的不可用状态拒绝。显式点名的投影必须全部就绪。
    const watermark = await this.#prepareProjectionsAt(ids ?? [...this.#durableProjections.keys()], ids === undefined);
    if (boundary) {
      this.#records?.record({ event: "prepared", refs: [{ kind: "authority", id: watermark.logId }], data: {
        boundary, lsn: watermark.lsn, frameEndOffset: watermark.frameEndOffset, projections: watermark.projections.length,
        durationMs: Math.round(performance.now() - started),
      } });
    }
    return watermark;
  }

  async #prepareProjectionsAt(ids: readonly string[], tolerateFailures: boolean): Promise<AuthorityPreparedWatermark> {
    const projections = [...new Set(ids)].map(id => {
      const projection = this.#durableProjections.get(id);
      if (!projection) throw new TypeError(`Durable projection is not registered: ${id}`);
      return projection;
    });
    return this.#withLogLock("projection.checkpoint", async () => {
      const head = this.#durableCheckpoint(await this.#loadLastLsn());
      const pending: string[] = [];
      const prepared: string[] = [];
      // 各投影目录互不相关：先并行打开（首次打开即初始化），失败在下面逐个打开时原样处理。
      await Promise.all(projections.map(projection => this.#openDurableProjection(projection, head).catch(() => undefined)));
      for (const projection of projections) {
        try {
          await this.#openDurableProjection(projection, head);
        } catch (error) {
          if (!tolerateFailures || isTransientProjectionError(error)) throw error;
          continue;
        }
        if (projection.failure !== undefined) {
          if (tolerateFailures) continue;
          throw projection.failure;
        }
        if (!projection.synchronized) pending.push(projection.state.projectionId);
        else prepared.push(projection.state.projectionId);
      }
      // 内存派生状态在本次操作内一次追平；可持久的才交给锁外分页准备。
      const memoryOnly = pending.filter(id => !this.#durableProjections.get(id)!.state.isPersistent());
      if (memoryOnly.length) {
        await this.#catchUpInline(memoryOnly, []);
        for (const id of memoryOnly) {
          const projection = this.#durableProjections.get(id)!;
          if (projection.failure !== undefined && !tolerateFailures) throw projection.failure;
          if (projection.synchronized) {
            pending.splice(pending.indexOf(id), 1);
            prepared.push(id);
          } else if (projection.failure !== undefined) {
            pending.splice(pending.indexOf(id), 1);
          }
        }
      }
      if (pending.length) {
        const required = new AuthorityPreparationRequired(pending);
        required.isolateFailures = tolerateFailures;
        throw required;
      }
      return { ...head, projections: prepared };
    });
  }

  /** One bounded source page serves every projection needing that interval.
   * The caller releases the source lock between pages and before any wait. */
  async #recoverProjectionPage(ids: readonly string[], coverageIds: readonly string[], isolateFailures = false,
    continuedHead?: DurableLogCheckpoint, requiredIds?: readonly string[]): Promise<boolean> {
    const head = continuedHead ?? this.#durableCheckpoint(await this.#loadLastLsn());
    const required = new Set(requiredIds);
    const canIsolate = (projection: RegisteredDurableProjection) =>
      isolateFailures && !required.has(projection.state.projectionId);
    const coverageOnly = new Set(coverageIds);
    const projections: RegisteredDurableProjection[] = [];
    for (const id of new Set([...ids, ...coverageIds])) {
      const projection = this.#durableProjections.get(id)!;
      try {
        if (!continuedHead) await this.#openDurableProjection(projection, head);
      } catch (error) {
        if (!canIsolate(projection) || isTransientProjectionError(error)) throw error;
        continue;
      }
      if (projection.failure !== undefined) {
        if (canIsolate(projection)) continue;
        throw projection.failure;
      }
      const checkpoint = coverageOnly.has(id) && projection.state.readiness() === "building"
        ? projection.state.unrelatedThrough().authority : projection.state.checkpoints().authority;
      if (!sameDurableCheckpoint(checkpoint, head)) projections.push(projection);
    }
    if (!projections.length) return true;
    const starts = projections.map(projection => {
      const state = projection.state;
      const data = state.checkpoints().authority!;
      return state.readiness() === "building" &&
        (coverageOnly.has(state.projectionId) || sameDurableCheckpoint(data, state.recoveryTarget()!.authority!))
        ? state.unrelatedThrough().authority! : data;
    });
    const start = starts.reduce((a, b) => a.lsn < b.lsn ? a : b);
    const restarted = new Set<RegisteredDurableProjection>();
    const reads = projections.map(projection => projection.authenticated ? recoveryPageRead(projection.read, () => projection.state.servesFromMemory()) : undefined);
    let frames = 0;
    await this.#scanLogFrom(start.frameEndOffset, start.lsn, start.prefixDigest, async (envelope, boundary) => {
      for (let i = 0; i < projections.length; i++) {
        const projection = projections[i]!;
        if (projection.failure !== undefined || restarted.has(projection) || boundary.lsn <= starts[i]!.lsn) continue;
        const state = projection.state;
        try {
          const consumes = projectionConsumes(projection.inputs, envelope.entries);
          if (state.readiness() === "building" && boundary.lsn > state.unrelatedThrough().authority!.lsn) {
            if (consumes) state.extendRecoveryTarget({ authority: boundary });
            else state.coverRecoveryGap({ authority: boundary });
          }
          if (!coverageOnly.has(state.projectionId) || state.readiness() === "ready") {
            const data = state.checkpoints().authority!;
            if (boundary.lsn > data.lsn && (state.readiness() === "ready" || boundary.lsn <= state.recoveryTarget()!.authority!.lsn)) {
              if (boundary.lsn !== data.lsn + 1) continue;
              if (consumes) {
                const mutations = await verifyProtocolStep(() => projection.reduce(envelope, reads[i]?.view ?? projection.read, this.#projectionSource(boundary, envelope)));
                const prepared = await state.prepare(bindDurableProjectionMutations(mutations));
                state.publish(prepared, { authority: boundary });
                reads[i]?.invalidate(mutations);
              } else state.coverUnchangedSource({ authority: boundary });
            }
          }
        } catch (error) {
          // 恢复准备、容量背压与验签身份补齐都不是投影本身的故障：放弃本页未发布的进度，锁外处理后重跑。
          if (isTransientProjectionError(error)) throw error;
          if (error instanceof DurableProjectionStorageError && !projection.recoveryReset) {
            projection.recoveryReset = true;
            await state.reset({ authority: this.#durableCheckpoint(0) }, { authority: head });
            restarted.add(projection);
            continue;
          }
          // Permanent invalid facts retain their original failure. They must
          // never enter an automatic retry loop or disable unrelated writers.
          projection.failure = error;
          delete projection.synchronized;
        }
      }
      frames++;
      if (this.#work) this.#work.preparedFrames++;
      return frames < AUTHORITY_RECOVERY_BUDGET.pageFrames &&
        boundary.frameEndOffset - start.frameEndOffset < AUTHORITY_RECOVERY_BUDGET.pageBytes && boundary.lsn < head.lsn;
    }, 0, undefined, undefined, { frames: AUTHORITY_RECOVERY_BUDGET.pageFrames, bytes: AUTHORITY_RECOVERY_BUDGET.pageBytes });
    for (const projection of projections) {
      if (projection.failure !== undefined) continue;
      const state = projection.state;
      if (state.readiness() === "building" && sameDurableCheckpoint(state.checkpoints().authority, state.recoveryTarget()!.authority!) &&
          sameDurableCheckpoint(state.unrelatedThrough().authority, head)) {
        await state.finishRebuild({ authority: head });
      } else await state.checkpointRecovery();
      if (state.readiness() === "ready" && sameDurableCheckpoint(state.checkpoints().authority, head)) {
        projection.synchronized = true;
        delete projection.recoveryReset;
      }
    }
    for (const projection of projections) if (projection.failure !== undefined && !canIsolate(projection)) throw projection.failure;
    return false;
  }

  async #prepareRecovery(required: AuthorityPreparationRequired): Promise<void> {
    for (;;) {
      if (this.#maintenanceStopped) throw new Error("Authority recovery stopped");
      const done = await this.#withLogLock("projection.prepare", async () => {
        if (required.frameIndex) await this.#flushFrameIndex();
        return this.#recoverProjectionPage(required.projections, required.coverage, required.isolateFailures, undefined, required.requiredProjections);
      });
      if (done) return;
      if (this.#maintenanceStopped) throw new Error("Authority recovery stopped");
      await yieldToIo();
    }
  }

  #queuePreparation(required: AuthorityPreparationRequired): Promise<void> {
    const abort = currentMaintenanceAbortSignal();
    return this.#sourceScope.exit(() => runDetachedMaintenanceContext("recovery", () => this.#maintenanceRunner.run(
      storageMaintenanceObligation("authority-projection-recovery", this.rootDir, {
        source: this.#logId, projections: [...required.projections].sort(), coverage: [...required.coverage].sort(),
        frameIndex: required.frameIndex, isolateFailures: required.isolateFailures, required: required.requiredProjections ?? null,
      }, { owner: "authority-commit-log", obligation: "committed" }), abort, () => this.#prepareRecovery(required),
    )));
  }

  async #append<Body>(
    entries: Array<LogicalRecord<Body>>,
    committedAt?: IsoTime,
    preparedEnvelope?: CommitEnvelope<Body>,
  ): Promise<CommitEnvelope<Body>> {
    if (this.#readOnly) throw new TypeError("Authority log is read-only");
    for (const guard of this.#appendAdmissionGuards) {
      guard(entries as Array<LogicalRecord<unknown>>);
    }
    const previousLsn = await this.#loadLastLsn();
    const previousCheckpoint = this.#durableCheckpoint(previousLsn);
    const affected = [...this.#durableProjections.values()].filter(projection => projectionConsumes(projection.inputs, entries));
    await this.#synchronizeRegisteredProjections(previousCheckpoint, affected);
    const unchanged = [...this.#durableProjections.values()].filter(projection =>
      projection.synchronized && !affected.includes(projection) &&
      sameDurableCheckpoint(projection.state.checkpoints().authority, previousCheckpoint));
    const buildingUnrelated = [...this.#durableProjections.values()].filter(projection =>
      projection.failure === undefined && projection.state.readiness() === "building" && !affected.includes(projection));
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
    const singleStream = entries.every((entry) => entry.stream === entries[0]!.stream)
      ? entries[0]!.stream
      : undefined;
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
    await this.#admitRecoveryDebt(previousCheckpoint, frame.byteLength, affected);
    this.#admitTailConsumers(previousCheckpoint, frame.byteLength);
    const preparedProjections: Array<{
      readonly projection: RegisteredDurableProjection;
      readonly prepared: Awaited<
        ReturnType<FileDurableProjectionIndex["prepare"]>
      >;
      readonly checkpoints: DurableProjectionCheckpoints;
    }> = [];
    for (const projection of affected) {
      const prepared = await this.#withDurableProjectionRecovery(
        projection,
        async () => {
          const mutations = await verifyProtocolStep(() => projection.reduce(
            envelope as unknown as CommitEnvelope<JsonValue>,
            projection.read,
            this.#projectionSource(checkpoint, envelope, true),
          ));
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
    let previousView: VerifiedWalView | undefined;
    try {
      const metadata = await readWalVersion(handle);
      if (
        metadata.dev !== previousTail.device ||
        metadata.ino !== previousTail.inode ||
        metadata.size !== previousTail.bytes ||
        !matchesWalVersion(previousTail, metadata)
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
        modifiedAt: undefined,
        changedAt: undefined,
        lastLsn: checkpoint.lsn,
        prefixDigest: checkpoint.prefixDigest,
        physicalHash: previousTail.physicalHash?.copy().update(frame),
      };
      previousView = verifiedWalViews.get(this.logPath, checkpoint.logId, metadata);
      verifiedWalViews.delete(this.logPath);
      this.#operationView = undefined;
      await handle.writeFile(frame);
      await handle.sync();
      committed = true;
      this.#records?.record(() => ({ event: "committed", result: "success",
        refs: [{ kind: "authority", id: checkpoint.logId }, ...authorityObservationRefs(entries)],
        data: { lsn, count: entries.length, streams: entries.slice(0, 32).map((entry) => entry.stream) },
      }));
      this.#verifiedTail = nextTail;
      // 认证帧索引随本进程刚写入的帧延伸；索引只是缓存，延伸失败即放弃，下次操作按封条重开。
      if (this.#frameIndex) {
        try {
          this.#frameIndex.append({
            format: this.#requireLogFormat(),
            frameEndOffset,
            payloadBytes: bytes.byteLength,
            payloadDigest: createHash("sha256").update(bytes).digest(),
            prefixDigest,
            streams: entries.map((entry) => entry.stream),
          });
          this.#scheduleFrameIndexFlush();
        } catch {
          this.#frameIndex = undefined;
        }
      }
      for (const { projection, prepared, checkpoints } of preparedProjections) {
        projection.state.publish(prepared, checkpoints);
      }
      for (const projection of unchanged) if (projection.failure === undefined) projection.state.coverUnchangedSource({ authority: checkpoint });
      for (const projection of buildingUnrelated) if (projection.failure === undefined) projection.state.coverRecoveryGap({ authority: checkpoint });
      // Cache publication is optional after the durable commit. A failed stat
      // must never turn a committed write into an apparent failed transaction.
      const published = await readWalVersion(handle).catch(() => undefined);
      if (published && published.dev === nextTail.device && published.ino === nextTail.inode &&
          published.size === nextTail.bytes) {
        nextTail = { ...nextTail, modifiedAt: published.mtimeNs, changedAt: published.ctimeNs };
        this.#verifiedTail = nextTail;
      }
    } catch (error) {
      if (!committed) this.#records?.record(() => ({ event: "uncertain", result: "unknown",
        refs: [{ kind: "authority", id: checkpoint.logId }, ...authorityObservationRefs(entries)],
        data: { lsn, error: error instanceof Error ? error.message : "权威追加异常" },
      }));
      throw error;
    } finally {
      if (committed) {
        await handle.close().catch(() => undefined);
      } else {
        await handle.close();
      }
    }
    if (previousView && nextTail && nextTail.modifiedAt !== undefined) {
      try {
        // 追加只给视图多挂一块（这一帧本身），不复制已保留的字节与帧表。
        const extended = extendVerifiedWalView(previousView, nextTail, frame, {
          lsn, frameEndOffset, prefixDigest,
          payloadStart: AUTHORITY_WAL_HEADER_BYTES, payloadBytes: bytes.byteLength,
          ...(singleStream === undefined ? {} : { singleStream }),
        });
        const compared = viewComparedAt.get(previousView);
        if (compared !== undefined) viewComparedAt.set(extended, compared);
        verifiedWalViews.put(this.logPath, extended, this.#viewLimits);
      } catch { verifiedWalViews.delete(this.logPath); } // Never fail an already durable commit for an optimization.
    }
    this.#refreshTailConsumers(checkpoint);
    return envelope;
  }

  /**
   * 耐久欠账加本次追加越过硬界时在追加前背压：由日志锁外让消费者追平并发布覆盖位置，再重跑本次
   * 操作、重新核对 head 与额度。合法大帧只在先前欠账全部发布后接纳。
   */
  #admitTailConsumers(head: DurableLogCheckpoint, bytes: number): void {
    for (const consumer of this.#tailConsumers) {
      // 整段重建的尾部分别计量，不挡新写入；重建由提交后的刷新推进。
      if (consumer.rebuilding?.()) continue;
      if (!tailConsumerNeedsFlush(consumer.coveredThrough(head.logId), head, bytes, true)) continue;
      const required = new AuthorityPreparationRequired([]);
      required.prepareOutside = () => consumer.publishCoverage();
      throw required;
    }
  }

  /** 已提交之后越过主动刷新阈值的外部消费者异步追平并发布，不让下一次追加撞上硬界。 */
  #refreshTailConsumers(head: DurableLogCheckpoint): void {
    for (const consumer of this.#tailConsumers) {
      if (!consumer.rebuilding?.() && !tailConsumerNeedsFlush(consumer.coveredThrough(head.logId), head, 0, false)) continue;
      try { consumer.refresh(); } catch { /* 刷新只是提前追平，不能让已提交的追加失败。 */ }
    }
  }

  async #admitRecoveryDebt(head: DurableLogCheckpoint, bytes: number, affected: readonly RegisteredDurableProjection[]): Promise<void> {
    if (this.#frameIndex) {
      const index = this.#frameIndex;
      const sealed = { ...head, lsn: index.sealedLsn, frameEndOffset: index.sealedFrameEnd };
      if (authorityTailNeedsFlush(sealed, head, bytes) || authorityTailNeedsFlush(sealed, head, 0, false)) {
        await this.#flushFrameIndex();
        if (authorityTailNeedsFlush({ ...head, lsn: index.sealedLsn, frameEndOffset: index.sealedFrameEnd }, head, bytes)) {
          this.#frameIndex = undefined;
          this.#verifiedTail = undefined;
          throw new AuthorityProjectionUnavailable("authority-frame-index", new FrameIndexUnavailableError("Frame index seal publication did not cover required recovery debt"));
        }
      }
    }
    for (const projection of this.#durableProjections.values()) {
      if (!projection.opened || projection.failure !== undefined || !projection.state.isPersistent()) continue;
      const state = projection.state;
      const published = state.readiness() === "building" ? state.publishedRecoveryCoverage().authority! : state.publishedCheckpoints().authority!;
      if (!authorityTailNeedsFlush(published, head, bytes) && !authorityTailNeedsFlush(published, head, 0, false)) continue;
      try {
        await state.flush({ compact: false });
      } catch (error) {
        if (isTransientProjectionError(error)) throw error;
        projection.failure = new AuthorityProjectionUnavailable(state.projectionId, error);
        delete projection.synchronized;
        if (affected.includes(projection)) throw projection.failure;
      }
    }
  }

  /**
   * 认证模式：开启启动证明，且组合入口在打开前注入了本 home 的缓存密钥。
   * 有钥只读访问者可复用现有认证证明，缺失或失效时严格回退；不发布或删除缓存。
   * legacy 复用同一索引，但封条还须绑定无文件头的实际来源身份。
   */
  async #authenticatedMode(): Promise<boolean> {
    if (!this.#startupProofs || !this.#integrity) return false;
    if (!this.#readOnly) return true;
    if (this.#readOnlyIndexLogId !== this.#requireLogId()) {
      this.#readOnlyIndexLogId = this.#requireLogId();
      this.#readOnlyIndexUsable = undefined;
    }
    this.#readOnlyIndexUsable ??= !!await AuthenticatedFrameIndex.open(this.rootDir, this.#requireLogId(),
      this.#logDataStartOffset(), emptyLogPrefix(this.#requireLogId()), this.#integrity,
      this.#requireLogFormat() === "legacy" ? await readWalVersion(this.logPath) : undefined);
    return this.#readOnlyIndexUsable;
  }

  /**
   * 认证模式下的尾部：文件元数据与已知尾部一致即直接采用；同一文件被延长或只有时间戳变化时，
   * 核对已知尾边界仍是同一帧后只续扫新增的帧；其余情形按封条重新打开。已认证范围内的历史字节
   * 不在这里重读，它们在被读取时逐帧按认证索引核对，并由后台巡检定期全量核对。
   */
  async #loadAuthenticatedTail(metadata: WalFileVersion): Promise<number> {
    const tail = this.#verifiedTail;
    const index = this.#frameIndex;
    if (this.#readOnly && index && metadata.size - index.sealedFrameEnd > maximumAuthorityRecoveryTailBytes()) {
      return this.#openAuthenticated(metadata);
    }
    if (index && tail && tail.logId === this.#requireLogId() &&
        index.headLsn === tail.lastLsn && index.headFrameEnd === tail.bytes) {
      if (matchesWalVersion(tail, metadata)) return tail.lastLsn;
      if (tail.device === metadata.dev && tail.inode === metadata.ino && metadata.size >= tail.bytes) {
        try {
          await this.#verifyFrameBoundary(tail.bytes, tail.lastLsn, tail.prefixDigest, index);
        } catch (error) {
          if (!(error instanceof AuthorityStorageError || error instanceof FrameIndexUnavailableError)) throw error;
          return this.#openAuthenticated(metadata);
        }
        verifiedWalViews.delete(this.logPath);
        this.#operationView = undefined;
        const extended = await this.#extendAuthenticated(index, tail.bytes, tail.lastLsn, tail.prefixDigest);
        if (extended.incompleteTail) {
          this.#records?.record({ event: "recovered", result: "success", refs: [{ kind: "authority", id: tail.logId }], data: { lsn: extended.lastLsn, incompleteTail: true } });
        }
        return extended.lastLsn;
      }
    }
    return this.#openAuthenticated(metadata);
  }

  /**
   * 按封条打开认证帧索引：核对头部仍在当前日志上（versioned帧尾；legacy认证行及载荷），再续扫
   * 其后的尾部。封条缺失、认证不过或头部不在当前日志上（日志被替换、截短或损坏）时完整核验并
   * 以新纪元重建索引。
   */
  async #openAuthenticated(metadata?: WalFileVersion): Promise<number> {
    this.#frameIndex = undefined;
    this.#verifiedTail = undefined;
    verifiedWalViews.delete(this.logPath);
    this.#operationView = undefined;
    const logId = this.#requireLogId();
    const dataStart = this.#logDataStartOffset();
    const emptyPrefix = emptyLogPrefix(logId);
    const source = this.#requireLogFormat() === "legacy" ? metadata ?? await readWalVersion(this.logPath) : undefined;
    let index = await AuthenticatedFrameIndex.open(this.rootDir, logId, dataStart, emptyPrefix, this.#integrity, source);
    // Truncation invalidates an old derived head. On an unchanged physical
    // legacy source, however, a present head with different authenticated bytes
    // is an authority failure, not permission to discard its proof and accept it.
    if (index && source && index.headFrameEnd > source.size) index = undefined;
    if (index) {
      try {
        await this.#verifyFrameBoundary(index.headFrameEnd, index.headLsn, index.headPrefix, index);
      } catch (error) {
        if (source && error instanceof AuthorityStorageError) throw error;
        if (!(error instanceof AuthorityStorageError || error instanceof FrameIndexUnavailableError)) throw error;
        index = undefined;
      }
    }
    if (!index) {
      if (this.#readOnly) {
        this.#readOnlyIndexUsable = false;
        return this.#loadLastLsn();
      }
      // A rejected but correctly authenticated old seal must not veto the new
      // epoch at flush. Only derived files are discarded, under the WAL lock.
      await AuthenticatedFrameIndex.discard(this.rootDir);
      index = AuthenticatedFrameIndex.create(this.rootDir, logId, dataStart, emptyPrefix, this.#integrity, source);
      // 旧版的已核验帧证明旁路已由认证帧索引取代。
      await durablyRemoveFiles([path.join(this.rootDir, "verified-frames-v1.json")]).catch(() => undefined);
    }
    if (this.#readOnly && (await readWalVersion(this.logPath)).size - index.sealedFrameEnd > maximumAuthorityRecoveryTailBytes()) {
      this.#readOnlyIndexUsable = false;
      return this.#loadLastLsn();
    }
    const extended = await this.#extendAuthenticated(index, index.headFrameEnd, index.headLsn, index.headPrefix);
    this.#records?.record({ event: "recovered", result: "success", refs: [{ kind: "authority", id: logId }], data: { lsn: extended.lastLsn, incompleteTail: extended.incompleteTail } });
    this.#scheduleFrameIndexAudit(FRAME_INDEX_AUDIT_DELAY_MS);
    return extended.lastLsn;
  }

  /** Versioned has a footer proof; legacy needs the authenticated row and its payload. */
  async #verifyFrameBoundary(frameEndOffset: number, lsn: number, prefixDigest: string, index: AuthenticatedFrameIndex): Promise<void> {
    if (lsn === 0) {
      if (frameEndOffset !== this.#logDataStartOffset() || prefixDigest !== emptyLogPrefix(this.#requireLogId())) {
        throw new AuthorityStorageError("commit-log-corrupt", "Empty authenticated WAL boundary is invalid");
      }
      return;
    }
    const handle = await open(this.logPath, "r");
    try {
      if (this.#requireLogFormat() === "legacy") {
        const row = await index.row(lsn);
        if (row.frameEndOffset !== frameEndOffset || row.prefixDigest !== prefixDigest) {
          throw new FrameIndexUnavailableError("Frame index head does not match its seal");
        }
        const start = row.payloadOffset - AUTHORITY_WAL_HEADER_BYTES;
        this.#verifyIndexedFrame(row, await this.#readExactAt(handle, start, frameEndOffset - start), 0);
        return;
      }
      const metadata = await readWalVersion(handle);
      const boundary = await verifyAuthorityWalFrameBoundary(this.#walReader(handle, metadata.size), frameEndOffset);
      if (boundary.metadata?.lsn !== lsn || boundary.metadata.prefixDigest !== prefixDigest) {
        throw new AuthorityStorageError("commit-log-corrupt", "Authority WAL boundary does not match its authenticated index");
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * 从已核验边界起完整核验其后的每一帧（逐帧解码、LSN 连续、前缀链与帧尾一致），为每帧追加认证
   * 行；不完整的尾部隔离后截掉。完成后索引与已核验尾部覆盖到同一位置。
   */
  async #extendAuthenticated(
    index: AuthenticatedFrameIndex,
    startOffset: number,
    previousLsn: number,
    previousPrefix: string,
  ): Promise<{ readonly lastLsn: number; readonly incompleteTail: boolean }> {
    const logId = this.#requireLogId();
    let expectedLsn = previousLsn + 1;
    let prefixDigest = previousPrefix;
    const handle = await open(this.logPath, "r");
    let scanned: Awaited<ReturnType<typeof scanAuthorityWalFrames>>;
    try {
      const metadata = await readWalVersion(handle);
      if (startOffset > metadata.size) {
        throw new AuthorityStorageError("commit-log-corrupt", "Authority WAL is shorter than its verified boundary");
      }
      scanned = await scanAuthorityWalFrames(
        this.#walReader(handle, metadata.size - startOffset, startOffset),
        (payload, offset, frameMetadata, nextOffset) => {
          const envelope = parseEnvelope(payload);
          if (envelope.lsn !== expectedLsn) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Commit log LSN ${envelope.lsn} does not follow ${expectedLsn - 1}`,
            );
          }
          prefixDigest = advanceProjectionPrefix(logId, prefixDigest, envelope);
          const proofMatches = this.#requireLogFormat() === "versioned"
            ? frameMetadata?.lsn === envelope.lsn && frameMetadata.prefixDigest === prefixDigest
            : frameMetadata === undefined;
          if (!proofMatches) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Authority WAL frame proof is invalid at byte ${startOffset + offset}`,
            );
          }
          index.append({
            format: this.#requireLogFormat(),
            frameEndOffset: startOffset + nextOffset,
            payloadBytes: payload.byteLength,
            payloadDigest: createHash("sha256").update(payload).digest(),
            prefixDigest,
            streams: envelope.entries.map((entry) => entry.stream),
          });
          expectedLsn += 1;
        },
      );
    } finally {
      await handle.close();
    }
    if (scanned.incompleteTail) {
      await this.#quarantineTail(scanned.incompleteTail, startOffset + scanned.validBytes);
    }
    this.#frameIndex = index;
    await this.#recordVerifiedTail(expectedLsn - 1, prefixDigest);
    if (index.dirty) this.#scheduleFrameIndexFlush();
    return { lastLsn: expectedLsn - 1, incompleteTail: scanned.incompleteTail !== undefined };
  }

  /** 认证模式下第 `lsn` 帧的索引行；严格模式返回 undefined。 */
  async #authenticatedRow(lsn: number): Promise<FrameIndexRow | undefined> {
    if (!await this.#authenticatedMode()) return undefined;
    const read = async () => {
      const lastLsn = await this.#loadLastLsn();
      return lsn <= lastLsn ? this.#frameIndex?.row(lsn) : undefined;
    };
    try { return await read(); }
    catch (error) {
      if (!(error instanceof FrameIndexUnavailableError)) throw error;
      this.#frameIndex = undefined;
      this.#verifiedTail = undefined;
      this.#operationView = undefined;
      verifiedWalViews.delete(this.logPath);
      if (this.#readOnly) this.#readOnlyIndexUsable = false;
      else await AuthenticatedFrameIndex.discard(this.rootDir);
      return read();
    }
  }

  /**
   * 认证模式的投影续读：游标恰在尾部时直接返回；否则核对游标边界与认证索引一致后，只读取其后
   * 被选中的帧。游标前缀与本日志不符时与严格模式同样拒绝。
   */
  async #readAuthenticatedProjectionTail(
    metadata: WalFileVersion,
    cursor: FileProjectionCursor | undefined,
    afterLsn: number,
    visit: (envelope: CommitEnvelope<JsonValue>, checkpoint: DurableLogCheckpoint) => void | Promise<void>,
    select: EnvelopeSelection | undefined,
  ): Promise<{ readonly lastLsn: number; readonly cursor: ProjectionCursor }> {
    const lastLsn = await this.#loadAuthenticatedTail(metadata);
    if (!this.#frameIndex) return this.#readProjectionTail(cursor, afterLsn, visit);
    const logId = this.#requireLogId();
    if (cursor && cursor.lsn <= lastLsn) {
      const boundary = await this.#frameIndex!.boundary(cursor.lsn);
      if (cursor.logId !== logId || cursor.prefixDigest !== boundary.prefixDigest ||
          (cursor.lsn > 0 && cursor.byteOffset !== boundary.frameEndOffset)) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Projection cursor prefix does not match the current commit log",
        );
      }
      if (cursor.lsn === lastLsn) return { lastLsn, cursor: this.#projectionCursor(lastLsn) };
    }
    if (cursor && cursor.lsn > lastLsn) return { lastLsn, cursor: this.#projectionCursor(lastLsn) };
    const from = cursor && cursor.lsn > 0 ? cursor.lsn : 0;
    const start = await this.#frameIndex!.boundary(from);
    const scanned = await this.#scanAuthenticated(start.frameEndOffset, from, start.prefixDigest,
      async (envelope, checkpoint) => { if (envelope.lsn > afterLsn) await visit(envelope, checkpoint); },
      afterLsn + 1, select);
    return { lastLsn: scanned.lastLsn, cursor: this.#projectionCursor(scanned.lastLsn) };
  }

  /**
   * 认证模式的历史读取：从已核对的边界起，按认证索引读取被选中的帧，逐帧核对载荷摘要后交给
   * 调用方。从头整读时顺带建立已核验视图，此后的整读不再读盘。索引页缺失或认证不过时放弃索引、
   * 完整核验重建后再读；访问开始之后不会因此中断。
   */
  async #scanAuthenticated(
    startOffset: number,
    previousLsn: number,
    previousPrefixDigest: string,
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => boolean | void | Promise<boolean | void>,
    fromLsn: number,
    select?: EnvelopeSelection,
    budget?: { readonly frames: number; readonly bytes: number },
  ): Promise<ScannedLog> {
    let lastLsn = await this.#loadLastLsn();
    if (this.#readOnly && !this.#frameIndex) {
      return this.#scanLogFrom(startOffset, previousLsn, previousPrefixDigest, visit, fromLsn, undefined, select, budget);
    }
    const first = Math.max(previousLsn + 1, fromLsn, 1);
    try {
      await this.#frameIndex?.ensureRows(first, budget ? Math.min(lastLsn, first + budget.frames - 1) : lastLsn);
    } catch (error) {
      if (!(error instanceof FrameIndexUnavailableError)) throw error;
      this.#frameIndex = undefined;
      if (this.#readOnly) {
        this.#readOnlyIndexUsable = false;
        this.#verifiedTail = undefined;
        await this.#loadLastLsn();
        return this.#scanLogFrom(startOffset, previousLsn, previousPrefixDigest, visit, fromLsn, undefined, select, budget);
      }
      await AuthenticatedFrameIndex.discard(this.rootDir);
      lastLsn = await this.#openAuthenticated();
    }
    const index = this.#frameIndex;
    const tail = this.#verifiedTail;
    if (!index || !tail || index.headLsn !== lastLsn) {
      throw new AuthorityStorageError("commit-log-corrupt", "Authenticated frame index is not current");
    }
    if (previousLsn > lastLsn) {
      throw new AuthorityStorageError("commit-log-corrupt", "Projection cursor is beyond the end of the commit log");
    }
    const boundary = await index.boundary(previousLsn);
    if (boundary.frameEndOffset !== startOffset || boundary.prefixDigest !== previousPrefixDigest) {
      throw new AuthorityStorageError("commit-log-corrupt", "Projection boundary does not match the verified WAL");
    }
    const logId = tail.logId;
    let until = lastLsn;
    if (budget) {
      until = Math.min(lastLsn, first + budget.frames - 1);
      for (let lsn = first; lsn <= until; lsn++) {
        const row = await index.row(lsn);
        if (lsn > first && row.frameEndOffset - startOffset > budget.bytes) { until = lsn - 1; break; }
      }
    }
    const version: WalFileVersion | undefined = tail.modifiedAt !== undefined && tail.changedAt !== undefined
      ? { dev: tail.device, ino: tail.inode, size: tail.bytes, mtimeNs: tail.modifiedAt, ctimeNs: tail.changedAt }
      : undefined;
    const view = version ? verifiedWalViews.get(this.logPath, logId, version) : undefined;
    if (view && view.tail.lastLsn === lastLsn && view.frameCount === lastLsn) {
      return this.#visitVerifiedView(view, startOffset, previousLsn, previousPrefixDigest, visit, fromLsn, select, budget);
    }
    if (first > lastLsn) return { lastLsn, validBytes: tail.bytes, prefixDigest: tail.prefixDigest, reused: true };
    const capture = version !== undefined && previousLsn === 0 && first === 1 && select === undefined &&
      256 + tail.bytes + lastLsn * VERIFIED_WAL_FRAME_RETAINED_BYTES <= this.#viewLimits.bytes &&
      lastLsn <= this.#viewLimits.frames;
    const chunks: Buffer[] = [];
    const frames: VerifiedWalFrame[] = [];
    const handle = await open(this.logPath, "r");
    try {
      if (capture) {
        const header = await this.#readExactAt(handle, 0, this.#logDataStartOffset());
        chunks.push(header);
      }
      const stopped = await this.#forEachAuthenticatedFrame(index, handle, first, until,
        capture ? undefined : select,
        async (row, window, payloadStart, legacyEnvelope) => {
          if (capture) {
            if (chunks[chunks.length - 1] !== window) chunks.push(window);
            frames.push({ lsn: row.lsn, frameEndOffset: row.frameEndOffset, prefixDigest: row.prefixDigest,
              chunk: chunks.length - 1, payloadStart, payloadBytes: row.payloadBytes,
              ...(row.streamTag === undefined ? {} : { streamTag: row.streamTag }),
              ...(row.streamBloom === undefined ? {} : { streamBloom: row.streamBloom }) });
          }
          const envelope = legacyEnvelope ?? JSON.parse(window.toString("utf8", payloadStart, payloadStart + row.payloadBytes)) as CommitEnvelope<JsonValue>;
          const proceed = await visit(envelope, { logId, lsn: row.lsn, frameEndOffset: row.frameEndOffset, prefixDigest: row.prefixDigest });
          return proceed === false && row.frameEndOffset < tail.bytes ? false : undefined;
        });
      if (stopped) {
        return { lastLsn: stopped.lsn, validBytes: stopped.frameEndOffset, prefixDigest: stopped.prefixDigest, stopped: true, reused: true };
      }
      if (until < lastLsn) {
        const end = await index.boundary(until);
        return { lastLsn: until, validBytes: end.frameEndOffset, prefixDigest: end.prefixDigest, stopped: true, reused: true };
      }
    } finally {
      await handle.close();
    }
    if (capture && version && frames.length === lastLsn) {
      const captured: VerifiedWalView = { tail, chunks, chunkCount: chunks.length, frames, frameCount: frames.length };
      verifiedWalViews.put(this.logPath, captured, this.#viewLimits);
    }
    return { lastLsn, validBytes: tail.bytes, prefixDigest: tail.prefixDigest, reused: true };
  }

  /**
   * 按认证索引读取 [first, last] 中被选中的帧：连续的帧合并为不超过读窗口的一次读取，逐帧核对
   * 载荷摘要后回调（窗口与帧载荷在窗口内的偏移）。回调返回 false 时停止并返回该帧的行。
   */
  async #forEachAuthenticatedFrame(
    index: AuthenticatedFrameIndex,
    handle: FileHandle,
    first: number,
    last: number,
    select: EnvelopeSelection | undefined,
    onFrame: (row: FrameIndexRow, window: Buffer, payloadStart: number, legacyEnvelope?: CommitEnvelope<JsonValue>) => boolean | void | Promise<boolean | void>,
  ): Promise<FrameIndexRow | undefined> {
    let lsn = first;
    let yieldAt = performance.now() + AUTHORITY_WAL_SCAN_SLICE_MS;
    while (lsn <= last) {
      // 先按页同步筛出一批被选中的行（只解码这些行），再把相邻的帧合并成读窗口逐帧核对。
      const selected: FrameIndexRow[] = [];
      let next = last + 1;
      await index.scanRows(lsn, last, (rowLsn, raw) => {
        if (select) {
          const summary = frameIndexRowStreams(raw);
          if (!select(summary === undefined ? { lsn: rowLsn } : { lsn: rowLsn, ...summary })) return;
        }
        selected.push(decodeFrameIndexRow(raw, rowLsn));
        if (selected.length >= AUTHENTICATED_ROW_BATCH) {
          next = rowLsn + 1;
          return false;
        }
      });
      lsn = next;
      let start = 0;
      while (start < selected.length) {
        const windowStart = selected[start]!.payloadOffset - AUTHORITY_WAL_HEADER_BYTES;
        let end = start + 1;
        // 相距不远的被选中帧合并为一次顺序读取（顺带读过中间未选中的帧），避免稀疏流逐帧随机读。
        while (end < selected.length) {
          const row = selected[end]!;
          if (row.payloadOffset - AUTHORITY_WAL_HEADER_BYTES - selected[end - 1]!.frameEndOffset > AUTHENTICATED_READ_GAP_BYTES ||
              row.frameEndOffset - windowStart > AUTHENTICATED_READ_WINDOW_BYTES) break;
          end += 1;
        }
        const windowEnd = selected[end - 1]!.frameEndOffset;
        const window = await this.#readExactAt(handle, windowStart, windowEnd - windowStart);
        for (let index = start; index < end; index += 1) {
          const row = selected[index]!;
          const payloadStart = row.payloadOffset - windowStart;
          const legacyEnvelope = this.#verifyIndexedFrame(row, window, payloadStart - AUTHORITY_WAL_HEADER_BYTES);
          if (await onFrame(row, window, payloadStart, legacyEnvelope) === false) return row;
        }
        start = end;
        if (performance.now() >= yieldAt) {
          await yieldToIo();
          yieldAt = performance.now() + AUTHORITY_WAL_SCAN_SLICE_MS;
        }
      }
    }
    return undefined;
  }

  /** A legacy prefix is authenticated by the index, never invented from its 12-byte footer. */
  #verifyIndexedFrame(row: FrameIndexRow, bytes: Buffer, frameStart: number): CommitEnvelope<JsonValue> | undefined {
    const frame = decodeAuthorityWalFrame(bytes, frameStart);
    if (row.format !== this.#requireLogFormat() || frame.kind !== "complete" ||
        frame.nextOffset - frameStart !== row.frameEndOffset - row.payloadOffset + AUTHORITY_WAL_HEADER_BYTES ||
        frame.payload.byteLength !== row.payloadBytes ||
        (row.format === "legacy" ? frame.metadata !== undefined
          : frame.metadata?.lsn !== row.lsn || frame.metadata.prefixDigest !== row.prefixDigest)) {
      throw new AuthorityStorageError("commit-log-corrupt", "Authority WAL frame boundary does not match its authenticated index");
    }
    if (!createHash("sha256").update(frame.payload).digest().equals(row.payloadDigest)) {
      throw new AuthorityStorageError("commit-log-corrupt", `Authority WAL frame ${row.lsn} does not match its authenticated index`);
    }
    if (row.format === "legacy") {
      // The authenticated digest binds the canonical envelope that was fully
      // validated at index construction; materialize it once for LSN and reader.
      let envelope: CommitEnvelope<JsonValue>;
      try { envelope = JSON.parse(frame.payload.toString("utf8")) as CommitEnvelope<JsonValue>; }
      catch { throw new AuthorityStorageError("commit-log-corrupt", "Authenticated legacy envelope is invalid"); }
      if (envelope?.lsn !== row.lsn) throw new AuthorityStorageError("commit-log-corrupt", "Authenticated legacy envelope LSN is invalid");
      return envelope;
    }
    return undefined;
  }

  async #readExactAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (this.#work) this.#work.readBytes += offset;
    if (offset !== length) {
      throw new AuthorityStorageError("commit-log-corrupt", "Authority WAL is shorter than its authenticated index");
    }
    return bytes;
  }

  /** 索引写盘安排在空闲后、日志锁内进行；停止维护后不再安排。 */
  #scheduleFrameIndexFlush(): void {
    if (this.#readOnly || this.#maintenanceStopped || this.#frameIndexFlushTimer) return;
    this.#frameIndexFlushTimer = setTimeout(() => {
      this.#frameIndexFlushTimer = undefined;
      if (this.#maintenanceStopped || !this.#frameIndex?.dirty) return;
      // 计时器会继承安排它的那次操作的维护语境，这里换成独立的后台语境。
      void runDetachedMaintenanceContext("background", () =>
        this.#withLogLock("maintainFrameIndex", () => this.#flushFrameIndex()),
      ).catch(() => undefined);
    }, FRAME_INDEX_FLUSH_DELAY_MS);
    this.#frameIndexFlushTimer.unref?.();
  }

  /** 写出认证帧索引（持有日志写者锁）。只写与当前日志尾部一致的索引；写不成只让下次启动多续扫一段。 */
  async #flushFrameIndex(): Promise<void> {
    if (this.#readOnly) return;
    const index = this.#frameIndex;
    if (!index?.dirty) return;
    if (await this.#loadLastLsn() !== index.headLsn || this.#frameIndex !== index) return;
    await index.flush();
  }

  #scheduleFrameIndexAudit(delayMs: number): void {
    if (this.#readOnly || this.#maintenanceStopped || this.#frameIndexAuditTimer || this.#frameIndexAudit) return;
    this.#frameIndexAuditTimer = setTimeout(() => {
      this.#frameIndexAuditTimer = undefined;
      if (this.#maintenanceStopped) return;
      const running = runDetachedMaintenanceContext("background", () =>
        this.auditFrameIndex(this.#frameIndexAuditAbort.signal),
      ).catch(() => undefined).finally(() => {
        if (this.#frameIndexAudit === running) this.#frameIndexAudit = undefined;
        this.#scheduleFrameIndexAudit(FRAME_INDEX_AUDIT_INTERVAL_MS);
      });
      this.#frameIndexAudit = running;
    }, delayMs);
    this.#frameIndexAuditTimer.unref?.();
  }

  /**
   * 历史帧巡检：按认证索引逐帧核对日志字节，分批持锁、批间让出。发现不符时记录并放弃索引与已核验
   * 尾部，下一次操作随之完整核验——与严格模式发现损坏时的行为一致。返回核对过的帧数。
   */
  async auditFrameIndex(signal?: AbortSignal): Promise<number> {
    if (this.#readOnly) return 0;
    let next = 1;
    let checked = 0;
    for (;;) {
      if (signal?.aborted) return checked;
      const batch = await this.#withLogLock("maintainFrameIndex", async () => {
        if (!await this.#authenticatedMode()) return { done: true, count: 0 };
        const lastLsn = await this.#loadLastLsn();
        const index = this.#frameIndex;
        const until = Math.min(lastLsn, next + FRAME_INDEX_AUDIT_BATCH - 1);
        if (!index || next > until) return { done: true, count: 0 };
        const handle = await open(this.logPath, "r");
        try {
          await this.#forEachAuthenticatedFrame(index, handle, next, until, undefined, () => undefined);
        } catch (error) {
          // 日志字节与认证索引不符：记录损坏并放弃索引与已核验尾部。索引页自身不可用：只放弃索引，
          // 下一次操作完整核验并重建。
          if (error instanceof AuthorityStorageError || error instanceof FrameIndexUnavailableError) {
            if (error instanceof AuthorityStorageError) {
              this.#records?.record({ event: "corrupted", result: "failure", refs: [{ kind: "authority", id: this.#requireLogId() }],
                data: { error: error.message } });
            }
            this.#frameIndex = undefined;
            this.#verifiedTail = undefined;
            verifiedWalViews.delete(this.logPath);
            await AuthenticatedFrameIndex.discard(this.rootDir);
          }
          throw error;
        } finally {
          await handle.close();
        }
        const count = until - next + 1;
        next = until + 1;
        return { done: until >= lastLsn, count };
      });
      checked += batch.count;
      if (batch.done) return checked;
      await new Promise((resolve) => setTimeout(resolve, FRAME_INDEX_AUDIT_PAUSE_MS));
    }
  }

  async #loadLastLsn(): Promise<number> {
    const metadata = await readWalVersion(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!metadata) {
      this.#verifiedTail = undefined;
      this.#frameIndex = undefined;
      verifiedWalViews.delete(this.logPath);
      return 0;
    }
    if (await this.#authenticatedMode()) return this.#loadAuthenticatedTail(metadata);
    const verified = await this.#verifiedView(metadata);
    if (verified) {
      this.#verifiedTail = verified.tail;
      return verified.tail.lastLsn;
    }
    const tail = this.#verifiedTail;
    if (tail?.physicalHash && tail.logId === this.#requireLogId() && tail.device === metadata.dev &&
        tail.inode === metadata.ino && tail.bytes === metadata.size) {
      // Eviction must not force every append to parse history again. A bounded
      // digest still proves the prefix, after checking every current byte.
      const handle = await open(this.logPath, "r");
      try {
        if (this.#work) this.#work.scans++;
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = this.#logDataStartOffset();
        while (offset < metadata.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
          if (bytesRead === 0) break;
          if (this.#work) this.#work.readBytes += bytesRead;
          digest.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        if (offset === metadata.size && digest.digest("hex") === tail.physicalHash.copy().digest("hex")) {
          const current = await readWalVersion(handle);
          const proof = { ...tail, modifiedAt: metadata.mtimeNs, changedAt: metadata.ctimeNs };
          if (matchesWalVersion(proof, current)) {
            this.#verifiedTail = proof;
            return proof.lastLsn;
          }
        }
      } finally { await handle.close(); }
    }
    // Missing post-commit metadata grants no reuse: recover the whole changed
    // version instead of trusting only a frame footer over an unverified prefix.
    // This decision needs only the validated tail. Verify every physical frame
    // but do not materialize already validated historical records for a no-op.
    return this.#readAndRecover(undefined, 0, () => false);
  }

  async #readAndRecover(
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => void | Promise<void> = () => undefined,
    fromLsn = 0,
    select?: EnvelopeSelection,
  ): Promise<number> {
    const firstRecovery = this.#verifiedTail === undefined;
    const scanned = await this.#scanLog(visit, fromLsn, select);
    if (this.#work && !scanned.reused) this.#work.recoveries++;
    if (scanned.incompleteTail) {
      await this.#quarantineTail(scanned.incompleteTail, scanned.validBytes);
    }
    if (!scanned.reused) await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest, scanned.physicalHash);
    if ((firstRecovery && !this.#frameIndex) || scanned.incompleteTail) this.#records?.record({ event: "recovered", result: "success", refs: [{ kind: "authority", id: this.#requireLogId() }], data: { lsn: scanned.lastLsn, incompleteTail: !!scanned.incompleteTail } });
    return scanned.lastLsn;
  }

  async #readProjectionTail(
    cursor: ProjectionCursor | undefined,
    afterLsn: number,
    visit: (
      envelope: CommitEnvelope<JsonValue>,
      checkpoint: DurableLogCheckpoint,
    ) => void | Promise<void>,
    selectedStreams?: ReadonlySet<string>,
  ): Promise<{ readonly lastLsn: number; readonly cursor: ProjectionCursor }> {
    const select = projectionEnvelopeSelection(selectedStreams, cursor?.lsn);
    if (cursor !== undefined && !(cursor instanceof FileProjectionCursor)) {
      throw new TypeError(
        "Projection cursor was not issued by this commit log",
      );
    }
    const metadata = await readWalVersion(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!metadata) {
      this.#verifiedTail = undefined;
      this.#frameIndex = undefined;
      return { lastLsn: 0, cursor: this.#projectionCursor(0) };
    }
    if (await this.#authenticatedMode()) {
      return this.#readAuthenticatedProjectionTail(
        metadata, cursor as FileProjectionCursor | undefined, afterLsn, visit, select,
      );
    }

    const verified = await this.#verifiedView(metadata);
    if (
      verified && cursor &&
      canResumeProjectionCursor(
        cursor,
        this.logPath,
        this.#requireLogId(),
        metadata,
      )
    ) {
      // This cursor covers the entire unchanged file, not merely a prefix.
      // The lock and identity/size/mtime/ctime check above establish an empty
      // tail. Any append, replacement or corruption takes the full scan below.
      return { lastLsn: cursor.lsn, cursor };
    }

    if (!verified && cursor?.physicalDigest && cursor.logPath === this.logPath &&
        cursor.logId === this.#requireLogId() && cursor.device === metadata.dev &&
        cursor.inode === metadata.ino && cursor.byteOffset <= metadata.size) {
      // Re-read EVERY old byte under the writer lock. The in-memory digest was
      // formed from validated frames; no mtime assumption, cached bytes, or
      // unverified checkpoint can authorize skipping prefix validation.
      const physicalHash = createHash("sha256");
      const handle = await open(this.logPath, "r");
      try {
        if (this.#work) this.#work.scans++;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = this.#logDataStartOffset();
        while (offset < cursor.byteOffset) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, cursor.byteOffset - offset), offset);
          if (bytesRead === 0) throw new AuthorityStorageError("commit-log-corrupt", "Authority log prefix is incomplete");
          physicalHash.update(buffer.subarray(0, bytesRead));
          if (this.#work) this.#work.readBytes += bytesRead;
          offset += bytesRead;
        }
      } finally { await handle.close(); }
      if (physicalHash.copy().digest("hex") !== cursor.physicalDigest) {
        throw new AuthorityStorageError("commit-log-corrupt", "Authority log prefix bytes changed");
      }
      const scanned = await this.#scanLogFrom(
        cursor.byteOffset, cursor.lsn, cursor.prefixDigest, visit, afterLsn + 1, physicalHash, select,
      );
      if (scanned.incompleteTail) await this.#quarantineTail(scanned.incompleteTail, scanned.validBytes);
      await this.#recordVerifiedTail(scanned.lastLsn, scanned.prefixDigest, scanned.physicalHash);
      return { lastLsn: scanned.lastLsn, cursor: this.#projectionCursor(scanned.lastLsn) };
    }

    const logId = this.#requireLogId();
    let observedPrefixDigest = emptyLogPrefix(logId);
    let prefixMatches =
      cursor?.lsn === 0 &&
      cursor.logId === logId &&
      cursor.prefixDigest === observedPrefixDigest;
    const lastLsn = await this.#readAndRecover(async (envelope, checkpoint) => {
      // The physical scanner already verified this exact prefix chain.
      observedPrefixDigest = checkpoint.prefixDigest;
      if (cursor && envelope.lsn === cursor.lsn) {
        prefixMatches =
          cursor.logId === logId &&
          observedPrefixDigest === cursor.prefixDigest;
      }
      if (envelope.lsn > afterLsn) await visit(envelope, checkpoint);
    }, Math.min(afterLsn + 1, cursor?.lsn ?? afterLsn + 1), select);
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
    fromLsn = 0,
    select?: EnvelopeSelection,
  ): Promise<ScannedLog> {
    return this.#scanLogFrom(
      this.#logDataStartOffset(),
      0,
      emptyLogPrefix(this.#requireLogId()),
      visit,
      fromLsn,
      undefined,
      select,
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
    fromLsn = 0,
    physicalHash = startOffset === this.#logDataStartOffset() ? createHash("sha256") : undefined,
    select?: EnvelopeSelection,
    budget?: { readonly frames: number; readonly bytes: number },
  ): Promise<ScannedLog> {
    if (await this.#authenticatedMode()) {
      return this.#scanAuthenticated(startOffset, previousLsn, previousPrefixDigest, visit, fromLsn, select, budget);
    }
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
      const metadata = await readWalVersion(handle);
      if (startOffset > metadata.size) {
        throw new AuthorityStorageError(
          "commit-log-corrupt",
          "Projection cursor is beyond the end of the commit log",
        );
      }
      const logId = this.#requireLogId();
      const verified = await this.#verifiedView(metadata, handle);
      if (verified) return await this.#visitVerifiedView(verified, startOffset, previousLsn,
        previousPrefixDigest, visit, fromLsn, select, budget);
      let capture: VerifiedWalFrame[] | undefined = previousLsn === 0 &&
        startOffset === this.#logDataStartOffset() && metadata.size <= this.#viewLimits.bytes ? [] : undefined;
      let captureBytes = 256 + metadata.size;
      // 视图按帧分块保留：每帧一块（扫描器为每帧新分配的那份字节），不再拼接整份副本。
      const chunks: Buffer[] = [];
      if (capture && startOffset > 0) {
        const header = Buffer.alloc(startOffset);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (this.#work) this.#work.readBytes += bytesRead;
        if (bytesRead !== header.length) throw new AuthorityStorageError("commit-log-corrupt", "Authority WAL header is incomplete");
        chunks.push(header);
      }
      let currentFrame: Buffer | undefined;
      const scanned = await scanAuthorityWalFrames(
        this.#walReader(handle, metadata.size - startOffset, startOffset),
        async (payload, offset, frameMetadata, nextOffset) => {
          // A changed file always goes through physical validation. Capture only
          // immutable payloads from a complete, stable scan for later readers.
          const digest = createHash("sha256").update(payload).digest("hex");
          const previousProof = validatedEnvelopes.get(digest);
          const envelope = !previousProof || (previousProof.lsn >= fromLsn && select?.(previousProof) !== false)
            ? previousProof
              ? JSON.parse(payload.toString("utf8")) as CommitEnvelope<JsonValue>
              : parseEnvelope(payload)
            : undefined;
          const identity = previousProof ?? envelope!;
          const singleStream = previousProof ? previousProof.singleStream
            : envelope!.entries.every(entry => entry.stream === envelope!.entries[0]!.stream)
              ? envelope!.entries[0]!.stream : undefined;
          if (identity.lsn !== expectedLsn) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Commit log LSN ${identity.lsn} does not follow ${expectedLsn - 1}`,
            );
          }
          expectedLsn += 1;
          const previousPrefix = prefixDigest;
          prefixDigest = previousProof?.logId === logId && previousProof.previousPrefix === previousPrefix
            ? previousProof.prefixDigest
            : advanceProjectionPrefix(logId, previousPrefix, identity);
          const frameProofIsValid =
            this.#requireLogFormat() === "versioned"
              ? frameMetadata?.lsn === identity.lsn &&
                frameMetadata.prefixDigest === prefixDigest
              : frameMetadata === undefined;
          if (!frameProofIsValid) {
            throw new AuthorityStorageError(
              "commit-log-corrupt",
              `Authority WAL frame proof is invalid at byte ${startOffset + offset}`,
            );
          }
          validatedEnvelopes.delete(digest);
          if (validatedEnvelopes.size >= VALIDATED_ENVELOPE_LIMIT) {
            validatedEnvelopes.delete(validatedEnvelopes.keys().next().value!);
          }
          validatedEnvelopes.set(digest, {
            lsn: identity.lsn, envelopeDigest: identity.envelopeDigest,
            logId, previousPrefix, prefixDigest,
            ...(singleStream === undefined ? {} : { singleStream }),
          });
          if (capture) {
            captureBytes += VERIFIED_WAL_FRAME_RETAINED_BYTES;
            if (captureBytes > this.#viewLimits.bytes || capture.length >= this.#viewLimits.frames || !currentFrame) {
              capture = undefined;
              chunks.length = 0;
            } else {
              chunks.push(currentFrame);
              capture.push({ lsn: identity.lsn, frameEndOffset: startOffset + nextOffset, prefixDigest,
                chunk: chunks.length - 1, payloadStart: AUTHORITY_WAL_HEADER_BYTES, payloadBytes: payload.byteLength,
                ...(singleStream === undefined ? {} : { singleStream }) });
            }
          }
          // Selection skips only object materialization/visitation. Every byte,
          // LSN and physical frame proof above is still verified in order.
          if (identity.lsn < fromLsn || select?.({ lsn: identity.lsn, singleStream }) === false) return;
          return visit(envelope!, {
            logId,
            lsn: identity.lsn,
            frameEndOffset: startOffset + nextOffset,
            prefixDigest,
          });
        },
        frame => { physicalHash?.update(frame); currentFrame = capture ? frame : undefined; },
        budget,
      );
      if (capture && !scanned.incompleteTail && !scanned.stopped) {
        const tail: VerifiedLogTail = { logId, device: metadata.dev, inode: metadata.ino,
          bytes: metadata.size, modifiedAt: metadata.mtimeNs, changedAt: metadata.ctimeNs,
          lastLsn: expectedLsn - 1, prefixDigest, ...(physicalHash ? { physicalHash: physicalHash.copy() } : {}) };
        // Never label bytes observed before a concurrent rewrite with its newer
        // timestamp. Cooperative writers are excluded by the WAL lock.
        if (matchesWalVersion(tail, await readWalVersion(handle))) {
          const view: VerifiedWalView = { tail, chunks, chunkCount: chunks.length, frames: capture, frameCount: capture.length };
          viewComparedAt.set(view, performance.now());
          verifiedWalViews.put(this.logPath, view, this.#viewLimits);
          if (this.#work) this.#operationView = view;
        }
      }
      return {
        lastLsn: expectedLsn - 1,
        validBytes: startOffset + scanned.validBytes,
        prefixDigest,
        ...(physicalHash ? { physicalHash } : {}),
        ...(scanned.stopped ? { stopped: true as const } : {}),
        ...(scanned.incompleteTail
          ? { incompleteTail: scanned.incompleteTail }
          : {}),
      };
    } finally {
      await handle.close();
    }
  }

  /** Metadata is not a proof on every filesystem (notably rapid Windows writes).
   * One bulk byte comparison reuses parsing/digest proofs without hiding changes. */
  async #verifiedView(metadata: WalFileVersion, supplied?: FileHandle): Promise<VerifiedWalView | undefined> {
    const view = verifiedWalViews.get(this.logPath, this.#requireLogId(), metadata);
    if (!view) return undefined;
    if (this.#work && this.#operationView === view) return view;
    // 身份与时间戳全部未变且刚比对过：在间隔内复用，不再整份重读。
    if (this.#walReverifyIntervalMs > 0 &&
        performance.now() - (viewComparedAt.get(view) ?? Number.NEGATIVE_INFINITY) < this.#walReverifyIntervalMs) {
      if (this.#work) this.#operationView = view;
      return view;
    }
    const handle = supplied ?? await open(this.logPath, "r");
    try {
      if (this.#work) this.#work.scans++;
      const current = this.#comparisonBuffer(view.tail.bytes);
      let offset = 0;
      while (offset < current.length) {
        const { bytesRead } = await handle.read(current, offset, current.length - offset, offset);
        if (this.#work) this.#work.readBytes += bytesRead;
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      let equal = offset === current.length;
      let position = 0;
      for (let index = 0; equal && index < view.chunkCount; index += 1) {
        const chunk = view.chunks[index]!;
        equal = current.subarray(position, position + chunk.byteLength).equals(chunk);
        position += chunk.byteLength;
      }
      if (equal && position === current.length && matchesWalVersion(view.tail, await readWalVersion(handle))) {
        viewComparedAt.set(view, performance.now());
        if (this.#work) this.#operationView = view;
        return view;
      }
      verifiedWalViews.delete(this.logPath);
      this.#operationView = undefined;
      this.#verifiedTail = undefined;
      return undefined;
    } finally { if (!supplied) await handle.close(); }
  }

  /** 逐次比对整份日志字节时复用同一块缓冲：只在连续持锁的会话内保留，会话结束即释放，
   * 不再为每次操作分配一份与日志等长的临时内存。 */
  #comparisonBuffer(bytes: number): Buffer {
    const session = this.#lockSession;
    if (!session) return Buffer.allocUnsafe(bytes);
    if (!session.comparison || session.comparison.byteLength < bytes) {
      session.comparison = Buffer.allocUnsafe(bytes);
    }
    return session.comparison.subarray(0, bytes);
  }

  async #visitVerifiedView(
    view: VerifiedWalView, startOffset: number, previousLsn: number, previousPrefixDigest: string,
    visit: (envelope: CommitEnvelope<JsonValue>, checkpoint: DurableLogCheckpoint) => boolean | void | Promise<boolean | void>,
    fromLsn: number, select?: EnvelopeSelection,
    budget?: { readonly frames: number; readonly bytes: number },
  ): Promise<ScannedLog> {
    const boundary = previousLsn <= view.frameCount ? view.frames[previousLsn - 1] : undefined;
    if (previousLsn === 0 ? startOffset !== this.#logDataStartOffset() || previousPrefixDigest !== emptyLogPrefix(view.tail.logId)
      : !boundary || boundary.frameEndOffset !== startOffset || boundary.prefixDigest !== previousPrefixDigest) {
      throw new AuthorityStorageError("commit-log-corrupt", "Projection boundary does not match the verified WAL");
    }
    this.#verifiedTail = view.tail;
    let yieldAt = performance.now() + AUTHORITY_WAL_SCAN_SLICE_MS;
    for (let index = Math.max(previousLsn, fromLsn - 1); index < view.frameCount; index++) {
      const frame = view.frames[index]!;
      if (budget && index > previousLsn && (index - previousLsn >= budget.frames || frame.frameEndOffset - startOffset > budget.bytes)) {
        const end = view.frames[index - 1]!;
        return { lastLsn: end.lsn, validBytes: end.frameEndOffset, prefixDigest: end.prefixDigest, stopped: true, reused: true };
      }
      const hasRemaining = frame.frameEndOffset < view.tail.bytes;
      if (select?.(frame) !== false) {
        // Each consumer owns its objects; reducer/caller mutations cannot poison
        // another reader or the next durable append.
        const shouldContinue = await visit(JSON.parse(verifiedViewPayload(view, frame).toString("utf8")) as CommitEnvelope<JsonValue>, {
          logId: view.tail.logId, lsn: frame.lsn, frameEndOffset: frame.frameEndOffset, prefixDigest: frame.prefixDigest,
        });
        // Match the physical scanner: a limit reached at EOF is completion,
        // not an early stop that promises another page.
        if (shouldContinue === false && hasRemaining) return { lastLsn: frame.lsn, validBytes: frame.frameEndOffset,
          prefixDigest: frame.prefixDigest, stopped: true, reused: true };
      }
      if (hasRemaining && performance.now() >= yieldAt) {
        await yieldToIo();
        yieldAt = performance.now() + AUTHORITY_WAL_SCAN_SLICE_MS;
      }
    }
    return { lastLsn: view.tail.lastLsn, validBytes: view.tail.bytes, prefixDigest: view.tail.prefixDigest,
      ...(view.tail.physicalHash ? { physicalHash: view.tail.physicalHash.copy() } : {}), reused: true };
  }

  async #quarantineTail(bytes: Buffer, validBytes: number): Promise<void> {
    if (bytes.byteLength === 0) return;
    if (this.#readOnly) throw new AuthorityStorageError("commit-log-corrupt", "Read-only authority log has an incomplete tail requiring its owner to recover");
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

    verifiedWalViews.delete(this.logPath);
    this.#operationView = undefined;
    const log = await open(this.logPath, "r+");
    try {
      await log.truncate(validBytes);
      await log.sync();
    } finally {
      await log.close();
    }
  }

  #walReader(handle: FileHandle, size: number, offset = 0) {
    if (this.#work) this.#work.scans++;
    return fileReader(handle, size, offset, bytes => { if (this.#work) this.#work.readBytes += bytes; });
  }

  async #recordVerifiedTail(
    lastLsn: number,
    prefixDigest: string,
    physicalHash?: Hash,
  ): Promise<void> {
    const metadata = await readWalVersion(this.logPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    const previous = this.#verifiedTail;
    // A suffix-only synchronization must not discard an existing prefix proof.
    // Reusing the proof still requires checking current bytes at the next read.
    const provenHash = physicalHash ?? (previous && metadata && previous.logId === this.#requireLogId() &&
      previous.device === metadata.dev && previous.inode === metadata.ino && previous.bytes === metadata.size &&
      previous.lastLsn === lastLsn && previous.prefixDigest === prefixDigest ? previous.physicalHash : undefined);
    this.#verifiedTail = metadata
      ? {
          logId: this.#requireLogId(),
          device: metadata.dev,
          inode: metadata.ino,
          bytes: metadata.size,
          modifiedAt: metadata.mtimeNs,
          changedAt: metadata.ctimeNs,
          lastLsn,
          prefixDigest,
          ...(provenHash ? { physicalHash: provenHash } : {}),
        }
      : undefined;
  }

  #projectionCursor(lastLsn: number): FileProjectionCursor {
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
        tail.physicalHash?.copy().digest("hex"),
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
  ): Promise<FrameIndexRow | undefined> {
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
    // 认证模式：边界直接与认证索引对应行核对，不读日志文件。
    if (await this.#authenticatedMode()) {
      const row = await this.#authenticatedRow(checkpoint.lsn);
      if (row) {
        if (row.frameEndOffset !== checkpoint.frameEndOffset || row.prefixDigest !== checkpoint.prefixDigest) {
          throw new AuthorityStorageError(
            "commit-log-corrupt",
            "Durable log checkpoint does not match its WAL boundary",
          );
        }
        return row;
      }
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
      const metadata = await readWalVersion(handle);
      const boundary = await verifyAuthorityWalFrameBoundary(
        this.#walReader(handle, metadata.size),
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
    const metadata = await readWalVersion(this.logPath).catch((error: unknown) => {
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
    if (this.#readOnly) throw new AuthorityStorageError("commit-log-corrupt", "Read-only authority log does not exist");
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
    await this.#recordVerifiedTail(0, emptyLogPrefix(this.#logId), createHash("sha256"));
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
    // A legacy file without a durable identity may still be strictly read. Its
    // process-local cursor cannot authorize a cache or a later writer.
    if (this.#readOnly) return this.#readOnlyLegacyId ??= randomBytes(LOG_ID_BYTES).toString("base64url");
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

  async #withLogLock<T>(kind: Parameters<AuthorityWorkObserver["begin"]>[0], operation: (observation: ReturnType<AuthorityWorkObserver['begin']>) => Promise<T>, tryOnly = false, waitAbort?: AbortSignal): Promise<T> {
    const observation = this.#workObserver.begin(kind);
    let failure: [] | [unknown] = [];
    try { return await this.#withObservedLogLock(() => operation(observation), observation,
      kind === "projection.prepare" || kind === "projection.retire" || tryOnly, tryOnly, waitAbort); }
    catch (error) { failure = [error]; throw error; }
    finally { observation.finish(...failure); }
  }

  async #withObservedLogLock<T>(operation: () => Promise<T>, observation: ReturnType<AuthorityWorkObserver["begin"]>, releaseAtBoundary = false, tryOnly = false, waitAbort?: AbortSignal): Promise<T> {
    if (tryOnly && this.#lockedOperations > 0) throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 25 });
    // Initial projection preparation can make useful progress for much longer
    // than five seconds. Its work must not consume the subsequent backpressure
    // wait budget. Start that one bounded window at the first retryable failure;
    // later failures never renew it.
    let maintenanceDeadline: number | undefined;
    const hydratedIdentities = new Set<string>();
    for (;;) {
      try {
        const queued = performance.now();
        observation.stage("local-queue");
        this.#lockedOperations++;
        try {
          return await this.#operations.run(async () => {
            observation.data.queueMs += performance.now() - queued;
            const session = await this.#enterLockSession(observation, tryOnly);
            const executing = performance.now();
            observation.stage("authority-execution");
            this.#work = observation.data;
            let failed = false;
            try {
              // 持有日志锁期间恒有权威操作在等待,故为前台。互斥区不在这里声明:
              // 外层 `#operations` 串行队列已单点标记,内层维护准入随之零等待——
              // 排队会把锁的持有时间拉到准入超时,阻塞全部其他持锁者。背压由本方法
              // 的锁外重试兜住。
              const scope = { active: true };
              try {
                const result = await this.#sourceScope.run(scope, () => runInMaintenanceContext("foreground", async () => {
                  await this.#ensureInitialized();
                  return await operation();
                }));
                return result;
              } finally { scope.active = false; }
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              // 每次操作都重新按字节核验：同一持锁会话也不跨操作沿用视图，
              // 非协作写者在两次操作之间的改动仍由下一次操作发现。
              this.#operationView = undefined;
              this.#work = undefined;
              observation.data.executionMs += performance.now() - executing;
              const releasing = performance.now();
              const previousStage = observation.stage("authority-lock-release");
              try { await this.#leaveLockSession(session, failed || releaseAtBoundary); } finally { observation.data.releaseMs += performance.now() - releasing; }
              observation.stage(previousStage);
            }
          }, waitAbort);
        } finally {
          this.#lockedOperations--;
        }
      } catch (error) {
        if (waitAbort?.aborted && error === waitAbort.reason) throw new StorageMaintenanceCancelledError();
        if (tryOnly) {
          if (error instanceof FileLockBusyError) throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 25 });
          if (error instanceof AuthorityPreparationRequired) error.prepareOutside ??= () => this.#queuePreparation(error);
          throw error;
        }
        if (error instanceof ProtocolIdentityNotLoaded) {
          // 本次操作尚未提交且已释放日志锁：精确补齐这一个身份后整体重跑；同一身份只补一次。
          if (hydratedIdentities.has(error.keyId)) throw untrustedProtocolSignature();
          hydratedIdentities.add(error.keyId);
          if (!await error.cache.hydrate(error)) throw untrustedProtocolSignature();
          continue;
        }
        if (error instanceof AuthorityPreparationRequired) {
          error.prepareOutside ??= () => this.#queuePreparation(error);
          // A domain queue must release its turn before waiting for a candidate.
          // The existing maintenance owner continues finite pages independently;
          // the caller receives ordinary backpressure and can retry outside it.
          if (isHoldingMaintenanceExclusion()) {
            void error.prepareOutside().catch(() => undefined); // Each source step already records its failure.
            throw error;
          }
          await error.prepareOutside();
          continue;
        }
        // 可重试判据由 resources 层单点给出,这里不再内联。
        const retryAfterMs = maintenanceRetryDelayMs(error);
        // 内层日志锁已释放不代表调用栈已离开全部互斥区。若外层设施仍持有
        // 串行权，等待后重试会把容量背压扩散成整条设施队列阻塞；交给最外层
        // 所有者在退出其互斥区后重驱。
        if (retryAfterMs !== undefined) maintenanceDeadline ??= Date.now() + 5_000;
        if (
          retryAfterMs === undefined ||
          isHoldingMaintenanceExclusion() ||
          Date.now() >= maintenanceDeadline!
        ) {
          throw error;
        }
        observation.stage("maintenance-retry");
        const retrying = performance.now();
        await waitForMaintenanceRetry(
          Math.min(retryAfterMs, Math.max(0, maintenanceDeadline! - Date.now())),
        );
        observation.data.retryWaitMs += performance.now() - retrying;
        observation.data.retries++;
      }
    }
  }

  /** 沿用本实例仍持有的写者锁，否则取得新锁并开始新会话。 */
  async #enterLockSession(observation: ReturnType<AuthorityWorkObserver["begin"]>, tryOnly = false): Promise<CommitLogLockSession> {
    const held = this.#lockSession;
    if (held) {
      clearTimeout(held.idle);
      held.idle = undefined;
      if (idleLockSessions.get(this.#lockPath) === held.close) idleLockSessions.delete(this.#lockPath);
      return held;
    }
    await this.#lockSessionClosing?.catch(() => undefined);
    // 同进程另一实例在空闲保留期持有同一把锁：立即收回，按原有语义由文件锁仲裁。
    await idleLockSessions.get(this.#lockPath)?.().catch(() => undefined);
    observation.stage("directory-preparation");
    const preparing = performance.now();
    try {
      if (this.#readOnly) await stat(this.logPath);
      else await ensureDurableDirectory(this.rootDir);
    }
    finally { observation.data.preparationMs += performance.now() - preparing; }
    const waiting = performance.now();
    observation.stage("authority-file-lock");
    let release: () => Promise<void>;
    try { release = await this.#acquireFileLock(this.#lockPath, {
        staleMs: this.#lockStaleMs,
        waitMs: tryOnly ? 0 : this.#lockWaitMs,
        resourceName: "AuthorityCommitLog",
      });
    } finally { observation.data.lockWaitMs += performance.now() - waiting; }
    const session: CommitLogLockSession = {
      release,
      acquiredAt: performance.now(),
      close: () => this.#closeLockSession(session),
      idle: undefined,
    };
    // 不持锁期间其他实例可能已持锁发布投影清单：新会话里再次打开投影时须重新采纳。
    this.#refreshedProjections.clear();
    this.#lockSession = session;
    return session;
  }

  /** 失败或持有到上限即在本操作边界释放；后续已排队的操作直接沿用；否则短暂保留以接住紧随其后的操作。 */
  async #leaveLockSession(session: CommitLogLockSession, failed: boolean): Promise<void> {
    if (failed || this.#readOnly || this.#lockSessionLingerMs === 0 || performance.now() - session.acquiredAt >= this.#lockSessionMaxHoldMs) {
      await session.close();
      return;
    }
    if (this.#lockedOperations > 1) return;
    session.idle = setTimeout(() => {
      // 计时到期时若已有操作排进队列，由它沿用并在结束时重新计时。
      if (this.#lockedOperations === 0) void session.close().catch(() => undefined);
    }, this.#lockSessionLingerMs);
    session.idle.unref?.();
    idleLockSessions.set(this.#lockPath, session.close);
  }

  #closeLockSession(session: CommitLogLockSession): Promise<void> {
    if (this.#lockSession !== session) return this.#lockSessionClosing ?? Promise.resolve();
    clearTimeout(session.idle);
    session.idle = undefined;
    if (idleLockSessions.get(this.#lockPath) === session.close) idleLockSessions.delete(this.#lockPath);
    this.#lockSession = undefined;
    const closing: Promise<void> = session.release().finally(() => {
      if (this.#lockSessionClosing === closing) this.#lockSessionClosing = undefined;
    });
    this.#lockSessionClosing = closing;
    return closing;
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
      { validation: 'artifact-byte-conflict' },
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

/** 覆盖位置未知、不属于本日志或不在本日志已验前缀上，一律当作需要先追平。 */
function tailConsumerNeedsFlush(covered: DurableLogCheckpoint | undefined, head: DurableLogCheckpoint,
  bytes: number, hard: boolean): boolean {
  if (!covered || covered.logId !== head.logId || covered.lsn > head.lsn || covered.frameEndOffset > head.frameEndOffset) return true;
  return authorityTailNeedsFlush(covered, head, bytes, hard);
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

export function decodeCommitEnvelope(bytes: Uint8Array): CommitEnvelope<JsonValue> {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
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
  const entries: string[] = [];
  for (const entry of value.entries) {
    if (!isPlainRecord(entry))
      throw invalidEnvelope("Logical record must be an object");
    assertExactKeys(entry, ["body", "stream"]);
    if (typeof entry.stream !== "string") {
      throw invalidEnvelope("Logical record stream must be a string");
    }
    assertStream(entry.stream);
    const body = assertInlineBody(entry.body);
    entries.push(`{"body":${body},"stream":${canonicalize(entry.stream)}}`);
  }
  // Serialize each validated body once. These fixed field orders are the
  // canonical CommitEnvelope v1 schema, also checked against protocolDigest.
  const prefix = `{"at":${JSON.stringify(value.at)},"entries":[${entries.join(",")}]`;
  const suffix = `,"lsn":${value.lsn},"v":1}`;
  const expectedDigest = protocolDigestOfCanonicalParts("CommitEnvelope", 1, [prefix, suffix]);
  if (expectedDigest !== value.envelopeDigest) {
    throw invalidEnvelope("Commit envelope digest is invalid");
  }
  if (`${prefix},"envelopeDigest":${JSON.stringify(value.envelopeDigest)}${suffix}` !== text) {
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

function assertInlineBody(body: unknown): string {
  const serialized = canonicalize(body);
  const inlineBytes = Buffer.byteLength(serialized, "utf8");
  if (inlineBytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
    throw new TypeError(
      `Logical record body exceeds the ${MAX_INLINE_LOGICAL_RECORD_BYTES}-byte inline limit`,
    );
  }
  return serialized;
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

const parseEnvelope = decodeCommitEnvelope;

function deduplicateReferences(
  references: readonly ArtifactRef[],
): ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const reference of references) {
    const existing = unique.get(reference.digest);
    if (existing && existing.bytes !== reference.bytes) {
      throw new TypeError(
        `Artifact digest has conflicting byte counts: ${reference.digest}`,
      );
    }
    unique.set(reference.digest, reference);
  }
  return [...unique.values()];
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

/** No records were appended; callers may recollect dependencies outside the lock. */
export class TransactionArtifactReferenceError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "TransactionArtifactReferenceError";
  }
}

function assertTransactionReferencesProtected(
  references: readonly ArtifactRef[],
  candidateDigests: ReadonlyMap<string, number>,
): void {
  for (const reference of references) {
    const protectedBytes = candidateDigests.get(reference.digest);
    if (protectedBytes === undefined) {
      throw new TransactionArtifactReferenceError(
        `Transaction introduced an undeclared artifact reference: ${reference.digest}`,
      );
    }
    if (protectedBytes !== reference.bytes) {
      throw new TransactionArtifactReferenceError(
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
  envelope: Pick<CommitEnvelope<unknown>, "lsn" | "envelopeDigest">,
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

function canResumeProjectionCursor(
  cursor: FileProjectionCursor,
  logPath: string,
  logId: string,
  metadata: WalFileVersion,
): boolean {
  return (
    cursor.logId === logId &&
    cursor.logPath === logPath &&
    cursor.device === metadata.dev &&
    cursor.inode === metadata.ino &&
    cursor.byteOffset >= 0 &&
    cursor.byteOffset === metadata.size &&
    cursor.modifiedAt === metadata.mtimeNs &&
    cursor.changedAt === metadata.ctimeNs
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Only a projection already at the verified prior head may skip this input. */
function sameDurableCheckpoint(left: DurableLogCheckpoint | undefined, right: DurableLogCheckpoint): boolean {
  return left?.logId === right.logId && left.lsn === right.lsn && left.frameEndOffset === right.frameEndOffset && left.prefixDigest === right.prefixDigest;
}

/** 资源背压、取消、容量步骤与验签身份补齐都不是投影本身的故障，原样交给锁外处理。 */
function isTransientProjectionError(error: unknown): boolean {
  return error instanceof StorageMaintenanceAdmissionError || error instanceof StorageMaintenanceCancelledError ||
    error instanceof DeviceCapacityAdmissionError || error instanceof DeviceCapacityStepError ||
    error instanceof ProtocolIdentityNotLoaded;
}

/** 已打开的健康投影在内存中推进了尚未发布的进度（数据或无关输入的覆盖位置）。 */
function hasUnpublishedProgress(projection: RegisteredDurableProjection): boolean {
  if (!projection.opened || projection.failure !== undefined || !projection.state.isPersistent()) return false;
  const state = projection.state;
  const current = state.checkpoints().authority;
  if (!current || !sameDurableCheckpoint(state.publishedCheckpoints().authority, current)) return true;
  // 位置未变但有未落盘的行（例如按分区迁移写入的结果）也随停止检查点保存。
  if (state.hasUnflushedRows()) return true;
  return state.readiness() === "building" &&
    !sameDurableCheckpoint(state.publishedRecoveryCoverage().authority, state.unrelatedThrough().authority!);
}

const RETIRED_DIRECTORY_PAGE_ENTRIES = 64;

/**
 * 删除一页被替代的派生目录内容：清单最先删除，使副本立即不可被采用；之后每页最多删除固定条数，
 * 每页同步目录，目录清空后移除目录本身。返回 absent（本来就不存在）、page（还有剩余）或 removed。
 */
async function reclaimDirectoryPage(directory: string): Promise<"absent" | "page" | "removed"> {
  const pending: string[] = [];
  const directories: string[] = [];
  const manifests: string[] = [];
  let remaining = RETIRED_DIRECTORY_PAGE_ENTRIES;
  let complete = true;
  const visit = async (current: string): Promise<boolean> => {
    let handle: import("node:fs").Dir;
    try { handle = await opendir(current); }
    catch (error) { if (isNodeError(error, "ENOENT")) return current !== directory; throw error; }
    directories.push(current);
    try {
      for (;;) {
        if (remaining === 0) { complete = false; break; }
        const entry = await handle.read();
        if (!entry) break;
        remaining--;
        const child = path.join(current, entry.name);
        if (entry.name === "manifest.json" && entry.isFile()) manifests.push(child);
        else if (entry.isDirectory()) await visit(child);
        else pending.push(child);
      }
    } finally { await handle.close(); }
    return true;
  };
  if (!await visit(directory)) return "absent";
  // Keep the version binding until every other entry is gone. Each page reads
  // at most its entry budget; no full directory enumeration precedes deletion.
  if (pending.length) await durablyRemoveFiles(pending);
  else if (complete && manifests.length) await durablyRemoveFiles(manifests);
  for (const empty of directories.reverse()) {
    const result = await durablyRemoveDirectory(empty);
    if (empty === directory && result !== "not-empty") return "removed";
  }
  return "page";
}

/** One 64-frame source-fenced recovery page only. Repeated negative lookups and
 * unchanged authenticated fields need not search the same immutable segments
 * for every envelope. Published mutations invalidate their keys immediately;
 * failed/restarted pages discard the entire view. No candidate guard is skipped
 * and no cached value crosses a source-fence release or becomes a disk fact. */
function recoveryPageRead(source: RegisteredDurableProjection['read'], resident: () => boolean) {
  // 与源视图返回的共享只读值相同；保留时量一次大小，命中不再重新编解码。
  // 全部重建状态都在内存里时读取不碰段，无需去重；内存副本一旦放弃，本页随即开始去重。
  const rows = new Map<string,{value: JsonValue | undefined; bytes: number}>();
  let bytes = 0;
  const getMany = async (keys: readonly string[]): Promise<readonly (JsonValue | undefined)[]> => {
    if (resident()) return source.getMany(keys);
    const missing = [...new Set(keys.filter(key => !rows.has(key)))];
    const fetched = missing.length ? await source.getMany(missing) : [];
    const fresh = new Map(missing.map((key,i) => [key,fetched[i]]));
    for (const [key,value] of fresh) {
      if (rows.size >= 256) break;
      const size = Buffer.byteLength(key) + (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)));
      if (bytes + size <= 256 * 1024) { rows.set(key,{value,bytes:size}); bytes += size; }
    }
    return keys.map(key => {
      const row=rows.get(key);
      return row ? row.value : fresh.get(key);
    });
  };
  const view: DurableProjectionReadContext = {get:async key=>(await getMany([key]))[0],getMany,
    scan:(range,limit,continuation)=>source.scan(range,limit,continuation)};
  return {view,invalidate(mutations: readonly DurableProjectionMutation[]) {
    for(const mutation of mutations){const row=rows.get(mutation.key);if(row){bytes-=row.bytes;rows.delete(mutation.key);}}
  }};
}