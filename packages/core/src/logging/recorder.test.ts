import { describe, expect, it, vi } from "vitest";
import { bindLogSource, captureLog } from "./capture.js";
import { LogRecorder } from "./recorder.js";
import { DEFAULT_LOG_POLICY, validateLogPolicy } from "./policy.js";
import { LogAppendIndeterminateError, LogStorageError } from "./contracts.js";
import type {
  LogCapture,
  LogDraft,
  LogPolicy,
  LogSink,
  LogSource,
  LogStatus,
} from "./contracts.js";

const source: LogSource = {
  id: "test",
  version: 1,
  events: {
    detail: {
      message: "细节",
      level: "debug",
      tier: "detail",
      fields: { n: "number", text: "text" },
    },
    error: {
      message: "错误",
      level: "error",
      tier: "critical",
      fields: {
        n: "number",
        text: "text",
        payload: { fields: { useful: "text", token: "secret" } },
      },
    },
  },
};
function status(policy = DEFAULT_LOG_POLICY): LogStatus {
  return {
    layout: "zxlog/1",
    storeId: "test",
    policy: { version: 1, effective: policy },
    bytes: 0,
    files: 0,
    retainedSegments: 0,
    pendingReclaims: 0,
    overdue: false,
    upper: 0,
  };
}
function sink(policy = DEFAULT_LOG_POLICY): LogSink & { stored: LogCapture[] } {
  const stored: LogCapture[] = [];
  return {
    stored,
    initialize: async () => status(policy),
    append: async (records) => {
      stored.push(...structuredClone(records));
      return status(policy);
    },
    maintain: async () => status(policy),
    close: async () => undefined,
  };
}
const pause = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
};

describe("runtime log capture and lifecycle", () => {
  it.each(["writer-busy", "resource-wait", "probe-unavailable", "migration-blocked"] as const)("waits through short %s without a false unavailable warning", async (code) => {
    const target = sink(), notify = vi.fn();
    target.initialize = vi.fn().mockRejectedValueOnce(new LogStorageError(code, "temporary contention")).mockResolvedValue(status());
    const recorder = new LogRecorder(target, { onHealth: notify });
    recorder.bind(source, { scope: "storage" }).record({ event: "error" });
    try {
      await recorder.start();
      expect(recorder.health()).toMatchObject({ state: "waiting", lost: 0, lastFailure: code });
      await recorder.flush(1500);
      expect(notify).not.toHaveBeenCalled();
      expect(recorder.health()).toMatchObject({ state: "ready", queued: 0, lost: 0 });
      expect(target.stored).toContainEqual(expect.objectContaining({ record: expect.objectContaining({ source: "logging", event: "recovered", data: expect.objectContaining({ reason: code, phase: "initialize", lost: 0 }) }) }));
    } finally { await recorder.close(); }
  });

  it.each(["initialize", "append", "maintain"] as const)("retains %s failure and recovery even without any record loss", async (phase) => {
    const target = sink(), notify = vi.fn(), original = target[phase].bind(target);
    target[phase] = vi.fn().mockRejectedValueOnce(Object.assign(Error("private payload"), { code: "EACCES" })).mockImplementation(original) as never;
    const recorder = new LogRecorder(target, { onHealth: notify });
    recorder.bind(source, { scope: "storage" }).record({ event: "error" });
    try {
      await recorder.flush(1500);
      expect(notify.mock.calls.map(([health]) => health.state)).toEqual(["degraded", "ready"]);
      expect(recorder.health()).toMatchObject({ state: "ready", queued: 0, lost: 0 });
      const health = target.stored.filter(entry => entry.record.source === "logging");
      expect(health.map(entry => entry.record.event)).toEqual(["degraded", "recovered"]);
      expect(health[0]?.record.data).toMatchObject({ reason: "permission-denied", phase, attempts: 1, lost: 0 });
      expect(JSON.stringify(health)).not.toContain("private payload");
    } finally { await recorder.close(); }
  });

  it.each(["writer-busy", "migration-blocked"] as const)("reports sustained %s and does not leave retries after close", async (code) => {
    vi.useFakeTimers();
    const target = sink(), notify = vi.fn();
    target.initialize = vi.fn(async () => { throw new LogStorageError(code, "busy"); });
    const recorder = new LogRecorder(target, { onHealth: notify });
    try {
      recorder.bind(source, { scope: "storage" }).record({ event: "error" });
      await recorder.start();
      await vi.advanceTimersByTimeAsync(6000);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: "degraded", lastFailure: code, lost: 0 }));
      const closing = recorder.close(50);
      await vi.advanceTimersByTimeAsync(50);
      await closing;
      const attempts = vi.mocked(target.initialize).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(target.initialize).toHaveBeenCalledTimes(attempts);
      expect(recorder.health()).toMatchObject({ state: "closed", lost: 1, queued: 0 });
    } finally { await recorder.close(0); vi.useRealTimers(); }
  });

  it("persists a wait that became degraded before its health record could be written", async () => {
    vi.useFakeTimers();
    const target = sink(), notify = vi.fn(), append = target.append.bind(target);
    let blocked = true;
    target.append = async records => {
      if (blocked) throw new LogStorageError("migration-blocked", "waiting for writer registration");
      return append(records);
    };
    const recorder = new LogRecorder(target, { onHealth: notify });
    try {
      recorder.bind(source, { scope: "storage" }).record({ event: "error" });
      await recorder.start();
      await vi.advanceTimersByTimeAsync(6000);
      expect(recorder.health().state).toBe("degraded");
      blocked = false;
      await vi.advanceTimersByTimeAsync(1000);
      const health = target.stored.filter(entry => entry.record.source === "logging");
      expect(health.map(entry => entry.record.event)).toEqual(["degraded", "recovered"]);
      expect(health[0]?.record.data).toMatchObject({ reason: "migration-blocked", lost: 0, unconfirmed: 0 });
      expect(notify.mock.calls.map(([value]) => value.state)).toEqual(["degraded", "ready"]);
    } finally { await recorder.close(); vi.useRealTimers(); }
  });

  it.each([
    "initialize",
    "append",
  ] as const)("drains after a transient %s failure within the same shutdown deadline", async (stage) => {
    const target = sink(),
      attempts: number[] = [];
    const original = target[stage].bind(target);
    if (stage === "initialize")
      target.initialize = async () => {
        attempts.push(Date.now());
        if (attempts.length === 1) throw Error("temporary initialization backpressure");
        return status();
      };
    else
      target.append = async (records) => {
        attempts.push(Date.now());
        if (attempts.length === 1) throw Error("temporary pre-write backpressure");
        return original(records);
      };
    const recorder = new LogRecorder(target);
    recorder.bind(source, { scope: "storage" }).record({ event: "error", data: { n: 1 } });
    const flushing = recorder.flush(1000);
    await recorder.close(1000);
    await flushing;
    expect(attempts).toHaveLength(stage === "append" ? 3 : 2); // The final append records recovery.
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(190);
    expect(target.stored.filter((capture) => capture.record.source === "test")).toHaveLength(1);
    expect(recorder.health()).toMatchObject({
      state: "closed",
      lost: 0,
      unconfirmed: 0,
      queued: 0,
    });
  });

  it("does not extend shutdown to reach a retry time beyond the deadline", async () => {
    const target = sink();
    target.initialize = vi.fn(async () => {
      throw Error("persistent backpressure");
    });
    const recorder = new LogRecorder(target);
    recorder.bind(source, { scope: "storage" }).record({ event: "error" });
    const started = Date.now();
    await recorder.close(75);
    expect(Date.now() - started).toBeLessThan(300);
    expect(target.initialize).toHaveBeenCalledOnce();
    expect(recorder.health()).toMatchObject({ state: "closed", lost: 1, unconfirmed: 0 });
  });

  it("wakes concurrent drain waiters when shutdown finishes before their retry", async () => {
    const target = sink();
    target.initialize = vi.fn(async () => {
      throw Error("persistent backpressure");
    });
    const recorder = new LogRecorder(target);
    recorder.bind(source, { scope: "storage" }).record({ event: "error" });
    let flushed = false;
    const flushing = recorder.flush(5000).then(() => {
      flushed = true;
    });
    await vi.waitFor(() => expect(target.initialize).toHaveBeenCalledOnce());
    await recorder.close(20);
    await Promise.resolve();
    expect(flushed).toBe(true);
    await flushing;
    expect(target.initialize).toHaveBeenCalledOnce();
  });

  it("preserves background recovery after a shorter explicit flush times out", async () => {
    const target = sink();
    target.initialize = vi
      .fn()
      .mockRejectedValueOnce(Error("temporary startup pressure"))
      .mockResolvedValue(status());
    const recorder = new LogRecorder(target);
    recorder.bind(source, { scope: "storage" }).record({ event: "error" });
    try {
      await recorder.flush(20);
      expect(target.stored).toHaveLength(0);
      await vi.waitFor(() => expect(target.stored.filter(entry => entry.record.source === "test")).toHaveLength(1));
      expect(target.initialize).toHaveBeenCalledTimes(2);
    } finally {
      await recorder.close();
    }
  });

  it("brings warm maintenance forward for new records and for failed short-flush recovery", async () => {
    const target = sink(),
      recorder = new LogRecorder(target);
    const port = recorder.bind(source, { scope: "storage" });
    await recorder.start();
    try {
      port.record({ event: "error", data: { n: 1 } });
      await vi.waitFor(() => expect(target.stored).toHaveLength(1));
      const append = target.append.bind(target);
      target.append = vi
        .fn()
        .mockRejectedValueOnce(Error("pre-write pressure"))
        .mockImplementation(append);
      port.record({ event: "error", data: { n: 2 } });
      await recorder.flush(20);
      expect(target.stored).toHaveLength(1);
      await vi.waitFor(() => expect(target.stored.filter(entry => entry.record.source === "test")).toHaveLength(2));
      await recorder.flush();
      expect(target.append).toHaveBeenCalledTimes(3);
      expect(recorder.health()).toMatchObject({ lost: 0, queued: 0, state: "ready" });
    } finally {
      await recorder.close();
    }
  });

  it("never runs draft accessors, custom iterators, nested proxies or toJSON", async () => {
    const target = sink(),
      recorder = new LogRecorder(target),
      port = recorder.bind(source, { scope: "storage" });
    const invoked = vi.fn(() => {
      throw Error("must not execute");
    });
    port.record(Object.defineProperty({}, "event", { get: invoked }) as LogDraft);
    const refs: unknown[] = [];
    Object.defineProperty(refs, Symbol.iterator, { value: invoked });
    port.record({
      event: "error",
      refs: refs as LogDraft["refs"],
      data: { n: 1 },
    });
    port.record({
      event: "error",
      data: { payload: new Proxy({}, { getOwnPropertyDescriptor: invoked }) },
    });
    port.record({
      event: "error",
      data: {
        payload: {
          useful: "yes",
          toJSON: invoked,
          ...Object.fromEntries(
            Array.from({ length: 10_000 }, (_, n) => [`ignored${n}`, "ignored"]),
          ),
        },
      },
    });
    await recorder.flush();
    await recorder.close();
    expect(invoked).not.toHaveBeenCalled();
    expect(target.stored.filter((entry) => entry.record.source === "test")).toHaveLength(2);
    expect(recorder.health().captureFailures).toBe(2);
  });

  it("projects nested fields and removes secrets from text, references and truncated PEM", () => {
    const policy = {
      ...DEFAULT_LOG_POLICY,
      recordBytes: 2048,
      attachmentBytes: 4096,
    };
    const captured = captureLog(
      bindLogSource(source),
      { scope: "storage" },
      {
        event: "error",
        data: {
          text: `-----BEGIN PRIVATE KEY-----${"PRIVATE-MATERIAL".repeat(1000)}-----END PRIVATE KEY-----`,
          payload: {
            useful: "hello",
            token: "opaque-private-credential",
            "sk-abcdefghijklmnopqrst": true,
          },
        },
        refs: [{ kind: "run", id: "sk-abcdefghijklmnopqrst" }],
      },
      policy,
      "process",
      1,
    );
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("PRIVATE-MATERIAL");
    expect(serialized).not.toContain("opaque-private");
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrst");
    expect(captured.record.redacted).toBe(true);
    const oversizedRefs = captureLog(
      bindLogSource(source),
      { scope: "storage" },
      {
        event: "error",
        refs: Array.from({ length: 16 }, () => ({
          kind: "k".repeat(160),
          id: "i".repeat(160),
          storeId: "s".repeat(160),
        })),
      },
      policy,
      "process",
      2,
    );
    expect(Buffer.byteLength(JSON.stringify(oversizedRefs.record)) + 512).toBeLessThanOrEqual(
      policy.recordBytes,
    );
  });

  it("retains in-flight accounting, shares close barrier, and never appends concurrently", async () => {
    const target = sink(),
      gate = pause(),
      started = pause();
    const policy = validateLogPolicy({
      ...DEFAULT_LOG_POLICY,
      queueRecords: 12,
      sourceQueueRecords: 10,
      queueBytes: 32_768,
    });
    target.initialize = async () => status(policy);
    let active = 0,
      maxActive = 0;
    target.append = async (records) => {
      active++;
      maxActive = Math.max(maxActive, active);
      started.resolve();
      await gate.promise;
      target.stored.push(...records);
      active--;
      return status(policy);
    };
    target.maintain = async () => status(policy);
    const recorder = new LogRecorder(target, { policy }),
      port = recorder.bind(source, { scope: "storage" });
    for (let n = 0; n < 8; n++) port.record({ event: "detail", data: { n } });
    void recorder.start(0);
    await started.promise;
    const before = recorder.health();
    for (let n = 0; n < 20; n++) port.record({ event: "error", data: { n } });
    expect(recorder.health().queued).toBeGreaterThanOrEqual(before.queued);
    expect(recorder.health().queuedBytes).toBeLessThanOrEqual(policy.queueBytes);
    const close = recorder.close(2000);
    expect(recorder.close()).toBe(close);
    const flush = recorder.flush();
    gate.resolve();
    await Promise.all([close, flush]);
    expect(maxActive).toBe(1);
    expect(recorder.health().state).toBe("closed");
  });

  it("lets critical evidence replace detail after a known pre-write refusal", async () => {
    const policy = validateLogPolicy({ ...DEFAULT_LOG_POLICY, queueRecords: 4, sourceQueueRecords: 3, queueBytes: 8192, recordBytes: 2048 });
    const target = sink(policy), append = target.append.bind(target);
    target.append = vi.fn().mockRejectedValueOnce(Error("lock busy before writing")).mockImplementation(append);
    const recorder = new LogRecorder(target, { policy }),
      detail = recorder.bind(source, { scope: "storage" }),
      critical = recorder.bind({ ...source, id: "critical-source" }, { scope: "storage" });
    try {
      for (let n = 0; n < 3; n++) detail.record({ event: "detail", data: { n } });
      await recorder.start();
      critical.record({ event: "error", data: { n: 99 } });
      await recorder.flush(1000);
      expect(target.stored.filter(entry => entry.record.tier === "detail")).toHaveLength(2);
      expect(target.stored).toContainEqual(expect.objectContaining({ record: expect.objectContaining({ source: "critical-source", data: { n: 99 } }) }));
      expect(recorder.health()).toMatchObject({ queued: 0, lost: 1, unconfirmed: 0 });
    } finally { await recorder.close(); }
  });

  it("merges a repeat again after a known pre-write refusal", async () => {
    const target = sink(), append = target.append.bind(target);
    target.append = vi.fn().mockRejectedValueOnce(Error("capacity refused before writing")).mockImplementation(append);
    const recorder = new LogRecorder(target), port = recorder.bind(source, { scope: "storage" });
    try {
      port.record({ event: "detail", data: { n: 1 } });
      await recorder.start();
      port.record({ event: "detail", data: { n: 1 } });
      expect(recorder.health().queued).toBe(1);
      await recorder.flush(1000);
      const business = target.stored.filter(entry => entry.record.source === "test");
      expect(business).toHaveLength(1);
      expect(business[0]?.record.repeat?.count).toBe(2);
      expect(recorder.health()).toMatchObject({ lost: 0, unconfirmed: 0 });
    } finally { await recorder.close(); }
  });

  it.each(["count", "bytes"])("preserves critical evidence within the same source's %s quota", async (dimension) => {
    const policy = validateLogPolicy({ ...DEFAULT_LOG_POLICY, recordBytes: 8192, queueRecords: 32, queueBytes: 16384, sourceQueueRecords: dimension === "count" ? 2 : 16 });
    const target = sink(policy), recorder = new LogRecorder(target, { policy }), port = recorder.bind(source, { scope: "storage" });
    const text = dimension === "bytes" ? "x".repeat(3000) : "short";
    try {
      for (let n = 0; n < 2; n++) port.record({ event: "detail", data: { n, text } });
      expect(recorder.health()).toMatchObject({ queued: 2, lost: 0 });
      port.record({ event: "error", data: { n: 99, text } });
      expect(recorder.health().queued).toBe(2);
      expect(recorder.health().queuedBytes).toBeLessThanOrEqual(policy.queueBytes / 2);
      await recorder.flush();
      expect(target.stored.filter(entry => entry.record.tier === "detail")).toHaveLength(1);
      expect(target.stored).toContainEqual(expect.objectContaining({ record: expect.objectContaining({ source: "test", tier: "critical", data: { n: 99, text } }) }));
      expect(recorder.health()).toMatchObject({ lost: 1, unconfirmed: 0 });
    } finally { await recorder.close(); }
  });

  it("drops a same-source attachment before an entire observation under byte pressure", async () => {
    const policy = validateLogPolicy({ ...DEFAULT_LOG_POLICY, recordBytes: 2048, queueBytes: 8192 });
    const target = sink(policy), recorder = new LogRecorder(target, { policy }), port = recorder.bind(source, { scope: "storage" });
    try {
      port.record({ event: "detail", data: { n: 1, text: "x".repeat(2800) } });
      port.record({ event: "error", data: { n: 2, text: "y".repeat(1000) } });
      await recorder.flush();
      expect(target.stored.filter(entry => entry.record.source === "test")).toHaveLength(2);
      expect(target.stored.find(entry => entry.record.tier === "detail")).toMatchObject({
        record: { gaps: [{ kind: "not-collected", reason: "detail-pressure" }] },
      });
      expect(target.stored.some(entry => entry.detail)).toBe(false);
      expect(recorder.health()).toMatchObject({ lost: 0, unconfirmed: 0 });
    } finally { await recorder.close(); }
  });

  it.each(["source", "global"])("never grows admitted entries when tiny detail cannot relieve %s pressure", async (mode) => {
    const policy = validateLogPolicy({ ...DEFAULT_LOG_POLICY, recordBytes: 2048, queueBytes: mode === "source" ? 8192 : 16384 });
    const target = sink(policy), recorder = new LogRecorder(target, { policy });
    const ports = Array.from({ length: mode === "source" ? 1 : 3 }, (_, index) =>
      recorder.bind({ ...source, id: `source-${index}` }, { scope: "storage" }));
    let rejected = 0;
    try {
      for (let n = 0; n < 24; n++) {
        const before = recorder.health();
        // A large legal envelope creates a small attachment even with empty data.
        ports[n % ports.length]!.record({
          event: "detail",
          refs: Array.from({ length: 16 }, (_, index) => ({ kind: "operation", id: `op-${n}-${index}-${"r".repeat(120)}` })),
        });
        const after = recorder.health();
        expect(after.queuedBytes).toBeLessThanOrEqual(policy.queueBytes - 4096);
        if (after.lost > before.lost) {
          rejected++;
          expect(after.queued).toBe(before.queued);
          expect(after.queuedBytes).toBeLessThanOrEqual(before.queuedBytes);
        }
      }
      expect(rejected).toBeGreaterThan(0);
      await recorder.flush();
      expect(target.stored.some(entry => entry.detail === "{}")).toBe(true);
      for (const portIndex of ports.keys()) {
        const captures = target.stored.filter(entry => entry.record.source === `source-${portIndex}`);
        expect(captures.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0)).toBeLessThanOrEqual(policy.queueBytes / 2);
      }
    } finally { await recorder.close(); }
  });

  it.each(["inflight", "critical-only"])("does not bypass source quotas or evict protected %s evidence", async (mode) => {
    const policy = validateLogPolicy({ ...DEFAULT_LOG_POLICY, sourceQueueRecords: 2 });
    const target = sink(policy), gate = pause(), started = pause(), append = target.append.bind(target);
    if (mode === "inflight") target.append = async (records) => { started.resolve(); await gate.promise; return append(records); };
    const recorder = new LogRecorder(target, { policy }), port = recorder.bind(source, { scope: "storage" });
    try {
      for (let n = 0; n < 2; n++) port.record({ event: mode === "inflight" ? "detail" : "error", data: { n } });
      if (mode === "inflight") { void recorder.start(0); await started.promise; }
      port.record({ event: "error", data: { n: 99 } });
      expect(recorder.health()).toMatchObject({ queued: 2, lost: 1 });
      gate.resolve();
      await recorder.flush();
      expect(target.stored.filter(entry => entry.record.source === "test").map(entry => entry.record.data.n)).toEqual([0, 1]);
    } finally { gate.resolve(); await recorder.close(); }
  });

  it("flushes its entire starting queue, aggregates storms and applies policy shrink", async () => {
    const small: LogPolicy = {
      ...DEFAULT_LOG_POLICY,
      queueRecords: 8,
      sourceQueueRecords: 4,
      queueBytes: 8192,
      recordBytes: 2048,
    };
    const target = sink(),
      recorder = new LogRecorder(target),
      port = recorder.bind(source, { scope: "storage" });
    for (let n = 0; n < 30; n++) port.record({ event: "error", data: { n } });
    await recorder.flush(5000);
    expect(target.stored.filter((entry) => entry.record.source === "test")).toHaveLength(30);
    for (let n = 0; n < 1000; n++) port.record({ event: "error", data: { text: "same" } });
    expect(recorder.health().queued).toBe(1);
    target.append = async (records) => {
      target.stored.push(...records);
      return status(small);
    };
    await recorder.flush();
    expect(target.stored.at(-1)!.record.repeat?.count).toBe(1000);
    for (let n = 0; n < 100; n++)
      port.record({ event: "error", data: { n, text: "x".repeat(4096) } });
    expect(recorder.health().queued).toBeLessThanOrEqual(small.queueRecords);
    expect(recorder.health().queuedBytes).toBeLessThanOrEqual(small.queueBytes);
    await recorder.close();
  });

  it("isolates capture/init/notification failures and rejects overflowing timer policies", async () => {
    const target = sink();
    target.initialize = async () => {
      throw Error("initialization failed");
    };
    const recorder = new LogRecorder(target, {
      onHealth: () => {
        throw Error("UI failed");
      },
    });
    const port = recorder.bind(source, { scope: "storage" });
    expect(() => port.record({ event: "unknown" })).not.toThrow();
    await recorder.start();
    expect(recorder.health().state).toBe("degraded");
    await recorder.close();
    expect(() =>
      validateLogPolicy({
        ...DEFAULT_LOG_POLICY,
        maintenanceMs: 2_147_483_648,
      }),
    ).toThrow();
  });
  it("never replays an unconfirmed batch and reports uncertainty separately from loss", async () => {
    const target = sink();
    let calls = 0;
    target.append = async (records) => {
      calls++;
      if (calls === 1) throw new LogAppendIndeterminateError();
      target.stored.push(...records);
      return status();
    };
    const recorder = new LogRecorder(target),
      port = recorder.bind(source, { scope: "storage" });
    port.record({ event: "error", data: { n: 1 } });
    await recorder.flush();
    expect(recorder.health().unconfirmed).toBe(1);
    expect(recorder.health().lost).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await recorder.flush();
    await recorder.close();
    expect(target.stored.some((entry) => entry.record.source === "test")).toBe(false);
    expect(
      target.stored.find((entry) => entry.record.source === "logging")?.record.data.unconfirmed,
    ).toBe(1);
  });

  it("advances a minimum-policy batch using physical rather than double-escaped queue bytes", async () => {
    const policy = validateLogPolicy({
      ...DEFAULT_LOG_POLICY,
      governanceBytes: 65536,
      maxFiles: 16,
      recordBytes: 2048,
      segmentBytes: 2048,
      attachmentBytes: 8192,
      maxBytes: 141312,
      queueBytes: 65536,
    });
    const target = sink(policy),
      recorder = new LogRecorder(target, { policy });
    recorder
      .bind(source, { scope: "storage" })
      .record({ event: "error", data: { text: '"'.repeat(3900) } });
    await recorder.flush();
    expect(recorder.health().queued).toBe(0);
    expect(target.stored).toHaveLength(1);
    expect(target.stored[0]?.detail).toBeDefined();
    await recorder.close();
  });

  it.each([
    { gap: "lost", published: false },
    { gap: "lost", published: true },
    { gap: "unconfirmed", published: false },
    { gap: "unconfirmed", published: true },
  ])("reports $gap after an unknown health write (published=$published) without new business input", async ({ gap, published }) => {
    vi.useFakeTimers();
    const target = sink();
    const attempts: LogCapture[][] = [];
    let healthAttempts = 0;
    target.append = async (records) => {
      attempts.push(structuredClone([...records]));
      if (records.some(entry => entry.record.source === "test"))
        throw new LogAppendIndeterminateError();
      if (++healthAttempts === 1) {
        if (published) target.stored.push(...records);
        throw new LogAppendIndeterminateError();
      }
      target.stored.push(...records);
      return status();
    };
    const recorder = new LogRecorder(target),
      port = recorder.bind(source, { scope: "storage" });
    try {
      port.record({ event: gap === "lost" ? "unknown-event" : "error" });
      await recorder.start();
      await vi.advanceTimersByTimeAsync(700);
      expect(recorder.health()).toMatchObject({
        state: "ready", queued: 0, lost: gap === "lost" ? 1 : 0,
        unconfirmed: gap === "unconfirmed" ? 1 : 0,
      });
      expect(attempts.flat().filter(entry => entry.record.source === "test")).toHaveLength(gap === "lost" ? 0 : 1);
      const notices = attempts.flat().filter(entry => entry.record.source === "logging" && entry.record.event === "degraded");
      expect(notices).toHaveLength(2);
      expect(new Set(notices.map(entry => entry.record.id)).size).toBe(2);
      expect(target.stored).toHaveLength(published ? 3 : 2);
      for (const entry of target.stored.filter(entry => entry.record.event === "degraded")) expect(entry.record.data).toMatchObject({
        lost: gap === "lost" ? 1 : 0, unconfirmed: gap === "unconfirmed" ? 1 : 0,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_LOG_POLICY.maintenanceMs * 2);
      expect(healthAttempts).toBe(3);
    } finally {
      const closing = recorder.close(50);
      await vi.advanceTimersByTimeAsync(50);
      await closing;
      vi.useRealTimers();
    }
  });

  it("preserves both old and new gaps when a health notice shares an unknown business batch", async () => {
    vi.useFakeTimers();
    const target = sink();
    const attempts: LogCapture[][] = [];
    target.append = async (records) => {
      attempts.push(structuredClone([...records]));
      if (attempts.length === 1) throw new LogAppendIndeterminateError();
      target.stored.push(...records);
      return status();
    };
    const recorder = new LogRecorder(target), port = recorder.bind(source, { scope: "storage" });
    try {
      port.record({ event: "unknown-event" });
      port.record({ event: "error", data: { n: 1 } });
      await recorder.start();
      port.record({ event: "unknown-event" });
      port.record({ event: "error", data: { n: 2 } });
      await vi.advanceTimersByTimeAsync(250);
      expect(attempts[0]?.map(entry => entry.record.source)).toEqual(["test", "logging"]);
      expect(target.stored.filter(entry => entry.record.source === "test").map(entry => entry.record.data.n)).toEqual([2]);
      expect(target.stored.find(entry => entry.record.source === "logging")?.record.data).toMatchObject({ lost: 2, unconfirmed: 1 });
      expect(recorder.health()).toMatchObject({ state: "ready", queued: 0, lost: 2, unconfirmed: 1 });
    } finally {
      const closing = recorder.close(50);
      await vi.advanceTimersByTimeAsync(50);
      await closing;
      vi.useRealTimers();
    }
  });

  it("bounds repeated health failures and shutdown without recursively counting notifications", async () => {
    vi.useFakeTimers();
    const target = sink(), attemptedAt: number[] = [], notices: LogCapture[] = [];
    target.append = async (records) => {
      attemptedAt.push(Date.now());
      notices.push(...records.filter(entry => entry.record.source === "logging"));
      throw new LogAppendIndeterminateError();
    };
    const recorder = new LogRecorder(target);
    try {
      recorder.bind(source, { scope: "storage" }).record({ event: "error" });
      await recorder.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attemptedAt.length).toBeGreaterThan(2);
      expect(attemptedAt.length).toBeLessThanOrEqual(10);
      expect(attemptedAt.slice(1).every((time, index) => time - attemptedAt[index]! >= 200)).toBe(true);
      expect(recorder.health()).toMatchObject({ state: "degraded", lost: 0, unconfirmed: 1, queued: 0 });
      expect(notices.every(entry => entry.record.data.unconfirmed === 1)).toBe(true);
      const before = attemptedAt.length, closing = recorder.close(50);
      await vi.advanceTimersByTimeAsync(50);
      await closing;
      expect(recorder.health()).toMatchObject({ state: "closed", lost: 0, unconfirmed: 1, queued: 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attemptedAt).toHaveLength(before);
    } finally {
      const closing = recorder.close(0);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      vi.useRealTimers();
    }
  });

  it("counts an in-flight shutdown as uncertain and incorporates its late durable receipt", async () => {
    const target = sink(),
      gate = pause(),
      started = pause();
    target.append = async () => {
      started.resolve();
      await gate.promise;
      return status();
    };
    const recorder = new LogRecorder(target);
    recorder.bind(source, { scope: "storage" }).record({ event: "error" });
    void recorder.start(0);
    await started.promise;
    await recorder.close(1);
    expect(recorder.health()).toMatchObject({ lost: 0, unconfirmed: 1, state: "closed" });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recorder.health()).toMatchObject({ lost: 0, unconfirmed: 0, state: "closed" });
  });

  it.each([false, true])("does not revive a closed recorder after a late health outcome (confirmed=%s)", async (confirmed) => {
    const target = sink(), gate = pause(), started = pause();
    target.append = vi.fn(async (records) => {
      started.resolve();
      await gate.promise;
      if (!confirmed) throw new LogAppendIndeterminateError();
      target.stored.push(...records);
      return status();
    });
    const recorder = new LogRecorder(target);
    recorder.bind(source, { scope: "storage" }).record({ event: "unknown-event" });
    void recorder.start(0);
    await started.promise;
    await recorder.close(1);
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(recorder.health()).toMatchObject({ state: "closed", queued: 0, lost: 1, unconfirmed: 0 });
    expect(target.append).toHaveBeenCalledOnce();
    expect(target.stored).toHaveLength(confirmed ? 1 : 0);
  });

  it("aggregates equal large details and truncates messages on UTF-8 boundaries", async () => {
    const target = sink(),
      recorder = new LogRecorder(target);
    const sourceWithMessage = {
      ...source,
      events: { ...source.events, error: { ...source.events.error!, message: "中".repeat(171) } },
    };
    const port = recorder.bind(sourceWithMessage, { scope: "storage" });
    for (let n = 0; n < 25; n++)
      port.record({ event: "error", data: { text: "d".repeat(50_000) } });
    await recorder.flush();
    await recorder.close();
    expect(target.stored).toHaveLength(1);
    expect(target.stored[0]?.record.repeat?.count).toBe(25);
    expect(Buffer.byteLength(target.stored[0]!.record.message)).toBeLessThanOrEqual(512);
    expect(target.stored[0]!.record.message).not.toContain("\ufffd");
  });
});
