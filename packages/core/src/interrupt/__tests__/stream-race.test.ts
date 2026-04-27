import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { abortWithReason, createInterruptController } from "../controller.js";
import { wrapStreamWithAbortRace } from "../stream-race.js";

/** 永不 yield 也永不 done 的 stream(模拟 LLM 静默挂死)。 */
function neverEndingStream(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          // 永远不 settle 的 promise——模拟 SDK 不响应 abort 的最坏情况
          return new Promise<IteratorResult<string>>(() => {
            /* never resolves */
          });
        },
      };
    },
  };
}

/** 受控 stream:每次 next 返回一个 chunk,items 耗尽后 done。 */
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

/** 第一次 next 就 throw 的 stream,模拟 SDK 抛 AbortError 之外的非预期错误。 */
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

/** 用 wrap 消费一个 stream 直到结束(或抛错),用于测试 listener 清理。 */
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of stream) out.push(v);
  return out;
}

describe("wrapStreamWithAbortRace", () => {
  it("底层 stream 永远 hang,abort 触发后短时间内返回 done", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithAbortRace(neverEndingStream(), c);

    const consumer = drain(wrapped);

    await new Promise<void>((r) => setTimeout(r, 5));
    const t0 = performance.now();
    abortWithReason(c, { kind: "user-cancel", source: "esc", pressedAt: Date.now() });

    const result = await consumer;
    const elapsed = performance.now() - t0;

    expect(result).toEqual([]);
    // 设计目标 ≤10ms;CI 上抖动放宽到 50ms。如果这个数值长期不达标,
    // 说明 race 机制本身有问题(比如有谁挡在 then 回调前阻塞 microtask)。
    expect(elapsed).toBeLessThan(50);
  });

  it("正常 stream(无 abort)→ 完整 yield 所有 chunk", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithAbortRace(arrayStream(["a", "b", "c"]), c);

    expect(await drain(wrapped)).toEqual(["a", "b", "c"]);
  });

  it("已 aborted signal → consumer 立即拿到 done,不消费底层 iterator", async () => {
    const c = createInterruptController();
    abortWithReason(c, { kind: "external", origin: "pre-aborted" });

    let consumed = 0;
    const probe: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            consumed++;
            return { done: false, value: "x" };
          },
        };
      },
    };

    const wrapped = wrapStreamWithAbortRace(probe, c);
    expect(await drain(wrapped)).toEqual([]);
    expect(consumed).toBe(0);
  });

  it("底层 stream throw → wrapped 也 throw(异常向上传播)", async () => {
    const c = createInterruptController();
    const wrapped = wrapStreamWithAbortRace(throwingStream("boom"), c);

    await expect(drain(wrapped)).rejects.toThrow("boom");
  });
});

// ─── 资源回收:任何终态都不能泄漏 abort listener ───
//
// 用 Node 的 events.getEventListeners 直接观测 controller.signal 上的 abort
// listener 数。每个测试在 wrap 操作前后取 snapshot 比较,差值必须为 0。
// 这是 race 实现里"settle 后立即 cleanup"契约的端到端验证。

describe("wrapStreamWithAbortRace 资源回收", () => {
  it("正常结束 → listener 清零", async () => {
    const c = createInterruptController();
    const before = countAbortListeners(c.signal);

    const wrapped = wrapStreamWithAbortRace(arrayStream(["a", "b"]), c);
    await drain(wrapped);

    expect(countAbortListeners(c.signal)).toBe(before);
  });

  it("中途 abort → listener 清零", async () => {
    const c = createInterruptController();
    const before = countAbortListeners(c.signal);

    const wrapped = wrapStreamWithAbortRace(neverEndingStream(), c);
    const consumer = drain(wrapped);

    await new Promise<void>((r) => setTimeout(r, 5));
    abortWithReason(c, { kind: "external", origin: "test" });
    await consumer;

    expect(countAbortListeners(c.signal)).toBe(before);
  });

  it("底层抛错 → listener 清零", async () => {
    const c = createInterruptController();
    const before = countAbortListeners(c.signal);

    const wrapped = wrapStreamWithAbortRace(throwingStream("boom"), c);
    await expect(drain(wrapped)).rejects.toThrow("boom");

    expect(countAbortListeners(c.signal)).toBe(before);
  });
});

/** Node 的 events.getEventListeners 适配 EventTarget 的"abort"事件 listener 数。 */
function countAbortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}
