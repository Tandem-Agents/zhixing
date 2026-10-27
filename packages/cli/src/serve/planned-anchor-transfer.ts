import { verifyProtocolStep } from "@zhixing/core/protocol";
import type {
  AnchorTransferAbort,
  AnchorTransferCommand,
  AnchorTransferCommit,
  AnchorTransferResult,
  ArtifactRef,
  AuthorityCatalog,
  CommitEnvelope,
  HomeTrustEvent,
  HomeTrustEventWithBody,
  HomeTrustEventBody,
  HomeTrustRecord,
  JsonValue,
  LogicalRecord,
  ReadyProof,
  SecretStorePort,
  TransferRecord,
} from "@zhixing/core/contracts";
import type {
  ArtifactReceiveProgress,
  ArtifactStore,
  ArtifactCheckpointRetentionPort,
  AuthorityCacheIntegrity,
  AuthorityAppendAdmissionGuard,
  DurableLogCheckpoint,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  IdentifiedPhysicalStepRunner,
  PhysicalStorageStepRunner,
  PlannedAnchorPrefixInstallation,
  ProjectionReducer,
  ProjectionReplayOptions,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
  ProjectionTransactionOptions,
  ProjectionTransactionReducer,
  ProjectionTransactionResult,
} from "@zhixing/core/authority";
import { collectArtifactRefs, DurableProjectionRecordBindingError } from "@zhixing/core/authority";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
} from "@zhixing/core/resources";
import {
  createSignedAnchorTransferCommand,
  createSignedAnchorTransferAbort,
  createSignedPlannedAnchorTransferCommit,
  canonicalize,
  compareCanonicalStrings,
  createSignedSourceFreezeProof,
  prepareAuthorityCatalog,
  protocolDigest,
  readyProofDigest,
  reducePlannedAnchorTransfer,
  sourceFreezeProofDigest,
  validateAnchorTransferAbort,
  validateAnchorTransferCommand,
  type PlannedAnchorTransferState,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  createAnchorTransferReadyProof,
  validateAnchorTransferReadyProof,
  type AnchorTransferReadySnapshot,
} from "@zhixing/mesh/anchor-transfer-ready";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  activateAnchorIssuerKey,
  deleteAnchorIssuerKey,
  loadActiveAnchorIssuerKey,
  loadAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  verifyHomeTrustRecord,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  installHomeRouteMaterial,
  loadOrCreateHomeRouteMaterial,
  loadStagedHomeRouteMaterial,
  stageHomeRouteMaterial,
  type HomeRouteMaterial,
} from "./home-route-material.js";
import {
  PLANNED_POST_INSTALL_STREAM,
  readAnchorInstallationState,
  recordAnchorInstallationCompletion,
  type AnchorInstallationIndexPort,
} from "./anchor-installation-index.js";
import {
  ANCHOR_CANDIDATE_STREAM,
  assertTargetWideAnchorCandidateAvailable,
  reduceTargetWideAnchorCandidateRecord,
  reduceTargetWideAnchorCandidates,
  targetWideAnchorCandidateClaim,
  targetWideAnchorCandidateTerminal,
  type TargetWideAnchorCandidateState,
} from "./target-wide-anchor-candidate.js";

const ANCHOR_TRANSFER_STREAM = "transfer:anchor";
const SOURCE_CLOSURE_STREAM = "transfer:anchor-closure";
const READY_RESERVATION_STREAM = "transfer:anchor-ready-reservation";
const TRANSFER_CHUNK_BYTES = 512 * 1024;
const TRANSFER_EXPORT_PAGE_COMMITS = 64;
const TRANSFER_HEADER_BYTES = 1024 * 1024;

type PlannedRecord = Extract<TransferRecord, { mode: "planned" }>;
type MigrationTransition = HomeTrustEventWithBody<
  Extract<HomeTrustEventBody, { t: "issuer-transition"; reason: "migration" }>
>;

interface ReadyReservation {
  readonly v: 1;
  readonly t: "planned-anchor-ready-reserved";
  readonly transferId: string;
  readonly targetDeviceId: string;
  readonly proofDigest: string;
  readonly snapshotDigest: string;
  readonly expiresAt: string;
}

interface PlannedAuthorityExportPage {
  readonly seq: number;
  readonly firstLsn: number;
  readonly lastLsn: number;
  readonly recordCount: number;
  readonly ref: ArtifactRef;
}

interface PlannedAuthorityExportPageBody {
  readonly v: 1;
  readonly seq: number;
  readonly commits: readonly CommitEnvelope<unknown>[];
}

interface PlannedAuthorityExport {
  readonly v: 2;
  readonly checkpoint: DurableLogCheckpoint;
  readonly pages: readonly PlannedAuthorityExportPage[];
}

interface CatalogStreamAccumulator {
  readonly stream: string;
  readonly firstLsn: number;
  readonly lastLsn: number;
  readonly recordCount: number;
  readonly digest: string;
}

interface PlannedAuthorityCapture {
  readonly manifest: PlannedAuthorityExport;
  readonly manifestRef: ArtifactRef;
  readonly retainedArtifacts: readonly ArtifactRef[];
  readonly streams: readonly CatalogStreamAccumulator[];
  readonly pendingObligations: AuthorityCatalog["pendingObligations"];
}

interface PlannedSourceClosure {
  readonly v: 1;
  readonly t: "planned-anchor-source-closure";
  readonly transferId: string;
  readonly acceptedTokens: readonly PlannedAcceptedToken[];
  readonly pendingObligations: AuthorityCatalog["pendingObligations"];
  readonly sourceHead: DurableLogCheckpoint;
}

interface PlannedAcceptedToken {
  readonly transferId: string;
  readonly kind: AuthorityCatalog["pendingObligations"][number]["kind"];
  readonly id: string;
  readonly requestId: string;
}

export interface PlannedAnchorCandidateIdentity {
  readonly homeId: string;
  readonly requestId: string;
  readonly transferId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly trustEpoch: number;
  readonly trustChainHead: HomeTrustRecord["chainHead"];
  readonly sourceAnchorEpoch: number;
}

export interface PlannedAnchorCandidateRelease {
  readonly v: 1;
  readonly t: "planned-anchor-candidate-release";
  readonly identity: PlannedAnchorCandidateIdentity;
  readonly reason: "operator-cancelled" | "target-rejected";
  readonly signature: ReturnType<ProtocolSigner["sign"]>;
}

type PlannedAnchorCandidateTerminal = "committed" | "aborted" | "released";
type PlannedAnchorPreparedRecord = Extract<PlannedRecord, { t: "anchor-prepared" }>;

interface PlannedAnchorCandidateState {
  readonly identity: PlannedAnchorCandidateIdentity;
  readonly readyProof?: ReadyProof;
  readonly prepared?: PlannedAnchorPreparedRecord;
  readonly terminal?: PlannedAnchorCandidateTerminal;
  readonly abort?: AnchorTransferAbort;
  readonly releaseDelivered?: true;
  /** 目标端：只领了声明或已中止的候选，其本机清理已确认完成。 */
  readonly cleaned?: true;
}

type PlannedAnchorCandidateRecord =
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-claimed";
      readonly identity: PlannedAnchorCandidateIdentity;
    }
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-ready";
      readonly identity: PlannedAnchorCandidateIdentity;
      readonly readyProof: ReadyProof;
    }
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-prepared";
      readonly identity: PlannedAnchorCandidateIdentity;
      readonly prepared: PlannedAnchorPreparedRecord;
    }
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-terminal";
      readonly identity: PlannedAnchorCandidateIdentity;
      readonly terminal: "committed" | "released";
    }
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-terminal";
      readonly identity: PlannedAnchorCandidateIdentity;
      readonly terminal: "aborted";
      readonly abort: AnchorTransferAbort;
    }
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-release-delivered";
      readonly identity: PlannedAnchorCandidateIdentity;
    }
  | {
      readonly v: 1;
      readonly t: "planned-anchor-candidate-cleaned";
      readonly identity: PlannedAnchorCandidateIdentity;
    };

interface PlannedSourceClosureRecord {
  readonly v: 1;
  readonly t: "planned-anchor-source-closure-recorded";
  readonly transferId: string;
  readonly sourceHead: DurableLogCheckpoint;
  readonly closure: ArtifactRef;
  readonly closureDigest: string;
}

export interface PlannedAnchorTransferLifecycle {
  stopAccepting(): void | Promise<void>;
  drainAccepted(): Promise<void>;
  resumeAfterAbort(): void | Promise<void>;
}

export interface PlannedAnchorTransferTargetPort {
  summary(): Promise<PlannedAnchorTargetReadinessSummary>;
  ready(input: {
    readonly candidate: PlannedAnchorCandidateIdentity;
  }): Promise<ReadyProof>;
  releaseCandidate(input: PlannedAnchorCandidateRelease): Promise<void>;
  apply(command: AnchorTransferCommand): Promise<AnchorTransferResult>;
}

export interface PlannedAnchorReadinessPort {
  snapshot(): Promise<AnchorTransferReadySnapshot>;
  reserve(input: {
    readonly transferId: string;
    readonly expiresAt: string;
  }): Promise<AnchorTransferReadySnapshot>;
  release(transferId: string): Promise<void>;
}

export interface PlannedAnchorTargetReadinessSummary {
  readonly ready: true;
}

export interface PlannedAnchorTransferArtifactSourcePort {
  applyArtifactCommand(command: AnchorTransferCommand): Promise<AnchorTransferResult>;
  /**
   * 家级路由材料：源端只交给已冻结、尚未终结的本次迁居的目标（requester 是经认证的目标设备）。
   * 经已认证的迁居连接传输，不写入任何制品或日志。
   */
  routeMaterial?(transferId: string, requesterDeviceId: string): Promise<HomeRouteMaterial>;
}

export interface PlannedAnchorCandidateJournalPort {
  state(transferId: string): Promise<PlannedAnchorCandidateState | undefined>;
  states(): Promise<ReadonlyMap<string, PlannedAnchorCandidateState>>;
  /** 未完候选（终态未定、已释放未投递、清理未确认），启动恢复只遍历它。 */
  unfinishedStates(): Promise<ReadonlyMap<string, PlannedAnchorCandidateState>>;
  markCleaned(identity: PlannedAnchorCandidateIdentity): Promise<PlannedAnchorCandidateState>;
  claimCandidate(
    identity: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState>;
  recordReady(
    identity: PlannedAnchorCandidateIdentity,
    readyProof: ReadyProof,
  ): Promise<PlannedAnchorCandidateState>;
  markPrepared(
    identity: PlannedAnchorCandidateIdentity,
    prepared: PlannedAnchorPreparedRecord,
  ): Promise<PlannedAnchorCandidateState>;
  decideRemoteAbort(
    identity: PlannedAnchorCandidateIdentity,
    abort: AnchorTransferAbort,
  ): Promise<PlannedAnchorCandidateState>;
  terminal(
    identity: PlannedAnchorCandidateIdentity,
    terminal: PlannedAnchorCandidateTerminal,
    abort?: AnchorTransferAbort,
  ): Promise<PlannedAnchorCandidateState>;
  releaseUnprepared(
    identity: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState>;
}

export interface PlannedAnchorPrivateJournalPort {
  state(transferId: string): Promise<PlannedAnchorTransferState | undefined>;
  append(
    record: PlannedRecord,
    extraEntries?: readonly LogicalRecord<unknown>[],
    beforeAppend?: () => void,
  ): Promise<PlannedAnchorTransferState>;
  readyReservation(transferId: string): Promise<ReadyReservation | undefined>;
  reserveReady(record: ReadyReservation): Promise<ReadyReservation>;
}

export interface PlannedAnchorStagingArtifacts {
  get(ref: ArtifactRef): Promise<Uint8Array>;
  readRange(ref: ArtifactRef, offset: number, limit: number): Promise<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
}

export interface PlannedAnchorStagingReceiver {
  progress(
    ref: ArtifactRef,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ): Promise<ArtifactReceiveProgress>;
  append(
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ): Promise<ArtifactReceiveProgress>;
}

export interface PlannedAnchorTransferStagingSession {
  readonly journal: PlannedAnchorPrivateJournalPort;
  readonly artifacts: PlannedAnchorStagingArtifacts;
  readonly receiver: PlannedAnchorStagingReceiver;
  readonly promotion: PlannedAnchorStagingReceiver;
  exists(): Promise<boolean>;
  cleanupTransfer(): Promise<void>;
  cleanupTransferAndJournal(): Promise<void>;
  close(): Promise<void>;
}

export interface PlannedAnchorTargetStaging {
  readonly candidates: PlannedAnchorCandidateJournalPort;
  recoverableTransferIds(): Promise<readonly string[]>;
  forTransfer(transferId: string): PlannedAnchorTransferStagingSession;
  close(): Promise<void>;
}

export interface PlannedAnchorTransferStagingArea {
  openTarget(input: Readonly<{
    artifacts: ArtifactStore;
    verifier: ProtocolSignatureVerifier;
    /** 同一 home 的缓存密钥：候选日志是启动必经的辅助写日志，带上即开启启动证明。 */
    integrity?: AuthorityCacheIntegrity;
  }>): PlannedAnchorTargetStaging;
  openTransfer(input: Readonly<{
    transferId: string;
    artifacts: ArtifactStore;
    verifier: ProtocolSignatureVerifier;
  }>): PlannedAnchorTransferStagingSession;
  cleanupPostInstall(transferId: string): Promise<void>;
  close(): Promise<void>;
}

interface PlannedAnchorAuthorityReadPort extends AnchorInstallationIndexPort {
  readStream<Body = unknown>(
    stream: string,
  ): Promise<Array<{ lsn: number; at: string; body: Body }>>;
  readTail<Body = unknown>(
    checkpoint: DurableLogCheckpoint,
    limit: number,
    runPhysicalStep?: PhysicalStorageStepRunner,
  ): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[];
    readonly checkpoint: DurableLogCheckpoint;
    readonly hasMore: boolean;
  }>;
  originCheckpoint(): Promise<DurableLogCheckpoint>;
  checkpoint(): Promise<DurableLogCheckpoint>;
}

interface PlannedAnchorInstallAuthorityPort extends PlannedAnchorAuthorityReadPort {
  installPlannedAnchorPrefix<Body>(
    input: PlannedAnchorPrefixInstallation<Body>,
  ): Promise<CommitEnvelope<Body>>;
}

export interface PlannedAnchorJournalStorage {
  rebuildProjection<State, Body = unknown>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options?: ProjectionReplayOptions,
  ): Promise<State>;
  transactProjection<State, Body = unknown, Value = void>(
    initial: State,
    reducer: ProjectionTransactionReducer<State, Body>,
    decide: (
      state: State,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options?: ProjectionTransactionOptions,
  ): Promise<ProjectionTransactionResult<State, Body, Value>>;
  // 迁居与候选的按键投影（未完目录与按 transferId 精确读）
  durableProjection: import("@zhixing/core/authority").AuthorityCommitLog["durableProjection"];
  transactDurableProjection: import("@zhixing/core/authority").AuthorityCommitLog["transactDurableProjection"];
  stopStorageMaintenance(): Promise<void>;
}

interface PlannedAnchorSourceAuthorityPort
  extends PlannedAnchorJournalStorage, PlannedAnchorAuthorityReadPort {
  installAppendAdmissionGuard(guard: AuthorityAppendAdmissionGuard): Promise<() => void>;
}

/** Assembly-owned gate for every planned-transfer command and physical step. */
export class PlannedAnchorTransferRuntimeLifecycle {
  readonly #abort = new AbortController();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #accepting = true;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new Error("Duty-device migration runtime is stopping"));
    }
    const promise = runWithMaintenanceUrgency(
      () => "foreground",
      this.#abort.signal,
      operation,
    );
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#accepting = false;
    this.#abort.abort(new Error("Duty-device migration runtime is stopping"));
    this.#closing = Promise.allSettled([...this.#inFlight]).then(() => undefined);
    return this.#closing;
  }
}

interface PlannedAnchorCandidateProjection {
  readonly claims: ReadonlyMap<string, PlannedAnchorCandidateState>;
  readonly targetWideClaims: ReadonlyMap<string, TargetWideAnchorCandidateState>;
  readonly transfers: ReadonlyMap<string, PlannedAnchorTransferState>;
  readonly installedTransfers: ReadonlySet<string>;
}

/**
 * 迁居与候选日志的按键投影：状态按 transferId 精确读，另有进行中的迁居、未完候选、进行中的全目标候选
 * 与“本机源端按任期”目录。启动恢复与各事务只读这几个目录与本次 transferId 的键，与历史迁居（含导入
 * 前缀）的数量无关。归约对每条记录组装只含相关键的小投影，沿用原有 reduceCandidateProjection。
 */
const PLANNED_JOURNAL_PROJECTION_ID = "planned-anchor-journal-v1";
const PLANNED_CANDIDATES_PROJECTION_ID = "planned-anchor-candidates-v1";
const PLANNED_JOURNAL_KEYS = Object.freeze({
  transfer: "transfer/",
  candidate: "candidate/",
  targetWide: "target-wide/",
  installed: "installed/",
  openTransfer: "open-transfer/",
  openCandidate: "open-candidate/",
  openTargetWide: "open-target-wide/",
  own: "own/",
});
const plannedJournalIndexes = new WeakMap<object, { readonly verifier: ProtocolSignatureVerifier; readonly projectionId: string }>();

function plannedJournalIdentity(value: Record<string, string>): string {
  return protocolDigest("PlannedAnchorJournalIdentity", 1, value);
}

function plannedJournalKey(prefix: string, transferId: string): string {
  return `${prefix}${plannedJournalIdentity({ transferId })}`;
}

function ownTransferPrefix(sourceDeviceId: string, sourceAnchorEpoch?: number): string {
  const device = `${PLANNED_JOURNAL_KEYS.own}${plannedJournalIdentity({ deviceId: sourceDeviceId })}/`;
  // 任期倒置排序：前缀扫描的第一条就是本机最近一次任期
  return sourceAnchorEpoch === undefined
    ? device
    : `${device}${(Number.MAX_SAFE_INTEGER - sourceAnchorEpoch).toString().padStart(16, "0")}/`;
}

function registerPlannedJournalIndex(
  log: PlannedAnchorJournalStorage,
  verifier: ProtocolSignatureVerifier,
  includeTransferState: boolean,
): string {
  const projectionId = includeTransferState ? PLANNED_JOURNAL_PROJECTION_ID : PLANNED_CANDIDATES_PROJECTION_ID;
  const existing = plannedJournalIndexes.get(log);
  if (existing) {
    if (existing.projectionId !== projectionId || existing.verifier !== verifier) {
      throw new TypeError("Planned migration journal index is already bound by another owner");
    }
    return projectionId;
  }
  log.durableProjection({
    projectionId,
    reducerVersion: 1,
    authenticated: true,
    inputs: {
      streams: includeTransferState
        ? [ANCHOR_CANDIDATE_STREAM, ANCHOR_TRANSFER_STREAM, "transfer:anchor-current"]
        : [ANCHOR_CANDIDATE_STREAM],
    },
    reduce: (envelope, current) => reducePlannedJournalIndex(envelope, current, verifier, includeTransferState),
  });
  plannedJournalIndexes.set(log, { verifier, projectionId });
  return projectionId;
}

function journalTransferIdOf(entry: LogicalRecord<unknown>): string | undefined {
  if (!isRecord(entry.body)) return undefined;
  if (entry.stream === ANCHOR_CANDIDATE_STREAM) {
    return isRecord(entry.body.identity) && typeof entry.body.identity.transferId === "string"
      ? entry.body.identity.transferId
      : undefined;
  }
  if (entry.stream === ANCHOR_TRANSFER_STREAM) {
    return typeof entry.body.transferId === "string" ? entry.body.transferId : undefined;
  }
  return entry.stream === "transfer:anchor-current" && isPlannedInstallation(entry.body)
    ? entry.body.transferId
    : undefined;
}

function journalRow<T>(value: JsonValue | undefined): T | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new DurableProjectionRecordBindingError("Planned migration journal index row is invalid");
  }
  return value as unknown as T;
}

async function journalDirectory(view: DurableProjectionReadContext, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: prefix, lt: `${prefix}￿` }, 128, continuation);
    for (const entry of page.entries) {
      const row = journalRow<{ readonly transferId?: unknown }>(entry.value);
      if (typeof row?.transferId !== "string") {
        throw new DurableProjectionRecordBindingError("Planned migration journal directory row is invalid");
      }
      ids.push(row.transferId);
    }
    continuation = page.continuation;
  } while (continuation);
  return ids;
}

/** 组装只含给定 transferId 与各进行中集合的小投影；决定函数与归约照原样消费它。 */
async function readPlannedJournalProjection(
  view: DurableProjectionReadContext,
  transferIds: readonly string[],
  scope: { readonly openCandidates: boolean; readonly openTransfers: boolean },
): Promise<PlannedAnchorCandidateProjection> {
  const claims = new Map<string, PlannedAnchorCandidateState>();
  const targetWideClaims = new Map<string, TargetWideAnchorCandidateState>();
  const transfers = new Map<string, PlannedAnchorTransferState>();
  const installedTransfers = new Set<string>();
  const load = async (transferId: string) => {
    const claim = journalRow<PlannedAnchorCandidateState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.candidate, transferId)));
    if (claim) claims.set(transferId, claim);
    const targetWide = journalRow<TargetWideAnchorCandidateState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.targetWide, transferId)));
    if (targetWide) targetWideClaims.set(transferId, targetWide);
    const transfer = journalRow<PlannedAnchorTransferState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.transfer, transferId)));
    if (transfer) transfers.set(transferId, transfer);
    if (await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.installed, transferId)) !== undefined) {
      installedTransfers.add(transferId);
    }
  };
  const ids = new Set(transferIds);
  // 全目标候选的唯一性总要看进行中集合；其余集合按事务需要读
  for (const id of await journalDirectory(view, PLANNED_JOURNAL_KEYS.openTargetWide)) ids.add(id);
  if (scope.openCandidates) for (const id of await journalDirectory(view, PLANNED_JOURNAL_KEYS.openCandidate)) ids.add(id);
  if (scope.openTransfers) for (const id of await journalDirectory(view, PLANNED_JOURNAL_KEYS.openTransfer)) ids.add(id);
  for (const id of ids) await load(id);
  return { claims, targetWideClaims, transfers, installedTransfers };
}

function unfinishedCandidate(candidate: PlannedAnchorCandidateState, includeTransferState: boolean): boolean {
  if (candidate.terminal === undefined) return true;
  if (candidate.terminal === "released" && !candidate.releaseDelivered) return true;
  // 目标端：只领了声明或已中止的候选在清理确认前仍需恢复续做
  return !includeTransferState && candidate.terminal !== "committed" && !candidate.cleaned;
}

async function reducePlannedJournalIndex(
  envelope: CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier,
  includeTransferState: boolean,
): Promise<readonly DurableProjectionMutation[]> {
  const changes: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const read: DurableProjectionReadContext = {
    get: async (key) => overlay.has(key) ? overlay.get(key) : current.get(key),
    scan: async (range, limit, continuation) => {
      const page = await current.scan(range, limit, continuation);
      // 本批已写的目录键覆盖底层结果：新增的补上、已删的去掉
      const entries = page.entries.filter((entry) => !overlay.has(entry.key) || overlay.get(entry.key) !== undefined)
        .map((entry) => overlay.has(entry.key) ? { ...entry, value: overlay.get(entry.key)! } : entry);
      for (const [key, value] of overlay) {
        if (value !== undefined && key >= range.gte! && key < range.lt! && !entries.some((entry) => entry.key === key)) {
          entries.push({ key, value });
        }
      }
      entries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      return { ...page, entries };
    },
  };
  const put = (key: string, value: JsonValue) => { overlay.set(key, value); changes.push({ kind: "put", key, value }); };
  const remove = (key: string) => { overlay.set(key, undefined); changes.push({ kind: "tombstone", key }); };
  const sync = (key: string, before: unknown, after: unknown) => {
    if (canonicalize(before ?? null) === canonicalize(after ?? null)) return;
    if (after === undefined) remove(key);
    else put(key, after as JsonValue);
  };
  for (const entry of envelope.entries) {
    const transferId = journalTransferIdOf(entry);
    if (transferId === undefined) continue;
    const before = await readPlannedJournalProjection(read, [transferId], { openCandidates: false, openTransfers: false });
    const after = await verifyProtocolStep(() => reduceCandidateProjection(before, entry, verifier, includeTransferState));
    const directoryRow = { transferId };
    // 已安装的迁居（含导入前缀里前任的迁居，其终态写在导出之后）不再是本机的未完工作
    const installedBefore = before.installedTransfers.has(transferId);
    const installedAfter = after.installedTransfers.has(transferId);
    const claim = after.claims.get(transferId);
    sync(plannedJournalKey(PLANNED_JOURNAL_KEYS.candidate, transferId), before.claims.get(transferId), claim);
    sync(plannedJournalKey(PLANNED_JOURNAL_KEYS.openCandidate, transferId),
      before.claims.has(transferId) && !installedBefore && unfinishedCandidate(before.claims.get(transferId)!, includeTransferState)
        ? directoryRow : undefined,
      claim && !installedAfter && unfinishedCandidate(claim, includeTransferState) ? directoryRow : undefined);
    const targetWide = after.targetWideClaims.get(transferId);
    sync(plannedJournalKey(PLANNED_JOURNAL_KEYS.targetWide, transferId), before.targetWideClaims.get(transferId), targetWide);
    sync(plannedJournalKey(PLANNED_JOURNAL_KEYS.openTargetWide, transferId),
      before.targetWideClaims.get(transferId)?.terminal === undefined && before.targetWideClaims.has(transferId) ? directoryRow : undefined,
      targetWide && targetWide.terminal === undefined ? directoryRow : undefined);
    if (!includeTransferState) continue;
    const transfer = after.transfers.get(transferId);
    const priorTransfer = before.transfers.get(transferId);
    sync(plannedJournalKey(PLANNED_JOURNAL_KEYS.transfer, transferId), priorTransfer, transfer);
    const inProgress = (state: PlannedAnchorTransferState | undefined) =>
      state !== undefined && state.phase !== "aborted" && state.phase !== "tombstoned";
    sync(plannedJournalKey(PLANNED_JOURNAL_KEYS.openTransfer, transferId),
      inProgress(priorTransfer) && !installedBefore ? directoryRow : undefined,
      inProgress(transfer) && !installedAfter ? directoryRow : undefined);
    if (transfer && !priorTransfer) {
      put(`${ownTransferPrefix(transfer.identity.sourceDeviceId, transfer.identity.sourceAnchorEpoch)}${plannedJournalIdentity({ transferId })}`, directoryRow);
    }
    if (after.installedTransfers.has(transferId) && !before.installedTransfers.has(transferId)) {
      put(plannedJournalKey(PLANNED_JOURNAL_KEYS.installed, transferId), directoryRow);
    }
  }
  return changes;
}

export class PlannedAnchorCandidateJournal implements PlannedAnchorCandidateJournalPort {
  readonly #projectionId: string;

  constructor(
    private readonly log: PlannedAnchorJournalStorage,
    private readonly verifier: ProtocolSignatureVerifier,
    private readonly includeTransferState: boolean,
  ) {
    this.#projectionId = registerPlannedJournalIndex(log, verifier, includeTransferState);
  }

  async state(transferId: string): Promise<PlannedAnchorCandidateState | undefined> {
    return this.#read(async (view) =>
      journalRow<PlannedAnchorCandidateState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.candidate, transferId))));
  }

  /** 显式历史查询：枚举全部候选。启动恢复与命令路径用 unfinishedStates。 */
  async states(): Promise<ReadonlyMap<string, PlannedAnchorCandidateState>> {
    return this.#read(async (view) => {
      const states = new Map<string, PlannedAnchorCandidateState>();
      let continuation: string | undefined;
      do {
        const page = await view.scan({ gte: PLANNED_JOURNAL_KEYS.candidate, lt: `${PLANNED_JOURNAL_KEYS.candidate}￿` }, 128, continuation);
        for (const entry of page.entries) {
          const claim = journalRow<PlannedAnchorCandidateState>(entry.value)!;
          states.set(claim.identity.transferId, claim);
        }
        continuation = page.continuation;
      } while (continuation);
      return states;
    });
  }

  /** 未完候选：终态未定、已释放未投递，或（目标端）清理未确认。读取随未完工作数，与历史无关。 */
  async unfinishedStates(): Promise<ReadonlyMap<string, PlannedAnchorCandidateState>> {
    return this.#read(async (view) => {
      const states = new Map<string, PlannedAnchorCandidateState>();
      for (const transferId of await journalDirectory(view, PLANNED_JOURNAL_KEYS.openCandidate)) {
        const claim = journalRow<PlannedAnchorCandidateState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.candidate, transferId)));
        if (!claim) throw new DurableProjectionRecordBindingError("Planned migration candidate directory has no state");
        states.set(transferId, claim);
      }
      return states;
    });
  }

  async claimCandidate(
    identityInput: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    const targetWideIdentity = plannedTargetWideCandidateIdentity(identity);
    const record: PlannedAnchorCandidateRecord = {
      v: 1,
      t: "planned-anchor-candidate-claimed",
      identity,
    };
    return (await this.#transact(identity.transferId, (projection) => {
      const targetWide = assertTargetWideAnchorCandidateAvailable(
        projection.targetWideClaims,
        targetWideIdentity,
      );
      const existing = projection.claims.get(identity.transferId);
      if (existing) {
        assertCandidateIdentity(existing.identity, identity);
        if (targetWide) return { kind: "return", value: existing };
        return {
          kind: "append",
          entries: [{
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateClaim(targetWideIdentity),
          }],
          value: existing,
        };
      }
      for (const candidate of projection.claims.values()) {
        if (
          candidate.identity.homeId === identity.homeId &&
          candidate.identity.transferId !== identity.transferId &&
          candidate.terminal === undefined &&
          !projection.installedTransfers.has(candidate.identity.transferId)
        ) {
          throw new Error("Another duty-device migration candidate is already in progress");
        }
      }
      for (const [transferId, transfer] of projection.transfers) {
        if (
          transferId !== identity.transferId &&
          transfer.phase !== "aborted" &&
          transfer.phase !== "tombstoned" &&
          !projection.installedTransfers.has(transferId)
        ) {
          throw new Error("Another duty-device migration is already in progress");
        }
      }
      return {
        kind: "append",
        entries: [
          {
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateClaim(targetWideIdentity),
          },
          { stream: ANCHOR_CANDIDATE_STREAM, body: record },
        ],
        value: { identity },
      };
    })).value;
  }

  async recordReady(
    identityInput: PlannedAnchorCandidateIdentity,
    readyProof: ReadyProof,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration target has no durable candidate claim");
      assertCandidateIdentity(existing.identity, identity);
      if (existing.terminal !== undefined) {
        throw new Error("Terminal migration candidate cannot reserve readiness");
      }
      if (existing.readyProof) {
        if (canonicalize(existing.readyProof) !== canonicalize(readyProof)) {
          throw new Error("Migration ready replay changes its durable candidate proof");
        }
        return { kind: "return", value: existing };
      }
      const record: PlannedAnchorCandidateRecord = {
        v: 1,
        t: "planned-anchor-candidate-ready",
        identity,
        readyProof,
      };
      return {
        kind: "append",
        entries: [{ stream: ANCHOR_CANDIDATE_STREAM, body: record }],
        value: { ...existing, readyProof },
      };
    })).value;
  }

  async terminal(
    identityInput: PlannedAnchorCandidateIdentity,
    terminal: PlannedAnchorCandidateTerminal,
    abortInput?: AnchorTransferAbort,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    const targetWideIdentity = plannedTargetWideCandidateIdentity(identity);
    const abort = terminal === "aborted"
      ? validateCandidateAbort(abortInput, identity, this.verifier)
      : undefined;
    if (terminal !== "aborted" && abortInput !== undefined) {
      throw new TypeError("Non-aborted migration candidate cannot store an abort decision");
    }
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration candidate terminal has no durable claim");
      assertCandidateIdentity(existing.identity, identity);
      if (terminal === "released" && existing.prepared) {
        throw new Error("Prepared migration candidate requires a signed transfer abort");
      }
      if (existing.terminal !== undefined) {
        if (existing.terminal !== terminal) {
          throw new Error("Migration candidate terminal decision conflicts with replay");
        }
        if (
          terminal === "aborted" &&
          canonicalize(existing.abort) !== canonicalize(abort)
        ) {
          throw new Error("Migration candidate abort decision conflicts with replay");
        }
        return { kind: "return", value: existing };
      }
      const record: PlannedAnchorCandidateRecord = terminal === "aborted"
        ? {
            v: 1,
            t: "planned-anchor-candidate-terminal",
            identity,
            terminal,
            abort: abort!,
          }
        : {
            v: 1,
            t: "planned-anchor-candidate-terminal",
            identity,
            terminal,
          };
      return {
        kind: "append",
        entries: [
          { stream: ANCHOR_CANDIDATE_STREAM, body: record },
          {
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateTerminal(
              targetWideIdentity,
              terminal,
            ),
          },
        ],
        value: abort ? { ...existing, terminal, abort } : { ...existing, terminal },
      };
    })).value;
  }

  async markPrepared(
    identityInput: PlannedAnchorCandidateIdentity,
    preparedInput: PlannedAnchorPreparedRecord,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    const prepared = validateCandidatePrepared(preparedInput, identity, this.verifier);
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration prepare has no durable candidate claim");
      assertCandidateIdentity(existing.identity, identity);
      if (existing.terminal !== undefined) {
        throw new Error("Terminal migration candidate cannot be prepared");
      }
      if (existing.prepared) {
        if (canonicalize(existing.prepared) !== canonicalize(prepared)) {
          throw new Error("Migration candidate prepared decision conflicts with replay");
        }
        return { kind: "return", value: existing };
      }
      const record: PlannedAnchorCandidateRecord = {
        v: 1,
        t: "planned-anchor-candidate-prepared",
        identity,
        prepared,
      };
      return {
        kind: "append",
        entries: [{ stream: ANCHOR_CANDIDATE_STREAM, body: record }],
        value: { ...existing, prepared },
      };
    })).value;
  }

  async decideRemoteAbort(
    identityInput: PlannedAnchorCandidateIdentity,
    abortInput: AnchorTransferAbort,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    const targetWideIdentity = plannedTargetWideCandidateIdentity(identity);
    const abort = validateCandidateAbort(abortInput, identity, this.verifier);
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration abort has no durable candidate claim");
      assertCandidateIdentity(existing.identity, identity);
      if (existing.terminal !== undefined) {
        if (
          existing.terminal !== "aborted" ||
          canonicalize(existing.abort) !== canonicalize(abort)
        ) {
          throw new Error("Migration candidate terminal decision conflicts with abort");
        }
        return { kind: "return", value: existing };
      }
      if (existing.prepared) return { kind: "return", value: existing };
      const record: PlannedAnchorCandidateRecord = {
        v: 1,
        t: "planned-anchor-candidate-terminal",
        identity,
        terminal: "aborted",
        abort,
      };
      return {
        kind: "append",
        entries: [
          { stream: ANCHOR_CANDIDATE_STREAM, body: record },
          {
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateTerminal(targetWideIdentity, "aborted"),
          },
        ],
        value: { ...existing, terminal: "aborted" as const, abort },
      };
    })).value;
  }

  async releaseUnprepared(
    identityInput: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    const targetWideIdentity = plannedTargetWideCandidateIdentity(identity);
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration candidate release has no durable claim");
      assertCandidateIdentity(existing.identity, identity);
      if (existing.terminal !== undefined) {
        if (existing.terminal !== "released") {
          throw new Error("Migration candidate terminal decision conflicts with release");
        }
        return { kind: "return", value: existing };
      }
      if (existing.prepared || projection.transfers.has(identity.transferId)) {
        throw new Error("Prepared migration candidate requires a signed transfer abort");
      }
      const record: PlannedAnchorCandidateRecord = {
        v: 1,
        t: "planned-anchor-candidate-terminal",
        identity,
        terminal: "released",
      };
      return {
        kind: "append",
        entries: [
          { stream: ANCHOR_CANDIDATE_STREAM, body: record },
          {
            stream: ANCHOR_CANDIDATE_STREAM,
            body: targetWideAnchorCandidateTerminal(targetWideIdentity, "released"),
          },
        ],
        value: { ...existing, terminal: "released" as const },
      };
    })).value;
  }

  async markReleaseDelivered(
    identityInput: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration candidate release has no durable claim");
      assertCandidateIdentity(existing.identity, identity);
      if (existing.terminal !== "released") {
        throw new Error("Only a released migration candidate can complete remote cleanup");
      }
      if (existing.releaseDelivered) return { kind: "return", value: existing };
      const record: PlannedAnchorCandidateRecord = {
        v: 1,
        t: "planned-anchor-candidate-release-delivered",
        identity,
      };
      return {
        kind: "append",
        entries: [{ stream: ANCHOR_CANDIDATE_STREAM, body: record }],
        value: { ...existing, releaseDelivered: true as const },
      };
    })).value;
  }

  /** 目标端：只领了声明或已中止的候选清理完成后写下，候选随之离开未完目录。 */
  async markCleaned(
    identityInput: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState> {
    const identity = validateCandidateIdentity(identityInput);
    return (await this.#transact(identity.transferId, (projection) => {
      const existing = projection.claims.get(identity.transferId);
      if (!existing) throw new Error("Migration candidate cleanup has no durable claim");
      assertCandidateIdentity(existing.identity, identity);
      if (existing.terminal !== "aborted" && existing.terminal !== "released") {
        throw new Error("Only an aborted or released migration candidate can complete cleanup");
      }
      if (existing.cleaned) return { kind: "return", value: existing };
      const record: PlannedAnchorCandidateRecord = {
        v: 1,
        t: "planned-anchor-candidate-cleaned",
        identity,
      };
      return {
        kind: "append",
        entries: [{ stream: ANCHOR_CANDIDATE_STREAM, body: record }],
        value: { ...existing, cleaned: true as const },
      };
    })).value;
  }

  async stopStorageMaintenance(): Promise<void> {
    await this.log.stopStorageMaintenance();
  }

  async #read<T>(read: (view: DurableProjectionReadContext) => Promise<T>): Promise<T> {
    return (await this.log.transactDurableProjection(this.#projectionId, async (view) => ({
      kind: "return" as const,
      value: await read(view),
    }))).value;
  }

  /** 决定函数照原样消费小投影：本 transferId、未完候选、进行中的全目标候选与（含迁居状态时）进行中的迁居。 */
  async #transact<Value>(
    transferId: string,
    decide: (
      projection: PlannedAnchorCandidateProjection,
    ) => import("@zhixing/core/authority").ProjectionTransactionDecision<unknown, Value>,
  ) {
    return this.log.transactDurableProjection<unknown, Value>(this.#projectionId, async (view) =>
      decide(await readPlannedJournalProjection(view, [transferId], {
        openCandidates: true,
        openTransfers: this.includeTransferState,
      })));
  }

  /** 迁居日志的事务：同一按键投影上读本 transferId 的迁居与候选，再按原决定函数追加。 */
  async transactTransfer<Value>(
    transferId: string,
    decide: (
      projection: PlannedAnchorCandidateProjection,
    ) => import("@zhixing/core/authority").ProjectionTransactionDecision<unknown, Value>,
    candidateReferences?: readonly ArtifactRef[],
  ) {
    return this.log.transactDurableProjection<unknown, Value>(this.#projectionId, async (view) =>
      decide(await readPlannedJournalProjection(view, [transferId], { openCandidates: false, openTransfers: false })),
      candidateReferences ? { candidateReferences } : undefined);
  }

  /** 按键读迁居状态与各目录（只用于含迁居状态的日志）。 */
  readIndex<T>(read: (view: DurableProjectionReadContext) => Promise<T>): Promise<T> {
    return this.#read(read);
  }
}

export class PlannedAnchorTransferJournal implements PlannedAnchorPrivateJournalPort {
  readonly #candidates: PlannedAnchorCandidateJournal;

  constructor(
    private readonly log: PlannedAnchorJournalStorage,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {
    this.#candidates = new PlannedAnchorCandidateJournal(log, verifier, true);
  }

  claimCandidate(identity: PlannedAnchorCandidateIdentity): Promise<PlannedAnchorCandidateState> {
    return this.#candidates.claimCandidate(identity);
  }

  candidate(transferId: string): Promise<PlannedAnchorCandidateState | undefined> {
    return this.#candidates.state(transferId);
  }

  /** 显式历史查询：枚举全部候选。恢复用 unfinishedCandidates。 */
  candidates(): Promise<ReadonlyMap<string, PlannedAnchorCandidateState>> {
    return this.#candidates.states();
  }

  unfinishedCandidates(): Promise<ReadonlyMap<string, PlannedAnchorCandidateState>> {
    return this.#candidates.unfinishedStates();
  }

  /** 给定源设备最近一次任期内的全部迁居（按“本机源端按任期”目录读第一组），与历史任期数无关。 */
  latestSourceTransfers(sourceDeviceId: string): Promise<readonly PlannedAnchorTransferState[]> {
    return this.#candidates.readIndex(async (view) => {
      const prefix = ownTransferPrefix(sourceDeviceId);
      const first = (await view.scan({ gte: prefix, lt: `${prefix}￿` }, 1)).entries[0];
      if (!first) return [];
      const epochPrefix = first.key.slice(0, prefix.length + 17);
      const states: PlannedAnchorTransferState[] = [];
      for (const transferId of await journalDirectory(view, epochPrefix)) {
        const state = journalRow<PlannedAnchorTransferState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.transfer, transferId)));
        if (!state || state.identity.sourceDeviceId !== sourceDeviceId) {
          throw new DurableProjectionRecordBindingError("Planned migration source directory has no matching state");
        }
        states.push(state);
      }
      return states;
    });
  }

  terminalCandidate(
    identity: PlannedAnchorCandidateIdentity,
    terminal: PlannedAnchorCandidateTerminal,
    abort?: AnchorTransferAbort,
  ): Promise<PlannedAnchorCandidateState> {
    return this.#candidates.terminal(identity, terminal, abort);
  }

  releaseUnpreparedCandidate(
    identity: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState> {
    return this.#candidates.releaseUnprepared(identity);
  }

  async prepareCandidate(
    record: Extract<PlannedRecord, { t: "anchor-prepared" }>,
  ): Promise<PlannedAnchorTransferState> {
    const next = reducePlannedAnchorTransfer(undefined, record, this.verifier);
    const identity = candidateIdentityFromState(next);
    const result = await this.#candidates.transactTransfer<PlannedAnchorTransferState>(
      record.transferId,
      (projection) => {
        const candidate = projection.claims.get(record.transferId);
        if (!candidate) throw new Error("Migration prepare has no durable candidate claim");
        assertCandidateIdentity(candidate.identity, identity);
        if (candidate.terminal !== undefined) {
          throw new Error("Terminal migration candidate cannot be prepared");
        }
        const current = projection.transfers.get(record.transferId);
        const prepared = reducePlannedAnchorTransfer(current, record, this.verifier);
        if (current === prepared && candidate.prepared) {
          return { kind: "return", value: prepared };
        }
        const entries: LogicalRecord<unknown>[] = [];
        if (!candidate.prepared) {
          entries.push({
            stream: ANCHOR_CANDIDATE_STREAM,
            body: {
              v: 1,
              t: "planned-anchor-candidate-prepared",
              identity,
              prepared: record,
            } satisfies PlannedAnchorCandidateRecord,
          });
        }
        if (current !== prepared) {
          entries.push({ stream: ANCHOR_TRANSFER_STREAM, body: record });
        }
        return { kind: "append", entries, value: prepared };
      },
    );
    return result.value;
  }

  markCandidateReleaseDelivered(
    identity: PlannedAnchorCandidateIdentity,
  ): Promise<PlannedAnchorCandidateState> {
    return this.#candidates.markReleaseDelivered(identity);
  }

  /** 按 transferId 精确读迁居状态，不重放迁居流。 */
  async state(transferId: string): Promise<PlannedAnchorTransferState | undefined> {
    return this.#candidates.readIndex(async (view) =>
      journalRow<PlannedAnchorTransferState>(await view.get(plannedJournalKey(PLANNED_JOURNAL_KEYS.transfer, transferId))));
  }

  /** 显式历史查询：枚举全部迁居。启动恢复用 latestSourceTransfers。 */
  async states(): Promise<ReadonlyMap<string, PlannedAnchorTransferState>> {
    return this.#candidates.readIndex(async (view) => {
      const states = new Map<string, PlannedAnchorTransferState>();
      let continuation: string | undefined;
      do {
        const page = await view.scan({ gte: PLANNED_JOURNAL_KEYS.transfer, lt: `${PLANNED_JOURNAL_KEYS.transfer}￿` }, 128, continuation);
        for (const entry of page.entries) {
          const state = journalRow<PlannedAnchorTransferState>(entry.value)!;
          states.set(state.identity.transferId, state);
        }
        continuation = page.continuation;
      } while (continuation);
      return states;
    });
  }

  async stopStorageMaintenance(): Promise<void> {
    await this.log.stopStorageMaintenance();
  }

  async append(
    record: PlannedRecord,
    extraEntries: readonly LogicalRecord<unknown>[] = [],
    beforeAppend?: () => void,
  ): Promise<PlannedAnchorTransferState> {
    const entries = [
      ...extraEntries,
      { stream: ANCHOR_TRANSFER_STREAM, body: record },
    ] as LogicalRecord<PlannedRecord>[];
    const result = await this.#candidates.transactTransfer<PlannedAnchorTransferState>(
      record.transferId,
      (projection) => {
        const current = projection.transfers.get(record.transferId);
        const next = reducePlannedAnchorTransfer(current, record, this.verifier);
        if (current === next) return { kind: "return", value: next };
        beforeAppend?.();
        return {
          kind: "append",
          entries,
          value: next,
        };
      },
      collectArtifactRefs(entries),
    );
    return result.value;
  }

  /** 只读进行中的迁居目录（阶段不为 aborted/tombstoned），不枚举历史。 */
  async assertNoCompetingTransfer(transferId: string): Promise<void> {
    const competing = await this.#candidates.readIndex(async (view) =>
      (await journalDirectory(view, PLANNED_JOURNAL_KEYS.openTransfer)).filter((candidate) => candidate !== transferId));
    if (competing.length > 0) {
      throw new Error("Another duty-device migration is already in progress");
    }
  }

  async readyReservation(transferId: string): Promise<ReadyReservation | undefined> {
    const reservations = await this.log.rebuildProjection<
      ReadonlyMap<string, ReadyReservation>,
      ReadyReservation
    >(new Map(), (current, entry) => {
      if (entry.stream !== READY_RESERVATION_STREAM) return current;
      const record = validateReadyReservation(entry.body);
      const next = new Map(current);
      const existing = next.get(record.transferId);
      if (existing && canonicalize(existing) !== canonicalize(record)) {
        throw new Error("Migration ready reservation changed its durable identity");
      }
      next.set(record.transferId, record);
      return next;
    }, { stream: READY_RESERVATION_STREAM });
    return reservations.get(transferId);
  }

  async reserveReady(record: ReadyReservation): Promise<ReadyReservation> {
    const valid = validateReadyReservation(record);
    const result = await this.log.transactProjection<
      ReadonlyMap<string, ReadyReservation>,
      ReadyReservation,
      ReadyReservation
    >(new Map(), (current, entry) => {
      if (entry.stream !== READY_RESERVATION_STREAM) return current;
      const next = new Map(current);
      const observed = validateReadyReservation(entry.body);
      next.set(observed.transferId, observed);
      return next;
    }, (current) => {
      const existing = current.get(valid.transferId);
      if (existing) {
        if (canonicalize(existing) !== canonicalize(valid)) {
          throw new Error("Migration ready reservation conflicts with its durable replay");
        }
        return { kind: "return", value: existing };
      }
      return {
        kind: "append",
        entries: [{ stream: READY_RESERVATION_STREAM, body: valid }],
        value: valid,
      };
    }, { stream: READY_RESERVATION_STREAM });
    return result.value;
  }
}

export class PlannedAnchorTransferTarget implements PlannedAnchorTransferTargetPort {
  readonly #staging: PlannedAnchorTargetStaging;
  readonly #candidates: PlannedAnchorCandidateJournalPort;

  constructor(private readonly options: {
    readonly deviceId: string;
    readonly identityKey: DeviceKey;
    readonly secretStore: SecretStorePort;
    readonly bootstrapStore: FileMeshBootstrapStore;
    readonly authorityLog: PlannedAnchorInstallAuthorityPort;
    readonly artifacts: ArtifactStore;
    readonly staging: PlannedAnchorTransferStagingArea;
    readonly sourceFor: (deviceId: string) => PlannedAnchorTransferArtifactSourcePort;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
    readonly signer: ProtocolSigner;
    readonly verifier: ProtocolSignatureVerifier;
    readonly readiness: PlannedAnchorReadinessPort;
    readonly onInstalled?: (record: HomeTrustRecord) => void | Promise<void>;
    readonly now?: () => number;
  }) {
    if (options.identityKey.deviceId !== options.deviceId) {
      throw new TypeError("Migration target identity key belongs to another device");
    }
    const integrity = options.bootstrapStore.authoritySources()?.integrity;
    this.#staging = options.staging.openTarget({
      artifacts: options.artifacts,
      verifier: options.verifier,
      ...(integrity ? { integrity } : {}),
    });
    this.#candidates = this.#staging.candidates;
  }

  state(transferId: string): Promise<PlannedAnchorTransferState | undefined> {
    return this.#context(transferId).journal.state(transferId);
  }

  /**
   * Restores durable late-ready exclusions before public target admission.
   * 只遍历未完候选：已提交的迁居不再打开它的私有日志，读取随未完工作数，与历史迁居次数无关。
   */
  async recoverBeforeAdmission(): Promise<void> {
    for (const candidate of (await this.#candidates.unfinishedStates()).values()) {
      const transferId = candidate.identity.transferId;
      const context = this.#context(transferId);
      let state = await context.journal.state(transferId);
      if (!state) {
        if (candidate.terminal === "aborted" || candidate.terminal === "released") {
          await this.#cleanupClaimOnlyCandidate(candidate);
          continue;
        }
        if (candidate.prepared && candidate.terminal === undefined) {
          state = await context.journal.append(candidate.prepared);
        }
        if (!state) continue;
      }
      const identity = candidateIdentityFromState(state);
      await this.#candidates.claimCandidate(identity);
      if (state.phase === "aborted") {
        await this.#candidates.terminal(identity, "aborted", state.abort!);
        // 中止的清理可重复执行；确认后候选离开未完目录
        await this.#cleanupAborted(context, state);
        continue;
      }
      if (state.phase === "committed" || state.phase === "tombstoned") {
        await this.#candidates.terminal(identity, "committed");
        continue;
      }
      const reservation = await context.journal.readyReservation(transferId);
      if (!reservation) continue;
      await this.options.readiness.reserve({
        transferId: reservation.transferId,
        expiresAt: reservation.expiresAt,
      });
    }
  }

  async summary(): Promise<PlannedAnchorTargetReadinessSummary> {
    await this.options.readiness.snapshot();
    return Object.freeze({ ready: true as const });
  }

  async ready(input: {
    readonly candidate: PlannedAnchorCandidateIdentity;
  }): Promise<ReadyProof> {
    const identity = validateCandidateIdentity(input.candidate);
    if (identity.targetDeviceId !== this.options.deviceId) {
      throw new TypeError("Migration candidate targets another device");
    }
    let trust = await currentTrust(this.options.bootstrapStore);
    assertCandidateTrust(identity, trust);
    const candidate = await this.#candidates.claimCandidate(identity);
    trust = await currentTrust(this.options.bootstrapStore);
    assertCandidateTrust(identity, trust);
    if (candidate.terminal !== undefined) {
      throw new Error("Terminal migration candidate cannot reserve target readiness");
    }
    const context = this.#context(identity.transferId);
    const existing = await context.journal.state(identity.transferId);
    if (existing) {
      if (
        existing.identity.sourceDeviceId !== identity.sourceDeviceId ||
        existing.identity.targetDeviceId !== this.options.deviceId
      ) {
        throw new Error("Migration ready replay conflicts with its durable identity");
      }
      if (existing.phase === "aborted") {
        throw new Error("Cancelled migration cannot reserve target readiness");
      }
      if (existing.phase !== "committed" && existing.phase !== "tombstoned") {
        const snapshot = await this.options.readiness.reserve({
          transferId: identity.transferId,
          expiresAt: existing.readyProof.expiresAt,
        });
        try {
          validateAnchorTransferReadyProof({
            proof: existing.readyProof,
            trust,
            targetDeviceId: this.options.deviceId,
            expected: snapshot,
            expectedIdentity: {
              requestId: identity.requestId,
              candidateDigest: plannedReadyCandidateDigest(identity),
            },
            now: this.options.now?.(),
          });
          const issuerKey = await loadAnchorIssuerKey(
            this.options.secretStore,
            identity.transferId,
          );
          if (
            !issuerKey ||
            issuerKey.deviceId !== existing.readyProof.targetIssuerKeyId ||
            issuerKey.publicKey !== existing.readyProof.targetIssuerPublicKey
          ) {
            throw new Error("Migration issuer key no longer matches its ready proof");
          }
          await context.journal.reserveReady(readyReservation(
            existing.readyProof,
            snapshot,
          ));
        } catch (error) {
          await this.options.readiness.release(identity.transferId);
          throw error;
        }
      }
      return existing.readyProof;
    }
    if (candidate.readyProof) {
      validateAnchorTransferReadyProof({
        proof: candidate.readyProof,
        trust,
        targetDeviceId: this.options.deviceId,
        expected: await this.options.readiness.snapshot(),
        expectedIdentity: {
          requestId: identity.requestId,
          candidateDigest: plannedReadyCandidateDigest(identity),
        },
        now: this.options.now?.(),
      });
      const issuerKey = await loadAnchorIssuerKey(
        this.options.secretStore,
        identity.transferId,
      );
      if (
        !issuerKey ||
        issuerKey.deviceId !== candidate.readyProof.targetIssuerKeyId ||
        issuerKey.publicKey !== candidate.readyProof.targetIssuerPublicKey
      ) {
        throw new Error("Migration candidate issuer key no longer matches its ready proof");
      }
      return candidate.readyProof;
    }
    const readyProof = (await createAnchorTransferReadyProof({
      requestId: identity.requestId,
      transferId: identity.transferId,
      candidateDigest: plannedReadyCandidateDigest(identity),
      targetIdentityKey: this.options.identityKey,
      trust,
      secretStore: this.options.secretStore,
      snapshot: await this.options.readiness.snapshot(),
      now: this.options.now?.(),
    })).proof;
    return (await this.#candidates.recordReady(identity, readyProof)).readyProof!;
  }

  async releaseCandidate(input: PlannedAnchorCandidateRelease): Promise<void> {
    const release = validateCandidateRelease(input, this.options.verifier);
    if (release.identity.targetDeviceId !== this.options.deviceId) {
      throw new TypeError("Migration candidate release targets another device");
    }
    const candidate = await this.#candidates.state(release.identity.transferId);
    if (!candidate) throw new Error("Migration candidate release has no target claim");
    assertCandidateIdentity(candidate.identity, release.identity);
    const context = this.#context(release.identity.transferId);
    const phase = await context.journal.state(release.identity.transferId);
    if (phase) {
      throw new Error("Prepared migration candidate requires a signed transfer abort");
    }
    await this.#candidates.releaseUnprepared(release.identity);
    const issuerKey = await loadAnchorIssuerKey(
      this.options.secretStore,
      release.identity.transferId,
    );
    if (issuerKey) {
      await deleteAnchorIssuerKey(
        this.options.secretStore,
        release.identity.transferId,
        issuerKey.deviceId,
      );
    }
    await context.cleanupTransferAndJournal();
    await this.options.readiness.release(release.identity.transferId);
    // 清理确认后候选离开未完目录，此后启动不再访问它
    await this.#candidates.markCleaned(release.identity);
  }

  async apply(commandInput: AnchorTransferCommand): Promise<AnchorTransferResult> {
    const command = validateAnchorTransferCommand(commandInput, this.options.verifier);
    if (command.op === "status") {
      const candidate = await this.#candidates.state(command.transferId);
      if (!candidate) return resultFor(command, undefined);
      if (candidate.terminal === "aborted" && candidate.abort) {
        return candidateAbortResult(command, candidate.abort);
      }
      const context = this.#context(command.transferId);
      return this.#result(command, await context.journal.state(command.transferId));
    }
    const candidate = await this.#candidates.state(command.transferId);
    if (!candidate) throw new Error("Migration target has no durable candidate claim");
    if (command.op === "freeze") return this.#freeze(command);
    if (command.op === "import") return this.#import(command);
    if (command.op === "commit") return this.#commit(command);
    if (command.op === "abort") return this.#abort(command);
    if (command.op !== "prepare") throw new Error("Migration target has not enabled this transfer phase yet");
    if (candidate.terminal !== undefined || !candidate.readyProof) {
      throw new Error("Migration prepare has no active ready candidate");
    }
    if (
      command.requestId !== candidate.identity.requestId ||
      command.sourceDeviceId !== candidate.identity.sourceDeviceId ||
      command.targetDeviceId !== candidate.identity.targetDeviceId ||
      command.sourceAnchorEpoch !== candidate.identity.sourceAnchorEpoch ||
      canonicalize(command.readyProof) !== canonicalize(candidate.readyProof)
    ) {
      throw new TypeError("Migration prepare does not bind its durable candidate claim");
    }
    const context = this.#context(command.transferId);
    const trust = await currentTrust(this.options.bootstrapStore);
    if (
      command.sourceDeviceId !== trust.issuer.deviceId ||
      command.targetDeviceId !== this.options.deviceId
    ) {
      throw new Error("Migration prepare command does not bind the current devices");
    }
    validateAnchorTransferReadyProof({
      proof: command.readyProof,
      trust,
      targetDeviceId: this.options.deviceId,
      expected: await this.options.readiness.snapshot(),
      expectedIdentity: {
        requestId: command.requestId,
        candidateDigest: plannedReadyCandidateDigest(candidate.identity),
      },
      now: this.options.now?.(),
    });
    const issuerKey = await loadAnchorIssuerKey(this.options.secretStore, command.transferId);
    if (
      !issuerKey ||
      issuerKey.deviceId !== command.readyProof.targetIssuerKeyId ||
      issuerKey.publicKey !== command.readyProof.targetIssuerPublicKey
    ) {
      throw new Error("Migration issuer key no longer matches its ready proof");
    }
    applyTrustEvent(trust, command.trustTransition);
    const prepared = preparedRecord(command);
    const decision = await this.#candidates.markPrepared(candidate.identity, prepared);
    const state = await context.journal.append(decision.prepared!);
    return this.#result(command, state);
  }

  async #freeze(
    command: Extract<AnchorTransferCommand, { op: "freeze" }>,
  ): Promise<AnchorTransferResult> {
    const context = this.#context(command.transferId);
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase !== "prepared" && state.phase !== "fenced") {
      return this.#result(command, state);
    }
    if (
      command.proof.sourceEpoch !== state.identity.sourceAnchorEpoch ||
      command.proof.subject !== state.identity.sourceDeviceId
    ) {
      throw new TypeError("Migration freeze proof changes its prepared source identity");
    }
    const source = this.options.sourceFor(state.identity.sourceDeviceId);
    await context.journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-fenced",
      transferId: command.transferId,
      sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
      recoveryCheckpointDigest: command.recoveryCheckpointDigest,
      at: new Date().toISOString(),
    });
    await Promise.all([
      this.#pull(context, source, command, command.checkpoint),
      this.#pull(context, source, command, command.catalog),
    ]);
    const catalog = parseAuthorityCatalog(await context.artifacts.get(command.catalog));
    const exported = parseAuthorityExport(await context.artifacts.get(command.checkpoint));
    for (const page of exported.pages) {
      await this.#pull(context, source, command, page.ref);
      validateAuthorityExportPage(
        await context.artifacts.get(page.ref),
        page,
      );
    }
    for (const reference of catalog.retainedArtifacts) {
      await this.#pull(context, source, command, reference);
    }
    assertExportBinding(catalog, exported, command.proof, state);
    const next = await context.journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-frozen",
      transferId: command.transferId,
      checkpoint: command.checkpoint,
      catalog,
      catalogRef: command.catalog,
      proof: command.proof,
    });
    return this.#result(command, next);
  }

  async #import(
    command: Extract<AnchorTransferCommand, { op: "import" }>,
  ): Promise<AnchorTransferResult> {
    const context = this.#context(command.transferId);
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase === "imported") return this.#result(command, state);
    if (
      state.phase !== "frozen" ||
      state.checkpoint?.digest !== command.checkpoint.digest ||
      state.catalogRef?.digest !== command.catalog.digest
    ) {
      throw new TypeError("Migration import does not bind the frozen artifacts");
    }
    for (const ref of state.catalog?.retainedArtifacts ?? []) {
      await this.#pull(
        context,
        this.options.sourceFor(state.identity.sourceDeviceId),
        createSignedAnchorTransferCommand({
          v: 1,
          op: "freeze",
          requestId: state.identity.requestId,
          transferId: state.identity.transferId,
          recoveryCheckpointDigest: state.recoveryCheckpointDigest!,
          checkpoint: state.checkpoint!,
          catalog: state.catalogRef!,
          proof: state.proof!,
        }, this.options.signer) as Extract<AnchorTransferCommand, { op: "freeze" }>,
        ref,
      );
    }
    const importedRefs = uniqueRefs([
      state.checkpoint!,
      state.catalogRef!,
      ...(state.catalog?.retainedArtifacts ?? []),
    ]);
    for (const ref of importedRefs) {
      if (!(await context.artifacts.has(ref))) {
        throw new Error(`Migration private import is missing ${ref.digest}`);
      }
    }
    // 家级路由材料在源端决定提交之前取到并按 transferId 暂存：源端退役后无从补取
    const source = this.options.sourceFor(state.identity.sourceDeviceId);
    if (source.routeMaterial) {
      const material = await source.routeMaterial(command.transferId, this.options.deviceId);
      if (material.homeId !== state.readyProof.homeId) {
        throw new Error("Migration route material belongs to another home");
      }
      await stageHomeRouteMaterial(this.options.secretStore, command.transferId, material);
    }
    const next = await context.journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-imported",
      transferId: command.transferId,
      checkpointDigest: command.checkpoint.digest,
      authorityCatalogDigest: command.catalog.digest,
    });
    return this.#result(command, next);
  }

  async #commit(
    command: Extract<AnchorTransferCommand, { op: "commit" }>,
  ): Promise<AnchorTransferResult> {
    const context = this.#context(command.transferId);
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase === "committed" || state.phase === "tombstoned") {
      if (canonicalize(state.commit) !== canonicalize(command.commit)) {
        throw new TypeError("Migration commit replay changes the signed decision");
      }
      const completion = await completePlannedAnchorInstallationBeforeBootstrap({
        deviceId: this.options.deviceId,
        secretStore: this.options.secretStore,
        bootstrapStore: this.options.bootstrapStore,
        verifier: this.options.verifier,
        staging: this.options.staging,
      });
      if (!completion || completion.installation.transferId !== command.transferId) {
        throw new Error("Committed migration has no exact installation completion");
      }
      // 安装收尾已完成时描述不带私有状态，重放沿用本次已读到的已提交状态
      const committedState = completion.requiresPostInstallCompletion ? completion.state : state;
      await this.#candidates.terminal(
        candidateIdentityFromState(committedState),
        "committed",
      );
      const trustRecord = await this.#completeInstallation(
        context,
        committedState,
        completion.installation.trustRecord,
      );
      return resultFor(command, committedState, trustRecord);
    }
    if (state.phase !== "imported" || !state.checkpoint || !state.catalogRef || !state.catalog) {
      throw new Error("Migration target cannot commit before its private import is complete");
    }
    if (
      this.options.sourceFor(state.identity.sourceDeviceId).routeMaterial &&
      !(await loadStagedHomeRouteMaterial(this.options.secretStore, command.transferId))
    ) {
      throw new Error("Migration target has no staged home route material");
    }
    const committedRecord: Extract<PlannedRecord, { t: "anchor-committed" }> = {
      v: 1,
      mode: "planned",
      t: "anchor-committed",
      transferId: command.transferId,
      commit: command.commit,
    };
    reducePlannedAnchorTransfer(state, committedRecord, this.options.verifier);
    const issuerKey = await loadAnchorIssuerKey(this.options.secretStore, command.transferId);
    if (
      !issuerKey ||
      issuerKey.deviceId !== state.readyProof.targetIssuerKeyId ||
      issuerKey.publicKey !== command.commit.targetIssuerPublicKey
    ) {
      throw new Error("Migration commit no longer owns the prepared target issuer key");
    }
    const current = await currentTrust(this.options.bootstrapStore);
    if (
      current.homeId !== state.readyProof.homeId ||
      current.trustEpoch !== state.readyProof.trustEpoch ||
      canonicalize(current.chainHead) !== canonicalize(state.readyProof.trustChainHead)
    ) {
      throw new Error("Migration target trust generation changed before commit installation");
    }
    const snapshot = await this.options.readiness.reserve({
      transferId: command.transferId,
      expiresAt: state.readyProof.expiresAt,
    });
    validateAnchorTransferReadyProof({
      proof: state.readyProof,
      trust: current,
      targetDeviceId: this.options.deviceId,
      expected: snapshot,
      now: this.options.now?.(),
    });
    const reservation = await context.journal.readyReservation(command.transferId);
    const expectedReservation = readyReservation(state.readyProof, snapshot);
    if (!reservation || canonicalize(reservation) !== canonicalize(expectedReservation)) {
      throw new Error("Migration commit has no current durable readiness reservation");
    }
    const transition = requireMigrationTransition(state.trustTransition);
    const nextTrust = applyTrustEvent(current, transition);
    if (nextTrust.trustEpoch !== command.commit.nextTrustEpoch) {
      throw new TypeError("Migration commit trust epoch does not match its transition");
    }
    const trustRecord = buildHomeTrustRecord(nextTrust, issuerKey);
    const references = uniqueRefs([
      state.checkpoint,
      state.catalogRef,
      state.catalog.authorityRecords,
      ...state.catalog.retainedArtifacts,
    ]);
    for (const reference of references) await this.#promote(context, reference, command.transferId);
    const exported = parseAuthorityExport(await context.artifacts.get(state.checkpoint));
    const installation = plannedAnchorInstallation({
      commit: command.commit,
      transition,
      trustRecord,
      checkpoint: state.checkpoint,
      catalog: state.catalogRef,
      sourceHead: exported.checkpoint,
    });
    await this.options.authorityLog.installPlannedAnchorPrefix({
      source: importedAuthorityEnvelopes(context.artifacts, exported),
      sourceHead: exported.checkpoint,
      installationEntries: [
        { stream: "trust", body: { t: "home-trust-event", event: transition } },
        { stream: "trust", body: { t: "home-trust-record", record: trustRecord } },
        { stream: "transfer:anchor-current", body: installation },
      ],
      candidateReferences: references,
    });
    // 本机若是被新任期取代的旧源端（迁回原值班设备），安装已耐久后释放旧任期的 fence
    PlannedAnchorTransferOwner.releaseSupersededFence(this.options.authorityLog, {
      deviceId: this.options.deviceId,
      installedAnchorEpoch: command.commit.nextAnchorEpoch,
    });
    const completion = await completePlannedAnchorInstallationBeforeBootstrap({
      deviceId: this.options.deviceId,
      secretStore: this.options.secretStore,
      bootstrapStore: this.options.bootstrapStore,
      verifier: this.options.verifier,
      staging: this.options.staging,
    });
    if (
      !completion ||
      completion.installation.transferId !== command.transferId ||
      !completion.requiresPostInstallCompletion
    ) {
      throw new Error("Installed migration completion did not bind the committed transfer");
    }
    await this.#candidates.terminal(
      candidateIdentityFromState(completion.state),
      "committed",
    );
    await this.#completeInstallation(
      context,
      completion.state,
      completion.installation.trustRecord,
    );
    return resultFor(command, completion.state, trustRecord);
  }

  async #abort(
    command: Extract<AnchorTransferCommand, { op: "abort" }>,
  ): Promise<AnchorTransferResult> {
    const candidate = await this.#candidates.state(command.transferId);
    if (!candidate) throw new Error("Migration abort has no durable candidate claim");
    if (
      command.requestId !== candidate.identity.requestId ||
      command.signature.keyId !== candidate.identity.sourceDeviceId
    ) {
      throw new TypeError("Migration abort command changes its durable candidate identity");
    }
    const abort = validateCandidateAbort(
      command.abort,
      candidate.identity,
      this.options.verifier,
    );
    assertCandidateReadyProofIdentity(candidate);
    await this.#assertCandidateIssuerKey(candidate);

    const context = this.#context(command.transferId);
    let state = await context.journal.state(command.transferId);
    if (!state) {
      const decision = await this.#candidates.decideRemoteAbort(
        candidate.identity,
        abort,
      );
      if (decision.terminal === "aborted") {
        await this.#cleanupClaimOnlyCandidate(decision);
        return candidateAbortResult(command, decision.abort!);
      }
      if (!decision.prepared) {
        throw new Error("Migration abort lost its durable prepare/abort decision");
      }
      state = await context.journal.append(decision.prepared);
    }
    if (state.phase === "committed" || state.phase === "tombstoned") {
      throw new Error("Committed migration cannot be cancelled");
    }
    if (state.phase === "aborted") {
      if (canonicalize(state.abort) !== canonicalize(command.abort)) {
        throw new TypeError("Migration abort replay changes the signed decision");
      }
      await this.#candidates.terminal(
        candidateIdentityFromState(state),
        "aborted",
        state.abort!,
      );
      await this.#cleanupAborted(context, state);
      return this.#result(command, state);
    }
    const record: Extract<PlannedRecord, { t: "anchor-aborted" }> = {
      v: 1,
      mode: "planned",
      t: "anchor-aborted",
      transferId: command.transferId,
      abort,
    };
    reducePlannedAnchorTransfer(state, record, this.options.verifier);
    const next = await context.journal.append(record);
    await this.#candidates.terminal(
      candidateIdentityFromState(next),
      "aborted",
      next.abort!,
    );
    await this.#cleanupAborted(context, next);
    return this.#result(command, next);
  }

  async #assertCandidateIssuerKey(candidate: PlannedAnchorCandidateState): Promise<void> {
    const proof = candidate.readyProof!;
    const issuerKey = await loadAnchorIssuerKey(
      this.options.secretStore,
      candidate.identity.transferId,
    );
    if (
      issuerKey &&
      (
        issuerKey.deviceId !== proof.targetIssuerKeyId ||
        issuerKey.publicKey !== proof.targetIssuerPublicKey
      )
    ) {
      throw new Error("Migration candidate issuer key conflicts with its durable ready proof");
    }
  }

  async #cleanupClaimOnlyCandidate(candidate: PlannedAnchorCandidateState): Promise<void> {
    assertCandidateReadyProofIdentity(candidate);
    await this.#assertCandidateIssuerKey(candidate);
    const proof = candidate.readyProof!;
    const issuerKey = await loadAnchorIssuerKey(
      this.options.secretStore,
      candidate.identity.transferId,
    );
    if (issuerKey) {
      await deleteAnchorIssuerKey(
        this.options.secretStore,
        candidate.identity.transferId,
        proof.targetIssuerKeyId,
      );
    }
    await this.#context(candidate.identity.transferId).cleanupTransferAndJournal();
    await this.options.readiness.release(candidate.identity.transferId);
    await this.#candidates.markCleaned(candidate.identity);
  }

  async #cleanupAborted(
    context: PlannedAnchorTransferStagingSession,
    state: PlannedAnchorTransferState,
  ): Promise<void> {
    await deleteAnchorIssuerKey(
      this.options.secretStore,
      state.identity.transferId,
      state.readyProof.targetIssuerKeyId,
    );
    await context.cleanupTransfer();
    await this.options.readiness.release(state.identity.transferId);
    await this.#candidates.markCleaned(candidateIdentityFromState(state));
  }

  async #completeInstallation(
    context: PlannedAnchorTransferStagingSession,
    state: PlannedAnchorTransferState,
    trustRecord?: HomeTrustRecord,
  ): Promise<HomeTrustRecord> {
    if (!state.commit) throw new Error("Migration installation has no signed commit");
    const record = trustRecord ?? await loadInstalledAnchorTrustRecord(
      this.options.authorityLog,
      state.identity.transferId,
    );
    if (!record || record.issuer.deviceId !== state.identity.targetDeviceId) {
      throw new Error("Committed migration has no installed target trust record");
    }
    await this.options.bootstrapStore.reconcileTrustEvent({
      event: state.trustTransition,
      record,
    });
    await this.options.onInstalled?.(record);
    await context.cleanupTransfer();
    await this.options.readiness.release(state.identity.transferId);
    return record;
  }

  async #result(
    command: AnchorTransferCommand,
    state: PlannedAnchorTransferState | undefined,
  ): Promise<AnchorTransferResult> {
    const trustRecord = state &&
      (state.phase === "committed" || state.phase === "tombstoned")
      ? await loadInstalledAnchorTrustRecord(
          this.options.authorityLog,
          state.identity.transferId,
        )
      : undefined;
    return resultFor(command, state, trustRecord);
  }

  async #requiredPrepared(transferId: string): Promise<PlannedAnchorTransferState> {
    const state = await this.#context(transferId).journal.state(transferId);
    if (!state) throw new Error("Migration target has no prepared state");
    return state;
  }

  async #pull(
    context: PlannedAnchorTransferStagingSession,
    source: PlannedAnchorTransferArtifactSourcePort,
    origin: Extract<AnchorTransferCommand, { op: "freeze" }>,
    ref: ArtifactRef,
  ): Promise<void> {
    const self = this;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < ref.bytes;) {
        const length = Math.min(TRANSFER_CHUNK_BYTES, ref.bytes - offset);
        const command = createSignedAnchorTransferCommand({
          v: 1,
          op: "read-range",
          requestId: `${origin.requestId}:range:${offset}`,
          transferId: origin.transferId,
          ref,
          offset,
          length,
        }, self.options.signer);
        if (command.op !== "read-range") throw new TypeError("Migration range command changed operation");
        const result = await source.applyArtifactCommand(command);
        if (result.status !== "range") throw new Error("Migration source did not return an artifact range");
        const bytes = Buffer.from(result.data, "base64");
        const progress = await context.receiver.append(
          ref,
          offset,
          bytes,
          (_identity, operation) => runStorageMaintenanceStep(
            self.options.storageMaintenance,
            storageMaintenanceRequest(
              "authority-checkpoint",
              self.options.deviceId,
              { transferId: origin.transferId, ref, offset },
              { obligation: "pre-commit" },
            ),
            operation,
          ),
        );
        offset = progress.receivedBytes;
      }
    }
    const progress = await context.receiver.progress(ref);
    if (progress.complete) return;
    for await (const _ of chunks()) void _;
  }

  async #promote(
    context: PlannedAnchorTransferStagingSession,
    ref: ArtifactRef,
    transferId: string,
  ): Promise<void> {
    if (await this.options.artifacts.has(ref)) return;
    let progress = await context.promotion.progress(ref);
    while (!progress.complete) {
      const offset = progress.receivedBytes;
      const length = Math.min(TRANSFER_CHUNK_BYTES, ref.bytes - offset);
      const bytes = await runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.deviceId,
          { transferId, ref, offset, phase: "promote-read" },
          { obligation: "committed" },
        ),
        () => context.artifacts.readRange(ref, offset, length),
      );
      progress = await context.promotion.append(
        ref,
        offset,
        bytes,
        (_identity, operation) => runStorageMaintenanceStep(
          this.options.storageMaintenance,
          storageMaintenanceRequest(
            "authority-checkpoint",
            this.options.deviceId,
            { transferId, ref, offset, phase: "promote-write" },
            { obligation: "committed" },
          ),
          operation,
        ),
      );
    }
  }

  #context(transferId: string): PlannedAnchorTransferStagingSession {
    assertTransferStorageId(transferId);
    return this.#staging.forTransfer(transferId);
  }

  async close(): Promise<void> {
    await this.#staging.close();
  }
}

/** 每本权威日志上持有源端 fence 的 owner（同一进程里角色切换可能留下不止一个）；owner 被丢弃后 fence 仍按日志可寻。 */
const sourceFenceOwners = new WeakMap<object, Set<PlannedAnchorTransferOwner>>();

export class PlannedAnchorTransferOwner {
  readonly #journal: PlannedAnchorTransferJournal;
  #fencedTransferId: string | undefined;
  #fencedEpoch: number | undefined;
  #fencedCommitted = false;
  #disposeFence: (() => void) | undefined;
  #installingFence: Promise<void> | undefined;

  constructor(private readonly options: {
    readonly deviceId: string;
    readonly anchorEpoch: () => number;
    readonly identityKey: DeviceKey;
    readonly bootstrapStore: FileMeshBootstrapStore;
    readonly log: PlannedAnchorSourceAuthorityPort;
    readonly signer: ProtocolSigner;
    readonly verifier: ProtocolSignatureVerifier;
    readonly targetFor: (deviceId: string) => PlannedAnchorTransferTargetPort;
    readonly artifacts: ArtifactStore;
    readonly retention: ArtifactCheckpointRetentionPort;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
    readonly ensureRecoveryCheckpoint: (transferId: string) => Promise<string>;
    readonly lifecycle: PlannedAnchorTransferLifecycle;
    readonly onSourceCommitted?: (targetDeviceId: string) => void | Promise<void>;
    readonly onCommitted?: (record: HomeTrustRecord) => void | Promise<void>;
    /** 家级路由材料所在的秘密库；没有时本源端不交出材料（目标随之不要求）。 */
    readonly secretStore?: SecretStorePort;
    readonly now?: () => string;
  }) {
    this.#journal = new PlannedAnchorTransferJournal(options.log, options.verifier);
    if (!options.secretStore) this.routeMaterial = undefined;
  }

  /** 只交给已冻结或已导入、目标设备即请求方的本次迁居；此前未需要过的材料在这里生成。 */
  routeMaterial: ((transferId: string, requesterDeviceId: string) => Promise<HomeRouteMaterial>) | undefined =
    async (transferId, requesterDeviceId) => {
      const state = await this.#journal.state(transferId);
      if (
        !state ||
        (state.phase !== "frozen" && state.phase !== "imported") ||
        state.identity.targetDeviceId !== requesterDeviceId
      ) {
        throw new Error("Home route material is only released to the frozen migration target");
      }
      return loadOrCreateHomeRouteMaterial(this.options.secretStore!, state.readyProof.homeId);
    };

  /** Reinstalls a durable source fence before any public producer is admitted. */
  async recoverBeforeAdmission(): Promise<void> {
    // 按键读已验链头的 issuer（不整流重放信任事件；提交后记录未跟上时也可读）
    const trust = await this.options.bootstrapStore.loadVerifiedTrustIssuer();
    if (!trust) throw new Error("Home trust is not initialized");
    const stillIssuer = trust.issuer.deviceId === this.options.deviceId;
    // 只恢复本机作为源端、属于本机最近一次任期的迁居。导入的前缀带着前任值班设备的迁居记录，
    // 那是前任的 fence，装在本机会冻结本机；更早任期已提交的迁居已被之后的安装取代，不再约束本机。
    // 本机仍是值班设备时恢复本任期在途或已中止的迁居；已交出值班时保持最近一次已提交迁居的 fence。
    // 只读“本机源端按任期”目录的第一组，与历史迁居及导入前缀的数量无关。
    const own = await this.#journal.latestSourceTransfers(this.options.deviceId);
    const current = new Map(own
      .filter((state) => (stillIssuer
        ? state.identity.sourceAnchorEpoch === this.options.anchorEpoch() &&
          state.phase !== "committed" && state.phase !== "tombstoned"
        : state.phase === "committed" || state.phase === "tombstoned"))
      .map((state) => [state.identity.transferId, state]));
    for (const state of current.values()) {
      const identity = candidateIdentityFromState(state);
      await this.#journal.claimCandidate(identity);
      if (
        state.phase === "fenced" ||
        state.phase === "frozen" ||
        state.phase === "imported" ||
        state.phase === "committed" ||
        state.phase === "tombstoned"
      ) {
        await this.#installFence(state);
      }
      if (state.phase === "committed" || state.phase === "tombstoned") {
        await this.#journal.terminalCandidate(identity, "committed");
        await this.options.onSourceCommitted?.(state.identity.targetDeviceId);
      } else if (state.phase === "aborted") {
        await this.#journal.terminalCandidate(identity, "aborted", state.abort!);
      }
      await this.#drive(state).catch(() => undefined);
    }
    for (const candidate of (await this.#journal.unfinishedCandidates()).values()) {
      // 候选同理：只续做本机作为源端、本任期的候选；导入前缀里前任的候选不由本机投递或准备
      if (
        candidate.identity.sourceDeviceId !== this.options.deviceId ||
        !stillIssuer ||
        candidate.identity.sourceAnchorEpoch !== this.options.anchorEpoch()
      ) {
        continue;
      }
      if (candidate.terminal === "released" && !candidate.releaseDelivered) {
        await this.#deliverCandidateRelease(candidate.identity, "operator-cancelled")
          .catch(() => undefined);
        continue;
      }
      if (
        candidate.terminal !== undefined ||
        await this.#journal.state(candidate.identity.transferId) !== undefined
      ) {
        continue;
      }
      await this.#prepareCandidate(candidate).catch(() => undefined);
    }
  }

  async prepare(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<PlannedAnchorTransferState> {
    const existing = await this.#journal.state(input.transferId);
    if (existing) {
      if (
        existing.identity.requestId !== input.requestId ||
        existing.identity.sourceDeviceId !== this.options.deviceId ||
        existing.identity.targetDeviceId !== input.targetDeviceId
      ) {
        throw new Error("Migration prepare replay conflicts with its durable identity");
      }
      await this.#journal.claimCandidate(candidateIdentityFromState(existing));
      return this.#drive(existing);
    }
    const trust = await currentTrust(this.options.bootstrapStore);
    if (
      trust.issuer.deviceId !== this.options.deviceId ||
      trust.issuer.issuerKeyId !== this.options.identityKey.deviceId
    ) {
      throw new Error("Only the current duty device can start migration");
    }
    const sourceAnchorEpoch = this.options.anchorEpoch();
    const candidate = await this.#journal.claimCandidate({
      homeId: trust.homeId,
      requestId: input.requestId,
      transferId: input.transferId,
      sourceDeviceId: this.options.deviceId,
      targetDeviceId: input.targetDeviceId,
      trustEpoch: trust.trustEpoch,
      trustChainHead: trust.chainHead,
      sourceAnchorEpoch,
    });
    return this.#prepareCandidate(candidate);
  }

  async #prepareCandidate(
    candidate: PlannedAnchorCandidateState,
  ): Promise<PlannedAnchorTransferState> {
    if (candidate.terminal !== undefined) {
      throw new Error("Terminal migration candidate cannot be prepared");
    }
    const identity = candidate.identity;
    const existing = await this.#journal.state(identity.transferId);
    if (existing) return this.#drive(existing);
    const trust = await currentTrust(this.options.bootstrapStore);
    assertCandidateTrust(identity, trust);
    if (
      trust.issuer.deviceId !== this.options.deviceId ||
      trust.issuer.issuerKeyId !== this.options.identityKey.deviceId ||
      identity.sourceAnchorEpoch !== this.options.anchorEpoch()
    ) {
      throw new Error("Migration candidate no longer binds the current duty generation");
    }
    const target = this.options.targetFor(identity.targetDeviceId);
    const readyProof = validateAnchorTransferReadyProof({
      proof: await target.ready({
        candidate: identity,
      }),
      trust,
      targetDeviceId: identity.targetDeviceId,
      expectedIdentity: {
        requestId: identity.requestId,
        candidateDigest: plannedReadyCandidateDigest(identity),
      },
    });
    const trustTransition = createMigrationTransition(
      trust,
      readyProof,
      this.options.identityKey,
    );
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "prepare",
      requestId: identity.requestId,
      transferId: identity.transferId,
      sourceDeviceId: this.options.deviceId,
      targetDeviceId: identity.targetDeviceId,
      sourceAnchorEpoch: identity.sourceAnchorEpoch,
      nextAnchorEpoch: identity.sourceAnchorEpoch + 1,
      readyProof,
      trustTransition,
    }, this.options.signer);
    if (command.op !== "prepare") {
      throw new TypeError("Migration prepare command was not preserved by validation");
    }
    const state = await this.#journal.prepareCandidate(preparedRecord(command));
    await this.#sendPrepared(state);
    return state;
  }

  async fence(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<DurableLogCheckpoint> {
    const state = await this.#journal.state(input.transferId);
    if (!state) throw new Error("Migration is not prepared");
    if (state.identity.requestId !== input.requestId) {
      throw new Error("Migration fence replay changes request identity");
    }
    if (state.phase === "aborted") throw new Error("Aborted migration cannot be fenced");
    if (state.phase === "committed" || state.phase === "tombstoned") {
      await this.#installFence(state);
      return this.options.log.checkpoint();
    }
    if (state.phase !== "prepared") {
      await this.#installFence(state);
      return this.options.log.checkpoint();
    }

    const recoveryCheckpointDigest = await this.options.ensureRecoveryCheckpoint(
      input.transferId,
    );
    let admissionClosed = false;
    try {
      await this.options.lifecycle.stopAccepting();
      admissionClosed = true;
      await this.options.lifecycle.drainAccepted();
      // Register before taking the checkpoint. Appends already inside the log
      // lock finish first and are included; every later fresh append is rejected.
      await this.#installFence(state);
      const sourceHead = await this.options.log.checkpoint();
      const pendingObligations = await projectPendingObligations(
        this.options.log,
        sourceHead,
      );
      const closure: PlannedSourceClosure = {
        v: 1,
        t: "planned-anchor-source-closure",
        transferId: input.transferId,
        acceptedTokens: pendingObligations.map((obligation) => ({
          transferId: input.transferId,
          kind: obligation.kind,
          id: obligation.id,
          requestId: `planned-accepted:${obligation.kind}:${obligation.id}`,
        })),
        pendingObligations,
        sourceHead,
      };
      const closureBytes = Buffer.from(canonicalize(closure), "utf8");
      if (closureBytes.byteLength > TRANSFER_HEADER_BYTES) {
        throw new Error("Migration accepted-work closure exceeds its fixed header budget");
      }
      const closureRef = await runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.deviceId,
          { transferId: input.transferId, phase: "source-closure" },
          { obligation: "pre-commit" },
        ),
        () => this.options.artifacts.put(closureBytes),
      );
      await this.#journal.append({
        v: 1,
        mode: "planned",
        t: "anchor-fenced",
        transferId: input.transferId,
        sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
        recoveryCheckpointDigest,
        at: this.options.now?.() ?? new Date().toISOString(),
      }, [{
        stream: SOURCE_CLOSURE_STREAM,
        body: {
          v: 1,
          t: "planned-anchor-source-closure-recorded",
          transferId: input.transferId,
          sourceHead,
          closure: closureRef,
          closureDigest: protocolDigest("PlannedAnchorSourceClosure", 1, closure),
        } satisfies PlannedSourceClosureRecord,
      }]);
      return this.options.log.checkpoint();
    } catch (error) {
      const durable = await this.#journal.state(input.transferId).catch(() => undefined);
      if (durable?.phase === "prepared") {
        this.#clearFence();
        if (admissionClosed) await this.options.lifecycle.resumeAfterAbort();
      }
      throw error;
    }
  }

  async freeze(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<PlannedAnchorTransferState> {
    const frozen = await this.#journal.state(input.transferId);
    if (!frozen) throw new Error("Migration is not prepared");
    if (frozen.identity.requestId !== input.requestId) {
      throw new Error("Migration freeze replay changes request identity");
    }
    if (frozen.phase === "frozen" || frozen.phase === "imported") {
      return this.#drive(frozen);
    }
    if (frozen.phase !== "prepared" && frozen.phase !== "fenced") {
      throw new Error(`Migration cannot freeze from ${frozen.phase}`);
    }
    const checkpoint = await this.fence(input);
    const state = await this.#journal.state(input.transferId);
    if (!state || state.phase !== "fenced") throw new Error("Migration fence is unavailable");
    const closure = await loadPlannedSourceClosure(
      this.options.log,
      this.options.artifacts,
      input.transferId,
    );
    if (closure.sourceHead.lsn + 1 !== checkpoint.lsn) {
      throw new Error("Migration source closure does not bind the durable fence envelope");
    }
    const capture = await capturePlannedAuthority({
      log: this.options.log,
      artifacts: this.options.artifacts,
      retention: this.options.retention,
      storageMaintenance: this.options.storageMaintenance,
      deviceId: this.options.deviceId,
      transferId: input.transferId,
      checkpoint,
    });
    const trust = await currentTrust(this.options.bootstrapStore);
    const catalog = buildAuthorityCatalog({
      state,
      checkpoint,
      streams: capture.streams,
      authorityRecords: capture.manifestRef,
      retainedArtifacts: capture.retainedArtifacts,
      pendingObligations: capture.pendingObligations,
      trust,
    });
    if (
      canonicalize(capture.pendingObligations) !==
      canonicalize(closure.pendingObligations)
    ) {
      throw new Error("Migration pending obligations changed after accepted-work closure");
    }
    const preparedCatalog = prepareAuthorityCatalog(catalog);
    if (preparedCatalog.bytes.byteLength > TRANSFER_HEADER_BYTES) {
      throw new Error("Migration authority catalog exceeds its fixed header budget");
    }
    await this.options.artifacts.put(preparedCatalog.bytes);
    const proof = createSignedSourceFreezeProof({
      v: 1,
      transferId: input.transferId,
      scope: "anchor",
      subject: state.identity.sourceDeviceId,
      sourceEpoch: state.identity.sourceAnchorEpoch,
      checkpointDigest: capture.manifestRef.digest,
      lastLsn: checkpoint.lsn,
    }, this.options.signer);
    const next = await this.#journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-frozen",
      transferId: input.transferId,
      checkpoint: capture.manifestRef,
      catalog,
      catalogRef: preparedCatalog.ref,
      proof,
    });
    return this.#drive(next);
  }

  async commit(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<PlannedAnchorTransferState> {
    let state = await this.#journal.state(input.transferId);
    if (!state) throw new Error("Migration is not prepared");
    if (state.identity.requestId !== input.requestId) {
      throw new Error("Migration commit replay changes request identity");
    }
    if (state.phase === "aborted") throw new Error("Aborted migration cannot commit");
    if (state.phase !== "committed" && state.phase !== "tombstoned") {
      if (state.phase !== "imported" || !state.proof || !state.checkpoint || !state.catalogRef) {
        throw new Error("Migration cannot commit before both sides finish the private import");
      }
      const trust = await currentTrust(this.options.bootstrapStore);
      const target = this.options.targetFor(state.identity.targetDeviceId);
      const lateReadyProof = await target.ready({
        candidate: candidateIdentityFromState(state),
      });
      if (readyProofDigest(lateReadyProof) !== readyProofDigest(state.readyProof)) {
        throw new Error("Migration target readiness changed before the source commit");
      }
      validateAnchorTransferReadyProof({
        proof: lateReadyProof,
        trust,
        targetDeviceId: state.identity.targetDeviceId,
        expectedIdentity: {
          requestId: state.identity.requestId,
          candidateDigest: plannedReadyCandidateDigest(candidateIdentityFromState(state)),
        },
      });
      if (
        state.catalog?.trust.homeId !== trust.homeId ||
        state.catalog.trust.trustEpoch !== trust.trustEpoch ||
        canonicalize(state.catalog.trust.chainHead) !== canonicalize(trust.chainHead) ||
        canonicalize(state.catalog.trust.issuerKeyId) !== canonicalize(trust.issuer.issuerKeyId)
      ) {
        throw new Error("Migration trust prefix changed after the authority export was frozen");
      }
      applyTrustEvent(trust, state.trustTransition);
      const commit = createSignedPlannedAnchorTransferCommit({
        v: 1,
        mode: "planned",
        transferId: state.identity.transferId,
        sourceDeviceId: state.identity.sourceDeviceId,
        targetDeviceId: state.identity.targetDeviceId,
        freezeProofDigest: sourceFreezeProofDigest(state.proof),
        checkpointDigest: state.checkpoint.digest,
        authorityCatalogDigest: state.catalogRef.digest,
        trustTransitionDigest: trustEventDigest(state.trustTransition),
        nextAnchorEpoch: state.identity.nextAnchorEpoch,
        nextTrustEpoch: state.readyProof.trustEpoch + 1,
        targetIssuerPublicKey: state.readyProof.targetIssuerPublicKey,
        readyProofDigest: readyProofDigest(state.readyProof),
        at: this.options.now?.() ?? new Date().toISOString(),
      }, this.options.signer);
      state = await this.#journal.append(
        {
          v: 1,
          mode: "planned",
          t: "anchor-committed",
          transferId: input.transferId,
          commit,
        },
        [
          { stream: "trust", body: { t: "home-trust-event", event: state.trustTransition } },
          {
            stream: "transfer:anchor-current",
            body: {
              v: 1,
              t: "planned-anchor-source-committed",
              transferId: input.transferId,
              targetDeviceId: state.identity.targetDeviceId,
              nextAnchorEpoch: state.identity.nextAnchorEpoch,
              nextTrustEpoch: commit.nextTrustEpoch,
              commit,
            },
          },
        ],
        () => {
          const now = Date.parse(this.options.now?.() ?? new Date().toISOString());
          if (!Number.isFinite(now) || Date.parse(lateReadyProof.expiresAt) <= now) {
            throw new Error("Migration readiness reservation expired before source commit");
          }
        },
      );
      await this.options.onSourceCommitted?.(state.identity.targetDeviceId);
      await this.#installFence(state);
    } else {
      await this.options.onSourceCommitted?.(state.identity.targetDeviceId);
    }
    await this.#journal.terminalCandidate(
      candidateIdentityFromState(state),
      "committed",
    );
    await this.#sendCommitted(state);
    return state;
  }

  async abort(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly reason: "source-resumed" | "target-rejected" | "operator-cancelled";
  }): Promise<PlannedAnchorTransferState | undefined> {
    let state = await this.#journal.state(input.transferId);
    if (!state) {
      const candidate = await this.#journal.candidate(input.transferId);
      if (!candidate) throw new Error("Migration is not prepared");
      if (candidate.identity.requestId !== input.requestId) {
        throw new Error("Migration cancellation replay changes request identity");
      }
      if (candidate.terminal !== undefined && candidate.terminal !== "released") {
        throw new Error("Terminal migration candidate cannot be released");
      }
      await this.#journal.releaseUnpreparedCandidate(candidate.identity);
      await this.#deliverCandidateRelease(candidate.identity, input.reason);
      return undefined;
    }
    if (state.identity.requestId !== input.requestId) {
      throw new Error("Migration cancellation replay changes request identity");
    }
    if (state.phase === "committed" || state.phase === "tombstoned") {
      throw new Error("Committed migration can only move forward");
    }
    if (state.phase !== "aborted") {
      const abort = createSignedAnchorTransferAbort({
        v: 1,
        transferId: input.transferId,
        requestId: input.requestId,
        sourceDeviceId: state.identity.sourceDeviceId,
        targetDeviceId: state.identity.targetDeviceId,
        sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
        reason: input.reason,
        at: this.options.now?.() ?? new Date().toISOString(),
      }, this.options.signer);
      state = await this.#journal.append({
        v: 1,
        mode: "planned",
        t: "anchor-aborted",
        transferId: input.transferId,
        abort,
      });
    }
    await this.#journal.terminalCandidate(
      candidateIdentityFromState(state),
      "aborted",
      state.abort!,
    );
    this.#clearFence();
    await this.options.lifecycle.resumeAfterAbort();
    await this.#sendAbort(state);
    return state;
  }

  async #drive(
    input: PlannedAnchorTransferState,
  ): Promise<PlannedAnchorTransferState> {
    let state = input;
    if (state.phase === "prepared") {
      await this.#sendPrepared(state);
      return state;
    }
    if (state.phase === "fenced") {
      return this.freeze({
        requestId: state.identity.requestId,
        transferId: state.identity.transferId,
      });
    }
    if (state.phase === "frozen" || state.phase === "imported") {
      await this.#sendPrepared(state);
      await this.#sendFrozen(state);
      await this.#sendImported(state);
      if (state.phase === "frozen") {
        state = await this.#journal.append({
          v: 1,
          mode: "planned",
          t: "anchor-imported",
          transferId: state.identity.transferId,
          checkpointDigest: state.checkpoint!.digest,
          authorityCatalogDigest: state.catalogRef!.digest,
        });
      }
      return state;
    }
    if (state.phase === "committed" || state.phase === "tombstoned") {
      await this.#journal.terminalCandidate(
        candidateIdentityFromState(state),
        "committed",
      );
      await this.#sendCommitted(state);
      return state;
    }
    if (state.phase === "aborted") {
      await this.#journal.terminalCandidate(
        candidateIdentityFromState(state),
        "aborted",
        state.abort!,
      );
      if (!this.#fencedTransferId || this.#fencedTransferId === state.identity.transferId) {
        this.#clearFence();
        await this.options.lifecycle.resumeAfterAbort();
      }
      await this.#sendAbort(state);
    }
    return state;
  }

  async #deliverCandidateRelease(
    identity: PlannedAnchorCandidateIdentity,
    reason: "source-resumed" | "target-rejected" | "operator-cancelled",
  ): Promise<void> {
    await this.options.targetFor(identity.targetDeviceId).releaseCandidate(
      signedCandidateRelease(
        identity,
        reason === "target-rejected" ? "target-rejected" : "operator-cancelled",
        this.options.signer,
      ),
    );
    await this.#journal.markCandidateReleaseDelivered(identity);
  }

  async #sendPrepared(state: PlannedAnchorTransferState): Promise<void> {
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "prepare",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      sourceDeviceId: state.identity.sourceDeviceId,
      targetDeviceId: state.identity.targetDeviceId,
      sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
      nextAnchorEpoch: state.identity.nextAnchorEpoch,
      readyProof: state.readyProof,
      trustTransition: requireMigrationTransition(state.trustTransition),
    }, this.options.signer);
    if (command.op !== "prepare") {
      throw new TypeError("Migration prepare command changed operation");
    }
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      result.state === "aborted"
    ) {
      throw new Error("Migration target did not durably retain its prepared decision");
    }
  }

  async #sendFrozen(state: PlannedAnchorTransferState): Promise<void> {
    if (!state.checkpoint || !state.catalogRef || !state.proof || !state.recoveryCheckpointDigest) {
      throw new Error("Migration frozen replay is missing its durable artifacts");
    }
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "freeze",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      recoveryCheckpointDigest: state.recoveryCheckpointDigest,
      checkpoint: state.checkpoint,
      catalog: state.catalogRef,
      proof: state.proof,
    }, this.options.signer);
    if (command.op !== "freeze") throw new TypeError("Migration freeze command changed operation");
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      !["frozen", "imported", "committed", "tombstoned"].includes(result.state)
    ) {
      throw new Error("Migration target did not durably freeze its private import");
    }
  }

  async #sendImported(state: PlannedAnchorTransferState): Promise<void> {
    if (!state.checkpoint || !state.catalogRef) {
      throw new Error("Migration import replay is missing its durable artifacts");
    }
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "import",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      checkpoint: state.checkpoint,
      catalog: state.catalogRef,
    }, this.options.signer);
    if (command.op !== "import") throw new TypeError("Migration import command changed operation");
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      !["imported", "committed", "tombstoned"].includes(result.state)
    ) {
      throw new Error("Migration target did not durably import the authority base");
    }
  }

  async #sendCommitted(state: PlannedAnchorTransferState): Promise<void> {
    if (!state.commit) throw new Error("Migration has no signed commit to install");
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "commit",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      commit: state.commit,
    }, this.options.signer);
    if (command.op !== "commit") throw new TypeError("Migration commit command changed operation");
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      (result.state !== "committed" && result.state !== "tombstoned") ||
      canonicalize(result.commit) !== canonicalize(state.commit)
    ) {
      throw new Error("Migration target did not install the signed commit");
    }
    const current = await currentTrust(this.options.bootstrapStore);
    const projection = current.trustEpoch === result.trustRecord.trustEpoch &&
        canonicalize(current.chainHead) === canonicalize(result.trustRecord.chainHead)
      ? current
      : applyTrustEvent(
          current,
          requireMigrationTransition(state.trustTransition),
        );
    verifyHomeTrustRecord(result.trustRecord, projection);
    if (
      result.trustRecord.issuer.deviceId !== state.identity.targetDeviceId ||
      result.trustRecord.issuer.issuerKeyId !== state.readyProof.targetIssuerKeyId ||
      result.trustRecord.issuer.issuerPublicKey !== state.readyProof.targetIssuerPublicKey
    ) {
      throw new Error("Migration target returned another current duty identity");
    }
    await this.options.bootstrapStore.reconcileTrustEvent({
      event: requireMigrationTransition(state.trustTransition),
      record: result.trustRecord,
    });
    await this.options.onCommitted?.(result.trustRecord);
  }

  async #sendAbort(state: PlannedAnchorTransferState): Promise<void> {
    if (!state.abort) throw new Error("Migration has no signed cancellation to replay");
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "abort",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      abort: state.abort,
    }, this.options.signer);
    if (command.op !== "abort") throw new TypeError("Migration abort command changed operation");
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      result.state !== "aborted" ||
      canonicalize(result.abort) !== canonicalize(state.abort)
    ) {
      throw new Error("Migration target did not durably cancel the transfer");
    }
  }

  async applyArtifactCommand(commandInput: AnchorTransferCommand): Promise<AnchorTransferResult> {
    const command = validateAnchorTransferCommand(commandInput, this.options.verifier);
    if (command.op !== "probe" && command.op !== "read-range") {
      throw new TypeError("Migration source accepts only artifact read commands");
    }
    const state = await this.#journal.state(command.transferId);
    if (!state || (state.phase !== "frozen" && state.phase !== "imported")) {
      throw new Error("Migration source artifacts are not frozen");
    }
    if (command.signature.keyId !== state.identity.targetDeviceId) {
      throw new TypeError("Migration artifact command is not signed by its prepared target");
    }
    const manifest = parseAuthorityExport(await this.options.artifacts.get(state.checkpoint!));
    const allowed = [
      state.checkpoint!,
      state.catalogRef!,
      ...manifest.pages.map((page) => page.ref),
      ...(state.catalog?.retainedArtifacts ?? []),
    ].some((ref) => ref.digest === command.ref.digest && ref.bytes === command.ref.bytes);
    if (!allowed) throw new TypeError("Migration artifact is outside the frozen catalog");
    if (command.op === "probe") return resultFor(command, state);
    const bytes = await runStorageMaintenanceStep(
      this.options.storageMaintenance,
      storageMaintenanceRequest(
        "authority-checkpoint",
        this.options.deviceId,
        {
          transferId: command.transferId,
          ref: command.ref,
          offset: command.offset,
          phase: "source-read",
        },
        { obligation: "pre-commit" },
      ),
      () => this.options.artifacts.readRange(
        command.ref,
        command.offset,
        command.length,
      ),
    );
    return {
      v: 1,
      status: "range",
      requestId: command.requestId,
      transferId: command.transferId,
      ref: command.ref,
      offset: command.offset,
      data: Buffer.from(bytes).toString("base64"),
    };
  }

  async #installFence(state: PlannedAnchorTransferState): Promise<void> {
    const transferId = state.identity.transferId;
    if (this.#fencedTransferId && this.#fencedTransferId !== transferId) {
      throw new Error("Another duty-device migration owns the authority fence");
    }
    this.#fencedTransferId = transferId;
    this.#fencedEpoch = state.identity.sourceAnchorEpoch;
    // 只取耐久状态：提交追加成功或恢复时读到已提交，才放行已提交旧源端的信任追赶与重任安装
    if (state.phase === "committed" || state.phase === "tombstoned") this.#fencedCommitted = true;
    const owners = sourceFenceOwners.get(this.options.log) ?? new Set<PlannedAnchorTransferOwner>();
    owners.add(this);
    sourceFenceOwners.set(this.options.log, owners);
    if (this.#disposeFence) return;
    if (this.#installingFence) return this.#installingFence;
    const installation = this.options.log.installAppendAdmissionGuard((entries) => {
      const belongsToFence = (entry: LogicalRecord<unknown>) =>
        entry.stream === ANCHOR_TRANSFER_STREAM &&
        typeof entry.body === "object" &&
        entry.body !== null &&
        "transferId" in entry.body &&
        entry.body.transferId === this.#fencedTransferId;
      const belongsToCandidate = (entry: LogicalRecord<unknown>) =>
        entry.stream === ANCHOR_CANDIDATE_STREAM &&
        isRecord(entry.body) &&
        isRecord(entry.body.identity) &&
        entry.body.identity.transferId === this.#fencedTransferId;
      const transferEntries = entries.filter(belongsToFence);
      const commitsTransfer = transferEntries.some((entry) =>
        "t" in (entry.body as object) &&
        (entry.body as { t?: string }).t === "anchor-committed",
      );
      const fencesTransfer = transferEntries.some((entry) =>
        "t" in (entry.body as object) &&
        (entry.body as { t?: string }).t === "anchor-fenced",
      );
      // 已提交的旧源端不再做权威决定，但仍追随信任链（只含 trust 流的写入，追加时由信任投影逐条验签），
      // 也可以作为新一次迁居的目标被重新安装（安装记录的 issuer 是本机）
      const retenure = (entry: LogicalRecord<unknown>) =>
        entry.stream === "transfer:anchor-current" &&
        isRecord(entry.body) &&
        (entry.body.t === "planned-anchor-installed" || entry.body.t === "disaster-anchor-installed") &&
        entry.body.transferId !== this.#fencedTransferId &&
        isRecord(entry.body.trustRecord) &&
        isRecord(entry.body.trustRecord.issuer) &&
        entry.body.trustRecord.issuer.deviceId === this.options.deviceId;
      const permitted = entries.every((entry) =>
        belongsToFence(entry) ||
        belongsToCandidate(entry) ||
        (fencesTransfer &&
          entry.stream === SOURCE_CLOSURE_STREAM &&
          isRecord(entry.body) &&
          entry.body.transferId === this.#fencedTransferId) ||
        (commitsTransfer && (entry.stream === "trust" || entry.stream === "transfer:anchor-current")) ||
        (this.#fencedCommitted && (entry.stream === "trust" || retenure(entry))),
      );
      if (!permitted) {
        throw new Error("Duty-device migration has frozen authority writes");
      }
    }).then((dispose) => {
      if (this.#fencedTransferId === transferId) {
        this.#disposeFence = dispose;
      } else {
        dispose();
      }
    });
    this.#installingFence = installation;
    try {
      await installation;
    } finally {
      if (this.#installingFence === installation) this.#installingFence = undefined;
    }
  }

  #clearFence(): void {
    this.#disposeFence?.();
    this.#disposeFence = undefined;
    this.#fencedTransferId = undefined;
    this.#fencedEpoch = undefined;
    this.#fencedCommitted = false;
    sourceFenceOwners.get(this.options.log)?.delete(this);
  }

  /**
   * 本机作为新一次迁居的目标安装成功后调用：释放本机已被新任期取代的旧源端 fence。
   * fence 按日志登记，交出值班后 owner 对象被丢弃也能找到；只释放已提交、任期更早的那一个。
   */
  static releaseSupersededFence(log: object, input: { readonly deviceId: string; readonly installedAnchorEpoch: number }): void {
    for (const owner of [...(sourceFenceOwners.get(log) ?? [])]) {
      if (
        owner.options.deviceId === input.deviceId &&
        owner.#fencedCommitted &&
        owner.#fencedEpoch !== undefined &&
        owner.#fencedEpoch < input.installedAnchorEpoch
      ) {
        owner.#clearFence();
      }
    }
  }
}

type PlannedCommit = Extract<AnchorTransferCommit, { mode: "planned" }>;

export interface PlannedAnchorInstallation {
  readonly v: 1;
  readonly t: "planned-anchor-installed";
  readonly transferId: string;
  readonly commit: PlannedCommit;
  readonly transition: MigrationTransition;
  readonly trustRecord: HomeTrustRecord;
  readonly checkpoint: ArtifactRef;
  readonly catalog: ArtifactRef;
  readonly sourceHead: DurableLogCheckpoint;
  readonly baseDigest: string;
}

function plannedAnchorInstallation(input: {
  readonly commit: PlannedCommit;
  readonly transition: MigrationTransition;
  readonly trustRecord: HomeTrustRecord;
  readonly checkpoint: ArtifactRef;
  readonly catalog: ArtifactRef;
  readonly sourceHead: DurableLogCheckpoint;
}): PlannedAnchorInstallation {
  return {
    v: 1,
    t: "planned-anchor-installed",
    transferId: input.commit.transferId,
    commit: input.commit,
    transition: input.transition,
    trustRecord: input.trustRecord,
    checkpoint: input.checkpoint,
    catalog: input.catalog,
    sourceHead: input.sourceHead,
    baseDigest: protocolDigest("PlannedAnchorAuthorityBase", 1, {
      checkpoint: input.checkpoint,
      sourceHead: input.sourceHead,
    }),
  };
}

async function loadInstalledAnchorTrustRecord(
  log: PlannedAnchorAuthorityReadPort,
  transferId: string,
): Promise<HomeTrustRecord | undefined> {
  // 按 transferId 精确读安装记录，不倒查整条 anchor-current 流
  const installation = (await readAnchorInstallationState(log, transferId)).installation;
  return installation && isPlannedInstallation(installation.body) && installation.body.transferId === transferId
    ? installation.body.trustRecord
    : undefined;
}

export function isPlannedInstallation(value: unknown): value is PlannedAnchorInstallation {
  return typeof value === "object" && value !== null &&
    (value as { v?: unknown }).v === 1 &&
    (value as { t?: unknown }).t === "planned-anchor-installed" &&
    typeof (value as { transferId?: unknown }).transferId === "string";
}

/** 已收尾的安装只带当前安装与代际；未收尾时才带私有日志状态与待办义务。 */
export type PlannedAnchorPostInstallDescriptor =
  | {
      readonly installation: PlannedAnchorInstallation;
      readonly installedGeneration: InstalledAuthorityGeneration;
      readonly requiresPostInstallCompletion: false;
    }
  | {
      readonly installation: PlannedAnchorInstallation;
      readonly installedGeneration: InstalledAuthorityGeneration;
      readonly state: PlannedAnchorTransferState;
      readonly pendingObligations: AuthorityCatalog["pendingObligations"];
      readonly requiresPostInstallCompletion: true;
    };

/** 计划迁居安装收尾的完成标记：在清理 staging 之前写入，启动据此判断已收尾，不靠 staging 是否存在。 */
interface PlannedPostInstallCompletion {
  readonly v: 1;
  readonly t: "planned-post-install-completed";
  readonly transferId: string;
  readonly generationDigest: string;
}

function plannedInstalledGenerationDigest(generation: InstalledAuthorityGeneration): string {
  return protocolDigest("PlannedInstalledAuthorityGeneration", 1, generation);
}

function plannedPostInstallCompletion(generation: InstalledAuthorityGeneration): PlannedPostInstallCompletion {
  return Object.freeze({
    v: 1,
    t: "planned-post-install-completed",
    transferId: generation.transferId,
    generationDigest: plannedInstalledGenerationDigest(generation),
  });
}

async function recordPlannedPostInstallCompletion(
  log: AnchorInstallationIndexPort,
  generation: InstalledAuthorityGeneration,
): Promise<void> {
  await recordAnchorInstallationCompletion(log, {
    stream: PLANNED_POST_INSTALL_STREAM,
    transferId: generation.transferId,
    value: plannedPostInstallCompletion(generation),
    conflictMessage: "Planned migration post-install completion conflicts with replay",
  });
}

/**
 * Immutable runtime identity of the authority prefix installed by one planned
 * transfer.  Post-install cleanup is deliberately absent: this projection is
 * reconstructed from the durable installation on every bootstrap.
 */
export interface InstalledAuthorityGeneration {
  readonly transferId: string;
  readonly commitDigest: string;
  readonly baseDigest: string;
  readonly sourceHead: DurableLogCheckpoint;
  readonly targetLogId: string;
  readonly installLsn: number;
  readonly anchorEpoch: number;
  readonly trustEpoch: number;
  readonly trustChainHead: HomeTrustRecord["chainHead"];
}

/**
 * Completes the installed target's transfer-key and private-journal progress
 * before current-role composition attempts to load the active issuer key.
 */
export async function completePlannedAnchorInstallationBeforeBootstrap(input: {
  readonly deviceId: string;
  readonly secretStore: SecretStorePort;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly staging: PlannedAnchorTransferStagingArea;
}): Promise<PlannedAnchorPostInstallDescriptor | undefined> {
  const authorityLog = input.bootstrapStore.authorityLog();
  const installed = await loadCurrentPlannedAnchorInstallation(authorityLog);
  if (!installed) return undefined;
  const { installation, installLsn } = installed;
  if (installation.trustRecord.issuer.deviceId !== input.deviceId) {
    return undefined;
  }
  if (
    installation.baseDigest !== protocolDigest("PlannedAnchorAuthorityBase", 1, {
      checkpoint: installation.checkpoint,
      sourceHead: installation.sourceHead,
    })
  ) {
    throw new Error("Installed migration authority base digest is invalid");
  }
  const installedGeneration: InstalledAuthorityGeneration = Object.freeze({
    transferId: installation.transferId,
    commitDigest: protocolDigest("PlannedAnchorInstalledCommit", 1, installation.commit),
    baseDigest: installation.baseDigest,
    sourceHead: Object.freeze({ ...installation.sourceHead }),
    targetLogId: (await authorityLog.originCheckpoint()).logId,
    installLsn,
    anchorEpoch: installation.commit.nextAnchorEpoch,
    trustEpoch: installation.trustRecord.trustEpoch,
    trustChainHead: Object.freeze({ ...installation.trustRecord.chainHead }),
  });
  // 已收尾：完成标记绑定完整代际，普通启动只需当前安装与代际。不打开私有 staging、不读 catalog；
  // 安装后信任照常演进（配对、移除），不再与安装时的信任记录比对
  const completion = (await readAnchorInstallationState(authorityLog, installation.transferId)).plannedCompletion;
  if (completion) {
    if (completion.conflict || canonicalize(completion.value) !== canonicalize(plannedPostInstallCompletion(installedGeneration))) {
      throw new Error("Planned migration post-install completion belongs to another generation");
    }
    return Object.freeze({ installation, installedGeneration, requiresPostInstallCompletion: false as const });
  }
  const currentTrust = await input.bootstrapStore.loadTrustRecord();
  if (!currentTrust || canonicalize(currentTrust) !== canonicalize(installation.trustRecord)) {
    throw new Error("Installed migration trust does not match the current authority record");
  }
  const staging = input.staging.openTransfer({
    transferId: installation.transferId,
    artifacts: input.bootstrapStore.artifactStore(),
    verifier: input.verifier,
  });
  try {
    let state = await staging.journal.state(installation.transferId);
    const activeKey = await loadActiveAnchorIssuerKey(
      input.secretStore,
      installation.trustRecord.issuer.issuerKeyId,
    );
    const activeKeyMatches = activeKey?.publicKey ===
      installation.trustRecord.issuer.issuerPublicKey;
    if (!state) {
      if (!activeKeyMatches || await staging.exists()) {
        throw new Error("Installed migration has no exact private-journal replay state");
      }
      throw new Error("Installed migration journal was removed before its durable terminal state");
    }
    if (
      state.identity.transferId !== installation.transferId ||
      state.identity.targetDeviceId !== input.deviceId ||
      canonicalize(state.checkpoint) !== canonicalize(installation.checkpoint) ||
      canonicalize(state.catalogRef) !== canonicalize(installation.catalog) ||
      (state.commit !== undefined &&
        canonicalize(state.commit) !== canonicalize(installation.commit))
    ) {
      throw new Error("Installed migration does not match its private transfer journal");
    }
    if (state.phase === "imported") {
      const transferKey = await loadAnchorIssuerKey(
        input.secretStore,
        installation.transferId,
      );
      if (
        !transferKey ||
        transferKey.deviceId !== installation.trustRecord.issuer.issuerKeyId ||
        transferKey.publicKey !== installation.trustRecord.issuer.issuerPublicKey ||
        transferKey.publicKey !== installation.commit.targetIssuerPublicKey
      ) {
        throw new Error("Installed migration is missing its exact transfer issuer key");
      }
      await activateAnchorIssuerKey(
        input.secretStore,
        installation.transferId,
        installation.trustRecord.issuer.issuerKeyId,
      );
      // 迁居暂存的家级路由材料随安装激活（回到原设备时与已有材料一致）
      const staged = await loadStagedHomeRouteMaterial(input.secretStore, installation.transferId);
      if (staged) await installHomeRouteMaterial(input.secretStore, staged, installation.transferId);
      state = await staging.journal.append({
        v: 1,
        mode: "planned",
        t: "anchor-committed",
        transferId: installation.transferId,
        commit: installation.commit,
      });
    } else if (state.phase !== "committed" && state.phase !== "tombstoned") {
      throw new Error(`Installed migration private journal is not committable from ${state.phase}`);
    }
    const exactActiveKey = await loadActiveAnchorIssuerKey(
      input.secretStore,
      installation.trustRecord.issuer.issuerKeyId,
    );
    if (
      !exactActiveKey ||
      exactActiveKey.publicKey !== installation.trustRecord.issuer.issuerPublicKey
    ) {
      throw new Error("Installed migration could not activate its exact issuer key");
    }
    input.bootstrapStore.bindIssuerKey(exactActiveKey);
    const catalogBytes = await input.bootstrapStore.artifactStore().get(installation.catalog);
    const catalog = parseAuthorityCatalog(catalogBytes);
    if (
      catalog.transferId !== installation.transferId ||
      canonicalize(catalog.source) !== canonicalize(installation.sourceHead)
    ) {
      throw new Error("Installed migration catalog does not match its authority base");
    }
    // 没有完成标记就由运行时续做收尾（幂等），不以 staging 是否存在判完成，意外缺失的资料不当成功
    return Object.freeze({
      installation,
      installedGeneration,
      state,
      pendingObligations: catalog.pendingObligations,
      requiresPostInstallCompletion: true as const,
    });
  } finally {
    await staging.close();
  }
}

export async function finishPlannedAnchorPostInstall(input: {
  readonly transferId: string;
  readonly readiness: PlannedAnchorReadinessPort;
  readonly staging: PlannedAnchorTransferStagingArea;
  readonly authorityLog: AnchorInstallationIndexPort;
  readonly installedGeneration: InstalledAuthorityGeneration;
}): Promise<void> {
  assertTransferStorageId(input.transferId);
  if (input.installedGeneration.transferId !== input.transferId) {
    throw new TypeError("Planned migration post-install generation belongs to another transfer");
  }
  // 完成标记先于清理 staging 落盘：此后启动按标记判已收尾；清理中途崩溃时标记已在，重做清理即可
  await recordPlannedPostInstallCompletion(input.authorityLog, input.installedGeneration);
  await input.staging.cleanupPostInstall(input.transferId);
  await input.readiness.release(input.transferId);
}

async function loadCurrentPlannedAnchorInstallation(
  log: PlannedAnchorAuthorityReadPort,
): Promise<{
  readonly installation: PlannedAnchorInstallation;
  readonly installLsn: number;
} | undefined> {
  // 当前安装指针精确读：真正末条是计划迁居安装记录，且同一 transferId 的安装记录只此一条
  const state = await readAnchorInstallationState(log);
  const latest = state.current;
  if (!latest || !isPlannedInstallation(latest.body)) return undefined;
  if (
    !state.installation ||
    state.installation.duplicates !== 0 ||
    state.installation.lsn !== latest.lsn ||
    state.installation.entry !== latest.entry
  ) {
    throw new Error("Current planned migration installation is ambiguous");
  }
  return {
    installation: latest.body,
    installLsn: latest.lsn,
  };
}

function trustEventDigest(event: HomeTrustEvent): string {
  const { signature: _, ...unsigned } = event;
  return protocolDigest("HomeTrustEvent", 1, unsigned);
}

function requireMigrationTransition(event: HomeTrustEvent): MigrationTransition {
  if (
    event.body.t !== "issuer-transition" ||
    event.body.reason !== "migration" ||
    event.body.signedBy !== "issuer"
  ) {
    throw new TypeError("Planned migration requires its prepared issuer transition");
  }
  return event as MigrationTransition;
}

function uniqueRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const existing = unique.get(ref.digest);
    if (existing && existing.bytes !== ref.bytes) {
      throw new TypeError("Artifact digest is associated with conflicting byte counts");
    }
    unique.set(ref.digest, ref);
  }
  return [...unique.values()].sort(compareRefs);
}

function canonicalExport(value: PlannedAuthorityExport): string {
  return canonicalize(value);
}

function parseAuthorityExport(bytes: Uint8Array): PlannedAuthorityExport {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as PlannedAuthorityExport;
  if (
    canonicalExport(value) !== text ||
    value.v !== 2 ||
    !Array.isArray(value.pages) ||
    value.pages.some((page, index) =>
      page.seq !== index ||
      !Number.isSafeInteger(page.firstLsn) ||
      !Number.isSafeInteger(page.lastLsn) ||
      !Number.isSafeInteger(page.recordCount) ||
      page.recordCount <= 0 ||
      page.firstLsn <= 0 ||
      page.lastLsn < page.firstLsn ||
      typeof page.ref?.digest !== "string" ||
      !Number.isSafeInteger(page.ref?.bytes) ||
      page.ref.bytes <= 0)
  ) {
    throw new TypeError("Planned authority export is not canonical");
  }
  return value;
}

function validateAuthorityExportPage(
  bytes: Uint8Array,
  descriptor: PlannedAuthorityExportPage,
): PlannedAuthorityExportPageBody {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as PlannedAuthorityExportPageBody;
  if (
    canonicalize(value) !== text ||
    value.v !== 1 ||
    value.seq !== descriptor.seq ||
    !Array.isArray(value.commits) ||
    value.commits.length !== descriptor.recordCount ||
    value.commits[0]?.lsn !== descriptor.firstLsn ||
    value.commits.at(-1)?.lsn !== descriptor.lastLsn
  ) {
    throw new TypeError("Planned authority export page does not match its descriptor");
  }
  for (let index = 0; index < value.commits.length; index += 1) {
    const commit = value.commits[index]!;
    if (commit.lsn !== descriptor.firstLsn + index) {
      throw new TypeError("Planned authority export page is not contiguous");
    }
  }
  return value;
}

async function* importedAuthorityEnvelopes(
  artifacts: PlannedAnchorStagingArtifacts,
  exported: PlannedAuthorityExport,
): AsyncGenerator<CommitEnvelope<unknown>> {
  let expectedLsn = 1;
  for (const descriptor of exported.pages) {
    const page = validateAuthorityExportPage(
      await artifacts.get(descriptor.ref),
      descriptor,
    );
    for (const commit of page.commits) {
      if (commit.lsn !== expectedLsn) {
        throw new TypeError("Planned authority export has a non-contiguous source prefix");
      }
      expectedLsn += 1;
      yield commit;
    }
  }
  if (expectedLsn - 1 !== exported.checkpoint.lsn) {
    throw new TypeError("Planned authority export does not reach its source checkpoint");
  }
}

function parseAuthorityCatalog(bytes: Uint8Array): AuthorityCatalog {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  const prepared = prepareAuthorityCatalog(value);
  if (Buffer.from(prepared.bytes).toString("utf8") !== text) {
    throw new TypeError("Authority catalog is not canonical");
  }
  return prepared.catalog;
}

async function capturePlannedAuthority(input: {
  readonly log: PlannedAnchorSourceAuthorityPort;
  readonly artifacts: ArtifactStore;
  readonly retention: ArtifactCheckpointRetentionPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly deviceId: string;
  readonly transferId: string;
  readonly checkpoint: DurableLogCheckpoint;
}): Promise<PlannedAuthorityCapture> {
  const retentionSnapshot = await input.retention.checkpointRetentionSnapshot();
  let cursor = await input.log.originCheckpoint();
  const pages: PlannedAuthorityExportPage[] = [];
  const references = new Map<string, ArtifactRef>();
  const streams = new Map<string, CatalogStreamAccumulator>();
  const pending = new PendingObligationTracker();
  while (cursor.lsn < input.checkpoint.lsn) {
    const page = await input.log.readTail<unknown>(
      cursor,
      TRANSFER_EXPORT_PAGE_COMMITS,
      (operation) => runStorageMaintenanceStep(
        input.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          input.deviceId,
          { transferId: input.transferId, page: pages.length, phase: "export-read" },
          { obligation: "pre-commit" },
        ),
        operation,
      ),
    );
    if (
      page.commits.length === 0 ||
      page.checkpoint.lsn > input.checkpoint.lsn
    ) {
      throw new Error("Migration export crossed its frozen authority checkpoint");
    }
    const body: PlannedAuthorityExportPageBody = {
      v: 1,
      seq: pages.length,
      commits: page.commits,
    };
    const bytes = Buffer.from(canonicalize(body), "utf8");
    const ref = await runStorageMaintenanceStep(
      input.storageMaintenance,
      storageMaintenanceRequest(
        "authority-checkpoint",
        input.deviceId,
        { transferId: input.transferId, page: pages.length, phase: "export-write" },
        { obligation: "pre-commit" },
      ),
      () => input.artifacts.put(bytes),
    );
    pages.push({
      seq: body.seq,
      firstLsn: page.commits[0]!.lsn,
      lastLsn: page.commits.at(-1)!.lsn,
      recordCount: page.commits.length,
      ref,
    });
    for (const commit of page.commits) {
      pending.accept(commit);
      for (const reference of collectArtifactRefs(commit.entries)) {
        const existing = references.get(reference.digest);
        if (existing && existing.bytes !== reference.bytes) {
          throw new TypeError("Frozen authority contains a conflicting artifact identity");
        }
        references.set(reference.digest, reference);
      }
      for (const entry of commit.entries) {
        const current = streams.get(entry.stream);
        streams.set(entry.stream, {
          stream: entry.stream,
          firstLsn: current?.firstLsn ?? commit.lsn,
          lastLsn: commit.lsn,
          recordCount: (current?.recordCount ?? 0) + 1,
          digest: protocolDigest("AuthorityCatalogStream", 1, {
            stream: entry.stream,
            ...(current ? { previousDigest: current.digest } : {}),
            lsn: commit.lsn,
            body: entry.body,
          }),
        });
      }
    }
    cursor = page.checkpoint;
  }
  if (
    canonicalize(cursor) !== canonicalize(input.checkpoint)
  ) {
    throw new Error("Migration export did not end at its frozen authority checkpoint");
  }
  const retained = await input.retention.retainedAtCheckpoint(
    retentionSnapshot,
    [...references.values()],
  );
  if (retained.status !== "current") {
    throw new Error("Migration retention projection changed while freezing authority");
  }
  const retainedArtifacts = uniqueRefs(retained.retained);
  for (const reference of retainedArtifacts) {
    if (!(await input.artifacts.has(reference))) {
      throw new Error(`Frozen authority references a missing artifact: ${reference.digest}`);
    }
  }
  const manifest: PlannedAuthorityExport = {
    v: 2,
    checkpoint: input.checkpoint,
    pages,
  };
  const manifestBytes = Buffer.from(canonicalExport(manifest), "utf8");
  if (manifestBytes.byteLength > TRANSFER_HEADER_BYTES) {
    throw new Error("Migration authority export exceeds its fixed header budget");
  }
  const manifestRef = await runStorageMaintenanceStep(
    input.storageMaintenance,
    storageMaintenanceRequest(
      "authority-checkpoint",
      input.deviceId,
      { transferId: input.transferId, phase: "export-manifest" },
      { obligation: "pre-commit" },
    ),
    () => input.artifacts.put(manifestBytes),
  );
  return {
    manifest,
    manifestRef,
    retainedArtifacts,
    streams: [...streams.values()],
    pendingObligations: pending.snapshot(),
  };
}

async function projectPendingObligations(
  log: PlannedAnchorAuthorityReadPort,
  checkpoint: DurableLogCheckpoint,
): Promise<AuthorityCatalog["pendingObligations"]> {
  const pending = new PendingObligationTracker();
  let cursor = await log.originCheckpoint();
  while (cursor.lsn < checkpoint.lsn) {
    const page = await log.readTail<unknown>(cursor, TRANSFER_EXPORT_PAGE_COMMITS);
    if (page.commits.length === 0 || page.checkpoint.lsn > checkpoint.lsn) {
      throw new Error("Migration pending projection crossed its source checkpoint");
    }
    for (const commit of page.commits) pending.accept(commit);
    cursor = page.checkpoint;
  }
  if (canonicalize(cursor) !== canonicalize(checkpoint)) {
    throw new Error("Migration pending projection did not reach its source checkpoint");
  }
  return pending.snapshot();
}

export async function readBackPlannedAnchorPostInstallObligations(input: {
  readonly log: PlannedAnchorAuthorityReadPort;
  readonly obligations: AuthorityCatalog["pendingObligations"];
}): Promise<readonly {
  readonly kind: AuthorityCatalog["pendingObligations"][number]["kind"];
  readonly id: string;
  readonly disposition: "current-owner" | "terminal";
}[]> {
  const seen = new Set<string>();
  for (const obligation of input.obligations) {
    const key = `${obligation.kind}:${obligation.id}`;
    if (seen.has(key)) {
      throw new Error("Installed migration catalog repeats a pending obligation");
    }
    seen.add(key);
  }
  const pending = await projectPendingObligations(
    input.log,
    await input.log.checkpoint(),
  );
  const current = new Set(pending.map((item) => `${item.kind}:${item.id}`));
  return Object.freeze(input.obligations.map((obligation) => Object.freeze({
    kind: obligation.kind,
    id: obligation.id,
    disposition: current.has(`${obligation.kind}:${obligation.id}`)
      ? "current-owner" as const
      : "terminal" as const,
  })));
}

async function loadPlannedSourceClosure(
  log: PlannedAnchorAuthorityReadPort,
  artifacts: ArtifactStore,
  transferId: string,
): Promise<PlannedSourceClosure> {
  const records = await log.readStream<unknown>(SOURCE_CLOSURE_STREAM);
  const matches = records.filter(({ body }) =>
    isRecord(body) &&
    body.v === 1 &&
    body.t === "planned-anchor-source-closure-recorded" &&
    body.transferId === transferId);
  if (matches.length !== 1) {
    throw new Error("Migration source closure is missing or ambiguous");
  }
  const record = matches[0]!.body as unknown as PlannedSourceClosureRecord;
  const bytes = await artifacts.get(record.closure);
  const text = Buffer.from(bytes).toString("utf8");
  const closure = JSON.parse(text) as PlannedSourceClosure;
  const expectedTokens = Array.isArray(closure.pendingObligations)
    ? closure.pendingObligations.map((obligation) => ({
        transferId,
        kind: obligation.kind,
        id: obligation.id,
        requestId: `planned-accepted:${obligation.kind}:${obligation.id}`,
      }))
    : [];
  if (
    canonicalize(closure) !== text ||
    closure.v !== 1 ||
    closure.t !== "planned-anchor-source-closure" ||
    closure.transferId !== transferId ||
    canonicalize(Object.keys(closure).sort()) !== canonicalize([
      "acceptedTokens",
      "pendingObligations",
      "sourceHead",
      "t",
      "transferId",
      "v",
    ]) ||
    !Array.isArray(closure.acceptedTokens) ||
    !Array.isArray(closure.pendingObligations) ||
    canonicalize(closure.acceptedTokens) !== canonicalize(expectedTokens) ||
    canonicalize(closure.sourceHead) !== canonicalize(record.sourceHead) ||
    protocolDigest("PlannedAnchorSourceClosure", 1, closure) !== record.closureDigest
  ) {
    throw new TypeError("Migration source closure is invalid");
  }
  return closure;
}

export class PendingObligationTracker {
  readonly #pending = new Map<string, AuthorityCatalog["pendingObligations"][number]>();

  accept(commit: CommitEnvelope<unknown>): void {
    for (const entry of commit.entries) {
      if (!isRecord(entry.body)) continue;
      const body = entry.body;
      if (entry.stream.startsWith("assignment:")) {
        const assignmentId = entry.stream.slice("assignment:".length);
        if (body.t === "received") this.#set("assignment", assignmentId);
        if (["acked", "halted", "execution-failed", "dispatch-rejected"].includes(String(body.t))) {
          this.#delete("assignment", assignmentId);
        }
        if (body.t === "interaction-requested" && typeof body.requestId === "string") {
          this.#set("interaction", body.requestId);
        }
        if (body.t === "interaction-finished" && typeof body.requestId === "string") {
          this.#delete("interaction", body.requestId);
        }
      }
      if (
        entry.stream === "final-outbox" &&
        body.t === "final" &&
        typeof body.conversationId === "string" &&
        typeof body.runId === "string" &&
        Number.isSafeInteger(body.commitRevision)
      ) {
        const id = `${body.conversationId}:${body.runId}:${body.commitRevision}`;
        body.state === "pending" ? this.#set("final", id) : this.#delete("final", id);
      }
      if (entry.stream === "delivery" && typeof body.itemId === "string") {
        if (["sent", "failed", "delivery-resolved"].includes(String(body.t))) {
          this.#delete("delivery", body.itemId);
        } else if (["enqueued", "attempt-started", "retry-scheduled", "delivery-uncertain"].includes(String(body.t))) {
          this.#set("delivery", body.itemId);
        }
      }
      if (
        entry.stream.startsWith("intent:") &&
        body.t === "intent" &&
        isRecord(body.intent) &&
        typeof body.intent.intentId === "string"
      ) {
        body.intent.status === "pending"
          ? this.#set("intent", body.intent.intentId)
          : this.#delete("intent", body.intent.intentId);
      }
      if (body.t === "confirmation-requested" && typeof body.requestId === "string") {
        this.#set("confirmation", body.requestId);
      }
      if (body.t === "confirmation-resolved" && typeof body.requestId === "string") {
        this.#delete("confirmation", body.requestId);
      }
    }
  }

  snapshot(): AuthorityCatalog["pendingObligations"] {
    return [...this.#pending.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind, "en-US") || left.id.localeCompare(right.id, "en-US"));
  }

  #set(kind: AuthorityCatalog["pendingObligations"][number]["kind"], id: string): void {
    this.#pending.set(`${kind}:${id}`, { kind, id });
  }

  #delete(kind: AuthorityCatalog["pendingObligations"][number]["kind"], id: string): void {
    this.#pending.delete(`${kind}:${id}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildAuthorityCatalog(input: {
  readonly state: PlannedAnchorTransferState;
  readonly checkpoint: DurableLogCheckpoint;
  readonly streams: readonly CatalogStreamAccumulator[];
  readonly authorityRecords: ArtifactRef;
  readonly retainedArtifacts: readonly ArtifactRef[];
  readonly pendingObligations: AuthorityCatalog["pendingObligations"];
  readonly trust: TrustProjection;
}): AuthorityCatalog {
  return prepareAuthorityCatalog({
    v: 1,
    transferId: input.state.identity.transferId,
    sourceDeviceId: input.state.identity.sourceDeviceId,
    targetDeviceId: input.state.identity.targetDeviceId,
    sourceAnchorEpoch: input.state.identity.sourceAnchorEpoch,
    source: input.checkpoint,
    trust: {
      homeId: input.trust.homeId,
      trustEpoch: input.trust.trustEpoch,
      chainHead: input.trust.chainHead,
      issuerDeviceId: input.trust.issuer.deviceId,
      issuerKeyId: input.trust.issuer.issuerKeyId,
    },
    coverage: [
      "conversation-authority", "conversation-content", "execution-assets",
      "global-authority", "pending-obligations", "trust-and-anchor",
    ],
    streams: [...input.streams].sort((left, right) =>
      left.stream.localeCompare(right.stream, "en-US")),
    authorityRecords: input.authorityRecords,
    retainedArtifacts: input.retainedArtifacts,
    pendingObligations: input.pendingObligations,
  }).catalog;
}

function assertExportBinding(
  catalog: AuthorityCatalog,
  exported: PlannedAuthorityExport,
  proof: import("@zhixing/core/contracts").SourceFreezeProof,
  state: PlannedAnchorTransferState,
): void {
  if (
    catalog.transferId !== state.identity.transferId ||
    catalog.sourceDeviceId !== state.identity.sourceDeviceId ||
    catalog.targetDeviceId !== state.identity.targetDeviceId ||
    catalog.source.lsn !== proof.lastLsn ||
    exported.checkpoint.lsn !== proof.lastLsn ||
    exported.checkpoint.prefixDigest !== catalog.source.prefixDigest ||
    exported.checkpoint.logId !== catalog.source.logId ||
    (proof.lastLsn === 0
      ? exported.pages.length !== 0
      : exported.pages.at(-1)?.lastLsn !== proof.lastLsn)
  ) {
    throw new TypeError("Planned authority export does not bind its frozen source prefix");
  }
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
  return compareCanonicalStrings(canonicalize(left), canonicalize(right));
}

function readyReservation(
  proof: ReadyProof,
  snapshot: AnchorTransferReadySnapshot,
): ReadyReservation {
  return Object.freeze({
    v: 1,
    t: "planned-anchor-ready-reserved",
    transferId: proof.transferId,
    targetDeviceId: proof.targetDeviceId,
    proofDigest: readyProofDigest(proof),
    snapshotDigest: protocolDigest("PlannedAnchorReadySnapshot", 1, {
      configuredCapabilities: {
        providers: [...snapshot.configuredCapabilities.providers].sort(),
        mcpServers: [...snapshot.configuredCapabilities.mcpServers].sort(),
        channels: [...snapshot.configuredCapabilities.channels].sort(),
      },
      protocolRevision: snapshot.protocolRevision,
      assetRevision: snapshot.assetRevision,
      serviceRevision: snapshot.serviceRevision,
      credentialRevision: snapshot.credentialRevision,
    }),
    expiresAt: proof.expiresAt,
  });
}

function validateReadyReservation(value: unknown): ReadyReservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Migration ready reservation must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    canonicalize(Object.keys(record).sort()) !== canonicalize([
      "expiresAt",
      "proofDigest",
      "snapshotDigest",
      "t",
      "targetDeviceId",
      "transferId",
      "v",
    ]) ||
    record.v !== 1 ||
    record.t !== "planned-anchor-ready-reserved" ||
    typeof record.transferId !== "string" ||
    typeof record.targetDeviceId !== "string" ||
    typeof record.proofDigest !== "string" ||
    typeof record.snapshotDigest !== "string" ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    throw new TypeError("Migration ready reservation fields are invalid");
  }
  return record as unknown as ReadyReservation;
}

function assertTransferStorageId(transferId: string): void {
  if (!/^xfer-[0-9A-HJKMNP-TV-Z]{26}$/u.test(transferId)) {
    throw new TypeError("Migration transfer id is not safe for private storage");
  }
}

function preparedRecord(
  command: Extract<AnchorTransferCommand, { op: "prepare" }>,
): Extract<PlannedRecord, { t: "anchor-prepared" }> {
  return {
    v: 1,
    mode: "planned",
    t: "anchor-prepared",
    requestId: command.requestId,
    transferId: command.transferId,
    sourceDeviceId: command.sourceDeviceId,
    targetDeviceId: command.targetDeviceId,
    sourceAnchorEpoch: command.sourceAnchorEpoch,
    nextAnchorEpoch: command.nextAnchorEpoch,
    readyProof: command.readyProof,
    trustTransition: command.trustTransition,
  };
}

function createMigrationTransition(
  trust: TrustProjection,
  proof: ReadyProof,
  signer: DeviceKey,
): MigrationTransition {
  return createSignedTrustEvent({
    current: trust,
    signer,
    at: proof.issuedAt,
    body: {
      t: "issuer-transition",
      reason: "migration",
      signedBy: "issuer",
      nextTrustEpoch: trust.trustEpoch + 1,
      fromIssuerKeyId: trust.issuer.issuerKeyId,
      toIssuerKeyId: proof.targetIssuerKeyId,
      toIssuerPublicKey: proof.targetIssuerPublicKey,
      toDeviceId: proof.targetDeviceId,
    },
  });
}

function reduceJournal(
  states: ReadonlyMap<string, PlannedAnchorTransferState>,
  entry: LogicalRecord<PlannedRecord>,
  verifier: ProtocolSignatureVerifier,
): ReadonlyMap<string, PlannedAnchorTransferState> {
  if (entry.stream !== ANCHOR_TRANSFER_STREAM) return states;
  const next = new Map(states);
  next.set(
    entry.body.transferId,
    reducePlannedAnchorTransfer(states.get(entry.body.transferId), entry.body, verifier),
  );
  return next;
}

function reduceCandidateProjection(
  projection: PlannedAnchorCandidateProjection,
  entry: LogicalRecord<unknown>,
  verifier: ProtocolSignatureVerifier,
  includeTransferState: boolean,
): PlannedAnchorCandidateProjection {
  const targetWideClaims = reduceTargetWideAnchorCandidates(
    projection.targetWideClaims,
    entry,
  );
  const candidateTag = entry.body && typeof entry.body === "object" && !Array.isArray(entry.body)
    ? (entry.body as { readonly t?: unknown }).t
    : undefined;
  if (
    entry.stream === ANCHOR_CANDIDATE_STREAM &&
    (candidateTag === "anchor-candidate-mode-claimed" ||
      candidateTag === "anchor-candidate-mode-terminal")
  ) {
    return targetWideClaims === projection.targetWideClaims
      ? projection
      : { ...projection, targetWideClaims };
  }
  const base = targetWideClaims === projection.targetWideClaims
    ? projection
    : { ...projection, targetWideClaims };
  if (entry.stream === ANCHOR_CANDIDATE_STREAM) {
    const record = validateCandidateRecord(entry.body, verifier);
    const existing = base.claims.get(record.identity.transferId);
    if (record.t === "planned-anchor-candidate-claimed") {
      const legacyTargetWide = base.targetWideClaims.has(record.identity.transferId)
        ? base.targetWideClaims
        : reduceTargetWideAnchorCandidateRecord(
            base.targetWideClaims,
            targetWideAnchorCandidateClaim(plannedTargetWideCandidateIdentity(record.identity)),
          );
      if (existing) {
        assertCandidateIdentity(existing.identity, record.identity);
        return legacyTargetWide === base.targetWideClaims
          ? base
          : { ...base, targetWideClaims: legacyTargetWide };
      }
      const claims = new Map(base.claims);
      claims.set(record.identity.transferId, { identity: record.identity });
      return { ...base, claims, targetWideClaims: legacyTargetWide };
    }
    if (!existing) throw new Error("Migration candidate progress has no durable claim");
    assertCandidateIdentity(existing.identity, record.identity);
    if (record.t === "planned-anchor-candidate-ready") {
      if (existing.terminal !== undefined) {
        throw new Error("Terminal migration candidate cannot gain readiness");
      }
      if (
        existing.readyProof &&
        canonicalize(existing.readyProof) !== canonicalize(record.readyProof)
      ) {
        throw new Error("Migration candidate ready proof changed across replay");
      }
      const claims = new Map(base.claims);
      claims.set(record.identity.transferId, { ...existing, readyProof: record.readyProof });
      return { ...base, claims };
    }
    if (record.t === "planned-anchor-candidate-prepared") {
      if (existing.terminal !== undefined) {
        throw new Error("Terminal migration candidate cannot be prepared");
      }
      if (existing.prepared) {
        if (canonicalize(existing.prepared) !== canonicalize(record.prepared)) {
          throw new Error("Migration candidate has conflicting prepared decisions");
        }
        return base;
      }
      const claims = new Map(base.claims);
      claims.set(record.identity.transferId, { ...existing, prepared: record.prepared });
      return { ...base, claims };
    }
    if (record.t === "planned-anchor-candidate-terminal") {
      if (record.terminal === "released" && existing.prepared) {
        throw new Error("Prepared migration candidate requires a signed transfer abort");
      }
      if (existing.terminal !== undefined && existing.terminal !== record.terminal) {
        throw new Error("Migration candidate has conflicting terminal decisions");
      }
      if (
        record.terminal === "aborted" &&
        existing.abort &&
        canonicalize(existing.abort) !== canonicalize(record.abort)
      ) {
        throw new Error("Migration candidate has conflicting abort decisions");
      }
      const claims = new Map(base.claims);
      claims.set(
        record.identity.transferId,
        record.terminal === "aborted"
          ? { ...existing, terminal: record.terminal, abort: record.abort }
          : { ...existing, terminal: record.terminal },
      );
      const legacyTargetWide = existing.terminal === undefined
        ? reduceTargetWideAnchorCandidateRecord(
            base.targetWideClaims,
            targetWideAnchorCandidateTerminal(
              plannedTargetWideCandidateIdentity(record.identity),
              record.terminal,
            ),
          )
        : base.targetWideClaims;
      return { ...base, claims, targetWideClaims: legacyTargetWide };
    }
    if (record.t === "planned-anchor-candidate-cleaned") {
      if (existing.terminal !== "aborted" && existing.terminal !== "released") {
        throw new Error("Migration candidate cleanup precedes its terminal decision");
      }
      const claims = new Map(base.claims);
      claims.set(record.identity.transferId, { ...existing, cleaned: true });
      return { ...base, claims };
    }
    if (existing.terminal !== "released") {
      throw new Error("Migration candidate cleanup completion precedes release");
    }
    const claims = new Map(base.claims);
    claims.set(record.identity.transferId, { ...existing, releaseDelivered: true });
    return { ...base, claims };
  }
  if (!includeTransferState) return base;
  if (entry.stream === ANCHOR_TRANSFER_STREAM) {
    const record = entry.body as PlannedRecord;
    const transfers = reduceJournal(base.transfers, {
      stream: ANCHOR_TRANSFER_STREAM,
      body: record,
    }, verifier);
    return { ...base, transfers };
  }
  if (entry.stream === "transfer:anchor-current" && isPlannedInstallation(entry.body)) {
    const installedTransfers = new Set(base.installedTransfers);
    installedTransfers.add(entry.body.transferId);
    // 导入前缀里前任的全目标候选声明在安装后即视为已提交：它的终态写在导出之后，不在本机副本里
    const claim = base.targetWideClaims.get(entry.body.transferId);
    const targetWideClaims = claim && claim.terminal === undefined
      ? reduceTargetWideAnchorCandidateRecord(
          base.targetWideClaims,
          targetWideAnchorCandidateTerminal(claim.identity, "committed"),
        )
      : base.targetWideClaims;
    return { ...base, installedTransfers, targetWideClaims };
  }
  return base;
}

function validateCandidateRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): PlannedAnchorCandidateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Migration candidate record must be an object");
  }
  const record = value as Partial<PlannedAnchorCandidateRecord> & Record<string, unknown>;
  const common = ["identity", "t", "v"];
  const expected = record.t === "planned-anchor-candidate-ready"
    ? [...common, "readyProof"]
    : record.t === "planned-anchor-candidate-prepared"
      ? [...common, "prepared"]
    : record.t === "planned-anchor-candidate-terminal"
      ? record.terminal === "aborted"
        ? [...common, "abort", "terminal"]
        : [...common, "terminal"]
      : common;
  if (
    record.v !== 1 ||
    ![
      "planned-anchor-candidate-claimed",
      "planned-anchor-candidate-ready",
      "planned-anchor-candidate-prepared",
      "planned-anchor-candidate-terminal",
      "planned-anchor-candidate-release-delivered",
      "planned-anchor-candidate-cleaned",
    ].includes(String(record.t)) ||
    canonicalize(Object.keys(record).sort()) !== canonicalize(expected.sort())
  ) {
    throw new TypeError("Migration candidate record fields are incomplete or unknown");
  }
  validateCandidateIdentity(record.identity);
  if (
    record.t === "planned-anchor-candidate-ready" &&
    (!record.readyProof || typeof record.readyProof !== "object")
  ) {
    throw new TypeError("Migration candidate ready record has no proof");
  }
  if (record.t === "planned-anchor-candidate-prepared") {
    validateCandidatePrepared(
      record.prepared,
      record.identity as PlannedAnchorCandidateIdentity,
      verifier,
    );
  }
  if (
    record.t === "planned-anchor-candidate-terminal" &&
    !["committed", "aborted", "released"].includes(String(record.terminal))
  ) {
    throw new TypeError("Migration candidate terminal is invalid");
  }
  if (record.t === "planned-anchor-candidate-terminal" && record.terminal === "aborted") {
    validateCandidateAbort(
      record.abort,
      record.identity as PlannedAnchorCandidateIdentity,
      verifier,
    );
  }
  return record as PlannedAnchorCandidateRecord;
}

function validateCandidatePrepared(
  value: unknown,
  identity: PlannedAnchorCandidateIdentity,
  verifier: ProtocolSignatureVerifier,
): PlannedAnchorPreparedRecord {
  const prepared = value as PlannedAnchorPreparedRecord;
  const state = reducePlannedAnchorTransfer(undefined, prepared, verifier);
  assertCandidateIdentity(candidateIdentityFromState(state), identity);
  return structuredClone(prepared);
}

function validateCandidateAbort(
  value: unknown,
  identity: PlannedAnchorCandidateIdentity,
  verifier: ProtocolSignatureVerifier,
): AnchorTransferAbort {
  const abort = validateAnchorTransferAbort(value, verifier);
  if (
    abort.requestId !== identity.requestId ||
    abort.transferId !== identity.transferId ||
    abort.sourceDeviceId !== identity.sourceDeviceId ||
    abort.targetDeviceId !== identity.targetDeviceId ||
    abort.sourceAnchorEpoch !== identity.sourceAnchorEpoch ||
    abort.signature.keyId !== identity.sourceDeviceId
  ) {
    throw new TypeError("Migration candidate abort changes its durable identity");
  }
  return abort;
}

function validateCandidateIdentity(
  value: unknown,
): PlannedAnchorCandidateIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Migration candidate identity must be an object");
  }
  const identity = value as Partial<PlannedAnchorCandidateIdentity> & Record<string, unknown>;
  if (
    canonicalize(Object.keys(identity).sort()) !== canonicalize([
      "homeId",
      "requestId",
      "sourceAnchorEpoch",
      "sourceDeviceId",
      "targetDeviceId",
      "transferId",
      "trustChainHead",
      "trustEpoch",
    ]) ||
    typeof identity.homeId !== "string" || identity.homeId.length === 0 ||
    typeof identity.requestId !== "string" || identity.requestId.length === 0 ||
    typeof identity.transferId !== "string" || identity.transferId.length === 0 ||
    typeof identity.sourceDeviceId !== "string" || identity.sourceDeviceId.length === 0 ||
    typeof identity.targetDeviceId !== "string" || identity.targetDeviceId.length === 0 ||
    !Number.isSafeInteger(identity.trustEpoch) || (identity.trustEpoch as number) < 0 ||
    !Number.isSafeInteger(identity.sourceAnchorEpoch) ||
      (identity.sourceAnchorEpoch as number) < 0 ||
    !identity.trustChainHead ||
    typeof identity.trustChainHead !== "object" ||
    Array.isArray(identity.trustChainHead) ||
    canonicalize(Object.keys(identity.trustChainHead).sort()) !==
      canonicalize(["eventDigest", "seq"]) ||
    !Number.isSafeInteger(identity.trustChainHead.seq) ||
      (identity.trustChainHead.seq as number) < 0 ||
    typeof identity.trustChainHead.eventDigest !== "string"
  ) {
    throw new TypeError("Migration candidate identity is invalid");
  }
  return Object.freeze({
    homeId: identity.homeId,
    requestId: identity.requestId,
    transferId: identity.transferId,
    sourceDeviceId: identity.sourceDeviceId,
    targetDeviceId: identity.targetDeviceId,
    trustEpoch: identity.trustEpoch as number,
    trustChainHead: Object.freeze({
      seq: identity.trustChainHead.seq as number,
      eventDigest: identity.trustChainHead.eventDigest,
    }),
    sourceAnchorEpoch: identity.sourceAnchorEpoch as number,
  });
}

function assertCandidateIdentity(
  actual: PlannedAnchorCandidateIdentity,
  expected: PlannedAnchorCandidateIdentity,
): void {
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new Error("Migration candidate replay conflicts with its durable identity");
  }
}

function plannedTargetWideCandidateIdentity(
  identity: PlannedAnchorCandidateIdentity,
) {
  return Object.freeze({
    mode: "planned" as const,
    homeId: identity.homeId,
    transferId: identity.transferId,
    identityDigest: protocolDigest("PlannedAnchorCandidateIdentity", 1, identity),
  });
}

function plannedReadyCandidateDigest(identity: PlannedAnchorCandidateIdentity): string {
  return protocolDigest("PlannedAnchorCandidateIdentity", 1, identity);
}

function assertCandidateTrust(
  identity: PlannedAnchorCandidateIdentity,
  trust: HomeTrustRecord | TrustProjection,
): void {
  if (
    identity.homeId !== trust.homeId ||
    identity.trustEpoch !== trust.trustEpoch ||
    canonicalize(identity.trustChainHead) !== canonicalize(trust.chainHead) ||
    identity.sourceDeviceId !== trust.issuer.deviceId
  ) {
    throw new Error("Migration candidate no longer binds the current trust generation");
  }
}

function assertCandidateReadyProofIdentity(
  candidate: PlannedAnchorCandidateState,
): asserts candidate is PlannedAnchorCandidateState & { readonly readyProof: ReadyProof } {
  const proof = candidate.readyProof;
  if (
    !proof ||
    proof.homeId !== candidate.identity.homeId ||
    proof.transferId !== candidate.identity.transferId ||
    proof.targetDeviceId !== candidate.identity.targetDeviceId ||
    proof.trustEpoch !== candidate.identity.trustEpoch ||
    canonicalize(proof.trustChainHead) !== canonicalize(candidate.identity.trustChainHead)
  ) {
    throw new TypeError("Migration candidate ready proof changes its durable identity");
  }
}

function candidateIdentityFromState(
  state: PlannedAnchorTransferState,
): PlannedAnchorCandidateIdentity {
  return validateCandidateIdentity({
    homeId: state.readyProof.homeId,
    requestId: state.identity.requestId,
    transferId: state.identity.transferId,
    sourceDeviceId: state.identity.sourceDeviceId,
    targetDeviceId: state.identity.targetDeviceId,
    trustEpoch: state.readyProof.trustEpoch,
    trustChainHead: state.readyProof.trustChainHead,
    sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
  });
}

function signedCandidateRelease(
  identity: PlannedAnchorCandidateIdentity,
  reason: PlannedAnchorCandidateRelease["reason"],
  signer: ProtocolSigner,
): PlannedAnchorCandidateRelease {
  const payload = {
    v: 1 as const,
    t: "planned-anchor-candidate-release" as const,
    identity: validateCandidateIdentity(identity),
    reason,
  };
  return Object.freeze({
    ...payload,
    signature: signer.sign("PlannedAnchorCandidateRelease", 1, payload),
  });
}

function validateCandidateRelease(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): PlannedAnchorCandidateRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Migration candidate release must be an object");
  }
  const release = value as Partial<PlannedAnchorCandidateRelease> & Record<string, unknown>;
  if (
    canonicalize(Object.keys(release).sort()) !==
      canonicalize(["identity", "reason", "signature", "t", "v"]) ||
    release.v !== 1 ||
    release.t !== "planned-anchor-candidate-release" ||
    (release.reason !== "operator-cancelled" && release.reason !== "target-rejected") ||
    !release.signature || typeof release.signature !== "object"
  ) {
    throw new TypeError("Migration candidate release fields are invalid");
  }
  const identity = validateCandidateIdentity(release.identity);
  const payload = {
    v: 1 as const,
    t: "planned-anchor-candidate-release" as const,
    identity,
    reason: release.reason,
  };
  verifier.verify(
    "PlannedAnchorCandidateRelease",
    1,
    payload,
    release.signature as PlannedAnchorCandidateRelease["signature"],
  );
  if (release.signature.keyId !== identity.sourceDeviceId) {
    throw new TypeError("Migration candidate release is not signed by its source");
  }
  return Object.freeze({ ...payload, signature: release.signature }) as PlannedAnchorCandidateRelease;
}

function resultFor(
  command: AnchorTransferCommand,
  state: PlannedAnchorTransferState | undefined,
  trustRecord?: HomeTrustRecord,
): AnchorTransferResult {
  if (!state) {
    return {
      v: 1,
      status: "rejected",
      requestId: command.requestId,
      transferId: command.transferId,
      error: { code: "not-found", retryable: false },
    };
  }
  if (state.phase === "prepared" || state.phase === "fenced") {
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "prepared" };
  }
  if (state.phase === "frozen" || state.phase === "imported") {
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: state.phase, ref: state.checkpoint! };
  }
  if (state.phase === "committed" || state.phase === "tombstoned") {
    if (!trustRecord) {
      throw new Error("Committed migration result has no signed trust projection");
    }
    return {
      v: 1,
      status: "ok",
      requestId: command.requestId,
      transferId: command.transferId,
      state: state.phase,
      commit: state.commit!,
      trustRecord,
    };
  }
  return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "aborted", abort: state.abort! };
}

function candidateAbortResult(
  command: AnchorTransferCommand,
  abort: AnchorTransferAbort,
): AnchorTransferResult {
  return {
    v: 1,
    status: "ok",
    requestId: command.requestId,
    transferId: command.transferId,
    state: "aborted",
    abort,
  };
}

async function currentTrust(store: FileMeshBootstrapStore): Promise<TrustProjection> {
  const trust = await store.loadTrustProjection();
  if (!trust) throw new Error("Home trust is not initialized");
  return trust;
}
