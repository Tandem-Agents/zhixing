/**
 * 宿主侧 turn 后维护 —— 自动命名与 journal 凝练的触发纪律。
 *
 * 锁住:
 *   - 单向阀:场景对话(ws:)与 ephemeral 不触发任何个人维护
 *   - 自动命名:仅首轮、仅 name 仍为 id 的对话、改名成功通知 onRenamed
 *   - journal:宿主级全局 single-flight,有凝练计划才走 LLM,失败后可重试
 *   - 运行体无 callText 能力时静默跳过
 */

import { describe, it, expect, vi } from "vitest";
import type { TurnCommittedInfo } from "@zhixing/server";
import type { Conversation, Message } from "@zhixing/core";
import { createTurnMaintenance, type NamerConversationRepo } from "../turn-maintenance.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeConv(id: string, name = id): Conversation {
  return {
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    isDefault: false,
    archived: false,
    scope: { kind: "user" },
  } as Conversation;
}

function makeRepo(conv: Conversation | null) {
  const renames: Array<{ id: string; name: string }> = [];
  const repo: NamerConversationRepo = {
    get: async () => conv,
    rename: async (id, name) => {
      renames.push({ id, name });
      return makeConv(id, name);
    },
  };
  return { repo, renames };
}

function makeJournal(opts?: { condensePlan?: unknown }) {
  const condenseSpy = vi.fn(async () => ({}));
  return {
    journal: {
      expireOld: vi.fn(async () => ({ deleted: 0 })),
      scan: vi.fn(async () => ({ condensePlan: opts?.condensePlan ?? null })),
      condense: condenseSpy,
    } as never,
    condenseSpy,
  };
}

function makeInfo(overrides?: Partial<TurnCommittedInfo>): TurnCommittedInfo {
  const userMsg: Message = {
    role: "user",
    content: [{ type: "text", text: "帮我写一份周报" }],
  };
  return {
    conversationId: "conv-1",
    turnId: "turn-1",
    turnCount: 1,
    runRecord: {
      timestamp: "2026-01-01T00:00:00.000Z",
      messages: [userMsg],
    },
    runIndex: 0,
    runMessages: [userMsg],
    ephemeral: false,
    runtime: {
      sessionId: "conv-1",
      callText: vi.fn(async () => "周报助手"),
    } as never,
    ...overrides,
  };
}

describe("createTurnMaintenance", () => {
  it("首轮自动命名:name 仍为 id 时改名并通知 onRenamed", async () => {
    const { repo, renames } = makeRepo(makeConv("conv-1"));
    const onRenamed = vi.fn();
    const maintain = createTurnMaintenance({
      convRepo: repo,
      journal: makeJournal().journal,
      onRenamed,
    });

    maintain(makeInfo());
    await flush();

    expect(renames).toEqual([{ id: "conv-1", name: "周报助手" }]);
    expect(onRenamed).toHaveBeenCalledWith("conv-1", "周报助手");
  });

  it("已有用户名字(name !== id)不改名;非首轮不触发命名", async () => {
    const { repo, renames } = makeRepo(makeConv("conv-1", "我的名字"));
    const maintain = createTurnMaintenance({
      convRepo: repo,
      journal: makeJournal().journal,
    });

    maintain(makeInfo());
    maintain(makeInfo({ turnCount: 2 }));
    await flush();

    expect(renames).toEqual([]);
  });

  it("单向阀:场景对话与 ephemeral 不触发任何维护", async () => {
    const { repo, renames } = makeRepo(makeConv("conv-1"));
    const { journal, condenseSpy } = makeJournal({ condensePlan: { months: ["2026-01"] } });
    const maintain = createTurnMaintenance({ convRepo: repo, journal });

    maintain(makeInfo({ conversationId: "ws:scene-1:conv-9" }));
    maintain(makeInfo({ ephemeral: true }));
    await flush();

    expect(renames).toEqual([]);
    expect(condenseSpy).not.toHaveBeenCalled();
  });

  it("journal:宿主级全局维护成功后不因其它 conversation 重复执行", async () => {
    const { repo } = makeRepo(makeConv("conv-1", "已命名"));
    const { journal, condenseSpy } = makeJournal({ condensePlan: { months: ["2026-01"] } });
    const maintain = createTurnMaintenance({ convRepo: repo, journal });

    maintain(makeInfo({ turnCount: 2 }));
    maintain(makeInfo({ conversationId: "conv-2", turnCount: 1 }));
    await flush();

    expect(condenseSpy).toHaveBeenCalledTimes(1);
  });

  it("journal:运行中触发合并为同一次维护,不并发凝练", async () => {
    const { repo } = makeRepo(makeConv("conv-1", "已命名"));
    let release!: () => void;
    const condenseSpy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const maintain = createTurnMaintenance({
      convRepo: repo,
      journal: {
        expireOld: vi.fn(async () => ({ deleted: 0 })),
        scan: vi.fn(async () => ({ condensePlan: { months: ["2026-01"] } })),
        condense: condenseSpy,
      } as never,
    });

    maintain(makeInfo({ conversationId: "conv-1", turnCount: 2 }));
    await flush();
    maintain(makeInfo({ conversationId: "conv-2", turnCount: 2 }));
    await flush();

    expect(condenseSpy).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  it("journal:维护失败后回到 idle,后续 user turn 可重试", async () => {
    const { repo } = makeRepo(makeConv("conv-1", "已命名"));
    const condenseSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("llm failed"))
      .mockResolvedValueOnce({});
    const maintain = createTurnMaintenance({
      convRepo: repo,
      journal: {
        expireOld: vi.fn(async () => ({ deleted: 0 })),
        scan: vi.fn(async () => ({ condensePlan: { months: ["2026-01"] } })),
        condense: condenseSpy,
      } as never,
    });

    maintain(makeInfo({ conversationId: "conv-1", turnCount: 2 }));
    await flush();
    maintain(makeInfo({ conversationId: "conv-2", turnCount: 2 }));
    await flush();

    expect(condenseSpy).toHaveBeenCalledTimes(2);
  });

  it("运行体无 callText 能力时静默跳过", async () => {
    const { repo, renames } = makeRepo(makeConv("conv-1"));
    const { journal, condenseSpy } = makeJournal({ condensePlan: {} });
    const maintain = createTurnMaintenance({ convRepo: repo, journal });

    maintain(
      makeInfo({
        runtime: { sessionId: "conv-1" } as never,
      }),
    );
    await flush();

    expect(renames).toEqual([]);
    expect(condenseSpy).not.toHaveBeenCalled();
  });
});
