/**
 * acquireWorksceneConversation 回归 —— 三条正交路径
 *
 *   A. latest 不存在 → create + 无 warning
 *   B. latest 存在 + load + get 均成功 → recovery + 无 warning
 *   C. latest 存在但加载失败（load 抛错 / get 返 null 两子）→ 降级 create + warning
 */

import { describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  IConversationRepository,
  RunRecord,
  ShardedTranscriptStore,
  TranscriptIndex,
} from "@zhixing/core";
import { acquireWorksceneConversation } from "../workscene-conversation.js";

const mkConv = (id: string, name = id): Conversation =>
  ({
    id,
    name,
    createdAt: "2026-05-21T00:00:00.000Z",
    lastActiveAt: "2026-05-21T00:00:00.000Z",
    isDefault: false,
    archived: false,
    scope: { kind: "workscene", sceneId: "scene-A" },
  }) as unknown as Conversation;

const mkIndex = (id: string): TranscriptIndex => ({
  version: 1,
  conversationId: id,
  activeShardId: "000001",
  shards: [
    {
      id: "000001",
      file: "000001.jsonl",
      createdAt: "2026-05-21T00:00:00.000Z",
      isActive: true,
    },
  ],
});

const mkRunRecord = (runIndex: number): RunRecord => ({
  type: "run",
  runIndex,
  timestamp: "2026-05-21T00:00:00.000Z",
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ],
});

function makeRepo(overrides: Partial<IConversationRepository>): IConversationRepository {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    ensureDefault: vi.fn(),
    findLatest: vi.fn(),
    touch: vi.fn(),
    clearViewLayerState: vi.fn(),
    updateTaskListState: vi.fn(),
    ...overrides,
  } as unknown as IConversationRepository;
}

/**
 * 历史装载走真实倒读原语（readRunsReverse），mock 只供它的两个读底座：
 * readIndex（null = 无 transcript）+ readShardLines（reject = 读失败降级）。
 */
function makeStore(
  overrides: Partial<ShardedTranscriptStore>,
): ShardedTranscriptStore {
  const store = {
    init: vi.fn(),
    appendRunRecord: vi.fn(),
    appendClear: vi.fn(),
    readIndex: vi.fn().mockResolvedValue(null),
    readShardLines: vi.fn().mockResolvedValue([]),
    exists: vi.fn(),
    ...overrides,
  };
  // 倒读原语走自愈版索引获取；mock 委托 readIndex —— 用例只需控制读底座
  return Object.assign(store, {
    ensureReadableIndex: vi.fn((id: string) =>
      (store.readIndex as (x: string) => Promise<unknown>)(id),
    ),
  }) as unknown as ShardedTranscriptStore;
}

describe("acquireWorksceneConversation", () => {
  it("路径 A：latest 不存在 → create + 无 warning", async () => {
    const created = mkConv("new-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    });
    const store = makeStore({});

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.conversation).toBe(created);
    expect(result.loaded).toBeNull();
    expect(result.warning).toBeUndefined();
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({});
    expect(store.readIndex).not.toHaveBeenCalled();
  });

  it("路径 B：latest 存在 + load + get 均成功 → recovery", async () => {
    const existing = mkConv("existing-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("existing-id"),
      get: vi.fn().mockResolvedValue(existing),
      create: vi.fn(),
    });
    const store = makeStore({
      readIndex: vi.fn().mockResolvedValue(mkIndex("existing-id")),
      readShardLines: vi.fn().mockResolvedValue([mkRunRecord(0)]),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.conversation).toBe(existing);
    expect(result.loaded).toEqual([mkRunRecord(0)]);
    expect(result.warning).toBeUndefined();
    expect(store.readIndex).toHaveBeenCalledWith("existing-id");
    expect(repo.get).toHaveBeenCalledWith("existing-id");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("路径 C-1：latest 存在 + load 抛错 → 降级 create + warning 含 error message", async () => {
    const created = mkConv("new-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("broken-id"),
      get: vi.fn(),
      create: vi.fn().mockResolvedValue(created),
    });
    const store = makeStore({
      readIndex: vi.fn().mockResolvedValue(mkIndex("broken-id")),
      readShardLines: vi.fn().mockRejectedValue(new Error("EBADJSON: corrupted")),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.conversation).toBe(created);
    expect(result.loaded).toBeNull();
    expect(result.warning).toContain("加载失败");
    expect(result.warning).toContain("EBADJSON: corrupted");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({});
    // get 不应调用（装载已先抛错走 catch）
    expect(repo.get).not.toHaveBeenCalled();
  });

  it("路径 C-2：latest 存在 + load 成功但 get 返 null → 降级 create + warning 标元数据缺失", async () => {
    const created = mkConv("new-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("ghost-id"),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    });
    const store = makeStore({
      readIndex: vi.fn().mockResolvedValue(mkIndex("ghost-id")),
      readShardLines: vi.fn().mockResolvedValue([mkRunRecord(0)]),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.conversation).toBe(created);
    expect(result.loaded).toBeNull();
    expect(result.warning).toContain("元数据缺失");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({});
  });

  it("warning 文案对非 Error 类型 reject 也能 stringify", async () => {
    const created = mkConv("new-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("broken-id"),
      create: vi.fn().mockResolvedValue(created),
    });
    const store = makeStore({
      readIndex: vi.fn().mockResolvedValue(mkIndex("broken-id")),
      readShardLines: vi.fn().mockRejectedValue("string-error-payload"),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.warning).toContain("string-error-payload");
  });
});
