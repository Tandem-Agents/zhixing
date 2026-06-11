/**
 * subscribeSegmentMarkerAccumulator 单元测试。
 *
 * 覆盖契约：
 *   - 收集 `segment:new_started` 事件 payload.windowCompact
 *   - 单 run 内重复触发取最新（覆盖式，不累加）
 *   - dispose 幂等
 */

import { describe, expect, it } from "vitest";
import type { AgentEventMap, WindowCompact } from "@zhixing/core";
import { EventBus } from "@zhixing/core";
import { subscribeSegmentMarkerAccumulator } from "../segment-marker-accumulator.js";

function makeBus(): EventBus<AgentEventMap> {
  return new EventBus<AgentEventMap>();
}

function makeWindowCompact(
  segmentId: string,
  overrides: Partial<WindowCompact> = {},
): WindowCompact {
  return {
    summary: `summary ${segmentId}`,
    pairsCompacted: 5,
    tokensBefore: 100_000,
    tokensAfter: 5_000,
    segmentId,
    structuredSummary: { facts: "F", state: "S", active: "A" },
    ...overrides,
  };
}

function makeEvent(
  windowCompact: WindowCompact,
): AgentEventMap["segment:new_started"] {
  return {
    segmentId: windowCompact.segmentId!,
    bufferTurns: 2,
    tokensBefore: windowCompact.tokensBefore,
    tokensAfter: windowCompact.tokensAfter,
    windowCompact,
  };
}

describe("subscribeSegmentMarkerAccumulator", () => {
  it("从未 fire 时 getWindowCompact 返回 undefined", () => {
    const bus = makeBus();
    const acc = subscribeSegmentMarkerAccumulator(bus);
    expect(acc.getWindowCompact()).toBeUndefined();
  });

  it("一次 fire 后 getWindowCompact 返回完整 wc", async () => {
    const bus = makeBus();
    const acc = subscribeSegmentMarkerAccumulator(bus);
    const wc = makeWindowCompact("seg-1");

    await bus.emit("segment:new_started", makeEvent(wc));

    expect(acc.getWindowCompact()).toEqual(wc);
  });

  it("多次 fire 取最新（覆盖式，不累加）", async () => {
    const bus = makeBus();
    const acc = subscribeSegmentMarkerAccumulator(bus);
    const m1 = makeWindowCompact("seg-1");
    const m2 = makeWindowCompact("seg-2", { summary: "更新后的摘要" });

    await bus.emit("segment:new_started", makeEvent(m1));
    await bus.emit("segment:new_started", makeEvent(m2));

    expect(acc.getWindowCompact()).toEqual(m2);
    expect(acc.getWindowCompact()?.segmentId).toBe("seg-2");
  });

  it("dispose 后 emit 不再被收集", async () => {
    const bus = makeBus();
    const acc = subscribeSegmentMarkerAccumulator(bus);
    const m1 = makeWindowCompact("seg-before-dispose");

    await bus.emit("segment:new_started", makeEvent(m1));
    expect(acc.getWindowCompact()).toEqual(m1);

    acc.dispose();

    const m2 = makeWindowCompact("seg-after-dispose");
    await bus.emit("segment:new_started", makeEvent(m2));

    // dispose 后 emit 不再被记录，getMarker 仍是 dispose 前的最后值
    expect(acc.getWindowCompact()).toEqual(m1);
  });

  it("dispose 幂等 —— 多次调用不抛错", () => {
    const bus = makeBus();
    const acc = subscribeSegmentMarkerAccumulator(bus);
    expect(() => acc.dispose()).not.toThrow();
    expect(() => acc.dispose()).not.toThrow();
    expect(() => acc.dispose()).not.toThrow();
  });

  it("wc 保留 segmentId + structuredSummary 等所有字段", async () => {
    const bus = makeBus();
    const acc = subscribeSegmentMarkerAccumulator(bus);
    const wc = makeWindowCompact("seg-x", {
      summary: "三段平文本",
      structuredSummary: {
        facts: "事实",
        state: "状态",
        active: "锚点",
      },
    });

    await bus.emit("segment:new_started", makeEvent(wc));

    const got = acc.getWindowCompact()!;
    expect(got.segmentId).toBe("seg-x");
    expect(got.structuredSummary).toEqual({
      facts: "事实",
      state: "状态",
      active: "锚点",
    });
    expect(got.summary).toBe("三段平文本");
  });
});
