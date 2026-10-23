import { AUTHORITY_RECOVERY_BUDGET, mergeNormalizedProjectionMutations, normalizeProjectionMutations, normalizeProjectionMutationsInSlices, type ArtifactStore, type AuthorityCommitLog, type DurableLogCheckpoint,
  type DurableProjectionMutation, type DurableProjectionReadContext, type DurableProjectionReducer, type DurableProjectionSource,
  type NormalizedProjectionMutations, type PersistentSortedMap } from '@zhixing/core/authority';
import type { CommitEnvelope, JsonValue } from '@zhixing/core/contracts';
import { verifyProtocolStep, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { currentMaintenanceAbortSignal, currentMaintenanceUrgency, maintenanceRetryDelayMs, runDetachedDeviceCapacity, runDetachedMaintenanceContext,
  runWithMaintenanceUrgency, StorageMaintenanceCancelledError, waitForMaintenanceRetry, type StorageMaintenanceUrgency } from '@zhixing/core/resources';
import { DECISION_MIGRATION_START, DECISION_MIGRATION_COMPLETE, DECISION_INDEXED_THROUGH, DECISION_CONVERSATION_PREFIX, TRANSFER_PARTITION,
  decisionPartitionKey, decisionConversationKey, decisionMigrationRequired, decisionMigrationActive, decisionPartitionReady,
  installDecisionMigrator } from './conversation-decision-partition-keys.js';
import { CONVERSATION_RUN_STATE_PROJECTION_ID, conversationResourceWitnessKey, conversationStateBase, conversationRunStateReducer,
  scanConversationState } from './conversation-run-state-index.js';
import { ADVANCEMENT_RECOVERY_PROJECTION_ID, advancementPendingPrefix, advancementRecoveryRegistered } from './advancement-recovery-index.js';
import { CONVERSATION_TRANSFER_STATE_PREFIX, conversationBaseKey, conversationBaseUnavailableKey, conversationTransferStateKey } from './conversation-base-registry.js';
import { ConversationDecisionMigration, DecisionRows, logDecisionSource, type DecisionSourceReader, type DecisionTransferBinding } from './conversation-decision-migration.js';
import { conversationStateKeyHash as hash } from './conversation-state-key.js';

/**
 * 带历史的旧资料升级时，会话决定状态（canonical 运行状态与推进待办目录）按会话分区迁移：
 * 投影从源头部以空状态就绪，启动与显示历史不做任何历史工作；某个会话第一次被读写时，
 * 先迁移该会话（可信旧基点 → 转换 → 尾部完整校验），后台按优先级迁移其余会话，全部完成后写完成标记。
 * 收编事实只能从日志正文认出：升级后一次性全库只读扫描建立会话清单与收编位置（Host 就绪后即在后台开始），
 * 会话迁移以它为前提。很小的源仍从起点重建：成本有固定上限，且从不进入迁移中。
 * 后台迁移在前台活动（用户请求在途、正向接入面推送）期间暂停；前台正在等待的分区（以及它们共同依赖的
 * 会话清单扫描）照常推进，不让路。
 */

/** 不超过这个位置的源从起点重建（成本有固定上限），更大的源按会话分区迁移。 */
export const DECISION_MIGRATION_MIN_SOURCE_LSN = 512;
let minSourceLsn = DECISION_MIGRATION_MIN_SOURCE_LSN;
/** 测试用：调整按分区迁移的源下限（0 表示任何非空源都按分区迁移）；返回恢复原值的函数。 */
export function setDecisionMigrationMinSourceLsnForTesting(value: number): () => void {
  const prior = minSourceLsn;
  minSourceLsn = value;
  return () => { minSourceLsn = prior; };
}
export function decisionStartAtSource(head: DurableLogCheckpoint): boolean {
  return head.lsn > minSourceLsn;
}
/** 从源头部起步时写下迁移起点；此后直到完成标记出现，投影处于迁移中。 */
export function decisionSeedAtSource(head: DurableLogCheckpoint): readonly DurableProjectionMutation[] {
  return [{ kind: 'put', key: DECISION_MIGRATION_START, value: { lsn: head.lsn } }];
}

/** 本日志已登记的决定状态投影；推进待办目录可能未在本进程登记（例如只构造执行侧日志时）。 */
function decisionProjections(log: AuthorityCommitLog): string[] {
  return [CONVERSATION_RUN_STATE_PROJECTION_ID, ...(advancementRecoveryRegistered(log) ? [ADVANCEMENT_RECOVERY_PROJECTION_ID] : [])];
}
const TRANSFER_INDEX_KEY = '~migration/transfer-bindings';
/** 后台迁移的会话行数不超过它时推迟落盘（覆盖层上限为 512 条）。 */
const DEFERRED_FLUSH_ROWS = 128;
/**
 * 发布时在日志锁内补齐的尾部不超过一页恢复预算（帧数与已验证源位置之间的物理字节，与普通页相同）；只剩一帧时
 * 不论大小都放行（合法大帧由日志格式限定）。锁外先追平到预算之内；锁内发现尾部又超出（例如后台让路期间其他写入
 * 继续追加）则放弃本次发布、回到锁外继续追平，持锁工作量不随等待时长或帧的大小增长。
 */
function lockedTailWithinBudget(from: DurableLogCheckpoint, head: DurableLogCheckpoint): boolean {
  const frames = head.lsn - from.lsn, bytes = head.frameEndOffset - from.frameEndOffset;
  return frames <= 1 || frames <= AUTHORITY_RECOVERY_BUDGET.pageFrames && bytes <= AUTHORITY_RECOVERY_BUDGET.pageBytes;
}
/**
 * 必要义务的推进下限：未迁移会话的推进待办只有迁移后才可发现。前台持续活动时，全库扫描（据此认出带推进事实的
 * 会话）与带推进事实的会话一次让路最多等这么久，随后推进一个片段再等；其余会话只在前台安静时迁移——它们的
 * 发布与随之而来的落盘、段整理不得抢占交互。
 */
const BACKGROUND_MAX_WAIT_MS = 1_000;
let backgroundMaxWaitMs = BACKGROUND_MAX_WAIT_MS;
/** 测试用：调整后台一次让路的最长等待；返回恢复原值的函数。 */
export function setDecisionMigrationMaxWaitForTesting(value: number): () => void {
  const prior = backgroundMaxWaitMs;
  backgroundMaxWaitMs = value;
  return () => { backgroundMaxWaitMs = prior; };
}
const URGENCY_RANK: Record<StorageMaintenanceUrgency, number> = { background: 0, recovery: 1, foreground: 2 };

function governorRoot(body: unknown): string | undefined {
  const value = body as { t?: string; lease?: { reservationId?: unknown }; rootReservationId?: unknown } | undefined;
  const root = value?.t === 'reserve' ? value.lease?.reservationId : value?.rootReservationId;
  return typeof root === 'string' ? root : undefined;
}

/** 信封涉及的决定状态分区：本会话事实、收编会话的转移事实，以及归属某会话存活预留的资源记录。 */
async function decisionPartitionsOf(envelope: CommitEnvelope<unknown>, view: DurableProjectionReadContext): Promise<Set<string>> {
  const partitions = new Set<string>();
  for (const entry of envelope.entries) {
    if (entry.stream.startsWith('run:')) partitions.add(entry.stream.slice(4));
    else if (entry.stream.startsWith('transfer:')) {
      partitions.add(TRANSFER_PARTITION);
      const body = entry.body as { t?: string; conversationId?: unknown } | undefined;
      if (body?.t === 'conversation-transfer-committed-base' && typeof body.conversationId === 'string') partitions.add(body.conversationId);
    } else if (entry.stream === 'governor') {
      const root = governorRoot(entry.body);
      if (!root) continue;
      // 未迁移会话的预留没有见证：这类资源记录照常追加，由资源调度自身校验，该会话迁移时再一并续算。
      const witness = await view.get(conversationResourceWitnessKey(root)) as { conversationId?: unknown } | undefined;
      if (typeof witness?.conversationId === 'string') partitions.add(witness.conversationId);
    }
  }
  return partitions;
}

/**
 * 迁移完成前：候选写入涉及未迁移分区时，先迁移再重做。不经准入的历史事实（崩溃后补算、旧版本写下的事实）
 * 无法折叠进未迁移分区，同信封的其余分区一并退回未迁移：撤销迁移标记，并把会话记入会话清单（没有历史的
 * 新会话也因此需要迁移），之后从日志完整续算。
 */
export function partitionedDecisionReducer(log: AuthorityCommitLog, inner: DurableProjectionReducer<unknown>): DurableProjectionReducer<unknown> {
  return async (envelope, view, source) => {
    if (await decisionMigrationActive(view)) {
      const partitions = await decisionPartitionsOf(envelope, view);
      const missing: string[] = [];
      for (const partition of partitions) if (!await decisionPartitionReady(view, partition)) missing.push(partition);
      if (missing.length) {
        if (source.candidate) throw decisionMigrationRequired(log, missing);
        return [...partitions].filter(partition => !missing.includes(partition)).flatMap((partition): DurableProjectionMutation[] => [
          { kind: 'tombstone', key: decisionPartitionKey(partition) },
          ...(partition === TRANSFER_PARTITION ? [] : [{ kind: 'put' as const, key: decisionConversationKey(partition),
            value: { conversationId: partition, lastLsn: source.checkpoint.lsn } }])]);
      }
    }
    return inner(envelope, view, source);
  };
}

interface TransferIndex {
  readonly bindings: readonly DecisionTransferBinding[];
  /** 全库扫描到的位置，以及各会话最后一次事实的位置（后台按近期使用排序）。 */
  readonly through: number;
  readonly conversations: ReadonlyMap<string, number>;
  /** 有推进事实的会话：可能带着待恢复的推进义务，后台先迁移它们，使义务尽早可被发现。 */
  readonly advancing: ReadonlySet<string>;
}

/** 一个会话在某投影中已有的全部行：会话前缀、待办目录项、收编绑定，以及归属它的预留见证。 */
async function existingPartitionKeys(view: DurableProjectionReadContext, id: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const row of await scanConversationState(view, conversationStateBase(id))) keys.add(row.key);
  for (const key of [advancementPendingPrefix + hash(id), conversationBaseKey(id), conversationBaseUnavailableKey(id), decisionPartitionKey(id)]) {
    if (await view.get(key) !== undefined) keys.add(key);
  }
  for (const row of await scanConversationState(view, 'resource/')) {
    if ((row.value as { conversationId?: unknown } | undefined)?.conversationId !== id) continue;
    keys.add(row.key);
    const root = row.key.slice('resource/'.length);
    for (const prefix of ['resource-hold/' + root + '/', 'resource-usage/' + root + '/']) for (const usage of await scanConversationState(view, prefix)) keys.add(usage.key);
  }
  return keys;
}

/**
 * 会话迁移的整批写入：迁移结果的全部行（含迁移标记），以及此前遗留而不再属于该会话的行。整批已在锁外按快照规范化，
 * 这里只规范化快照之后被尾部续算改动的行（未改动的行保留同一对象）和遗留行的删除。
 */
async function replacement(view: DurableProjectionReadContext, rows: DecisionRows,
  staged: { readonly snapshot: PersistentSortedMap<JsonValue | undefined>; readonly bulk: NormalizedProjectionMutations }, id: string): Promise<NormalizedProjectionMutations> {
  const overrides: DurableProjectionMutation[] = [], written = new Set<string>();
  for (const [key, value] of rows.snapshot().entriesFrom()) {
    if (value !== undefined) written.add(key);
    if (staged.snapshot.get(key) === value) continue;
    overrides.push(value === undefined ? { kind: 'tombstone', key } : { kind: 'put', key, value });
  }
  for (const key of await existingPartitionKeys(view, id)) if (!written.has(key)) overrides.push({ kind: 'tombstone', key });
  return mergeNormalizedProjectionMutations(staged.bulk, normalizeProjectionMutations(overrides));
}

/** 后台迁移的让路方式：等到前台安静；信号取消时立即返回。 */
export type DecisionMigrationIdle = (signal: AbortSignal) => Promise<void>;

export interface DecisionMigrationStatus {
  readonly complete: boolean;
  readonly migrating: readonly string[];
  readonly failed: ReadonlyMap<string, string>;
}

class DecisionMigrator {
  readonly #running = new Map<string, Promise<void>>();
  readonly #failed = new Map<string, string>();
  readonly #priority: string[] = [];
  readonly #urgency = new Map<string, StorageMaintenanceUrgency>();
  #transfers?: Promise<TransferIndex>;
  #background?: Promise<void>;
  #complete = false;
  /** 有调用方正在等待的分区及等待数。 */
  readonly #interest = new Map<string, number>();
  readonly #wakers = new Set<() => void>();
  #idle?: DecisionMigrationIdle;
  readonly #stopping = new AbortController();
  /** 全库扫描认出的带推进事实的会话：它们享有推进下限。 */
  #advancing: ReadonlySet<string> = new Set();

  constructor(private readonly log: AuthorityCommitLog, private readonly artifacts: ArtifactStore, private readonly verifier: ProtocolSignatureVerifier) {}

  status(): DecisionMigrationStatus {
    return { complete: this.#complete, migrating: [...this.#running.keys()], failed: new Map(this.#failed) };
  }

  /** 调用方正在等待这些分区：它们按前台推进，不为前台活动让路。 */
  migrate(partitions: readonly string[]): Promise<void> {
    const unique = [...new Set(partitions)];
    for (const partition of unique) this.#raise(partition);
    return Promise.all(unique.map(partition => this.#one(partition))).then(() => undefined)
      .finally(() => { for (const partition of unique) this.#lower(partition); });
  }

  /** 选中的会话插到后台队列最前，并立即按前台开始迁移（不排在其他会话之后）。 */
  prioritize(conversationId: string): void {
    if (!this.#priority.includes(conversationId)) this.#priority.unshift(conversationId);
    if (this.#complete) return;
    this.#raise(conversationId);
    void this.#one(conversationId).catch(() => undefined).finally(() => this.#lower(conversationId));
  }

  start(options: { readonly idle?: DecisionMigrationIdle } = {}): Promise<void> {
    if (this.#stopping.signal.aborted) return Promise.resolve();
    if (options.idle) this.#idle = options.idle;
    // 被 Host 停止取消属于正常结束，不是迁移失败。
    return this.#background ??= this.#runBackground().catch(error => { if (!this.#stopping.signal.aborted) throw error; })
      .finally(() => { this.#background = undefined; });
  }

  /** Host 停止：取消让路中的等待，后台与进行中的迁移在下一个让出点退出；等它们全部结束。 */
  async stop(): Promise<void> {
    this.#stopping.abort();
    for (const wake of this.#wakers) wake();
    await Promise.allSettled([this.#background, ...this.#running.values()]);
  }

  #raise(partition: string): void {
    this.#interest.set(partition, (this.#interest.get(partition) ?? 0) + 1);
    for (const wake of this.#wakers) wake();
  }

  #lower(partition: string): void {
    const remaining = (this.#interest.get(partition) ?? 1) - 1;
    if (remaining > 0) this.#interest.set(partition, remaining);
    else this.#interest.delete(partition);
  }

  /**
   * 迁移的让出点：总是让出事件循环。没有调用方在等这一分区（会话清单扫描：任一分区）时，再等前台安静；
   * 等待期间有调用方开始等它，立即继续。maintenance 为发布带出的段整理的步间让路：只等前台安静，不享有推进
   * 下限（整理不影响义务能否被发现，不在交互期间推进）。
   */
  async #pace(partition: string | undefined, maintenance = false): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (this.#stopping.signal.aborted) throw new StorageMaintenanceCancelledError();
    const wanted = () => partition === undefined ? this.#interest.size > 0 : this.#interest.has(partition);
    if (!this.#idle || wanted()) return;
    const controller = new AbortController();
    const wake = () => { if (wanted() || this.#stopping.signal.aborted) controller.abort(); };
    const floor = !maintenance && (partition === undefined || this.#advancing.has(partition)) ? setTimeout(() => controller.abort(), backgroundMaxWaitMs) : undefined;
    floor?.unref?.();
    this.#wakers.add(wake);
    try { await this.#idle(controller.signal); } finally { clearTimeout(floor); this.#wakers.delete(wake); }
    if (this.#stopping.signal.aborted) throw new StorageMaintenanceCancelledError();
  }

  #one(partition: string): Promise<void> {
    if (this.#stopping.signal.aborted) return Promise.reject(new StorageMaintenanceCancelledError());
    // 准入紧急度取最强的等待者：前台读写在等的迁移按前台准入，只有后台在等的按后台。
    const urgency = currentMaintenanceUrgency();
    if (URGENCY_RANK[urgency] > URGENCY_RANK[this.#urgency.get(partition) ?? 'background']) this.#urgency.set(partition, urgency);
    const running = this.#running.get(partition);
    if (running) return running;
    // 迁移由本迁移器负责到底且可整体重做：脱离调用方的互斥区与容量步骤，否则持有互斥区的调用方触发它时，
    // 它的每次日志操作都只能零等待、锁忙即被拒绝。
    const work = runDetachedDeviceCapacity(() => runDetachedMaintenanceContext('background', () =>
      runWithMaintenanceUrgency(() => this.#urgency.get(partition) ?? 'background', currentMaintenanceAbortSignal(),
        () => this.#untilAdmitted(() => partition === TRANSFER_PARTITION ? this.#transferPartition() : this.#conversation(partition)))))
      .then(() => { this.#failed.delete(partition); },
        error => { if (!this.#stopping.signal.aborted) this.#failed.set(partition, String((error as Error)?.message ?? error)); throw error; })
      .finally(() => { this.#running.delete(partition); this.#urgency.delete(partition); });
    this.#running.set(partition, work);
    return work;
  }

  /** 存储的暂时背压不是迁移失败：等待后整体重做（发布可整体重做）；持续超过一分钟才如实失败。 */
  async #untilAdmitted(migrate: () => Promise<void>): Promise<void> {
    let deadline: number | undefined;
    for (;;) {
      try { return await migrate(); } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined) throw error;
        deadline ??= performance.now() + 60_000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(Math.max(delay, 50), 1_000));
      }
    }
  }

  /** 在 canonical 上读各已登记决定状态投影的同一已验位置。 */
  async #read<T>(read: (view: (projectionId: string) => DurableProjectionReadContext, projections: readonly string[]) => Promise<T>): Promise<T> {
    const projections = decisionProjections(this.log);
    return (await this.log.transactDurableProjection<never, T>(CONVERSATION_RUN_STATE_PROJECTION_ID, async (_canonical, context) =>
      ({ kind: 'return', value: await read(id => context.readProjection(id), projections) }), { readProjectionIds: projections })).value;
  }

  async #migrated(partition: string): Promise<boolean> {
    return this.#read(async (view, projections) => {
      for (const id of projections) if (!await decisionPartitionReady(view(id), partition)) return false;
      return true;
    });
  }

  async #allComplete(): Promise<boolean> {
    return this.#read(async (view, projections) => {
      for (const id of projections) if (await decisionMigrationActive(view(id))) return false;
      return true;
    });
  }

  async #conversation(id: string): Promise<void> {
    if (await this.#migrated(id)) return;
    const index = await this.#ensureTransfers();
    if (await this.#migrated(id)) return;
    const origin = await this.log.originCheckpoint(), head = await this.log.checkpoint();
    const migration = new ConversationDecisionMigration({ log: this.log, artifacts: this.artifacts, verifier: this.verifier,
      conversationId: id, origin, transfers: index.bindings, pace: () => this.#pace(id) });
    await migration.start(logDecisionSource(this.log), head.lsn);
    if (!this.log.publishProjectionRows) throw new TypeError('Conversation migration requires projection publication');
    const projections = decisionProjections(this.log);
    const rowsOf = (projectionId: string) => projectionId === CONVERSATION_RUN_STATE_PROJECTION_ID ? migration.canonical : migration.advancement;
    // 迁移已续算到的已验证源位置。
    let through = head;
    for (;;) {
      through = await this.#catchUp(migration, through);
      await this.#pace(id);
      // 迁移结果在锁外按快照整批规范化（逐值求规范字节数随会话状态大小增长，分片进行、不长时间占用事件循环）；
      // 锁内只处理快照之后的改动。
      const staged = new Map<string, { readonly snapshot: PersistentSortedMap<JsonValue | undefined>; readonly bulk: NormalizedProjectionMutations }>();
      for (const projectionId of projections) {
        const rows = rowsOf(projectionId);
        staged.set(projectionId, { snapshot: rows.snapshot(),
          bulk: await normalizeProjectionMutationsInSlices([...rows.rows()].map(([key, value]): DurableProjectionMutation => ({ kind: 'put', key, value }))) });
      }
      // 只有后台在迁移的小会话推迟落盘：迁移结果可从日志重新推导，崩溃丢失时该会话重新迁移；
      // 前台在等的会话与大批写入照常落盘。
      const deferFlush = !this.#interest.has(id) && projections.every(projectionId => rowsOf(projectionId).size <= DEFERRED_FLUSH_ROWS);
      let tailTooLong = false;
      await this.log.publishProjectionRows(projections, async (current, read, source) => {
        tailTooLong = false;
        const pending: string[] = [];
        for (const projectionId of projections) if (!await decisionPartitionReady(read(projectionId), id)) pending.push(projectionId);
        if (!pending.length) return new Map();
        if (!lockedTailWithinBudget(through, current)) { tailTooLong = true; return new Map(); }
        // 锁内只补齐不超过预算的尾部：未迁移期间本会话事实无法写入，只有归属其预留的资源记录可能追加。
        await migration.extend(source as DecisionSourceReader, current.lsn);
        const changes = new Map<string, NormalizedProjectionMutations>();
        for (const projectionId of pending) changes.set(projectionId, await replacement(read(projectionId), rowsOf(projectionId), staged.get(projectionId)!, id));
        return changes;
      }, { deferFlush, betweenSteps: () => this.#pace(undefined, true) });
      if (!tailTooLong) return;
    }
  }

  /** 锁外把迁移从已验证位置 from 续算到距最新头部在锁内预算之内，返回续算到的位置；后台迁移按前台让路。 */
  async #catchUp(migration: ConversationDecisionMigration, from: DurableLogCheckpoint): Promise<DurableLogCheckpoint> {
    for (let at = from;;) {
      const latest = await this.log.checkpoint();
      if (lockedTailWithinBudget(at, latest)) return at;
      await migration.extend(logDecisionSource(this.log), latest.lsn, { paced: true });
      at = latest;
    }
  }

  #ensureTransfers(): Promise<TransferIndex> {
    return this.#transfers ??= this.#loadOrBuildTransfers().catch(error => { this.#transfers = undefined; throw error; });
  }

  /** 转移分区的迁移标记可能被不经准入的历史事实撤销：已有的清单结果不再可用，重新扫描。 */
  async #transferPartition(): Promise<void> {
    const cached = this.#transfers;
    if (cached) {
      await cached.catch(() => undefined);
      if (await this.#migrated(TRANSFER_PARTITION)) return;
      if (this.#transfers === cached) this.#transfers = undefined;
    }
    await this.#ensureTransfers();
  }

  async #loadOrBuildTransfers(): Promise<TransferIndex> {
    const stored = await this.#read(async (view, projections) => {
      let complete = true;
      for (const id of projections) if (!await decisionPartitionReady(view(id), TRANSFER_PARTITION) || await view(id).get(DECISION_INDEXED_THROUGH) === undefined) complete = false;
      const canonical = view(CONVERSATION_RUN_STATE_PROJECTION_ID);
      if (!complete) return undefined;
      const through = (await canonical.get(DECISION_INDEXED_THROUGH) as { lsn: number }).lsn;
      const conversations = new Map<string, number>(), advancing = new Set<string>();
      for (const row of await scanConversationState(canonical, DECISION_CONVERSATION_PREFIX)) {
        const value = row.value as { conversationId: string; lastLsn: number; advancement?: true };
        conversations.set(value.conversationId, value.lastLsn);
        if (value.advancement) advancing.add(value.conversationId);
      }
      return { bindings: (await canonical.get(TRANSFER_INDEX_KEY) ?? []) as unknown as DecisionTransferBinding[], through, conversations, advancing };
    });
    return stored ?? this.#buildTransfers();
  }

  /**
   * 全库只读扫描一次：转移事实按转移编号分流，无法按流标记定位；同一遍扫描列出全部会话及其最后位置。
   * 用同一 canonical 归约折叠转移状态，记录每个收编事实之前一刻的转移状态，供该会话迁移时并入。
   * 扫描期间追加的少量尾部在发布时于锁内补齐：清单建立前，转移事实与已有会话的事实都无法折叠进投影。
   */
  async #buildTransfers(): Promise<TransferIndex> {
    const origin = await this.log.originCheckpoint();
    const rows = new DecisionRows(), reduce = conversationRunStateReducer(this.log), bindings: DecisionTransferBinding[] = [];
    const conversations = new Map<string, number>(), advancing = new Set<string>();
    rows.apply([[decisionPartitionKey(TRANSFER_PARTITION), {}]]);
    const fold = async (envelope: CommitEnvelope<unknown>, checkpoint: DurableLogCheckpoint, reader: Pick<DecisionSourceReader, 'readEnvelopeAt'>) => {
      for (const entry of envelope.entries) if (entry.stream.startsWith('run:')) {
        conversations.set(entry.stream.slice(4), envelope.lsn);
        if ((entry.body as { t?: string } | undefined)?.t === 'advancement-event') advancing.add(entry.stream.slice(4));
      }
      if (!envelope.entries.some(entry => entry.stream.startsWith('transfer:'))) return;
      const marks: (readonly [string, JsonValue])[] = [], found: DecisionTransferBinding[] = [];
      for (const entry of envelope.entries) {
        const body = entry.body as { t?: string; transferId?: unknown; conversationId?: unknown } | undefined;
        if (body?.t !== 'conversation-transfer-committed-base' || typeof body.transferId !== 'string' || typeof body.conversationId !== 'string') continue;
        // 收编事实同时属于被收编会话：该会话迁移时先放入这一刻之前的转移状态，再用同一归约处理这个信封。
        marks.push([decisionPartitionKey(body.conversationId), { conversationId: body.conversationId }]);
        const transferKey = conversationTransferStateKey(body.transferId);
        found.push({ checkpoint, conversationId: body.conversationId, transferKey, prior: await rows.get(transferKey) ?? null });
      }
      rows.apply(marks);
      const source: DurableProjectionSource = { checkpoint, originCheckpoint: origin, readEnvelopeAt: location => reader.readEnvelopeAt(location) };
      const changes = await verifyProtocolStep(() => reduce(envelope as CommitEnvelope<JsonValue>, rows, source));
      rows.apply(changes.map(m => [m.key, m.kind === 'put' ? m.value : undefined] as const));
      bindings.push(...found);
    };
    let at = origin;
    /** 锁外从上次位置读到当前头部。 */
    const scan = async () => {
      for (;;) {
        await this.#pace(undefined);
        const page = await this.log.readTail<unknown>(at, 256);
        for (let n = 0; n < page.commits.length; n++) await fold(page.commits[n]!, page.checkpoints[n]!, this.log);
        at = page.checkpoint;
        if (!page.hasMore) return;
      }
    };
    await scan();
    if (!this.log.publishProjectionRows) throw new TypeError('Conversation migration requires projection publication');
    const projections = decisionProjections(this.log);
    let through = at.lsn;
    for (;;) {
      const scannedAt = at, scanned = at.lsn;
      let tailTooLong = false;
      await this.log.publishProjectionRows(projections, async (head, read, source) => {
        tailTooLong = false;
        // 锁内只补不超过预算的尾部；超出时放弃本次发布，回到锁外继续读。
        if (!lockedTailWithinBudget(scannedAt, head)) { tailTooLong = true; return new Map(); }
        // 锁内操作可能被整体重跑：失败时回到扫描结果，下次从同一位置重新补齐尾部。
        const saved = { rows: rows.snapshot(), bindings: bindings.length, conversations: [...conversations], advancing: [...advancing] };
        try {
          for (let after = scanned; after < head.lsn;) {
            const page = await source.readStreamEnvelopes<unknown>([], after, head.lsn);
            for (let n = 0; n < page.commits.length; n++) await fold(page.commits[n]!, page.checkpoints[n]!, source);
            if (!page.hasMore) break;
            after = page.lastLsn;
          }
          through = head.lsn;
          // 转移分区只发布转移状态，并整体替换已有的转移状态；收编得到的基线绑定和会话目录属于各自会话，由会话迁移写入。
          // 每个决定状态投影都用同一函数从同一前序状态折叠转移事实，转移状态行彼此相同。
          const transferRows: DurableProjectionMutation[] = [...rows.rows()].filter(([key]) => key.startsWith(CONVERSATION_TRANSFER_STATE_PREFIX))
            .map(([key, value]): DurableProjectionMutation => ({ kind: 'put', key, value }));
          const indexRows: DurableProjectionMutation[] = [{ kind: 'put', key: DECISION_INDEXED_THROUGH, value: { lsn: head.lsn } },
            ...[...conversations].map(([conversationId, lastLsn]): DurableProjectionMutation =>
              ({ kind: 'put', key: decisionConversationKey(conversationId), value: { conversationId, lastLsn, ...(advancing.has(conversationId) ? { advancement: true } : {}) } }))];
          const changes = new Map<string, DurableProjectionMutation[]>();
          for (const projectionId of projections) {
            const view = read(projectionId);
            if (!await decisionMigrationActive(view)) continue;
            const transfersReady = await view.get(decisionPartitionKey(TRANSFER_PARTITION)) !== undefined;
            const indexed = await view.get(DECISION_INDEXED_THROUGH) !== undefined;
            if (transfersReady && indexed) continue;
            const next: DurableProjectionMutation[] = [];
            // 会话清单只建一次：清单之后出现的会话要么经准入完整折叠，要么已被不经准入的事实记入清单。
            if (!indexed) next.push(...indexRows);
            if (!transfersReady) {
              next.push({ kind: 'put', key: decisionPartitionKey(TRANSFER_PARTITION), value: {} });
              const written = new Set(transferRows.map(mutation => mutation.key));
              next.push(...transferRows);
              for (const row of await scanConversationState(view, CONVERSATION_TRANSFER_STATE_PREFIX)) if (!written.has(row.key)) next.push({ kind: 'tombstone', key: row.key });
              // 收编位置只供迁移器读取，存于 canonical。
              if (projectionId === CONVERSATION_RUN_STATE_PROJECTION_ID) next.push({ kind: 'put', key: TRANSFER_INDEX_KEY, value: bindings as unknown as JsonValue });
            }
            changes.set(projectionId, next);
          }
          return changes;
        } catch (error) {
          rows.restore(saved.rows);
          bindings.length = saved.bindings;
          conversations.clear();
          for (const [id, lsn] of saved.conversations) conversations.set(id, lsn);
          advancing.clear();
          for (const id of saved.advancing) advancing.add(id);
          throw error;
        }
      }, { betweenSteps: () => this.#pace(undefined, true) });
      if (!tailTooLong) break;
      await scan();
    }
    return { bindings, through, conversations, advancing };
  }

  async #runBackground(): Promise<void> {
    if (await this.#allComplete()) { this.#complete = true; return; }
    const index = await this.#ensureTransfers();
    // 有推进事实的会话在前（义务尽早可被发现），各自按最近使用排序一次；被选中的会话随时插到最前。
    this.#advancing = index.advancing;
    const recent = [...index.conversations].sort((a, b) => Number(index.advancing.has(b[0])) - Number(index.advancing.has(a[0])) || b[1] - a[1])
      .map(([id]) => id);
    const attempted = new Set<string>();
    let cursor = 0;
    for (;;) {
      if (this.#stopping.signal.aborted) return;
      let next = this.#priority.find(id => !attempted.has(id));
      if (next === undefined) {
        while (cursor < recent.length && attempted.has(recent[cursor]!)) cursor++;
        next = recent[cursor];
      }
      if (next === undefined) break;
      attempted.add(next);
      await this.#pace(next);
      // 单个会话迁移失败（例如历史事实非法）只令该会话保持未迁移、使用时如实失败，不阻断其他会话。
      await this.#one(next).catch(() => undefined);
    }
    await this.#finish();
  }

  /**
   * 全部分区就绪才写完成标记；此后投影与逐事实折叠一致。未就绪的只可能是转移分区或会话清单中的会话
   * （清单之外的会话在迁移开始前没有历史），因此只核对清单，不读日志。
   */
  async #finish(): Promise<void> {
    if (this.#failed.size || !this.log.publishProjectionRows) return;
    for (let round = 0; round < 3; round++) {
      const missing = new Set<string>();
      const projections = decisionProjections(this.log);
      await this.log.publishProjectionRows(projections, async (head, read) => {
        missing.clear();
        const open: string[] = [];
        for (const projectionId of projections) if (await decisionMigrationActive(read(projectionId))) open.push(projectionId);
        if (!open.length) return new Map();
        for (const projectionId of open) {
          const view = read(projectionId);
          if (!await decisionPartitionReady(view, TRANSFER_PARTITION) || await view.get(DECISION_INDEXED_THROUGH) === undefined) missing.add(TRANSFER_PARTITION);
          for (const row of await scanConversationState(view, DECISION_CONVERSATION_PREFIX)) {
            const id = (row.value as { conversationId: string }).conversationId;
            if (await view.get(decisionPartitionKey(id)) === undefined) missing.add(id);
          }
        }
        if (missing.size) return new Map();
        const complete: DurableProjectionMutation = { kind: 'put', key: DECISION_MIGRATION_COMPLETE, value: { through: head.lsn } };
        return new Map(open.map(projectionId => [projectionId, [complete]]));
      });
      if (!missing.size) { this.#complete = true; return; }
      for (const id of missing) await this.#one(id).catch(() => undefined);
      if (this.#failed.size) return;
    }
  }
}

const migrators = new WeakMap<AuthorityCommitLog, DecisionMigrator>();

/** canonical 登记时安装：未迁移分区的读写据此迁移。 */
export function installConversationDecisionMigration(log: AuthorityCommitLog, artifacts: ArtifactStore, verifier: ProtocolSignatureVerifier): void {
  if (migrators.has(log)) return;
  const migrator = new DecisionMigrator(log, artifacts, verifier);
  migrators.set(log, migrator);
  installDecisionMigrator(log, partitions => migrator.migrate(partitions));
}

/** Host 就绪后在后台迁移其余会话；不阻塞启动。提供 idle 时只在前台安静时推进。 */
export function startConversationDecisionMigration(log: AuthorityCommitLog, options: { readonly idle?: DecisionMigrationIdle } = {}): Promise<void> | undefined {
  return migrators.get(log)?.start(options);
}

/** Host 停止时调用：取消后台迁移的等待并等进行中的迁移退出。 */
export function stopConversationDecisionMigration(log: AuthorityCommitLog): Promise<void> {
  return migrators.get(log)?.stop() ?? Promise.resolve();
}

/** 终端选中会话时立即迁移它（若尚未迁移）。 */
export function prioritizeConversationDecisionMigration(log: AuthorityCommitLog, conversationId: string): void {
  migrators.get(log)?.prioritize(conversationId);
}

export function conversationDecisionMigrationStatus(log: AuthorityCommitLog): DecisionMigrationStatus | undefined {
  return migrators.get(log)?.status();
}

/** 只读查询：一批会话中决定状态尚不能直接读写（须先迁移）的那些。一次读取，不触发迁移。 */
export async function conversationDecisionPending(log: AuthorityCommitLog, conversationIds: readonly string[]): Promise<ReadonlySet<string>> {
  const pending = new Set<string>();
  if (!conversationIds.length || !migrators.has(log)) return pending;
  const projections = decisionProjections(log);
  await log.transactDurableProjection<never, undefined>(CONVERSATION_RUN_STATE_PROJECTION_ID, async (_canonical, context) => {
    pending.clear();
    for (const id of projections) {
      const view = context.readProjection(id);
      if (!await decisionMigrationActive(view)) continue;
      for (const conversationId of conversationIds) if (!await decisionPartitionReady(view, conversationId)) pending.add(conversationId);
    }
    return { kind: 'return', value: undefined };
  }, { readProjectionIds: projections });
  return pending;
}

/** 只读查询：该会话的决定状态是否已可直接读写（不在迁移中、已迁移或没有历史）。不触发迁移。 */
export async function conversationDecisionReady(log: AuthorityCommitLog, conversationId: string): Promise<boolean> {
  const projections = decisionProjections(log);
  return (await log.transactDurableProjection<never, boolean>(CONVERSATION_RUN_STATE_PROJECTION_ID, async (_canonical, context) => {
    for (const id of projections) if (!await decisionPartitionReady(context.readProjection(id), conversationId)) return { kind: 'return', value: false };
    return { kind: 'return', value: true };
  }, { readProjectionIds: projections })).value;
}
