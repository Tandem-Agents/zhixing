/**
 * createSegmentPersistence 装配测试。
 *
 * SegmentPersistence 接口仅承担 segmentMetadata 累积写入。transcript marker
 * 不走本接口（通过 segment:new_started 事件 → orchestrator accumulator →
 * run-agent 单点 commitTurn 路径落盘）。
 */

import { describe, expect, it, vi } from "vitest";
import type { SegmentMeta } from "../../../conversation/types.js";
import {
  createSegmentPersistence,
  type ConversationSegmentRepo,
} from "../persist.js";

function makeRepo(): ConversationSegmentRepo & {
  calls: { id: string; meta: SegmentMeta }[];
} {
  const calls: { id: string; meta: SegmentMeta }[] = [];
  return {
    calls,
    async appendSegmentMeta(id, meta) {
      calls.push({ id, meta });
    },
  };
}

const sampleMeta: SegmentMeta = {
  segmentId: "seg-abc",
  timestamp: "2026-05-11T10:00:00Z",
  tokensBefore: 100_000,
  tokensAfter: 5_000,
};

describe("createSegmentPersistence", () => {
  it("appendSegment 透传给 conversationRepo.appendSegmentMeta", async () => {
    const conversationRepo = makeRepo();
    const persistence = createSegmentPersistence({ conversationRepo });

    await persistence.appendSegment("conv-2", sampleMeta);

    expect(conversationRepo.calls).toEqual([{ id: "conv-2", meta: sampleMeta }]);
  });

  it("仅暴露 appendSegment 方法（接口隔离）", () => {
    const conversationRepo = makeRepo();
    const persistence = createSegmentPersistence({ conversationRepo });

    expect(typeof persistence.appendSegment).toBe("function");
    expect((persistence as Record<string, unknown>).writeMarker).toBeUndefined();
  });

  it("底层 repo 抛错 → appendSegment rethrow（调用方决定降级策略）", async () => {
    const conversationRepo: ConversationSegmentRepo = {
      appendSegmentMeta: vi.fn().mockRejectedValue(new Error("lock contention")),
    };
    const persistence = createSegmentPersistence({ conversationRepo });

    await expect(
      persistence.appendSegment("conv-5", sampleMeta),
    ).rejects.toThrow("lock contention");
  });

  it("多次调 appendSegment 顺序透传", async () => {
    const conversationRepo = makeRepo();
    const persistence = createSegmentPersistence({ conversationRepo });

    await persistence.appendSegment("conv-1", { ...sampleMeta, segmentId: "s1" });
    await persistence.appendSegment("conv-1", { ...sampleMeta, segmentId: "s2" });

    expect(conversationRepo.calls).toHaveLength(2);
    expect(conversationRepo.calls[0]!.meta.segmentId).toBe("s1");
    expect(conversationRepo.calls[1]!.meta.segmentId).toBe("s2");
  });
});
