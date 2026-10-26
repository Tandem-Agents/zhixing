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
    const after = advanceIndexedAssignment(before, assignmentId, records, verifier);
    mutations.push({ kind: "put", key: stateKey(assignmentId), value: encodeIndexedAssignment(after) });
    const isCandidate = isRecoveryCandidate(after);
    if (isCandidate && !wasCandidate) mutations.push({ kind: "put", key: candidateKey(assignmentId), value: { assignmentId } });
    if (!isCandidate && wasCandidate) mutations.push({ kind: "tombstone", key: candidateKey(assignmentId) });
  }
  return mutations;
}

function advanceIndexedAssignment(
  before: IndexedAssignment | undefined,
  assignmentId: string,
  records: readonly LogicalRecord<unknown>[],
  verifier: ProtocolSignatureVerifier,
): IndexedAssignment {
  if (before?.kind === "corrupt") return before;
  try {
    const state = before?.state ?? createAssignmentLedgerValidationState(assignmentId);
    for (const record of records) applyValidatedAssignmentEntry(state, validateAssignmentEntry(record.body, verifier));
    return { kind: "valid", state };
  } catch (error) {
    // 身份尚未装入属于需要重做，不是记录损坏
    rethrowUnloadedProtocolIdentity(error);
    return { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) };
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
