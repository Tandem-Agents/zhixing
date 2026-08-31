import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../../product-api/catalog.js";
import {
  ADVANCEMENT_DETAIL_QUERY,
  ADVANCEMENT_PRODUCT_API_EXACT_SET,
  AdvancementApplicationService,
  createAdvancementProductApiContribution,
  type AdvancementDetailReadPort,
} from "../application.js";
import type {
  AdvancementRunReview,
  AdvancementSession,
} from "../types.js";

describe("AdvancementApplicationService detail query", () => {
  it("returns null when the owner has no Advancement session", async () => {
    const loadLatestSession = vi.fn(async () => null);
    const application = new AdvancementApplicationService({
      loadLatestSession,
    });

    await expect(
      application.queryDetail({ conversationId: "conv-none" }),
    ).resolves.toBeNull();
    expect(loadLatestSession).toHaveBeenCalledOnce();
    expect(loadLatestSession).toHaveBeenCalledWith("conv-none");
    await expect(
      application.queryDetail({ conversationId: "" }),
    ).rejects.toThrow("Advancement detail requires a conversation identity");
  });

  it("projects an open session with confirmed title, latest review and closure facts", async () => {
    const criterion = {
      criterionId: "pc-1",
      verdict: "unmet" as const,
      reason: "测试尚未通过。",
    };
    const source = session({
      status: "active",
      confirmedRubric: confirmedRubric("已确认标准"),
      pendingRubricDraft: pendingRubric("旧草案标题"),
      runs: [
        review("review-1", 0),
        review("review-2", 1, { attribution: { criteria: [criterion] } }),
      ],
    });
    const application = new AdvancementApplicationService(port(source));

    const detail = await application.queryDetail({ conversationId: "conv-1" });

    expect(detail).toMatchObject({
      advancementSessionId: "adv-1",
      status: "active",
      rubricTitle: "已确认标准",
      facts: {
        sessionId: "adv-1",
        reviewedRunCount: 2,
        criteria: [
          {
            criterionId: "pc-1",
            verdict: "unmet",
            reason: "测试尚未通过。",
          },
        ],
      },
      lastReview: { id: "review-2", runIndex: 1 },
    });
    expect(detail?.lastReview).not.toBe(source.runs[1]);
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail?.facts.criteria)).toBe(true);
    expect(Object.isFrozen(detail?.lastReview?.attribution.criteria)).toBe(true);
    criterion.reason = "外部随后篡改。";
    expect(detail?.lastReview?.attribution.criteria[0]?.reason).toBe(
      "测试尚未通过。",
    );
  });

  it("projects the latest terminal session with pending title and exit", async () => {
    const source = session({
      status: "exited",
      confirmedRubric: undefined,
      pendingRubricDraft: pendingRubric("待确认标准"),
      exit: {
        reason: "user-took-over",
        message: "用户接管了任务。",
        occurredAt: "2026-01-01T00:05:00.000Z",
      },
    });
    const application = new AdvancementApplicationService(port(source));

    await expect(
      application.queryDetail({ conversationId: "conv-1" }),
    ).resolves.toMatchObject({
      status: "exited",
      rubricTitle: "待确认标准",
      exit: { reason: "user-took-over" },
      facts: { status: "exited", reviewedRunCount: 0 },
    });
  });

  it("contributes one sealed Query and no Fact Event", async () => {
    const application = new AdvancementApplicationService(port(session()));
    const dispatcher = new ProductApiDispatcher(
      ADVANCEMENT_PRODUCT_API_EXACT_SET,
      [createAdvancementProductApiContribution(application)],
    );

    expect(ADVANCEMENT_PRODUCT_API_EXACT_SET.operations).toEqual([
      ADVANCEMENT_DETAIL_QUERY,
    ]);
    expect(ADVANCEMENT_PRODUCT_API_EXACT_SET.factEvents).toEqual([]);
    await expect(
      dispatcher.query(ADVANCEMENT_DETAIL_QUERY, {
        conversationId: "conv-1",
      }),
    ).resolves.toMatchObject({ advancementSessionId: "adv-1" });
  });
});

function port(session: AdvancementSession): AdvancementDetailReadPort {
  return { loadLatestSession: async () => session };
}

function session(overrides: Partial<AdvancementSession> = {}): AdvancementSession {
  return {
    id: "adv-1",
    conversationId: "conv-1",
    status: "active",
    originalUserTask: { parts: [{ type: "text", text: "把任务做完" }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:04:00.000Z",
    rubricDraftVersion: 1,
    confirmedRubric: confirmedRubric("已确认标准"),
    runs: [],
    proxyMessages: [],
    ...overrides,
  };
}

function pendingRubric(title: string) {
  return {
    draftId: "draft-1",
    originalTurnId: "turn-1",
    source: "generated" as const,
    candidateRubricIds: [],
    title,
    description: "测试标准。",
    content: {
      passCriteria: ["测试通过"],
      evidenceRequirements: [],
      failureHandling: [],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function confirmedRubric(title: string) {
  return {
    source: {
      kind: "library" as const,
      rubricId: "rubric-1",
      rubricVersion: "v1",
    },
    title,
    description: "测试标准。",
    content: {
      passCriteria: [{ id: "pc-1", text: "测试通过" }],
      evidenceRequirements: [],
      failureHandling: [],
    },
    confirmedAt: "2026-01-01T00:01:00.000Z",
    confirmedBy: "user" as const,
  };
}

function review(
  id: string,
  runIndex: number,
  overrides: Partial<AdvancementRunReview> = {},
): AdvancementRunReview {
  return {
    id,
    runIndex,
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: [],
    attribution: { criteria: [] },
    unmetCriteria: [],
    ...overrides,
  };
}
