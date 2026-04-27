import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import { abortWithReason, createInterruptController } from "../controller.js";
import { wrapStreamWithWatchdog } from "../watchdog.js";

/**
 * 永不 yield 也永不 done 的 stream —— 模拟 LLM 静默挂死。
 *
 * 注意: next() 返回的是真正的"永不 settle" promise (`new Promise(() => {})`),
 * 不依赖 setTimeout, 因此 vi.useFakeTimers() 不会让它意外 resolve。
 */
function neverEndingStream(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<string>>(() => {
            /* never resolves */
          });
        },
      };
    },
  };
}

/**
 * 受控 stream: 在外部 trigger() 之前 next() 一直 hang, trigger 后 yield 一个值。
 * 用于精确控制 chunk 到达时机, 配合 fake timer 测试 reset 语义。
 */
function controlledStream<T>(): {
  stream: AsyncIterable<T>;
  emit: (value: T) => void;
  end: () => void;
} {
  const queue: T[] = [];
  let pendingResolve: ((r: IteratorResult<T>) => void) | null = null;
  let ended = false;

  const drainPending = () => {
    if (pendingResolve === null) return;
    if (ended && queue.length === 0) {
      const r = pendingResolve;
      pendingResolve = null;
      r({ done: true, value: undefined });
      return;
    }
    if (queue.length > 0) {
      const r = pendingResolve;
      pendingResolve = null;
      r({ done: false, value: queue.shift() as T });
    }
  };

  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (queue.length > 0) {
              return Promise.resolve({ done: false, value: queue.shift() as T });
            }
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise<IteratorResult<T>>((resolve) => {
              pendingResolve = resolve;
            });
          },
        };
      },
    },
    emit(value: T) {
      queue.push(value);
      drainPending();
    },
    end() {
      ended = true;
      drainPending();
    },
  };
}

/** 受控 stream: 一次性 push 全部 items, 适用于不需要时间控制的场景。 */
function arrayStream<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (i >= items.length) return { done: true, value: undefined };
          const v = items[i]!;
          i++;
          return { done: false, value: v };
        },
      };
    },
  };
}

/** 第一次 next 就 throw, 验证 finally 清理路径。 */
function throwingStream(message: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          throw new Error(message);
        },
      };
    },
  };
}

/** drain 一个 wrapped stream 直到结束(或抛错)。 */
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of stream) out.push(v);
  return out;
}

function countAbortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

// ─── 主行为 ───

describe("wrapStreamWithWatchdog: idle-timer 触发", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 静默 watchdog WARN 日志, 避免污染 vitest 输出;
    // 日志格式由独立"日志格式契约"测试断言, 此处仅 swallow
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("chunk 间隔超 idleTimeoutMs → 触发 abort with idle-timeout reason", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });

    const consumer = drain(wrapped);

    // 推到 60s = 触发 abortTimer
    await vi.advanceTimersByTimeAsync(60_000);
    await consumer;

    expect(c.signal.aborted).toBe(true);
    const reason = c.signal.reason as { kind: string; timeoutMs?: number; chunksReceived?: number };
    expect(reason.kind).toBe("idle-timeout");
    expect(reason.timeoutMs).toBe(60_000);
    expect(reason.chunksReceived).toBe(0);
  });

  it("warn 阈值触发 → emit interrupt:warn (不 abort)", async () => {
    const c = createInterruptController();
    const bus = createEventBus<AgentEventMap>();
    const warns: { kind: string; chunksReceived: number; timeoutMs: number }[] = [];
    bus.on("interrupt:warn", (e) => {
      warns.push({ kind: e.kind, chunksReceived: e.chunksReceived, timeoutMs: e.timeoutMs });
    });

    const wrapped = wrapStreamWithWatchdog(
      neverEndingStream(),
      c,
      { idleTimeoutMs: 60_000, warnThresholdRatio: 0.5 },
      bus,
    );
    const consumer = drain(wrapped);

    // 推到 30s (50% × 60s) → warn 应触发, abort 还没到
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ kind: "idle-timeout-warn", timeoutMs: 60_000, chunksReceived: 0 });
    expect(c.signal.aborted).toBe(false);

    // 再推 30s 到 60s → abort 触发
    await vi.advanceTimersByTimeAsync(30_000);
    await consumer;
    expect(c.signal.aborted).toBe(true);
  });

  it("chunk 在 warn 后到达 → reset, 新周期 30s 后再次 warn", async () => {
    const c = createInterruptController();
    const bus = createEventBus<AgentEventMap>();
    const warns: number[] = [];
    bus.on("interrupt:warn", (e) => {
      warns.push(e.chunksReceived);
    });

    const ctrl = controlledStream<string>();
    const wrapped = wrapStreamWithWatchdog(
      ctrl.stream,
      c,
      { idleTimeoutMs: 60_000, warnThresholdRatio: 0.5 },
      bus,
    );

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of wrapped) collected.push(v);
    })();

    // 30s warn 触发
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warns).toEqual([0]);

    // 50s 时收到一个 chunk → reset (距上次 chunk 50s, 还没到 60s abort)
    await vi.advanceTimersByTimeAsync(20_000);
    ctrl.emit("a");
    // 让 yield 流转
    await vi.advanceTimersByTimeAsync(0);
    expect(collected).toEqual(["a"]);
    expect(c.signal.aborted).toBe(false);

    // 新周期: 再走 30s 触发 warn (chunksReceived=1 反映 reset 后状态)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warns).toEqual([0, 1]);

    // 关闭 stream, 等 consumer 收尾
    ctrl.end();
    abortWithReason(c, { kind: "external", origin: "cleanup" });
    await consumer;
  });

  it("每次 chunk 到达即 reset → 永不触发 warn/abort", async () => {
    const c = createInterruptController();
    const bus = createEventBus<AgentEventMap>();
    const warns: unknown[] = [];
    bus.on("interrupt:warn", (e) => warns.push(e));

    const ctrl = controlledStream<string>();
    const wrapped = wrapStreamWithWatchdog(
      ctrl.stream,
      c,
      { idleTimeoutMs: 60_000, warnThresholdRatio: 0.5 },
      bus,
    );

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of wrapped) collected.push(v);
    })();

    // 5 个 chunk, 每隔 5s 一个 → 总共 25s, 远低于 30s warn 阈值
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      ctrl.emit(`c${i}`);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(collected).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(warns).toEqual([]);
    expect(c.signal.aborted).toBe(false);

    ctrl.end();
    await consumer;
  });
});

// ─── race 与 idle-timer 解耦: race 总是生效 ───

describe("wrapStreamWithWatchdog: race 是基础能力,与 idle-timer 是否启用无关", () => {
  it("idleTimeoutMs=0 (idle-timer disabled) 但外部 abort 仍能让 stream 立即退出", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 0,
      warnThresholdRatio: 0.5,
    });
    const consumer = drain(wrapped);

    // 5ms 后触发外部 abort → race 应在 ≤50ms (CI 抖动余量) 让 consumer 退出
    await new Promise<void>((r) => setTimeout(r, 5));
    const t0 = performance.now();
    abortWithReason(c, { kind: "user-cancel", source: "esc", pressedAt: Date.now() });
    await consumer;
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50);
  });

  it("idleTimeoutMs=60000 启用 idle-timer, 外部 abort 先于看门狗 → race 立即退出", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    const consumer = drain(wrapped);

    await new Promise<void>((r) => setTimeout(r, 5));
    const t0 = performance.now();
    abortWithReason(c, { kind: "external", origin: "test" });
    await consumer;
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(50);
    // 外部触发的 reason 不会被 idle-timer 覆盖 (idempotent)
    const reason = c.signal.reason as { kind: string };
    expect(reason.kind).toBe("external");
  });

  it("已 aborted signal → consumer 立即退出, 不 arm timer", async () => {
    const c = createInterruptController();
    abortWithReason(c, { kind: "external", origin: "pre-aborted" });

    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    expect(await drain(wrapped)).toEqual([]);
    // pre-aborted 路径下 race 直接返回 done, idle-timer wrap 也不该残留 timer
  });
});

// ─── 资源回收: 任何终态都清理 timer 与 listener ───

describe("wrapStreamWithWatchdog: 资源回收(终态 timer 清零, listener 不增长)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 静默 watchdog WARN 日志, 避免污染 vitest 输出;
    // 日志格式由独立"日志格式契约"测试断言, 此处仅 swallow
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("正常结束 → timer 清零, listener 清零", async () => {
    const c = createInterruptController();
    const before = countAbortListeners(c.signal);
    const wrapped = wrapStreamWithWatchdog(arrayStream(["a", "b", "c"]), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });

    expect(await drain(wrapped)).toEqual(["a", "b", "c"]);

    expect(vi.getTimerCount()).toBe(0);
    expect(countAbortListeners(c.signal)).toBe(before);
  });

  it("idle-timer 触发 abort → timer 清零, listener 清零", async () => {
    const c = createInterruptController();
    const before = countAbortListeners(c.signal);
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    const consumer = drain(wrapped);

    await vi.advanceTimersByTimeAsync(60_000);
    await consumer;

    expect(vi.getTimerCount()).toBe(0);
    expect(countAbortListeners(c.signal)).toBe(before);
  });

  it("底层 throw → timer 清零(finally 兜底)", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(throwingStream("boom"), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });

    await expect(drain(wrapped)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── 日志格式契约 ───
//
// REPL / CI 用户依赖 stderr 看"流即将超时" / "流被中断" 信号, 不依赖 EventBus 订阅。
// 格式锚定避免后续无意改动破坏运维诊断 (例如 grep [watchdog] 的告警链路)。

describe("wrapStreamWithWatchdog: 日志格式契约", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("warn 触发 → stderr 格式 `[watchdog] stream idle Ns/Ms, K chunks`", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    const consumer = drain(wrapped);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnSpy).toHaveBeenCalledWith("[watchdog] stream idle 30s/60s, 0 chunks");

    await vi.advanceTimersByTimeAsync(30_000);
    await consumer;
  });

  it("abort 触发 → stderr 格式 `[watchdog] stream idle timeout, aborting`", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    const consumer = drain(wrapped);

    await vi.advanceTimersByTimeAsync(60_000);
    await consumer;

    expect(warnSpy).toHaveBeenCalledWith("[watchdog] stream idle timeout, aborting");
  });

  it("warn 日志反映已收到的 chunk 数 (不是 0)", async () => {
    const c = createInterruptController();
    const ctrl = controlledStream<string>();
    const wrapped = wrapStreamWithWatchdog(ctrl.stream, c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    const consumer = (async () => {
      for await (const _v of wrapped) {
        // drain
      }
    })();

    // 推 5s 后 emit 2 个 chunk → chunksReceived=2
    await vi.advanceTimersByTimeAsync(5_000);
    ctrl.emit("a");
    await vi.advanceTimersByTimeAsync(0);
    ctrl.emit("b");
    await vi.advanceTimersByTimeAsync(0);

    // 第二个 chunk 后再走 30s → warn 触发, 日志中 K=2
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warnSpy).toHaveBeenCalledWith("[watchdog] stream idle 30s/60s, 2 chunks");

    ctrl.end();
    abortWithReason(c, { kind: "external", origin: "cleanup" });
    await consumer;
  });
});

// ─── 容错: 缺省 eventBus / 失败 emit ───

describe("wrapStreamWithWatchdog: 容错路径", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 静默 watchdog WARN 日志, 避免污染 vitest 输出;
    // 日志格式由独立"日志格式契约"测试断言, 此处仅 swallow
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("缺省 eventBus → warn 阈值无 emit 也无 throw", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithWatchdog(neverEndingStream(), c, {
      idleTimeoutMs: 60_000,
      warnThresholdRatio: 0.5,
    });
    const consumer = drain(wrapped);

    // 推到 30s warn 时间点 → 不应该 throw
    await vi.advanceTimersByTimeAsync(30_000);
    // 推到 60s abort 时间点 → 仍按预期触发 abort
    await vi.advanceTimersByTimeAsync(30_000);
    await consumer;

    expect(c.signal.aborted).toBe(true);
  });

  it("emit 抛错 → 被 .catch swallow, stream 仍正常 abort 退出", async () => {
    const c = createInterruptController();
    // 自制 EventBus mock: emit 永远 reject
    const bus = {
      emit: vi.fn().mockRejectedValue(new Error("subscriber boom")),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as ReturnType<typeof createEventBus<AgentEventMap>>;

    const wrapped = wrapStreamWithWatchdog(
      neverEndingStream(),
      c,
      { idleTimeoutMs: 60_000, warnThresholdRatio: 0.5 },
      bus,
    );
    const consumer = drain(wrapped);

    // 30s emit warn → 拒绝但被 .catch 吃掉
    await vi.advanceTimersByTimeAsync(30_000);
    // 60s abort 触发
    await vi.advanceTimersByTimeAsync(30_000);
    await consumer;

    expect(c.signal.aborted).toBe(true);
    // 验证 emit 确实被调用且抛错
    expect(bus.emit).toHaveBeenCalled();
  });
});
