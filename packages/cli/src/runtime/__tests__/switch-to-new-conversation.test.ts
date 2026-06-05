/**
 * switchToNewConversation 回归 —— 验证完整切换链路 + 非致命降级。
 */

import { describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  IConversationRepository,
  ITranscriptStore,
  Message,
} from "@zhixing/core";
import {
  switchToNewConversation,
  type MutableConversationState,
  type SwitchToNewConversationSession,
  type TaskListServicePrime,
} from "../switch-to-new-conversation.js";

const mkConv = (id: string): Conversation =>
  ({
    id,
    name: `name-${id}`,
    createdAt: "2026-05-21T00:00:00.000Z",
    lastActiveAt: "2026-05-21T00:00:00.000Z",
    isDefault: false,
    archived: false,
    scope: { kind: "user" },
  }) as unknown as Conversation;

function makeRepo(
  overrides: Partial<IConversationRepository> = {},
): IConversationRepository {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn().mockResolvedValue(mkConv("new-id")),
    rename: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    ensureDefault: vi.fn(),
    findLatest: vi.fn(),
    touch: vi.fn().mockResolvedValue(undefined),
    clearViewLayerState: vi.fn().mockResolvedValue(undefined),
    updateTaskListState: vi.fn(),
    appendSegmentMeta: vi.fn(),
    ...overrides,
  } as unknown as IConversationRepository;
}

function makeStore(
  overrides: Partial<ITranscriptStore> = {},
): ITranscriptStore {
  return {
    init: vi.fn().mockResolvedValue(undefined),
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

function makeState(
  overrides: Partial<MutableConversationState> = {},
): MutableConversationState {
  return {
    messages: [{ role: "user", content: "old" } as unknown as Message],
    store: makeStore(),
    convRepo: makeRepo(),
    conversationId: "old-id",
    turnCounter: 5,
    ...overrides,
  };
}

function makeSession(
  resetImpl?: () => Promise<void>,
): SwitchToNewConversationSession {
  return {
    runtime: {
      model: "test-model",
      providerId: "test-provider",
      resetConversationState: vi.fn(resetImpl ?? (() => Promise.resolve())),
      onAttentionWindowChange: vi.fn(() => Promise.resolve()),
    },
  };
}

function makeService(
  primeImpl?: (id: string) => Promise<void>,
): TaskListServicePrime {
  return {
    prime: vi.fn(primeImpl ?? (() => Promise.resolve())),
  };
}

describe("switchToNewConversation", () => {
  it("完整切换链:create + init + state 重置 + prime + touch + reset + notify", async () => {
    const conv = makeState();
    const session = makeSession();
    const service = makeService();
    const notify = vi.fn();

    const created = await switchToNewConversation(conv, session, service, {
      name: "hello",
      notify,
    });

    expect(created.id).toBe("new-id");
    expect(conv.convRepo.create).toHaveBeenCalledWith({
      name: "hello",
      preferredModel: "test-model",
      preferredProvider: "test-provider",
    });
    expect(conv.store.init).toHaveBeenCalledWith("new-id", {
      model: "test-model",
      provider: "test-provider",
    });
    expect(conv.conversationId).toBe("new-id");
    expect(conv.messages).toEqual([]);
    expect(conv.turnCounter).toBe(0);
    expect(service.prime).toHaveBeenCalledWith("new-id");
    expect(conv.convRepo.touch).toHaveBeenCalledWith("new-id");
    expect(session.runtime.resetConversationState).toHaveBeenCalled();
    expect(conv.convRepo.clearViewLayerState).toHaveBeenCalledWith("new-id");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("name 缺省 → repository 自动命名", async () => {
    const conv = makeState();
    await switchToNewConversation(conv, makeSession(), makeService());
    expect(conv.convRepo.create).toHaveBeenCalledWith({
      name: undefined,
      preferredModel: "test-model",
      preferredProvider: "test-provider",
    });
  });

  it("非致命降级:resetConversationState 抛错不阻塞主流程,后续步骤仍执行", async () => {
    const conv = makeState();
    const session = makeSession(() => Promise.reject(new Error("reset failed")));
    const service = makeService();
    const notify = vi.fn();

    const created = await switchToNewConversation(conv, session, service, {
      notify,
    });

    expect(created.id).toBe("new-id");
    expect(conv.conversationId).toBe("new-id");
    expect(conv.convRepo.clearViewLayerState).toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
  });

  it("非致命降级:clearViewLayerState 抛错不阻塞主流程", async () => {
    const conv = makeState({
      convRepo: makeRepo({
        clearViewLayerState: vi.fn().mockRejectedValue(new Error("clear failed")),
      }),
    });
    const notify = vi.fn();

    const created = await switchToNewConversation(
      conv,
      makeSession(),
      makeService(),
      { notify },
    );

    expect(created.id).toBe("new-id");
    expect(notify).toHaveBeenCalled();
  });

  it("touch 抛错 fire-and-forget swallow,主流程继续", async () => {
    const conv = makeState({
      convRepo: makeRepo({
        touch: vi.fn().mockRejectedValue(new Error("touch failed")),
      }),
    });

    const created = await switchToNewConversation(
      conv,
      makeSession(),
      makeService(),
    );

    expect(created.id).toBe("new-id");
    expect(conv.conversationId).toBe("new-id");
  });

  it("create 抛错 → 向上传播(caller 负责错误处理),state 不变", async () => {
    const conv = makeState();
    const broken = makeRepo({
      create: vi.fn().mockRejectedValue(new Error("create failed")),
    });
    conv.convRepo = broken;

    await expect(
      switchToNewConversation(conv, makeSession(), makeService()),
    ).rejects.toThrow("create failed");

    // create 失败 → 后续 state mutate 不应发生
    expect(conv.conversationId).toBe("old-id");
    expect(conv.turnCounter).toBe(5);
  });
});
