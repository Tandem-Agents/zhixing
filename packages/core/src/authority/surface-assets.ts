import type {
  ArtifactRef,
  ControlRecord,
  Digest,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "../contracts/index.js";
import {
  MAX_SURFACE_ASSET_DEVICE_BYTES,
  MAX_SURFACE_ASSET_GRANT_BYTES,
  MAX_SURFACE_ASSET_GRANT_TTL_MS,
  MAX_SURFACE_ASSET_SCOPE_BYTES,
} from "../contracts/index.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";
import {
  assertProtocolIdentifier,
  assertSurfaceAssetGrantIssueBinding,
  assertSurfaceAssetGrantUse,
  canonicalize,
  createSignedSurfaceAssetGrant,
  validateSurfaceAssetGrant,
  validateSurfaceAssetGrantIssueBinding,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type SurfaceAssetGrantIssueBinding,
  type SurfaceAssetGrantOperationBinding,
} from "../protocol/index.js";
import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  type ArtifactReceiveProgress,
  type FileResumableArtifactReceiver,
} from "./assignment-artifacts.js";
import type {
  ArtifactDeletionResult,
  MutableArtifactStore,
} from "./interfaces.js";
import type {
  ArtifactQuotaSnapshot,
  ArtifactReleaseCandidate,
  ArtifactTemporaryCandidate,
} from "./artifact-lifecycle-index.js";
import {
  maintenanceRetryDelayMs,
  runInMaintenanceContext,
  runStorageMaintenanceStep,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  waitForMaintenanceRetry,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";

const DEFAULT_UNADOPTED_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_SURFACE_ASSET_COLLECTION_REFS = 64;
/** 启动恢复在段外重试背压的总时限;超过即按容量缺口 fail-closed。 */
const RECOVERY_ADMISSION_DEADLINE_MS = 5_000;
const COLLECTION_NEVER_ABORT = new AbortController().signal;

type IssuedRecord = Extract<ControlRecord, { t: "asset-grant-issued" }>;
type RevokedRecord = Extract<ControlRecord, { t: "asset-grant-revoked" }>;
type FrontierRecord = Extract<ControlRecord, { t: "authority-time-frontier" }>;
type SurfaceAssetControlRecord = IssuedRecord | RevokedRecord | FrontierRecord;

export interface SurfaceAssetGrantLedgerSnapshot {
  readonly records: readonly SurfaceAssetControlRecord[];
  readonly durableTime?: string;
}

export interface SurfaceAssetGrantLedgerAppendResult {
  readonly durableTime: string;
}

export interface SurfaceAssetGrantLedgerIssuedResult
  extends SurfaceAssetGrantLedgerAppendResult {
  readonly accepted: boolean;
}

export interface SurfaceAssetGrantLedger {
  load(): Promise<SurfaceAssetGrantLedgerSnapshot>;
  synchronize(): Promise<void>;
  append(
    record: RevokedRecord | FrontierRecord,
  ): Promise<SurfaceAssetGrantLedgerAppendResult>;
  appendIssued(
    record: IssuedRecord,
  ): Promise<SurfaceAssetGrantLedgerIssuedResult>;
  /**
   * 按耐久申请键精确查找已签发 grant——exact replay 的冷路径,只在热集
   * 未命中且键确实出现过时调用;同键多条不同 grant 必须报错而非择一。
   */
  findIssuedByRequestKey(
    requestKey: string,
  ): Promise<SurfaceAssetGrant | undefined>;
  findActiveGrant(
    grantId: string,
    expected?: SurfaceAssetGrant,
  ): Promise<SurfaceAssetGrant | undefined>;
  listActiveConversationGrants(
    conversationId: string,
    limit: number,
  ): Promise<readonly SurfaceAssetGrant[]>;
  listActiveSurfaceGrants(
    surfacePrincipal: string,
    limit: number,
  ): Promise<readonly SurfaceAssetGrant[]>;
  nextActiveGrantExpiry(): Promise<string | undefined>;
  quotaSnapshot(
    scope: SurfaceAssetScope,
    refs: readonly ArtifactRef[],
  ): Promise<ArtifactQuotaSnapshot>;
  isRetainedReference(ref: ArtifactRef): Promise<boolean>;
  recordTemporaryPresence(
    ref: ArtifactRef,
    scopeIdentity: string,
  ): Promise<void>;
  settleTemporaryPresence(
    ref: ArtifactRef,
    scopeIdentity: string,
    landed: boolean,
  ): Promise<void>;
  temporaryBefore(
    before: string,
    limit: number,
  ): Promise<readonly ArtifactTemporaryCandidate[]>;
  adoptedTemporary(limit: number): Promise<readonly ArtifactRef[]>;
  markTemporaryRemoved(ref: ArtifactRef): Promise<boolean>;
  /** 进程停机时停止本账本拥有的存储维护任务。 */
  stopStorageMaintenance?(): void;
}

export type SurfaceAssetGrantIssueRequest = SurfaceAssetGrantIssueBinding & {
  readonly surfacePrincipal: string;
};

export interface SurfaceAssetAdoptionRequest {
  readonly scope: SurfaceAssetScope;
  readonly surfacePrincipal: string;
  readonly requestId: string;
  readonly assets: readonly ArtifactRef[];
  readonly payloadDigest: Digest;
}

export interface SurfaceAssetCollectionResult {
  readonly processed: number;
  readonly removed: number;
  readonly hasMore: boolean;
}

export interface SurfaceAssetCoordinatorOptions {
  readonly artifacts: MutableArtifactStore;
  readonly temporaryArtifacts: MutableArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly ledger: SurfaceAssetGrantLedger;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly createGrantId: (issuedAt: string) => string;
  readonly canDownload: (
    scope: SurfaceAssetScope,
    refs: readonly ArtifactRef[],
  ) => boolean | Promise<boolean>;
  readonly authorizeScope: (
    scope: SurfaceAssetScope,
  ) => boolean | Promise<boolean>;
  readonly deleteUnreferencedArtifacts: (
    refs: readonly ArtifactRef[],
    /**
     * 主存储物理删除段的治理包装,由协调器提供并要求实现透传到真正的 unlink
     * 段;保留判定不得包进来,否则与其自身的治理准入形成嵌套。
     */
    governDeletion: <T>(operation: () => Promise<T>) => Promise<T>,
  ) => Promise<readonly ArtifactDeletionResult[]>;
  readonly listReleasedArtifacts: (
    before: string,
    limit: number,
  ) => Promise<readonly ArtifactReleaseCandidate[]>;
  readonly markReleasedArtifactsReclaimed: (
    candidates: readonly ArtifactReleaseCandidate[],
  ) => Promise<void>;
  readonly clock?: () => string;
  readonly monotonicClock?: () => number;
  readonly scopeQuotaBytes?: number;
  readonly deviceQuotaBytes?: number;
  readonly unadoptedRetentionMs?: number;
  readonly grantTtlMs?: number;
  /**
   * 存储维护治理。回收的物理删除步骤经它取得容量;缺省时不受治理,只用于不
   * 装配治理的测试与内嵌场景。
   */
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  /** 回收任务身份中的资源标识,默认取临时存储根。 */
  readonly maintenanceResourceId?: string;
}

export type SurfaceAssetAuthorityBinding = Pick<
  SurfaceAssetCoordinatorOptions,
  | "ledger"
  | "signer"
  | "verifier"
  | "createGrantId"
  | "canDownload"
  | "authorizeScope"
  | "deleteUnreferencedArtifacts"
  | "listReleasedArtifacts"
  | "markReleasedArtifactsReclaimed"
>;

interface OperationPin {
  readonly id: symbol;
  readonly ref: ArtifactRef;
  readonly scope: string;
  readonly kind: SurfaceAssetGrant["kind"];
}

const coordinators = new WeakMap<
  MutableArtifactStore,
  SurfaceAssetCoordinator
>();

/**
 * Owns the one linearization domain for surface grants, quota reservations,
 * transfers and collection over a shared artifact store.
 */
export class SurfaceAssetCoordinator {
  readonly #queue = new SerialTaskQueue();
  readonly #pins = new Map<symbol, OperationPin>();
  readonly #time: NonRegressingAuthorityClock;
  readonly #scopeQuotaBytes: number;
  readonly #deviceQuotaBytes: number;
  readonly #retentionMs: number;
  readonly #grantTtlMs: number;
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  readonly #maintenanceResourceId: string;
  #recovered = false;

  private constructor(private options: SurfaceAssetCoordinatorOptions) {
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#storageMaintenance = options.storageMaintenance;
    this.#maintenanceResourceId =
      options.maintenanceResourceId ?? "surface-assets";
    this.#time = new NonRegressingAuthorityClock(
      options.clock ?? (() => new Date().toISOString()),
      options.monotonicClock ?? (() => performance.now()),
    );
    this.#scopeQuotaBytes =
      options.scopeQuotaBytes ?? MAX_SURFACE_ASSET_SCOPE_BYTES;
    this.#deviceQuotaBytes =
      options.deviceQuotaBytes ?? MAX_SURFACE_ASSET_DEVICE_BYTES;
    this.#retentionMs =
      options.unadoptedRetentionMs ?? DEFAULT_UNADOPTED_RETENTION_MS;
    this.#grantTtlMs =
      options.grantTtlMs ?? MAX_SURFACE_ASSET_GRANT_TTL_MS;
    assertPositiveBudget(this.#scopeQuotaBytes, "Surface scope quota");
    assertPositiveBudget(this.#deviceQuotaBytes, "Surface device quota");
    assertPositiveBudget(this.#retentionMs, "Surface retention window");
    if (
      !Number.isSafeInteger(this.#grantTtlMs) ||
      this.#grantTtlMs <= 0 ||
      this.#grantTtlMs > MAX_SURFACE_ASSET_GRANT_TTL_MS
    ) {
      throw new RangeError("Surface asset grant TTL is outside its bound");
    }
  }

  static forStore(
    options: SurfaceAssetCoordinatorOptions,
  ): SurfaceAssetCoordinator {
    const existing = coordinators.get(options.artifacts);
    if (existing) return existing;
    const created = new SurfaceAssetCoordinator(options);
    coordinators.set(options.artifacts, created);
    return created;
  }

  async rebindAuthority(binding: SurfaceAssetAuthorityBinding): Promise<void> {
    await this.#queue.run(async () => {
      this.options = { ...this.options, ...binding };
      this.#recovered = false;
      await this.#recoverLocked();
    });
  }

  /**
   * 请求服务入口:调用方在同步等待结果,阻塞关系固定为前台,与是谁发起无关。
   * 启动恢复与周期回收各自由它们的顶层所有者声明语境,不经这里。
   */
  #serving<T>(operation: () => Promise<T>): Promise<T> {
    return runInMaintenanceContext("foreground", operation);
  }

  async recover(): Promise<void> {
    // 恢复要在串行段内完成,段内准入是零等待的,容量紧张时会立刻拿到背压。
    // 背压不是恢复失败:重试必须发生在段外,否则等待又回到段内。
    const deadline = Date.now() + RECOVERY_ADMISSION_DEADLINE_MS;
    for (;;) {
      try {
        await this.#queue.run(() => this.#recoverLocked());
        return;
      } catch (error) {
        const retryAfterMs = maintenanceRetryDelayMs(error);
        if (retryAfterMs === undefined || Date.now() >= deadline) throw error;
        await waitForMaintenanceRetry(
          Math.min(retryAfterMs, Math.max(0, deadline - Date.now())),
        );
      }
    }
  }

  /** Returns whether the authority currently owns the requested asset scope. */
  ownsScope(scope: SurfaceAssetScope): Promise<boolean> {
    return this.#serving(() => Promise.resolve(this.options.authorizeScope(scope)));
  }

  async issue(
    request: SurfaceAssetGrantIssueRequest,
  ): Promise<SurfaceAssetGrant> {
    const { surfacePrincipal, ...rawBinding } = request;
    assertProtocolIdentifier(
      surfacePrincipal,
      "Surface asset grant issue principal",
    );
    const binding = validateSurfaceAssetGrantIssueBinding(rawBinding);
    const key = requestKey(binding.scope, surfacePrincipal, binding.requestId);
    return this.#serving(() =>
      this.#queue.run(async () => {
        if (!this.#recovered) {
          // durable-first exact replay:不依赖热投影、当前资格、时钟与签名器。
          const durable = await this.options.ledger.findIssuedByRequestKey(key);
          if (durable) {
            return this.#replayGrant(
              validateSurfaceAssetGrant(durable, this.options.verifier),
              binding,
              surfacePrincipal,
            );
          }
          await this.#recoverLocked();
        }
        const durable = await this.options.ledger.findIssuedByRequestKey(key);
        if (durable) {
          return this.#replayGrant(
            validateSurfaceAssetGrant(durable, this.options.verifier),
            binding,
            surfacePrincipal,
          );
        }

        if (!(await this.options.authorizeScope(binding.scope))) {
          throw new TypeError("Surface asset scope is not owned by this authority");
        }
        const issuedAt = this.#time.observe().iso;
        await this.#retireExpired(Date.parse(issuedAt));
        const unsigned = {
          v: 1 as const,
          grantId: this.options.createGrantId(issuedAt),
          scope: binding.scope,
          surfacePrincipal,
          requestId: binding.requestId,
          kind: binding.kind,
          assets: [...binding.assets],
          issuedAt,
          expiry: new Date(Date.parse(issuedAt) + this.#grantTtlMs).toISOString(),
          ...(binding.kind === "asset-upload"
            ? { payloadDigest: binding.payloadDigest }
            : {}),
        };
        const candidate = createSignedSurfaceAssetGrant(
          unsigned as Parameters<typeof createSignedSurfaceAssetGrant>[0],
          this.options.signer,
        );
        const quota = await this.options.ledger.quotaSnapshot(
          candidate.scope,
          candidate.assets,
        );
        if (candidate.kind === "asset-download") {
          if (!(await this.options.canDownload(candidate.scope, candidate.assets))) {
            throw new Error("Surface asset download is outside the visible asset set");
          }
        } else {
          await this.#assertQuota(candidate, quota);
        }

        let result: SurfaceAssetGrantLedgerIssuedResult;
        try {
          result = await this.options.ledger.appendIssued({
            t: "asset-grant-issued",
            grant: candidate,
          });
        } catch (error) {
          this.#recovered = false;
          throw error;
        }
        this.#time.advanceDurable(result.durableTime);
        if (!result.accepted) {
          throw new TypeError("Surface asset scope is not owned by this authority");
        }
        return candidate;
        }),
    );
  }

  #replayGrant(
    grant: SurfaceAssetGrant,
    binding: SurfaceAssetGrantIssueBinding,
    surfacePrincipal: string,
  ): SurfaceAssetGrant {
    if (grant.surfacePrincipal !== surfacePrincipal) {
      throw new Error("Surface asset grant idempotency-conflict");
    }
    try {
      assertSurfaceAssetGrantIssueBinding(grant, binding);
    } catch {
      throw new Error("Surface asset grant idempotency-conflict");
    }
    return grant;
  }

  async revoke(
    grantId: string,
    reason: RevokedRecord["reason"],
  ): Promise<void> {
    // 前台语境由 `#runRecovered` 单点声明,这里不重复。
    await this.#runRecovered(() => this.#revokeIds([grantId], reason));
  }

  async revokeConversation(conversationId: string): Promise<void> {
    await this.#runRecovered(async () => {
      for (;;) {
        const grants = await this.options.ledger.listActiveConversationGrants(
          conversationId,
          MAX_SURFACE_ASSET_COLLECTION_REFS,
        );
        if (grants.length === 0) return;
        await this.#revokeIds(
          grants.map(({ grantId }) => grantId),
          "session-deleted",
        );
      }
    });
  }

  async revokeSurface(surfacePrincipal: string): Promise<void> {
    await this.#runRecovered(async () => {
      for (;;) {
        const grants = await this.options.ledger.listActiveSurfaceGrants(
          surfacePrincipal,
          MAX_SURFACE_ASSET_COLLECTION_REFS,
        );
        if (grants.length === 0) return;
        await this.#revokeIds(
          grants.map(({ grantId }) => grantId),
          "surface-revoked",
        );
      }
    });
  }

  async assertUploadAdoption(
    request: SurfaceAssetAdoptionRequest,
  ): Promise<void> {
    await this.#runRecovered(async () => {
      const issued = await this.options.ledger.findIssuedByRequestKey(
        requestKey(request.scope, request.surfacePrincipal, request.requestId),
      );
      const grant = issued
        ? await this.options.ledger.findActiveGrant(issued.grantId, issued)
        : undefined;
      if (!grant || grant.kind !== "asset-upload") {
        throw new TypeError("Surface asset upload grant is unknown or revoked");
      }
      const assets = request.assets.map(({ digest, bytes }) => ({ digest, bytes }));
      if (
        grant.payloadDigest !== request.payloadDigest ||
        canonicalize(grant.assets) !== canonicalize(assets)
      ) {
        throw new TypeError(
          "Surface asset upload grant does not bind this control request",
        );
      }
      const now = this.#time.observe();
      await this.#retireExpired(now.ms);
      if (!(await this.options.ledger.findActiveGrant(grant.grantId, grant))) {
        throw new TypeError("Surface asset upload grant is unknown or revoked");
      }
      if (!(await this.options.authorizeScope(request.scope))) {
        throw new TypeError("Surface asset scope is not owned by this authority");
      }
      for (const ref of assets) {
        assertSurfaceAssetGrantUse(grant, {
          scope: request.scope,
          surfacePrincipal: request.surfacePrincipal,
          kind: "asset-upload",
          ref,
          at: now.iso,
          payloadDigest: request.payloadDigest,
        });
        await this.#promoteTemporary(ref);
      }
    });
  }

  async probe(
    grant: SurfaceAssetGrant,
    use: SurfaceAssetGrantOperationBinding,
    ref: ArtifactRef,
  ): Promise<ArtifactReceiveProgress> {
    return this.#withGrantOperation(grant, use, ref, async () => {
      if (await this.options.artifacts.has(ref)) {
        return { receivedBytes: ref.bytes, complete: true };
      }
      return this.options.receiver.progress(ref);
    });
  }

  async append(
    grant: SurfaceAssetGrant,
    use: SurfaceAssetGrantOperationBinding,
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
  ): Promise<ArtifactReceiveProgress> {
    return this.#withGrantOperation(grant, use, ref, async (pin) => {
      if (grant.kind !== "asset-upload") {
        throw new TypeError("Download grant cannot append an artifact");
      }
      if (await this.options.artifacts.has(ref)) {
        return { receivedBytes: ref.bytes, complete: true };
      }
      // The durable operational projection is recorded before file I/O. A
      // crash can therefore leave a conservative candidate, never an
      // unaccounted temporary file.
      await this.options.ledger.recordTemporaryPresence(ref, pin.scope);
      try {
        const progress = await this.options.receiver.append(ref, offset, bytes);
        await this.options.ledger.settleTemporaryPresence(
          ref,
          pin.scope,
          hasDurableArtifact(progress),
        );
        return progress;
      } catch (error) {
        try {
          const progress = await this.options.receiver.progress(ref);
          await this.options.ledger.settleTemporaryPresence(
            ref,
            pin.scope,
            hasDurableArtifact(progress),
          );
        } catch {
          // The durable intent remains for bounded recovery on the next turn.
        }
        throw error;
      }
    });
  }

  async read(
    grant: SurfaceAssetGrant,
    use: SurfaceAssetGrantOperationBinding,
    ref: ArtifactRef,
    offset: number,
    limit: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > DEFAULT_ARTIFACT_CHUNK_BYTES
    ) {
      throw new RangeError("Surface asset read limit is outside its bound");
    }
    return this.#withGrantOperation(grant, use, ref, async () => {
      if (grant.kind !== "asset-download") {
        throw new TypeError("Upload grant cannot read an artifact");
      }
      return this.options.artifacts.readRange(ref, offset, limit);
    });
  }

  async markAdopted(refs: readonly ArtifactRef[]): Promise<void> {
    await this.#runRecovered(async () => {
      for (const ref of refs) {
        if (!(await this.options.ledger.isRetainedReference(ref))) {
          throw new Error("Adopted surface asset is not retained by authority");
        }
      }
      // 接管只确认耐久归属。临时副本已经由 lifecycle 候选事实持续追踪，
      // 物理清理由锚点 GC owner 统一驱动，业务入口不得临时充当维护所有者。
    });
  }

  async collectExpiredTemporaryAssets(
    waiterAbort: AbortSignal = COLLECTION_NEVER_ABORT,
  ): Promise<SurfaceAssetCollectionResult> {
    try {
      // 一轮完整回收是一份义务:候选游标 = 本轮的淘汰时间前沿,同前沿触发
      // 合流为一次执行,更强等待者提级。义务层不持任何容量 permit;
      // 物理删除在设施串行区内各自准入。
      const now = this.#time.observe();
      const cutoff = new Date(now.ms - this.#retentionMs).toISOString();
      return await this.#maintenanceRunner.run(
        storageMaintenanceObligation(
          "asset-gc",
          this.#maintenanceResourceId,
          { cutoff },
          { owner: "anchor-asset-maintainer", obligation: "committed" },
        ),
        waiterAbort,
        () => this.#collectLocked(now),
      );
    } catch (error) {
      if (maintenanceRetryDelayMs(error) === undefined) throw error;
      // 串行段内的准入是零等待的,容量紧张时立刻拿到背压。回收整体幂等,
      // 本轮不做进展、由既有周期触发器重试即可,不能把背压升级成维护失败;
      // 零进展也不会触发立即续跑(见 U23-23)。
      return { processed: 0, removed: 0, hasMore: true };
    }
  }

  /** 停止周期回收拥有的 GC 义务，不提前截断其下游账本所有者。 */
  stopCollectionMaintenance(): void {
    this.#maintenanceRunner.stop();
  }

  /** 进程存储层停机时，按所有权层级停止 GC、账本、投影和日志义务。 */
  stopStorageMaintenance(): void {
    this.stopCollectionMaintenance();
    this.options.ledger.stopStorageMaintenance?.();
  }

  async #collectLocked(now: {
    readonly ms: number;
  }): Promise<SurfaceAssetCollectionResult> {
    return this.#runRecoveredIn(async () => {
      await this.#retireExpired(now.ms);
      const cleanup = await this.#drainAdoptedCleanup(
        MAX_SURFACE_ASSET_COLLECTION_REFS,
      );
      if (cleanup.processed === MAX_SURFACE_ASSET_COLLECTION_REFS) {
        return {
          processed: cleanup.processed,
          removed: cleanup.removed,
          hasMore: true,
        };
      }
      const remaining =
        MAX_SURFACE_ASSET_COLLECTION_REFS - cleanup.processed;
      const cutoff = new Date(now.ms - this.#retentionMs).toISOString();
      const temporary = await this.options.ledger.temporaryBefore(
        cutoff,
        remaining,
      );
      const availableAfterTemporary = remaining - temporary.length;
      const released = availableAfterTemporary > 0
        ? await this.options.listReleasedArtifacts(
          cutoff,
          availableAfterTemporary,
        )
        : [];
      const selectedTemporary = temporary.filter(({ ref }) =>
        !this.#hasPin(ref.digest)
      );
      const selectedReleased = released.filter(({ ref }) =>
        !this.#hasPin(ref.digest)
      );
      const selectedRefs: ArtifactRef[] = [];
      let selectedBytes = 0;
      let hasMore =
        cleanup.hasMore ||
        temporary.length === remaining ||
        released.length === availableAfterTemporary;
      for (const candidate of [...selectedTemporary, ...selectedReleased]) {
        if (
          selectedRefs.length > 0 &&
          selectedBytes + candidate.ref.bytes > MAX_SURFACE_ASSET_GRANT_BYTES
        ) {
          hasMore = true;
          break;
        }
        selectedRefs.push(candidate.ref);
        selectedBytes += candidate.ref.bytes;
      }
      if (selectedRefs.length === 0) {
        return {
          processed: cleanup.processed,
          removed: cleanup.removed,
          hasMore,
        };
      }
      if (await this.#persistTimeFrontier(now.ms)) {
        await this.options.ledger.synchronize();
      }
      const results = await this.options.deleteUnreferencedArtifacts(
        selectedRefs,
        (operation) =>
          this.#admitGcStep(
            { step: "delete-unreferenced", count: selectedRefs.length },
            operation,
          ),
      );
      const byDigest = new Map(
        results.map((result) => [result.ref.digest, result]),
      );
      const selectedDigests = new Set(selectedRefs.map(({ digest }) => digest));
      let removed = cleanup.removed;
      let processedTemporary = 0;
      for (const candidate of selectedTemporary) {
        if (!selectedDigests.has(candidate.ref.digest)) continue;
        const disposition = byDigest.get(candidate.ref.digest)?.disposition;
        if (!disposition || disposition === "deferred") {
          hasMore = true;
          continue;
        }
        const { partial, complete } = await this.#discardTemporary(
          candidate.ref,
        );
        // 权威状态更新留在 permit 之外:它内部自行取生命周期治理容量,包进来
        // 会形成嵌套准入,单槽设备上外层占住唯一槽、内层永远等不到。
        if (!(await this.options.ledger.markTemporaryRemoved(candidate.ref))) {
          hasMore = true;
        }
        if (partial || complete) removed += 1;
        processedTemporary += 1;
      }
      const reclaimed = selectedReleased.filter((candidate) => {
        if (!selectedDigests.has(candidate.ref.digest)) return false;
        const disposition = byDigest.get(candidate.ref.digest)?.disposition;
        if (!disposition || disposition === "deferred") {
          hasMore = true;
          return false;
        }
        if (disposition === "deleted") removed += 1;
        return disposition === "deleted" || disposition === "missing";
      });
      await this.options.markReleasedArtifactsReclaimed(reclaimed);
      return {
        processed:
          cleanup.processed +
          processedTemporary +
          reclaimed.length,
        removed,
        hasMore,
      };
    });
  }

  /**
   * 回收物理删除步骤的容量准入。调用点必须已持有所属设施的串行权或排他锁:
   * 先拿锁、后取容量、完成即释放——顺序反过来就是持 permit 等锁。
   */
  async #admitGcStep<T>(
    inputIdentity: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runStorageMaintenanceStep(
      this.#storageMaintenance,
      storageMaintenanceRequest(
        "asset-gc",
        this.#maintenanceResourceId,
        inputIdentity,
        { obligation: "committed" },
      ),
      operation,
    );
  }

  /** 临时区的物理删除 —— partial 与完整临时件各自在设施串行区内准入后清除。 */
  async #discardTemporary(
    ref: ArtifactRef,
  ): Promise<{ readonly partial: boolean; readonly complete: boolean }> {
    const partial = await this.options.receiver.discard(
      ref,
      (operation) =>
        this.#admitGcStep(
          { step: "discard-partial", digest: ref.digest },
          operation,
        ),
    );
    const complete = await this.options.temporaryArtifacts.discard(
      ref,
      (operation) =>
        this.#admitGcStep(
          { step: "discard-temporary", digest: ref.digest },
          operation,
        ),
    );
    return { partial, complete };
  }

  async #withGrantOperation<T>(
    input: SurfaceAssetGrant,
    use: SurfaceAssetGrantOperationBinding,
    ref: ArtifactRef,
    operation: (pin: OperationPin) => Promise<T>,
  ): Promise<T> {
    const pin = await this.#runRecovered(() =>
      this.#authorizeAndPin(input, use, ref),
    );
    try {
      return await operation(pin);
    } finally {
      await this.#queue.run(() => this.#finishPin(pin));
    }
  }

  async #authorizeAndPin(
    input: SurfaceAssetGrant,
    use: SurfaceAssetGrantOperationBinding,
    ref: ArtifactRef,
  ): Promise<OperationPin> {
    const grant = validateSurfaceAssetGrant(input, this.options.verifier);
    const now = this.#time.observe();
    const activeBeforeRetirement = await this.options.ledger.findActiveGrant(
      grant.grantId,
      grant,
    );
    await this.#retireExpired(now.ms);
    const active = await this.options.ledger.findActiveGrant(
      grant.grantId,
      grant,
    );
    if (!active) {
      if (activeBeforeRetirement) {
        assertSurfaceAssetGrantUse(grant, {
          ...use,
          ref,
          at: now.iso,
        });
      }
      throw new TypeError("Surface asset grant is unknown or revoked");
    }
    if (canonicalize(active) !== canonicalize(grant)) {
      throw new TypeError("Surface asset grant is unknown or revoked");
    }
    assertSurfaceAssetGrantUse(grant, {
      ...use,
      ref,
      at: now.iso,
    });
    if (!(await this.options.authorizeScope(grant.scope))) {
      throw new TypeError("Surface asset scope is not owned by this authority");
    }
    const pin: OperationPin = {
      id: Symbol(grant.grantId),
      ref,
      scope: scopeKey(grant.scope),
      kind: grant.kind,
    };
    this.#pins.set(pin.id, pin);
    return pin;
  }

  /** 请求路径:调用方在等,前台语境由此单点声明。 */
  async #runRecovered<T>(task: () => Promise<T>): Promise<T> {
    return this.#serving(() => this.#runRecoveredIn(task));
  }

  /** 已由所有者声明语境的路径(周期回收)直接走这里,不得被覆盖成前台。 */
  async #runRecoveredIn<T>(task: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      await this.#recoverLocked();
      return task();
    });
  }

  async #recoverLocked(
    loaded?: SurfaceAssetGrantLedgerSnapshot,
  ): Promise<void> {
    if (this.#recovered) return;
    const snapshot = loaded ?? await this.options.ledger.load();
    this.#time.reset(snapshot.durableTime);
    await this.options.ledger.synchronize();
    await this.#retireExpired(this.#time.observe().ms);
    // 恢复只重建耐久状态。锚点维护器会在启动时立即执行首轮 GC，
    // adopted cleanup 不得绕过其义务协调器落到恢复串行段内。
    this.#recovered = true;
  }

  async #assertQuota(
    candidate: SurfaceAssetGrant,
    initial: ArtifactQuotaSnapshot,
  ): Promise<void> {
    const at = Date.parse(candidate.issuedAt);
    await this.#retireExpired(at);
    const key = scopeKey(candidate.scope);
    const livePins = [...this.#pins.values()].filter(
      (pin) => pin.kind === "asset-upload",
    );
    const indexedRefs = deduplicateReferences([
      ...candidate.assets,
      ...livePins.map(({ ref }) => ref),
    ]);
    const indexed = livePins.length === 0
      ? initial
      : await this.options.ledger.quotaSnapshot(
        candidate.scope,
        indexedRefs,
      );
    const indexedByDigest = new Map(
      indexed.memberships.map((membership) => [
        membership.digest,
        membership,
      ]),
    );
    let scopeBytes = indexed.scopeBytes;
    let deviceBytes = indexed.deviceBytes;
    const pendingDevice = new Map<string, ArtifactRef>();
    const pendingScope = new Map<string, ArtifactRef>();
    for (const pin of livePins) {
      addReference(pendingDevice, pin.ref);
      if (pin.scope === key) addReference(pendingScope, pin.ref);
    }
    for (const ref of candidate.assets) {
      addReference(pendingDevice, ref);
      addReference(pendingScope, ref);
    }
    for (const ref of pendingDevice.values()) {
      const membership = indexedByDigest.get(ref.digest);
      if (
        membership?.retained !== true &&
        membership?.deviceCounted !== true
      ) {
        deviceBytes += ref.bytes;
      }
    }
    for (const ref of pendingScope.values()) {
      const membership = indexedByDigest.get(ref.digest);
      if (
        membership?.retained !== true &&
        membership?.scopeCounted !== true
      ) {
        scopeBytes += ref.bytes;
      }
    }
    if (scopeBytes > this.#scopeQuotaBytes) {
      throw new RangeError("Surface asset scope quota exceeded");
    }
    if (deviceBytes > this.#deviceQuotaBytes) {
      throw new RangeError("Surface asset device quota exceeded");
    }
  }

  async #revokeIds(
    grantIds: readonly string[],
    reason: RevokedRecord["reason"],
  ): Promise<void> {
    for (const grantId of new Set(grantIds)) {
      const grant = await this.options.ledger.findActiveGrant(grantId);
      if (!grant) continue;
      await this.#appendLedger({
        t: "asset-grant-revoked",
        grantId,
        reason,
      });
    }
  }

  async #retireExpired(now: number): Promise<void> {
    const current = await this.options.ledger.nextActiveGrantExpiry();
    if (current === undefined || Date.parse(current) > now) return;
    await this.#persistTimeFrontier(now);
    const next = await this.options.ledger.nextActiveGrantExpiry();
    if (next !== undefined && Date.parse(next) <= now) {
      throw new Error("Surface grant expiry projection did not advance");
    }
  }

  async #drainAdoptedCleanup(
    limit: number,
  ): Promise<{
    readonly processed: number;
    readonly removed: number;
    readonly hasMore: boolean;
  }> {
    const candidates = await this.options.ledger.adoptedTemporary(limit);
    let removed = 0;
    let processed = 0;
    let hasMore = candidates.length === limit;
    for (const ref of candidates) {
      if (this.#hasPin(ref.digest)) continue;
      try {
        // 与过期临时件走同一条受治理删除路径。同一类物理删除在同一个文件里分成
        // 受治理与不受治理两条,正是本单元反复裁决的合同分叉。
        const discarded = await this.#discardTemporary(ref);
        // 记账紧跟物理副作用:出账晚于下一步,而下一步(权威状态更新)自己也会
        // 取容量、也会背压,那个插点上文件已经删了、报告却说没删。
        if (discarded.partial || discarded.complete) removed += 1;
        if (!(await this.options.ledger.markTemporaryRemoved(ref))) {
          hasMore = true;
        }
      } catch (error) {
        // 顺带清理是可推迟的维护:候选来自耐久的 adopted 集合,本轮不做,下一轮
        // GC 会捡起。把容量背压上抛会让接管与 pin 释放这些业务路径因为一次维护
        // 拿不到容量而失败。判据复用单源实现,不在这里重写。
        if (maintenanceRetryDelayMs(error) === undefined) throw error;
        return { processed, removed, hasMore: true };
      }
      processed += 1;
    }
    return { processed, removed, hasMore };
  }

  async #appendLedger(
    record: RevokedRecord | FrontierRecord,
  ): Promise<void> {
    try {
      const result = await this.options.ledger.append(record);
      this.#time.advanceDurable(result.durableTime);
    } catch (error) {
      this.#recovered = false;
      throw error;
    }
  }

  async #persistTimeFrontier(timestamp: number): Promise<boolean> {
    if (!this.#time.needsDurableAdvance(timestamp)) return false;
    await this.#appendLedger({
      t: "authority-time-frontier",
      frontier: new Date(timestamp).toISOString(),
    });
    return true;
  }

  async #finishPin(pin: OperationPin): Promise<void> {
    // pin 释放只改变 GC 的资格；耐久候选留给唯一 GC owner 在下一轮消费。
    this.#pins.delete(pin.id);
  }

  #hasPin(digest: string): boolean {
    for (const pin of this.#pins.values()) {
      if (pin.ref.digest === digest) return true;
    }
    return false;
  }

  async #promoteTemporary(ref: ArtifactRef): Promise<void> {
    if (await this.options.artifacts.has(ref)) return;
    await this.options.artifacts.putVerifiedStream(
      ref,
      readArtifact(this.options.temporaryArtifacts, ref),
    );
  }

}

function hasDurableArtifact(progress: ArtifactReceiveProgress): boolean {
  return progress.complete || progress.receivedBytes > 0;
}

class NonRegressingAuthorityClock {
  #durableFloor = 0;
  #anchorTime = 0;
  #anchorMonotonic = 0;
  #lastMonotonic = 0;
  #initialized = false;

  constructor(
    private readonly wallClock: () => string,
    private readonly monotonicClock: () => number,
  ) {}

  reset(durableTime?: string): void {
    const wall = Date.parse(canonicalTime(this.wallClock(), "Authority wall clock"));
    const monotonic = this.#readMonotonic();
    const snapshotFloor = durableTime === undefined
      ? 0
      : Date.parse(canonicalTime(durableTime, "Authority durable time frontier"));
    const carriedTime = this.#carriedTime(monotonic);
    this.#durableFloor = Math.max(this.#durableFloor, snapshotFloor);
    this.#reanchor(monotonic, Math.max(wall, this.#durableFloor, carriedTime));
  }

  observe(): { readonly ms: number; readonly iso: string } {
    if (!this.#initialized) this.reset();
    const wall = Date.parse(canonicalTime(this.wallClock(), "Authority wall clock"));
    const monotonic = this.#readMonotonic();
    if (monotonic < this.#lastMonotonic) {
      throw new Error("Authority monotonic clock moved backwards");
    }
    const elapsed = Math.floor(monotonic - this.#anchorMonotonic);
    const effective = Math.max(
      wall,
      this.#anchorTime + elapsed,
      this.#durableFloor,
    );
    this.#anchorTime = effective;
    this.#anchorMonotonic = monotonic;
    this.#lastMonotonic = monotonic;
    return { ms: effective, iso: new Date(effective).toISOString() };
  }

  advanceDurable(value: string): void {
    const timestamp = Date.parse(
      canonicalTime(value, "Authority durable time frontier"),
    );
    const monotonic = this.#readMonotonic();
    const carriedTime = this.#carriedTime(monotonic);
    this.#durableFloor = Math.max(this.#durableFloor, timestamp);
    this.#reanchor(
      monotonic,
      Math.max(carriedTime, this.#durableFloor),
    );
  }

  needsDurableAdvance(timestamp: number): boolean {
    return timestamp > this.#durableFloor;
  }

  #readMonotonic(): number {
    const value = this.monotonicClock();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("Authority monotonic clock must be a finite non-negative number");
    }
    return value;
  }

  #carriedTime(monotonic: number): number {
    if (!this.#initialized) return 0;
    if (monotonic < this.#lastMonotonic) {
      throw new Error("Authority monotonic clock moved backwards");
    }
    return this.#anchorTime + Math.floor(monotonic - this.#anchorMonotonic);
  }

  #reanchor(monotonic: number, effectiveTime: number): void {
    this.#anchorTime = effectiveTime;
    this.#anchorMonotonic = monotonic;
    this.#lastMonotonic = monotonic;
    this.#initialized = true;
  }
}

// 耐久申请键的唯一编码:coordinator 热索引与 ledger 冷查询共用,禁止另造。
export function surfaceAssetRequestKey(
  scope: SurfaceAssetScope,
  surfacePrincipal: string,
  requestId: string,
): string {
  return canonicalize([scope, surfacePrincipal, requestId]);
}

const requestKey = surfaceAssetRequestKey;

function scopeKey(scope: SurfaceAssetScope): string {
  return canonicalize(scope);
}

function addReference(
  refs: Map<string, ArtifactRef>,
  ref: ArtifactRef,
): void {
  const current = refs.get(ref.digest);
  if (current && current.bytes !== ref.bytes) {
    throw new TypeError(
      "The same surface asset digest cannot declare different byte counts",
    );
  }
  refs.set(ref.digest, ref);
}

function deduplicateReferences(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byDigest = new Map<string, ArtifactRef>();
  for (const ref of refs) addReference(byDigest, ref);
  return [...byDigest.values()];
}

async function* readArtifact(
  artifacts: MutableArtifactStore,
  ref: ArtifactRef,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < ref.bytes; offset += DEFAULT_ARTIFACT_CHUNK_BYTES) {
    yield await artifacts.readRange(
      ref,
      offset,
      Math.min(DEFAULT_ARTIFACT_CHUNK_BYTES, ref.bytes - offset),
    );
  }
  if (ref.bytes === 0) yield new Uint8Array();
}

function canonicalTime(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function assertPositiveBudget(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}
