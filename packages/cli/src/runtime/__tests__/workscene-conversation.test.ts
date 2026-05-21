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
  ITranscriptStore,
  LoadedTranscript,
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

const mkLoaded = (id: string): LoadedTranscript => ({
  header: {
    type: "header",
    version: 1,
    conversationId: id,
    name: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    model: "test-model",
    provider: "test-provider",
  },
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ] as unknown as LoadedTranscript["messages"],
  turnCount: 1,
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

function makeStore(overrides: Partial<ITranscriptStore>): ITranscriptStore {
  return {
    init: vi.fn(),
    commitTurn: vi.fn(),
    appendTurn: vi.fn(),
    appendCompact: vi.fn(),
    compactAll: vi.fn(),
    load: vi.fn(),
    countTurns: vi.fn(),
    exists: vi.fn(),
    ...overrides,
  } as unknown as ITranscriptStore;
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
    expect(store.load).not.toHaveBeenCalled();
  });

  it("路径 B：latest 存在 + load + get 均成功 → recovery", async () => {
    const existing = mkConv("existing-id");
    const loaded = mkLoaded("existing-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("existing-id"),
      get: vi.fn().mockResolvedValue(existing),
      create: vi.fn(),
    });
    const store = makeStore({
      load: vi.fn().mockResolvedValue(loaded),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.conversation).toBe(existing);
    expect(result.loaded).toBe(loaded);
    expect(result.warning).toBeUndefined();
    expect(store.load).toHaveBeenCalledWith("existing-id");
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
      load: vi.fn().mockRejectedValue(new Error("EBADJSON: corrupted")),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.conversation).toBe(created);
    expect(result.loaded).toBeNull();
    expect(result.warning).toContain("加载失败");
    expect(result.warning).toContain("EBADJSON: corrupted");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({});
    // get 不应调用（load 已先抛错走 catch）
    expect(repo.get).not.toHaveBeenCalled();
  });

  it("路径 C-2：latest 存在 + load 成功但 get 返 null → 降级 create + warning 标元数据缺失", async () => {
    const created = mkConv("new-id");
    const loaded = mkLoaded("ghost-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("ghost-id"),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    });
    const store = makeStore({
      load: vi.fn().mockResolvedValue(loaded),
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
      load: vi.fn().mockRejectedValue("string-error-payload"),
    });

    const result = await acquireWorksceneConversation(repo, store);

    expect(result.warning).toContain("string-error-payload");
  });
});
