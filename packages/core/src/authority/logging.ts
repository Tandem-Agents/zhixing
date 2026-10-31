import type { LogRecordPort, LogRef, LogSource } from "../logging/contracts.js";
import { currentLogPhaseRefs } from "../logging/phase.js";
import { LOG_FAILURE_FIELDS, logFailureEvidence, failureSourceFrames } from "../logging/failure.js";
import { AuthorityStorageError } from "./errors.js";
import { observationRefs } from "../logging/producer.js";
import type { LogicalRecord } from "../contracts/index.js";
import { maintenanceRetryDelayMs, type StorageMaintenanceAdmissionError } from "../resources/storage-maintenance.js";

export const AUTHORITY_LOG_SOURCE: LogSource = {
  id: "authority", version: 1,
  events: {
    committed: { message: "业务权威提交已耐久", level: "info", tier: "critical", fields: {
      lsn: "number", count: "number", streams: { items: "text", maxItems: 32 },
    } },
    uncertain: { message: "业务权威追加结果未确认", level: "error", tier: "critical", fields: { lsn: "number", error: "text" } },
    recovered: { message: "业务权威已恢复有效尾部", level: "info", tier: "critical", fields: { lsn: "number", incompleteTail: "boolean" } },
    corrupted: { message: "业务权威历史字节与认证索引不符", level: "error", tier: "critical", fields: { error: "text" } },
    work: { message: "业务权威存储工作汇总", level: "info", tier: "critical", fields: {
      operation: "text", preparationMs: "number", releaseMs: "number", retryWaitMs: "number", recoveries: "number", operations: "number", scans: "number", readBytes: "number", queueMs: "number", lockWaitMs: "number", executionMs: "number", retries: "number",
      preparedFrames: "number", segmentOpens: "number", segmentVerifies: "number", segmentEntryReads: "number", directoryPageReads: "number", manifestReads: "number", maxExecutionMs: "number",
      lockAcquisitions: "number", lockAfterIdle: "number", lockAfterHoldLimit: "number", lockAfterBoundary: "number", lockAfterHandoff: "number",
    } },
    opened: { message: "上一个就绪准备边界以来本进程首次打开的持久投影（含清单与段边界核验、检查点核对），按耗时列出最慢的几个", level: "info", tier: "critical", fields: {
      boundary: "text", count: "number", totalMs: "number", slowest: { items: "text", maxItems: 8 },
    } },
    maintained: { message: "一轮空闲维护整理过的投影，按耗时列出最慢的几个", level: "info", tier: "critical", fields: {
      count: "number", durationMs: "number", slowest: { items: "text", maxItems: 8 },
    } },
    prepared: { message: "就绪边界依赖的派生状态已在该位置就绪", level: "info", tier: "critical", fields: {
      boundary: "text", lsn: "number", frameEndOffset: "number", projections: "number", durationMs: "number",
    } },
    retired: { message: "被替代派生版本副本的回收状态", level: "info", tier: "critical", fields: {
      projection: "text", version: "number", outcome: "text", reason: "text",
    } },
    waiting: { message: "业务权威操作仍在等待或执行", level: "info", tier: "critical", fields: { operation: "text", waitFor: "text", durationMs: "number" } },
    deferred: { message: "业务权威操作被资源准入推迟，由调用方重试", level: "info", tier: "detail", fields: { operation: "text", waitFor: "text", blockedBy: "text", retryAfterMs: "number", kind: "text",
      reason: "text", requiredLsn: "number", projections: { items: "text", maxItems: 8 } } },
    failed: { message: "业务权威操作未完成", level: "error", tier: "critical", fields: { operation: "text", waitFor: "text", validation: "text", sourceFrames: { items: "text", maxItems: 4 }, failure: { fields: LOG_FAILURE_FIELDS } } },
  },
};

export type AuthorityOperation = "append" | "readSnapshot" | "readStream" | "readProjection" | "checkpoint" | "installPlannedAnchorPrefix"
  | "installAppendAdmissionGuard" | "originCheckpoint" | "readTail" | "readEnvelopeAt" | "rebuildProjection"
  | "transactProjection" | "transactDurableProjection" | "maintainFrameIndex" | "projection.get" | "projection.getMany" | "projection.scan" | "projection.checkpoint" | "projection.checkpoints" | "projection.rebuild" | "projection.retainedReferences"
  | "projection.prepare" | "projection.retire" | "projection.publishRows";
export interface AuthorityWork {
  scans: number; readBytes: number; recoveries: number; queueMs: number; preparationMs: number;
  lockWaitMs: number; executionMs: number; releaseMs: number; retryWaitMs: number; retries: number;
  /** 派生状态追平/候选构建实际处理的源帧数（锁内同步与锁外分页准备都计入）。 */
  preparedFrames: number;
  /** 经准入真正打开段文件句柄的次数。 */
  segmentOpens: number;
  /** 复用已打开段前的文件身份核对次数（同一源操作内同一段只核一次；与真正打开句柄的 segmentOpens 分开计）。 */
  segmentVerifies: number;
  /** 投影的物理读：条目缓存未命中而从段文件读取的条目数、目录缓存未命中而读取的目录页数、读取的清单数。 */
  segmentEntryReads: number;
  directoryPageReads: number;
  manifestReads: number;
  /** 新取得写者锁（新锁会话）的次数；沿用已有会话的操作不计。 */
  lockAcquisitions: number;
  /** 新取得锁之前，上一个会话的结束原因：空闲到期、持有上限、操作边界强制释放、同进程另一实例收回。 */
  lockAfterIdle: number;
  lockAfterHoldLimit: number;
  lockAfterBoundary: number;
  lockAfterHandoff: number;
}
/** 派生准备信号上只供观测的原因与位置（见 AuthorityPreparationRequired.observed）；按形状读取，不引入准备模块的依赖。 */
function preparationEvidence(error: unknown): { reason?: string; requiredLsn?: number; projections?: string[] } {
  const observed = (error as { observed?: { reason?: unknown; requiredLsn?: unknown; positions?: unknown } } | null)?.observed;
  if (!observed || typeof observed.reason !== "string") return {};
  return {
    reason: observed.reason,
    ...(typeof observed.requiredLsn === "number" ? { requiredLsn: observed.requiredLsn } : {}),
    ...(Array.isArray(observed.positions) ? { projections: observed.positions.filter((item): item is string => typeof item === "string").slice(0, 8) } : {}),
  };
}

const emptyWork = (): AuthorityWork => ({ scans: 0, readBytes: 0, recoveries: 0, queueMs: 0, preparationMs: 0,
  lockWaitMs: 0, executionMs: 0, releaseMs: 0, retryWaitMs: 0, retries: 0, preparedFrames: 0, segmentOpens: 0, segmentVerifies: 0,
  segmentEntryReads: 0, directoryPageReads: 0, manifestReads: 0, lockAcquisitions: 0, lockAfterIdle: 0, lockAfterHoldLimit: 0, lockAfterBoundary: 0, lockAfterHandoff: 0 });
/** Bounded by phase and finite operation kind, never by business body or operation count. */
export class AuthorityWorkObserver {
  #pending = new Map<string, { refs: readonly LogRef[]; data: AuthorityWork & { operation: AuthorityOperation; operations: number; maxExecutionMs: number } }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly records: LogRecordPort | undefined, private readonly authority: () => string | undefined) {}
  begin(operation: AuthorityOperation) {
    const refs = currentLogPhaseRefs();
    const data = emptyWork();
    let waitFor = "local-queue", since = performance.now(), finished = false;
    const emit = (event: string, value: Record<string, unknown>, failed = false) => {
      try {
        const id = this.authority();
        this.records?.record({ event, refs: [...refs, ...(id ? [{ kind: "authority", id }] : [])], data: { operation, ...value }, ...(failed ? { result: "failure" as const } : {}) });
      } catch { /* Observation never changes authority outcome. */ }
    };
    const timer = this.records ? setInterval(() => emit("waiting", { waitFor, durationMs: Math.round(performance.now() - since) }), 5000) : undefined;
    timer?.unref();
    return { data, stage: (stage: string) => { const previous = waitFor; waitFor = stage; since = performance.now(); return previous; },
      // 锁外重试前记下这一次被拒的叶：所处阶段、阻塞维度与维护类别；只观测，不改重试
      deferred: (error: unknown) => {
        const retryAfterMs = maintenanceRetryDelayMs(error);
        if (retryAfterMs === undefined || !this.records) return;
        const { admission, maintenanceKind } = error as StorageMaintenanceAdmissionError;
        emit("deferred", { waitFor, blockedBy: "blockedBy" in admission ? admission.blockedBy : undefined, retryAfterMs,
          ...(maintenanceKind ? { kind: maintenanceKind } : {}), ...preparationEvidence(error) });
      },
      finish: (...failure: [] | [unknown]) => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        const retryAfterMs = failure.length ? maintenanceRetryDelayMs(failure[0]) : undefined;
        if (retryAfterMs !== undefined && this.records) {
          // 可重试背压由调用方重试，只记推迟，不记“操作未完成”
          const { admission } = failure[0] as StorageMaintenanceAdmissionError;
          emit("deferred", { waitFor, blockedBy: "blockedBy" in admission ? admission.blockedBy : undefined, retryAfterMs,
            ...preparationEvidence(failure[0]) });
        } else if (failure.length && this.records) {
          const error = failure[0];
          emit("failed",{ waitFor, sourceFrames: failureSourceFrames(error), ...(error instanceof AuthorityStorageError && error.validation ? { validation: error.validation } : {}), failure: error instanceof AuthorityStorageError && error.cause === undefined ? { category: "authority", code: error.code } : logFailureEvidence(error) }, true);
        }
        if (!this.records) return;
        try {
          const id = this.authority();
          const key = JSON.stringify([operation, refs]);
          if (!this.#pending.has(key) && this.#pending.size >= 8) this.flush();
          const bucket = this.#pending.get(key) ?? { refs: [...refs, ...(id ? [{ kind: "authority", id }] : [])], data: { ...emptyWork(), operation, operations: 0, maxExecutionMs: 0 } };
          for (const name of Object.keys(data) as (keyof AuthorityWork)[]) bucket.data[name] += Math.round(data[name]);
          bucket.data.operations++;
          // 汇总里单次操作的最长锁内执行：用来核对最长一步，而不只看合计与平均
          bucket.data.maxExecutionMs = Math.max(bucket.data.maxExecutionMs, Math.round(data.executionMs));
          this.#pending.set(key, bucket);
          this.#timer ??= setTimeout(() => this.flush(), 1000);
          this.#timer.unref();
        } catch { /* The observer, including identity lookup, is non-authoritative. */ }
      },
    };
  }
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const { refs, data } of this.#pending.values()) {
      try { this.records?.record({ event: "work", refs, data: { ...data } }); } catch { /* Observation is best effort. */ }
    }
    this.#pending.clear();
  }
}

/** Only stable top-level authority identities; never copies a business body. */
export function authorityObservationRefs(entries: readonly LogicalRecord<unknown>[]): LogRef[] {
  const refs: LogRef[] = [];
  for (const entry of entries.slice(0, 32)) {
    const body = entry.body;
    const occurrence = body && typeof body === "object" ? Object.getOwnPropertyDescriptor(body, "occ")?.value : undefined;
    for (const ref of [...observationRefs(body), ...observationRefs(occurrence)]) {
      if (!refs.some((item) => item.kind === ref.kind && item.id === ref.id)) refs.push(ref);
      if (refs.length === 10) return refs;
    }
  }
  return refs;
}
