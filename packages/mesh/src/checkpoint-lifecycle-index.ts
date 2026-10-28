import type { CheckpointStreamRecord, JsonValue, RecoveryCheckpointGeneration } from "@zhixing/core/contracts";
import {
  DurableProjectionRecordBindingError, createDurableProjectionOverlay,
  type AuthorityCommitLog, type DurableProjectionReadContext, type DurableProjectionMutation,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";

/**
 * checkpoint 生命周期的按键投影：替代每次从 LSN 0 按流重放 checkpoint 记录。
 * - f/：全部事实按记录键存放，精确查找与追加去重；同键不同内容即为冲突。
 * - 另有几组只存“当前未完成项”的小索引（当前已验证、待复制、待清理、各代际最新已复制、
 *   各目标最新根激活与尚未验证的根激活），读取只扫这些小前缀，不随已完成的备份历史增长。
 */
export const CHECKPOINT_LIFECYCLE_PROJECTION_ID = "checkpoint-lifecycle-v1";
const STREAM = "checkpoint";
type Created = Extract<CheckpointStreamRecord, { t: "checkpoint-created" }>;
type Verified = Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }>;
type Replicated = Extract<CheckpointStreamRecord, { t: "checkpoint-replicated" }>;
type Superseded = Extract<CheckpointStreamRecord, { t: "checkpoint-superseded" }>;

function invalid(): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError("Checkpoint lifecycle index binding is invalid");
}
/** 与原生命周期重放同一口径的记录键；cleanup 的本地释放阶段不留事实。 */
export function checkpointRecordKey(record: CheckpointStreamRecord): string {
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
// 按持久化的 JSON 语义取摘要：调用方传入的代际可能带值为 undefined 的可选字段（记录里不会出现）
const digest = (domain: string, value: unknown): string =>
  protocolDigest(`CheckpointLifecycle${domain}`, 1, JSON.parse(JSON.stringify(value)) as JsonValue);
const factKey = (recordKey: string): string => "f/" + digest("Fact", recordKey);
/** 源位置（LSN, 条目序号）的定长串：字典序即先后；信封里的条目数不设上限。 */
const position = (lsn: number, ordinal: number): string => `${lsn.toString().padStart(16, "0")}.${ordinal.toString().padStart(10, "0")}`;
const POSITION = /^\d{16}\.\d{10}$/u;
/** 倒序位置：两段各自取反，正向扫描时较新的记录排在前面。 */
const inverse = (pos: string): string => {
  const [lsn, ordinal] = pos.split(".").map(Number) as [number, number];
  return `${(Number.MAX_SAFE_INTEGER - lsn).toString().padStart(16, "0")}.${(9_999_999_999 - ordinal).toString().padStart(10, "0")}`;
};
const pair = (checkpointId: string, targetId: string): string => digest("Pair", [checkpointId, targetId]);
const verifiedPrefix = (recipientKeyId: string): string => `v/${digest("Recipient", recipientKeyId)}/`;
const verifiedOf = (checkpointId: string, targetId: string): string => `vk/${pair(checkpointId, targetId)}`;
const verifiedByCheckpoint = (checkpointId: string): string => `vc/${digest("Checkpoint", checkpointId)}/`;
const pendingReplication = (checkpointId: string, targetId: string): string => `pr/${pair(checkpointId, targetId)}`;
const generationKey = (generation: Pick<RecoveryCheckpointGeneration, "rootKeyId" | "recipientKeyId" | "trustChainHead">): string =>
  `rc/${digest("Generation", { rootKeyId: generation.rootKeyId, recipientKeyId: generation.recipientKeyId, trustChainHead: generation.trustChainHead })}`;
const generationLatestKey = (generation: RecoveryCheckpointGeneration): string => `gl/${digest("FullGeneration", generation)}`;
const createdForKey = (generation: RecoveryCheckpointGeneration, request: unknown): string => `cq/${digest("Request", [generation, request])}`;
const cleanupPrefix = "cl/";
const rootActivationLatest = (targetId: string): string => `ra/${digest("Target", targetId)}`;
const rootActivationOpenPrefix = (targetId: string): string => `rao/${digest("Target", targetId)}/`;

interface Sequenced<T> { readonly pos: string; readonly record: T }
function sequenced<T extends CheckpointStreamRecord>(value: JsonValue | undefined, t: T["t"]): Sequenced<T> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.pos !== "string" || !POSITION.test(value.pos) ||
      !value.record || typeof value.record !== "object" || Array.isArray(value.record) || (value.record as { t?: unknown }).t !== t) throw invalid();
  return value as unknown as Sequenced<T>;
}

/** 登记投影（重复登记同一定义幂等）：home 权威入口在首次写入前登记，其他打开权威日志的入口读取前也登记。 */
export function registerCheckpointLifecycleIndex(log: AuthorityCommitLog): void {
  log.durableProjection<CheckpointStreamRecord>({
    projectionId: CHECKPOINT_LIFECYCLE_PROJECTION_ID, reducerVersion: 2, authenticated: true, inputs: { streams: [STREAM] },
    reduce: async (envelope, current) => {
      const changes = new Map<string, JsonValue | undefined>();
      const view = createDurableProjectionOverlay(current, changes);
      for (const [ordinal, entry] of envelope.entries.entries()) {
        if (entry.stream !== STREAM) continue;
        await reduceCheckpointRecord(view, changes, entry.body, position(envelope.lsn, ordinal));
      }
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined ?
        { kind: "tombstone", key } : { kind: "put", key, value });
    },
  });
}

async function reduceCheckpointRecord(view: DurableProjectionReadContext, changes: Map<string, JsonValue | undefined>,
  record: CheckpointStreamRecord, pos: string): Promise<void> {
  if (record.t === "checkpoint-cleanup-progress" && record.phase === "local-released") return;
  // 同一流里还有恢复根激活提交等非生命周期记录，它们不进本投影
  const recordKey = checkpointRecordKey(record) as string | undefined;
  if (recordKey === undefined) return;
  const key = factKey(recordKey);
  const existing = await view.get(key);
  if (existing !== undefined) {
    const prior = sequenced(existing, record.t);
    if (canonicalize(prior!.record) !== canonicalize(record)) throw new TypeError("Checkpoint lifecycle contains conflicting durable facts");
    return;
  }
  changes.set(key, { pos, record } as unknown as JsonValue);
  const superseded = async (checkpointId: string) =>
    (await view.get(factKey(`checkpoint-superseded:${checkpointId}`))) !== undefined;
  const createdOf = async (checkpointId: string) =>
    sequenced<Created>(await view.get(factKey(`checkpoint-created:${checkpointId}`)), "checkpoint-created");
  switch (record.t) {
    case "checkpoint-created": {
      if (record.generation) {
        // 同一完整代际最新的 created（状态的 pending）；同代际同请求的第一个 created（幂等创建）
        changes.set(generationLatestKey(record.generation), { pos, checkpointId: record.checkpointId } as unknown as JsonValue);
        if (record.request) {
          const request = createdForKey(record.generation, record.request);
          if ((await view.get(request)) === undefined) changes.set(request, record.checkpointId);
        }
      }
      if (record.targetId && record.generation &&
          (await view.get(factKey(`checkpoint-replicated:${record.checkpointId}:${record.targetId}`))) === undefined)
        changes.set(pendingReplication(record.checkpointId, record.targetId), { pos, checkpointId: record.checkpointId } as unknown as JsonValue);
      if (record.targetId && record.purpose.kind === "root-activation") {
        changes.set(rootActivationLatest(record.targetId), { pos, checkpointId: record.checkpointId } as unknown as JsonValue);
        // 原口径：该 checkpoint 有任一目标的 verified 即视为已终结
        const verified = await view.scan({ gte: verifiedByCheckpoint(record.checkpointId), lt: verifiedByCheckpoint(record.checkpointId) + "￿" }, 1);
        if (verified.continuation) view.releaseContinuation?.(verified.continuation);
        if (!verified.entries.length) changes.set(rootActivationOpenPrefix(record.targetId) + inverse(pos), record.checkpointId);
      }
      break;
    }
    case "checkpoint-replicated": {
      changes.set(pendingReplication(record.checkpointId, record.targetId), undefined);
      const created = await createdOf(record.checkpointId);
      // 原口径：按 created 先后最新、已复制（复制记录的收件人即当前收件人）、代际同属当前 root/recipient/trustChainHead
      if (created && created.record.targetId === record.targetId && created.record.generation &&
          created.record.generation.targetId === created.record.targetId &&
          record.recipientKeyId === created.record.generation.recipientKeyId) {
        const latest = generationKey(created.record.generation), prior = await view.get(latest);
        const priorPos = prior && typeof prior === "object" && !Array.isArray(prior) && typeof prior.pos === "string" ? prior.pos : "";
        if (created.pos > priorPos)
          changes.set(latest, { pos: created.pos, checkpointId: created.record.checkpointId, targetId: record.targetId } as unknown as JsonValue);
      }
      break;
    }
    case "checkpoint-verified": {
      if (!await superseded(record.checkpointId)) {
        const verified = verifiedPrefix(record.recipientKeyId) + inverse(pos) + "/" + pair(record.checkpointId, record.targetId);
        changes.set(verified, { pos, record } as unknown as JsonValue);
        changes.set(verifiedOf(record.checkpointId, record.targetId), verified);
      }
      changes.set(verifiedByCheckpoint(record.checkpointId) + pair(record.checkpointId, record.targetId), { pos, record } as unknown as JsonValue);
      const created = await createdOf(record.checkpointId);
      if (created?.record.purpose.kind === "root-activation" && created.record.targetId)
        changes.set(rootActivationOpenPrefix(created.record.targetId) + inverse(created.pos), undefined);
      break;
    }
    case "checkpoint-superseded": {
      // 取代即退出“当前已验证”；created 带目标时进入待清理，按取代时间排序
      for (let continuation: string | undefined, first = true; first || continuation; first = false) {
        const page = await view.scan({ gte: verifiedByCheckpoint(record.checkpointId), lt: verifiedByCheckpoint(record.checkpointId) + "￿" }, 64, continuation);
        for (const entry of page.entries) {
          const verified = sequenced<Verified>(entry.value, "checkpoint-verified")!.record;
          const pointer = await view.get(verifiedOf(verified.checkpointId, verified.targetId));
          if (typeof pointer === "string") changes.set(pointer, undefined);
          changes.set(verifiedOf(verified.checkpointId, verified.targetId), undefined);
        }
        continuation = page.continuation;
      }
      const created = await createdOf(record.checkpointId);
      if (created?.record.targetId)
        changes.set(cleanupKey(record), { checkpointId: record.checkpointId, supersededBy: record.supersededBy, targetId: created.record.targetId } as unknown as JsonValue);
      break;
    }
    case "checkpoint-cleanup-progress": {
      if (record.phase === "target-retired") {
        const superseded = sequenced<Superseded>(await view.get(factKey(`checkpoint-superseded:${record.checkpointId}`)), "checkpoint-superseded");
        if (superseded && superseded.record.supersededBy === record.supersededBy) changes.set(cleanupKey(superseded.record), undefined);
      }
      break;
    }
    case "checkpoint-verify-failed":
      break;
  }
}
function cleanupKey(record: Superseded): string {
  const at = Date.parse(record.at);
  if (!Number.isSafeInteger(at) || at < 0) throw invalid();
  return cleanupPrefix + at.toString().padStart(16, "0") + "/" + digest("Checkpoint", record.checkpointId);
}

/** 读取侧：都在同一个已验证视图上按键读或扫小前缀。 */
export class CheckpointLifecycleView {
  constructor(private readonly current: DurableProjectionReadContext) {}
  async fact<T extends CheckpointStreamRecord>(recordKey: string, t: T["t"]): Promise<T | undefined> {
    return sequenced<T>(await this.current.get(factKey(recordKey)), t)?.record;
  }
  created(checkpointId: string): Promise<Created | undefined> {
    return this.fact<Created>(`checkpoint-created:${checkpointId}`, "checkpoint-created");
  }
  verified(checkpointId: string, targetId: string): Promise<Verified | undefined> {
    return this.fact<Verified>(`checkpoint-verified:${checkpointId}:${targetId}`, "checkpoint-verified");
  }
  replicated(checkpointId: string, targetId: string): Promise<Replicated | undefined> {
    return this.fact<Replicated>(`checkpoint-replicated:${checkpointId}:${targetId}`, "checkpoint-replicated");
  }
  async targetRetired(checkpointId: string, targetId: string): Promise<boolean> {
    return (await this.current.get(factKey(`checkpoint-cleanup-progress:${checkpointId}:${targetId}:target-retired`))) !== undefined;
  }
  /** 某 checkpoint 的已验证记录（任一目标），按先后。 */
  async verifiedOfCheckpoint(checkpointId: string): Promise<readonly Verified[]> {
    return (await this.#all(verifiedByCheckpoint(checkpointId))).map((entry) => sequenced<Verified>(entry.value, "checkpoint-verified")!)
      .sort((left, right) => left.pos < right.pos ? -1 : left.pos > right.pos ? 1 : 0).map((entry) => entry.record);
  }
  /** 当前（未被取代）的已验证记录，最新在前。 */
  async currentVerified(recipientKeyId: string): Promise<readonly Verified[]> {
    return (await this.#all(verifiedPrefix(recipientKeyId))).map((entry) => sequenced<Verified>(entry.value, "checkpoint-verified")!.record);
  }
  /** 该代际已复制的 created 中按 created 先后最新的一个。 */
  async latestReplicated(generation: Pick<RecoveryCheckpointGeneration, "rootKeyId" | "recipientKeyId" | "trustChainHead">):
    Promise<{ checkpointId: string; targetId: string } | undefined> {
    const value = await this.current.get(generationKey(generation));
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.checkpointId !== "string" || typeof value.targetId !== "string") throw invalid();
    return { checkpointId: value.checkpointId, targetId: value.targetId };
  }
  /** 待复制的 created（有目标与代际、尚未复制），按 created 先后。 */
  async pendingReplication(): Promise<readonly Created[]> {
    const pending: { pos: string; checkpointId: string }[] = [];
    for (const entry of await this.#all("pr/")) {
      const value = entry.value;
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.pos !== "string" || typeof value.checkpointId !== "string") throw invalid();
      pending.push({ pos: value.pos, checkpointId: value.checkpointId });
    }
    const created: Created[] = [];
    for (const { checkpointId } of pending.sort((left, right) => left.pos < right.pos ? -1 : left.pos > right.pos ? 1 : 0)) {
      const record = await this.created(checkpointId);
      if (record) created.push(record);
    }
    return created;
  }
  /** 取代时间不晚于 cutoff、目标尚未退役的待清理项，按取代时间先后。 */
  async cleanupDue(cutoffMs: number): Promise<readonly { checkpointId: string; supersededBy: string; targetId: string }[]> {
    return (await this.#all(cleanupPrefix, cleanupPrefix + (cutoffMs + 1).toString().padStart(16, "0"))).map(({ value }) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.checkpointId !== "string" ||
          typeof value.supersededBy !== "string" || typeof value.targetId !== "string") throw invalid();
      return { checkpointId: value.checkpointId, supersededBy: value.supersededBy, targetId: value.targetId };
    });
  }
  /** 完整代际（含目标）相同的 created 中最新的一个。 */
  async latestCreated(generation: RecoveryCheckpointGeneration): Promise<Created | undefined> {
    const value = await this.current.get(generationLatestKey(generation));
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.checkpointId !== "string") throw invalid();
    return this.created(value.checkpointId);
  }
  /** 同代际同请求的第一个 created。 */
  async createdFor(generation: RecoveryCheckpointGeneration, request: unknown): Promise<Created | undefined> {
    const value = await this.current.get(createdForKey(generation, request));
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw invalid();
    return this.created(value);
  }
  /** 某目标最新的根激活 created。 */
  async latestRootActivation(targetId: string): Promise<Created | undefined> {
    const value = await this.current.get(rootActivationLatest(targetId));
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.checkpointId !== "string") throw invalid();
    return this.created(value.checkpointId);
  }
  /** 某目标最新的尚未验证的根激活 created。 */
  async latestOpenRootActivation(targetId: string): Promise<Created | undefined> {
    const page = await this.current.scan({ gte: rootActivationOpenPrefix(targetId), lt: rootActivationOpenPrefix(targetId) + "￿" }, 1);
    const first = page.entries[0];
    if (page.continuation) this.current.releaseContinuation?.(page.continuation);
    if (!first) return undefined;
    if (typeof first.value !== "string") throw invalid();
    return this.created(first.value);
  }
  async #all(gte: string, lt = gte + "￿"): Promise<readonly { key: string; value: JsonValue }[]> {
    const entries: { key: string; value: JsonValue }[] = [];
    for (let continuation: string | undefined, first = true; first || continuation; first = false) {
      const page = await this.current.scan({ gte, lt }, 64, continuation);
      entries.push(...page.entries);
      continuation = page.continuation;
    }
    return entries;
  }
}
