import { describe, expect, it, vi } from "vitest";
import { bindLogSource, captureLog } from "./capture.js";
import { LogRecorder } from "./recorder.js";
import { DEFAULT_LOG_POLICY, validateLogPolicy } from "./policy.js";
import { LogAppendIndeterminateError } from "./contracts.js";
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
    expect(attempts).toHaveLength(2);
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
      await vi.waitFor(() => expect(target.stored).toHaveLength(1));
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
      await vi.waitFor(() => expect(target.stored).toHaveLength(2));
      expect(target.append).toHaveBeenCalledTimes(2);
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

  it("does not recursively report failure of a health report", async () => {
    const target = sink();
    let calls = 0;
    target.append = async () => {
      calls++;
      throw new LogAppendIndeterminateError();
    };
    const recorder = new LogRecorder(target),
      port = recorder.bind(source, { scope: "storage" });
    port.record({ event: "error" });
    await recorder.flush();
    await recorder.flush();
    await recorder.flush();
    await recorder.flush();
    expect(calls).toBe(2);
    expect(recorder.health().unconfirmed).toBe(1);
    expect(recorder.health().queued).toBe(0);
    await recorder.close();
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
