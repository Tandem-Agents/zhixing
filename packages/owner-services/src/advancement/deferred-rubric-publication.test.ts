import { describe, expect, it, vi } from "vitest";
import type { RubricContractDraftSnapshot } from "@zhixing/core";
import type { DeferredGlobalIntentPort } from "@zhixing/core/contracts";
import { DeferredRubricPublication } from "./deferred-rubric-publication.js";

const NOW = "2026-08-03T12:00:00.000Z";

function draft(): RubricContractDraftSnapshot {
  return {
    draftId: "draft-1",
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title: "交付验收",
    description: "判断任务是否完成。",
    content: {
      passCriteria: [{ id: "done", text: "核心功能完成" }],
      evidenceRequirements: [],
      failureHandling: [{ id: "continue", scenario: "未完成", reply: "继续完成。" }],
    },
    createdAt: NOW,
  };
}

describe("DeferredRubricPublication", () => {
  it("只通过注入端口耐久登记 rubric 意向，并返回真实离线状态", async () => {
    const record = vi.fn<DeferredGlobalIntentPort["record"]>(async () => ({
      intentId: "intent-1",
    }));
    const intents: DeferredGlobalIntentPort = {
      record,
      list: async () => [],
      decide: async () => {},
    };
    const mutation = {
      kind: "rubric-save-own" as const,
      rubric: {
        title: "交付验收",
        description: "判断任务是否完成。",
        content: { digest: `sha256:${"a".repeat(64)}`, bytes: 128 },
      },
    };
    const publication = new DeferredRubricPublication({
      intents,
      prepareMutation: async () => mutation,
      now: () => NOW,
    });

    expect(publication.acceptanceOutcome()).toEqual({
      kind: "deferred",
      message: "已用于本任务，连接值班设备后保存",
    });
    await expect(publication.publish({
      conversationId: "conv-1",
      draft: draft(),
      persistence: { kind: "save-new" },
    })).resolves.toEqual(publication.acceptanceOutcome());

    expect(record).toHaveBeenCalledWith(
      "conv-1",
      mutation,
      false,
      {
        principal: { kind: "host", component: "advancement-rubric-intent" },
        requestId: "rubric-intent:conv-1:draft-1:save-new",
        deadlineAt: "2026-08-03T12:00:30.000Z",
      },
    );
  });

  it("意向内容无法准备时不伪装成已登记", async () => {
    const record = vi.fn<DeferredGlobalIntentPort["record"]>();
    const publication = new DeferredRubricPublication({
      intents: { record, list: async () => [], decide: async () => {} },
      prepareMutation: async () => {
        throw new Error("local content asset is unavailable");
      },
      now: () => NOW,
    });

    await expect(publication.publish({
      conversationId: "conv-1",
      draft: draft(),
      persistence: { kind: "save-new" },
    })).rejects.toThrow("local content asset is unavailable");
    expect(record).not.toHaveBeenCalled();
  });

  it("把 update 目标写入稳定操作身份，避免同草案的不同目标被误判重放", async () => {
    const record = vi.fn<DeferredGlobalIntentPort["record"]>(async () => ({
      intentId: "intent-1",
    }));
    const mutation = {
      kind: "rubric-update-own" as const,
      rubricId: "rubric-1",
      expectedRevision: 2,
      rubric: {
        title: "交付验收",
        description: "判断任务是否完成。",
        content: { digest: `sha256:${"b".repeat(64)}`, bytes: 128 },
      },
    };
    const publication = new DeferredRubricPublication({
      intents: { record, list: async () => [], decide: async () => {} },
      prepareMutation: async () => mutation,
      now: () => NOW,
    });

    await publication.publish({
      conversationId: "conv-1",
      draft: draft(),
      persistence: {
        kind: "update-existing",
        rubricId: "rubric-1",
      },
    });

    expect(record).toHaveBeenCalledWith(
      "conv-1",
      mutation,
      false,
      expect.objectContaining({
        requestId: "rubric-intent:conv-1:draft-1:update-existing:rubric-1",
      }),
    );
  });
});
