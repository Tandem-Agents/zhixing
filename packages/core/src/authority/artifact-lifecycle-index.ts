import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type {
  ArtifactRef,
  CommitEnvelope,
  ControlRecord,
  Digest,
  JsonValue,
  LogicalRecord,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "../contracts/index.js";
import { createFileLockAcquirer, FileLockBusyError } from "../persistence/index.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import {
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  runDetachedMaintenanceContext,
  runStorageMaintenanceStep,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  waitForMaintenanceRetry,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";
import {
  classifyRegisteredArtifactReferences,
  classifyRetainedRecordReferences,
  collectRegisteredArtifactRoots,
  deletedConversationOf,
} from "./artifact-retention.js";
import {
  bindDurableProjectionMutations,
  createBoundDurableProjectionReadContext,
  DurableProjectionStorageError,
  FileDurableProjectionIndex,
  type DurableProjectionCheckpoints,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
} from "./durable-projection-index.js";
import { AuthorityStorageError } from "./errors.js";
import type {
  ArtifactReferenceCursor,
  ArtifactStore,
  ArtifactRetentionSnapshot,
  AuthorityTailConsumer,
  DurableLogCheckpoint,
  MutableArtifactStore,
  PhysicalStorageStepRunner,
} from "./interfaces.js";
import type { FileAuthorityCommitLog } from "./commit-log.js";
import type {
  SurfaceAssetTemporaryPresenceCursor,
  SurfaceAssetTemporaryPresencePort,
  SurfaceAssetTemporaryRecoveryPort,
} from "./surface-asset-staging.js";

const SOURCE_PAGE_SIZE = 64;
const RETIREMENT_PAGE_SIZE = 64;
const PENDING_JOB_PAGE_SIZE = 16;
const MAX_RELEASE_PAGE_SIZE = 64;
const MAX_SYNCHRONIZATION_TURNS = 4;
const LIFECYCLE_ADMISSION_DEADLINE_MS = 5_000;
const WRITER_LOCK_STALE_MS = 30_000;
const WRITER_LOCK_WAIT_MS = 10_000;
const EMPTY_FACT_ROOTS = createEmptyFactRoots();

const STATE_PREFIX = "state/";
const OWNER_PREFIX = "owner/";
const DEAD_PREFIX = "dead/";
const PENDING_PREFIX = "pending/";
const RELEASE_PREFIX = "release/";
const FACT_PREFIX = "fact/";
const MERKLE_PREFIX = "merkle/";
const META_TIME_KEY = "meta/effective-time";
const META_TEMPORARY_RECONCILED_KEY = "meta/temporary-reconciled";
const GRANT_HISTORY_PREFIX = "grant/history/";
const ACTIVE_GRANT_PREFIX = "grant/active/";
const EXPIRY_GRANT_PREFIX = "grant/expiry/";
const CONVERSATION_GRANT_PREFIX = "grant/conversation/";
const SURFACE_GRANT_PREFIX = "grant/surface/";
const UPLOAD_GRANT_PREFIX = "grant/upload/";
const UPLOAD_SUMMARY_PREFIX = "grant/upload-summary/";
const UPLOAD_SCOPE_PREFIX = "grant/upload-scope/";
const RESERVATION_MEMBER_PREFIX = "reservation/member/";
const RESERVATION_SCOPE_PREFIX = "reservation/scope/";
const RESERVATION_DEVICE_PREFIX = "reservation/device/";
const QUOTA_SCOPE_PREFIX = "quota/scope/";
const QUOTA_DEVICE_KEY = "quota/device";
const ADOPTION_JOB_PREFIX = "adoption-pending/";
const TEMPORARY_STATE_PREFIX = "temporary/state/";
const TEMPORARY_INTENT_PREFIX = "temporary/intent/";
const TEMPORARY_MIGRATION_PREFIX = "temporary/migration/";
const TEMPORARY_SCOPE_PREFIX = "temporary/scope/";
const TEMPORARY_DUE_PREFIX = "temporary/due/";
const TEMPORARY_CLEANUP_PREFIX = "temporary/cleanup/";

export interface ArtifactReleaseCandidate {
  readonly ref: ArtifactRef;
  readonly releasedAt: string;
  readonly releaseId: Digest;
}

export interface ArtifactLifecycleIndexOptions {
  readonly rootDir: string;
  readonly logs: readonly FileAuthorityCommitLog[];
  readonly artifacts: ArtifactStore;
  readonly temporaryArtifacts: MutableArtifactStore;
  readonly temporaryPresence: SurfaceAssetTemporaryPresencePort;
  readonly receiver: SurfaceAssetTemporaryRecoveryPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  /** 规范维护身份中的物理 ArtifactStore 标识；生产装配必须传真实存储根。 */
  readonly maintenanceResourceId?: string;
  /**
   * 源日志的维护生命周期是否归本索引（缺省为是）。统一 home 入口共享的日志由其组合 owner
   * 按引用计数停止，任何单个使用者关闭自己的索引都不能停掉别人仍在使用的日志。
   */
  readonly ownsSourceLogs?: boolean;
}

export interface ArtifactQuotaSnapshot {
  readonly scopeBytes: number;
  readonly deviceBytes: number;
  readonly memberships: readonly {
    readonly digest: Digest;
    readonly scopeCounted: boolean;
    readonly deviceCounted: boolean;
    readonly retained: boolean;
  }[];
}

export interface ArtifactTemporaryCandidate {
  readonly ref: ArtifactRef;
  readonly eligibleAt: string;
}

interface LifecycleSource {
  readonly id: string;
  readonly log: FileAuthorityCommitLog;
  readonly origin: DurableLogCheckpoint;
}

type LifecycleSourceHeads = Readonly<
  Record<string, DurableLogCheckpoint>
>;

export interface ArtifactCheckpointRetentionSnapshot {
  readonly sourceHeads: LifecycleSourceHeads;
}

export interface ArtifactCheckpointRetentionPort {
  checkpointRetentionSnapshot(): Promise<ArtifactCheckpointRetentionSnapshot>;
  retainedAtCheckpoint(
    snapshot: ArtifactCheckpointRetentionSnapshot,
    candidates: readonly ArtifactRef[],
  ): Promise<ArtifactRetentionSnapshot>;
}

interface LifecycleDigestState {
  readonly ref: ArtifactRef;
  readonly liveOwners: number;
  readonly unconditionalFacts: number;
  readonly ownershipFactsRoot: Digest;
  readonly retirementFactsRoot: Digest;
  readonly latestRetirementAt?: string;
  readonly releasedAt?: string;
  readonly releaseId?: Digest;
  readonly reclaimedReleaseId?: Digest;
}

interface DeadOwner {
  readonly owner: string;
  readonly factId: Digest;
  readonly at: string;
}

interface OwnerDigest {
  readonly owner: string;
  readonly digest: Digest;
}

interface CountedReference {
  readonly key: string;
  readonly ref: ArtifactRef;
  readonly count: number;
}

interface ProjectionMarker {
  readonly key: string;
}

interface IndexedDigest {
  readonly key: string;
  readonly digest: Digest;
}

interface IndexedGrant {
  readonly key: string;
  readonly grantId: string;
}

interface PendingOwner {
  readonly key: string;
  readonly owner: string;
}

interface ScopeReference {
  readonly key: string;
  readonly ref: ArtifactRef;
  readonly scopeIdentity: string;
}

interface QuotaValue {
  readonly key: string;
  readonly bytes: number;
}

interface MerkleNodeValue {
  readonly key: string;
  readonly digest: Digest;
}

interface UploadSummary {
  readonly ref: ArtifactRef;
  readonly latestExpiry: string;
}

interface TemporaryState {
  readonly ref: ArtifactRef;
  readonly latestExpiry: string;
}

interface TemporaryIntent {
  readonly ref: ArtifactRef;
  readonly scopeIdentity: string;
}

interface TemporaryMigration {
  readonly ref: ArtifactRef;
  readonly after?: string;
  readonly found: boolean;
}

interface AdoptionJob {
  readonly key: string;
  readonly digest: Digest;
  readonly adopted: boolean;
  readonly phase?: "grants" | "temporary";
  readonly after?: string;
}

interface MutationValue {
  readonly kind: "put" | "tombstone";
  readonly value?: JsonValue;
}

interface TemporaryReconciliationSession {
  phase: "presence" | "legacy" | "partial";
  presence?: SurfaceAssetTemporaryPresenceCursor;
  references?: ArtifactReferenceCursor;
  readonly queued: ArtifactRef[];
  referencePage: number;
  current?: ArtifactRef;
}

/**
 * Rebuildable cross-log lifecycle projection for one physical artifact store.
 * Authority logs remain the only business facts; this index supplies bounded
 * exact reads, stable release identities and restart-safe reclamation progress.
 */
export class ArtifactLifecycleIndex {
  readonly #queue = new SerialTaskQueue();
  readonly #queueScope = new AsyncLocalStorage<{ active: boolean }>();
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  readonly #maintenanceResourceId: string;
  readonly #index: FileDurableProjectionIndex;
  readonly #records: DurableProjectionReadContext;
  readonly #artifacts: ArtifactStore;
  readonly #temporaryArtifacts: MutableArtifactStore;
  readonly #temporaryPresence: SurfaceAssetTemporaryPresencePort;
  readonly #receiver: SurfaceAssetTemporaryRecoveryPort;
  readonly #logs: readonly FileAuthorityCommitLog[];
  readonly #ownsSourceLogs: boolean;
  #sources: readonly LifecycleSource[] | undefined;
  readonly #sourceHeads = new Map<string, DurableLogCheckpoint>();
  #retentionRebuildRequired = false;
  // 整段重建的目标源头：追平到它之前，尾部准入不按硬界挡新写入。
  #rebuildTarget: LifecycleSourceHeads | undefined;
  #temporaryReconciliation: TemporaryReconciliationSession | undefined;
  // 同一 home 的索引可能被宿主与短命命令两个进程打开：清单发布与非源派生的直写在跨进程锁内进行，
  // 发布前先采纳他方更新的一代，不产生同代冲突，也不让一方的未落盘直写被另一方的发布冲掉。
  readonly #lockPath: string;
  readonly #acquireLock = createFileLockAcquirer();
  readonly #writerLock = new AsyncLocalStorage<true>();
  #refreshing: Promise<void> | undefined;

  constructor(options: ArtifactLifecycleIndexOptions) {
    if (options.logs.length === 0) {
      throw new TypeError("Artifact lifecycle index requires an authority log");
    }
    this.#lockPath = path.join(path.resolve(options.rootDir), "artifact-lifecycle.lock");
    this.#logs = [...new Set(options.logs)];
    this.#ownsSourceLogs = options.ownsSourceLogs !== false;
    this.#artifacts = options.artifacts;
    this.#temporaryArtifacts = options.temporaryArtifacts;
    this.#temporaryPresence = options.temporaryPresence;
    this.#receiver = options.receiver;
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#storageMaintenance = options.storageMaintenance;
    this.#maintenanceResourceId = path.resolve(
      options.maintenanceResourceId ?? options.rootDir,
    );
    this.#index = new FileDurableProjectionIndex({
      rootDir: path.join(options.rootDir, "artifact-lifecycle"),
      projectionId: "artifact-lifecycle",
      reducerVersion: 3,
      // 内部投影必须拿到同一个 governor:它的 flush/compaction/rebuild 是本索引
      // 唯一的耐久写叶,不注入就等于这些写永远不进设备容量裁决。
      storageMaintenance: options.storageMaintenance,
      withSourceLock: (operation, abort) => this.#queueScope.getStore()?.active
        ? this.#withWriterLock(operation)
        : this.#serialize(() => this.#withWriterLock(operation), abort),
      // 脱离调用方的后续工作不能继承调用方的串行区与跨进程锁：那时锁可能早已释放。
      runDetached: (operation) => this.#queueScope.exit(() => this.#writerLock.exit(operation)),
      // 只包数据读取本身；投影退休清理由投影 owner 在该 permit 释放后独立准入，
      // 否则 lifecycle-reconcile 与 projection-compaction 会形成容量嵌套。
      runReadStep: (inputIdentity, operation) =>
        this.#runLifecycleStep(inputIdentity, operation),
    });
    this.#records = createBoundDurableProjectionReadContext(this.#index);
  }

  /**
   * 记账追平：追平各源尾部并排空退休、接管、过期与临时任务。配额、接管确认、后台回收与上传在场
   * 记录依赖它；启动与首发路径上只需 grant 的读者用 {@link catchUp}。
   */
  async synchronize(): Promise<void> {
    // 完整 reconcile 的身份只取触发时冻结的源日志头；派生索引同步位会随每页
    // 发布变化，不能进入义务键，否则同一目标在推进途中会裂成多个任务。
    const sources = await this.#initialize();
    const sourceHeads = await this.#captureSourceHeads(sources);
    await this.#drive({ sourceHeads }, () => this.#synchronizeBounded(sourceHeads));
  }

  /**
   * 只追平各源尾部，不排空退休、接管、过期与临时任务。尾部受源端追加准入的恢复欠账预算约束，
   * 所以工作量与已结束的历史和积压的维护任务无关；那些任务由后台维护分页排空。
   */
  async catchUp(): Promise<void> {
    const sources = await this.#initialize();
    const sourceHeads = await this.#captureSourceHeads(sources);
    // 义务身份与完整 reconcile 区分开：同源头的两种义务若合流，追尾的调用方会被拖进整轮排空。
    await this.#drive({ sourceHeads, scope: "sources" }, () =>
      this.#serialize(() => this.#catchUpLocked(sources, sourceHeads)));
  }

  /**
   * 追平源尾部并把覆盖位置落盘发布。源端准入按已发布位置计欠账：只追到内存，重开后仍要回放
   * 整段未发布尾部，准入在同一 head 上也永远不会放行。
   */
  async #publishCoverage(): Promise<void> {
    await this.catchUp();
    await this.#serialize(async () => {
      await this.#index.flush({ compact: false });
      this.#unflushedSourceRecords = 0;
    });
  }

  /**
   * 作为各源日志的尾部消费者登记：源端每次追加按日志自己的恢复欠账预算核本索引已落盘发布的覆盖
   * 位置，越过硬界即在追加前背压、由日志锁外追平并发布，越过主动刷新阈值则提交后异步追平并发布。
   * 每个打开本索引的写者进程在首次写入前登记一次。
   */
  registerTailAdmission(): () => void {
    const consumer: AuthorityTailConsumer = {
      // 只计清单里已发布的位置：内存覆盖层重开后要从源日志重放。未打开时位置未知；源还没有任何
      // 已发布的覆盖时，覆盖位置就是它的起点。
      coveredThrough: (logId) => this.#sources
        ? this.#index.publishedCheckpoints()[logId] ?? this.#sources.find((source) => source.id === logId)?.origin
        : undefined,
      publishCoverage: () => this.#publishCoverage().catch((error: unknown) => {
        if (error instanceof StorageMaintenanceAdmissionError || error instanceof StorageMaintenanceCancelledError) throw error;
        // 发布失败：本次追加不提交，按容量背压交调用方在互斥区外重试；失败原因随 cause 带出。
        throw Object.assign(
          new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 25 }),
          { cause: error },
        );
      }),
      refresh: () => {
        // 追加者的维护语境与串行区不随刷新带走：刷新是独立的后台推进。
        this.#refreshing ??= this.#queueScope.exit(() => this.#writerLock.exit(() =>
          runDetachedMaintenanceContext("background", () => this.#publishCoverage()))).catch(() => undefined)
          .finally(() => { this.#refreshing = undefined; });
      },
      rebuilding: () => this.#retentionRebuildRequired || this.#rebuildTarget !== undefined,
      // 源日志装入了新前缀：旧覆盖位置失效，下一步整段重建；缓存的源头提示一并作废。
      sourceReplaced: () => {
        this.#retentionRebuildRequired = true;
        this.#sourceHeads.clear();
      },
    };
    const unregister = this.#logs.map((log) => log.registerTailConsumer(consumer));
    return () => { for (const remove of unregister) remove(); };
  }

  async #drive(identity: unknown, step: () => Promise<boolean>): Promise<void> {
    await this.#maintenanceRunner.run(
      storageMaintenanceObligation(
        "lifecycle-reconcile",
        this.#maintenanceResourceId,
        identity,
        { owner: "artifact-lifecycle-index", obligation: "committed" },
      ),
      currentMaintenanceAbortSignal(),
      async () => {
        const admissionDeadline = Date.now() + LIFECYCLE_ADMISSION_DEADLINE_MS;
        let more = true;
        while (more) {
          try {
            more = await step();
          } catch (error) {
            const retryAfterMs = maintenanceRetryDelayMs(error);
            // `#synchronizeBounded` 已退出自己的串行区，正常调用可在这里等待后
            // 重驱同一 committed 义务。若调用方仍持有更外层互斥区，则继续上抛，
            // 由那个最外层 owner 退出互斥区后重试，不能把等待藏回锁内。
            if (
              retryAfterMs === undefined ||
              isHoldingMaintenanceExclusion() ||
              Date.now() >= admissionDeadline
            ) {
              throw error;
            }
            await waitForMaintenanceRetry(
              Math.min(
                retryAfterMs,
                Math.max(0, admissionDeadline - Date.now()),
              ),
            );
            continue;
          }
          if (more) await yieldToEventLoop();
        }
      },
    );
  }

  /**
   * 空闲维护：追平源日志并完成挂起的整轮合并。宿主在空闲时调用，使重启时的恢复只需
   * 回放很短的尾部，且不在启动或请求路径上承担与索引规模成正比的合并。
   */
  async maintainIdle(): Promise<void> {
    await this.synchronize();
    await this.#serialize(() => this.#index.flush({ compact: true }));
  }

  #serialize<T>(operation: () => Promise<T>, abort?: AbortSignal): Promise<T> {
    return this.#queue.run(() => {
      const scope = { active: true };
      return this.#queueScope.run(scope, async () => {
        try { return await operation(); }
        finally { scope.active = false; }
      });
    }, abort);
  }

  /** 进程停机时取消生命周期、内部投影及源日志拥有的维护义务。 */
  async stopStorageMaintenance(): Promise<void> {
    await this.#maintenanceRunner.stop();
    await this.#index.stopStorageMaintenance();
    if (this.#ownsSourceLogs) for (const log of this.#logs) await log.stopStorageMaintenance();
  }

  /** 包着直写的操作传 verifyAfter=false：见 {@link #runCovered}。 */
  async #runSynchronized<T>(operation: () => Promise<T>, verifyAfter = true): Promise<T> {
    return this.#runCovered(() => this.synchronize(), operation, verifyAfter);
  }

  async #runCaughtUp<T>(operation: () => Promise<T>): Promise<T> {
    return this.#runCovered(() => this.catchUp(), operation, true);
  }

  /**
   * 只在覆盖到冻结源头、且自追平开始没有换底的状态上执行操作。采纳他方发布会丢弃本实例未落盘的
   * 覆盖层，可能发生在追平之后、读取之前，也可能发生在读取中途（读取触发的退役清理会读盘）；
   * 这时重新追平再执行，而不是在退回的状态上作答。每次重做都对应他方又一次发布；停止后追平抛出，
   * 循环随之结束。包着直写的操作只核执行前：直写在写者锁内读盘、按需重同步，执行后不能重做。
   */
  async #runCovered<T>(
    advance: () => Promise<void>,
    operation: () => Promise<T>,
    verifyAfter: boolean,
  ): Promise<T> {
    let rebuilt = false;
    for (;;) {
      const sources = await this.#initialize();
      const sourceHeads = await this.#captureSourceHeads(sources);
      const base = this.#index.adoptionCount();
      await advance();
      let result: { readonly value: T } | undefined;
      try {
        result = await this.#serialize(async () => {
          if (this.#index.adoptionCount() !== base || !this.#covers(sources, sourceHeads)) return undefined;
          const value = await operation();
          return !verifyAfter || this.#index.adoptionCount() === base ? { value } : undefined;
        });
      } catch (error) {
        if (rebuilt || !(error instanceof DurableProjectionStorageError)) throw error;
        rebuilt = true;
        await this.#serialize(async () => {
          this.#retentionRebuildRequired = true;
        });
        continue;
      }
      if (result) return result.value;
      await yieldToEventLoop();
    }
  }

  #covers(sources: readonly LifecycleSource[], sourceHeads: LifecycleSourceHeads): boolean {
    const checkpoints = this.#index.checkpoints();
    return sources.every((source) =>
      (checkpoints[source.id] ?? source.origin).lsn >= sourceHeads[source.id]!.lsn);
  }

  async #catchUpLocked(
    sources: readonly LifecycleSource[],
    sourceHeads: LifecycleSourceHeads,
  ): Promise<boolean> {
    if (this.#retentionRebuildRequired) {
      await this.#reset(sources, sourceHeads);
      this.#retentionRebuildRequired = false;
      return true;
    }
    try {
      const more = await this.#synchronizeSources(sources, sourceHeads);
      this.#settleRebuild();
      return more;
    } catch (error) {
      if (!isRebuildableProjectionFailure(error)) throw error;
      await this.#reset(sources, sourceHeads);
      return true;
    }
  }

  /**
   * 停止前发布已有的有界覆盖层与源向量：只写检查点，不追尾、不排空任务、不做整轮合并。未覆盖的
   * 尾部受源端追加准入的预算约束，由下次启动追平。
   */
  async checkpoint(): Promise<void> {
    if (!this.#sources) return;
    await this.#serialize(() => this.#index.flushCheckpoint());
  }

  /** 跨进程写者锁：同一异步链内可重入；等不到时按容量背压交给调用方在其互斥区外重试。 */
  async #withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#writerLock.getStore()) return operation();
    let release: () => Promise<void>;
    try {
      release = await this.#acquireLock(this.#lockPath, {
        staleMs: WRITER_LOCK_STALE_MS,
        waitMs: WRITER_LOCK_WAIT_MS,
        resourceName: "ArtifactLifecycleIndex",
      });
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) throw error;
      throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 25 });
    }
    try {
      return await this.#writerLock.run(true, operation);
    } finally {
      await release();
    }
  }

  /**
   * 非源派生的直写（上传在场意图、回收标记）：从决定到落盘整段持跨进程锁。先采纳他方已发布的
   * 更新一代；采纳了就在锁内把源尾追平再做决定，因为本进程未落盘的覆盖层已随之作废。
   */
  #directWrite<T>(operation: () => Promise<T>): Promise<T> {
    return this.#withWriterLock(async () => {
      const before = this.#index.checkpoints();
      await this.#index.refreshPublishedState();
      if (!sameSourceHeads(before, this.#index.checkpoints())) {
        const sources = await this.#initialize();
        const sourceHeads = await this.#captureSourceHeads(sources);
        while (await this.#synchronizeSources(sources, sourceHeads)) await yieldToEventLoop();
      }
      return operation();
    });
  }

  async #synchronizeBounded(
    sourceHeads: LifecycleSourceHeads,
  ): Promise<boolean> {
    return this.#serialize(() => this.#synchronizeBoundedLocked(sourceHeads));
  }

  #runLifecycleStep<T>(
    inputIdentity: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runStorageMaintenanceStep(
      this.#storageMaintenance,
      storageMaintenanceRequest(
        "lifecycle-reconcile",
        this.#maintenanceResourceId,
        inputIdentity,
        { obligation: "committed" },
      ),
      operation,
    );
  }

  #referencePageRunner(
    session: TemporaryReconciliationSession,
    phase: "legacy" | "partial",
  ): PhysicalStorageStepRunner {
    return (operation) => {
      const page = session.referencePage;
      session.referencePage = page + 1;
      return this.#runLifecycleStep(
        { step: "temporary-reference-page", phase, page },
        operation,
      );
    };
  }

  async #synchronizeBoundedLocked(
    sourceHeads: LifecycleSourceHeads,
  ): Promise<boolean> {
    const sources = await this.#initialize();
    if (this.#retentionRebuildRequired) {
      await this.#reset(sources, sourceHeads);
      this.#retentionRebuildRequired = false;
      return true;
    }
    try {
      const more = await this.#advanceBounded(sources, sourceHeads);
      this.#settleRebuild();
      return more;
    } catch (error) {
      if (error instanceof LifecycleBaseReplaced) {
        // 本步的增量没有留下。临时件对账的游标可能已越过这些条目，关掉会话、下一步从头对账。
        await this.#closeTemporaryReconciliation();
        return true;
      }
      if (!isRebuildableProjectionFailure(error)) throw error;
      await this.#reset(sources, sourceHeads);
      return true;
    }
  }

  async releasedBefore(
    before: string,
    limit: number,
  ): Promise<readonly ArtifactReleaseCandidate[]> {
    assertCanonicalTime(before, "Artifact release cutoff");
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > MAX_RELEASE_PAGE_SIZE
    ) {
      throw new RangeError(
        `Artifact release page limit must be 1-${MAX_RELEASE_PAGE_SIZE}`,
      );
    }
    return this.#runSynchronized(async () => {
      const page = await this.#records.scan(
        {
          gte: RELEASE_PREFIX,
          lt: `${RELEASE_PREFIX}${before}\uffff`,
        },
        limit,
      );
      const candidates: ArtifactReleaseCandidate[] = [];
      for (const { key, value } of page.entries) {
        candidates.push(await this.#releaseCandidate(value, key));
      }
      return candidates;
    });
  }

  /**
   * Called while the artifact-store delete fence is held. It performs only
   * constant-size WAL boundary checks and exact index reads. If any log moved
   * after the last synchronized checkpoint, every candidate is conservatively
   * deferred and the next GC turn will synchronize before retrying. A damaged
   * derived index also defers this turn and arms a fence-free rebuild.
   */
  async retainedAtCurrentHead(
    candidates: readonly ArtifactRef[],
  ): Promise<ArtifactRetentionSnapshot> {
    return this.#serialize(async () => {
      try {
        const sources = await this.#initialize();
        const checkpoints = this.#index.checkpoints();
        for (const source of sources) {
          const current = await source.log.checkpoint();
          if (!sameCheckpoint(checkpoints[source.id], current)) {
            return { status: "deferred" };
          }
        }
        const retained: ArtifactRef[] = [];
        for (const ref of deduplicateReferences(candidates)) {
          const state = await this.#state(ref.digest);
          if (!state) continue;
          assertCompatibleReference(state.ref, ref);
          if (state.unconditionalFacts > 0 || state.liveOwners > 0) {
            retained.push(ref);
          }
        }
        return { status: "current", retained };
      } catch (error) {
        if (error instanceof DurableProjectionStorageError) {
          this.#retentionRebuildRequired = true;
          return { status: "deferred" };
        }
        throw error;
      }
    });
  }

  async checkpointRetentionSnapshot(): Promise<ArtifactCheckpointRetentionSnapshot> {
    return this.#runSynchronized(async () => ({
      sourceHeads: cloneSourceHeads(this.#index.checkpoints()),
    }));
  }

  async retainedAtCheckpoint(
    snapshot: ArtifactCheckpointRetentionSnapshot,
    candidates: readonly ArtifactRef[],
  ): Promise<ArtifactRetentionSnapshot> {
    return this.#serialize(async () => {
      try {
        if (!sameSourceHeads(this.#index.checkpoints(), snapshot.sourceHeads)) {
          return { status: "deferred" };
        }
        const retained: ArtifactRef[] = [];
        for (const ref of deduplicateReferences(candidates)) {
          const state = await this.#state(ref.digest);
          if (!state) continue;
          assertCompatibleReference(state.ref, ref);
          if (state.unconditionalFacts > 0 || state.liveOwners > 0) retained.push(ref);
        }
        return { status: "current", retained };
      } catch (error) {
        if (error instanceof DurableProjectionStorageError) {
          this.#retentionRebuildRequired = true;
          return { status: "deferred" };
        }
        throw error;
      }
    });
  }

  async markReclaimed(
    candidates: readonly ArtifactReleaseCandidate[],
  ): Promise<void> {
    if (candidates.length === 0) return;
    await this.#runSynchronized(() => this.#directWrite(async () => {
      const buffer = this.#buffer();
      for (const candidate of candidates) {
        const state = await this.#state(candidate.ref.digest, buffer);
        if (
          !state ||
          state.releaseId !== candidate.releaseId ||
          state.reclaimedReleaseId === candidate.releaseId
        ) {
          continue;
        }
        buffer.tombstone(releaseKey(candidate));
        buffer.put(stateKey(candidate.ref.digest), asJson({
          ...state,
          reclaimedReleaseId: candidate.releaseId,
        }));
      }
      await this.#commit(buffer, this.#index.checkpoints());
    }), false);
  }

  /**
   * 启动与每次使用 grant 的路径只追源尾：撤销在源回放时内联停用，过期按有效时间前沿在这里判定，
   * 与后台排空过期任务后的结果逐键相同，不等过期、退休等积压排空。
   */
  async activeGrant(
    grantId: string,
    expected?: SurfaceAssetGrant,
  ): Promise<SurfaceAssetGrant | undefined> {
    return this.#runCaughtUp(async () => {
      const key = activeGrantKey(grantId);
      const value = await this.#records.get(key);
      if (value === undefined) return undefined;
      const grant = await this.#indexedGrant(
        value,
        key,
        (candidate) => activeGrantKey(candidate.grantId),
        this.#records,
      );
      if (
        expected !== undefined &&
        canonicalize(expected) !== canonicalize(grant)
      ) {
        throw invalidLifecycleProjection(
          "Active surface grant does not match its expected authority grant",
        );
      }
      const effectiveTime = optionalTime(await this.#records.get(META_TIME_KEY));
      if (effectiveTime && Date.parse(grant.expiry) <= Date.parse(effectiveTime)) return undefined;
      return grant;
    });
  }

  async activeConversationGrants(
    conversationId: string,
    limit: number,
  ): Promise<readonly SurfaceAssetGrant[]> {
    return this.#activeGrants(
      conversationGrantPrefix(conversationId),
      limit,
      (grant) =>
        grant.scope.domain === "conversation"
          ? conversationGrantKey(grant.scope.conversationId, grant.grantId)
          : undefined,
    );
  }

  async activeSurfaceGrants(
    surfacePrincipal: string,
    limit: number,
  ): Promise<readonly SurfaceAssetGrant[]> {
    return this.#activeGrants(
      surfaceGrantPrefix(surfacePrincipal),
      limit,
      (grant) => surfaceGrantKey(grant.surfacePrincipal, grant.grantId),
    );
  }

  /** Logical key pagination over the live grant index, independent of old trust members. */
  async activeGrantPage(after: string | undefined, limit: number): Promise<readonly SurfaceAssetGrant[]> {
    assertPageLimit(limit, "Active grant");
    return this.#runSynchronized(async () => {
      const page = await this.#records.scan({
        ...(after === undefined ? { gte: ACTIVE_GRANT_PREFIX } : { gt: activeGrantKey(after) }),
        lt: `${ACTIVE_GRANT_PREFIX}\uffff`,
      }, limit);
      const grants: SurfaceAssetGrant[] = [];
      for (const { key, value } of page.entries) {
        grants.push(await this.#indexedGrant(value, key, grant => activeGrantKey(grant.grantId), this.#records));
      }
      return grants;
    });
  }

  /** \u6709\u6548\u65f6\u95f4\u524d\u6cbf\u4e4b\u540e\u6700\u65e9\u7684\u5230\u671f\uff1b\u524d\u6cbf\u53ca\u4e4b\u524d\u5df2\u5230\u671f\u3001\u5c1a\u5f85\u540e\u53f0\u505c\u7528\u7684\u4e0d\u8ba1\u3002 */
  async nextGrantExpiry(): Promise<string | undefined> {
    return this.#runCaughtUp(async () => {
      const effectiveTime = optionalTime(await this.#records.get(META_TIME_KEY));
      const page = await this.#records.scan(
        {
          gte: effectiveTime ? `${EXPIRY_GRANT_PREFIX}${effectiveTime}\uffff` : EXPIRY_GRANT_PREFIX,
          lt: `${EXPIRY_GRANT_PREFIX}\uffff`,
        },
        1,
      );
      const first = page.entries[0];
      return first
        ? (await this.#indexedGrant(
          first.value,
          first.key,
          expiryGrantKey,
          this.#records,
        )).expiry
        : undefined;
    });
  }

  async quotaSnapshot(
    scope: SurfaceAssetScope,
    refs: readonly ArtifactRef[],
  ): Promise<ArtifactQuotaSnapshot> {
    return this.#runSynchronized(async () => {
      const scopeIdentity = surfaceScopeKey(scope);
      const memberships = [];
      for (const ref of deduplicateReferences(refs)) {
        const state = await this.#state(ref.digest);
        if (state) assertCompatibleReference(state.ref, ref);
        const accounting = await this.#accountingMembership(
          ref,
          scopeIdentity,
          this.#records,
        );
        memberships.push({
          digest: ref.digest,
          retained: state ? isRetained(state) : false,
          scopeCounted: accounting.scopeCounted,
          deviceCounted: accounting.deviceCounted,
        });
      }
      return {
        scopeBytes: quotaValue(
          await this.#records.get(quotaScopeKey(scopeIdentity)),
          quotaScopeKey(scopeIdentity),
        ),
        deviceBytes: quotaValue(
          await this.#records.get(QUOTA_DEVICE_KEY),
          QUOTA_DEVICE_KEY,
        ),
        memberships,
      };
    });
  }

  async isRetainedReference(ref: ArtifactRef): Promise<boolean> {
    return this.#runSynchronized(async () => {
      const state = await this.#state(ref.digest);
      if (!state) return false;
      assertCompatibleReference(state.ref, ref);
      return isRetained(state);
    });
  }

  async recordTemporaryPresence(
    ref: ArtifactRef,
    scopeIdentity: string,
  ): Promise<void> {
    await this.#runSynchronized(() => this.#directWrite(async () => {
      const buffer = this.#buffer();
      await this.#assertUploadScope(ref, scopeIdentity, buffer);
      buffer.put(
        temporaryIntentKey(ref.digest, scopeIdentity),
        asJson({ ref, scopeIdentity }),
      );
      await this.#commit(buffer, this.#index.checkpoints());
      await this.#temporaryPresence.mark(ref, scopeIdentity);
    }), false);
  }

  async settleTemporaryPresence(
    ref: ArtifactRef,
    scopeIdentity: string,
    landed: boolean,
  ): Promise<void> {
    await this.#runSynchronized(() => this.#directWrite(async () => {
      if (!landed) {
        await this.#temporaryPresence.remove(ref, scopeIdentity);
      }
      const buffer = this.#buffer();
      const key = temporaryIntentKey(ref.digest, scopeIdentity);
      if (landed) {
        await this.#recordTemporary(ref, scopeIdentity, buffer);
      }
      buffer.tombstone(key);
      await this.#commit(buffer, this.#index.checkpoints());
    }), false);
  }

  async temporaryBefore(
    before: string,
    limit: number,
  ): Promise<readonly ArtifactTemporaryCandidate[]> {
    assertCanonicalTime(before, "Temporary artifact cutoff");
    assertPageLimit(limit, "Temporary artifact");
    return this.#runSynchronized(async () => {
      const page = await this.#records.scan(
        {
          gte: TEMPORARY_DUE_PREFIX,
          lt: `${TEMPORARY_DUE_PREFIX}${before}\uffff`,
        },
        limit,
      );
      const candidates: ArtifactTemporaryCandidate[] = [];
      for (const { key, value } of page.entries) {
        candidates.push(await this.#temporaryCandidate(value, key));
      }
      return candidates;
    });
  }

  async adoptedTemporary(
    limit: number,
  ): Promise<readonly ArtifactRef[]> {
    assertPageLimit(limit, "Adopted temporary artifact");
    return this.#runSynchronized(async () => {
      const page = await this.#records.scan(
        {
          gte: TEMPORARY_CLEANUP_PREFIX,
          lt: `${TEMPORARY_CLEANUP_PREFIX}\uffff`,
        },
        limit,
      );
      const references: ArtifactRef[] = [];
      for (const { key, value } of page.entries) {
        const indexed = indexedDigest(value, key, "Temporary cleanup");
        assertProjectionKey(
          temporaryCleanupKey(indexed.digest),
          key,
          "Temporary cleanup",
        );
        const lifecycle = await this.#state(indexed.digest);
        // cleanup 记录只反绑主状态存在,不要求仍被保留:接管后、清扫前会话即
        // 删除的叶子会以"已释放 + cleanup 未清"的组合存在,其临时副本照样要清
        // ——主字节的保留窗管的是正式存储,与临时副本的物理清理无关。若这里
        // 要求 isRetained,该组合会永久抛投影损坏,重建后从日志重放得到同一
        // 状态再抛,GC 从此停摆。
        if (!lifecycle) {
          throw invalidLifecycleProjection(
            "Temporary cleanup has no canonical state",
          );
        }
        references.push(lifecycle.ref);
      }
      return references;
    });
  }

  async markTemporaryRemoved(ref: ArtifactRef): Promise<boolean> {
    return this.#runSynchronized(() => this.#directWrite(async () => {
      const prefix = temporaryScopePrefix(ref.digest);
      const page = await this.#records.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        RETIREMENT_PAGE_SIZE,
      );
      const scopes = page.entries.map(({ key, value }) =>
        scopeReference(value, key, temporaryScopeKey).scopeIdentity
      );
      await this.#temporaryPresence.removeScopes(ref, scopes);
      const buffer = this.#buffer();
      for (const scopeIdentity of scopes) {
        await this.#removeTemporaryScope(ref, scopeIdentity, buffer);
      }
      const complete = page.entries.length < RETIREMENT_PAGE_SIZE;
      if (complete) {
        await this.#finishTemporaryRemoval(ref, buffer);
      }
      await this.#commit(buffer, this.#index.checkpoints());
      return complete;
    }), false);
  }

  async #activeGrants(
    prefix: string,
    limit: number,
    keyOf: (grant: SurfaceAssetGrant) => string | undefined,
  ): Promise<readonly SurfaceAssetGrant[]> {
    assertPageLimit(limit, "Active grant");
    return this.#runSynchronized(async () => {
      const page = await this.#records.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        limit,
      );
      const grants: SurfaceAssetGrant[] = [];
      for (const { key, value } of page.entries) {
        grants.push(
          await this.#indexedGrant(value, key, keyOf, this.#records),
        );
      }
      return grants;
    });
  }

  async #indexedGrant(
    value: JsonValue,
    key: string,
    keyOf: (grant: SurfaceAssetGrant) => string | undefined,
    reader: Pick<DurableProjectionReadContext | MutationBuffer, "get">,
  ): Promise<SurfaceAssetGrant> {
    const indexed = indexedGrant(value, key);
    const historyKey = grantHistoryKey(indexed.grantId);
    const historical = await reader.get(historyKey);
    if (historical === undefined) {
      throw invalidLifecycleProjection(
        "Surface grant secondary index has no canonical history record",
      );
    }
    const grant = boundSurfaceGrant(
      historical,
      historyKey,
      (candidate) => grantHistoryKey(candidate.grantId),
    );
    const expected = keyOf(grant);
    if (expected === undefined) {
      throw invalidLifecycleProjection(
        "Surface asset grant is outside the index key domain",
      );
    }
    assertProjectionKey(expected, key, "Surface asset grant");
    return grant;
  }

  async #releaseCandidate(
    value: JsonValue,
    key: string,
  ): Promise<ArtifactReleaseCandidate> {
    const indexed = indexedDigest(value, key, "Artifact release");
    const state = await this.#state(indexed.digest);
    if (
      !state ||
      state.releasedAt === undefined ||
      state.releaseId === undefined
    ) {
      throw invalidLifecycleProjection(
        "Artifact release has no canonical lifecycle state",
      );
    }
    const candidate = {
      ref: state.ref,
      releasedAt: state.releasedAt,
      releaseId: state.releaseId,
    };
    assertProjectionKey(releaseKey(candidate), key, "Artifact release");
    return candidate;
  }

  async #temporaryCandidate(
    value: JsonValue,
    key: string,
  ): Promise<ArtifactTemporaryCandidate> {
    const indexed = indexedDigest(value, key, "Temporary artifact candidate");
    const stateKeyForDigest = temporaryStateKey(indexed.digest);
    const stateValue = await this.#records.get(stateKeyForDigest);
    if (stateValue === undefined) {
      throw invalidLifecycleProjection(
        "Temporary due index has no canonical temporary state",
      );
    }
    const state = temporaryState(stateValue);
    assertProjectionKey(
      temporaryStateKey(state.ref.digest),
      stateKeyForDigest,
      "Temporary state",
    );
    const candidate = {
      ref: state.ref,
      eligibleAt: state.latestExpiry,
    };
    assertProjectionKey(
      temporaryDueKey(candidate),
      key,
      "Temporary artifact candidate",
    );
    return candidate;
  }

  async #initialize(): Promise<readonly LifecycleSource[]> {
    if (this.#sources) return this.#sources;
    const sources: LifecycleSource[] = [];
    for (const log of this.#logs) {
      const origin = await log.originCheckpoint();
      sources.push({ id: origin.logId, log, origin });
    }
    sources.sort((left, right) => compare(left.id, right.id));
    for (let index = 1; index < sources.length; index += 1) {
      if (sources[index - 1]?.id === sources[index]?.id) {
        throw new Error("Artifact lifecycle input log identity is duplicated");
      }
    }
    const origins = Object.fromEntries(
      sources.map((source) => [source.id, source.origin]),
    );
    await this.#index.initialize(origins);
    this.#sources = sources;
    return sources;
  }

  /**
   * 整段重建：派生损坏、源被替换或源集合换代。重建到起点时的源头之前，作为尾部消费者不参与硬界
   * 准入——重建尾部分别计量，不挡新写入；由提交后的刷新与读取推进。
   */
  async #reset(sources: readonly LifecycleSource[], rebuildTarget: LifecycleSourceHeads): Promise<void> {
    await this.#closeTemporaryReconciliation();
    this.#unflushedSourceRecords = 0;
    await this.#index.reset(
      Object.fromEntries(sources.map((source) => [source.id, source.origin])),
    );
    this.#rebuildTarget = rebuildTarget;
  }

  #settleRebuild(): void {
    const target = this.#rebuildTarget;
    if (!target) return;
    const checkpoints = this.#index.checkpoints();
    if (Object.values(target).every((head) => (checkpoints[head.logId]?.lsn ?? 0) >= head.lsn)) {
      this.#rebuildTarget = undefined;
    }
  }

  async #advanceBounded(
    sources: readonly LifecycleSource[],
    sourceHeads: LifecycleSourceHeads,
  ): Promise<boolean> {
    const sourcesLagging = await this.#synchronizeSources(
      sources,
      sourceHeads,
    );
    let maintenanceLagging = false;
    for (let turn = 0; turn < MAX_SYNCHRONIZATION_TURNS; turn += 1) {
      const retirementLagging = await this.#drainRetirementJobs();
      const adoptionLagging = await this.#drainAdoptionJobs();
      const expiryLagging = await this.#retireExpiredGrants();
      const temporaryIntentLagging = await this.#drainTemporaryIntents();
      maintenanceLagging =
        retirementLagging ||
        adoptionLagging ||
        expiryLagging ||
        temporaryIntentLagging;
      if (!maintenanceLagging) break;
    }
    if (!sourcesLagging && !maintenanceLagging) {
      maintenanceLagging = await this.#reconcileTemporaryArtifacts();
    }
    return sourcesLagging || maintenanceLagging;
  }

  async #reconcileTemporaryArtifacts(): Promise<boolean> {
    const reconciled = await this.#records.get(
      META_TEMPORARY_RECONCILED_KEY,
    );
    if (reconciled !== undefined && reconciled !== true) {
      throw invalidLifecycleProjection(
        "Temporary reconciliation marker is invalid",
      );
    }
    if (reconciled === true) {
      await this.#closeTemporaryReconciliation();
      return false;
    }
    const session = this.#temporaryReconciliation ??= {
      phase: "presence",
      presence: this.#temporaryPresence.openReconciliationCursor(),
      queued: [],
      referencePage: 0,
    };
    if (session.phase === "presence") {
      const page = await session.presence!.next(SOURCE_PAGE_SIZE);
      for (const { ref, scopeIdentity } of page.entries) {
        const progress = await this.#receiver.progress(
          ref,
          (identity, operation) =>
            this.#runLifecycleStep(identity, operation),
        );
        if (!hasDurableTemporary(progress)) {
          await this.#temporaryPresence.remove(ref, scopeIdentity);
          continue;
        }
        await this.#recordRecoveredTemporary(ref, scopeIdentity);
      }
      if (page.done) {
        await session.presence!.close();
        session.presence = undefined;
        session.phase = "legacy";
        session.references = this.#temporaryArtifacts.openReferenceCursor(
          this.#referencePageRunner(session, "legacy"),
        );
        session.referencePage = 0;
      }
      return true;
    }
    if (session.current) {
      if (await this.#recordLegacyTemporary(session.current)) {
        session.current = undefined;
      }
      return true;
    }
    if (session.queued.length > 0) {
      session.current = session.queued.shift();
      return true;
    }
    const page = await session.references!.next(SOURCE_PAGE_SIZE);
    session.queued.push(...page.references);
    if (session.queued.length > 0) {
      session.current = session.queued.shift();
      return true;
    }
    if (!page.done) return true;
    await session.references!.close();
    session.references = undefined;
    if (session.phase === "legacy") {
      session.phase = "partial";
      session.referencePage = 0;
      session.references = this.#receiver.openPartialReferenceCursor(
        this.#referencePageRunner(session, "partial"),
      );
      return true;
    }
    const buffer = this.#buffer();
    buffer.put(META_TEMPORARY_RECONCILED_KEY, true);
    await this.#commit(buffer, this.#index.checkpoints());
    await this.#closeTemporaryReconciliation();
    return false;
  }

  async #recordRecoveredTemporary(
    ref: ArtifactRef,
    scopeIdentity: string,
  ): Promise<void> {
    // 先记底：下面“已记录则跳过”的判断也属于这次决定。
    const buffer = this.#buffer();
    const existingState = await this.#records.get(
      temporaryStateKey(ref.digest),
    );
    if (existingState !== undefined) {
      const state = temporaryState(existingState);
      assertProjectionKey(
        temporaryStateKey(state.ref.digest),
        temporaryStateKey(ref.digest),
        "Temporary state",
      );
      assertCompatibleReference(state.ref, ref);
    }
    const existingCleanup = await this.#records.get(
      temporaryCleanupKey(ref.digest),
    );
    if (existingCleanup !== undefined) {
      const cleanupKey = temporaryCleanupKey(ref.digest);
      const cleanup = indexedDigest(
        existingCleanup,
        cleanupKey,
        "Temporary cleanup",
      );
      assertProjectionKey(
        temporaryCleanupKey(cleanup.digest),
        cleanupKey,
        "Temporary cleanup",
      );
      const lifecycle = await this.#state(cleanup.digest);
      // 同 `adoptedTemporary`:cleanup 只要求主状态存在。恢复扫描撞见"已释放 +
      // cleanup 未清"的叶子是合法中间态,不是损坏。
      if (!lifecycle) {
        throw invalidLifecycleProjection(
          "Temporary cleanup has no canonical state",
        );
      }
      assertCompatibleReference(lifecycle.ref, ref);
      return;
    }
    await this.#recordTemporary(ref, scopeIdentity, buffer);
    await this.#commit(buffer, this.#index.checkpoints());
  }

  async #recordLegacyTemporary(ref: ArtifactRef): Promise<boolean> {
    const migrationKey = temporaryMigrationKey(ref.digest);
    let migrationValue = await this.#records.get(migrationKey);
    const migrationActive =
      migrationValue !== undefined ||
      await this.#temporaryPresence.hasLegacyMigration(ref);
    if (!migrationActive && await this.#temporaryPresence.has(ref)) return true;
    if (!migrationActive) {
      await this.#temporaryPresence.beginLegacyMigration(ref);
    } else if (!(await this.#temporaryPresence.hasLegacyMigration(ref))) {
      await this.#temporaryPresence.beginLegacyMigration(ref);
    }
    if (migrationValue === undefined) {
      const buffer = this.#buffer();
      buffer.put(migrationKey, asJson({
        ref,
        found: false,
      }));
      await this.#commit(buffer, this.#index.checkpoints());
      migrationValue = await this.#records.get(migrationKey);
    }
    let migration = temporaryMigration(migrationValue);
    assertCompatibleReference(migration.ref, ref);
    assertProjectionKey(
      temporaryMigrationKey(migration.ref.digest),
      migrationKey,
      "Temporary artifact migration",
    );
    const lifecycle = await this.#state(ref.digest);
    if (lifecycle && isRetained(lifecycle)) {
      assertCompatibleReference(lifecycle.ref, ref);
      const buffer = this.#buffer();
      const cleanupKey = temporaryCleanupKey(ref.digest);
      buffer.put(
        cleanupKey,
        indexedDigestValue(cleanupKey, ref.digest),
      );
      buffer.tombstone(migrationKey);
      await this.#commit(buffer, this.#index.checkpoints());
      await this.#temporaryPresence.finishLegacyMigration(ref);
      return true;
    }
    const prefix = uploadScopePrefix(ref.digest);
    assertPageCursor(
      migration.after,
      prefix,
      "Temporary artifact migration",
    );
    const page = await this.#records.scan(
      {
        ...(migration.after === undefined
          ? { gte: prefix }
          : { gt: migration.after }),
        lt: `${prefix}\uffff`,
      },
      RETIREMENT_PAGE_SIZE,
    );
    if (page.entries.length === 0) {
      if (!migration.found) {
        throw new Error("Temporary surface asset has no durable upload grant");
      }
      const buffer = this.#buffer();
      buffer.tombstone(migrationKey);
      await this.#commit(buffer, this.#index.checkpoints());
      await this.#temporaryPresence.finishLegacyMigration(ref);
      return true;
    }
    const buffer = this.#buffer();
    for (const entry of page.entries) {
      const scopeIdentity = scopeReference(
        entry.value,
        entry.key,
        uploadScopeKey,
      ).scopeIdentity;
      await this.#temporaryPresence.mark(ref, scopeIdentity);
      await this.#recordTemporary(
        ref,
        scopeIdentity,
        buffer,
      );
    }
    const last = page.entries.at(-1);
    if (!last) throw new Error("Temporary migration page is empty");
    migration = {
      ref,
      after: last.key,
      found: true,
    };
    const complete = page.entries.length < RETIREMENT_PAGE_SIZE;
    if (complete) buffer.tombstone(migrationKey);
    else buffer.put(migrationKey, asJson(migration));
    await this.#commit(buffer, this.#index.checkpoints());
    if (complete) {
      await this.#temporaryPresence.finishLegacyMigration(ref);
    }
    return complete;
  }

  async #closeTemporaryReconciliation(): Promise<void> {
    const session = this.#temporaryReconciliation;
    this.#temporaryReconciliation = undefined;
    await session?.presence?.close();
    await session?.references?.close();
  }

  async #drainTemporaryIntents(): Promise<boolean> {
    const pending = await this.#records.scan(
      {
        gte: TEMPORARY_INTENT_PREFIX,
        lt: `${TEMPORARY_INTENT_PREFIX}\uffff`,
      },
      RETIREMENT_PAGE_SIZE,
    );
    for (const entry of pending.entries) {
      const intent = temporaryIntent(entry.value);
      assertProjectionKey(
        temporaryIntentKey(intent.ref.digest, intent.scopeIdentity),
        entry.key,
        "Temporary artifact intent",
      );
      const progress = await this.#receiver.progress(
        intent.ref,
        (identity, operation) =>
          this.#runLifecycleStep(identity, operation),
      );
      if (!hasDurableTemporary(progress)) {
        await this.#temporaryPresence.remove(
          intent.ref,
          intent.scopeIdentity,
        );
      }
      const buffer = this.#buffer();
      if (progress.complete || progress.receivedBytes > 0) {
        await this.#recordTemporary(
          intent.ref,
          intent.scopeIdentity,
          buffer,
        );
      }
      buffer.tombstone(entry.key);
      await this.#commit(buffer, this.#index.checkpoints());
    }
    return (await this.#records.scan(
      {
        gte: TEMPORARY_INTENT_PREFIX,
        lt: `${TEMPORARY_INTENT_PREFIX}\uffff`,
      },
      1,
    )).entries.length > 0;
  }

  #unflushedSourceRecords = 0;

  async #synchronizeSources(
    sources: readonly LifecycleSource[],
    sourceHeads: LifecycleSourceHeads,
  ): Promise<boolean> {
    if (this.#unflushedSourceRecords >= SOURCE_PAGE_SIZE) {
      await this.#index.flush({ compact: false });
      this.#unflushedSourceRecords = 0;
    }
    let hasMore = false;
    for (const source of sources) {
      const sourceHead = sourceHeads[source.id];
      if (!sourceHead || sourceHead.logId !== source.id) {
        throw new Error("Artifact lifecycle source head is invalid");
      }
      for (
        let pageIndex = 0;
        pageIndex < MAX_SYNCHRONIZATION_TURNS;
        pageIndex += 1
      ) {
        // 先记底，再读覆盖位置：本页的决定与发布的位置都据同一个底。
        const buffer = this.#buffer();
        const checkpoints = this.#index.checkpoints();
        const checkpoint = checkpoints[source.id] ?? source.origin;
        if (checkpoint.lsn >= sourceHead.lsn) {
          // 同一位置前缀不同，或覆盖位置超出源日志的实际 head：源已被整段替换（如迁居装入新前缀）。
          // 按派生损坏整段重建，不能当成已追平跳过——否则尾部准入会一直要求追平而追不动。另一步骤
          // 已把索引推进到冻结源头之后则属正常，跳过即可。
          if (
            checkpoint.lsn === sourceHead.lsn
              ? !sameCheckpoint(checkpoint, sourceHead)
              : checkpoint.lsn > (await source.log.checkpoint()).lsn
          ) {
            throw invalidLifecycleProjection(
              "Artifact lifecycle checkpoint is not on its source log",
            );
          }
          break;
        }
        const remaining = sourceHead.lsn - checkpoint.lsn;
        const page = await source.log.readTail<JsonValue>(
          checkpoint,
          Math.min(SOURCE_PAGE_SIZE, remaining),
          (operation) =>
            this.#runLifecycleStep(
              {
                step: "source-tail",
                source: source.id,
                checkpoint,
              },
              operation,
            ),
        );
        if (page.commits.length === 0) {
          throw new Error(
            "Artifact lifecycle source ended before its frozen head",
          );
        }
        for (const envelope of page.commits) {
          await this.#applyEnvelope(source.id, envelope, buffer);
        }
        // Pure authority replay is reconstructible. Coalesce a short suffix
        // in the bounded overlay, but checkpoint at least each source page so
        // a crash never turns this optimization into an unbounded replay.
        try {
          await this.#commit(buffer, {
            ...checkpoints,
            [source.id]: page.checkpoint,
          }, false, page.commits.length);
        } catch (error) {
          // 换底：本页（连同此前未落盘的页）没有留下，下一轮从当前实际覆盖位置重读。
          if (!(error instanceof LifecycleBaseReplaced)) throw error;
        }
        // 完成与否看提交后实际有效的覆盖位置，不看本页曾算到的位置。
        const covered = this.#index.checkpoints()[source.id] ?? source.origin;
        if (covered.lsn >= sourceHead.lsn) break;
        if (pageIndex === MAX_SYNCHRONIZATION_TURNS - 1) {
          hasMore = true;
        }
      }
    }
    return hasMore;
  }

  async #captureSourceHeads(
    sources: readonly LifecycleSource[],
  ): Promise<LifecycleSourceHeads> {
    const entries: Array<readonly [string, DurableLogCheckpoint]> = [];
    for (const source of sources) {
      // Reuse the log's own verified read view when it has not changed. A new
      // prefix still takes the normal physical verification and tail path;
      // deletion fences deliberately obtain a fresh checkpoint separately.
      const checkpoint = await source.log.checkpoint(this.#sourceHeads.get(source.id));
      if (checkpoint.logId !== source.id) {
        throw new Error("Artifact lifecycle source identity changed");
      }
      this.#sourceHeads.set(source.id, checkpoint);
      entries.push([source.id, checkpoint]);
    }
    return Object.fromEntries(entries);
  }

  async #applyEnvelope(
    logId: string,
    envelope: CommitEnvelope<JsonValue>,
    buffer: MutationBuffer,
  ): Promise<void> {
    buffer.put(
      META_TIME_KEY,
      latestTime(
        optionalTime(await buffer.get(META_TIME_KEY)),
        envelope.at,
      ),
    );
    for (let entryIndex = 0; entryIndex < envelope.entries.length; entryIndex += 1) {
      const entry = envelope.entries[entryIndex] as LogicalRecord<unknown>;
      if (entry.stream === "control") {
        const record = entry.body as ControlRecord;
        if (record.t === "asset-grant-issued") {
          await this.#recordGrant(record.grant, buffer);
        } else if (record.t === "asset-grant-revoked") {
          await this.#deactivateGrant(record.grantId, buffer);
        } else if (record.t === "authority-time-frontier") {
          buffer.put(
            META_TIME_KEY,
            latestTime(
              optionalTime(await buffer.get(META_TIME_KEY)),
              record.frontier,
            ),
          );
        }
      }
      const factId = lifecycleFactId(logId, envelope.lsn, entryIndex);
      const deadOwner = deletedConversationOf(entry);
      if (deadOwner !== undefined) {
        await this.#recordDeadOwner(
          { owner: deadOwner, factId, at: envelope.at },
          buffer,
        );
      }
      const classified = classifyRetainedRecordReferences(entry);
      for (const ref of classified.unconditional) {
        await this.#recordUnconditional(ref, factId, buffer);
      }
      for (const leaf of classified.conversationLeaves) {
        await this.#recordOwnership(
          leaf.ref,
          leaf.conversationId,
          factId,
          buffer,
        );
      }
      for (const root of collectRegisteredArtifactRoots([entry])) {
        const resolved = classifyRegisteredArtifactReferences(
          root,
          await this.#artifacts.get(root.ref),
        );
        for (const ref of resolved.unconditional) {
          await this.#recordUnconditional(ref, factId, buffer);
        }
        for (const leaf of resolved.conversationLeaves) {
          await this.#recordOwnership(
            leaf.ref,
            leaf.conversationId,
            factId,
            buffer,
          );
        }
      }
    }
  }

  async #recordGrant(
    input: SurfaceAssetGrant,
    buffer: MutationBuffer,
  ): Promise<void> {
    const grant = surfaceGrant(asJson(input));
    const historyKey = grantHistoryKey(grant.grantId);
    const historical = await buffer.get(historyKey);
    if (historical !== undefined) {
      const historicalGrant = boundSurfaceGrant(
        historical,
        historyKey,
        (stored) => grantHistoryKey(stored.grantId),
      );
      if (canonicalize(historicalGrant) !== canonicalize(grant)) {
        throw invalidLifecycleProjection(
          "Surface grant id has conflicting durable payloads",
        );
      }
      return;
    }
    buffer.put(historyKey, asJson(grant));
    const activeKey = activeGrantKey(grant.grantId);
    const expiryKey = expiryGrantKey(grant);
    const surfaceKey = surfaceGrantKey(
      grant.surfacePrincipal,
      grant.grantId,
    );
    buffer.put(activeKey, indexedGrantValue(activeKey, grant.grantId));
    buffer.put(expiryKey, indexedGrantValue(expiryKey, grant.grantId));
    buffer.put(surfaceKey, indexedGrantValue(surfaceKey, grant.grantId));
    if (grant.scope.domain === "conversation") {
      const conversationKey = conversationGrantKey(
        grant.scope.conversationId,
        grant.grantId,
      );
      buffer.put(
        conversationKey,
        indexedGrantValue(conversationKey, grant.grantId),
      );
    }
    for (const ref of grant.assets) {
      const state = await this.#state(ref.digest, buffer);
      if (state) {
        assertCompatibleReference(state.ref, ref);
      } else {
        buffer.put(stateKey(ref.digest), asJson(emptyDigestState(ref)));
      }
    }
    if (grant.kind !== "asset-upload") return;
    const scopeIdentity = surfaceScopeKey(grant.scope);
    for (const ref of grant.assets) {
      const uploadKey = uploadGrantKey(ref.digest, grant.grantId);
      buffer.put(
        uploadKey,
        indexedGrantValue(uploadKey, grant.grantId),
      );
      const summaryValue = await buffer.get(uploadSummaryKey(ref.digest));
      const summary = summaryValue === undefined
        ? undefined
        : uploadSummary(summaryValue);
      if (summary) {
        assertCompatibleReference(summary.ref, ref);
        assertProjectionKey(
          uploadSummaryKey(summary.ref.digest),
          uploadSummaryKey(ref.digest),
          "Upload summary",
        );
      }
      buffer.put(
        uploadSummaryKey(ref.digest),
        asJson({
          ref,
          latestExpiry: latestTime(summary?.latestExpiry, grant.expiry),
        }),
      );
      buffer.put(
        uploadScopeKey(ref.digest, scopeIdentity),
        asJson({
          key: uploadScopeKey(ref.digest, scopeIdentity),
          ref,
          scopeIdentity,
        } satisfies ScopeReference),
      );
      const state = await this.#state(ref.digest, buffer);
      if (!state || !isRetained(state)) {
        await this.#addReservation(grant, ref, buffer);
      }
    }
  }

  async #deactivateGrant(
    grantId: string,
    buffer: MutationBuffer,
  ): Promise<void> {
    const value = await buffer.get(activeGrantKey(grantId));
    if (value === undefined) return;
    const grant = await this.#indexedGrant(
      value,
      activeGrantKey(grantId),
      (stored) => activeGrantKey(stored.grantId),
      buffer,
    );
    buffer.tombstone(activeGrantKey(grantId));
    buffer.tombstone(expiryGrantKey(grant));
    buffer.tombstone(surfaceGrantKey(grant.surfacePrincipal, grantId));
    if (grant.scope.domain === "conversation") {
      buffer.tombstone(
        conversationGrantKey(grant.scope.conversationId, grantId),
      );
    }
    if (grant.kind !== "asset-upload") return;
    for (const ref of grant.assets) {
      buffer.tombstone(uploadGrantKey(ref.digest, grantId));
      await this.#removeReservation(grant, ref, buffer);
    }
  }

  async #addReservation(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    buffer: MutationBuffer,
  ): Promise<void> {
    const member = reservationMemberKey(grant.grantId, ref.digest);
    const existingMember = await buffer.get(member);
    if (existingMember !== undefined) {
      projectionMarker(existingMember, member, "Reservation member");
      return;
    }
    buffer.put(member, asJson({ key: member } satisfies ProjectionMarker));
    const scopeIdentity = surfaceScopeKey(grant.scope);
    const accounting = await this.#accountingMembership(
      ref,
      scopeIdentity,
      buffer,
    );
    await this.#incrementReservation(
      reservationScopeKey(scopeIdentity, ref.digest),
      quotaScopeKey(scopeIdentity),
      ref,
      accounting.scopePhysical,
      buffer,
    );
    await this.#incrementReservation(
      reservationDeviceKey(ref.digest),
      QUOTA_DEVICE_KEY,
      ref,
      accounting.devicePhysical,
      buffer,
    );
  }

  async #removeReservation(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    buffer: MutationBuffer,
  ): Promise<void> {
    const member = reservationMemberKey(grant.grantId, ref.digest);
    const existingMember = await buffer.get(member);
    if (existingMember === undefined) return;
    projectionMarker(existingMember, member, "Reservation member");
    buffer.tombstone(member);
    const scopeIdentity = surfaceScopeKey(grant.scope);
    const accounting = await this.#accountingMembership(
      ref,
      scopeIdentity,
      buffer,
    );
    await this.#decrementReservation(
      reservationScopeKey(scopeIdentity, ref.digest),
      quotaScopeKey(scopeIdentity),
      ref,
      accounting.scopePhysical,
      buffer,
    );
    await this.#decrementReservation(
      reservationDeviceKey(ref.digest),
      QUOTA_DEVICE_KEY,
      ref,
      accounting.devicePhysical,
      buffer,
    );
  }

  async #accountingMembership(
    ref: ArtifactRef,
    scopeIdentity: string,
    reader: Pick<DurableProjectionReadContext | MutationBuffer, "get">,
  ): Promise<{
    readonly scopeCounted: boolean;
    readonly deviceCounted: boolean;
    readonly scopePhysical: boolean;
    readonly devicePhysical: boolean;
  }> {
    const scopeReservationKey = reservationScopeKey(
      scopeIdentity,
      ref.digest,
    );
    const deviceReservationKey = reservationDeviceKey(ref.digest);
    const temporaryScopeIdentityKey = temporaryScopeKey(
      ref.digest,
      scopeIdentity,
    );
    const temporaryStateIdentityKey = temporaryStateKey(ref.digest);
    // These reads share a zero-wait physical admission policy under the
    // lifecycle queue. Fan-out would repeatedly compete with itself on a
    // single-slot device; finish each bounded read before admitting the next.
    const scopeReservation = await reader.get(scopeReservationKey);
    const deviceReservation = await reader.get(deviceReservationKey);
    const temporaryScope = await reader.get(temporaryScopeIdentityKey);
    const temporary = await reader.get(temporaryStateIdentityKey);
    if (scopeReservation !== undefined) {
      countedReference(scopeReservation, scopeReservationKey);
    }
    if (deviceReservation !== undefined) {
      countedReference(deviceReservation, deviceReservationKey);
    }
    if (temporaryScope !== undefined) {
      scopeReference(
        temporaryScope,
        temporaryScopeIdentityKey,
        temporaryScopeKey,
      );
    }
    if (temporary !== undefined) {
      const state = temporaryState(temporary);
      assertProjectionKey(
        temporaryStateKey(state.ref.digest),
        temporaryStateIdentityKey,
        "Temporary state",
      );
    }
    const scopePhysical = temporaryScope !== undefined;
    const devicePhysical = temporary !== undefined;
    return {
      scopeCounted: scopeReservation !== undefined || scopePhysical,
      deviceCounted: deviceReservation !== undefined || devicePhysical,
      scopePhysical,
      devicePhysical,
    };
  }

  async #incrementReservation(
    key: string,
    quotaKey: string,
    ref: ArtifactRef,
    occupiedByPhysical: boolean,
    buffer: MutationBuffer,
  ): Promise<void> {
    const currentValue = await buffer.get(key);
    const current = currentValue === undefined
      ? undefined
      : countedReference(currentValue, key);
    if (current) assertCompatibleReference(current.ref, ref);
    buffer.put(
      key,
      countedReferenceValue(key, ref, (current?.count ?? 0) + 1),
    );
    if (!current && !occupiedByPhysical) {
      buffer.put(
        quotaKey,
        quotaProjectionValue(
          quotaKey,
          quotaValue(await buffer.get(quotaKey), quotaKey) + ref.bytes,
        ),
      );
    }
  }

  async #decrementReservation(
    key: string,
    quotaKey: string,
    ref: ArtifactRef,
    occupiedByPhysical: boolean,
    buffer: MutationBuffer,
  ): Promise<void> {
    const currentValue = await buffer.get(key);
    if (currentValue === undefined) {
      throw invalidLifecycleProjection(
        "Surface asset reservation index is corrupt",
      );
    }
    const current = countedReference(currentValue, key);
    assertCompatibleReference(current.ref, ref);
    if (current.count > 1) {
      buffer.put(key, countedReferenceValue(key, ref, current.count - 1));
      return;
    }
    buffer.tombstone(key);
    if (!occupiedByPhysical) {
      const quota = quotaValue(await buffer.get(quotaKey), quotaKey);
      if (quota < ref.bytes) {
        throw invalidLifecycleProjection(
          "Surface asset quota index is corrupt",
        );
      }
      buffer.put(
        quotaKey,
        quotaProjectionValue(quotaKey, quota - ref.bytes),
      );
    }
  }

  async #recordTemporary(
    ref: ArtifactRef,
    scopeIdentity: string,
    buffer: MutationBuffer,
  ): Promise<void> {
    const summary = await this.#assertUploadScope(ref, scopeIdentity, buffer);
    const lifecycle = await this.#state(ref.digest, buffer);
    if (lifecycle && isRetained(lifecycle)) {
      const cleanupKey = temporaryCleanupKey(ref.digest);
      buffer.put(
        cleanupKey,
        indexedDigestValue(cleanupKey, ref.digest),
      );
      return;
    }

    const stateValue = await buffer.get(temporaryStateKey(ref.digest));
    const state = stateValue === undefined
      ? undefined
      : temporaryState(stateValue);
    if (state) {
      assertCompatibleReference(state.ref, ref);
      assertProjectionKey(
        temporaryStateKey(state.ref.digest),
        temporaryStateKey(ref.digest),
        "Temporary state",
      );
    }
    const latestExpiry = latestTime(state?.latestExpiry, summary.latestExpiry);
    if (state && state.latestExpiry !== latestExpiry) {
      buffer.tombstone(temporaryDueKey({
        ref: state.ref,
        eligibleAt: state.latestExpiry,
      }));
    }
    buffer.put(
      temporaryStateKey(ref.digest),
      asJson({ ref, latestExpiry }),
    );
    const dueKey = temporaryDueKey({ ref, eligibleAt: latestExpiry });
    buffer.put(dueKey, indexedDigestValue(dueKey, ref.digest));

    const scopeKey = temporaryScopeKey(ref.digest, scopeIdentity);
    const existingScope = await buffer.get(scopeKey);
    if (existingScope === undefined) {
      buffer.put(
        scopeKey,
        asJson({ key: scopeKey, ref, scopeIdentity } satisfies ScopeReference),
      );
      if (
        (await buffer.get(reservationScopeKey(scopeIdentity, ref.digest))) ===
          undefined
      ) {
        buffer.put(
          quotaScopeKey(scopeIdentity),
          quotaProjectionValue(
            quotaScopeKey(scopeIdentity),
            quotaValue(
              await buffer.get(quotaScopeKey(scopeIdentity)),
              quotaScopeKey(scopeIdentity),
            ) + ref.bytes,
          ),
        );
      }
    }
    if (
      state === undefined &&
      (await buffer.get(reservationDeviceKey(ref.digest))) === undefined
    ) {
      buffer.put(
        QUOTA_DEVICE_KEY,
        quotaProjectionValue(
          QUOTA_DEVICE_KEY,
          quotaValue(await buffer.get(QUOTA_DEVICE_KEY), QUOTA_DEVICE_KEY) +
            ref.bytes,
        ),
      );
    }
  }

  async #assertUploadScope(
    ref: ArtifactRef,
    scopeIdentity: string,
    buffer: MutationBuffer,
  ): Promise<UploadSummary> {
    const summaryValue = await buffer.get(uploadSummaryKey(ref.digest));
    if (summaryValue === undefined) {
      throw new Error("Temporary surface asset has no durable upload grant");
    }
    const summary = uploadSummary(summaryValue);
    assertCompatibleReference(summary.ref, ref);
    assertProjectionKey(
      uploadSummaryKey(summary.ref.digest),
      uploadSummaryKey(ref.digest),
      "Upload summary",
    );
    const scopeKey = uploadScopeKey(ref.digest, scopeIdentity);
    const scopeValue = await buffer.get(scopeKey);
    if (scopeValue === undefined) {
      throw new Error("Temporary surface asset scope has no durable upload grant");
    }
    scopeReference(scopeValue, scopeKey, uploadScopeKey);
    return summary;
  }

  async #removeTemporaryScope(
    ref: ArtifactRef,
    scopeIdentity: string,
    buffer: MutationBuffer,
  ): Promise<void> {
    const key = temporaryScopeKey(ref.digest, scopeIdentity);
    const existing = await buffer.get(key);
    if (existing === undefined) return;
    scopeReference(existing, key, temporaryScopeKey);
    buffer.tombstone(key);
    if (
      (await buffer.get(reservationScopeKey(scopeIdentity, ref.digest))) ===
        undefined
    ) {
      const quotaKey = quotaScopeKey(scopeIdentity);
      const quota = quotaValue(await buffer.get(quotaKey), quotaKey);
      if (quota < ref.bytes) {
        throw invalidLifecycleProjection(
          "Surface asset quota index is corrupt",
        );
      }
      buffer.put(
        quotaKey,
        quotaProjectionValue(quotaKey, quota - ref.bytes),
      );
    }
  }

  async #finishTemporaryRemoval(
    ref: ArtifactRef,
    buffer: MutationBuffer,
    preserveCleanup = false,
  ): Promise<void> {
    const value = await buffer.get(temporaryStateKey(ref.digest));
    if (value !== undefined) {
      const state = temporaryState(value);
      assertProjectionKey(
        temporaryStateKey(state.ref.digest),
        temporaryStateKey(ref.digest),
        "Temporary state",
      );
      assertCompatibleReference(state.ref, ref);
      buffer.tombstone(temporaryStateKey(ref.digest));
      buffer.tombstone(temporaryDueKey({
        ref: state.ref,
        eligibleAt: state.latestExpiry,
      }));
      if ((await buffer.get(reservationDeviceKey(ref.digest))) === undefined) {
        const quota = quotaValue(
          await buffer.get(QUOTA_DEVICE_KEY),
          QUOTA_DEVICE_KEY,
        );
        if (quota < ref.bytes) {
          throw invalidLifecycleProjection(
            "Surface asset quota index is corrupt",
          );
        }
        buffer.put(
          QUOTA_DEVICE_KEY,
          quotaProjectionValue(QUOTA_DEVICE_KEY, quota - ref.bytes),
        );
      }
    }
    if (preserveCleanup) {
      const cleanupKey = temporaryCleanupKey(ref.digest);
      buffer.put(
        cleanupKey,
        indexedDigestValue(cleanupKey, ref.digest),
      );
    } else {
      buffer.tombstone(temporaryCleanupKey(ref.digest));
    }
  }

  async #recordUnconditional(
    ref: ArtifactRef,
    factId: Digest,
    buffer: MutationBuffer,
  ): Promise<void> {
    const fact = factKey("unconditional", ref.digest, factId);
    const existing = await buffer.get(fact);
    if (existing !== undefined) {
      projectionMarker(existing, fact, "Unconditional retention fact");
      return;
    }
    const state = await this.#state(ref.digest, buffer) ??
      emptyDigestState(ref);
    assertCompatibleReference(state.ref, ref);
    buffer.put(fact, asJson({ key: fact } satisfies ProjectionMarker));
    const next = {
      ...state,
      unconditionalFacts: state.unconditionalFacts + 1,
    };
    await this.#publishReleaseState(state, next, buffer);
  }

  async #recordOwnership(
    ref: ArtifactRef,
    owner: string,
    factId: Digest,
    buffer: MutationBuffer,
  ): Promise<void> {
    const fact = factKey("ownership", ref.digest, factId);
    const existingFact = await buffer.get(fact);
    if (existingFact !== undefined) {
      projectionMarker(existingFact, fact, "Artifact ownership fact");
      return;
    }
    const state = await this.#state(ref.digest, buffer) ??
      emptyDigestState(ref);
    assertCompatibleReference(state.ref, ref);
    const ownershipFactsRoot = await addFactToMerkleSet(
      buffer,
      "ownership",
      ref.digest,
      factId,
    );
    const membership = ownerKey(owner, ref.digest);
    const existingMembership = await buffer.get(membership);
    const dead = await this.#deadOwner(owner, buffer);
    let next: LifecycleDigestState = { ...state, ownershipFactsRoot };
    if (existingMembership === undefined) {
      if (dead) {
        next = await this.#retireState(next, dead, false, buffer);
      } else {
        next = { ...next, liveOwners: next.liveOwners + 1 };
        buffer.put(membership, { owner, digest: ref.digest });
      }
    }
    await this.#publishReleaseState(state, next, buffer);
  }

  async #recordDeadOwner(
    dead: DeadOwner,
    buffer: MutationBuffer,
  ): Promise<void> {
    const key = deadKey(dead.owner);
    const existing = await buffer.get(key);
    if (existing !== undefined) {
      deadOwner(existing, key);
      return;
    }
    buffer.put(key, asJson(dead));
    const pending = pendingKey(dead.owner);
    buffer.put(
      pending,
      asJson({ key: pending, owner: dead.owner } satisfies PendingOwner),
    );
  }

  async #drainRetirementJobs(): Promise<boolean> {
    const pending = await this.#records.scan(
      { gte: PENDING_PREFIX, lt: `${PENDING_PREFIX}\uffff` },
      PENDING_JOB_PAGE_SIZE,
    );
    if (pending.entries.length === 0) return false;
    for (const entry of pending.entries) {
      const pendingOwner = indexedPendingOwner(entry.value, entry.key);
      const deadValue = await this.#records.get(deadKey(pendingOwner.owner));
      if (deadValue === undefined) {
        throw invalidLifecycleProjection(
          "Retirement job has no canonical dead-owner record",
        );
      }
      const dead = deadOwner(deadValue, deadKey(pendingOwner.owner));
      const prefix = ownerPrefix(dead.owner);
      const owners = await this.#records.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        RETIREMENT_PAGE_SIZE,
      );
      const buffer = this.#buffer();
      for (const ownerEntry of owners.entries) {
        const owned = ownerDigest(ownerEntry.value, ownerEntry.key);
        const state = await this.#state(owned.digest, buffer);
        if (!state) {
          throw invalidLifecycleProjection(
            "Artifact lifecycle owner index is corrupt",
          );
        }
        const next = await this.#retireState(state, dead, true, buffer);
        buffer.tombstone(ownerEntry.key);
        await this.#publishReleaseState(state, next, buffer);
      }
      if (owners.entries.length < RETIREMENT_PAGE_SIZE) {
        buffer.tombstone(entry.key);
      }
      // 退休任务同样由源回放派生、只改写索引内记账：合入有界覆盖层按页落盘。
      await this.#commit(buffer, this.#index.checkpoints(), false, 1);
    }
    return (await this.#records.scan(
      { gte: PENDING_PREFIX, lt: `${PENDING_PREFIX}\uffff` },
      1,
    )).entries.length > 0;
  }

  async #drainAdoptionJobs(): Promise<boolean> {
    const pending = await this.#records.scan(
      { gte: ADOPTION_JOB_PREFIX, lt: `${ADOPTION_JOB_PREFIX}\uffff` },
      PENDING_JOB_PAGE_SIZE,
    );
    if (pending.entries.length === 0) return false;
    for (const entry of pending.entries) {
      const job = adoptionJob(entry.value, entry.key);
      const buffer = this.#buffer();
      const lifecycle = await this.#state(job.digest, buffer);
      if (!lifecycle || isRetained(lifecycle) !== job.adopted) {
        throw invalidLifecycleProjection(
          "Artifact adoption job disagrees with canonical lifecycle state",
        );
      }
      if ((job.phase ?? "grants") === "grants") {
        const prefix = uploadGrantPrefix(job.digest);
        assertPageCursor(job.after, prefix, "Surface upload grant");
        const page = await this.#records.scan(
          {
            ...(job.after ? { gt: job.after } : { gte: prefix }),
            lt: `${prefix}\uffff`,
          },
          RETIREMENT_PAGE_SIZE,
        );
        for (const active of page.entries) {
          const grant = await this.#indexedGrant(
            active.value,
            active.key,
            (stored) =>
              stored.kind === "asset-upload" &&
                stored.assets.some(({ digest }) => digest === job.digest)
                ? uploadGrantKey(job.digest, stored.grantId)
                : undefined,
            buffer,
          );
          const ref = grant.assets.find(({ digest }) => digest === job.digest);
          if (!ref || grant.kind !== "asset-upload") {
            throw invalidLifecycleProjection(
              "Surface upload grant index is corrupt",
            );
          }
          if (job.adopted) {
            await this.#removeReservation(grant, ref, buffer);
          } else {
            await this.#addReservation(grant, ref, buffer);
          }
        }
        const lastKey = page.entries.at(-1)?.key;
        if (page.entries.length >= RETIREMENT_PAGE_SIZE && lastKey) {
          buffer.put(entry.key, asJson({ ...job, after: lastKey }));
        } else if (
          (await buffer.get(temporaryStateKey(job.digest))) !== undefined
        ) {
          buffer.put(
            entry.key,
            asJson({
              key: entry.key,
              digest: job.digest,
              adopted: job.adopted,
              phase: "temporary",
            }),
          );
        } else {
          buffer.tombstone(entry.key);
        }
      } else {
        const stateValue = await buffer.get(temporaryStateKey(job.digest));
        if (stateValue === undefined) {
          buffer.tombstone(entry.key);
        } else {
          const state = temporaryState(stateValue);
          assertProjectionKey(
            temporaryStateKey(state.ref.digest),
            temporaryStateKey(job.digest),
            "Temporary state",
          );
          const prefix = temporaryScopePrefix(job.digest);
          assertPageCursor(job.after, prefix, "Temporary surface asset scope");
          const page = await this.#records.scan(
            {
              ...(job.after ? { gt: job.after } : { gte: prefix }),
              lt: `${prefix}\uffff`,
            },
            RETIREMENT_PAGE_SIZE,
          );
          for (const scope of page.entries) {
            await this.#removeTemporaryScope(
              state.ref,
              scopeReference(
                scope.value,
                scope.key,
                temporaryScopeKey,
              ).scopeIdentity,
              buffer,
            );
          }
          const lastKey = page.entries.at(-1)?.key;
          if (page.entries.length >= RETIREMENT_PAGE_SIZE && lastKey) {
            buffer.put(entry.key, asJson({ ...job, after: lastKey }));
          } else {
            await this.#finishTemporaryRemoval(state.ref, buffer, true);
            buffer.tombstone(entry.key);
          }
        }
      }
      // 领用任务由源回放派生、只改写索引内记账，崩溃后可从耐久检查点重放重建：
      // 与源回放一样合入有界覆盖层按页落盘，不逐任务刷盘，更不逐五个任务做一次整轮合并。
      await this.#commit(buffer, this.#index.checkpoints(), false, 1);
    }
    return (await this.#records.scan(
      {
        gte: ADOPTION_JOB_PREFIX,
        lt: `${ADOPTION_JOB_PREFIX}\uffff`,
      },
      1,
    )).entries.length > 0;
  }

  async #retireExpiredGrants(): Promise<boolean> {
    const effectiveTime = optionalTime(await this.#records.get(META_TIME_KEY));
    if (!effectiveTime) return false;
    const expired = await this.#records.scan(
      {
        gte: EXPIRY_GRANT_PREFIX,
        lt: `${EXPIRY_GRANT_PREFIX}${effectiveTime}\uffff`,
      },
      RETIREMENT_PAGE_SIZE,
    );
    if (expired.entries.length === 0) return false;
    const buffer = this.#buffer();
    for (const entry of expired.entries) {
      const grant = await this.#indexedGrant(
        entry.value,
        entry.key,
        expiryGrantKey,
        buffer,
      );
      if (Date.parse(grant.expiry) > Date.parse(effectiveTime)) {
        throw invalidLifecycleProjection(
          "Surface grant expiry index is corrupt",
        );
      }
      await this.#deactivateGrant(grant.grantId, buffer);
    }
    await this.#commit(buffer, this.#index.checkpoints());
    return (await this.#records.scan(
      {
        gte: EXPIRY_GRANT_PREFIX,
        lt: `${EXPIRY_GRANT_PREFIX}${effectiveTime}\uffff`,
      },
      1,
    )).entries.length > 0;
  }

  async #retireState(
    state: LifecycleDigestState,
    dead: DeadOwner,
    decrementLiveOwner: boolean,
    buffer: MutationBuffer,
  ): Promise<LifecycleDigestState> {
    const retirementFactsRoot = await addFactToMerkleSet(
      buffer,
      "retirement",
      state.ref.digest,
      dead.factId,
    );
    return {
      ...state,
      liveOwners: decrementLiveOwner
        ? Math.max(0, state.liveOwners - 1)
        : state.liveOwners,
      retirementFactsRoot,
      latestRetirementAt: latestTime(state.latestRetirementAt, dead.at),
    };
  }

  async #publishReleaseState(
    previous: LifecycleDigestState,
    candidate: LifecycleDigestState,
    buffer: MutationBuffer,
  ): Promise<void> {
    const wasRetained = isRetained(previous);
    const willBeRetained = isRetained(candidate);
    if (wasRetained !== willBeRetained) {
      const jobKey = adoptionJobKey(candidate.ref.digest);
      buffer.put(
        jobKey,
        asJson({
          key: jobKey,
          digest: candidate.ref.digest,
          adopted: willBeRetained,
        } satisfies AdoptionJob),
      );
    }
    if (previous.releaseId && previous.releasedAt) {
      buffer.tombstone(releaseKey({
        ref: previous.ref,
        releasedAt: previous.releasedAt,
        releaseId: previous.releaseId,
      }));
    }
    let next = candidate;
    if (
      candidate.liveOwners === 0 &&
      candidate.unconditionalFacts === 0 &&
      candidate.latestRetirementAt
    ) {
      const releasedAt = candidate.latestRetirementAt;
      const releaseId = protocolDigest("ArtifactRelease", 1, {
        ref: candidate.ref,
        ownershipFactsRoot: candidate.ownershipFactsRoot,
        retirementFactsRoot: candidate.retirementFactsRoot,
        releasedAt,
      });
      next = { ...candidate, releasedAt, releaseId };
      if (candidate.reclaimedReleaseId !== releaseId) {
        const release = { ref: candidate.ref, releasedAt, releaseId };
        const key = releaseKey(release);
        buffer.put(
          key,
          indexedDigestValue(key, candidate.ref.digest),
        );
      }
    } else {
      const {
        releasedAt: _releasedAt,
        releaseId: _releaseId,
        ...withoutRelease
      } = candidate;
      next = withoutRelease;
    }
    buffer.put(stateKey(candidate.ref.digest), asJson(next));
  }

  async #state(
    digest: Digest,
    buffer?: MutationBuffer,
  ): Promise<LifecycleDigestState | undefined> {
    const value = buffer
      ? await buffer.get(stateKey(digest))
      : await this.#records.get(stateKey(digest));
    if (value === undefined) return undefined;
    const state = lifecycleState(value);
    assertProjectionKey(
      stateKey(state.ref.digest),
      stateKey(digest),
      "Artifact lifecycle state",
    );
    return state;
  }

  async #deadOwner(
    owner: string,
    buffer: MutationBuffer,
  ): Promise<DeadOwner | undefined> {
    const value = await buffer.get(deadKey(owner));
    return value === undefined ? undefined : deadOwner(value, deadKey(owner));
  }

  /** 记下创建时的采纳计数：缓冲区里的决定都据这个底算出。 */
  #buffer(): MutationBuffer {
    return new MutationBuffer(this.#records, this.#index.adoptionCount());
  }

  /**
   * 正常返回即保证本次增量留在当前底上。准备或落盘时都可能先读盘、采纳他方发布的更新一代：
   * 准备时换了底，据旧底算出的增量不能发布；落盘时换了底，已发布的增量随覆盖层一起被丢弃。
   * 两种情况都抛 {@link LifecycleBaseReplaced}，由调用方从当前状态重做。
   */
  async #commit(
    buffer: MutationBuffer,
    checkpoints: DurableProjectionCheckpoints,
    compact = false,
    replayedSourceRecords = 0,
  ): Promise<void> {
    if (buffer.size === 0) return;
    const prepared = await this.#index.prepare(
      bindDurableProjectionMutations(buffer.mutations()),
    );
    // 自缓冲区创建（决定读取）到准备完成之间任何一次采纳，都使增量失去它的底。
    this.#assertBase(buffer);
    this.#index.publish(prepared, checkpoints);
    this.#unflushedSourceRecords += replayedSourceRecords;
    if (replayedSourceRecords > 0 && this.#unflushedSourceRecords < SOURCE_PAGE_SIZE) return;
    await this.#index.flush({ compact });
    this.#unflushedSourceRecords = 0;
    this.#assertBase(buffer);
  }

  #assertBase(buffer: MutationBuffer): void {
    if (buffer.base !== this.#index.adoptionCount()) throw new LifecycleBaseReplaced();
  }
}

/** 决定所依据的底已被采纳的他方新一代替换：增量没有留在当前底上，调用方从当前状态重做。 */
class LifecycleBaseReplaced extends Error {
  constructor() {
    super("Artifact lifecycle base was replaced by an adopted peer publication");
    this.name = "LifecycleBaseReplaced";
  }
}

class MutationBuffer {
  readonly #mutations = new Map<string, MutationValue>();

  constructor(
    private readonly index: DurableProjectionReadContext,
    /** 创建时的采纳计数。 */
    readonly base: number,
  ) {}

  get size(): number {
    return this.#mutations.size;
  }

  async get(key: string): Promise<JsonValue | undefined> {
    const mutation = this.#mutations.get(key);
    if (mutation) return mutation.kind === "tombstone" ? undefined : mutation.value;
    return this.index.get(key);
  }

  put(key: string, value: JsonValue): void {
    this.#mutations.set(key, { kind: "put", value });
  }

  tombstone(key: string): void {
    this.#mutations.set(key, { kind: "tombstone" });
  }

  mutations(): readonly DurableProjectionMutation[] {
    return [...this.#mutations].map(([key, mutation]) =>
      mutation.kind === "put"
        ? { kind: "put", key, value: mutation.value as JsonValue }
        : { kind: "tombstone", key }
    );
  }
}

async function addFactToMerkleSet(
  buffer: MutationBuffer,
  kind: "ownership" | "retirement",
  digest: Digest,
  factId: Digest,
): Promise<Digest> {
  const marker = factKey(kind, digest, factId);
  const existing = await buffer.get(marker);
  const rootKey = merkleNodeKey(kind, digest, 0, "");
  if (existing !== undefined) {
    projectionMarker(existing, marker, "Artifact lifecycle fact");
    const root = await buffer.get(rootKey);
    return root === undefined
      ? EMPTY_FACT_ROOTS[0]!
      : merkleNodeValue(root, rootKey);
  }
  buffer.put(marker, asJson({ key: marker } satisfies ProjectionMarker));
  const bits = digestBits(factId);
  let child = protocolDigest("ArtifactFactSetLeaf", 1, { factId });
  const leafKey = merkleNodeKey(kind, digest, 256, bits);
  buffer.put(
    leafKey,
    asJson({ key: leafKey, digest: child } satisfies MerkleNodeValue),
  );
  for (let depth = 255; depth >= 0; depth -= 1) {
    const prefix = bits.slice(0, depth);
    const bit = bits[depth]!;
    const siblingPrefix = `${prefix}${bit === "0" ? "1" : "0"}`;
    const siblingValue = await buffer.get(
      merkleNodeKey(kind, digest, depth + 1, siblingPrefix),
    );
    const siblingKey = merkleNodeKey(
      kind,
      digest,
      depth + 1,
      siblingPrefix,
    );
    const sibling =
      siblingValue !== undefined
        ? merkleNodeValue(siblingValue, siblingKey)
        : EMPTY_FACT_ROOTS[depth + 1]!;
    const left = bit === "0" ? child : sibling;
    const right = bit === "0" ? sibling : child;
    child = protocolDigest("ArtifactFactSetNode", 1, {
      depth,
      left,
      right,
    });
    const nodeKey = merkleNodeKey(kind, digest, depth, prefix);
    buffer.put(
      nodeKey,
      asJson({ key: nodeKey, digest: child } satisfies MerkleNodeValue),
    );
  }
  return child;
}

function createEmptyFactRoots(): readonly Digest[] {
  const roots = Array<Digest>(257);
  roots[256] = protocolDigest("ArtifactFactSetEmpty", 1, { depth: 256 });
  for (let depth = 255; depth >= 0; depth -= 1) {
    roots[depth] = protocolDigest("ArtifactFactSetNode", 1, {
      depth,
      left: roots[depth + 1],
      right: roots[depth + 1],
    });
  }
  return roots;
}

function lifecycleFactId(
  logId: string,
  lsn: number,
  entryIndex: number,
): Digest {
  return protocolDigest("ArtifactLifecycleFact", 1, {
    logId,
    lsn,
    entryIndex,
  });
}

function emptyDigestState(ref: ArtifactRef): LifecycleDigestState {
  return {
    ref,
    liveOwners: 0,
    unconditionalFacts: 0,
    ownershipFactsRoot: EMPTY_FACT_ROOTS[0]!,
    retirementFactsRoot: EMPTY_FACT_ROOTS[0]!,
  };
}

function lifecycleState(value: JsonValue): LifecycleDigestState {
  const record = plainRecord(value);
  const ref = artifactRef(record?.ref);
  const liveOwners = nonNegativeInteger(record?.liveOwners, "liveOwners");
  const unconditionalFacts = nonNegativeInteger(
    record?.unconditionalFacts,
    "unconditionalFacts",
  );
  const ownershipFactsRoot = digest(record?.ownershipFactsRoot);
  const retirementFactsRoot = digest(record?.retirementFactsRoot);
  const latestRetirementAt = optionalTime(record?.latestRetirementAt);
  const releasedAt = optionalTime(record?.releasedAt);
  const releaseId = optionalDigest(record?.releaseId);
  const reclaimedReleaseId = optionalDigest(record?.reclaimedReleaseId);
  if ((releasedAt === undefined) !== (releaseId === undefined)) {
    throw invalidLifecycleProjection(
      "Artifact lifecycle release state is incomplete",
    );
  }
  return {
    ref,
    liveOwners,
    unconditionalFacts,
    ownershipFactsRoot,
    retirementFactsRoot,
    ...(latestRetirementAt ? { latestRetirementAt } : {}),
    ...(releasedAt ? { releasedAt } : {}),
    ...(releaseId ? { releaseId } : {}),
    ...(reclaimedReleaseId ? { reclaimedReleaseId } : {}),
  };
}

function deadOwner(value: JsonValue, key: string): DeadOwner {
  const record = plainRecord(value);
  if (
    typeof record?.owner !== "string" ||
    typeof record.factId !== "string" ||
    typeof record.at !== "string"
  ) {
    throw invalidLifecycleProjection(
      "Artifact lifecycle dead-owner state is invalid",
    );
  }
  assertCanonicalTime(record.at, "Artifact retirement time");
  const dead = {
    owner: record.owner,
    factId: digest(record.factId),
    at: record.at,
  };
  if (deadKey(dead.owner) !== key) {
    throw invalidLifecycleProjection(
      "Artifact lifecycle dead-owner state is not bound to its key",
    );
  }
  return dead;
}

function ownerDigest(value: JsonValue, key: string): OwnerDigest {
  const record = plainRecord(value);
  if (typeof record?.owner !== "string" || record.owner.length === 0) {
    throw invalidLifecycleProjection(
      "Artifact lifecycle owner state is invalid",
    );
  }
  const owned = { owner: record.owner, digest: digest(record.digest) };
  assertProjectionKey(
    ownerKey(owned.owner, owned.digest),
    key,
    "Artifact lifecycle owner",
  );
  return owned;
}

function countedReference(
  value: JsonValue,
  key: string,
): CountedReference {
  const record = plainRecord(value);
  if (record?.key !== key) {
    throw invalidLifecycleProjection(
      "Artifact reservation is not bound to its key",
    );
  }
  return {
    key,
    ref: artifactRef(record?.ref),
    count: positiveInteger(record?.count, "reservation count"),
  };
}

function countedReferenceValue(
  key: string,
  ref: ArtifactRef,
  count: number,
): JsonValue {
  return asJson({ key, ref, count } satisfies CountedReference);
}

function uploadSummary(value: JsonValue): UploadSummary {
  const record = plainRecord(value);
  const latestExpiry = optionalTime(record?.latestExpiry);
  if (!latestExpiry) {
    throw invalidLifecycleProjection("Surface upload summary is invalid");
  }
  return {
    ref: artifactRef(record?.ref),
    latestExpiry,
  };
}

function temporaryState(value: JsonValue): TemporaryState {
  const record = plainRecord(value);
  const latestExpiry = optionalTime(record?.latestExpiry);
  if (!latestExpiry) {
    throw invalidLifecycleProjection("Temporary artifact state is invalid");
  }
  return {
    ref: artifactRef(record?.ref),
    latestExpiry,
  };
}

function temporaryIntent(value: JsonValue): TemporaryIntent {
  const record = plainRecord(value);
  if (typeof record?.scopeIdentity !== "string") {
    throw invalidLifecycleProjection("Temporary artifact intent is invalid");
  }
  return {
    ref: artifactRef(record.ref),
    scopeIdentity: record.scopeIdentity,
  };
}

function temporaryMigration(value: JsonValue | undefined): TemporaryMigration {
  const record = plainRecord(value);
  if (
    typeof record?.found !== "boolean" ||
    (record.after !== undefined && typeof record.after !== "string")
  ) {
    throw invalidLifecycleProjection(
      "Temporary artifact migration is invalid",
    );
  }
  return {
    ref: artifactRef(record.ref),
    ...(record.after === undefined ? {} : { after: record.after as string }),
    found: record.found,
  };
}

function adoptionJob(value: JsonValue, key: string): AdoptionJob {
  const record = plainRecord(value);
  if (
    record?.key !== key ||
    typeof record.adopted !== "boolean" ||
    (
      record.phase !== undefined &&
      record.phase !== "grants" &&
      record.phase !== "temporary"
    ) ||
    (record.after !== undefined && typeof record.after !== "string")
  ) {
    throw invalidLifecycleProjection("Artifact adoption job is invalid");
  }
  const job: AdoptionJob = {
    key,
    digest: digest(record.digest),
    adopted: record.adopted,
    ...(record.phase === undefined ? {} : { phase: record.phase }),
    ...(record.after === undefined ? {} : { after: record.after }),
  };
  assertProjectionKey(
    adoptionJobKey(job.digest),
    key,
    "Artifact adoption job",
  );
  return job;
}

function indexedDigest(
  value: JsonValue,
  key: string,
  label: string,
): IndexedDigest {
  const record = plainRecord(value);
  if (
    record?.key !== key ||
    Object.keys(record).length !== 2
  ) {
    throw invalidLifecycleProjection(`${label} is not bound to its key`);
  }
  return { key, digest: digest(record.digest) };
}

function indexedDigestValue(key: string, digestValue: Digest): JsonValue {
  return asJson({ key, digest: digestValue } satisfies IndexedDigest);
}

function indexedPendingOwner(value: JsonValue, key: string): PendingOwner {
  const record = plainRecord(value);
  if (
    record?.key !== key ||
    typeof record.owner !== "string" ||
    record.owner.length === 0 ||
    Object.keys(record).length !== 2 ||
    pendingKey(record.owner) !== key
  ) {
    throw invalidLifecycleProjection(
      "Artifact retirement job is not bound to its key",
    );
  }
  return { key, owner: record.owner };
}

function surfaceGrant(value: JsonValue): SurfaceAssetGrant {
  const record = plainRecord(value);
  if (
    record?.v !== 1 ||
    typeof record.grantId !== "string" ||
    typeof record.surfacePrincipal !== "string" ||
    typeof record.requestId !== "string" ||
    (record.kind !== "asset-upload" && record.kind !== "asset-download") ||
    !Array.isArray(record.assets)
  ) {
    throw invalidLifecycleProjection(
      "Surface asset grant index value is invalid",
    );
  }
  const scope = surfaceScope(record.scope);
  const assets = record.assets.map((ref) => artifactRef(ref));
  const issuedAt = optionalTime(record.issuedAt);
  const expiry = optionalTime(record.expiry);
  if (!issuedAt || !expiry || plainRecord(record.signature) === undefined) {
    throw invalidLifecycleProjection(
      "Surface asset grant index value is invalid",
    );
  }
  if (record.kind === "asset-upload") digest(record.payloadDigest);
  return {
    ...(value as unknown as SurfaceAssetGrant),
    scope,
    assets,
    issuedAt,
    expiry,
  };
}

function surfaceScope(value: unknown): SurfaceAssetScope {
  const record = plainRecord(value);
  if (
    record?.domain === "conversation" &&
    typeof record.conversationId === "string" &&
    Number.isSafeInteger(record.ownerEpoch) &&
    (record.ownerEpoch as number) >= 0
  ) {
    return {
      domain: "conversation",
      conversationId: record.conversationId,
      ownerEpoch: record.ownerEpoch as number,
    };
  }
  if (
    record?.domain === "global" &&
    Number.isSafeInteger(record.anchorEpoch) &&
    (record.anchorEpoch as number) >= 0
  ) {
    return {
      domain: "global",
      anchorEpoch: record.anchorEpoch as number,
    };
  }
  throw invalidLifecycleProjection("Surface asset grant scope is invalid");
}

function boundSurfaceGrant(
  value: JsonValue,
  key: string,
  keyOf: (grant: SurfaceAssetGrant) => string | undefined,
): SurfaceAssetGrant {
  const grant = surfaceGrant(value);
  const expected = keyOf(grant);
  if (expected === undefined) {
    throw invalidLifecycleProjection(
      "Surface asset grant is outside the index key domain",
    );
  }
  assertProjectionKey(expected, key, "Surface asset grant");
  return grant;
}

function indexedGrant(value: JsonValue, key: string): IndexedGrant {
  const record = plainRecord(value);
  if (
    record?.key !== key ||
    typeof record.grantId !== "string" ||
    record.grantId.length === 0 ||
    Object.keys(record).length !== 2
  ) {
    throw invalidLifecycleProjection(
      "Surface grant secondary index is not bound to its key",
    );
  }
  return { key, grantId: record.grantId };
}

function indexedGrantValue(key: string, grantId: string): JsonValue {
  return asJson({ key, grantId } satisfies IndexedGrant);
}

function stateKey(digestValue: Digest): string {
  return `${STATE_PREFIX}${digestHex(digestValue)}`;
}

function ownerPrefix(owner: string): string {
  return `${OWNER_PREFIX}${encode(owner)}/`;
}

function ownerKey(owner: string, digestValue: Digest): string {
  return `${ownerPrefix(owner)}${digestHex(digestValue)}`;
}

function deadKey(owner: string): string {
  return `${DEAD_PREFIX}${encode(owner)}`;
}

function pendingKey(owner: string): string {
  return `${PENDING_PREFIX}${encode(owner)}`;
}

function factKey(
  kind: "unconditional" | "ownership" | "retirement",
  digestValue: Digest,
  factId: Digest,
): string {
  return `${FACT_PREFIX}${kind}/${digestHex(digestValue)}/${digestHex(factId)}`;
}

function merkleNodeKey(
  kind: "ownership" | "retirement",
  digestValue: Digest,
  depth: number,
  prefix: string,
): string {
  return `${MERKLE_PREFIX}${kind}/${digestHex(digestValue)}/${depth
    .toString()
    .padStart(3, "0")}/${prefix}`;
}

function releaseKey(candidate: ArtifactReleaseCandidate): string {
  return `${RELEASE_PREFIX}${candidate.releasedAt}/${digestHex(
    candidate.ref.digest,
  )}/${digestHex(candidate.releaseId)}`;
}

function grantHistoryKey(grantId: string): string {
  return `${GRANT_HISTORY_PREFIX}${encode(grantId)}`;
}

function activeGrantKey(grantId: string): string {
  return `${ACTIVE_GRANT_PREFIX}${encode(grantId)}`;
}

function expiryGrantKey(grant: SurfaceAssetGrant): string {
  return `${EXPIRY_GRANT_PREFIX}${grant.expiry}/${encode(grant.grantId)}`;
}

function conversationGrantPrefix(conversationId: string): string {
  return `${CONVERSATION_GRANT_PREFIX}${encode(conversationId)}/`;
}

function conversationGrantKey(
  conversationId: string,
  grantId: string,
): string {
  return `${conversationGrantPrefix(conversationId)}${encode(grantId)}`;
}

function surfaceGrantPrefix(surfacePrincipal: string): string {
  return `${SURFACE_GRANT_PREFIX}${encode(surfacePrincipal)}/`;
}

function surfaceGrantKey(
  surfacePrincipal: string,
  grantId: string,
): string {
  return `${surfaceGrantPrefix(surfacePrincipal)}${encode(grantId)}`;
}

function uploadGrantPrefix(digestValue: Digest): string {
  return `${UPLOAD_GRANT_PREFIX}${digestHex(digestValue)}/`;
}

function uploadGrantKey(digestValue: Digest, grantId: string): string {
  return `${uploadGrantPrefix(digestValue)}${encode(grantId)}`;
}

function uploadSummaryKey(digestValue: Digest): string {
  return `${UPLOAD_SUMMARY_PREFIX}${digestHex(digestValue)}`;
}

function uploadScopePrefix(digestValue: Digest): string {
  return `${UPLOAD_SCOPE_PREFIX}${digestHex(digestValue)}/`;
}

function uploadScopeKey(
  digestValue: Digest,
  scopeIdentity: string,
): string {
  return `${uploadScopePrefix(digestValue)}${encode(scopeIdentity)}`;
}

function reservationMemberKey(
  grantId: string,
  digestValue: Digest,
): string {
  return `${RESERVATION_MEMBER_PREFIX}${encode(grantId)}/${digestHex(
    digestValue,
  )}`;
}

function reservationScopeKey(
  scopeIdentity: string,
  digestValue: Digest,
): string {
  return `${RESERVATION_SCOPE_PREFIX}${encode(scopeIdentity)}/${digestHex(
    digestValue,
  )}`;
}

function reservationDeviceKey(digestValue: Digest): string {
  return `${RESERVATION_DEVICE_PREFIX}${digestHex(digestValue)}`;
}

function quotaScopeKey(scopeIdentity: string): string {
  return `${QUOTA_SCOPE_PREFIX}${encode(scopeIdentity)}`;
}

function adoptionJobKey(digestValue: Digest): string {
  return `${ADOPTION_JOB_PREFIX}${digestHex(digestValue)}`;
}

function temporaryStateKey(digestValue: Digest): string {
  return `${TEMPORARY_STATE_PREFIX}${digestHex(digestValue)}`;
}

function temporaryIntentKey(
  digestValue: Digest,
  scopeIdentity: string,
): string {
  return `${TEMPORARY_INTENT_PREFIX}${digestHex(digestValue)}/${
    encode(scopeIdentity)
  }`;
}

function temporaryMigrationKey(digestValue: Digest): string {
  return `${TEMPORARY_MIGRATION_PREFIX}${digestHex(digestValue)}`;
}

function temporaryScopePrefix(digestValue: Digest): string {
  return `${TEMPORARY_SCOPE_PREFIX}${digestHex(digestValue)}/`;
}

function temporaryScopeKey(
  digestValue: Digest,
  scopeIdentity: string,
): string {
  return `${temporaryScopePrefix(digestValue)}${encode(scopeIdentity)}`;
}

function temporaryDueKey(candidate: ArtifactTemporaryCandidate): string {
  return `${TEMPORARY_DUE_PREFIX}${candidate.eligibleAt}/${digestHex(
    candidate.ref.digest,
  )}`;
}

function temporaryCleanupKey(digestValue: Digest): string {
  return `${TEMPORARY_CLEANUP_PREFIX}${digestHex(digestValue)}`;
}

function surfaceScopeKey(scope: SurfaceAssetScope): string {
  return canonicalize(scope);
}

function assertPageCursor(
  cursor: string | undefined,
  prefix: string,
  label: string,
): void {
  if (cursor !== undefined && !cursor.startsWith(prefix)) {
    throw invalidLifecycleProjection(
      `${label} continuation is outside its index prefix`,
    );
  }
}

function isRetained(state: LifecycleDigestState): boolean {
  return state.unconditionalFacts > 0 || state.liveOwners > 0;
}

function digestBits(value: Digest): string {
  return [...digestHex(value)]
    .map((hex) => Number.parseInt(hex, 16).toString(2).padStart(4, "0"))
    .join("");
}

function digestHex(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Artifact lifecycle digest is invalid");
  }
  return value.slice("sha256:".length);
}

function digest(value: unknown): Digest {
  if (
    typeof value !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value)
  ) {
    throw invalidLifecycleProjection("Artifact lifecycle digest is invalid");
  }
  return value as Digest;
}

function optionalDigest(value: unknown): Digest | undefined {
  return value === undefined ? undefined : digest(value);
}

function artifactRef(value: unknown): ArtifactRef {
  const record = plainRecord(value);
  const ref = {
    digest: digest(record?.digest),
    bytes: nonNegativeInteger(record?.bytes, "artifact bytes"),
  };
  return ref;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidLifecycleProjection(
      `Artifact lifecycle ${label} is invalid`,
    );
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) {
    throw invalidLifecycleProjection(
      `Artifact lifecycle ${label} is invalid`,
    );
  }
  return parsed;
}

function quotaValue(
  value: JsonValue | undefined,
  key: string,
): number {
  if (value === undefined) return 0;
  const record = plainRecord(value);
  if (record?.key !== key) {
    throw invalidLifecycleProjection(
      "Artifact quota is not bound to its key",
    );
  }
  return nonNegativeInteger(record.bytes, "quota bytes");
}

function quotaProjectionValue(key: string, bytes: number): JsonValue {
  return asJson({ key, bytes } satisfies QuotaValue);
}

function projectionMarker(
  value: JsonValue,
  key: string,
  label: string,
): void {
  const record = plainRecord(value);
  if (record?.key !== key || Object.keys(record).length !== 1) {
    throw invalidLifecycleProjection(`${label} is not bound to its key`);
  }
}

function merkleNodeValue(value: JsonValue, key: string): Digest {
  const record = plainRecord(value);
  if (record?.key !== key) {
    throw invalidLifecycleProjection(
      "Artifact lifecycle Merkle node is not bound to its key",
    );
  }
  return digest(record.digest);
}

function scopeReference(
  value: JsonValue,
  key: string,
  keyOf: (digest: Digest, scopeIdentity: string) => string,
): ScopeReference {
  const record = plainRecord(value);
  if (
    record?.key !== key ||
    typeof record.scopeIdentity !== "string" ||
    record.scopeIdentity.length === 0
  ) {
    throw invalidLifecycleProjection(
      "Artifact scope reference is invalid",
    );
  }
  const ref = artifactRef(record.ref);
  assertProjectionKey(
    keyOf(ref.digest, record.scopeIdentity),
    key,
    "Artifact scope reference",
  );
  return { key, ref, scopeIdentity: record.scopeIdentity };
}

function assertProjectionKey(
  expected: string,
  actual: string,
  label: string,
): void {
  if (expected !== actual) {
    throw invalidLifecycleProjection(`${label} is not bound to its key`);
  }
}

function invalidLifecycleProjection(
  message: string,
): ArtifactLifecycleProjectionValueError {
  return new ArtifactLifecycleProjectionValueError(message);
}

class ArtifactLifecycleProjectionValueError
  extends DurableProjectionStorageError
{
  constructor(message: string) {
    super(message);
    this.name = "ArtifactLifecycleProjectionValueError";
  }
}

function assertPageLimit(limit: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
    throw new RangeError(`${label} page limit must be 1-256`);
  }
}

function optionalTime(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidLifecycleProjection("Artifact lifecycle time is invalid");
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw invalidLifecycleProjection("Artifact lifecycle time is invalid");
  }
  return value;
}

function assertCanonicalTime(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
}

function latestTime(left: string | undefined, right: string): string {
  return left === undefined || Date.parse(right) > Date.parse(left)
    ? right
    : left;
}

function assertCompatibleReference(
  expected: ArtifactRef,
  actual: ArtifactRef,
): void {
  if (
    expected.digest !== actual.digest ||
    expected.bytes !== actual.bytes
  ) {
    throw new Error("Artifact lifecycle digest has conflicting byte counts");
  }
}

function deduplicateReferences(
  refs: readonly ArtifactRef[],
): readonly ArtifactRef[] {
  const unique = new Map<Digest, ArtifactRef>();
  for (const ref of refs) {
    const existing = unique.get(ref.digest);
    if (existing) assertCompatibleReference(existing, ref);
    else unique.set(ref.digest, ref);
  }
  return [...unique.values()];
}

function hasDurableTemporary(progress: {
  readonly receivedBytes: number;
  readonly complete: boolean;
}): boolean {
  return progress.complete || progress.receivedBytes > 0;
}

function isRebuildableProjectionFailure(error: unknown): boolean {
  return (
    error instanceof DurableProjectionStorageError ||
    (
      error instanceof AuthorityStorageError &&
      error.code === "commit-log-corrupt"
    )
  );
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sameCheckpoint(
  left: DurableLogCheckpoint | undefined,
  right: DurableLogCheckpoint,
): boolean {
  return (
    left?.logId === right.logId &&
    left.lsn === right.lsn &&
    left.frameEndOffset === right.frameEndOffset &&
    left.prefixDigest === right.prefixDigest
  );
}

function cloneSourceHeads(sourceHeads: LifecycleSourceHeads): LifecycleSourceHeads {
  return Object.fromEntries(Object.entries(sourceHeads).map(([id, checkpoint]) => [
    id,
    { ...checkpoint },
  ]));
}

function sameSourceHeads(left: LifecycleSourceHeads, right: LifecycleSourceHeads): boolean {
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  return canonicalize(leftIds) === canonicalize(rightIds) &&
    leftIds.every((id) => sameCheckpoint(left[id], right[id]!));
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
