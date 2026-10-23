import type { ArtifactStore, AuthorityCommitLog, DurableLogCheckpoint, DurableProjectionReadContext, DurableProjectionScanPage,
  DurableProjectionScanRange, DurableProjectionSource } from '@zhixing/core/authority';
import { PersistentSortedMap, createDurableProjectionOverlay } from '@zhixing/core/authority';
import type { CommitEnvelope, JsonValue, LogicalRecord } from '@zhixing/core/contracts';
import { canonicalize, interactionMirrorBatchDigest, protocolDigest, validateGovernorRecord, verifyProtocolStep, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';
import { reduceConversationRunState, reduceConversationSubmissionGuard, loadCommittedBundleBinding, emptyConversationRunProjection, emptySubmissionGuardProjection,
  type RunProjection, type SubmissionGuardProjection, type ConversationCommitLogRecord, type ConversationFactGroup } from './conversation-assignment.js';
import { conversationRunStateReducer, conversationStateBase as base, conversationStateHash as hash, conversationStateFieldKey as fieldKey,
  encodeConversationState as encode, conversationGuardRows, storeConversationGuard, assignmentResourceLive,
  conversationResourceWitnessKey, conversationResourceHoldKey, conversationResourceUsageKey, conversationReductionContexts, CONVERSATION_RUN_STATE_PROJECTION_ID,
  type ResourceWitness } from './conversation-run-state-index.js';
import { conversationRunRootKey, type ConversationRunRoot } from './conversation-run-state-extras.js';
import { advancementRecoveryReducer, advancementRecoveryRegistered } from './advancement-recovery-index.js';
import { decisionPartitionKey } from './conversation-decision-partition-keys.js';

/**
 * 旧资料升级：会话的可信决定状态迁移。
 *
 * 可信基点是旧版本按会话写下的认证检查点（运行状态、提交守卫）：它们由 owner 以完整校验折叠事实得到，
 * MAC 与已核验帧链边界由日志加载器核对。基点之前的事实不再完整校验，只做一次只读扫描，补齐检查点
 * 没有保存的原文位置并折叠推进待办目录；基点之后的事实用同一组生产归约完整校验续算。没有基点时从起点续算。
 *
 * 只接受经代码历史审计、与现行归约语义兼容的检查点代次（键内归约指纹）；其余一律视为没有基点，
 * 从日志起点完整校验。转换需要整份读取旧检查点并按键改写，规模是该会话已积累的状态，只发生一次。
 */

const RUN_CHECKPOINT = 'conversation-run-projection:v2:';
const GUARD_CHECKPOINT = 'conversation-submission-projection:v1:';
/**
 * 旧版本写过会话检查点的全部代次（写入期间提交的代码只有一版归约，另一代来自同期未提交构建）。审计依据：
 * 对真实旧资料副本，各代检查点在其边界处的状态与现行归约从起点完整重放到同一位置逐字段一致（输入正文的
 * 存放形式除外，迁移从原始事实重新取得；另有两项新增字段按下方规则转换），从其续算到头部也与完整重放一致。
 * 键内指纹只覆盖当时的归约函数本体，因此新代次不能凭指纹自动纳入，必须重新审计后列入。
 */
const TRUSTED_RUN_GENERATIONS = new Set(['e537cbb8810d6903', 'c719305717f89751']);
const TRUSTED_GUARD_GENERATIONS = new Set(['9eac0d4e1b9751ac', '22bf144f0dccda64']);

type Location = { readonly checkpoint: DurableLogCheckpoint; readonly item: number };
interface InputRow { record: Record<string, unknown>; lsn: number; source: Location; inputRef?: JsonValue; inputDigest?: string }

/** 认证检查点键：<名称>:v<版本>:<16位指纹>:<会话>:<owner代>。会话标识自身可能含冒号。 */
function parseCheckpointKey(key: string, prefix: string): { fingerprint: string; conversationId: string; ownerEpoch: string } | undefined {
  if (!key.startsWith(prefix)) return;
  const rest = key.slice(prefix.length), fingerprint = rest.slice(0, 16);
  if (rest[16] !== ':') return;
  const tail = rest.slice(17), split = tail.lastIndexOf(':');
  if (split <= 0) return;
  return { fingerprint, conversationId: tail.slice(0, split), ownerEpoch: tail.slice(split + 1) };
}

export interface ConversationTrustedBase {
  readonly run: RunProjection; readonly runLsn: number;
  readonly guard: SubmissionGuardProjection; readonly guardLsn: number;
}

/** 取同一 owner 代、两者都认证通过的最新一对旧检查点；没有就返回 undefined（从起点完整校验）。 */
/**
 * 受信旧代次的会话检查点键，按会话分组。旧代次检查点不会再写入（受信代次只含旧版本），每本日志只列一次：
 * 逐会话列目录会让后台迁移随会话数平方增长。列出后新增的键只可能来自非受信代次，删除的键读取时视同不存在。
 */
const trustedCheckpointKeys = new WeakMap<AuthorityCommitLog, Promise<ReadonlyMap<string, { readonly run: string[]; readonly guard: string[] }>>>();
function trustedCheckpointIndex(log: AuthorityCommitLog): Promise<ReadonlyMap<string, { readonly run: string[]; readonly guard: string[] }>> {
  let index = trustedCheckpointKeys.get(log);
  if (!index) {
    index = (async () => {
      const byConversation = new Map<string, { run: string[]; guard: string[] }>();
      for (const [prefix, trusted, kind] of [[RUN_CHECKPOINT, TRUSTED_RUN_GENERATIONS, 'run'], [GUARD_CHECKPOINT, TRUSTED_GUARD_GENERATIONS, 'guard']] as const) {
        for (const key of await log.listProjectionCheckpointKeys!(prefix)) {
          const parsed = parseCheckpointKey(key, prefix);
          if (!parsed || !trusted.has(parsed.fingerprint)) continue;
          const entry = byConversation.get(parsed.conversationId) ?? { run: [], guard: [] };
          entry[kind].push(key);
          byConversation.set(parsed.conversationId, entry);
        }
      }
      return byConversation;
    })();
    trustedCheckpointKeys.set(log, index);
    index.catch(() => { if (trustedCheckpointKeys.get(log) === index) trustedCheckpointKeys.delete(log); });
  }
  return index;
}

export async function loadConversationTrustedBase(log: AuthorityCommitLog, conversationId: string, maxLsn = Infinity): Promise<ConversationTrustedBase | undefined> {
  if (!log.listProjectionCheckpointKeys || !log.loadProjectionCheckpoint) return;
  const keys = (await trustedCheckpointIndex(log)).get(conversationId);
  if (!keys) return;
  const candidates = async (prefix: string, listed: readonly string[]) => {
    const found = new Map<string, { state: unknown; lsn: number }>();
    for (const key of listed) {
      const parsed = parseCheckpointKey(key, prefix);
      if (!parsed) continue;
      const loaded = await log.loadProjectionCheckpoint!<unknown>(key);
      if (!loaded || loaded.cursor.lsn > maxLsn) continue;
      const prior = found.get(parsed.ownerEpoch);
      if (!prior || prior.lsn < loaded.cursor.lsn) found.set(parsed.ownerEpoch, { state: loaded.state, lsn: loaded.cursor.lsn });
    }
    return found;
  };
  const runs = await candidates(RUN_CHECKPOINT, keys.run);
  if (runs.size === 0) return;
  const guards = await candidates(GUARD_CHECKPOINT, keys.guard);
  let best: ConversationTrustedBase | undefined;
  for (const [epoch, run] of runs) {
    const guard = guards.get(epoch);
    if (!guard) continue;
    const candidate = { run: convertRunState(run.state as RunProjection), runLsn: run.lsn,
      guard: convertGuardState(guard.state as SubmissionGuardProjection), guardLsn: guard.lsn };
    if (!best || Math.min(candidate.runLsn, candidate.guardLsn) > Math.min(best.runLsn, best.guardLsn)) best = candidate;
  }
  return best;
}

/** 两项在旧代次之后新增的字段：派发尝试次数由派发记录精确推出；接纳时的领域版本号旧状态没有，
 * 消费方对缺失值按清空位置判断，两种判断对同一历史等价，因此不补造。 */
function attemptsByRun(assigned: ReadonlyMap<string, { record: { runId: string; reservation: { attempt: number } } }>) {
  const attempts = new Map<string, number>();
  for (const value of assigned.values()) attempts.set(value.record.runId, Math.max(attempts.get(value.record.runId) ?? 0, value.record.reservation.attempt));
  return attempts;
}
function convertRunState(state: RunProjection): RunProjection {
  return { ...state, assignmentAttemptByRun: attemptsByRun(state.assignedById) } as RunProjection;
}
function convertGuardState(state: SubmissionGuardProjection): SubmissionGuardProjection {
  return { ...state, assignmentAttemptByRun: attemptsByRun(state.assignedById) } as SubmissionGuardProjection;
}

/** 内存中的有序决定状态行，供迁移期间的同一归约读写；删除以 undefined 占位。 */
export class DecisionRows implements DurableProjectionReadContext {
  #map = PersistentSortedMap.empty<JsonValue | undefined>();
  apply(changes: Iterable<readonly [string, JsonValue | undefined]>): void { this.#map = this.#map.withEntries(changes); }
  /** 当前内容（不可变）；失败时据此回到这一刻。 */
  snapshot(): PersistentSortedMap<JsonValue | undefined> { return this.#map; }
  restore(snapshot: PersistentSortedMap<JsonValue | undefined>): void { this.#map = snapshot; }
  has(key: string): boolean { return this.#map.get(key) !== undefined; }
  /** 行数（含删除占位）。 */
  get size(): number { return this.#map.size; }
  async get(key: string): Promise<JsonValue | undefined> { return this.#map.get(key); }
  async getMany(keys: readonly string[]): Promise<readonly (JsonValue | undefined)[]> { return keys.map(key => this.#map.get(key)); }
  async scan(range: DurableProjectionScanRange, limit: number, continuation?: string): Promise<DurableProjectionScanPage> {
    const start = continuation ?? range.gt ?? range.gte, exclusive = continuation !== undefined || range.gt !== undefined;
    const entries: { key: string; value: JsonValue }[] = [];
    for (const [key, value] of this.#map.entriesFrom(start)) {
      if (exclusive && key === start) continue;
      if (range.lt !== undefined && key >= range.lt) break;
      if (value === undefined) continue;
      if (entries.length === limit) return { entries, continuation: entries.at(-1)!.key };
      entries.push({ key, value });
    }
    return { entries };
  }
  *rows(): IterableIterator<[string, JsonValue]> { for (const [key, value] of this.#map.entriesFrom()) if (value !== undefined) yield [key, value]; }
}

/** 会话的资源见证：与 canonical 归约相同的保护（重复用量身份、归属一致、序号连续）。 */
interface Witness { lease: JsonValue; watermark: number; usages: JsonValue[]; openUsageReservations: number; conversationId?: string }
class WitnessLedger {
  constructor(readonly conversationId: string) {}
  readonly witnesses = new Map<string, Witness>();
  readonly holds = new Map<string, { reservation: JsonValue & { rootReservationId: string; reservationId: string }; consumed: boolean }>();
  readonly seen = new Map<string, JsonValue>();
  readonly owned = new Set<string>();
  apply(entry: LogicalRecord<unknown>, verifier: ProtocolSignatureVerifier): void {
    const body = validateGovernorRecord(entry.body, verifier) as unknown as Record<string, any>;
    const hold = (root: string, usage: string) => root + '\0' + usage;
    if (body.t === 'reserve') {
      if (!this.owned.has(body.lease.reservationId)) return;
      const prior = this.witnesses.get(body.lease.reservationId);
      if (prior?.lease && canonicalize(prior.lease) !== canonicalize(body.lease)) throw Error('Resource reservation identity changed');
      this.witnesses.set(body.lease.reservationId, { lease: body.lease, watermark: prior?.watermark ?? 0, usages: prior?.usages ?? [], openUsageReservations: prior?.openUsageReservations ?? 0, conversationId: this.conversationId });
    } else if (body.t === 'usage-reserved') {
      const prior = this.witnesses.get(body.rootReservationId);
      if (!prior) return;
      const held = this.holds.get(hold(body.rootReservationId, body.usageId));
      if (held) { if (canonicalize(held.reservation) !== canonicalize(body)) throw Error('Resource usage reservation identity changed'); return; }
      this.holds.set(hold(body.rootReservationId, body.usageId), { reservation: body as never, consumed: false });
      this.witnesses.set(body.rootReservationId, { ...prior, openUsageReservations: prior.openUsageReservations + 1 });
    } else if (body.t === 'consume') {
      const prior = this.witnesses.get(body.rootReservationId);
      if (!prior) return;
      const usage = { usageSeq: body.usageSeq, reservationId: body.reservationId, usageId: body.usageId,
        ...(body.tokens ? { tokens: body.tokens } : {}), ...(body.calls ? { calls: body.calls } : {}), ...(body.costMinor ? { costMinor: body.costMinor } : {}) };
      const key = hold(body.rootReservationId, body.usageId), seen = this.seen.get(key);
      if (seen !== undefined) { if (canonicalize(seen) !== canonicalize({ root: body.rootReservationId, usage })) throw Error('Resource usage identity changed'); return; }
      if (body.usageSeq !== prior.watermark + 1) throw Error('Resource usage witness is not continuous');
      const held = this.holds.get(key);
      if (!held || held.consumed || held.reservation.rootReservationId !== body.rootReservationId || held.reservation.reservationId !== body.reservationId || prior.openUsageReservations < 1) throw Error('Resource usage has no matching reservation');
      this.holds.set(key, { ...held, consumed: true });
      this.witnesses.set(body.rootReservationId, { ...prior, openUsageReservations: prior.openUsageReservations - 1, watermark: body.usageSeq,
        usages: [...((body.usageSeq - 1) % 256 === 0 ? [] : prior.usages), usage as JsonValue] });
      this.seen.set(key, { root: body.rootReservationId, usage } as JsonValue);
    }
  }
  /** 只保留存活派发的见证，与 canonical 在信封末尾的删除规则一致。 */
  rows(live: ReadonlySet<string>): Map<string, JsonValue> {
    const rows = new Map<string, JsonValue>();
    for (const [root, witness] of this.witnesses) if (live.has(root)) rows.set(conversationResourceWitnessKey(root), witness as unknown as JsonValue);
    for (const [key, value] of this.holds) { const [root, usage] = key.split('\0') as [string, string]; if (live.has(root)) rows.set(conversationResourceHoldKey(root, usage), value as unknown as JsonValue); }
    for (const [key, value] of this.seen) { const [root, usage] = key.split('\0') as [string, string]; if (live.has(root)) rows.set(conversationResourceUsageKey(root, usage), value); }
    return rows;
  }
}

function liveReservations(guard: SubmissionGuardProjection): Set<string> {
  const live = new Set<string>();
  for (const [assignmentId, assigned] of guard.assignedById) {
    if (assignmentResourceLive(guard, assignmentId, assigned.record.runId)) live.add(assigned.record.reservation.reservationId);
  }
  return live;
}

/** 检查点没有保存、而决定状态需要的原文位置与提交摘要：只读扫描基点前的本会话事实得到。 */
interface PrefixFacts {
  lastRunLsn: number;
  readonly admitted: Map<string, InputRow>;
  readonly appended: Map<string, InputRow & { runId: string; position: number }>;
  readonly mirrors: Map<string, Location>;
  readonly committed: Map<string, CommitEnvelope<unknown>>;
}

function inputRow(body: Record<string, unknown>, lsn: number, source: Location): InputRow {
  const { input, ...record } = body;
  const reference = input && typeof input === 'object' && Object.keys(input).length === 1 && 'ref' in input ? (input as { ref: JsonValue }).ref : undefined;
  return { record, lsn, source, ...(reference ? { inputRef: reference } : { inputDigest: protocolDigest('ConversationAdmittedInput', 1, input as JsonValue) }) };
}

/** 运行状态与守卫在基点处 → canonical 决定状态行（与逐事实折叠写出的行相同）。 */
export async function encodeConversationDecisionRows(id: string, run: RunProjection, guard: SubmissionGuardProjection,
  facts: PrefixFacts, artifacts: ArtifactStore): Promise<Map<string, JsonValue | undefined>> {
  const rows = new Map<string, JsonValue | undefined>();
  for (const [key, value] of conversationGuardRows(id, guard)) rows.set(key, value);
  await storeConversationGuard(createDurableProjectionOverlay(new DecisionRows(), rows), id, guard, new Map(), facts.lastRunLsn, rows);
  // 逐行编码随会话状态大小增长：先记下，最后分片编码、片间让出事件循环（extra 的键与其余行互不重叠，先后不影响结果）。
  const extras: (readonly [string, string | number, unknown])[] = [];
  const extra = (name: string, key: string | number, value: unknown) => { extras.push([name, key, value]); };
  const pending = (name: string, key: string, value: JsonValue) => rows.set(base(id) + 'pending-' + name + '/' + hash(key), value);
  for (const [key, value] of run.sessionMutationDigests) extra('sessionMutationDigests', key, value);
  for (const key of run.taskListRequestIds) extra('taskListRequestIds', key, true);
  for (const segment of run.segments) extra('segmentSeen', segment.segmentId, true);
  for (const [key, value] of run.sessionMetaByRequest) extra('sessionMetaByRequest', key, value);
  for (const [key, value] of run.lifecycleByRequest) extra('lifecycleByRequest', key, value);
  for (const [revision, value] of run.pendingLifecycleProjections) { extra('pendingLifecycleProjections', revision, value); pending('lifecycle', String(revision), revision); }
  for (const revision of run.projectedLifecycleRevisions) extra('projectedLifecycleRevisions', revision, true);
  const identities = new Map<string, string[]>();
  for (const [runId, row] of [...facts.admitted].sort((a, b) => a[1].lsn - b[1].lsn || a[1].source.item - b[1].source.item)) {
    if (!run.admittedByRun.has(runId)) continue;
    // 新代次的状态记有接纳时的领域版本号则沿用；旧代次没有，消费方按清空位置判断，二者等价。
    const admittedRevision = (run.admittedByRun.get(runId) as { domainRevision?: unknown } | undefined)?.domainRevision;
    extra('admittedByRun', runId, typeof admittedRevision === 'number' ? { ...row, domainRevision: admittedRevision } : row);
    const record = row.record as { ingress: { ingressId: string }; invocation: { source: unknown } };
    const identity = canonicalize([record.ingress.ingressId, record.invocation.source] as JsonValue);
    const prior = identities.get(identity) ?? [];
    if (!prior.includes(runId) && prior.length < 2) prior.push(runId);
    identities.set(identity, prior);
  }
  for (const [key, value] of identities) extra('runByIngressIdentity', key, value);
  for (const [ingressKey, row] of facts.appended) {
    if (!run.appendedInputs.has(ingressKey)) continue;
    const { runId, position, ...stored } = row;
    extra('appendedInputs', ingressKey, stored);
    rows.set(base(id) + 'appended/' + hash(runId) + '/' + String(position).padStart(16, '0') + '/' + hash(ingressKey), ingressKey);
    rows.set(fieldKey(id, 'runByIngress', ingressKey), { key: ingressKey, value: encode(runId) } as unknown as JsonValue);
  }
  for (const [runId, assignmentId] of run.openInputAssignments) extra('openInputAssignments', runId, assignmentId);
  for (const assignmentId of run.closedInputAssignments) extra('closedInputAssignments', assignmentId, true);
  const heads = new Map<string, number>();
  for (const consumption of run.inputConsumptions.values()) {
    const key = consumption.assignmentId + '/' + consumption.boundary;
    for (const ingressKey of consumption.ingressKeys) extra('consumedIngress', consumption.assignmentId + '\0' + ingressKey, true);
    heads.set(consumption.assignmentId, Math.max(heads.get(consumption.assignmentId) ?? 0, consumption.boundary));
    extra('inputConsumptions', key, consumption);
    rows.set(base(id) + 'consumed/' + hash(consumption.assignmentId) + '/' + String(consumption.boundary).padStart(16, '0'), key);
  }
  for (const [assignmentId, head] of heads) extra('inputConsumptionHead', assignmentId, head);
  for (const [runId, assignmentId] of run.assignmentByRun) extra('assignmentByRun', runId, assignmentId);
  for (const [runId, attempt] of run.assignmentAttemptByRun ?? []) extra('assignmentAttemptByRun', runId, attempt);
  for (const assignmentId of run.recoveryAssignments) pending('recovery', assignmentId, assignmentId);
  for (const [assignmentId, head] of run.mirrorStateByAssignment) extra('mirrorStateByAssignment', assignmentId, { ordinal: head.ordinal, mirroredUpTo: head.mirroredUpTo, mirrorDigest: head.mirrorDigest });
  for (const [key, value] of run.supersedeStartedObservations) extra('supersedeStartedObservations', key, value);
  for (const [key, value] of run.conflictByAssignment) extra('conflictByAssignment', key, value);
  for (const [key, value] of run.conflicts) extra('conflicts', key, value);
  for (const [key, value] of run.rejectedNotStarted) extra('rejectedNotStarted', key, value);
  for (const key of run.containedFacts) extra('containedFacts', key, true);
  for (const [key, value] of run.containmentByAssignment) extra('containmentByAssignment', key, value);
  for (const [key, value] of run.acceptedCancellations) extra('acceptedCancellations', key, value);
  for (const [key, value] of run.superseded) extra('superseded', key, value);
  for (const key of run.closedAssignments) extra('closedAssignments', key, true);
  for (const [key, value] of run.cancelOrigins) extra('cancelOrigins', key, value);
  for (const [key, value] of run.uncertainOrigins) extra('uncertainOrigins', key, value);
  const outcomes = new Set<string>();
  for (const [digest, record] of run.mirrorBatches) {
    for (const entry of record.batch.entries) {
      extra('mirrorRequests', record.assignmentId + '\0' + entry.requestId, true);
      if (!outcomes.has(entry.requestId)) {
        outcomes.add(entry.requestId);
        extra('interactionOutcome', entry.requestId, entry.outcome.t === 'answered' ? { t: 'answered', decisionDigest: entry.outcome.decisionDigest } : { t: 'closed' });
      }
    }
    const source = facts.mirrors.get(digest);
    if (!source) throw new TypeError('Interaction mirror batch has no source fact');
    extra('mirrorBatches', digest, { source });
  }
  const channel = run.channelInteractions as unknown as Record<string, Map<string, unknown>>;
  for (const name of ['preparedByChallenge', 'deliveredByChallenge', 'closedByChallenge', 'challengeByInteraction'] as const) {
    for (const [key, value] of channel[name] ?? []) extra('channel-' + name, key, value);
  }
  for (const challenge of channel.preparedByChallenge?.keys() ?? []) if (!channel.closedByChallenge?.has(challenge)) pending('channel', challenge, challenge);
  for (const [runId, history] of run.statusHistoryByRun) if (history.length) extra('statusHistoryByRun', runId, [history.at(-1)]);
  for (const [key, value] of run.advancementWrites) extra('advancementWrites', key, value);
  for (const [sessionId, session] of run.advancementSessions) { extra('advancementSessions', sessionId, session); extra('advancementStatuses', sessionId, (session as { status: string }).status); }
  const committedByRun = new Map<string, (typeof run.commits)[number]>();
  for (const [assignmentId, committed] of run.committedByAssignment) {
    extra('committedByAssignment', assignmentId, committed);
    extra('assignmentByCommitRevision', committed.commitRevision, assignmentId);
    extra('committedByRun', committed.runId, committed);
    committedByRun.set(committed.runId, committed);
    rows.set(base(id) + 'commit-order/' + String(committed.commitRevision).padStart(16, '0'), assignmentId);
  }
  for (const assignmentId of run.pendingCommitProjections.keys()) {
    const envelope = facts.committed.get(assignmentId);
    if (!envelope) throw new TypeError('Unprojected commit has no source fact');
    const binding = await loadCommittedBundleBinding(envelope as unknown as ConversationFactGroup, artifacts, candidate => candidate.assignmentId === assignmentId);
    extra('committedDigest', assignmentId, binding.bundle.digest);
    pending('commit', assignmentId, assignmentId);
  }
  for (const assignmentId of run.bundleAcknowledgementOutbox) pending('ack', assignmentId, assignmentId);
  for (const [runId, control] of run.worksceneControls) {
    const committed = committedByRun.get(runId);
    if (!committed) throw new TypeError('Workscene control has no committed run');
    extra('worksceneControls', runId, { bundle: committed.bundle.ref, ...(control.advancementSessionId ? { advancementSessionId: control.advancementSessionId } : {}) });
    rows.set(base(id) + 'workscene-controls/' + hash(runId), runId);
  }
  for (const [revision, value] of run.contentByRevision) extra('contentByRevision', revision, value);
  for (const [key, value] of run.projectedByAssignment) extra('projectedByAssignment', key, value);
  const sessions = [...run.advancementSessions.values()] as unknown as { id: string; status: string }[];
  const clears = [...run.lifecycleByRequest.values()].filter(value => (value as { mutation?: string }).mutation === 'clear');
  const latestCommit = [...run.committedByAssignment.values()].sort((a, b) => b.commitRevision - a.commitRevision)[0];
  const root: ConversationRunRoot = { domainRevision: run.domainRevision, deleted: run.deleted, clearedThroughLsn: run.clearedThroughLsn,
    hasDurableIdentity: run.admittedByRun.size > 0 || run.sessionMetaByRequest.size > 0 || run.lifecycleByRequest.size > 0,
    ...(clears.length ? { clearedThroughRevision: Math.max(...clears.map(value => (value as { domainRevision: number }).domainRevision)) } : {}),
    pendingLifecycleCount: run.pendingLifecycleProjections.size,
    ...(run.sessionName !== undefined ? { sessionName: run.sessionName } : {}), ...(run.lastActiveAt !== undefined ? { lastActiveAt: run.lastActiveAt } : {}),
    ...(run.sessionMeta ? { sessionMeta: run.sessionMeta } : {}), ...(latestCommit ? { latestCommit } : {}),
    ...(run.segments.length ? { latestSegment: { segmentId: run.segments.at(-1)!.segmentId, timestamp: run.segments.at(-1)!.timestamp } } : {}),
    ...(sessions.find(value => value.status === 'active') ? { activeAdvancementSessionId: sessions.find(value => value.status === 'active')!.id } : {}),
    ...(sessions.find(value => value.status === 'active' || value.status === 'awaiting-rubric-confirmation')
      ? { openAdvancementSessionId: sessions.find(value => value.status === 'active' || value.status === 'awaiting-rubric-confirmation')!.id } : {}),
    taskList: run.taskList };
  rows.set(conversationRunRootKey(id), encode(root));
  let sliceEnd = performance.now() + LARGE_SLICE_MS;
  for (let index = 0; index < extras.length; index++) {
    if (performance.now() >= sliceEnd) { await yieldEventLoop(); sliceEnd = performance.now() + LARGE_SLICE_MS; }
    const [name, key, value] = extras[index]!;
    rows.set(fieldKey(id, 'extra-' + name, key), { key, value: encode(value) } as unknown as JsonValue);
  }
  return rows;
}

/** 大批行的编码按时间片让出事件循环；写入有序表按条数分片。 */
const LARGE_SLICE_MS = 4;
const LARGE_SLICE_ROWS = 128;
function yieldEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/** 迁移期间读取源事实：锁外用日志的加锁读取，锁内用同一锁会话提供的读取。 */
export interface DecisionSourceReader {
  readStreamEnvelopes<Body = JsonValue>(streams: readonly string[], afterLsn: number, throughLsn: number, limit?: number): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[]; readonly checkpoints: readonly DurableLogCheckpoint[]; readonly lastLsn: number; readonly hasMore: boolean;
  }>;
  readEnvelopeAt<Body = JsonValue>(checkpoint: DurableLogCheckpoint): Promise<CommitEnvelope<Body>>;
}

/** 收编某会话的转移事实：续算时按位置并入，并先放入该转移在此前一刻的状态（属于转移分区，续算后移除）。 */
export interface DecisionTransferBinding {
  readonly checkpoint: DurableLogCheckpoint;
  readonly conversationId: string;
  readonly transferKey: string;
  readonly prior: JsonValue | null;
}

export function logDecisionSource(log: AuthorityCommitLog): DecisionSourceReader {
  if (!log.readStreamEnvelopes) throw new TypeError('Conversation migration requires stream reads');
  return { readStreamEnvelopes: (streams, after, through, limit) => log.readStreamEnvelopes!(streams, after, through, limit),
    readEnvelopeAt: checkpoint => log.readEnvelopeAt(checkpoint) };
}

/**
 * 长时间的内存计算定期让出事件循环：计时器（包括设备采样）照常运行，同时进行的操作不被饿住。
 * 提供 pace 时由它决定让出多久（后台迁移在前台活动期间等它安静）。
 */
function eventLoopYield(pace?: () => Promise<void>, sliceMs = 30): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await (pace ? pace() : new Promise<void>(resolve => setImmediate(resolve)));
    since = performance.now();
  };
}

async function* pages(reader: DecisionSourceReader, streams: readonly string[], after: number, until: number) {
  for (let at = after; at < until;) {
    const page = await reader.readStreamEnvelopes<unknown>(streams, at, until);
    for (let n = 0; n < page.commits.length; n++) yield { envelope: page.commits[n]!, checkpoint: page.checkpoints[n]! };
    if (!page.hasMore) return;
    at = page.lastLsn;
  }
}

/**
 * 一个会话的决定状态迁移：可信基点 → 只读扫描基点前事实（原文位置、推进待办） → 补齐存活派发的资源见证
 * → 对齐两份检查点 → 基点后事实在内存中用同一组生产归约完整校验续算，最后一次编码成行。start 在日志锁外
 * 完成主体；extend 在发布时于锁内用登记的行归约补齐此后的少量尾部（未迁移期间只有归属本会话预留的资源记录
 * 可能追加）。被收编的会话叠加导入基线的视图，全程用行归约续算。
 */
export class ConversationDecisionMigration {
  readonly canonical = new DecisionRows();
  readonly advancement = new DecisionRows();
  readonly cost = { prefixEnvelopes: 0, tailEnvelopes: 0, governorEnvelopes: 0, alignedEntries: 0, witnessFrames: 0, transferEnvelopes: 0 };
  #baseLsn = 0;
  #through = 0;
  readonly #owned = new Set<string>();
  readonly #stream: string;

  constructor(private readonly input: {
    readonly log: AuthorityCommitLog; readonly artifacts: ArtifactStore; readonly verifier: ProtocolSignatureVerifier;
    readonly conversationId: string; readonly origin: DurableLogCheckpoint;
    readonly transfers?: readonly DecisionTransferBinding[];
    /** 锁外长计算的让出点：至少让出事件循环；后台迁移借此在前台活动期间暂停。 */
    readonly pace?: () => Promise<void>;
  }) {
    this.#stream = 'run:' + input.conversationId;
    // 迁移中的视图就是该会话的已迁移状态：标记先行，归约取会话视图时不再要求迁移。
    const marker = [[decisionPartitionKey(input.conversationId), { conversationId: input.conversationId }]] as const;
    this.canonical.apply(marker); this.advancement.apply(marker);
  }

  get baseLsn(): number { return this.#baseLsn; }
  get through(): number { return this.#through; }

  #sourceAt(reader: DecisionSourceReader, checkpoint: DurableLogCheckpoint): DurableProjectionSource {
    return { checkpoint, originCheckpoint: this.input.origin, readEnvelopeAt: location => reader.readEnvelopeAt(location),
      readPreparedProjection: projectionId => {
        if (projectionId !== CONVERSATION_RUN_STATE_PROJECTION_ID) throw new TypeError('Unexpected migration dependency');
        return this.canonical;
      } };
  }

  /**
   * 迁移只持有本会话的状态：信封若还含其他会话的事实，归约会在空状态上写出那个会话的部分行。
   * 事务只追加自己会话的流，这种信封不应出现；出现即拒绝迁移该会话，不写出错误状态。
   */
  #assertIsolated(envelope: CommitEnvelope<unknown>): void {
    if (envelope.entries.some(entry => entry.stream.startsWith('run:') && entry.stream !== this.#stream)) {
      throw new TypeError('Conversation migration found an envelope shared with another conversation');
    }
  }

  async #applyAdvancement(reader: DecisionSourceReader, envelope: CommitEnvelope<unknown>, checkpoint: DurableLogCheckpoint): Promise<void> {
    this.#assertIsolated(envelope);
    // 推进待办目录未在本进程登记时不迁移它；之后登记时它从源头部起步，该会话再单独迁移。
    if (!advancementRecoveryRegistered(this.input.log)) return;
    const mutations = await verifyProtocolStep(() =>
      advancementRecoveryReducer(this.input.log)(envelope as CommitEnvelope<JsonValue>, this.advancement, this.#sourceAt(reader, checkpoint)));
    this.advancement.apply(mutations.map(m => [m.key, m.kind === 'put' ? m.value : undefined] as const));
  }

  async start(reader: DecisionSourceReader, through: number, options: { readonly trustedBase?: boolean; readonly maxBaseLsn?: number } = {}): Promise<void> {
    const { log, artifacts, verifier, conversationId: id } = this.input;
    const stream = this.#stream;
    // 被转移收编过的会话叠加导入基线的视图，没有旧会话检查点：按登记的行归约从起点逐事实续算。
    if ((this.input.transfers ?? []).some(value => value.conversationId === id)) {
      this.#through = 0;
      await this.extend(reader, through, { paced: true });
      return;
    }
    const base0 = options.trustedBase !== false ? await loadConversationTrustedBase(log, id, Math.min(options.maxBaseLsn ?? Infinity, through)) : undefined;
    const ledger = new WitnessLedger(id);
    const facts: PrefixFacts = { lastRunLsn: 0, admitted: new Map(), appended: new Map(), mirrors: new Map(), committed: new Map() };
    const assignedAt = new Map<string, number>();
    let run = base0?.run ?? emptyConversationRunProjection(id), guard = base0?.guard ?? emptySubmissionGuardProjection();
    const runFrom = base0?.runLsn ?? 0, guardFrom = base0?.guardLsn ?? 0;
    const pause = eventLoopYield(this.input.pace);
    this.#baseLsn = Math.max(runFrom, guardFrom);
    /** 一个信封：认领本会话派发的预留、记入资源见证、补齐原文位置、折叠推进待办，并推进尚未覆盖该位置的状态。 */
    const step = async (envelope: CommitEnvelope<unknown>, checkpoint: DurableLogCheckpoint): Promise<boolean> => {
      await pause();
      // 只逐条处理本会话的事实；同信封的其他会话事实（例如其派发与预留）不属于本会话，跳过。整信封折叠的推进待办另有隔离检查。
      for (const entry of envelope.entries) if (entry.stream === stream && (entry.body as { t?: string })?.t === 'assigned') ledger.owned.add((entry.body as { reservation: { reservationId: string } }).reservation.reservationId);
      for (const entry of envelope.entries) if (entry.stream === 'governor') await verifyProtocolStep(() => ledger.apply(entry, verifier));
      if (!envelope.entries.some(entry => entry.stream === stream)) return false;
      collectPrefixFacts(facts, stream, envelope, checkpoint, assignedAt);
      await this.#applyAdvancement(reader, envelope, checkpoint);
      for (const entry of envelope.entries) {
        if (entry.stream !== stream) continue;
        const contexts = conversationReductionContexts(log, id, envelope, root => ledger.witnesses.get(root) as ResourceWitness | undefined);
        if (envelope.lsn > runFrom) run = await verifyProtocolStep(() => reduceConversationRunState(contexts.run, run, entry, envelope));
        if (envelope.lsn > guardFrom) guard = await verifyProtocolStep(() => reduceConversationSubmissionGuard(contexts.guard, guard,
          entry as LogicalRecord<ConversationCommitLogRecord>, envelope as CommitEnvelope<ConversationCommitLogRecord>));
      }
      return true;
    };
    if (base0) {
      const lagging = Math.min(runFrom, guardFrom);
      // 只读扫描基点前的本会话事实：补齐原文位置、未投影提交，并折叠推进待办（这些事实已由检查点证明当时校验通过）。
      for await (const { envelope, checkpoint } of pages(reader, [stream], 0, lagging)) {
        await pause();
        this.#assertIsolated(envelope);
        this.cost.prefixEnvelopes++;
        collectPrefixFacts(facts, stream, envelope, checkpoint, assignedAt);
        await this.#applyAdvancement(reader, envelope, checkpoint);
      }
      // 较早那份检查点处仍存活的派发：从最早的派发位置起读一次资源记录，补齐其见证。
      const behindState = (runFrom < guardFrom ? run : guard) as SubmissionGuardProjection;
      let from: number | undefined;
      for (const [assignmentId, assigned] of behindState.assignedById) {
        if (!assignmentResourceLive(behindState, assignmentId, assigned.record.runId)) continue;
        const at = (assigned as { commit?: { lsn: number } }).commit?.lsn ?? assignedAt.get(assigned.record.reservation.reservationId);
        if (at === undefined) throw new TypeError('Live assignment has no source position');
        ledger.owned.add(assigned.record.reservation.reservationId);
        from = Math.min(from ?? at, at);
      }
      if (from !== undefined) for await (const { envelope } of pages(reader, ['governor'], from - 1, lagging)) {
        this.cost.witnessFrames++;
        for (const entry of envelope.entries) if (entry.stream === 'governor') await verifyProtocolStep(() => ledger.apply(entry, verifier));
      }
      // 两份检查点位置不同：较早的一份用同一归约完整校验推进到较晚的位置。
      for await (const { envelope, checkpoint } of pages(reader, [stream, 'governor'], lagging, this.#baseLsn)) {
        if (await step(envelope, checkpoint)) this.cost.alignedEntries++;
      }
    }
    // 基点之后（没有基点时从起点）用同一组生产归约在内存中逐事实完整校验，最后一次编码成行。资源记录只在
    // 本会话持有存活预留期间与它有关：持有时连同资源记录整页读取，不持有时只读本会话的流。
    let live = liveReservations(guard).size > 0;
    for (let at = this.#baseLsn; at < through;) {
      const combined = live;
      const page = await reader.readStreamEnvelopes<unknown>(combined ? [stream, 'governor'] : [stream], at, through);
      let next = page.lastLsn, restart = false;
      for (let n = 0; n < page.commits.length; n++) {
        const envelope = page.commits[n]!;
        if (!await step(envelope, page.checkpoints[n]!)) { this.cost.governorEnvelopes++; continue; }
        this.cost.tailEnvelopes++;
        live = liveReservations(guard).size > 0;
        // 只读本会话流时出现存活预留：其后的资源记录与本会话有关，从这里起连同资源记录重读。
        if (!combined && live) { next = envelope.lsn; restart = true; break; }
      }
      if (!restart && !page.hasMore) break;
      at = next;
    }
    const rows = await encodeConversationDecisionRows(id, run, guard, facts, artifacts);
    for (const [key, value] of ledger.rows(liveReservations(guard))) rows.set(key, value);
    // 分片写入：整批插入有序表随行数增长。
    const all = [...rows];
    for (let start = 0; start < all.length; start += LARGE_SLICE_ROWS) {
      if (start > 0) await yieldEventLoop();
      this.canonical.apply(all.slice(start, start + LARGE_SLICE_ROWS));
    }
    for (const root of liveReservations(guard)) this.#owned.add(root);
    this.#through = through;
  }

  /**
   * 用登记的行归约从当前位置完整校验续算：本会话事实、归属本会话预留的资源记录与收编本会话的转移事实。
   * 中途失败（含锁内操作被整体重跑）时回到续算前的状态，同一事实不会被折叠两次。
   * paced 只用于锁外的长续算：锁内补尾不得为等前台安静而占着日志锁。
   */
  async extend(reader: DecisionSourceReader, through: number, options: { readonly paced?: boolean } = {}): Promise<void> {
    if (through <= this.#through) return;
    const saved = { canonical: this.canonical.snapshot(), advancement: this.advancement.snapshot(), owned: [...this.#owned], cost: { ...this.cost } };
    try {
      await this.#extend(reader, through, options.paced ? eventLoopYield(this.input.pace) : undefined);
    } catch (error) {
      this.canonical.restore(saved.canonical);
      this.advancement.restore(saved.advancement);
      this.#owned.clear();
      for (const root of saved.owned) this.#owned.add(root);
      Object.assign(this.cost, saved.cost);
      throw error;
    }
  }

  async #extend(reader: DecisionSourceReader, through: number, pause: (() => Promise<void>) | undefined): Promise<void> {
    const stream = this.#stream, reduceCanonical = conversationRunStateReducer(this.input.log);
    const transfers = (this.input.transfers ?? []).filter(value => value.conversationId === this.input.conversationId &&
      value.checkpoint.lsn > this.#through && value.checkpoint.lsn <= through);
    const reduce = async (envelope: CommitEnvelope<unknown>, checkpoint: DurableLogCheckpoint) => {
      this.#assertIsolated(envelope);
      const mutations = await verifyProtocolStep(() => reduceCanonical(envelope as CommitEnvelope<JsonValue>, this.canonical, this.#sourceAt(reader, checkpoint)));
      this.canonical.apply(mutations.map(m => [m.key, m.kind === 'put' ? m.value : undefined] as const));
      await this.#applyAdvancement(reader, envelope, checkpoint);
    };
    const mergeTransfersBefore = async (lsn: number) => {
      while (transfers.length && transfers[0]!.checkpoint.lsn < lsn) {
        const binding = transfers.shift()!;
        this.cost.transferEnvelopes++;
        // 每个决定状态投影都在自己的视图里折叠转移事实：两者都先放入这一刻之前的转移状态。
        this.canonical.apply([[binding.transferKey, binding.prior ?? undefined]]);
        this.advancement.apply([[binding.transferKey, binding.prior ?? undefined]]);
        await reduce(await reader.readEnvelopeAt(binding.checkpoint), binding.checkpoint);
        // 转移状态归转移分区：本会话只保留收编得到的基线绑定。
        this.canonical.apply([[binding.transferKey, undefined]]);
        this.advancement.apply([[binding.transferKey, undefined]]);
      }
    };
    const apply = async (envelope: CommitEnvelope<unknown>, checkpoint: DurableLogCheckpoint) => {
      await mergeTransfersBefore(envelope.lsn);
      for (const entry of envelope.entries) if (entry.stream === stream && (entry.body as { t?: string })?.t === 'assigned') this.#owned.add((entry.body as { reservation: { reservationId: string } }).reservation.reservationId);
      const mine = envelope.entries.some(entry => entry.stream === stream || entry.stream === 'governor' && this.#owned.has(governorRoot(entry.body)));
      if (!mine) return;
      this.cost.tailEnvelopes++;
      await reduce(envelope, checkpoint);
      // 预留结束时归约随即删除其见证：此后它的资源记录与本会话无关。
      for (const root of this.#owned) if (!this.canonical.has(conversationResourceWitnessKey(root))) this.#owned.delete(root);
    };
    // 资源记录只在本会话持有存活预留期间与它有关：持有时按“本会话流＋资源记录”整页读取，不持有时只读
    // 本会话的流。只在页边界或出现新派发时切换，读取次数与整段读取同一量级。
    let at = this.#through;
    while (at < through) {
      const combined = this.#owned.size > 0;
      const page = await reader.readStreamEnvelopes<unknown>(combined ? [stream, 'governor'] : [stream], at, through);
      let next = page.lastLsn, restart = false;
      for (let n = 0; n < page.commits.length; n++) {
        await pause?.();
        const envelope = page.commits[n]!;
        if (!envelope.entries.some(entry => entry.stream === stream)) this.cost.governorEnvelopes++;
        await apply(envelope, page.checkpoints[n]!);
        // 只读本会话流时出现新派发：其后的资源记录与本会话有关，从这里起连同资源记录重读。
        if (!combined && this.#owned.size) { next = envelope.lsn; restart = true; break; }
      }
      if (!restart && !page.hasMore) break;
      at = next;
    }
    await mergeTransfersBefore(Infinity);
    this.#through = through;
  }
}

/** 对照校验与一次性迁移：在 through（含）处得到该会话的决定状态。 */
export async function migrateConversationDecisionState(input: {
  log: AuthorityCommitLog; artifacts: ArtifactStore; verifier: ProtocolSignatureVerifier; conversationId: string;
  through: number; origin: DurableLogCheckpoint; transfers?: readonly DecisionTransferBinding[];
  /** 对照校验用：false 时不取可信基点，从日志起点完整校验。 */
  readonly trustedBase?: boolean;
  /** 对照校验用：只取不晚于该位置的可信基点。 */
  readonly maxBaseLsn?: number;
}): Promise<ConversationDecisionMigration> {
  const migration = new ConversationDecisionMigration(input);
  await migration.start(logDecisionSource(input.log), input.through, { ...(input.trustedBase === false ? { trustedBase: false } : {}),
    ...(input.maxBaseLsn !== undefined ? { maxBaseLsn: input.maxBaseLsn } : {}) });
  return migration;
}

function governorRoot(body: unknown): string {
  const value = body as { t?: string; lease?: { reservationId?: string }; rootReservationId?: string };
  return (value.t === 'reserve' ? value.lease?.reservationId : value.rootReservationId) ?? '';
}

function collectPrefixFacts(facts: PrefixFacts, stream: string, envelope: CommitEnvelope<unknown>, checkpoint: DurableLogCheckpoint, assignedAt: Map<string, number>): void {
  envelope.entries.forEach((entry, item) => {
    if (entry.stream !== stream) return;
    const body = entry.body as Record<string, any>;
    facts.lastRunLsn = envelope.lsn;
    const source = { checkpoint, item };
    if (body.t === 'admitted') facts.admitted.set(body.runId, inputRow(body, envelope.lsn, source));
    else if (body.t === 'run-input-appended') facts.appended.set(body.ingressKey, { ...inputRow(body, envelope.lsn, source), runId: body.runId, position: body.position });
    else if (body.t === 'interaction-mirror') facts.mirrors.set(interactionMirrorBatchDigest(body.batch), source);
    else if (body.t === 'committed') facts.committed.set(body.assignmentId, envelope);
    else if (body.t === 'assigned') assignedAt.set(body.reservation.reservationId, envelope.lsn);
  });
}
