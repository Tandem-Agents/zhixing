/**
 * acquireWorksceneConversation 回归 —— 三条正交路径。
 *
 * helper 只裁决"复用哪个对话还是新建"（窗口装填归 caller 的 enter 流程）：
 *   A. latest 不存在 → create + 无 warning
 *   B. latest 存在 + get 成功 → recovery + 无 warning
 *   C. latest 存在但 get 返 null（meta 缺失/损坏）→ 降级 create + warning
 */

import { describe, expect, it, vi } from "vitest";
import type { Conversation, IConversationRepository } from "@zhixing/core";
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

describe("acquireWorksceneConversation", () => {
  it("路径 A：latest 不存在 → create + 无 warning", async () => {
    const created = mkConv("new-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    });

    const result = await acquireWorksceneConversation(repo);

    expect(result.conversation).toBe(created);
    expect(result.recovered).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({});
    expect(repo.get).not.toHaveBeenCalled();
  });

  it("路径 B：latest 存在 + get 成功 → recovery", async () => {
    const existing = mkConv("existing-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("existing-id"),
      get: vi.fn().mockResolvedValue(existing),
      create: vi.fn(),
    });

    const result = await acquireWorksceneConversation(repo);

    expect(result.conversation).toBe(existing);
    expect(result.recovered).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(repo.get).toHaveBeenCalledWith("existing-id");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("路径 C：latest 存在但 get 返 null → 降级 create + warning 标元数据缺失", async () => {
    const created = mkConv("new-id");
    const repo = makeRepo({
      findLatest: vi.fn().mockResolvedValue("ghost-id"),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    });

    const result = await acquireWorksceneConversation(repo);

    expect(result.conversation).toBe(created);
    expect(result.recovered).toBe(false);
    expect(result.warning).toContain("元数据缺失");
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith({});
  });
});
