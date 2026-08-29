/**
 * Segment 运行依赖装配与 TaskListReader 适配测试。
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
import { createEventBus, type AgentEventMap } from "@zhixing/core";
import type {
  AssignmentMutationOverlayRecord,
  AssignmentMutationPort,
} from "@zhixing/core/contracts";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { TaskListService } from "@zhixing/tools-builtin";
import { InMemoryTaskListStore } from "../task-list-stores.js";
import {
  createPersistentSegmentDeps,
  createTransientSegmentDeps,
  createTaskListReaderFromService,
} from "../../serve/segment-deps.js";

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
    ensure: vi.fn(),
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
  it("service 无任务 → hasInProgress 返 false", async () => {
    const service = makeTaskListService();
    const reader = createTaskListReaderFromService(service);

    await expect(reader.hasInProgress("conv-1")).resolves.toBe(false);
  });

  it("service 含 pending + completed（无 in_progress）→ false", async () => {
    const service = makeTaskListService();
    await service.set("conv-1", [
      { id: "t1", content: "等待", status: "pending" },
      { id: "t2", content: "已完成", status: "completed" },
    ]);
    const reader = createTaskListReaderFromService(service);

    await expect(reader.hasInProgress("conv-1")).resolves.toBe(false);
  });

  it("service 含 in_progress → true", async () => {
    const service = makeTaskListService();
    await service.set("conv-1", [
      { id: "t1", content: "执行中", status: "in_progress" },
    ]);
    const reader = createTaskListReaderFromService(service);

    await expect(reader.hasInProgress("conv-1")).resolves.toBe(true);
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

    await expect(reader.hasInProgress("conv-A")).resolves.toBe(true);
    await expect(reader.hasInProgress("conv-B")).resolves.toBe(false);
    await expect(reader.hasInProgress("conv-never-set")).resolves.toBe(false);
  });

  it("段切换判据优先读取当前 assignment 的 task-list overlay", async () => {
    const service = makeTaskListService();
    const overlay: AssignmentMutationOverlayRecord[] = [
      {
        recordSeq: 1,
        domain: "session",
        requestId: "task-list:tool-call-1",
        mutationDigest: "digest-task-list",
        mutation: {
          kind: "task-list-op",
          op: {
            op: "set",
            state: {
              items: [{ id: "active", content: "运行中", status: "in_progress" }],
            },
          },
        },
      },
    ];
    const assignmentMutations = {
      assignmentId: "assignment-1",
      execution: "conversation",
      readOverlay: async () => overlay,
    } as AssignmentMutationPort;

    const result = await runContextStorage.run(
      {
        bus: createEventBus<AgentEventMap>({ lineage: "main" }),
        lineage: "main",
        assignmentMutations,
      },
      () => createTaskListReaderFromService(service).hasInProgress("conv-1"),
    );

    expect(result).toBe(true);
    expect(service.getInProgressTasks("conv-1")).toEqual([]);
  });
});

// ─── 持久化 Segment 依赖装配 ───

describe("createPersistentSegmentDeps", () => {
  it("返回 taskListReader + persistence 两个抽象", () => {
    const deps = createPersistentSegmentDeps({
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
    const deps = createPersistentSegmentDeps({
      taskListService: makeTaskListService(),
      conversationRepo,
    });

    await deps.persistence.appendSegment("conv-Y", SAMPLE_META);

    expect(conversationRepo.calls).toEqual([{ id: "conv-Y", meta: SAMPLE_META }]);
  });

  it("taskListReader 接 service 单例 —— 测试时 set 后立即反映", async () => {
    const service = makeTaskListService();
    const deps = createPersistentSegmentDeps({
      taskListService: service,
      conversationRepo: makeFakeConversationRepo(),
    });

    await expect(deps.taskListReader.hasInProgress("conv-Z")).resolves.toBe(false);
    await service.set("conv-Z", [
      { id: "x", content: "running", status: "in_progress" },
    ]);
    await expect(deps.taskListReader.hasInProgress("conv-Z")).resolves.toBe(true);
  });

  it("run 内 segment 写只进入 assignment overlay，权威 repository 提交前不变", async () => {
    const conversationRepo = makeFakeConversationRepo();
    const deps = createPersistentSegmentDeps({
      taskListService: makeTaskListService(),
      conversationRepo,
    });
    const staged: AssignmentMutationOverlayRecord[] = [];
    const mutations: AssignmentMutationPort = {
      assignmentId: "assignment-1",
      execution: "conversation",
      async stage(input) {
        const record: AssignmentMutationOverlayRecord = {
          recordSeq: staged.length + 1,
          domain: input.domain,
          mutation: input.mutation,
          requestId: input.operationId,
          mutationDigest: `digest-${staged.length + 1}`,
        };
        staged.push(record);
        return {
          kind: "assignment-mutation-staged",
          requestId: record.requestId,
          recordSeq: record.recordSeq,
          mutationDigest: record.mutationDigest,
        };
      },
      async readOverlay() {
        return staged;
      },
    };

    await runContextStorage.run(
      {
        bus: createEventBus<AgentEventMap>({ lineage: "main" }),
        lineage: "main",
        assignmentMutations: mutations,
      },
      () => deps.persistence.appendSegment("conv-Y", SAMPLE_META),
    );

    expect(conversationRepo.calls).toEqual([]);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      domain: "session",
      requestId: "segment:seg-abc",
      mutation: { kind: "segment-append", segment: SAMPLE_META },
    });
  });
});

describe("createTransientSegmentDeps", () => {
  it("assignment 外保持瞬态 no-op，taskListReader 与 REPL 同源", async () => {
    const service = makeTaskListService();
    const deps = createTransientSegmentDeps({ taskListService: service });

    // in-progress 守卫与 REPL 装配同一适配器语义
    await expect(deps.taskListReader.hasInProgress("conv-x")).resolves.toBe(false);
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
