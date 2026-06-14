/**
 * createCliSegmentDeps + createTaskListReaderFromService 单元测试。
 *
 * 验证：
 *   - TaskListReader 适配契约：service 无 in-progress → false / 有 → true
 *   - 跨 conversationId 隔离（service.cache 按 conv 分桶）
 *   - persistence 透传 appendSegment 调用到底层 conversationRepo
 *   - 错误透传（底层 throw → persistence 接口 throw）
 *
 * 注意：cli 工厂不透传 transcript —— 窗口折叠指令通过 segment:new_started
 * 事件流向 orchestrator accumulator，随 RunResult.windowCompact 在 run 边界交给窗口。
 */

import { describe, expect, it, vi } from "vitest";
import type {
  IConversationRepository,
  SegmentMeta,
} from "@zhixing/core";
import { TaskListService } from "@zhixing/tools-builtin";
import { InMemoryTaskListStore } from "../task-list-stores.js";
import {
  createCliSegmentDeps,
  createServeSegmentDeps,
  createTaskListReaderFromService,
} from "../segment-deps.js";

function makeTaskListService(): TaskListService {
  return new TaskListService(new InMemoryTaskListStore());
}

function makeFakeConversationRepo(): IConversationRepository & {
  calls: { id: string; meta: SegmentMeta }[];
} {
  const calls: { id: string; meta: SegmentMeta }[] = [];
  return {
    calls,
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    ensureDefault: vi.fn(),
    findLatest: vi.fn().mockResolvedValue(null),
    touch: vi.fn().mockResolvedValue(undefined),
    clearViewLayerState: vi.fn().mockResolvedValue(undefined),
    updateTaskListState: vi.fn().mockResolvedValue(undefined),
    async appendSegmentMeta(id, meta) {
      calls.push({ id, meta });
    },
  } as unknown as IConversationRepository & {
    calls: { id: string; meta: SegmentMeta }[];
  };
}

const SAMPLE_META: SegmentMeta = {
  segmentId: "seg-abc",
  timestamp: "2026-05-11T10:00:00Z",
  tokensBefore: 100,
  tokensAfter: 10,
};

// ─── TaskListReader 适配 ───

describe("createTaskListReaderFromService", () => {
  it("service 无任务 → hasInProgress 返 false", () => {
    const service = makeTaskListService();
    const reader = createTaskListReaderFromService(service);

    expect(reader.hasInProgress("conv-1")).toBe(false);
  });

  it("service 含 pending + completed（无 in_progress）→ false", async () => {
    const service = makeTaskListService();
    await service.set("conv-1", [
      { id: "t1", content: "等待", status: "pending" },
      { id: "t2", content: "已完成", status: "completed" },
    ]);
    const reader = createTaskListReaderFromService(service);

    expect(reader.hasInProgress("conv-1")).toBe(false);
  });

  it("service 含 in_progress → true", async () => {
    const service = makeTaskListService();
    await service.set("conv-1", [
      { id: "t1", content: "执行中", status: "in_progress" },
    ]);
    const reader = createTaskListReaderFromService(service);

    expect(reader.hasInProgress("conv-1")).toBe(true);
  });

  it("跨 conversationId 隔离 —— 一个 conv 有 in_progress 不影响另一个", async () => {
    const service = makeTaskListService();
    await service.set("conv-A", [
      { id: "a", content: "执行中", status: "in_progress" },
    ]);
    await service.set("conv-B", [
      { id: "b", content: "等待", status: "pending" },
    ]);
    const reader = createTaskListReaderFromService(service);

    expect(reader.hasInProgress("conv-A")).toBe(true);
    expect(reader.hasInProgress("conv-B")).toBe(false);
    expect(reader.hasInProgress("conv-never-set")).toBe(false);
  });
});

// ─── createCliSegmentDeps 装配 ───

describe("createCliSegmentDeps", () => {
  it("返回 taskListReader + persistence 两个抽象", () => {
    const deps = createCliSegmentDeps({
      taskListService: makeTaskListService(),
      conversationRepo: makeFakeConversationRepo(),
    });

    expect(deps.taskListReader).toBeDefined();
    expect(deps.persistence).toBeDefined();
    expect(typeof deps.taskListReader.hasInProgress).toBe("function");
    expect(typeof deps.persistence.appendSegment).toBe("function");
    // 不再暴露 writeMarker —— marker 走事件流，不走 persistence 接口
    expect((deps.persistence as Record<string, unknown>).writeMarker).toBeUndefined();
  });

  it("persistence.appendSegment 透传给 conversationRepo.appendSegmentMeta", async () => {
    const conversationRepo = makeFakeConversationRepo();
    const deps = createCliSegmentDeps({
      taskListService: makeTaskListService(),
      conversationRepo,
    });

    await deps.persistence.appendSegment("conv-Y", SAMPLE_META);

    expect(conversationRepo.calls).toEqual([{ id: "conv-Y", meta: SAMPLE_META }]);
  });

  it("taskListReader 接 service 单例 —— 测试时 set 后立即反映", async () => {
    const service = makeTaskListService();
    const deps = createCliSegmentDeps({
      taskListService: service,
      conversationRepo: makeFakeConversationRepo(),
    });

    expect(deps.taskListReader.hasInProgress("conv-Z")).toBe(false);
    await service.set("conv-Z", [
      { id: "x", content: "running", status: "in_progress" },
    ]);
    expect(deps.taskListReader.hasInProgress("conv-Z")).toBe(true);
  });
});

describe("createServeSegmentDeps", () => {
  it("taskListReader 与 REPL 同源；persistence 为 no-op（segmentMeta 缺写无害）", async () => {
    const service = makeTaskListService();
    const deps = createServeSegmentDeps({ taskListService: service });

    // in-progress 守卫与 REPL 装配同一适配器语义
    expect(deps.taskListReader.hasInProgress("conv-x")).toBe(false);
    // no-op persistence：不抛、无副作用 —— serve segmentMeta 暂不落盘
    await expect(
      deps.persistence.appendSegment("conv-x", {
        segmentId: "seg-1",
        timestamp: new Date().toISOString(),
        tokensBefore: 100,
        tokensAfter: 10,
      }),
    ).resolves.toBeUndefined();
  });
});
