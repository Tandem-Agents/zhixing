import { createHash, randomBytes } from "node:crypto";
import { open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  CheckpointStreamRecord,
  DeviceIdentity,
  DeviceRole,
  HomeTrustEvent,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  PairingStreamRecord,
  RecoveryActivationPlan,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  ArtifactLifecycleIndex,
  collectArtifactRefs,
  FileArtifactStore,
  FileAuthorityCommitLog,
  type ArtifactCheckpointRetentionPort,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { credentialExposureIndex } from "@zhixing/mesh/credential-exposure";
import { readCheckpointLifecycle } from "@zhixing/mesh/checkpoint-service";
import type { DeviceCapacityArbiterPort, StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { ensureDurableDirectory, SerialTaskQueue, syncDirectory } from "@zhixing/core/persistence";
import {
  MeshEndpointDirectory,
  validateMeshEndpointDescriptor,
} from "@zhixing/mesh/bootstrap";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  validateDeviceTrustRoot,
} from "@zhixing/mesh/device-identity";
import {
  homeTrustEventDigest,
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  replayTrustChain,
  type TrustProjection,
  verifyHistoricalHomeTrustRecord,
  verifyHomeTrustRecord,
  CURRENT_TRUST_PROJECTION_ID, LEGACY_TRUST_RECORD_MESSAGE, readCurrentTrust, readCurrentTrustRecord,
  readLegacyClosedTrust, readVerifiedTrustProgress, readTrustReconciliationPage, readTrustEventByDigest,
  readVerifiedTrustIssuer, readCurrentTrustMember, type CurrentTrustProjection, type HistoricalHomeTrustRecord,
  EMPTY_TRUST_STREAM_FOLD, foldTrustStreamRecord, readTrustBranchProgress, readSupersededTrustEvents,
  readTrustProjectionAt, readStagedTrustBranch, readTrustEventAt, readTrustEventsAfter, readRevokedTrustMemberAt, trustBranchAdoptionId,
  type HomeTrustBranchAdoptedRecord, type HomeTrustBranchStagedRecord, type TrustStreamFold,
} from "@zhixing/mesh/trust-chain";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import type { HomeDiscoveryLocalChain } from "@zhixing/mesh/home-discovery";
import type {
  BootstrapAuthorityPort,
  PairingAtomicCommit,
  PairingAttemptAdmission,
  PairingAttemptDecision,
  PairingAuthorityPort,
  PairingCommitReceipt,
  PairingCommitReplay,
  RecoveryActivationAtomicCommit,
  RecoveryActivationReplay,
} from "@zhixing/mesh/bootstrap-authority";
import {
  checkpointEnvelopeArtifact,
  checkpointPackageFromChunks,
  readCheckpointChunk,
  type CheckpointPackage,
} from "@zhixing/mesh/checkpoint";
import { validateRecoveryActivationPlan } from "@zhixing/mesh/bootstrap-authority";
import { pairingOfferDigest } from "@zhixing/mesh/pairing";
import type {
  MeshBootstrapCompletionPersistencePort,
  MeshEndpointDirectoryPersistencePort,
  MeshTransportPeerDirectoryPersistencePort,
} from "./mesh-bootstrap-projection.js";
import { createSurfaceAssetStagingInfrastructure } from "./surface-asset-staging-infrastructure.js";
import type { HomeAuthoritySourcesLease } from "./home-authority-sources.js";

// 流里较早的快照可能是 v1 历史帧；新写入的一律是 v2
type TrustStreamRecord =
  | { readonly t: "home-trust-event"; readonly event: HomeTrustEvent }
  | { readonly t: "home-trust-record"; readonly record: HomeTrustRecord | HistoricalHomeTrustRecord }
  | HomeTrustBranchStagedRecord
  | HomeTrustBranchAdoptedRecord;

/** 分支接续每页暂存的事件数上限：单页受原生帧约束，页数不限。 */
const TRUST_BRANCH_PAGE_EVENTS = 64;

const FULL_AUTHORITY_CHECKPOINT_SCOPE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);
const MAX_MATERIALIZED_LEGACY_CHECKPOINT_BYTES = 16 * 1024 * 1024;

interface PersistedEndpointDirectory {
  readonly v: 1;
  readonly descriptors: readonly MeshEndpointDescriptor[];
}

interface PersistedTransportPeer {
  readonly v: 1;
  readonly peer: TrustedMeshPeer;
}

import { bindConversationAnchorTenure } from './conversation-anchor-tenure.js';
import { registerAnchorInstallationIndex } from "./anchor-installation-index.js";
import { registerHomeRouteMaterialIndex } from "./home-route-material.js";
import { registerSupersededTrustReportIndex } from "./superseded-trust-report.js";
import {
  readMemberTransport,
  recordMemberEndpoint,
  recordMemberTransport,
  registerMemberConnectionDirectory,
} from "./member-connection-directory.js";

export interface FileMeshBootstrapStoreOptions {
  readonly records?: import("@zhixing/core/logging").LogRecordPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly sources?: HomeAuthoritySourcesLease;
}

export interface RecoveryRootActivationReplay {
  readonly checkpointId: string;
  readonly event: Extract<RecoveryActivationPlan, { kind: "establish" }>["rootEvent"];
  /** 激活那一帧入链的签名快照：较早的激活是 v1 历史帧 */
  readonly record: HomeTrustRecord | HistoricalHomeTrustRecord;
}

/** Durable device-domain bootstrap state sharing the authority log's trust stream. */
export class FileMeshBootstrapStore
  implements
    MeshEndpointDirectoryPersistencePort,
    MeshTransportPeerDirectoryPersistencePort,
    MeshBootstrapCompletionPersistencePort
{
  readonly #log: FileAuthorityCommitLog;
  readonly #artifacts: FileArtifactStore;
  readonly #endpointFile: string;
  readonly #peerDirectory: string;
  readonly #completionFile: string;
  readonly #openCheckpointLifecycle: () => ArtifactLifecycleIndex;
  #checkpointLifecycle: ArtifactLifecycleIndex | undefined;
  #ownedCheckpointLifecycle: ArtifactLifecycleIndex | undefined;
  readonly #endpointWrites = new SerialTaskQueue();
  readonly #sources: HomeAuthoritySourcesLease | undefined;

  /**
   * 生产入口：经统一 home 权威入口打开。写者与本进程其他写者共享同一组物理日志 owner；
   * readOnly 只读取已验事实，不创建权威文件、不写派生缓存。
   */
  static async open(rootDir: string, issuerKey: DeviceKey | undefined, options: Omit<FileMeshBootstrapStoreOptions, "sources"> & {
    readonly secretStore?: SecretStorePort;
    readonly readOnly?: boolean;
    readonly deviceCapacity?: DeviceCapacityArbiterPort;
  }): Promise<FileMeshBootstrapStore> {
    const { openHomeAuthoritySources } = await import("./home-authority-sources.js");
    const sources = await openHomeAuthoritySources({
      home: rootDir,
      secretStore: options.secretStore,
      readOnly: options.readOnly,
      records: options.records,
      storageMaintenance: options.storageMaintenance,
      deviceCapacity: options.deviceCapacity,
    });
    try {
      return new FileMeshBootstrapStore(rootDir, issuerKey, { ...options, sources });
    } catch (error) {
      await sources.close();
      throw error;
    }
  }

  constructor(
    readonly rootDir: string,
    issuerKey?: DeviceKey,
    options: FileMeshBootstrapStoreOptions = {},
  ) {
    this.issuerKey = issuerKey;
    this.#sources = options.sources;
    const distributedRoot = path.join(path.resolve(rootDir), "distributed-runtime");
    this.#artifacts = options.sources?.sources.artifacts ?? new FileArtifactStore(path.join(distributedRoot, "artifacts"));
    this.#log = options.sources?.sources.authority ?? new FileAuthorityCommitLog(
      path.join(distributedRoot, "authority"),
      this.#artifacts,
      { storageMaintenance: options.storageMaintenance, records: options.records, startupProofs: true },
    );
    credentialExposureIndex(this.#log);
    bindConversationAnchorTenure(this.#log);
    // 当前安装指针：迁居与灾备的安装、收尾凭据都写在这本日志上，首次写入前登记
    registerAnchorInstallationIndex(this.#log);
    // 成员连接目录与家级路由材料的密封记录：随迁居前缀与完整检查点交给继任值班设备
    registerMemberConnectionDirectory(this.#log);
    registerHomeRouteMaterialIndex(this.#log);
    registerSupersededTrustReportIndex(this.#log);
    // 检查点保留用到时才取索引。经写者统一入口时与资产权威共用同一个生命周期索引（源集合固定为
    // 两本权威日志），由入口停止；源集合不同的实例交替打开同一目录会互相判失配、整段重放。只读
    // 入口与不经统一入口的测试保持自建。
    const shared = options.sources && !options.sources.sources.readOnly ? options.sources.sources : undefined;
    this.#openCheckpointLifecycle = () => shared?.assetLifecycle().lifecycle ?? (() => {
      const staging = createSurfaceAssetStagingInfrastructure({
        distributedRoot,
        storageMaintenance: options.storageMaintenance,
      });
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(distributedRoot, "derived"),
        logs: [this.#log],
        artifacts: this.#artifacts,
        temporaryArtifacts: staging.temporaryArtifacts,
        temporaryPresence: staging.presence,
        receiver: staging.recovery,
        storageMaintenance: options.storageMaintenance,
        maintenanceResourceId: this.#artifacts.rootDir,
        // 统一入口提供的日志由其 owner 停止；只有自建日志随本存储一起停止。
        ownsSourceLogs: !options.sources,
      });
      this.#ownedCheckpointLifecycle = lifecycle;
      return lifecycle;
    })();
    this.#endpointFile = path.join(distributedRoot, "mesh-endpoints.json");
    this.#peerDirectory = path.join(distributedRoot, "mesh-peers");
    this.#completionFile = path.join(distributedRoot, "mesh-bootstrap-completions.json");
  }

  issuerKey?: DeviceKey;

  bindIssuerKey(key: DeviceKey): void {
    this.issuerKey = key;
  }

  async stopStorageMaintenance(): Promise<void> {
    // 共用的生命周期索引随统一入口最后一个持有者关闭而停止；自建的随本存储停止。
    await this.#ownedCheckpointLifecycle?.stopStorageMaintenance();
    if (this.#sources) await this.#sources.close();
    else await this.#log.stopStorageMaintenance();
  }

  authoritySources() { return this.#sources?.sources; }

  async loadCurrentTrust(): Promise<CurrentTrustProjection | undefined> {
    if (this.#sources) return this.#sources.sources.currentTrust();
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
      async current => ({ kind: "return", value: await readCurrentTrust(current) }))).value;
  }

  /** 按事件摘要精确读一条已入链的信任事件，不整读信任流。 */
  async trustEventByDigest(digest: string): Promise<HomeTrustEvent | undefined> {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
      async current => ({ kind: "return", value: await readTrustEventByDigest(current, digest) }))).value;
  }

  /** 只读入口在 home 尚未建立权威日志时不创建它，信任状态即为不存在。 */
  #authorityAbsent(): boolean {
    return this.#sources?.sources.authorityPresent() === false;
  }

  authorityLog(): FileAuthorityCommitLog {
    return this.#log;
  }

  artifactStore(): FileArtifactStore {
    return this.#artifacts;
  }

  checkpointRetention(): ArtifactCheckpointRetentionPort {
    return this.#checkpointLifecycle ??= this.#openCheckpointLifecycle();
  }

  /** 某目标最新的根激活 created，以及它是否已在该目标上验证（按键读 checkpoint 生命周期投影，不重放整条流）。 */
  latestRootActivation(targetId: string): Promise<{ readonly created: Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>; readonly verified: boolean } | undefined> {
    return readCheckpointLifecycle(this.#log, async (view) => {
      const created = await view.latestRootActivation(targetId);
      return created ? { created, verified: (await view.verified(created.checkpointId, targetId)) !== undefined } : undefined;
    });
  }

  /** 某目标最新的、尚未在任何目标上验证的根激活 created。 */
  latestOpenRootActivation(targetId: string): Promise<Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> | undefined> {
    return readCheckpointLifecycle(this.#log, (view) => view.latestOpenRootActivation(targetId));
  }

  /** 已验信任链链头的 issuer 与任期，按键读，不要求签名记录已闭合（迁居源端提交后的启动恢复用）。 */
  async loadVerifiedTrustIssuer() {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
      async view => ({ kind: 'return', value: await readVerifiedTrustIssuer(view) }))).value;
  }

  async trustReconciliationProgress() {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
      async view => ({ kind: 'return', value: await readVerifiedTrustProgress(view) }))).value;
  }

  async trustReconciliationPage(input: Parameters<typeof readTrustReconciliationPage>[2]) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view, context) => ({
      kind: 'return', value: await readTrustReconciliationPage(view, point => context.readEnvelopeAt!(point), input),
    }))).value;
  }

  /**
   * 合法灾备后离线成员接续当前权威分支（发现已验过分叉规则与根签提交证明）：按接续标识分页暂存新分支，
   * 已暂存的跳过（可中断续做）；完整时最后一条原子发布，未完时只暂存。旧分支事件留在 WAL 与 superseded 键里，
   * 不删除。从进度接着的会话看不到分支首条，接续标识取自进度。返回接续标识。
   */
  async adoptTrustBranch(verified: {
    readonly ancestor?: HomeTrustRecord['chainHead'];
    readonly pages: readonly { readonly events: readonly HomeTrustEvent[]; readonly record?: HomeTrustRecord | HistoricalHomeTrustRecord }[];
    readonly recoveryCommits: readonly unknown[];
    readonly complete: boolean;
    readonly adoptionId?: string;
    /** 原子发布之前（暂存已齐）：例如写下待上报项并让本机限制先生效。 */
    readonly beforePublish?: (adoptionId: string) => Promise<void>;
  }): Promise<string> {
    const ancestor = verified.ancestor;
    if (!ancestor) throw new TypeError('Trust branch adoption requires a forked discovery');
    const branch = verified.pages.flatMap((page) => page.events).filter((event) => event.seq > ancestor.seq);
    const record = verified.complete ? verified.pages.at(-1)?.record : undefined;
    if (verified.complete && (!record || record.v !== 2)) throw new Error('Discovered trust branch does not end at a current signed snapshot');
    const progress = async (adoptionId?: string) => (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readTrustBranchProgress(view, adoptionId),
    }))).value;
    const superseded = (await progress()).head;
    if (!superseded) throw new Error('Trust branch adoption requires a local trust chain');
    if (!verified.adoptionId && branch[0]?.seq !== ancestor.seq + 1) {
      throw new Error('Discovered trust branch does not start at its fork');
    }
    const adoptionId = verified.adoptionId ?? trustBranchAdoptionId(ancestor, superseded, homeTrustEventDigest(branch[0]!));
    const current = await progress(adoptionId);
    if (current.adopted) return adoptionId;
    if (verified.adoptionId && current.stagedThrough === undefined) throw new Error('Trust branch staging to continue is missing');
    const remaining = branch.filter((event) => event.seq > (current.stagedThrough ?? ancestor.seq));
    const append = (body: TrustStreamRecord) => this.#log.transactDurableProjection<TrustStreamRecord, void>(CURRENT_TRUST_PROJECTION_ID, async () => ({
      kind: 'append', entries: [{ stream: 'trust', body }], value: undefined,
    }));
    for (let index = 0; index < remaining.length; index += TRUST_BRANCH_PAGE_EVENTS) {
      const events = remaining.slice(index, index + TRUST_BRANCH_PAGE_EVENTS);
      const transitions = new Set(events
        .filter((event) => event.body.t === 'issuer-transition' && event.body.reason === 'disaster-recovery')
        .map((event) => homeTrustEventDigest(event)));
      await append({
        t: 'home-trust-branch-staged', adoptionId, ancestor, superseded, events,
        recoveryCommits: verified.recoveryCommits.filter((commit) =>
          transitions.has(String((commit as { readonly trustTransitionDigest?: unknown }).trustTransitionDigest))),
      });
    }
    // 未完的会话只暂存；完整时以链头的当前签名快照原子发布
    if (!record || record.v !== 2) return adoptionId;
    await verified.beforePublish?.(adoptionId);
    await append({ t: 'home-trust-branch-adopted', adoptionId, record });
    this.#sources?.sources.invalidateKnownTrust();
    return adoptionId;
  }

  /** 本机已验证信任链的链头（分支接续与发现进度以它判断是否仍是同一条本机链）。 */
  async localTrustHead() {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: (await readTrustBranchProgress(view)).head,
    }))).value;
  }

  /** 进行中的分支暂存（祖先、被替代链头、已暂存到的投影）。 */
  async stagedTrustBranch(adoptionId: string) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readStagedTrustBranch(view, adoptionId),
    }))).value;
  }

  /** 某次分支接续是否已原子发布（按键读）。 */
  async trustBranchAdopted(adoptionId: string): Promise<boolean> {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: (await readTrustBranchProgress(view, adoptionId)).adopted,
    }))).value;
  }

  /** 本机链上 seq 处的事件（按键读）。 */
  async trustEventAt(seq: number) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readTrustEventAt(view, seq),
    }))).value;
  }

  /** 本机链上 afterSeq 之后的至多 limit 条事件（按键范围读）。 */
  async trustEventsAfter(afterSeq: number, limit: number) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readTrustEventsAfter(view, afterSeq, limit),
    }))).value;
  }

  /** 家级发现的本机链端口：链头、按序号或摘要读事件、某点投影，全部按键读，不整读信任链。 */
  async discoveryLocalChain(): Promise<HomeDiscoveryLocalChain | undefined> {
    const head = await this.localTrustHead();
    if (!head) return undefined;
    return {
      head,
      eventAt: (seq) => this.trustEventAt(seq),
      eventByDigest: (digest) => this.trustEventByDigest(digest),
      projectionAt: async (point) => {
        const projection = await this.trustProjectionAt(point);
        if (!projection) throw new Error('Trust point is not on the local chain');
        return projection;
      },
      revokedMemberAt: (deviceId, seq) => this.revokedTrustMemberAt(deviceId, seq),
    };
  }

  /** seq 之时已撤销的设备（按键读成员行）；以收窄投影接着验时补齐事件引用到的历史成员。 */
  async revokedTrustMemberAt(deviceId: string, seq: number) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readRevokedTrustMemberAt(view, deviceId, seq),
    }))).value;
  }

  /** 当前视图里的一个成员（含已撤销与待重新配对，按键读）。 */
  async trustMember(deviceId: string) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readCurrentTrustMember(view, deviceId),
    }))).value;
  }

  /** 被取代旧分支上 afterSeq 之后的至多 limit 条原签名事件。 */
  async supersededTrustEvents(adoptionId: string, afterSeq: number, limit: number) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readSupersededTrustEvents(view, adoptionId, afterSeq, limit),
    }))).value;
  }

  /** 本机链上某一点的投影：按摘要精确定位、按键读到该点重放；该点不在本机链上返回 undefined。 */
  async trustProjectionAt(point: HomeTrustRecord['chainHead']) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: 'return' as const, value: await readTrustProjectionAt(view, point),
    }))).value;
  }

  /** 发现入口：客户端给出的候选点里第一个落在本机链上的点（按事件摘要精确读，不整读信任流）。 */
  async findTrustBase(points: readonly HomeTrustRecord['chainHead'][]): Promise<HomeTrustRecord['chainHead'] | undefined> {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => {
      for (const point of points) {
        const event = await readTrustEventByDigest(view, point.eventDigest);
        if (event && event.seq === point.seq) return { kind: 'return' as const, value: { seq: point.seq, eventDigest: point.eventDigest } };
      }
      return { kind: 'return' as const, value: undefined };
    })).value;
  }

  /** 发现入口的后缀分页：沿用对齐分页（停在原签名记录边界），到当前记录链头即完成。 */
  async discoveryTrustPage(homeId: string, from: HomeTrustRecord['chainHead']) {
    const page = await this.trustReconciliationPage({ homeId, chainHead: from });
    const last = page.events.at(-1)?.seq ?? from.seq;
    return {
      events: page.events,
      ...(page.record ? { record: page.record } : {}),
      complete: page.done && last >= page.latest.seq,
    };
  }

  async reconcileTrustPage(input: { homeId: string; previous: HomeTrustRecord['chainHead']; events: readonly HomeTrustEvent[];
    record: HomeTrustRecord | HistoricalHomeTrustRecord }) {
    // One original signed trust group, subject to the existing native WAL
    // frame bound. Never durably expose transport pages without their record.
    if (Buffer.byteLength(canonicalize(input)) > 16 * 1024 * 1024) throw new TypeError('Trust reconciliation group exceeds the native frame bound');
    const result = await this.#log.transactDurableProjection<TrustStreamRecord, boolean>(CURRENT_TRUST_PROJECTION_ID, async view => {
      const current = await readVerifiedTrustProgress(view);
      if (!current || current.homeId !== input.homeId) throw new TypeError('Trust reconciliation page belongs to another home');
      if (current.chainHead.seq > input.previous.seq) return { kind: 'return', value: false };
      if (canonicalize(current.chainHead) !== canonicalize(input.previous)) throw new TypeError('Trust reconciliation page does not continue the exact prefix');
      let previous = input.previous;
      for (const event of input.events) {
        if (event.homeId !== input.homeId || event.seq !== previous.seq + 1 || event.prevEventDigest !== previous.eventDigest) throw new TypeError('Trust reconciliation page skips or conflicts with an event');
        previous = { seq: event.seq, eventDigest: homeTrustEventDigest(event) };
      }
      if (input.record.homeId !== input.homeId || canonicalize(input.record.chainHead) !== canonicalize(previous)) throw new TypeError('Signed trust record does not close the delivered prefix');
      // 同一链头：只有本机只由 v1 历史帧闭合、对端给出 v2 当前快照时才补上（一次性接续）
      if (!input.events.length && current.complete && (current.currentRecord || input.record.v !== 2)) {
        return { kind: 'return', value: true };
      }
      // The existing current-trust reducer verifies every original signature,
      // transition, member change and final signed record before WAL commit.
      return { kind: 'append', entries: [
        ...input.events.map(event => ({ stream: 'trust', body: { t: 'home-trust-event' as const, event } })),
        { stream: 'trust', body: { t: 'home-trust-record' as const, record: input.record } },
      ], value: true };
    });
    if (result.commit) this.#sources?.sources.invalidateKnownTrust();
    return result.value;
  }

  async loadTrustEvents(): Promise<readonly HomeTrustEvent[]> {
    const records = await this.#log.readStream<TrustStreamRecord>("trust");
    let fold = EMPTY_TRUST_STREAM_FOLD;
    for (const { body } of records) fold = foldTrustStreamRecord(fold, body);
    const events = [...fold.events];
    if (events.length > 0) replayTrustChain(events);
    return events;
  }

  async loadTrustProjection(): Promise<TrustProjection | undefined> {
    const events = await this.loadTrustEvents();
    return events.length === 0 ? undefined : replayTrustChain(events);
  }

  /**
   * 当前签名信任记录。信任投影在每条信任事件/记录提交时已沿链自校验并核对签名记录与全部
   * 成员，这里按投影保存的定位精确读取那一帧，不再重放整条信任链。没有信任链时为 undefined，
   * 记录缺失或落后于链头时与旧实现同样拒绝。显式整链审计仍用 loadTrustEvents。
   */
  async loadTrustRecord(): Promise<HomeTrustRecord | undefined> {
    if (this.#authorityAbsent()) return undefined;
    // 只读访问者没有缓存密钥，派生索引只能在内存重建；与 C8 严格路径相同，只按流读取信任记录并整链核对。
    if (this.#sources?.sources.readOnly && !this.#sources.sources.integrity) return this.#loadTrustRecordByReplay();
    try {
      const result = await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
        async (current, context) => ({
          kind: "return",
          value: await readCurrentTrustRecord(current, (checkpoint) => context.readEnvelopeAt!(checkpoint)),
        }));
      return result.value;
    } catch (error) {
      // 链头只由 v1 历史帧闭合：持当前签发密钥时就地补签一次，否则等对齐取回
      if (!(error instanceof Error) || error.message !== LEGACY_TRUST_RECORD_MESSAGE || !this.issuerKey) throw error;
      const continued = await this.continueCurrentTrustRecord(this.issuerKey);
      if (!continued) throw error;
      return continued;
    }
  }

  /**
   * 开发资料的一次性接续：链头只由 v1 历史帧闭合时，持当前签发密钥的设备为同一链头补签 v2 快照。
   * 只读当前视图（链头与 active 目录）；已有当前快照或本机不是当前签发者时不写，返回 undefined。
   */
  async continueCurrentTrustRecord(issuerKey: DeviceKey): Promise<HomeTrustRecord | undefined> {
    const result = await this.#log.transactDurableProjection<TrustStreamRecord, HomeTrustRecord | undefined>(
      CURRENT_TRUST_PROJECTION_ID,
      async (view) => {
        const current = await readLegacyClosedTrust(view);
        if (!current || current.issuer.issuerKeyId !== issuerKey.deviceId) return { kind: "return", value: undefined };
        const record = buildHomeTrustRecord(current, issuerKey);
        return { kind: "append", entries: [{ stream: "trust", body: { t: "home-trust-record", record } }], value: record };
      },
    );
    if (result.commit) this.#sources?.sources.invalidateKnownTrust();
    return result.value;
  }

  async #loadTrustRecordByReplay(): Promise<HomeTrustRecord | undefined> {
    const records = await this.#log.readStream<TrustStreamRecord>("trust");
    let fold = EMPTY_TRUST_STREAM_FOLD;
    for (const { body } of records) fold = foldTrustStreamRecord(fold, body);
    const events = fold.events;
    const latest = fold.record;
    if (events.length === 0) return undefined;
    const projection = replayTrustChain(events);
    // 只读访问者不能补签：最新快照仍是 v1 历史帧时与当前快照读者给出同一错误
    if (latest?.v === 1) throw new Error(LEGACY_TRUST_RECORD_MESSAGE);
    if (
      latest?.homeId === projection.homeId &&
      latest.trustEpoch === projection.trustEpoch &&
      latest.chainHead.seq === projection.chainHead.seq &&
      latest.chainHead.eventDigest === projection.chainHead.eventDigest
    ) {
      verifyHomeTrustRecord(latest, projection);
      return latest;
    }
    throw new Error("Home trust projection record is missing or stale");
  }

  async loadRecoveryRootActivationReplay(input: {
    readonly activationDigest: string;
    readonly targetId: string;
  }): Promise<RecoveryRootActivationReplay | undefined> {
    const snapshot = await this.#log.readSnapshot<RecoveryStreamRecord>();
    const matches: Array<{
      readonly lsn: number;
      readonly commit: RecoveryActivationAtomicCommit;
    }> = [];
    let trustFold = EMPTY_TRUST_STREAM_FOLD;

    for (const envelope of snapshot.commits) {
      for (const entry of envelope.entries) {
        const body = entry.body;
        if (entry.stream === "trust") {
          trustFold = foldTrustStreamRecord(trustFold, body);
          continue;
        }
        if (
          entry.stream === "checkpoint" &&
          body.t === "recovery-activation-committed" &&
          body.commit.plan.kind === "establish" &&
          protocolDigest("RecoveryActivationPlan", 1, body.commit.plan) === input.activationDigest &&
          body.commit.verification.targetId === input.targetId
        ) {
          matches.push({ lsn: envelope.lsn, commit: body.commit });
        }
      }
    }

    const trustEvents = trustFold.events;
    if (trustEvents.length === 0) return undefined;
    const current = replayTrustChain(trustEvents);
    if (current.recoveryActivationDigest !== input.activationDigest) return undefined;
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error("Recovery root activation replay identity is ambiguous");
    }

    const match = matches[0]!;
    const commit = match.commit;
    const plan = commit.plan;
    if (plan.kind !== "establish") {
      throw new Error("Recovery root activation replay is not an establishment plan");
    }
    const verification = commit.verification;
    const verified = commit.checkpointRecords[0];
    const expectedVerified: Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }> = {
      t: "checkpoint-verified",
      checkpointId: verification.checkpointId,
      recipientKeyId: verification.recipientKeyId,
      purpose: verification.purpose,
      targetId: verification.targetId,
      envelopeDigest: verification.envelopeDigest,
      verification,
    };
    if (
      verification.purpose.kind !== "root-activation" ||
      verification.purpose.activationDigest !== input.activationDigest ||
      verification.targetId !== input.targetId ||
      !verified ||
      canonicalize(verified) !== canonicalize(expectedVerified)
    ) {
      throw new Error("Recovery root activation commit evidence is inconsistent");
    }

    const activationEnvelope = snapshot.commits.find((envelope) => envelope.lsn === match.lsn);
    if (!activationEnvelope) {
      throw new Error("Recovery root activation commit envelope is missing");
    }
    const committed = activationEnvelope.entries.filter((entry) =>
      entry.stream === "checkpoint" &&
      entry.body.t === "recovery-activation-committed" &&
      canonicalize(entry.body.commit) === canonicalize(commit));
    const verifiedEvidence = activationEnvelope.entries.filter((entry) =>
      entry.stream === "checkpoint" &&
      canonicalize(entry.body) === canonicalize(expectedVerified));
    const activationEvents = activationEnvelope.entries.flatMap((entry) =>
      entry.stream === "trust" && entry.body.t === "home-trust-event"
        ? [entry.body.event]
        : []);
    const activationRecords = activationEnvelope.entries.flatMap((entry) =>
      entry.stream === "trust" && entry.body.t === "home-trust-record"
        ? [entry.body.record]
        : []);
    if (
      committed.length !== 1 ||
      verifiedEvidence.length !== 1 ||
      activationEvents.length !== 1 ||
      activationRecords.length !== 1 ||
      canonicalize(activationEvents[0]) !== canonicalize(plan.rootEvent)
    ) {
      throw new Error("Recovery root activation historical tuple is incomplete");
    }

    let historicalFold = EMPTY_TRUST_STREAM_FOLD;
    for (const envelope of snapshot.commits) {
      if (envelope.lsn > match.lsn) break;
      for (const entry of envelope.entries) {
        if (entry.stream === "trust") historicalFold = foldTrustStreamRecord(historicalFold, entry.body);
      }
    }
    const historical = replayTrustChain(historicalFold.events);
    const event = plan.rootEvent;
    const record = activationRecords[0]!;
    if (
      historical.chainHead.seq !== event.seq ||
      historical.chainHead.eventDigest !== homeTrustEventDigest(event)
    ) {
      throw new Error("Recovery root activation event is not the committed trust head");
    }
    // 激活那一帧的快照是历史帧：较早的激活按 v1 原规则验证
    verifyHistoricalHomeTrustRecord(record, historical);
    return { checkpointId: verification.checkpointId, event, record };
  }

  async initializeLocalHome(input: {
    readonly key: DeviceKey;
    readonly identity: DeviceIdentity;
    readonly roles: readonly DeviceRole[];
    readonly at?: string;
    readonly homeId?: string;
  }): Promise<{ readonly projection: TrustProjection; readonly record: HomeTrustRecord }> {
    const at = input.at ?? new Date().toISOString();
    const homeId = input.homeId ?? generateUlid();
    const result = await this.#log.transactProjection<
      readonly HomeTrustEvent[],
      TrustStreamRecord,
      { projection: TrustProjection; record: HomeTrustRecord }
    >(
      [],
      (events, record) => {
        if (record.body.t !== "home-trust-event") return events;
        const next = [...events, record.body.event];
        replayTrustChain(next);
        return next;
      },
      (events) => {
        if (events.length > 0) {
          const projection = replayTrustChain(events);
          const record = buildHomeTrustRecord(projection, input.key);
          return { kind: "return", value: { projection, record } };
        }
        const genesis = createTrustGenesisEvent({
          homeId,
          issuer: input.identity,
          signer: input.key,
          at,
        });
        let projection = replayTrustChain([genesis]);
        const roleChange = createSignedTrustEvent({
          current: projection,
          body: {
            t: "role-change",
            deviceId: input.identity.deviceId,
            roles: [...input.roles],
          },
          at,
          signer: input.key,
        });
        projection = applyTrustEvent(projection, roleChange);
        const record = buildHomeTrustRecord(projection, input.key);
        return {
          kind: "append",
          entries: [
            { stream: "trust", body: { t: "home-trust-event", event: genesis } },
            { stream: "trust", body: { t: "home-trust-event", event: roleChange } },
            { stream: "trust", body: { t: "home-trust-record", record } },
          ],
          value: { projection, record },
        };
      },
      { stream: "trust" },
    );
    return result.value;
  }

  async appendTrustEvent(input: {
    readonly event: HomeTrustEvent;
    readonly issuerKey?: DeviceKey;
    readonly record?: HomeTrustRecord;
  }): Promise<TrustProjection> {
    const result = await this.#log.transactProjection<
      TrustStreamFold,
      TrustStreamRecord,
      TrustProjection
    >(
      EMPTY_TRUST_STREAM_FOLD,
      (state, record) => foldTrustStreamRecord(state, record.body),
      ({ events }) => {
        if (events.length === 0) throw new Error("Trust chain genesis is missing");
        const current = replayTrustChain(events);
        const projection = applyTrustEvent(current, input.event);
        const record = input.record ??
          (input.issuerKey ? buildHomeTrustRecord(projection, input.issuerKey) : undefined);
        if (!record) throw new Error("Trust update requires its signed projection record");
        return {
          kind: "append",
          entries: [
            { stream: "trust", body: { t: "home-trust-event", event: input.event } },
            { stream: "trust", body: { t: "home-trust-record", record } },
          ],
          value: projection,
        };
      },
      { stream: "trust" },
    );
    return result.value;
  }

  async commitRecoveryRootLifecycle(input: {
    readonly events: readonly HomeTrustEvent[];
    readonly record: HomeTrustRecord | HistoricalHomeTrustRecord;
  }): Promise<void> {
    if (input.events.length < 1 || input.events.length > 2) {
      throw new TypeError("Recovery root lifecycle requires one or two trust events");
    }
    await this.#log.transactProjection<
      TrustStreamFold,
      TrustStreamRecord,
      void
    >(
      EMPTY_TRUST_STREAM_FOLD,
      (state, entry) => foldTrustStreamRecord(state, entry.body),
      (state) => {
        const exactEvents = state.events.slice(-input.events.length);
        if (state.record && canonicalize(exactEvents) === canonicalize(input.events)) {
          if (canonicalize(state.record) === canonicalize(input.record)) return { kind: "return", value: undefined };
          // 一次性接续之前入链的 v1 历史帧：同一链头的签名快照仍是精确重放
          if (input.record.v === 1) {
            verifyHistoricalHomeTrustRecord(input.record, replayTrustChain(state.events));
            return { kind: "return", value: undefined };
          }
        }
        if (state.events.length === 0) throw new Error("Recovery root lifecycle trust chain is missing");
        if (input.record.v !== 2) throw new TypeError("Recovery root lifecycle requires a current trust snapshot");
        let next = replayTrustChain(state.events);
        for (const event of input.events) next = applyTrustEvent(next, event);
        verifyHomeTrustRecord(input.record, next);
        return {
          kind: "append",
          entries: [
            ...input.events.map((event) => ({
              stream: "trust",
              body: { t: "home-trust-event" as const, event },
            })),
            { stream: "trust", body: { t: "home-trust-record" as const, record: input.record } },
          ],
          value: undefined,
        };
      },
      { stream: "trust" },
    );
  }

  /** Idempotently appends one already-authorized trust transition and its signed projection. */
  async reconcileTrustEvent(input: {
    readonly event: HomeTrustEvent;
    readonly record: HomeTrustRecord;
  }): Promise<TrustProjection> {
    const result = await this.#log.transactProjection<
      TrustStreamFold,
      TrustStreamRecord,
      TrustProjection
    >(
      EMPTY_TRUST_STREAM_FOLD,
      (state, logical) => foldTrustStreamRecord(state, logical.body),
      ({ events, record: latestRecord }) => {
        const recordHead = latestRecord?.chainHead;
        if (events.length === 0) throw new Error("Trust chain genesis is missing");
        const current = replayTrustChain(events);
        if (
          current.homeId === input.record.homeId &&
          current.trustEpoch === input.record.trustEpoch &&
          canonicalize(current.chainHead) === canonicalize(input.record.chainHead)
        ) {
          verifyHomeTrustRecord(input.record, current);
          if (recordHead && canonicalize(recordHead) === canonicalize(current.chainHead)) {
            return { kind: "return", value: current };
          }
          // 链头已在本机而签名记录没跟上（迁居源端提交时只追加了 issuer-transition 事件）：补上这条记录，
          // 本机前缀才完整，之后才能向新值班设备对齐信任
          return {
            kind: "append",
            entries: [{ stream: "trust", body: { t: "home-trust-record", record: input.record } }],
            value: current,
          };
        }
        const projection = applyTrustEvent(current, input.event);
        verifyHomeTrustRecord(input.record, projection);
        return {
          kind: "append",
          entries: [
            { stream: "trust", body: { t: "home-trust-event", event: input.event } },
            { stream: "trust", body: { t: "home-trust-record", record: input.record } },
          ],
          value: projection,
        };
      },
      { stream: "trust" },
    );
    return result.value;
  }

  /** Appends a peer-supplied trust suffix after replaying it against the local prefix. */
  async reconcileTrustSuffix(input: {
    readonly events: readonly HomeTrustEvent[];
    readonly record: HomeTrustRecord;
    readonly localDeviceId: string;
  }): Promise<TrustProjection> {
    const result = await this.#log.transactProjection<
      TrustStreamFold,
      TrustStreamRecord,
      TrustProjection
    >(
      EMPTY_TRUST_STREAM_FOLD,
      (state, logical) => foldTrustStreamRecord(state, logical.body),
      ({ events }) => {
        if (events.length === 0) throw new Error("Trust chain genesis is missing");
        const current = replayTrustChain(events);
        if (input.record.homeId !== current.homeId) {
          throw new Error("Peer trust suffix belongs to another home");
        }
        const suffix = input.events.filter((event) => event.seq > current.chainHead.seq);
        if (
          suffix.length !== input.events.length ||
          suffix.some((event, index) => event.seq !== current.chainHead.seq + index + 1)
        ) {
          throw new Error("Peer trust suffix does not continue the local prefix");
        }
        const projection = suffix.length === 0
          ? current
          : replayTrustChain([...events, ...suffix]);
        verifyHomeTrustRecord(input.record, projection);
        if (!input.record.members.some((member) =>
          member.device.deviceId === input.localDeviceId && member.state === "active")) {
          throw new Error("Peer trust suffix does not keep the local device active");
        }
        if (suffix.length === 0) {
          return { kind: "return", value: projection };
        }
        return {
          kind: "append",
          entries: [
            ...suffix.map((event) => ({
              stream: "trust",
              body: { t: "home-trust-event" as const, event },
            })),
            { stream: "trust", body: { t: "home-trust-record" as const, record: input.record } },
          ],
          value: projection,
        };
      },
      { stream: "trust" },
    );
    return result.value;
  }

  async importTrustBootstrap(input: {
    readonly events: readonly HomeTrustEvent[];
    readonly record: HomeTrustRecord;
    readonly localDeviceId: string;
  }): Promise<void> {
    if (input.events.length === 0) throw new Error("Trust bootstrap event chain is empty");
    const projection = replayTrustChain(input.events);
    verifyHomeTrustRecord(input.record, projection);
    if (
      input.record.chainHead.seq !== projection.chainHead.seq ||
      input.record.chainHead.eventDigest !== projection.chainHead.eventDigest ||
      !input.record.members.some((member) =>
        member.device.deviceId === input.localDeviceId && member.state === "active")
    ) {
      throw new Error("Trust bootstrap does not activate the local device");
    }
    await this.#log.transactProjection<TrustStreamFold, TrustStreamRecord, void>(
      EMPTY_TRUST_STREAM_FOLD,
      (state, logical) => foldTrustStreamRecord(state, logical.body),
      ({ events }) => {
        if (events.length > 0) {
          if (canonicalize(events) !== canonicalize(input.events)) {
            throw new Error("Local device already belongs to another trust chain");
          }
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [
            ...input.events.map((event) => ({
              stream: "trust",
              body: { t: "home-trust-event" as const, event },
            })),
            { stream: "trust", body: { t: "home-trust-record" as const, record: input.record } },
          ],
          value: undefined,
        };
      },
      { stream: "trust" },
    );
  }

  async markBootstrapComplete(peerDeviceId: string, offerId: string): Promise<void> {
    await this.#endpointWrites.run(async () => {
      const current = await readBootstrapCompletions(this.#completionFile);
      const existing = current[peerDeviceId];
      if (existing && existing !== offerId) {
        throw new Error("Mesh peer bootstrap already completed under another pairing offer");
      }
      await writeDurableJson(this.#completionFile, {
        ...current,
        [peerDeviceId]: offerId,
      });
    });
  }

  async bootstrapCompleted(peerDeviceId: string, offerId: string): Promise<boolean> {
    const current = await readBootstrapCompletions(this.#completionFile);
    return current[peerDeviceId] === offerId;
  }

  pairingAuthority(): PairingAuthorityPort {
    return new FilePairingAuthority(this.#log, this.issuerKey);
  }

  bootstrapAuthority(): BootstrapAuthorityPort {
    return new FileBootstrapAuthority(this.#log, this.#artifacts, this.issuerKey);
  }

  async loadEndpoints(): Promise<MeshEndpointDirectory> {
    let text: string;
    try {
      text = await readFile(this.#endpointFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new MeshEndpointDirectory();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Mesh endpoint directory is not valid JSON");
    }
    if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.descriptors)) {
      throw new Error("Mesh endpoint directory is invalid");
    }
    if (canonicalize(value) !== text) {
      throw new Error("Mesh endpoint directory is not canonical");
    }
    return new MeshEndpointDirectory(
      value.descriptors.map(validateMeshEndpointDescriptor),
    );
  }

  async acceptEndpoint(value: unknown): Promise<MeshEndpointDescriptor> {
    const accepted = await this.#endpointWrites.run(async () => {
      const directory = await this.loadEndpoints();
      const accepted = directory.accept(value);
      await writeDurableJson(this.#endpointFile, {
        v: 1,
        descriptors: directory.list(),
      } satisfies PersistedEndpointDirectory);
      return accepted;
    });
    // 调用方都已按发布者核过描述设备（端点服务按连接对端、配对按配对双方）；只为链上成员记目录
    const publisher = await this.#currentTrustMember(accepted.deviceId);
    if (publisher) await recordMemberEndpoint(this.#log, accepted, publisher.device);
    return accepted;
  }

  /**
   * 按设备精确读一份传输身份：启动、信任变更与终态解析都只读需要的那几份。本地没有时（继任值班设备
   * 上的成员）按成员连接目录精确读，且须与当前信任里该成员的公钥一致。
   */
  async transportPeer(deviceId: string): Promise<TrustedMeshPeer | undefined> {
    const local = await readTransportPeerFile(this.#transportPeerFile(deviceId), deviceId);
    if (local) return local;
    const member = await this.#currentTrustMember(deviceId);
    return member ? readMemberTransport(this.#log, deviceId, member.device) : undefined;
  }

  async #currentTrustMember(deviceId: string) {
    return (await this.#log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: "return" as const,
      value: await readCurrentTrustMember(view, deviceId),
    }))).value;
  }

  /** 已知对端清单：只供灾备、备份这类人工命令枚举，启动与常驻路径不调用。 */
  async listTransportPeers(): Promise<readonly TrustedMeshPeer[]> {
    let names: string[];
    try {
      names = await readdir(this.#peerDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const peers: TrustedMeshPeer[] = [];
    for (const name of names.sort()) {
      if (!TRANSPORT_PEER_FILE.test(name)) continue;
      const peer = await readTransportPeerFile(path.join(this.#peerDirectory, name));
      if (peer) peers.push(peer);
    }
    return peers.sort((left, right) =>
      left.identity.deviceId.localeCompare(right.identity.deviceId, "en-US"));
  }

  async acceptTransportPeer(peer: TrustedMeshPeer): Promise<void> {
    await this.#endpointWrites.run(async () => {
      const accepted = validateTransportPeer(peer);
      const file = this.#transportPeerFile(accepted.identity.deviceId);
      const existing = await readTransportPeerFile(file, accepted.identity.deviceId);
      if (existing && canonicalize(existing) !== canonicalize(accepted)) {
        throw new Error("Authenticated mesh peer transport identity changed");
      }
      if (!existing) {
        await writeDurableJson(file, {
          v: 1,
          peer: accepted,
        } satisfies PersistedTransportPeer);
      }
      // 同时记进成员连接目录：继任值班设备经迁居前缀拿到它，不必与每台成员重新配对
      await recordMemberTransport(this.#log, accepted);
    });
  }

  #transportPeerFile(deviceId: string): string {
    if (typeof deviceId !== "string" || deviceId.length === 0) {
      throw new TypeError("Mesh transport peer device id is invalid");
    }
    return path.join(
      this.#peerDirectory,
      `${createHash("sha256").update("zhixing:mesh-transport-peer:v1\0").update(deviceId).digest("hex")}.json`,
    );
  }
}

const TRANSPORT_PEER_FILE = /^[a-f0-9]{64}\.json$/u;

async function readTransportPeerFile(
  file: string,
  expectedDeviceId?: string,
): Promise<TrustedMeshPeer | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Mesh peer transport trust is not valid JSON");
  }
  if (!isRecord(value) || value.v !== 1 || Object.keys(value).sort().join(",") !== "peer,v") {
    throw new Error("Mesh peer transport trust is invalid");
  }
  if (canonicalize(value) !== text) {
    throw new Error("Mesh peer transport trust is not canonical");
  }
  const peer = validateTransportPeer(value.peer);
  if (expectedDeviceId !== undefined && peer.identity.deviceId !== expectedDeviceId) {
    throw new Error("Mesh peer transport trust is filed under another device");
  }
  return peer;
}

interface PairingProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly trustStaged?: TrustStreamFold["staged"];
  readonly attempts: ReadonlyMap<string, {
    readonly admission: PairingAttemptAdmission;
    readonly status: "started" | "failed" | "succeeded";
    readonly acceptance?: import("@zhixing/core/contracts").PairingAcceptance;
    readonly trustEventDigest?: string;
  }>;
}

type BootstrapRecord = TrustStreamRecord | PairingStreamRecord;

type RecoveryStreamRecord =
  | TrustStreamRecord
  | CheckpointStreamRecord
  | {
      readonly t: "recovery-activation-committed";
      readonly commit: RecoveryActivationAtomicCommit;
    };

interface RecoveryProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly trustStaged?: TrustStreamFold["staged"];
  readonly checkpointRecords: readonly CheckpointStreamRecord[];
  readonly activations: ReadonlyMap<string, RecoveryActivationAtomicCommit>;
}

class FilePairingAuthority implements PairingAuthorityPort {
  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly issuerKey?: DeviceKey,
  ) {}

  async beginPairingAttempt(
    offer: import("@zhixing/core/contracts").PairingOffer,
    now: number,
  ): Promise<PairingAttemptDecision> {
    const result = await this.log.transactProjection<PairingProjection, BootstrapRecord, PairingAttemptDecision>(
      emptyPairingProjection(),
      reducePairingProjection,
      (state) => {
        const attempts = [...state.attempts.values()]
          .filter((entry) => entry.admission.offerId === offer.offerId)
          .sort((left, right) => left.admission.ordinal - right.admission.ordinal);
        const succeeded = attempts.some((entry) => entry.status === "succeeded");
        const latest = attempts.at(-1);
        if (succeeded || attempts.length >= offer.attempts.max) {
          return {
            kind: "return",
            value: { admitted: false, reason: "exhausted", attempts: attempts.length, retryAfterMs: 0 },
          };
        }
        const retryNotBefore = latest ? Date.parse(latest.admission.retryNotBefore) : 0;
        if (now < retryNotBefore) {
          return {
            kind: "return",
            value: {
              admitted: false,
              reason: "backoff",
              attempts: attempts.length,
              retryAfterMs: retryNotBefore - now,
            },
          };
        }
        const ordinal = attempts.length + 1;
        const admittedAt = now;
        const admission: PairingAttemptAdmission = {
          offerId: offer.offerId,
          offerDigest: pairingOfferDigest(offer),
          attemptId: generateUlid(admittedAt),
          ordinal,
          at: new Date(admittedAt).toISOString(),
          retryNotBefore: new Date(admittedAt + Math.min(8_000, 250 * 2 ** (ordinal - 1))).toISOString(),
        };
        return {
          kind: "append",
          entries: [{ stream: "pairing", body: { t: "pairing-attempt-started", ...admission } }],
          value: { admitted: true, attempt: admission },
        };
      },
      { streams: ["pairing", "trust"] },
    );
    return result.value;
  }

  async failPairingAttempt(attempt: PairingAttemptAdmission): Promise<void> {
    await this.log.transactProjection<PairingProjection, BootstrapRecord, void>(
      emptyPairingProjection(),
      reducePairingProjection,
      (state) => {
        const current = state.attempts.get(attempt.attemptId);
        if (!current || canonicalize(current.admission) !== canonicalize(attempt)) {
          throw new Error("Pairing attempt admission is unknown");
        }
        if (current.status === "failed") return { kind: "return", value: undefined };
        if (current.status !== "started") throw new Error("Pairing attempt is already finalized");
        return {
          kind: "append",
          entries: [{
            stream: "pairing",
            body: {
              t: "pairing-attempt-failed",
              offerId: attempt.offerId,
              attemptId: attempt.attemptId,
            },
          }],
          value: undefined,
        };
      },
      { streams: ["pairing", "trust"] },
    );
  }

  async loadPairingCommit(attemptId: string): Promise<PairingCommitReplay | undefined> {
    const state = await this.log.rebuildProjection(
      emptyPairingProjection(),
      reducePairingProjection,
      { streams: ["pairing", "trust"] },
    );
    const attempt = state.attempts.get(attemptId);
    if (attempt?.status !== "succeeded" || !attempt.acceptance || !attempt.trustEventDigest) {
      return undefined;
    }
    const event = state.trustEvents.find((candidate) =>
      homeTrustEventDigest(candidate) === attempt.trustEventDigest);
    if (!event) throw new Error("Pairing commit is missing its trust event");
    const trust = replayTrustChain(state.trustEvents);
    return {
      receipt: pairingReceipt(attempt.admission, attempt.acceptance, event),
      trust,
    };
  }

  async commitPairing(input: PairingAtomicCommit): Promise<void> {
    const issuerKey = this.issuerKey;
    if (!issuerKey) throw new Error("Pairing authority requires the local issuer key");
    await this.log.transactProjection<PairingProjection, BootstrapRecord, void>(
      emptyPairingProjection(),
      reducePairingProjection,
      (state) => {
        const current = state.attempts.get(input.attempt.attemptId);
        const expectedReceipt = pairingReceipt(input.attempt, input.acceptance, input.trustEvent);
        if (current?.status === "succeeded" && current.acceptance && current.trustEventDigest) {
          const event = state.trustEvents.find((candidate) =>
            homeTrustEventDigest(candidate) === current.trustEventDigest);
          if (!event || canonicalize(pairingReceipt(current.admission, current.acceptance, event)) !== canonicalize(expectedReceipt)) {
            throw new Error("Pairing attempt commit conflict");
          }
          return { kind: "return", value: undefined };
        }
        if (
          !current ||
          current.status !== "started" ||
          canonicalize(current.admission) !== canonicalize(input.attempt) ||
          current.admission.offerId !== input.offer.offerId
        ) {
          throw new Error("Pairing attempt is not durably admitted");
        }
        if ([...state.attempts.values()].some((entry) =>
          entry.admission.offerId === input.offer.offerId && entry.status === "succeeded")) {
          throw new Error("Pairing offer is already consumed");
        }
        if (state.trustEvents.length === 0) throw new Error("Trust chain genesis is missing");
        const trust = replayTrustChain(state.trustEvents);
        if (canonicalize(trust.chainHead) !== canonicalize(input.expectedChainHead)) {
          throw new Error("Pairing trust head changed before commit");
        }
        const next = applyTrustEvent(trust, input.trustEvent);
        const record = buildHomeTrustRecord(next, issuerKey);
        return {
          kind: "append",
          entries: [
            {
              stream: "pairing",
              body: {
                t: "pairing-attempt-succeeded",
                offerId: input.offer.offerId,
                attemptId: input.attempt.attemptId,
                offerDigest: pairingOfferDigest(input.offer),
                acceptance: input.acceptance,
                trustEventDigest: homeTrustEventDigest(input.trustEvent),
              },
            },
            { stream: "trust", body: { t: "home-trust-event", event: input.trustEvent } },
            { stream: "trust", body: { t: "home-trust-record", record } },
          ],
          value: undefined,
        };
      },
      { streams: ["pairing", "trust"] },
    );
  }
}

class FileBootstrapAuthority implements BootstrapAuthorityPort {
  readonly #pairing: FilePairingAuthority;

  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly artifacts: FileArtifactStore,
    private readonly issuerKey?: DeviceKey,
  ) {
    this.#pairing = new FilePairingAuthority(log, issuerKey);
  }

  beginPairingAttempt(
    offer: Parameters<PairingAuthorityPort["beginPairingAttempt"]>[0],
    now: number,
  ): ReturnType<PairingAuthorityPort["beginPairingAttempt"]> {
    return this.#pairing.beginPairingAttempt(offer, now);
  }

  failPairingAttempt(
    attempt: PairingAttemptAdmission,
  ): ReturnType<PairingAuthorityPort["failPairingAttempt"]> {
    return this.#pairing.failPairingAttempt(attempt);
  }

  loadPairingCommit(
    attemptId: string,
  ): ReturnType<PairingAuthorityPort["loadPairingCommit"]> {
    return this.#pairing.loadPairingCommit(attemptId);
  }

  commitPairing(
    input: PairingAtomicCommit,
  ): ReturnType<PairingAuthorityPort["commitPairing"]> {
    return this.#pairing.commitPairing(input);
  }

  async persistCheckpointPackage(checkpoint: CheckpointPackage): Promise<ArtifactRef> {
    for (const descriptor of checkpoint.envelope.chunks) {
      const bytes = await readCheckpointChunk(checkpoint, descriptor.seq);
      try {
        const stored = await this.artifacts.put(bytes);
        if (stored.digest !== descriptor.digest || stored.bytes !== descriptor.bytes) {
          throw new TypeError("Checkpoint chunk does not match its signed manifest");
        }
      } finally {
        bytes.fill(0);
      }
    }
    const expectedEnvelope = checkpointEnvelopeArtifact(checkpoint.envelope);
    const storedEnvelope = await this.artifacts.put(
      Buffer.from(canonicalize(checkpoint.envelope), "utf8"),
    );
    if (canonicalize(storedEnvelope) !== canonicalize(expectedEnvelope)) {
      throw new TypeError("Checkpoint envelope artifact identity is inconsistent");
    }
    return storedEnvelope;
  }

  async loadCheckpointPackage(
    envelopeRef: ArtifactRef,
  ): Promise<CheckpointPackage | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await this.artifacts.get(envelopeRef);
    } catch (error) {
      if ((error as { code?: string }).code === "artifact-missing") return undefined;
      throw error;
    }
    const text = Buffer.from(bytes).toString("utf8");
    const envelope = JSON.parse(text) as CheckpointPackage["envelope"];
    if (
      canonicalize(envelope) !== text ||
      canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(envelopeRef)
    ) {
      throw new Error("Checkpoint envelope artifact is not canonical or self-consistent");
    }
    if (canonicalize(envelope.manifest.scope) !== canonicalize(FULL_AUTHORITY_CHECKPOINT_SCOPE)) {
      let totalBytes = 0;
      for (const descriptor of envelope.chunks) {
        totalBytes += descriptor.bytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MATERIALIZED_LEGACY_CHECKPOINT_BYTES) {
          throw new TypeError("Legacy checkpoint exceeds its bounded materialization limit");
        }
      }
      const chunks: { seq: number; bytes: Uint8Array }[] = [];
      try {
        for (const descriptor of envelope.chunks) {
          chunks.push({
            seq: descriptor.seq,
            bytes: await this.artifacts.get({ digest: descriptor.digest, bytes: descriptor.bytes }),
          });
        }
        return checkpointPackageFromChunks(envelope, chunks);
      } catch (error) {
        for (const chunk of chunks) {
          Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength).fill(0);
        }
        throw error;
      }
    }
    return {
      envelope,
      source: {
        read: (seq, offset, limit) => {
          const descriptor = envelope.chunks[seq];
          if (!descriptor || descriptor.seq !== seq) {
            return Promise.reject(new TypeError("Stored checkpoint chunk sequence is invalid"));
          }
          return this.artifacts.readRange(
            { digest: descriptor.digest, bytes: descriptor.bytes },
            offset,
            limit,
          );
        },
      },
    };
  }

  async appendCheckpoint(record: CheckpointStreamRecord): Promise<void> {
    await this.log.transactProjection<RecoveryProjection, RecoveryStreamRecord, void>(
      emptyRecoveryProjection(),
      reduceRecoveryProjection,
      (state) => {
        const exact = state.checkpointRecords.find((candidate) =>
          canonicalize(candidate) === canonicalize(record));
        if (exact) return { kind: "return", value: undefined };
        const identity = checkpointRecordIdentity(record);
        if (state.checkpointRecords.some((candidate) =>
          checkpointRecordIdentity(candidate) === identity)) {
          throw new Error("Checkpoint record identity conflict");
        }
        return {
          kind: "append",
          entries: [{ stream: "checkpoint", body: record }],
          value: undefined,
        };
      },
      {
        streams: ["trust", "checkpoint"],
        candidateReferences: collectArtifactRefs(record),
      },
    );
  }

  async loadRecoveryActivation(
    checkpointId: string,
  ): Promise<RecoveryActivationReplay | undefined> {
    const state = await this.log.rebuildProjection(
      emptyRecoveryProjection(),
      reduceRecoveryProjection,
      { streams: ["trust", "checkpoint"] },
    );
    const commit = state.activations.get(checkpointId);
    if (!commit) return undefined;
    return {
      commit,
      trust: replayTrustChain(state.trustEvents),
    };
  }

  async commitRecoveryActivation(input: RecoveryActivationAtomicCommit): Promise<void> {
    const issuerKey = this.issuerKey;
    if (!issuerKey) throw new Error("Recovery activation requires the local issuer key");
    await this.log.transactProjection<RecoveryProjection, RecoveryStreamRecord, void>(
      emptyRecoveryProjection(),
      reduceRecoveryProjection,
      (state) => {
        const checkpointId = input.verification.checkpointId;
        const replay = state.activations.get(checkpointId);
        if (replay) {
          if (canonicalize(replay) !== canonicalize(input)) {
            throw new Error("Recovery activation commit conflict");
          }
          return { kind: "return", value: undefined };
        }
        if (state.trustEvents.length === 0) {
          throw new Error("Recovery activation trust chain is missing");
        }
        const current = replayTrustChain(state.trustEvents);
        if (canonicalize(current.chainHead) !== canonicalize(input.expectedChainHead)) {
          throw new Error("Recovery activation trust head changed before commit");
        }
        assertRecoveryEvidence(state.checkpointRecords, input);
        const next = validateRecoveryActivationPlan(current, input.plan);
        const events = recoveryPlanEvents(input.plan);
        const record = buildHomeTrustRecord(next, issuerKey);
        return {
          kind: "append",
          entries: [
            ...events.map((event) => ({
              stream: "trust",
              body: { t: "home-trust-event" as const, event },
            })),
            { stream: "trust", body: { t: "home-trust-record" as const, record } },
            ...input.checkpointRecords.map((checkpointRecord) => ({
              stream: "checkpoint",
              body: checkpointRecord,
            })),
            {
              stream: "checkpoint",
              body: { t: "recovery-activation-committed" as const, commit: input },
            },
          ],
          value: undefined,
        };
      },
      { streams: ["trust", "checkpoint"] },
    );
  }
}

function emptyPairingProjection(): PairingProjection {
  return { trustEvents: [], attempts: new Map() };
}

/** 配对与恢复投影里的信任链：沿共用折叠认得分支接续，链有变化时整链核对。 */
function foldProjectionTrust<State extends { readonly trustEvents: readonly HomeTrustEvent[]; readonly trustStaged?: TrustStreamFold["staged"] }>(
  state: State,
  body: unknown,
): State {
  const fold = foldTrustStreamRecord({ events: state.trustEvents, staged: state.trustStaged ?? EMPTY_TRUST_STREAM_FOLD.staged }, body);
  if (fold.events === state.trustEvents && fold.staged === (state.trustStaged ?? EMPTY_TRUST_STREAM_FOLD.staged)) return state;
  if (fold.events !== state.trustEvents) replayTrustChain(fold.events);
  return { ...state, trustEvents: fold.events, trustStaged: fold.staged };
}

function reducePairingProjection(
  state: PairingProjection,
  record: { readonly stream: string; readonly body: BootstrapRecord },
): PairingProjection {
  if (record.stream === "trust") return foldProjectionTrust(state, record.body);
  if (record.stream !== "pairing") return state;
  const body = record.body;
  const attempts = new Map(state.attempts);
  if (body.t === "pairing-attempt-started") {
    const admission: PairingAttemptAdmission = {
      attemptId: body.attemptId,
      offerId: body.offerId,
      offerDigest: body.offerDigest,
      ordinal: body.ordinal,
      at: body.at,
      retryNotBefore: body.retryNotBefore,
    };
    if (attempts.has(admission.attemptId)) throw new Error("Duplicate pairing attempt id");
    attempts.set(admission.attemptId, { admission, status: "started" });
  } else if (body.t === "pairing-attempt-failed") {
    const current = attempts.get(body.attemptId);
    if (!current || current.admission.offerId !== body.offerId || current.status !== "started") {
      throw new Error("Invalid pairing attempt failure record");
    }
    attempts.set(body.attemptId, { ...current, status: "failed" });
  } else if (body.t === "pairing-attempt-succeeded") {
    const current = attempts.get(body.attemptId);
    if (
      !current ||
      current.status !== "started" ||
      current.admission.offerId !== body.offerId ||
      current.admission.offerDigest !== body.offerDigest
    ) {
      throw new Error("Invalid pairing attempt success record");
    }
    attempts.set(body.attemptId, {
      ...current,
      status: "succeeded",
      acceptance: body.acceptance,
      trustEventDigest: body.trustEventDigest,
    });
  }
  return { ...state, attempts };
}

function emptyRecoveryProjection(): RecoveryProjection {
  return {
    trustEvents: [],
    checkpointRecords: [],
    activations: new Map(),
  };
}

function reduceRecoveryProjection(
  state: RecoveryProjection,
  record: { readonly stream: string; readonly body: RecoveryStreamRecord },
): RecoveryProjection {
  const body = record.body;
  if (record.stream === "trust") return foldProjectionTrust(state, body);
  if (record.stream !== "checkpoint") return state;
  if (
    body.t === "home-trust-event" || body.t === "home-trust-record" ||
    body.t === "home-trust-branch-staged" || body.t === "home-trust-branch-adopted"
  ) {
    throw new Error("Trust record was written to the checkpoint stream");
  }
  if (body.t === "recovery-activation-committed") {
    const checkpointId = body.commit.verification.checkpointId;
    const activations = new Map(state.activations);
    const existing = activations.get(checkpointId);
    if (existing && canonicalize(existing) !== canonicalize(body.commit)) {
      throw new Error("Recovery activation log contains a conflicting commit");
    }
    activations.set(checkpointId, body.commit);
    return { ...state, activations };
  }
  const identity = checkpointRecordIdentity(body);
  const existing = state.checkpointRecords.find((candidate) =>
    checkpointRecordIdentity(candidate) === identity);
  if (existing) {
    if (canonicalize(existing) !== canonicalize(body)) {
      throw new Error("Checkpoint log contains a conflicting record");
    }
    return state;
  }
  return {
    ...state,
    checkpointRecords: [...state.checkpointRecords, body],
  };
}

function checkpointRecordIdentity(record: CheckpointStreamRecord): string {
  switch (record.t) {
    case "checkpoint-created":
    case "checkpoint-superseded":
      return `${record.t}:${record.checkpointId}`;
    case "checkpoint-cleanup-progress":
      return `${record.t}:${record.checkpointId}:${record.targetId}:${record.phase}`;
    case "checkpoint-replicated":
    case "checkpoint-verified":
      return `${record.t}:${record.checkpointId}:${record.targetId}`;
    case "checkpoint-verify-failed":
      return `${record.t}:${canonicalize(record)}`;
  }
}

function assertRecoveryEvidence(
  records: readonly CheckpointStreamRecord[],
  input: RecoveryActivationAtomicCommit,
): void {
  const verification = input.verification;
  const created = records.find((record): record is Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-created" }
  > => record.t === "checkpoint-created" && record.checkpointId === verification.checkpointId);
  const replicated = records.find((record): record is Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-replicated" }
  > =>
    record.t === "checkpoint-replicated" &&
    record.checkpointId === verification.checkpointId &&
    record.targetId === verification.targetId);
  if (
    !created ||
    !replicated ||
    created.recipientKeyId !== verification.recipientKeyId ||
    replicated.recipientKeyId !== verification.recipientKeyId ||
    created.envelopeDigest !== verification.envelopeDigest ||
    replicated.envelopeDigest !== verification.envelopeDigest
  ) {
    throw new Error("Recovery activation checkpoint evidence is incomplete");
  }
}

function recoveryPlanEvents(plan: RecoveryActivationPlan): readonly HomeTrustEvent[] {
  return plan.kind === "domain-reset-establish"
    ? [plan.resetEvent, plan.rootEvent]
    : [plan.rootEvent];
}

function pairingReceipt(
  attempt: PairingAttemptAdmission,
  acceptance: import("@zhixing/core/contracts").PairingAcceptance,
  event: HomeTrustEvent,
): PairingCommitReceipt {
  const trustEventDigest = homeTrustEventDigest(event);
  return {
    expectedChainHead: {
      seq: event.seq - 1,
      eventDigest: event.prevEventDigest,
    },
    attemptId: attempt.attemptId,
    offerId: attempt.offerId,
    offerDigest: attempt.offerDigest,
    acceptance,
    trustEventDigest,
    resultingChainHead: { seq: event.seq, eventDigest: trustEventDigest },
  };
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, canonicalize(value), { encoding: "utf8", flag: "wx" });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function generateUlid(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = now;
  let prefix = "";
  for (let index = 0; index < 10; index += 1) {
    prefix = alphabet[timestamp % 32]! + prefix;
    timestamp = Math.floor(timestamp / 32);
  }
  const entropy = randomBytes(10);
  let bits = 0;
  let available = 0;
  let suffix = "";
  for (const byte of entropy) {
    bits = (bits << 8) | byte;
    available += 8;
    while (available >= 5 && suffix.length < 16) {
      available -= 5;
      suffix += alphabet[(bits >>> available) & 31];
      bits &= (1 << available) - 1;
    }
  }
  if (suffix.length < 16) suffix += alphabet[(bits << (5 - available)) & 31];
  return `${prefix}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTransportPeer(value: unknown): TrustedMeshPeer {
  if (!isRecord(value) || !isRecord(value.identity)) {
    throw new Error("Mesh peer transport identity is invalid");
  }
  const identity = value.identity;
  const identityKeys = Object.keys(identity).sort();
  if (
    Object.keys(value).sort().join(",") !== "identity,rootCertificatePem" ||
    identityKeys.join(",") !== "deviceId,displayName,enrolledAt,platform,publicKey" ||
    typeof identity.deviceId !== "string" ||
    typeof identity.publicKey !== "string" ||
    typeof identity.displayName !== "string" ||
    (identity.platform !== "windows" && identity.platform !== "macos" && identity.platform !== "linux" && identity.platform !== "headless") ||
    typeof identity.enrolledAt !== "string" ||
    typeof value.rootCertificatePem !== "string"
  ) {
    throw new Error("Mesh peer transport identity fields are invalid");
  }
  validateDeviceTrustRoot(identity as unknown as DeviceIdentity, value.rootCertificatePem);
  return Object.freeze({
    identity: Object.freeze({
      deviceId: identity.deviceId as string,
      publicKey: identity.publicKey as string,
      displayName: identity.displayName as string,
      platform: identity.platform,
      enrolledAt: identity.enrolledAt as string,
    }) as DeviceIdentity,
    rootCertificatePem: value.rootCertificatePem,
  });
}

async function readBootstrapCompletions(filePath: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Mesh bootstrap completion state is not valid JSON");
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("Mesh bootstrap completion state is invalid");
  }
  if (canonicalize(value) !== text) {
    throw new Error("Mesh bootstrap completion state is not canonical");
  }
  return value as Record<string, string>;
}
