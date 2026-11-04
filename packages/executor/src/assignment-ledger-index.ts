import { createHash } from "node:crypto";
import {
  AuthorityStorageError,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
} from "@zhixing/core/authority";
import type { CommitEnvelope, JsonValue, LogicalRecord } from "@zhixing/core/contracts";
import {
  applyValidatedAssignmentEntry,
  createAssignmentLedgerValidationState,
  rethrowUnloadedProtocolIdentity,
  validateAssignmentEntry,
  type AssignmentLedgerValidationState,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";

/**
 * 派发账本的领域索引。每个派发按键各存两样东西：
 * - 触及它的提交信封（原样）：冷实例上由账本用同一份归约重放，只读这个派发自己的行，
 *   不再按流从日志起点扫描；
 * - 按共享校验状态机推进的校验状态：据此判断它是否仍是对话恢复的候选。
 * 候选目录只收仍可能被启动恢复选中的对话派发，恢复只遍历这个目录，再按原条件逐个核对。
 * 记录校验不过的派发标为损坏并留在目录里，由账本重放报出原错误，其余派发不受影响。
 */
export const ASSIGNMENT_LEDGER_INDEX_ID = "executor-assignment-ledger-v1";

const ASSIGNMENT_LEDGER_INDEX_VERSION = 2;
const ENVELOPE_PREFIX = "e/";
const STATE_PREFIX = "s/";
const CANDIDATE_PREFIX = "o/";
const PHASE_PREFIX = "p/";
const HISTORY_PREFIX = "h/";
const READ_PAGE = 256;

/**
 * 与 assignment 日志共用同一提交日志、同享 `assignment:` 前缀,但由各自
 * reducer 拥有的子流。assignmentId 自身含冒号,无法按分段区分,只能按子流
 * 后缀排除;新增子流若漏登记,枚举与派生索引会以校验失败 fail-closed。
 */
const ASSIGNMENT_SUB_STREAM_SUFFIXES = [":data-plane-tickets"] as const;

/** 只认本 ledger 自己写入的 assignment 流,子流一律让位给其所有者。 */
export function assignmentIdFromStream(stream: string): string | undefined {
  if (!stream.startsWith("assignment:")) return undefined;
  for (const suffix of ASSIGNMENT_SUB_STREAM_SUFFIXES) {
    if (stream.endsWith(suffix)) return undefined;
  }
  return stream.slice("assignment:".length) || undefined;
}

type IndexedAssignment =
  | { readonly kind: "valid"; readonly state: AssignmentLedgerValidationState }
  | { readonly kind: "corrupt"; readonly reason: string };

const subject = (assignmentId: string) => createHash("sha256").update(assignmentId, "utf8").digest("hex").slice(0, 32);
const envelopePrefix = (assignmentId: string) => `${ENVELOPE_PREFIX}${subject(assignmentId)}/`;
const envelopeKey = (assignmentId: string, lsn: number) => `${envelopePrefix(assignmentId)}${String(lsn).padStart(16, "0")}`;
const stateKey = (assignmentId: string) => `${STATE_PREFIX}${subject(assignmentId)}`;
const candidateKey = (assignmentId: string) => `${CANDIDATE_PREFIX}${subject(assignmentId)}`;
const phaseKey = (assignmentId: string) => `${PHASE_PREFIX}${subject(assignmentId)}`;
// 已完成历史按键：标记行表示该分派自第一条记录起的按键行都由本格式写下；请求 ID 取摘要定长
const historyMarkerKey = (assignmentId: string) => `${HISTORY_PREFIX}${subject(assignmentId)}`;
const historyKey = (assignmentId: string, kind: "q" | "f" | "o" | "x" | "y", part: string) =>
  `${HISTORY_PREFIX}${subject(assignmentId)}/${kind}/${part}`;
const seqPart = (seq: number) => String(seq).padStart(16, "0");

export function registerAssignmentLedgerIndex(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier) {
  return log.durableProjection({
    projectionId: ASSIGNMENT_LEDGER_INDEX_ID,
    reducerVersion: ASSIGNMENT_LEDGER_INDEX_VERSION,
    authenticated: true,
    inputs: { families: ["assignment:"] },
    reduce: (envelope, current) => reduceAssignmentLedgerIndex(envelope as CommitEnvelope<unknown>, current, verifier),
  });
}

async function reduceAssignmentLedgerIndex(
  envelope: CommitEnvelope<unknown>,
  current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier,
): Promise<readonly DurableProjectionMutation[]> {
  const touched = new Map<string, LogicalRecord<unknown>[]>();
  for (const record of envelope.entries) {
    const assignmentId = assignmentIdFromStream(record.stream);
    if (!assignmentId) continue;
    const records = touched.get(assignmentId) ?? [];
    records.push(record);
    touched.set(assignmentId, records);
  }
  const mutations: DurableProjectionMutation[] = [];
  for (const [assignmentId, records] of touched) {
    // 原样保存整封信封：账本归约要核对同一提交里的调控与时钟伴随记录
    mutations.push({ kind: "put", key: envelopeKey(assignmentId, envelope.lsn), value: envelope as unknown as JsonValue });
    const before = await readIndexedAssignment(current, assignmentId);
    // 推进会原地改写已装入的状态：先判定推进前是否为候选
    const wasCandidate = before !== undefined && isRecoveryCandidate(before);
    const { indexed: after, history } = advanceIndexedAssignment(before, assignmentId, records, verifier, envelope.at);
    mutations.push({ kind: "put", key: stateKey(assignmentId), value: encodeIndexedAssignment(after) });
    if (before === undefined) mutations.push({ kind: "put", key: historyMarkerKey(assignmentId), value: { v: 1 } });
    mutations.push(...history);
    // 小的阶段行：不必解码整份校验状态就能判断一个分派是否已开始、是否已接收（例如资源回执核对先据此排除）
    mutations.push({ kind: "put", key: phaseKey(assignmentId), value: after.kind === "valid"
      ? { phase: after.state.phase, started: after.state.started, received: after.state.received } : { corrupt: true } });
    const isCandidate = isRecoveryCandidate(after);
    // 候选行随每次提交更新分类与派发信封引用：启动恢复的列表据此排除确定不属于本类的候选，命中的直接按引用
    // 读取信封，不必为它们读整份状态或重放。引用来自本提交里已通过校验的 received 记录，之后的提交沿用上一行
    if (isCandidate) {
      const received = after.kind === "valid"
        ? records.map(record => (record.body as { body?: { t?: unknown; envelope?: { ref?: unknown } } } | null)?.body)
          .find(body => body?.t === "received")?.envelope?.ref
        : undefined;
      const previous = received === undefined
        ? (await current.get(candidateKey(assignmentId)) as { readonly envelopeRef?: JsonValue } | undefined)?.envelopeRef
        : undefined;
      const envelopeRef = (received as JsonValue | undefined) ?? previous;
      mutations.push({ kind: "put", key: candidateKey(assignmentId), value: candidateRow(assignmentId, after, envelopeRef) });
    }
    if (!isCandidate && wasCandidate) mutations.push({ kind: "tombstone", key: candidateKey(assignmentId) });
  }
  return mutations;
}

function advanceIndexedAssignment(
  before: IndexedAssignment | undefined,
  assignmentId: string,
  records: readonly LogicalRecord<unknown>[],
  verifier: ProtocolSignatureVerifier,
  at: string,
): { readonly indexed: IndexedAssignment; readonly history: readonly DurableProjectionMutation[] } {
  if (before?.kind === "corrupt") return { indexed: before, history: [] };
  try {
    const state = before?.state ?? createAssignmentLedgerValidationState(assignmentId);
    const history: DurableProjectionMutation[] = [];
    for (const record of records) {
      const entry = validateAssignmentEntry(record.body, verifier);
      applyValidatedAssignmentEntry(state, entry);
      history.push(...historyRows(assignmentId, entry, state, at));
    }
    // 整封信封都校验通过才写按键行：损坏的分派由账本重放报错，不留半截历史
    return { indexed: { kind: "valid", state }, history };
  } catch (error) {
    // 身份尚未装入属于需要重做，不是记录损坏
    rethrowUnloadedProtocolIdentity(error);
    return { indexed: { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) }, history: [] };
  }
}

/**
 * 一条已校验记录的按键历史行。每个键只在首次使用时写下（协议保证请求 ID、副作用序号与记录序号不重复），
 * 值带记录序号：账本只采用序号不超过其决定状态位置的键，比当前记录更晚的写入不会被当成先前已用。
 * 镜像链项的序号与摘要取自本条记录归约后的校验状态；交互结果与沉淀都是 v1 记录，时间即提交时间。
 */
function historyRows(
  assignmentId: string,
  entry: ReturnType<typeof validateAssignmentEntry>,
  state: AssignmentLedgerValidationState,
  at: string,
): DurableProjectionMutation[] {
  const seq = entry.recordSeq;
  const body = entry.body as unknown as JsonValue & { readonly t: string; readonly requestId?: string; readonly effectSeq?: number };
  switch (body.t) {
    case "interaction-requested":
      return [{ kind: "put", key: historyKey(assignmentId, "q", subject(body.requestId!)), value: { seq, body } }];
    case "interaction-finished":
    case "trust-sediment": {
      const checkpoint = state.unmirroredFinished.get(seq);
      if (!checkpoint) return [];
      const item = { body, recordSeq: seq, at, ordinal: checkpoint.ordinal, mirrorDigest: checkpoint.mirrorDigest };
      return [
        { kind: "put", key: historyKey(assignmentId, "o", seqPart(seq)), value: item },
        ...(body.t === "interaction-finished"
          ? [{ kind: "put" as const, key: historyKey(assignmentId, "f", subject(body.requestId!)), value: { seq } }]
          : []),
      ];
    }
    case "side-effect-started":
      return [{ kind: "put", key: historyKey(assignmentId, "x", seqPart(body.effectSeq!)), value: { seq, body } }];
    case "side-effect-completed":
      return [{ kind: "put", key: historyKey(assignmentId, "y", seqPart(body.effectSeq!)), value: { seq, body } }];
    default:
      return [];
  }
}

/**
 * 与账本的三个对话恢复查询同一口径（已封存；已接收且未取消；带票据取消、owner 尚未耐久处理
 * 取消证明且仍在接收、运行或已停止），取它们的并集。作业派发由作业恢复索引承担，不进这里。
 */
function isRecoveryCandidate(indexed: IndexedAssignment): boolean {
  if (indexed.kind === "corrupt") return true;
  const { state } = indexed;
  if (state.ref?.execution === "job") return false;
  const ticketAbort = !state.cancelProofOwnerAccepted && [...state.aborts.values()].some(abort => abort.via === "abort-ticket");
  switch (state.phase) {
    case "sealed": return true;
    case "received": return state.aborts.size === 0 || ticketAbort;
    case "started":
    case "halted": return ticketAbort;
    default: return false;
  }
}

/** 一个派发触及过的全部信封，按日志位置排序；行不完整时按索引损坏拒绝。 */
export async function readAssignmentEnvelopes(
  view: DurableProjectionReadContext,
  assignmentId: string,
): Promise<readonly CommitEnvelope<unknown>[]> {
  const prefix = envelopePrefix(assignmentId);
  const envelopes: CommitEnvelope<unknown>[] = [];
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: prefix, lt: `${prefix}￿` }, READ_PAGE, continuation);
    for (const entry of page.entries) envelopes.push(storedEnvelope(entry.value, assignmentId));
    continuation = page.continuation;
  } while (continuation);
  return envelopes;
}

/** 该派发在 lsn 之后的信封（按 LSN 升序）：从它自己的定长 LSN 键处起扫，读取量只随这段增量，不随历史。 */
export async function readAssignmentEnvelopesAfter(
  view: DurableProjectionReadContext,
  assignmentId: string,
  lsn: number,
): Promise<readonly CommitEnvelope<unknown>[]> {
  const prefix = envelopePrefix(assignmentId);
  const envelopes: CommitEnvelope<unknown>[] = [];
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: `${prefix}${String(lsn + 1).padStart(16, "0")}`, lt: `${prefix}￿` }, READ_PAGE, continuation);
    for (const entry of page.entries) envelopes.push(storedEnvelope(entry.value, assignmentId));
    continuation = page.continuation;
  } while (continuation);
  return envelopes;
}

/** 该派发在 lsn 之后有没有新信封：从它自己的定长 LSN 键处起扫一条，不碰别的派发与无关记录。 */
export async function assignmentChangedAfter(view: DurableProjectionReadContext, assignmentId: string, lsn: number): Promise<boolean> {
  const prefix = envelopePrefix(assignmentId);
  const page = await view.scan({ gte: `${prefix}${String(lsn + 1).padStart(16, "0")}`, lt: `${prefix}￿` }, 1);
  if (page.continuation) view.releaseContinuation?.(page.continuation);
  return page.entries.length > 0;
}

/** 该分派的历史是否全部按键可取：本格式之前创建的分派没有标记行，账本照旧在决定状态里保存完整集合。 */
export async function hasAssignmentHistoryKeys(view: DurableProjectionReadContext, assignmentId: string): Promise<boolean> {
  return (await view.get(historyMarkerKey(assignmentId))) !== undefined;
}

export interface AssignmentHistoryNeeds {
  readonly requests?: readonly string[];
  readonly effects?: readonly number[];
  readonly mirrorSeqs?: readonly number[];
}

export interface AssignmentHistoryRows {
  /** 请求 ID → 请求记录，及其结果的镜像链项（已有结果时） */
  readonly requests: ReadonlyMap<string, { readonly seq: number; readonly body: JsonValue; readonly finished?: JsonValue }>;
  readonly effects: ReadonlyMap<number, { readonly started: JsonValue; readonly completed?: JsonValue }>;
  readonly mirror: ReadonlyMap<number, JsonValue>;
}

/**
 * 按键取该分派序号不超过 upToSeq 的已完成历史：每项只读自己的小行，读取量随所需键数而不随历史。
 * 行的形态与键不符按索引损坏拒绝；超过 upToSeq 的行属于更晚的记录，不当作先前已有。
 */
export async function readAssignmentHistory(
  view: DurableProjectionReadContext,
  assignmentId: string,
  needs: AssignmentHistoryNeeds,
  upToSeq: number,
): Promise<AssignmentHistoryRows> {
  const row = async (key: string) => {
    const value = await view.get(key) as { readonly seq?: unknown; readonly recordSeq?: unknown; readonly body?: { readonly t?: unknown } } | undefined;
    if (value === undefined) return undefined;
    const seq = value.seq ?? value.recordSeq;
    if (!Number.isSafeInteger(seq) || (seq as number) <= 0) throw corruptIndex("Assignment history row is invalid");
    return (seq as number) <= upToSeq ? { seq: seq as number, value } : undefined;
  };
  const mirrorItem = async (seq: number) => {
    const found = await row(historyKey(assignmentId, "o", seqPart(seq)));
    if (found && (found.seq !== seq || (found.value.body?.t !== "interaction-finished" && found.value.body?.t !== "trust-sediment"))) {
      throw corruptIndex("Assignment history mirror row is invalid");
    }
    return found?.value as JsonValue | undefined;
  };
  const requests = new Map<string, { seq: number; body: JsonValue; finished?: JsonValue }>();
  for (const requestId of needs.requests ?? []) {
    const requested = await row(historyKey(assignmentId, "q", subject(requestId)));
    if (!requested) continue;
    const body = requested.value.body as { readonly t?: unknown; readonly requestId?: unknown } | undefined;
    if (body?.t !== "interaction-requested" || body.requestId !== requestId) throw corruptIndex("Assignment history request row is invalid");
    const finishedAt = await row(historyKey(assignmentId, "f", subject(requestId)));
    const finished = finishedAt ? await mirrorItem(finishedAt.seq) : undefined;
    if (finishedAt && (finished as { body?: { requestId?: unknown } } | undefined)?.body?.requestId !== requestId) {
      throw corruptIndex("Assignment history result row is invalid");
    }
    requests.set(requestId, { seq: requested.seq, body: body as JsonValue, ...(finished ? { finished } : {}) });
  }
  const effects = new Map<number, { started: JsonValue; completed?: JsonValue }>();
  for (const effectSeq of needs.effects ?? []) {
    const started = await row(historyKey(assignmentId, "x", seqPart(effectSeq)));
    if (!started) continue;
    const completed = await row(historyKey(assignmentId, "y", seqPart(effectSeq)));
    const startBody = started.value.body as { readonly t?: unknown; readonly effectSeq?: unknown } | undefined;
    const endBody = completed?.value.body as { readonly t?: unknown; readonly effectSeq?: unknown } | undefined;
    if (startBody?.t !== "side-effect-started" || startBody.effectSeq !== effectSeq ||
        (completed && (endBody?.t !== "side-effect-completed" || endBody.effectSeq !== effectSeq))) {
      throw corruptIndex("Assignment history side-effect row is invalid");
    }
    effects.set(effectSeq, { started: startBody as JsonValue, ...(endBody ? { completed: endBody as JsonValue } : {}) });
  }
  const mirror = new Map<number, JsonValue>();
  for (const seq of needs.mirrorSeqs ?? []) {
    const item = await mirrorItem(seq);
    if (item !== undefined) mirror.set(seq, item);
  }
  return { requests, effects, mirror };
}

/**
 * 候选的恢复分类：与校验状态在同一提交中更新的阶段、取消请求数，以及是否有尚待 owner 接受取消证明的票据取消。
 * 校验不过的候选标为 corrupt；分类缺失（本格式之前写下的行）或 corrupt 时，调用方一律按原路径完整核对。
 */
export interface RecoveryCandidateClass {
  readonly phase: AssignmentLedgerValidationState["phase"];
  readonly aborts: number;
  readonly ticketAbortPending: boolean;
}

function candidateRow(assignmentId: string, indexed: IndexedAssignment, envelopeRef?: JsonValue): JsonValue {
  if (indexed.kind === "corrupt") return { assignmentId, corrupt: true };
  const { state } = indexed;
  return { assignmentId, phase: state.phase, aborts: state.aborts.size,
    ticketAbortPending: !state.cancelProofOwnerAccepted && [...state.aborts.values()].some(abort => abort.via === "abort-ticket"),
    ...(envelopeRef !== undefined && state.received ? { envelopeRef } : {}) };
}

/** 对话恢复候选目录：每个候选的派发 id 与它的恢复分类（没有可信分类时为 undefined）。只读小行，不解码整份状态。 */
export async function readRecoveryCandidateClasses(
  view: DurableProjectionReadContext,
): Promise<readonly { readonly assignmentId: string; readonly classification?: RecoveryCandidateClass; readonly envelopeRef?: JsonValue }[]> {
  const rows: { assignmentId: string; classification?: RecoveryCandidateClass; envelopeRef?: JsonValue }[] = [];
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: CANDIDATE_PREFIX, lt: `${CANDIDATE_PREFIX}￿` }, READ_PAGE, continuation);
    for (const entry of page.entries) {
      const row = entry.value as { readonly assignmentId?: unknown; readonly phase?: unknown; readonly aborts?: unknown;
        readonly ticketAbortPending?: unknown; readonly corrupt?: unknown; readonly envelopeRef?: JsonValue } | null;
      const assignmentId = row?.assignmentId;
      if (typeof assignmentId !== "string" || entry.key !== candidateKey(assignmentId)) {
        throw corruptIndex("Assignment recovery candidate is invalid");
      }
      const classified = row?.corrupt !== true && typeof row?.phase === "string" && Number.isSafeInteger(row.aborts) &&
        typeof row.ticketAbortPending === "boolean";
      if (classified) {
        rows.push({ assignmentId, classification: { phase: row!.phase as RecoveryCandidateClass["phase"], aborts: row!.aborts as number,
          ticketAbortPending: row!.ticketAbortPending as boolean }, ...(row!.envelopeRef !== undefined ? { envelopeRef: row!.envelopeRef } : {}) });
      } else if (row?.corrupt === true) {
        rows.push({ assignmentId });
      } else {
        // 本格式之前写下的候选行没有分类：从同一读视图里该分派的校验状态行推出，不重建索引、不重放；
        // 状态行缺失或损坏时不给分类，由调用方按原路径完整核对
        const indexed = await readIndexedAssignment(view, assignmentId).catch(() => undefined);
        const legacy = indexed?.kind === "valid" ? candidateRow(assignmentId, indexed) as { phase: RecoveryCandidateClass["phase"]; aborts: number; ticketAbortPending: boolean } : undefined;
        rows.push(legacy ? { assignmentId, classification: { phase: legacy.phase, aborts: legacy.aborts, ticketAbortPending: legacy.ticketAbortPending } } : { assignmentId });
      }
    }
    continuation = page.continuation;
  } while (continuation);
  return rows;
}

/**
 * 若干分派的小阶段行（是否已开始、是否已接收）。没有这一行（本格式之前写下、此后未再提交）或标为 corrupt 的
 * 分派不给结果，调用方按原路径完整核对。
 */
export async function readAssignmentPhases(
  view: DurableProjectionReadContext,
  assignmentIds: readonly string[],
): Promise<ReadonlyMap<string, { readonly phase: AssignmentLedgerValidationState["phase"]; readonly started: boolean; readonly received: boolean }>> {
  const phases = new Map<string, { readonly phase: AssignmentLedgerValidationState["phase"]; readonly started: boolean; readonly received: boolean }>();
  for (const assignmentId of assignmentIds) {
    const row = await view.get(phaseKey(assignmentId)) as { phase?: unknown; started?: unknown; received?: unknown } | undefined;
    if (row && typeof row.phase === "string" && typeof row.started === "boolean" && typeof row.received === "boolean") {
      phases.set(assignmentId, { phase: row.phase as AssignmentLedgerValidationState["phase"], started: row.started, received: row.received });
    }
  }
  return phases;
}

/** 对话恢复候选目录里的派发 id。 */
export async function readRecoveryCandidates(view: DurableProjectionReadContext): Promise<readonly string[]> {
  const assignmentIds: string[] = [];
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: CANDIDATE_PREFIX, lt: `${CANDIDATE_PREFIX}￿` }, READ_PAGE, continuation);
    for (const entry of page.entries) {
      const assignmentId = (entry.value as { readonly assignmentId?: unknown } | null)?.assignmentId;
      if (typeof assignmentId !== "string" || entry.key !== candidateKey(assignmentId)) {
        throw corruptIndex("Assignment recovery candidate is invalid");
      }
      assignmentIds.push(assignmentId);
    }
    continuation = page.continuation;
  } while (continuation);
  return assignmentIds;
}

function storedEnvelope(value: JsonValue, assignmentId: string): CommitEnvelope<unknown> {
  const envelope = value as unknown as CommitEnvelope<unknown> | null;
  const stream = `assignment:${assignmentId}`;
  if (!envelope || typeof envelope !== "object" || !Number.isSafeInteger(envelope.lsn) || typeof envelope.at !== "string" ||
      !Array.isArray(envelope.entries) || !envelope.entries.some(record => record?.stream === stream)) {
    throw corruptIndex("Assignment envelope row is invalid");
  }
  return envelope;
}

async function readIndexedAssignment(
  current: DurableProjectionReadContext,
  assignmentId: string,
): Promise<IndexedAssignment | undefined> {
  const stored = await current.get(stateKey(assignmentId)) as { readonly state?: JsonValue; readonly corrupt?: unknown } | undefined;
  if (stored === undefined) return undefined;
  if (typeof stored.corrupt === "string") return { kind: "corrupt", reason: stored.corrupt };
  const state = stored.state === undefined ? undefined : decodeValue(stored.state) as AssignmentLedgerValidationState | undefined;
  if (!state || typeof state !== "object" || state.assignmentId !== assignmentId) {
    throw corruptIndex("Assignment validation state row is invalid");
  }
  return { kind: "valid", state };
}

function encodeIndexedAssignment(indexed: IndexedAssignment): JsonValue {
  return indexed.kind === "corrupt" ? { corrupt: indexed.reason } : { state: encodeValue(indexed.state) };
}

// 复合值逐层带标签编码，记录里的对象不会被误认成状态里的 Set/Map。
function encodeValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Set) return { t: "set", v: [...value].map(encodeValue) };
  if (value instanceof Map) return { t: "map", v: [...value].map(([key, item]) => [encodeValue(key), encodeValue(item)]) };
  if (Array.isArray(value)) return { t: "array", v: value.map(encodeValue) };
  if (typeof value === "object") {
    return { t: "object", v: Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, encodeValue(item)])) };
  }
  throw new TypeError("Assignment validation state is not encodable");
}

function decodeValue(value: JsonValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) throw corruptIndex("Assignment validation state encoding is invalid");
  const payload = value.v;
  if (value.t === "object" && payload && typeof payload === "object" && !Array.isArray(payload)) {
    return Object.fromEntries(Object.entries(payload).map(([key, item]) => [key, decodeValue(item)]));
  }
  if (!Array.isArray(payload)) throw corruptIndex("Assignment validation state encoding is invalid");
  if (value.t === "set") return new Set(payload.map(decodeValue));
  if (value.t === "array") return payload.map(decodeValue);
  if (value.t === "map") {
    return new Map(payload.map((item) => {
      if (!Array.isArray(item) || item.length !== 2) throw corruptIndex("Assignment validation state encoding is invalid");
      return [decodeValue(item[0]!), decodeValue(item[1]!)];
    }));
  }
  throw corruptIndex("Assignment validation state encoding is invalid");
}

function corruptIndex(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}
