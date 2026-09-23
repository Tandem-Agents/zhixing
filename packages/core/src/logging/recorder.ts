import { createHash, randomUUID } from "node:crypto";
import { bindLogSource, captureLog } from "./capture.js";
import { LogAppendIndeterminateError } from "./contracts.js";
import type {
  LogAccess,
  LogCapture,
  LogHealth,
  LogPolicy,
  LogRecordPort,
  LogSink,
  LogSource,
} from "./contracts.js";
import { fitLogCapture } from "./limits.js";
import { DEFAULT_LOG_POLICY, validateLogPolicy } from "./policy.js";

interface Entry {
  capture: LogCapture;
  bytes: number;
  key: string;
  healthThrough?: number;
  unconfirmedThrough?: number;
  sealed?: boolean;
  uncertain?: boolean;
  countedAtClose?: boolean;
}
const HEALTH_SOURCE = bindLogSource({
  id: "logging",
  version: 1,
  events: {
    degraded: {
      message: "日志采集曾受阻，以下时段的证据可能不完整",
      level: "warn",
      tier: "critical",
      fields: {
        lost: "number",
        from: "number",
        until: "number",
        captureFailures: "number",
        unconfirmed: "number",
      },
    },
  },
});
const size = (capture: LogCapture): number => Buffer.byteLength(JSON.stringify(capture));

/** Synchronous bounded producer boundary; all persistence is single-flight and failure-isolated. */
export class LogRecorder {
  readonly #sink: LogSink;
  readonly #process = randomUUID();
  readonly #healthProcess = randomUUID();
  readonly #queue: Entry[] = [];
  readonly #inflight = new Set<Entry>();
  readonly #sources = new Set<string>();
  readonly #stopped = new AbortController();
  readonly #notify: ((health: LogHealth) => void) | undefined;
  #policy: LogPolicy;
  #state: LogHealth["state"] = "starting";
  #bytes = 0;
  #seq = 0;
  #lost = 0;
  #unconfirmed = 0;
  #reportedUnconfirmed = 0;
  #failures = 0;
  #reportedLost = 0;
  #lostSince = 0;
  #lastFailure: string | undefined;
  #lastNotice = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = 0;
  #work: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #stopping = false;
  #ready = false;
  #retry = 0;
  #retryAt = 0;
  #lastMaintenance = 0;

  constructor(
    sink: LogSink,
    options: {
      policy?: LogPolicy;
      onHealth?: (health: LogHealth) => void;
    } = {},
  ) {
    this.#sink = sink;
    this.#policy = validateLogPolicy(options.policy ?? DEFAULT_LOG_POLICY);
    this.#notify = options.onHealth;
  }
  bind(source: LogSource, access: LogAccess): LogRecordPort {
    const boundSource = bindLogSource(source),
      boundAccess = { ...access };
    if (!this.#sources.has(source.id)) {
      if (this.#sources.size >= 64) throw Error("日志来源数量超限");
      this.#sources.add(source.id);
    }
    return Object.freeze({
      record: (draft) => {
        if (this.#closing) return;
        try {
          this.#enqueue(
            captureLog(boundSource, boundAccess, draft, this.#policy, this.#process, ++this.#seq),
          );
        } catch {
          this.#failures++;
          this.#lose();
          this.#degrade("capture-failed");
        }
      },
    } satisfies LogRecordPort);
  }
  health(): LogHealth {
    return {
      state: this.#state,
      queued: this.#queue.length,
      queuedBytes: this.#bytes,
      lost: this.#lost,
      captureFailures: this.#failures,
      unconfirmed: this.#unconfirmed,
      ...(this.#lastFailure ? { lastFailure: this.#lastFailure } : {}),
    };
  }
  async start(waitMs = 100): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#kick();
    await waitBounded(this.#work ?? Promise.resolve(), waitMs, this.#stopped.signal);
  }
  async flush(deadlineMs = 1500): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    await this.#drain(Date.now() + boundedDelay(deadlineMs), this.#seq);
  }
  close(deadlineMs = 1500): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#closePromise = (async () => {
      const deadline = Date.now() + boundedDelay(deadlineMs);
      await this.#drain(deadline, this.#seq);
      this.#stopping = true;
      this.#stopped.abort();
      try {
        if (!(await waitBounded(this.#sink.close(), Math.max(0, deadline - Date.now()))))
          this.#lastFailure = "close-pending";
      } catch {
        this.#lastFailure = "close-failed";
      }
      if (this.#queue.length) {
        for (const entry of this.#queue) {
          if (entry.healthThrough !== undefined) continue;
          if (this.#inflight.has(entry) || entry.uncertain) {
            this.#unconfirmed++;
            entry.countedAtClose = true;
          } else this.#lost++;
        }
        this.#lastFailure = "close-incomplete";
      }
      this.#queue.length = 0;
      this.#inflight.clear();
      this.#bytes = 0;
      this.#state = "closed";
    })();
    return this.#closePromise;
  }
  async #drain(deadline: number, upper: number): Promise<void> {
    do {
      if (Date.now() >= deadline || this.#stopping) return;
      const retryWait = Math.min(deadline - Date.now(), this.#retryAt - Date.now());
      if (retryWait > 0) {
        await waitBounded(undefined, retryWait, this.#stopped.signal);
        if (Date.now() >= deadline || this.#stopping) return;
      }
      this.#kick();
      if (
        !(await waitBounded(
          this.#work ?? Promise.resolve(),
          deadline - Date.now(),
          this.#stopped.signal,
        ))
      )
        return;
    } while (
      this.#queue.some((entry) => entry.capture.record.seq <= upper) ||
      this.#lost > this.#reportedLost ||
      this.#unconfirmed > this.#reportedUnconfirmed
    );
  }
  #lose(count = 1): void {
    this.#lost = Math.min(Number.MAX_SAFE_INTEGER, this.#lost + count);
    this.#lostSince ||= Date.now();
  }
  #enqueue(capture: LogCapture, healthThrough?: number): void {
    const { id: _id, seq: _seq, occurredAt: _time, ...stable } = capture.record;
    const key = createHash("sha256")
      .update(JSON.stringify({ ...stable, detail: capture.detail }))
      .digest("hex");
    const duplicate =
      healthThrough === undefined
        ? this.#queue.find((entry) => entry.key === key && !entry.sealed)
        : undefined;
    if (duplicate) {
      const merged = {
        ...duplicate.capture,
        record: {
          ...duplicate.capture.record,
          repeat: {
            count: Math.min(
              Number.MAX_SAFE_INTEGER,
              (duplicate.capture.record.repeat?.count ?? 1) + 1,
            ),
            until: capture.record.occurredAt,
          },
        },
      };
      const delta = size(merged) - duplicate.bytes;
      if (
        this.#bytes + delta <= this.#policy.queueBytes &&
        this.#queue
          .filter((entry) => entry.capture.record.source === capture.record.source)
          .reduce((sum, entry) => sum + entry.bytes, delta) <=
          this.#policy.queueBytes / 2 &&
        Buffer.byteLength(JSON.stringify(merged.record)) + 512 <= this.#policy.recordBytes
      ) {
        duplicate.capture = merged;
        duplicate.bytes += delta;
        this.#bytes += delta;
        return;
      }
    }
    const reserveBytes = Math.min(4096, Math.floor(this.#policy.queueBytes / 2));
    const limitBytes = this.#policy.queueBytes - (healthThrough === undefined ? reserveBytes : 0);
    const limitCount = Math.max(
      1,
      this.#policy.queueRecords - (healthThrough === undefined ? 1 : 0),
    );
    const source = capture.record.source;
    const sameSource = (): Entry[] =>
      this.#queue.filter((entry) => entry.capture.record.source === source);
    let bytes = size(capture);
    const sourceLimit = Math.floor(this.#policy.queueBytes / 2);
    if (
      capture.detail &&
      (bytes > sourceLimit ||
        this.#bytes + bytes > limitBytes ||
        sameSource().reduce((sum, entry) => sum + entry.bytes, bytes) > sourceLimit)
    ) {
      capture = {
        record: {
          ...capture.record,
          truncated: true,
          gaps: [{ kind: "not-collected", reason: "detail-pressure" }],
        },
      };
      bytes = size(capture);
    }
    if (
      healthThrough === undefined &&
      (bytes > sourceLimit ||
        sameSource().length >= this.#policy.sourceQueueRecords ||
        sameSource().reduce((sum, entry) => sum + entry.bytes, bytes) > sourceLimit)
    ) {
      this.#lose();
      return;
    }
    while (this.#bytes + bytes > limitBytes || this.#queue.length >= limitCount) {
      const expendable = this.#queue.find((entry) => entry.capture.detail && !entry.sealed);
      if (expendable && this.#bytes + bytes > limitBytes) {
        const reduced: LogCapture = {
          record: {
            ...expendable.capture.record,
            truncated: true,
            gaps: [{ kind: "not-collected", reason: "detail-pressure" }],
          },
        };
        this.#bytes += size(reduced) - expendable.bytes;
        expendable.capture = reduced;
        expendable.bytes = size(reduced);
        continue;
      }
      const index =
        capture.record.tier === "critical"
          ? this.#queue.findIndex(
              (entry) => entry.capture.record.tier === "detail" && !entry.sealed,
            )
          : -1;
      if (index < 0) {
        if (healthThrough === undefined) this.#lose();
        return;
      }
      this.#remove(this.#queue[index]!);
      this.#lose();
    }
    this.#queue.push({
      capture,
      bytes,
      key,
      ...(healthThrough === undefined
        ? {}
        : { healthThrough, unconfirmedThrough: this.#unconfirmed }),
    });
    this.#bytes += bytes;
    this.#schedule(10);
  }
  #remove(entry: Entry): void {
    const index = this.#queue.indexOf(entry);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#bytes -= entry.bytes;
    }
  }
  #apply(policy: LogPolicy): void {
    this.#policy = validateLogPolicy(policy);
    for (const entry of [...this.#queue]) {
      const adjusted = fitLogCapture(entry.capture, policy);
      this.#bytes += size(adjusted) - entry.bytes;
      entry.capture = adjusted;
      entry.bytes = size(adjusted);
    }
    const counts = new Map<string, { count: number; bytes: number }>();
    for (const entry of [...this.#queue].sort((a, b) =>
      a.capture.record.tier === b.capture.record.tier
        ? 0
        : a.capture.record.tier === "critical"
          ? -1
          : 1,
    )) {
      const source = entry.capture.record.source,
        used = counts.get(source) ?? { count: 0, bytes: 0 };
      if (
        entry.healthThrough === undefined &&
        (used.count + 1 > policy.sourceQueueRecords ||
          used.bytes + entry.bytes > policy.queueBytes / 2)
      ) {
        this.#remove(entry);
        this.#lose();
      } else
        counts.set(source, {
          count: used.count + 1,
          bytes: used.bytes + entry.bytes,
        });
    }
    const health = this.#queue.find((entry) => entry.healthThrough !== undefined);
    const byteLimit =
      policy.queueBytes - Math.min(4096, Math.floor(policy.queueBytes / 2)) + (health?.bytes ?? 0);
    const countLimit = policy.queueRecords - (health ? 0 : 1);
    while (
      this.#queue.length > countLimit ||
      this.#bytes > Math.min(byteLimit, policy.queueBytes)
    ) {
      const entry =
        this.#queue.find((item) => item.capture.record.tier === "detail") ??
        this.#queue.findLast((item) => item !== health);
      if (!entry) break;
      this.#remove(entry);
      this.#lose();
    }
  }
  #schedule(ms: number): void {
    if (this.#closing) return;
    const delay = boundedDelay(ms),
      at = Date.now() + delay;
    if (this.#timer && this.#timerAt <= at) return;
    clearTimeout(this.#timer);
    this.#timerAt = at;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#kick();
    }, delay);
    this.#timer.unref();
  }
  #kick(): void {
    if (this.#work || this.#stopping) return;
    if (Date.now() < this.#retryAt) {
      this.#schedule(this.#retryAt - Date.now());
      return;
    }
    this.#work = this.#step().finally(() => {
      this.#work = undefined;
      this.#schedule(
        this.#retry
          ? Math.max(0, this.#retryAt - Date.now())
          : this.#queue.length
            ? 10
            : this.#policy.maintenanceMs,
      );
    });
  }
  async #step(): Promise<void> {
    try {
      if (!this.#ready) {
        const status = await this.#sink.initialize();
        if (this.#stopping) return;
        this.#apply(status.policy.effective);
        this.#ready = true;
      }
      if (
        (this.#lost > this.#reportedLost || this.#unconfirmed > this.#reportedUnconfirmed) &&
        !this.#queue.some((entry) => entry.healthThrough !== undefined)
      ) {
        const health = captureLog(
          HEALTH_SOURCE,
          { scope: "storage" },
          {
            event: "degraded",
            data: {
              lost: this.#lost - this.#reportedLost,
              from: this.#lostSince,
              until: Date.now(),
              captureFailures: this.#failures,
              unconfirmed: this.#unconfirmed - this.#reportedUnconfirmed,
            },
          },
          this.#policy,
          this.#healthProcess,
          ++this.#seq,
        );
        this.#enqueue(
          this.#unconfirmed > this.#reportedUnconfirmed
            ? {
                ...health,
                record: {
                  ...health.record,
                  gaps: [{ kind: "insufficient", reason: "persistence-unconfirmed" }],
                },
              }
            : health,
          this.#lost,
        );
      }
      const ordered = [...this.#queue].sort((a, b) =>
        a.capture.record.tier === b.capture.record.tier
          ? 0
          : a.capture.record.tier === "critical"
            ? -1
            : 1,
      );
      const batch: Entry[] = [];
      let peakBytes = 0;
      for (const entry of ordered) {
        const bytes =
          Buffer.byteLength(JSON.stringify(entry.capture.record)) +
          Buffer.byteLength(entry.capture.detail ?? "") +
          512;
        if (batch.length >= Math.min(8, Math.floor((this.#policy.maxFiles - 7) / 2))) break;
        if (peakBytes + bytes > this.#policy.maxBytes - this.#policy.governanceBytes * 2) {
          if (batch.length) break;
          this.#remove(entry);
          this.#lose();
          continue;
        }
        batch.push(entry);
        peakBytes += bytes;
      }
      if (batch.length) {
        for (const entry of batch) {
          entry.sealed = true;
          this.#inflight.add(entry);
        }
        let status;
        try {
          status = await this.#sink.append(batch.map((entry) => entry.capture));
        } catch (error) {
          if (
            error instanceof LogAppendIndeterminateError ||
            (error instanceof Error && error.name === "LogAppendIndeterminateError")
          ) {
            for (const entry of batch) {
              if (this.#stopping) {
                entry.uncertain = true;
                continue;
              }
              this.#remove(entry);
              if (entry.healthThrough === undefined) this.#unconfirmed++;
              else this.#acknowledgeHealth(entry);
            }
            this.#lostSince ||= Date.now();
          }
          throw error;
        }
        for (const entry of batch) {
          this.#remove(entry);
          if (entry.countedAtClose) {
            this.#unconfirmed--;
            entry.countedAtClose = false;
          }
          this.#acknowledgeHealth(entry);
        }
        this.#inflight.clear();
        if (this.#stopping) return;
        this.#apply(status.policy.effective);
        if (status.storageDegraded) {
          this.#ready = false;
          throw Error("日志写入已确认，文件所有者需重建");
        }
      }
      if (!this.#stopping && Date.now() - this.#lastMaintenance >= this.#policy.maintenanceMs) {
        const status = await this.#sink.maintain();
        if (this.#stopping) return;
        this.#apply(status.policy.effective);
        this.#lastMaintenance = Date.now();
      }
      this.#retry = 0;
      this.#retryAt = 0;
      this.#lastFailure = undefined;
      if (!this.#stopping) this.#state = "ready";
    } catch {
      if (!this.#stopping) {
        this.#retry++;
        this.#retryAt = Date.now() + Math.min(30_000, 100 * 2 ** Math.min(this.#retry, 8));
        this.#degrade("storage-unavailable");
      }
    } finally {
      this.#inflight.clear();
    }
  }
  #acknowledgeHealth(entry: Entry): void {
    if (entry.healthThrough === undefined) return;
    this.#reportedLost = Math.max(this.#reportedLost, entry.healthThrough);
    this.#reportedUnconfirmed = Math.max(this.#reportedUnconfirmed, entry.unconfirmedThrough ?? 0);
  }
  #degrade(reason: string): void {
    if (this.#stopping) return;
    this.#state = "degraded";
    this.#lastFailure = reason;
    if (Date.now() - this.#lastNotice < 30_000) return;
    this.#lastNotice = Date.now();
    try {
      this.#notify?.(this.health());
    } catch {
      /* Health cannot fail business. */
    }
  }
}

function boundedDelay(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(2_147_483_647, Math.floor(value))) : 0;
}
async function waitBounded(
  work: Promise<void> | undefined,
  ms: number,
  abort?: AbortSignal,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  try {
    return await Promise.race([
      ...(work
        ? [
            work.then(
              () => true,
              () => true,
            ),
          ]
        : []),
      new Promise<boolean>((resolve) => {
        cancelled = () => resolve(false);
        abort?.addEventListener("abort", cancelled, { once: true });
        timer = setTimeout(() => resolve(false), boundedDelay(ms));
        if (abort?.aborted) resolve(false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancelled) abort?.removeEventListener("abort", cancelled);
  }
}
