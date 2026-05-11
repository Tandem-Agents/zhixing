/**
 * 架构契约测试 —— 双 accumulator 协同与优先级。
 *
 * 验证 run-end 关键决策的语义不变量：
 *   compactBefore = segmentAccumulator.getMarker() ?? compactAccumulator.getMarker()
 *
 * 这是 create-agent-runtime.ts run() 路径的核心选择逻辑。两个 accumulator
 * 在同一 EventBus 上独立工作，监听不同的事件源：
 *   - compactAccumulator 监听 context:compact_end —— LLMSummarize 走的事件
 *   - segmentAccumulator 监听 segment:new_started —— SegmentManager 走的事件
 *
 * 单 run 内两者通常不会同时触发（attention 阈值远早于 budget critical），
 * 但 marker 选择优先级仍要严格定义：segment > compact（段切换 marker 含
 * segmentId / structuredSummary 等结构化信息，应优先采用）。
 *
 * 本测试用真实 EventBus + 真实两个 accumulator，直接验证：
 *   - 两类事件流互不干扰（不串台）
 *   - 优先级选择逻辑（手动模拟 run-agent 端 ??）
 *   - dispose 互相独立
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentEventMap,
  CompactMarker,
  CompactStrategyContribution,
} from "@zhixing/core";
import { EventBus } from "@zhixing/core";
import {
  subscribeCompactAccumulator,
  type CompactAccumulator,
} from "../compact-accumulator.js";
import {
  subscribeSegmentMarkerAccumulator,
  type SegmentMarkerAccumulator,
} from "../segment-marker-accumulator.js";

// ─── Fixtures ───

let bus: EventBus<AgentEventMap>;
let compactAcc: CompactAccumulator;
let segmentAcc: SegmentMarkerAccumulator;

beforeEach(() => {
  bus = new EventBus<AgentEventMap>();
  compactAcc = subscribeCompactAccumulator(bus);
  segmentAcc = subscribeSegmentMarkerAccumulator(bus);
});

afterEach(() => {
  compactAcc.dispose();
  segmentAcc.dispose();
});

function segmentMarker(segmentId: string): CompactMarker {
  return {
    type: "compact",
    timestamp: "2026-05-11T10:00:00Z",
    summary: `segment summary ${segmentId}`,
    turnsCompacted: 5,
    tokensBefore: 200_000,
    tokensAfter: 5_000,
    segmentId,
    structuredSummary: { facts: "F", state: "S", active: "A" },
  };
}

async function emitSegment(marker: CompactMarker): Promise<void> {
  await bus.emit("segment:new_started", {
    segmentId: marker.segmentId!,
    bufferTurns: 2,
    tokensBefore: marker.tokensBefore,
    tokensAfter: marker.tokensAfter,
    marker,
  });
}

async function emitCompact(opts: {
  summary: string;
  turnsCompacted: number;
}): Promise<void> {
  const contribution: CompactStrategyContribution = {
    name: "llm-summarize",
    success: true,
    tokensBefore: 100_000,
    tokensAfter: 10_000,
    summary: opts.summary,
    turnsCompacted: opts.turnsCompacted,
  };
  await bus.emit("context:compact_end", {
    strategies: [contribution],
    summary: opts.summary,
    turnsCompacted: opts.turnsCompacted,
    tokensBefore: 100_000,
    tokensAfter: 10_000,
  });
}

/**
 * 模拟 create-agent-runtime.ts run-end 处的 marker 选择逻辑：
 *   compactBefore = segmentAcc.getMarker() ?? compactAcc.getMarker()
 */
function selectMarker(): CompactMarker | undefined {
  return segmentAcc.getMarker() ?? compactAcc.getMarker();
}

// ─── 优先级契约 ───

describe("双 accumulator 优先级 —— segment > compact", () => {
  it("两者都未 fire → undefined", () => {
    expect(selectMarker()).toBeUndefined();
  });

  it("仅 segment fire → 用 segment marker", async () => {
    await emitSegment(segmentMarker("seg-only"));

    const selected = selectMarker();
    expect(selected).toBeDefined();
    expect(selected!.segmentId).toBe("seg-only");
    expect(selected!.structuredSummary).toBeDefined();
  });

  it("仅 compact fire → 用 compact marker（兜底路径）", async () => {
    await emitCompact({ summary: "fallback summary", turnsCompacted: 3 });

    const selected = selectMarker();
    expect(selected).toBeDefined();
    expect(selected!.summary).toBe("fallback summary");
    expect(selected!.turnsCompacted).toBe(3);
    // compact marker 路径不含结构化摘要
    expect(selected!.segmentId).toBeUndefined();
    expect(selected!.structuredSummary).toBeUndefined();
  });

  it("两者都 fire → segment 优先（更丰富结构化信息）", async () => {
    await emitCompact({ summary: "compact summary", turnsCompacted: 3 });
    await emitSegment(segmentMarker("seg-wins"));

    const selected = selectMarker();
    expect(selected!.segmentId).toBe("seg-wins");
    expect(selected!.structuredSummary).toBeDefined();
    expect(selected!.summary).toContain("seg-wins"); // segment 的，不是 compact 的
  });

  it("两者都 fire（compact 后到也不影响）→ segment 优先", async () => {
    await emitSegment(segmentMarker("seg-first"));
    await emitCompact({ summary: "compact later", turnsCompacted: 3 });

    const selected = selectMarker();
    expect(selected!.segmentId).toBe("seg-first");
  });
});

// ─── 事件流互不干扰 ───

describe("两类事件源互相独立", () => {
  it("segment 事件不写 compact accumulator", async () => {
    await emitSegment(segmentMarker("seg-1"));

    expect(compactAcc.getMarker()).toBeUndefined();
    expect(segmentAcc.getMarker()).toBeDefined();
  });

  it("compact 事件不写 segment accumulator", async () => {
    await emitCompact({ summary: "x", turnsCompacted: 1 });

    expect(segmentAcc.getMarker()).toBeUndefined();
    expect(compactAcc.getMarker()).toBeDefined();
  });
});

// ─── dispose 互相独立 ───

describe("dispose 互不影响", () => {
  it("dispose segment accumulator 后 compact accumulator 仍工作", async () => {
    segmentAcc.dispose();
    await emitCompact({ summary: "still works", turnsCompacted: 1 });

    expect(compactAcc.getMarker()).toBeDefined();
    expect(compactAcc.getMarker()!.summary).toBe("still works");
    expect(segmentAcc.getMarker()).toBeUndefined();
  });

  it("dispose compact accumulator 后 segment accumulator 仍工作", async () => {
    compactAcc.dispose();
    await emitSegment(segmentMarker("seg-survived"));

    expect(segmentAcc.getMarker()).toBeDefined();
    expect(segmentAcc.getMarker()!.segmentId).toBe("seg-survived");
    expect(compactAcc.getMarker()).toBeUndefined();
  });

  it("dispose 两个 accumulator 都不收集后续事件", async () => {
    segmentAcc.dispose();
    compactAcc.dispose();

    await emitSegment(segmentMarker("seg-after"));
    await emitCompact({ summary: "compact after", turnsCompacted: 1 });

    expect(segmentAcc.getMarker()).toBeUndefined();
    expect(compactAcc.getMarker()).toBeUndefined();
  });
});
