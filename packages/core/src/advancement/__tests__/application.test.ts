import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../../product-api/catalog.js";
import {
  ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
  ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
  ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
  ADVANCEMENT_DETAIL_QUERY,
  ADVANCEMENT_PRODUCT_API_EXACT_SET,
  ADVANCEMENT_REVISE_RUBRIC_COMMAND,
  AdvancementApplicationError,
  AdvancementApplicationService,
  createAdvancementProductApiContribution,
  type AdvancementApplicationOptions,
  type AdvancementConversationMaintenancePort,
  type AdvancementDetailReadPort,
  type AdvancementRubricRevisionMechanismPort,
  type AdvancementRubricCancellationMechanismPort,
  type AdvancementOriginalTaskExecutionPort,
  type AdvancementOriginalTaskSurfacePort,
} from "../application.js";
import type {
  AdvancementRunReview,
  AdvancementSession,
} from "../types.js";

describe("AdvancementApplicationService detail query", () => {
  it("returns null when the owner has no Advancement session", async () => {
    const loadLatestSession = vi.fn(async () => null);
    const application = createApplication({
      detail: { loadLatestSession },
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
    const application = createApplication({ detail: port(source) });

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
    const application = createApplication({ detail: port(source) });

    await expect(
      application.queryDetail({ conversationId: "conv-1" }),
    ).resolves.toMatchObject({
      status: "exited",
      rubricTitle: "待确认标准",
      exit: { reason: "user-took-over" },
      facts: { status: "exited", reviewedRunCount: 0 },
    });
  });

  it("owns trim, pending-draft preconditions, consecutive revision and immutable fact projection", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待修订标准"),
      confirmedRubric: undefined,
    });
    const reviseRubricDraftContent = vi.fn(
      async (input: Parameters<AdvancementRubricRevisionMechanismPort["reviseRubricDraftContent"]>[0]) => ({
        ...input.currentDraft,
        draftId: `draft-${input.userFeedback}`,
        content: {
          ...input.currentDraft.content,
          passCriteria: [
            ...input.currentDraft.content.passCriteria,
            input.userFeedback,
          ],
        },
      }),
    );
    const fixture = createRevisionFixture(source, { reviseRubricDraftContent });

    const first = await fixture.application.reviseRubricDraft({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      userFeedback: "  补充文档验收  ",
    });
    const second = await fixture.application.reviseRubricDraft({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      userFeedback: "再补充构建验收",
    });

    expect(reviseRubricDraftContent.mock.calls[0]?.[0].userFeedback).toBe(
      "补充文档验收",
    );
    expect(reviseRubricDraftContent.mock.calls[1]?.[0].currentDraft.draftId).toBe(
      "draft-补充文档验收",
    );
    expect(first.result.rubricDraftVersion).toBe(2);
    expect(second.result.rubricDraftVersion).toBe(3);
    expect(second.fact).toEqual({
      kind: "advancement-contract-draft-revised",
      conversationId: "conv-1",
      originalTurnId: "turn-1",
      advancementSessionId: "adv-1",
      rubricDraftId: "draft-再补充构建验收",
      rubricDraftVersion: 3,
      rubricDraft: second.result.rubricDraft,
      revised: true,
    });
    expect(Object.isFrozen(second.result)).toBe(true);
    expect(Object.isFrozen(second.result.rubricDraft.content.passCriteria)).toBe(true);
    expect(Object.isFrozen(second.fact)).toBe(true);
  });

  it("forms Result and Fact only from the committed authoritative session projection", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待修订标准"),
      confirmedRubric: undefined,
    });
    const candidate = {
      ...pendingRubric("提交前候选"),
      draftId: "draft-candidate",
    };
    const committed = {
      ...pendingRubric("提交后规范化草案"),
      draftId: "draft-committed",
    };
    const fixture = createRevisionFixture(source, {
      reviseRubricDraftContent: async () => candidate,
      persistRubricDraftRevision: async () => ({
        ...source,
        id: "adv-committed",
        pendingRubricDraft: committed,
        rubricDraftVersion: 7,
      }),
    });

    const revised = await fixture.application.reviseRubricDraft({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      userFeedback: "规范化后提交",
    });

    expect(revised.result).toMatchObject({
      advancementSessionId: "adv-committed",
      rubricDraftId: "draft-committed",
      rubricDraftVersion: 7,
      rubricDraft: { title: "提交后规范化草案" },
    });
    expect(revised.fact).toMatchObject({
      advancementSessionId: "adv-committed",
      rubricDraftId: "draft-committed",
      rubricDraftVersion: 7,
      rubricDraft: { title: "提交后规范化草案" },
    });
    expect(revised.result.rubricDraft).toBe(revised.fact.rubricDraft);
    expect(revised.result.rubricDraft).not.toBe(candidate);

    const missing = createRevisionFixture(source, {
      reviseRubricDraftContent: async () => candidate,
      persistRubricDraftRevision: async () => ({
        ...source,
        pendingRubricDraft: undefined,
        rubricDraftVersion: 7,
      }),
    });
    await expect(
      missing.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        userFeedback: "规范化后提交",
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "committed-rubric-draft-missing",
    });
  });

  it("fails closed before revision for invalid input, maintenance refusal, state mismatch and missing draft", async () => {
    const awaiting = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待修订标准"),
      confirmedRubric: undefined,
    });
    const base = createRevisionFixture(awaiting);
    await expect(
      base.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        userFeedback: "   ",
      }),
    ).rejects.toThrow("requires non-empty user feedback");
    await expect(
      base.application.reviseRubricDraft({
        conversationId: "",
        advancementSessionId: "adv-1",
        userFeedback: "修订",
      }),
    ).rejects.toThrow("conversation identity must be non-empty");
    await expect(
      base.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: " ",
        userFeedback: "修订",
      }),
    ).rejects.toThrow("Advancement session identity must be non-empty");

    for (const status of ["busy", "not-found"] as const) {
      const fixture = createRevisionFixture(awaiting, {
        maintenance: {
          runExisting: async () => ({ status }),
        },
      });
      await expect(
        fixture.application.reviseRubricDraft({
          conversationId: "conv-1",
          advancementSessionId: "adv-1",
          userFeedback: "修订",
        }),
      ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
        code: status === "busy" ? "conversation-busy" : "conversation-not-found",
      });
    }

    const absent = createRevisionFixture(awaiting, {
      loadRubricRevisionSession: async () => null,
    });
    await expect(
      absent.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: "adv-missing",
        userFeedback: "修订",
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "advancement-session-not-found",
    });

    const inactive = createRevisionFixture(session({ status: "active" }));
    await expect(
      inactive.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        userFeedback: "修订",
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "not-awaiting-rubric-confirmation",
    });
    const missing = createRevisionFixture(session({
      status: "awaiting-rubric-confirmation",
      confirmedRubric: undefined,
      pendingRubricDraft: undefined,
    }));
    await expect(
      missing.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        userFeedback: "修订",
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "pending-rubric-draft-missing",
    });
  });

  it("propagates mechanism failures without persisting a revision or forming a fact", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待修订标准"),
      confirmedRubric: undefined,
    });
    const persistRubricDraftRevision = vi.fn();
    const fixture = createRevisionFixture(source, {
      reviseRubricDraftContent: async () => {
        throw new Error("revision mechanism failed");
      },
      persistRubricDraftRevision,
    });

    await expect(
      fixture.application.reviseRubricDraft({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        userFeedback: "修订",
      }),
    ).rejects.toThrow("revision mechanism failed");
    expect(persistRubricDraftRevision).not.toHaveBeenCalled();
  });

  it("owns cancellation and publishes its committed Fact before original-task handoff", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    const order: string[] = [];
    const fixture = createRevisionFixture(source, {
      persistRubricCancellation: async (input) => {
        order.push("persist");
        expect(input).toMatchObject({
          reason: "user-cancelled",
          message: "用户选择直接执行原始任务",
        });
        return {
          ...source,
          status: "cancelled",
          exit: {
            reason: input.reason,
            message: input.message,
            occurredAt: "2026-01-01T00:06:00.000Z",
          },
        };
      },
      originalTask: {
        execute: async (input) => {
          order.push("execute");
          expect(input).toEqual({
            conversationId: "conv-1",
            originalTurnId: "turn-1",
            originalUserTask: source.originalUserTask,
            surface: expect.any(Object),
          });
          expect(Object.isFrozen(input.originalUserTask)).toBe(true);
          return {
            conversationId: input.conversationId,
            turnId: input.originalTurnId,
            runId: "run-1",
            runStatus: "immediate",
          };
        },
      },
    });

    const cancelled = await fixture.application.cancelRubric({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      executeOriginal: true,
      fact: {
        publish: (fact) => {
          order.push("fact");
          expect(fact).toMatchObject({
            kind: "advancement-contract-cancelled",
            originalTurnId: "turn-1",
            controlSeq: 2,
            executeOriginal: true,
          });
        },
      },
      surface: testSurface(),
    });

    expect(order).toEqual(["persist", "fact", "execute"]);
    expect(cancelled.result).toEqual({
      kind: "direct-original-task",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      turnId: "turn-1",
      runId: "run-1",
      runStatus: "immediate",
    });
    expect(cancelled.fact.executeOriginal).toBe(true);
  });

  it("cancels without handoff when no committed draft exists and fails closed before effects", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: undefined,
      confirmedRubric: undefined,
    });
    const publish = vi.fn();
    const execute = vi.fn();
    const fixture = createRevisionFixture(source, {
      originalTask: { execute },
    });

    const cancelled = await fixture.application.cancelRubric({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      executeOriginal: true,
      fact: { publish },
      surface: testSurface(),
    });

    expect(cancelled.result).toEqual({
      kind: "cancelled",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
    });
    expect(cancelled.fact).toMatchObject({
      originalTurnId: "adv-1",
      executeOriginal: false,
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();

    const inactive = createRevisionFixture(session({ status: "active" }));
    await expect(
      inactive.application.cancelRubric({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        executeOriginal: false,
        fact: { publish },
        surface: testSurface(),
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "not-awaiting-rubric-confirmation",
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();

    const persistMismatched = vi.fn();
    const mismatched = createRevisionFixture(source, {
      loadRubricCancellationSession: async () => ({
        ...source,
        id: "adv-foreign",
      }),
      persistRubricCancellation: persistMismatched,
    });
    await expect(
      mismatched.application.cancelRubric({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        executeOriginal: false,
        fact: { publish },
        surface: testSurface(),
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "advancement-session-identity-mismatch",
    });
    expect(persistMismatched).not.toHaveBeenCalled();

    for (const status of ["busy", "not-found"] as const) {
      const refused = createRevisionFixture(source, {
        maintenance: {
          runExisting: async () => ({ status }),
        },
      });
      await expect(
        refused.application.cancelRubric({
          conversationId: "conv-1",
          advancementSessionId: "adv-1",
          executeOriginal: false,
          fact: { publish },
          surface: testSurface(),
        }),
      ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
        code: status === "busy" ? "conversation-busy" : "conversation-not-found",
      });
    }
  });

  it("does not hand off when cancellation persistence or Fact publication fails", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    const execute = vi.fn();
    const failedPersistence = createRevisionFixture(source, {
      persistRubricCancellation: async () => {
        throw new Error("cancel persistence failed");
      },
      originalTask: { execute },
    });
    await expect(
      failedPersistence.application.cancelRubric({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        executeOriginal: true,
        fact: { publish: vi.fn() },
        surface: testSurface(),
      }),
    ).rejects.toThrow("cancel persistence failed");

    const failedFact = createRevisionFixture(source, {
      originalTask: { execute },
    });
    await expect(
      failedFact.application.cancelRubric({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        executeOriginal: true,
        fact: {
          publish: () => {
            throw new Error("fact projection failed");
          },
        },
        surface: testSurface(),
      }),
    ).rejects.toThrow("fact projection failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("contributes one Query plus revision/cancellation Commands and Facts", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待修订标准"),
      confirmedRubric: undefined,
    });
    const application = createRevisionFixture(source).application;
    const dispatcher = new ProductApiDispatcher(
      ADVANCEMENT_PRODUCT_API_EXACT_SET,
      [createAdvancementProductApiContribution(application)],
    );

    expect(ADVANCEMENT_PRODUCT_API_EXACT_SET.operations).toEqual([
      ADVANCEMENT_DETAIL_QUERY,
      ADVANCEMENT_REVISE_RUBRIC_COMMAND,
      ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
    ]);
    expect(ADVANCEMENT_PRODUCT_API_EXACT_SET.factEvents).toEqual([
      ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
    ]);
    await expect(
      dispatcher.query(ADVANCEMENT_DETAIL_QUERY, {
        conversationId: "conv-1",
      }),
    ).resolves.toMatchObject({ advancementSessionId: "adv-1" });
    await expect(
      dispatcher.command(ADVANCEMENT_REVISE_RUBRIC_COMMAND, {
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        userFeedback: "补充制品验收",
      }),
    ).resolves.toMatchObject({
      result: {
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        rubricDraftVersion: 2,
      },
      facts: [
        {
          kind: "advancement-contract-draft-revised",
          rubricDraftVersion: 2,
          revised: true,
        },
      ],
    });
    await expect(
      dispatcher.command(ADVANCEMENT_CANCEL_RUBRIC_COMMAND, {
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        executeOriginal: false,
        fact: { publish: vi.fn() },
        surface: testSurface(),
      }),
    ).resolves.toMatchObject({
      result: {
        kind: "cancelled",
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
      },
      facts: [
        {
          kind: "advancement-contract-cancelled",
          controlSeq: 3,
          executeOriginal: false,
        },
      ],
    });
  });
});

function port(session: AdvancementSession): AdvancementDetailReadPort {
  return { loadLatestSession: async () => session };
}

function createApplication(
  overrides: Partial<AdvancementApplicationOptions> = {},
): AdvancementApplicationService {
  const fixture = createRevisionFixture(
    session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待修订标准"),
      confirmedRubric: undefined,
    }),
  );
  return new AdvancementApplicationService({
    detail: overrides.detail ?? fixture.options.detail,
    maintenance: overrides.maintenance ?? fixture.options.maintenance,
    rubricRevision:
      overrides.rubricRevision ?? fixture.options.rubricRevision,
    rubricCancellation:
      overrides.rubricCancellation ?? fixture.options.rubricCancellation,
    originalTask: overrides.originalTask ?? fixture.options.originalTask,
  });
}

type RevisionFixtureOverrides =
  Partial<AdvancementRubricRevisionMechanismPort> &
  Partial<AdvancementRubricCancellationMechanismPort> &
  Readonly<{
    maintenance?: AdvancementConversationMaintenancePort;
    originalTask?: AdvancementOriginalTaskExecutionPort;
  }>;

function createRevisionFixture(
  initial: AdvancementSession,
  overrides: RevisionFixtureOverrides = {},
): Readonly<{
  application: AdvancementApplicationService;
  options: AdvancementApplicationOptions;
}> {
  let current = structuredClone(initial);
  const rubricRevision: AdvancementRubricRevisionMechanismPort = {
    loadRubricRevisionSession:
      overrides.loadRubricRevisionSession ?? (async () => current),
    reviseRubricDraftContent:
      overrides.reviseRubricDraftContent ??
      (async ({ currentDraft }) => ({
        ...currentDraft,
        draftId: `${currentDraft.draftId}-revised`,
      })),
    persistRubricDraftRevision:
      overrides.persistRubricDraftRevision ??
      (async ({ draft }) => {
        current = {
          ...current,
          pendingRubricDraft: draft,
          rubricDraftVersion: current.rubricDraftVersion + 1,
        };
        return current;
      }),
  };
  const maintenance: AdvancementConversationMaintenancePort =
    overrides.maintenance ?? {
      runExisting: async (_conversationId, operation) => ({
        status: "done",
        value: await operation(),
      }),
    };
  const rubricCancellation: AdvancementRubricCancellationMechanismPort = {
    loadRubricCancellationSession:
      overrides.loadRubricCancellationSession ?? (async () => current),
    persistRubricCancellation:
      overrides.persistRubricCancellation ??
      (async ({ reason, message }) => {
        current = {
          ...current,
          status: "cancelled",
          exit: {
            reason,
            message,
            occurredAt: "2026-01-01T00:06:00.000Z",
          },
        };
        return current;
      }),
  };
  const options: AdvancementApplicationOptions = {
    detail: port(current),
    maintenance,
    rubricRevision,
    rubricCancellation,
    originalTask:
      overrides.originalTask ??
      {
        execute: async (input) => {
          await input.surface.execute({
            conversationId: input.conversationId,
            turnId: input.originalTurnId,
            originalUserTask: input.originalUserTask,
          });
          return {
            conversationId: input.conversationId,
            turnId: input.originalTurnId,
            runStatus: "immediate",
          };
        },
      },
  };
  return Object.freeze({
    options,
    application: new AdvancementApplicationService(options),
  });
}

function testSurface(): AdvancementOriginalTaskSurfacePort {
  return Object.freeze({
    caller: Object.freeze({
      surfacePrincipal: "surface-test",
      connectionId: "connection-test",
    }),
    turnOrigin: Object.freeze({
      channel: "rpc",
      triggeredBy: "connection-test",
    }),
    execute: vi.fn(async () => undefined),
    cancelPending: vi.fn(),
  });
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
