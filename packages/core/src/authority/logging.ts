import type { LogRecordPort, LogRef, LogSource } from "../logging/contracts.js";
import { currentLogPhaseRefs } from "../logging/phase.js";
import { LOG_FAILURE_FIELDS, logFailureEvidence } from "../logging/failure.js";
import { AuthorityStorageError } from "./errors.js";
import { observationRefs } from "../logging/producer.js";
import type { LogicalRecord } from "../contracts/index.js";

export const AUTHORITY_LOG_SOURCE: LogSource = {
  id: "authority", version: 1,
  events: {
    committed: { message: "业务权威提交已耐久", level: "info", tier: "critical", fields: {
      lsn: "number", count: "number", streams: { items: "text", maxItems: 32 },
    } },
    uncertain: { message: "业务权威追加结果未确认", level: "error", tier: "critical", fields: { lsn: "number", error: "text" } },
    recovered: { message: "业务权威已恢复有效尾部", level: "info", tier: "critical", fields: { lsn: "number", incompleteTail: "boolean" } },
    work: { message: "业务权威存储工作汇总", level: "info", tier: "critical", fields: {
      operation: "text", preparationMs: "number", releaseMs: "number", retryWaitMs: "number", recoveries: "number", operations: "number", scans: "number", readBytes: "number", queueMs: "number", lockWaitMs: "number", executionMs: "number", retries: "number",
    } },
    waiting: { message: "业务权威操作仍在等待或执行", level: "info", tier: "critical", fields: { operation: "text", waitFor: "text", durationMs: "number" } },
    failed: { message: "业务权威操作未完成", level: "error", tier: "critical", fields: { operation: "text", waitFor: "text", failure: { fields: LOG_FAILURE_FIELDS } } },
  },
};

export type AuthorityOperation = "append" | "readSnapshot" | "readStream" | "readProjection" | "checkpoint" | "installPlannedAnchorPrefix"
  | "installAppendAdmissionGuard" | "originCheckpoint" | "readTail" | "readEnvelopeAt" | "rebuildProjection"
  | "transactProjection" | "transactDurableProjection" | "projection.get" | "projection.scan" | "projection.checkpoints" | "projection.rebuild";
export interface AuthorityWork {
  scans: number; readBytes: number; recoveries: number; queueMs: number; preparationMs: number;
  lockWaitMs: number; executionMs: number; releaseMs: number; retryWaitMs: number; retries: number;
}
const emptyWork = (): AuthorityWork => ({ scans: 0, readBytes: 0, recoveries: 0, queueMs: 0, preparationMs: 0,
  lockWaitMs: 0, executionMs: 0, releaseMs: 0, retryWaitMs: 0, retries: 0 });
/** Bounded by phase and finite operation kind, never by business body or operation count. */
export class AuthorityWorkObserver {
  #pending = new Map<string, { refs: readonly LogRef[]; data: AuthorityWork & { operation: AuthorityOperation; operations: number } }>();
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
      finish: (...failure: [] | [unknown]) => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        if (failure.length) {
          const error = failure[0];
          emit("failed", { waitFor, failure: error instanceof AuthorityStorageError && error.cause === undefined ? { category: "authority", code: error.code } : logFailureEvidence(error) }, true);
        }
        if (!this.records) return;
        try {
          const id = this.authority();
          const key = JSON.stringify([operation, refs]);
          if (!this.#pending.has(key) && this.#pending.size >= 8) this.flush();
          const bucket = this.#pending.get(key) ?? { refs: [...refs, ...(id ? [{ kind: "authority", id }] : [])], data: { ...emptyWork(), operation, operations: 0 } };
          for (const name of Object.keys(data) as (keyof AuthorityWork)[]) bucket.data[name] += Math.round(data[name]);
          bucket.data.operations++;
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
