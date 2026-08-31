import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../../product-api/catalog.js";
import { buildClosureFacts, renderClosureReport } from "../closure.js";
import {
  ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
  ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
  ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
  ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
  ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
  ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
  ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
  ADVANCEMENT_ACTIVE_STATE_QUERY,
  ADVANCEMENT_DETAIL_QUERY,
  ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND,
  ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,
  ADVANCEMENT_PRODUCT_API_EXACT_SET,
  ADVANCEMENT_REVISE_RUBRIC_COMMAND,
  ADVANCEMENT_SESSION_EXITED_FACT_EVENT,
  AdvancementApplicationError,
  AdvancementApplicationService,
  AdvancementAcceptedTurnApplicationService,
  AdvancementConversationLifecycleApplicationService,
  AdvancementReviewResultProjectionApplicationService,
  AdvancementOriginalTaskAdmissionError,
  createAdvancementProductApiContribution,
  type AdvancementApplicationOptions,
  type AdvancementCommittedTurn,
  type AdvancementConversationLifecycleApplicationOptions,
  type AdvancementAwaitingRubricAdmissionMechanismPort,
  type AdvancementConversationMaintenancePort,
  type AdvancementDetailReadPort,
  type AdvancementRubricRevisionMechanismPort,
  type AdvancementRubricCancellationMechanismPort,
  type AdvancementRubricConfirmationMechanismPort,
  type AdvancementConfirmedOriginalTaskAdmissionPort,
  type AdvancementOriginalTaskExecutionPort,
  type AdvancementOriginalTaskSurfacePort,
  type RubricPublicationPort,
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

  it("owns confirmation, publishes the committed Fact before admission and settles the durable run identity", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    const order: string[] = [];
    let committed = source;
    const fixture = createRevisionFixture(source, {
      persistRubricConfirmation: async ({ confirmedRubric, admissionIntent }) => {
        order.push("commit-confirmation");
        committed = {
          ...source,
          status: "active",
          confirmedRubric,
          pendingRubricDraft: undefined,
          originalTaskAdmission: { status: "pending", intent: admissionIntent },
        };
        return committed;
      },
      confirmedOriginalTask: {
        admit: async (input) => {
          order.push("admit");
          expect(input.admissionIntent).toMatchObject({
            turnId: "turn-1",
            surfacePrincipal: "surface-test",
            turnOrigin: { channel: "rpc", triggeredBy: "surface-test" },
          });
          return {
            conversationId: "conv-1",
            turnId: "turn-1",
            runId: "run-confirmed",
            status: "queued",
          };
        },
      },
      persistOriginalTaskAdmissionSettlement: async ({ runId }) => {
        order.push("settle");
        committed = {
          ...committed,
          originalTaskAdmission: {
            status: "admitted",
            intent: committed.originalTaskAdmission!.intent,
            runId,
          },
        };
        return committed;
      },
      rubricPublication: {
        publish: async () => {
          order.push("publish-rubric");
          return { kind: "saved", rubricId: "rubric-new", revision: 1 };
        },
      },
    });

    const confirmed = await fixture.application.confirmRubric(
      confirmationCommand({
        persistence: { kind: "save-new" },
        fact: {
          publish: (fact) => {
            order.push(`fact:${fact.kind}`);
            expect(fact).toMatchObject({
              kind: "advancement-contract-confirmed",
              advancementSessionId: "adv-1",
              originalTurnId: "turn-1",
              controlSeq: 2,
            });
          },
        },
      }),
    );

    expect(order).toEqual([
      "commit-confirmation",
      "fact:advancement-contract-confirmed",
      "publish-rubric",
      "admit",
      "settle",
    ]);
    expect(confirmed.result).toEqual({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      turnId: "turn-1",
      runId: "run-confirmed",
      runStatus: "queued",
      rubricPublicationMessage: "准则已保存到准则库。",
    });
    expect(confirmed.fact.kind).toBe("advancement-contract-confirmed");
  });

  it("cancels a pre-confirmation conversation miss without projecting a cancellation Fact", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    const publish = vi.fn();
    const admit = vi.fn();
    const persistRubricCancellation = vi.fn(async ({ message }) => ({
      ...source,
      status: "cancelled" as const,
      exit: {
        reason: "system-error" as const,
        message,
        occurredAt: "2026-01-01T00:06:00.000Z",
      },
    }));
    const fixture = createRevisionFixture(source, {
      maintenance: {
        runExisting: async () => ({ status: "not-found" }),
      },
      persistRubricCancellation,
      confirmedOriginalTask: { admit },
    });

    await expect(
      fixture.application.confirmRubric(
        confirmationCommand({ fact: { publish } }),
      ),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "conversation-not-found",
    });

    expect(persistRubricCancellation).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("keeps a successful admission result when durable settlement must be recovered", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    let committed = source;
    const fixture = createRevisionFixture(source, {
      persistRubricConfirmation: async ({ confirmedRubric, admissionIntent }) => {
        committed = {
          ...source,
          status: "active",
          confirmedRubric,
          pendingRubricDraft: undefined,
          originalTaskAdmission: { status: "pending", intent: admissionIntent },
        };
        return committed;
      },
      confirmedOriginalTask: {
        admit: async () => ({
          conversationId: "conv-1",
          turnId: "turn-1",
          runId: "run-recover-settlement",
          status: "queued",
        }),
      },
      persistOriginalTaskAdmissionSettlement: async () => {
        throw new Error("settlement response lost");
      },
    });

    await expect(
      fixture.application.confirmRubric(confirmationCommand()),
    ).resolves.toMatchObject({
      result: {
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        turnId: "turn-1",
        runId: "run-recover-settlement",
        runStatus: "queued",
      },
      fact: { kind: "advancement-contract-confirmed" },
    });
    expect(committed.originalTaskAdmission).toMatchObject({
      status: "pending",
      intent: { turnId: "turn-1" },
    });
  });

  it.each([
    ["conversation-not-found", true],
    ["idempotency-conflict", true],
    ["queue-full", false],
    ["lifecycle-busy", false],
  ] as const)(
    "compensates only terminal original-task admission failure %s",
    async (reason, shouldCancel) => {
      const source = session({
        status: "awaiting-rubric-confirmation",
        pendingRubricDraft: pendingRubric("待确认标准"),
        confirmedRubric: undefined,
      });
      const originalError = new Error(`admission:${reason}`);
      const persistRubricCancellation = vi.fn(async ({ message }) => ({
        ...source,
        status: "cancelled" as const,
        exit: {
          reason: "system-error" as const,
          message,
          occurredAt: "2026-01-01T00:06:00.000Z",
        },
      }));
      const facts: string[] = [];
      const fixture = createRevisionFixture(source, {
        persistRubricCancellation,
        confirmedOriginalTask: {
          admit: async () => {
            throw new AdvancementOriginalTaskAdmissionError(
              reason,
              originalError,
            );
          },
        },
      });

      await expect(
        fixture.application.confirmRubric(
          confirmationCommand({
            fact: {
              publish: (fact) => {
                facts.push(fact.kind);
                if (fact.kind === "advancement-contract-cancelled") {
                  expect(fact.reason).toBe("original-task-admission-failed");
                  expect(fact.executeOriginal).toBe(false);
                }
              },
            },
          }),
        ),
      ).rejects.toBe(originalError);

      expect(persistRubricCancellation).toHaveBeenCalledTimes(
        shouldCancel ? 1 : 0,
      );
      expect(facts).toEqual(
        shouldCancel
          ? [
              "advancement-contract-confirmed",
              "advancement-contract-cancelled",
            ]
          : ["advancement-contract-confirmed"],
      );
    },
  );

  it("fails closed for a stale draft or unproved committed confirmation before Fact/admission", async () => {
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    const publish = vi.fn();
    const admit = vi.fn();
    const fixture = createRevisionFixture(source, {
      confirmedOriginalTask: { admit },
    });
    await expect(
      fixture.application.confirmRubric(
        confirmationCommand({ expectedRubricDraftId: "draft-stale", fact: { publish } }),
      ),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "rubric-draft-stale",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();

    const invalidCommit = createRevisionFixture(source, {
      persistRubricConfirmation: async () => source,
      confirmedOriginalTask: { admit },
    });
    await expect(
      invalidCommit.application.confirmRubric(
        confirmationCommand({ fact: { publish } }),
      ),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "committed-rubric-confirmation-missing",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("keeps an awaiting Rubric without writing or publishing and returns the authoritative draft", async () => {
    const persistRubricCancellation = vi.fn();
    const publish = vi.fn();
    const execute = vi.fn();
    const fixture = createRevisionFixture(
      session({
        status: "awaiting-rubric-confirmation",
        pendingRubricDraft: pendingRubric("待确认标准"),
        confirmedRubric: undefined,
      }),
      {
        decideAwaitingRubricAdmission: async () => ({
          kind: "question",
          action: "keep-awaiting-confirmation",
          reason: "继续等待",
        }),
        persistRubricCancellation,
        originalTask: { execute },
      },
    );

    const controlled = await fixture.application.controlAwaitingRubric({
      conversationId: "conv-1",
      userInput: { parts: [{ type: "text", text: "先等等" }] },
      fact: { publish },
      surface: testSurface(),
    });

    expect(controlled).toMatchObject({
      result: {
        kind: "keep-awaiting",
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        rubricDraft: { title: "待确认标准" },
      },
    });
    expect(Object.isFrozen(controlled.result)).toBe(true);
    expect(persistRubricCancellation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads and decides the awaiting state only inside Conversation maintenance", async () => {
    const order: string[] = [];
    let insideMaintenance = false;
    const awaiting = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("并发后可见标准"),
      confirmedRubric: undefined,
    });
    const loadLatestSession = vi.fn(async () => {
      order.push(insideMaintenance ? "read-inside" : "read-outside");
      return insideMaintenance ? awaiting : session({ status: "active" });
    });
    const decideAwaitingRubricAdmission = vi.fn(async () => {
      order.push("decide");
      return {
        kind: "question" as const,
        action: "keep-awaiting-confirmation" as const,
        reason: "继续等待",
      };
    });
    const application = createApplication({
      detail: { loadLatestSession },
      maintenance: {
        runExisting: async (_conversationId, operation) => {
          order.push("maintenance");
          insideMaintenance = true;
          try {
            return { status: "done", value: await operation() };
          } finally {
            insideMaintenance = false;
          }
        },
      },
      awaitingRubricAdmission: { decideAwaitingRubricAdmission },
    });

    await expect(
      application.controlAwaitingRubric({
        conversationId: "conv-1",
        userInput: { parts: [{ type: "text", text: "先等等" }] },
        fact: { publish: vi.fn() },
        surface: testSurface(),
      }),
    ).resolves.toMatchObject({
      result: {
        kind: "keep-awaiting",
        rubricDraft: { title: "并发后可见标准" },
      },
    });
    expect(order).toEqual(["maintenance", "read-inside", "decide"]);
    expect(loadLatestSession).toHaveBeenCalledOnce();
    expect(decideAwaitingRubricAdmission).toHaveBeenCalledOnce();
  });

  it("owns natural-language cancellation and publishes its committed user-cancelled Fact", async () => {
    const order: string[] = [];
    const source = session({
      status: "awaiting-rubric-confirmation",
      pendingRubricDraft: pendingRubric("待确认标准"),
      confirmedRubric: undefined,
    });
    const fixture = createRevisionFixture(source, {
      decideAwaitingRubricAdmission: async () => ({
        kind: "question",
        action: "cancel-pending-task",
        reason: "用户取消",
      }),
      persistRubricCancellation: async (input) => {
        order.push("persist");
        expect(input).toMatchObject({
          reason: "user-cancelled",
          message: "用户取消待确认任务",
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
    });

    const controlled = await fixture.application.controlAwaitingRubric({
      conversationId: "conv-1",
      userInput: { parts: [{ type: "text", text: "取消任务" }] },
      fact: { publish: (fact) => {
        order.push("fact");
        expect(fact).toMatchObject({
          kind: "advancement-contract-cancelled",
          originalTurnId: "turn-1",
          controlSeq: 2,
          executeOriginal: false,
          reason: "user-cancelled",
        });
      } },
      surface: testSurface(),
    });

    expect(order).toEqual(["persist", "fact"]);
    expect(controlled.result).toEqual({
      kind: "cancelled",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
    });
  });

  it("publishes cancellation before handing the original turn to Conversation", async () => {
    const order: string[] = [];
    const execute = vi.fn(async (input) => {
      order.push("execute");
      expect(input).toMatchObject({
        conversationId: "conv-1",
        originalTurnId: "turn-1",
      });
      return {
        conversationId: "conv-1",
        turnId: "turn-1",
        runId: "run-1",
        runStatus: "immediate" as const,
      };
    });
    const fixture = createRevisionFixture(
      session({
        status: "awaiting-rubric-confirmation",
        pendingRubricDraft: pendingRubric("待确认标准"),
        confirmedRubric: undefined,
      }),
      {
        decideAwaitingRubricAdmission: async () => ({
          kind: "direct-task",
          action: "downgrade-to-direct",
          reason: "直接执行",
        }),
        persistRubricCancellation: async (input) => {
          order.push("persist");
          return {
            ...session(),
            status: "cancelled",
            pendingRubricDraft: pendingRubric("待确认标准"),
            confirmedRubric: undefined,
            exit: {
              reason: input.reason,
              message: input.message,
              occurredAt: "2026-01-01T00:06:00.000Z",
            },
          };
        },
        originalTask: { execute },
      },
    );

    const controlled = await fixture.application.controlAwaitingRubric({
      conversationId: "conv-1",
      userInput: { parts: [{ type: "text", text: "直接执行" }] },
      fact: { publish: () => { order.push("fact"); } },
      surface: testSurface(),
    });

    expect(order).toEqual(["persist", "fact", "execute"]);
    expect(controlled.result).toEqual({
      kind: "direct-original-task",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      turnId: "turn-1",
      runId: "run-1",
      runStatus: "immediate",
    });
  });

  it("distinguishes not-applicable from maintenance refusal and keeps a visible Fact when handoff fails", async () => {
    const publish = vi.fn();
    const notApplicable = createApplication({
      detail: port(session({ status: "active" })),
    });
    await expect(
      notApplicable.controlAwaitingRubric({
        conversationId: "conv-1",
        userInput: { parts: [{ type: "text", text: "继续" }] },
        fact: { publish },
        surface: testSurface(),
      }),
    ).resolves.toEqual({ result: { kind: "not-applicable" } });

    const mismatched = createApplication({
      detail: port(
        session({
          conversationId: "conv-other",
          status: "awaiting-rubric-confirmation",
        }),
      ),
    });
    await expect(
      mismatched.controlAwaitingRubric({
        conversationId: "conv-1",
        userInput: { parts: [{ type: "text", text: "继续" }] },
        fact: { publish },
        surface: testSurface(),
      }),
    ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
      code: "advancement-session-identity-mismatch",
    });

    for (const status of ["not-found", "busy"] as const) {
      const application = createApplication({
        maintenance: { runExisting: async () => ({ status }) },
      });
      await expect(
        application.controlAwaitingRubric({
          conversationId: "conv-1",
          userInput: { parts: [{ type: "text", text: "继续" }] },
          fact: { publish },
          surface: testSurface(),
        }),
      ).rejects.toMatchObject<Partial<AdvancementApplicationError>>({
        code: status === "busy" ? "conversation-busy" : "conversation-not-found",
      });
    }

    const failedHandoff = createRevisionFixture(
      session({
        status: "awaiting-rubric-confirmation",
        pendingRubricDraft: pendingRubric("待确认标准"),
        confirmedRubric: undefined,
      }),
      {
        decideAwaitingRubricAdmission: async () => ({
          kind: "direct-task",
          action: "downgrade-to-direct",
          reason: "直接执行",
        }),
        originalTask: { execute: async () => { throw new Error("handoff failed"); } },
      },
    );
    await expect(
      failedHandoff.application.controlAwaitingRubric({
        conversationId: "conv-1",
        userInput: { parts: [{ type: "text", text: "直接执行" }] },
        fact: { publish },
        surface: testSurface(),
      }),
    ).rejects.toThrow("handoff failed");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("owns new-conversation admission, shell-before-session and committed draft Fact", async () => {
    const order: string[] = [];
    const draft = pendingRubric("新任务标准");
    const application = createApplication({
      maintenance: {
        runNew: async (_conversationId, operation) => {
          order.push("maintenance");
          return { status: "done", value: await operation() };
        },
        runExisting: async (_conversationId, operation) => ({
          status: "done",
          value: await operation(),
        }),
      },
      newTaskConversation: {
        ensureShell: async () => {
          order.push("shell");
        },
      },
      newTask: {
        loadOpenNewTaskSession: async () => {
          order.push("open");
          return null;
        },
        decideNewTaskAdmission: async () => {
          order.push("admission");
          return {
            kind: "advancement-task",
            action: "start-advancement",
            reason: "needs rubric",
          };
        },
        buildNewTaskRubricDraft: async () => {
          order.push("draft");
          return draft;
        },
        persistNewTaskAwaitingSession: async ({
          conversationId,
          originalUserTask,
        }) => {
          order.push("session");
          return session({
            id: "adv_draft-1",
            conversationId,
            status: "awaiting-rubric-confirmation",
            originalUserTask,
            pendingRubricDraft: draft,
            confirmedRubric: undefined,
          });
        },
      },
    });

    const prepared = await application.prepareNewTask({
      conversationId: "conv-new",
      conversationScope: "new",
      turnId: "turn-1",
      userInput: { parts: [{ type: "text", text: "把任务做完" }] },
    });

    expect(order).toEqual([
      "maintenance",
      "open",
      "admission",
      "draft",
      "shell",
      "session",
    ]);
    expect(prepared.result).toMatchObject({
      kind: "awaiting-rubric-confirmation",
      advancementSessionId: "adv_draft-1",
      conversationId: "conv-new",
    });
    expect(prepared.fact).toMatchObject({
      kind: "advancement-contract-draft-created",
      conversationId: "conv-new",
      originalTurnId: "turn-1",
      advancementSessionId: "adv_draft-1",
      rubricDraftId: "draft-1",
    });
  });

  it("keeps direct, busy, not-found and draft failure free of shell, session and Fact", async () => {
    const ensureShell = vi.fn(async () => undefined);
    const persist = vi.fn();
    const runDirect = createApplication({
      newTaskConversation: { ensureShell },
      newTask: {
        loadOpenNewTaskSession: async () => null,
        decideNewTaskAdmission: async () => ({
          kind: "direct-task",
          action: "run-direct",
          reason: "direct",
        }),
        buildNewTaskRubricDraft: vi.fn(),
        persistNewTaskAwaitingSession: persist,
      },
    });
    await expect(
      runDirect.prepareNewTask({
        conversationId: "conv-1",
        conversationScope: "existing",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "直接回答" }] },
      }),
    ).resolves.toEqual({
      result: {
        kind: "run-direct",
        admission: {
          kind: "direct-task",
          action: "run-direct",
          reason: "direct",
        },
      },
    });

    const busy = createApplication({
      maintenance: {
        runNew: async () => ({ status: "busy" }),
        runExisting: async () => ({ status: "busy" }),
      },
    });
    await expect(
      busy.prepareNewTask({
        conversationId: "conv-new",
        conversationScope: "new",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "直接回答" }] },
      }),
    ).resolves.toEqual({ result: { kind: "owner-busy" } });

    const notFound = createApplication({
      maintenance: {
        runNew: async () => ({ status: "busy" }),
        runExisting: async () => ({ status: "not-found" }),
      },
    });
    await expect(
      notFound.prepareNewTask({
        conversationId: "conv-missing",
        conversationScope: "existing",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "直接回答" }] },
      }),
    ).rejects.toMatchObject({ code: "conversation-not-found" });

    const failed = createApplication({
      newTaskConversation: { ensureShell },
      newTask: {
        loadOpenNewTaskSession: async () => null,
        decideNewTaskAdmission: async () => ({
          kind: "advancement-task",
          action: "start-advancement",
          reason: "needs rubric",
        }),
        buildNewTaskRubricDraft: async () => {
          throw new Error("draft unavailable");
        },
        persistNewTaskAwaitingSession: persist,
      },
    });
    await expect(
      failed.prepareNewTask({
        conversationId: "conv-new",
        conversationScope: "new",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "推进任务" }] },
      }),
    ).resolves.toEqual({
      result: {
        kind: "contract-failed",
        conversationId: "conv-new",
        originalTurnId: "turn-1",
        error: { message: "draft unavailable" },
      },
    });
    expect(ensureShell).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("fails closed for an open session and for a mismatched committed draft", async () => {
    const open = createApplication({
      newTask: {
        loadOpenNewTaskSession: async () => session(),
        decideNewTaskAdmission: vi.fn(),
        buildNewTaskRubricDraft: vi.fn(),
        persistNewTaskAwaitingSession: vi.fn(),
      },
    });
    await expect(
      open.prepareNewTask({
        conversationId: "conv-1",
        conversationScope: "existing",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "推进任务" }] },
      }),
    ).resolves.toEqual({ result: { kind: "not-applicable" } });

    const draft = pendingRubric("新任务标准");
    const mismatched = createApplication({
      newTask: {
        loadOpenNewTaskSession: async () => null,
        decideNewTaskAdmission: async () => ({
          kind: "advancement-task",
          action: "start-advancement",
          reason: "needs rubric",
        }),
        buildNewTaskRubricDraft: async () => draft,
        persistNewTaskAwaitingSession: async () =>
          session({
            id: "adv_other",
            status: "awaiting-rubric-confirmation",
            pendingRubricDraft: draft,
            confirmedRubric: undefined,
          }),
      },
    });
    await expect(
      mismatched.prepareNewTask({
        conversationId: "conv-1",
        conversationScope: "existing",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "推进任务" }] },
      }),
    ).rejects.toMatchObject({ code: "committed-rubric-draft-missing" });
  });

  it("does not persist after shell failure and does not emit a Fact after persistence failure", async () => {
    const draft = pendingRubric("新任务标准");
    const persistAfterShell = vi.fn();
    const shellFailure = createApplication({
      newTaskConversation: {
        ensureShell: async () => {
          throw new Error("shell failed");
        },
      },
      newTask: {
        loadOpenNewTaskSession: async () => null,
        decideNewTaskAdmission: async () => ({
          kind: "advancement-task",
          action: "start-advancement",
          reason: "needs rubric",
        }),
        buildNewTaskRubricDraft: async () => draft,
        persistNewTaskAwaitingSession: persistAfterShell,
      },
    });
    await expect(
      shellFailure.prepareNewTask({
        conversationId: "conv-new",
        conversationScope: "new",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "推进任务" }] },
      }),
    ).rejects.toThrow("shell failed");
    expect(persistAfterShell).not.toHaveBeenCalled();

    const persistenceFailure = createApplication({
      newTask: {
        loadOpenNewTaskSession: async () => null,
        decideNewTaskAdmission: async () => ({
          kind: "advancement-task",
          action: "start-advancement",
          reason: "needs rubric",
        }),
        buildNewTaskRubricDraft: async () => draft,
        persistNewTaskAwaitingSession: async () => {
          throw new Error("session write failed");
        },
      },
    });
    await expect(
      persistenceFailure.prepareNewTask({
        conversationId: "conv-1",
        conversationScope: "existing",
        turnId: "turn-1",
        userInput: { parts: [{ type: "text", text: "推进任务" }] },
      }),
    ).rejects.toThrow("session write failed");
  });

  it("owns active continuation ordering and settles only a genuinely interrupted outstanding proxy", async () => {
    const fixture = createActiveFixture({
      interruption: {
        interrupted: true,
        proxyMessageId: "proxy-1",
      },
    });

    const prepared = await fixture.application.prepareActiveUserTurn(
      activeCommand(fixture.surface),
    );

    expect(prepared).toMatchObject({
      result: {
        kind: "active-user-turn",
        interruptedProxy: true,
        handoff: { conversationId: "conv-1", turnId: "turn-active" },
      },
      facts: [],
    });
    expect(fixture.order).toEqual([
      "maintenance",
      "load-current",
      "interrupt",
      "admission",
      "settle",
      "handoff",
    ]);
  });

  it("keeps ordinary busy turns intact while the single application still classifies and hands off", async () => {
    const fixture = createActiveFixture({
      maintenanceStatus: "busy",
      interruption: { interrupted: false },
    });

    await expect(
      fixture.application.prepareActiveUserTurn(activeCommand(fixture.surface)),
    ).resolves.toMatchObject({
      result: { kind: "active-user-turn", interruptedProxy: false },
    });
    expect(fixture.order).toEqual([
      "maintenance",
      "load-current",
      "interrupt",
      "admission",
      "handoff",
    ]);
  });

  it("returns not-applicable without interrupting when the linearized active identity disappeared", async () => {
    const interruptProxy = vi.fn();
    let reads = 0;
    const application = createApplication({
      activeUserTurn: {
        loadActiveUserTurnSession: async () => {
          reads += 1;
          return reads === 1 ? session() : null;
        },
      } as AdvancementApplicationOptions["activeUserTurn"],
      activeUserTurnRuntime: {
        interruptProxy,
        recoverInterruptedProxy: vi.fn(),
      },
    });

    await expect(
      application.prepareActiveUserTurn(activeCommand(testActiveSurface())),
    ).resolves.toEqual({ result: { kind: "not-applicable" }, facts: [] });
    expect(interruptProxy).not.toHaveBeenCalled();
  });

  it("does not hand off when interrupted-proxy settlement fails", async () => {
    const fixture = createActiveFixture({
      interruption: { interrupted: true, proxyMessageId: "proxy-1" },
      settlementError: new Error("settlement failed"),
    });

    await expect(
      fixture.application.prepareActiveUserTurn(activeCommand(fixture.surface)),
    ).rejects.toThrow("settlement failed");
    expect(fixture.order).not.toContain("handoff");
  });

  it("keeps a committed exit Fact visible when the ordinary handoff fails", async () => {
    const fixture = createActiveFixture({
      admission: "take-over-active",
      handoffError: new Error("handoff failed"),
    });

    await expect(
      fixture.application.prepareActiveUserTurn(activeCommand(fixture.surface)),
    ).rejects.toThrow("handoff failed");
    expect(fixture.current().status).toBe("exited");
    expect(fixture.order.slice(-2)).toEqual(["publish-exit", "handoff"]);
  });

  it.each([
    {
      label: "takeover",
      admission: "take-over-active" as const,
      confirmedRubric: confirmedRubric("已确认标准"),
      reason: "user-took-over",
    },
    {
      label: "missing confirmed Rubric",
      admission: "revise-rubric" as const,
      confirmedRubric: undefined,
      reason: "system-error",
    },
  ])("commits and publishes $label exit before ordinary handoff", async ({
    admission,
    confirmedRubric,
    reason,
  }) => {
    const fixture = createActiveFixture({ admission, confirmedRubric });

    const prepared = await fixture.application.prepareActiveUserTurn(
      activeCommand(fixture.surface),
    );

    expect(prepared.result).toMatchObject({
      kind: "active-session-taken-over",
      exit: { reason },
    });
    expect(prepared.facts).toEqual([
      expect.objectContaining({
        kind: "advancement-session-exited",
        exit: expect.objectContaining({ reason }),
      }),
    ]);
    expect(fixture.order.slice(-4)).toEqual([
      "exit",
      "closure",
      "publish-exit",
      "handoff",
    ]);
  });

  it("regenerates from the confirmed Rubric and publishes exited before committed draft", async () => {
    const fixture = createActiveFixture({ admission: "revise-rubric" });

    const prepared = await fixture.application.prepareActiveUserTurn(
      activeCommand(fixture.surface, "补充文档验收"),
    );

    expect(prepared.result).toMatchObject({
      kind: "rubric-regenerated",
      exitedAdvancementSessionId: "adv-1",
      advancementSessionId: "adv_draft-regenerated",
      exit: { reason: "superseded" },
      draft: {
        originalTurnId: "turn-active",
        content: { passCriteria: ["测试通过", "补充文档验收"] },
      },
    });
    expect(prepared.facts.map((fact) => fact.kind)).toEqual([
      "advancement-session-exited",
      "advancement-contract-draft-created",
    ]);
    expect(fixture.order.slice(-6)).toEqual([
      "revise",
      "exit",
      "closure",
      "create",
      "publish-exit",
      "publish-draft",
    ]);
  });

  it("keeps the active contract on regeneration failure and projects failure before best-effort recovery", async () => {
    const fixture = createActiveFixture({
      admission: "revise-rubric",
      revisionError: new Error("revision provider down"),
      recoveryError: new Error("recovery unavailable"),
    });

    const prepared = await fixture.application.prepareActiveUserTurn(
      activeCommand(fixture.surface),
    );

    expect(prepared).toMatchObject({
      result: {
        kind: "contract-failed",
        error: { message: "revision provider down" },
      },
      facts: [],
    });
    expect(fixture.current().status).toBe("active");
    expect(fixture.order.slice(-3)).toEqual([
      "revise",
      "publish-failure",
      "recover",
    ]);
  });

  it("contributes two Queries plus six finite Commands and five Facts", async () => {
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
      ADVANCEMENT_ACTIVE_STATE_QUERY,
      ADVANCEMENT_DETAIL_QUERY,
      ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND,
      ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,
      ADVANCEMENT_REVISE_RUBRIC_COMMAND,
      ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
      ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
      ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
    ]);
    expect(ADVANCEMENT_PRODUCT_API_EXACT_SET.factEvents).toEqual([
      ADVANCEMENT_SESSION_EXITED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
    ]);
    await expect(
      dispatcher.query(ADVANCEMENT_ACTIVE_STATE_QUERY, {
        conversationId: "conv-1",
      }),
    ).resolves.toBeNull();
    await expect(
      dispatcher.query(ADVANCEMENT_DETAIL_QUERY, {
        conversationId: "conv-1",
      }),
    ).resolves.toMatchObject({ advancementSessionId: "adv-1" });
    await expect(
      dispatcher.command(ADVANCEMENT_PREPARE_NEW_TASK_COMMAND, {
        conversationId: "conv-new",
        conversationScope: "new",
        turnId: "turn-new",
        userInput: { parts: [{ type: "text", text: "直接回答" }] },
      }),
    ).resolves.toMatchObject({
      result: { kind: "run-direct" },
      facts: [],
    });
    await expect(
      dispatcher.command(ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND, {
        conversationId: "conv-1",
        userInput: { parts: [{ type: "text", text: "继续等待" }] },
        fact: { publish: vi.fn() },
        surface: testSurface(),
      }),
    ).resolves.toMatchObject({
      result: { kind: "keep-awaiting" },
      facts: [],
    });
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

describe("AdvancementConversationLifecycleApplicationService", () => {
  it("treats a missing open session as an idempotent cancellation success", async () => {
    const persist = vi.fn();
    const application = createConversationLifecycleApplication({
      mechanism: {
        loadOpenConversationLifecycleSession: async () => null,
        persistConversationLifecycleCancellation: persist,
        removeConversationData: async () => undefined,
        listConversationDataCandidates: async () => [],
        removeConversationDataCandidate: async () => undefined,
      },
    });

    await expect(
      application.cancelConversationLifecycle("conv-none"),
    ).resolves.toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["awaiting-rubric-confirmation", "active"] as const)(
    "cancels an open %s session with the Conversation-retirement decision",
    async (status) => {
      const open = session({ status });
      const persist = vi.fn(async (input) => ({
        ...open,
        status: "cancelled" as const,
        exit: {
          reason: input.reason,
          message: input.message,
          occurredAt: "2026-01-01T00:08:00.000Z",
        },
      }));
      const application = createConversationLifecycleApplication({
        mechanism: {
          loadOpenConversationLifecycleSession: async () => open,
          persistConversationLifecycleCancellation: persist,
          removeConversationData: async () => undefined,
          listConversationDataCandidates: async () => [],
          removeConversationDataCandidate: async () => undefined,
        },
      });

      await expect(
        application.cancelConversationLifecycle("conv-1"),
      ).resolves.toBeUndefined();
      expect(persist).toHaveBeenCalledWith({
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        reason: "user-cancelled",
        message: "原始对话已删除，推进会话已取消。",
      });
    },
  );

  it("propagates cancellation and direct data-removal failures", async () => {
    const open = session({ status: "active" });
    const application = createConversationLifecycleApplication({
      mechanism: {
        loadOpenConversationLifecycleSession: async () => open,
        persistConversationLifecycleCancellation: async () => {
          throw new Error("cancel failed");
        },
        removeConversationData: async () => {
          throw new Error("remove failed");
        },
        listConversationDataCandidates: async () => [],
        removeConversationDataCandidate: async () => undefined,
      },
    });

    await expect(
      application.cancelConversationLifecycle("conv-1"),
    ).rejects.toThrow("cancel failed");
    await expect(application.removeConversationData("conv-1")).rejects.toThrow(
      "remove failed",
    );
  });

  it("owns the alive/dead orphan decision and isolates per-candidate failures", async () => {
    const removed: string[] = [];
    const application = createConversationLifecycleApplication({
      mechanism: {
        loadOpenConversationLifecycleSession: async () => null,
        persistConversationLifecycleCancellation: async () => {
          throw new Error("unused");
        },
        removeConversationData: async () => undefined,
        listConversationDataCandidates: async () => [
          "alive",
          "dead",
          "probe-failure",
          "remove-failure",
        ],
        removeConversationDataCandidate: async (candidateId) => {
          if (candidateId === "remove-failure") throw new Error("remove denied");
          removed.push(candidateId);
        },
      },
      conversationAlive: {
        isConversationDataAlive: async (candidateId) => {
          if (candidateId === "probe-failure") throw new Error("probe failed");
          return candidateId === "alive";
        },
      },
    });

    await expect(application.sweepOrphanData()).resolves.toEqual({
      scanned: 4,
      removed: 1,
      warnings: [
        "probe-failure: probe failed",
        "remove-failure: remove denied",
      ],
    });
    expect(removed).toEqual(["dead"]);
  });

  it("keeps enumeration failure as an empty, idempotent sweep", async () => {
    const application = createConversationLifecycleApplication({
      mechanism: {
        loadOpenConversationLifecycleSession: async () => null,
        persistConversationLifecycleCancellation: async () => {
          throw new Error("unused");
        },
        removeConversationData: async () => undefined,
        listConversationDataCandidates: async () => {
          throw new Error("root unavailable");
        },
        removeConversationDataCandidate: async () => undefined,
      },
    });

    await expect(application.sweepOrphanData()).resolves.toEqual({
      scanned: 0,
      removed: 0,
      warnings: [],
    });
  });
});

describe("Advancement accepted-turn application", () => {
  it("admits only durable turns and orders catch-up, review, and result projection", async () => {
    const order: string[] = [];
    const events: string[] = [];
    const application = new AdvancementAcceptedTurnApplicationService({
      catchUp: {
        catchUpAcceptedTurn: async (_conversationId, beforeRunIndex) => {
          order.push(`catch-up:${beforeRunIndex}`);
          return { status: "no-pending-recovery" };
        },
      },
      review: {
        reviewAcceptedRun: async (input) => {
          order.push(`review:${input.runIndex}`);
          return acceptedTurnReviewResult("reviewed");
        },
      },
      results: {
        projectReviewResult: async (input) => {
          order.push(`project:${input.runId}`);
          events.push(input.result.kind);
        },
      },
    });

    application.acceptCommittedTurn(committedTurn({ ephemeral: true }));
    application.acceptCommittedTurn(committedTurn({ runIndex: 5 }));
    await flushAcceptedTurns();

    expect(order).toEqual(["catch-up:5", "review:5", "project:turn-1"]);
    expect(events).toEqual(["reviewed"]);
  });

  it("serializes one conversation, permits another, and does not poison the next turn", async () => {
    const first = deferred<void>();
    const reviewed: string[] = [];
    let failNext = false;
    const application = new AdvancementAcceptedTurnApplicationService({
      catchUp: {
        catchUpAcceptedTurn: async (conversationId, beforeRunIndex) => {
          if (conversationId === "conv-1" && beforeRunIndex === 0) {
            await first.promise;
          }
          return { status: "no-pending-recovery" };
        },
      },
      review: {
        reviewAcceptedRun: async (input) => {
          reviewed.push(`${input.conversationId}:${input.runIndex}`);
          if (failNext) {
            failNext = false;
            throw new Error("review unavailable");
          }
          return acceptedTurnReviewResult("reviewed");
        },
      },
      results: { projectReviewResult: async () => {} },
    });

    application.acceptCommittedTurn(committedTurn({ runIndex: 0 }));
    application.acceptCommittedTurn(committedTurn({ runIndex: 1, turnId: "turn-2" }));
    application.acceptCommittedTurn(
      committedTurn({ conversationId: "conv-2", runIndex: 0 }),
    );
    await flushAcceptedTurns();
    expect(reviewed).toEqual(["conv-2:0"]);

    first.resolve();
    await flushAcceptedTurns();
    expect(reviewed).toEqual(["conv-2:0", "conv-1:0", "conv-1:1"]);

    failNext = true;
    application.acceptCommittedTurn(committedTurn({ runIndex: 2 }));
    application.acceptCommittedTurn(committedTurn({ runIndex: 3 }));
    await flushAcceptedTurns();
    expect(reviewed.slice(-2)).toEqual(["conv-1:2", "conv-1:3"]);
  });

  it.each(["failed", "awaiting-original-run"] as const)(
    "does not review across a %s catch-up gap",
    async (status) => {
      const reviewAcceptedRun = vi.fn(async () =>
        acceptedTurnReviewResult("reviewed"),
      );
      const application = new AdvancementAcceptedTurnApplicationService({
        catchUp: { catchUpAcceptedTurn: async () => ({ status }) },
        review: { reviewAcceptedRun },
        results: { projectReviewResult: async () => {} },
      });
      application.acceptCommittedTurn(committedTurn());
      await flushAcceptedTurns();
      expect(reviewAcceptedRun).not.toHaveBeenCalled();
    },
  );

  it("does not review when catch-up rejects", async () => {
    const reviewAcceptedRun = vi.fn(async () =>
      acceptedTurnReviewResult("reviewed"),
    );
    const application = new AdvancementAcceptedTurnApplicationService({
      catchUp: {
        catchUpAcceptedTurn: async () => {
          throw new Error("recovery unavailable");
        },
      },
      review: { reviewAcceptedRun },
      results: { projectReviewResult: async () => {} },
    });
    application.acceptCommittedTurn(committedTurn());
    await flushAcceptedTurns();
    expect(reviewAcceptedRun).not.toHaveBeenCalled();
  });
});

describe("Advancement review result projection application", () => {
  it.each([
    ["skipped", []],
    ["review-deferred", ["advancement:review_deferred"]],
    ["reviewed", ["advancement:run_reviewed"]],
    ["proxy-enqueued", ["advancement:run_reviewed", "advancement:proxy_enqueued"]],
    ["completed", ["advancement:run_reviewed", "advancement:completed"]],
    ["exited", ["advancement:run_reviewed", "advancement:exited"]],
  ] as const)("projects %s with the established event sequence", async (kind, expected) => {
    const events: Array<{ readonly event: string; readonly seq: number }> = [];
    const schedule = vi.fn(async () => {});
    const application = new AdvancementReviewResultProjectionApplicationService({
      events: { emit: (event) => events.push(event) },
      proxySchedule: { schedule },
    });
    await application.projectReviewResult({
      conversationId: "conv-1",
      runId: "turn-1",
      result: acceptedTurnReviewResult(kind),
    });
    expect(events.map((event) => event.event)).toEqual(expected);
    expect(events.map((event) => event.seq)).toEqual(
      expected.map((_, index) => index as 0 | 1),
    );
    expect(schedule).toHaveBeenCalledTimes(kind === "proxy-enqueued" ? 1 : 0);
  });

  it("lets recovery reuse the same projection without proxy emission or scheduling", async () => {
    const events: string[] = [];
    const schedule = vi.fn(async () => {});
    const application = new AdvancementReviewResultProjectionApplicationService({
      events: { emit: (event) => events.push(event.event) },
      proxySchedule: { schedule },
    });
    await application.projectReviewResult({
      conversationId: "conv-1",
      runId: "turn-1",
      result: acceptedTurnReviewResult("proxy-enqueued"),
      emitProxyEnqueued: false,
      scheduleProxy: false,
    });
    expect(events).toEqual(["advancement:run_reviewed"]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("preserves review round, proxy identity, and terminal closure payloads", async () => {
    const events: Array<import("../application.js").AdvancementReviewPresentationEvent> = [];
    const application = new AdvancementReviewResultProjectionApplicationService({
      events: { emit: (event) => events.push(event) },
      proxySchedule: { schedule: async () => {} },
    });
    await application.projectReviewResult({
      conversationId: "conv-1",
      runId: "turn-1",
      result: acceptedTurnReviewResult("proxy-enqueued"),
    });
    expect(events).toEqual([
      expect.objectContaining({
        runId: "turn-1",
        seq: 0,
        payload: expect.objectContaining({
          advancementSessionId: "adv-1",
          reviewRound: 1,
        }),
      }),
      expect.objectContaining({
        runId: "proxy-1",
        seq: 1,
        payload: expect.objectContaining({
          proxyMessageId: "proxy-1",
          reviewId: "review-accepted",
        }),
      }),
    ]);

    events.length = 0;
    await application.projectReviewResult({
      conversationId: "conv-1",
      runId: "turn-1",
      result: acceptedTurnReviewResult("completed"),
    });
    expect(events[1]).toEqual(
      expect.objectContaining({
        event: "advancement:completed",
        seq: 1,
        payload: expect.objectContaining({
          reviewId: "review-accepted",
          closure: expect.objectContaining({ synthesized: false }),
        }),
      }),
    );
  });
});

function committedTurn(
  overrides: Partial<AdvancementCommittedTurn> = {},
): AdvancementCommittedTurn {
  return {
    conversationId: "conv-1",
    turnId: "turn-1",
    runIndex: 0,
    runRecord: {
      timestamp: "2026-01-01T00:00:00.000Z",
      messages: [],
    },
    runRecordRef: { shardId: "000001", runIndex: 0 },
    ephemeral: false,
    ...overrides,
  };
}

function acceptedTurnReviewResult(
  kind:
    | "skipped"
    | "review-deferred"
    | "reviewed"
    | "proxy-enqueued"
    | "completed"
    | "exited",
): import("../application.js").AdvancementTurnReviewResult {
  if (kind === "skipped") return { kind, reason: "no-active-session" };
  const reviewed = review("review-accepted", 0);
  const current = session({ runs: [reviewed] });
  if (kind === "review-deferred") {
    return {
      kind,
      session: current,
      cause: "infrastructure",
      reason: "review unavailable",
    };
  }
  if (kind === "reviewed") return { kind, session: current, review: reviewed };
  if (kind === "proxy-enqueued") {
    return {
      kind,
      session: current,
      review: reviewed,
      proxyMessage: {
        id: "proxy-1",
        sessionId: current.id,
        reviewId: reviewed.id,
        content: { parts: [{ type: "text", text: "continue" }] },
        rubricFailureHandlingId: "fix-tests",
        variables: {},
        createdAt: "2026-01-01T00:03:00.000Z",
      },
    };
  }
  return {
    kind,
    session: current,
    review: reviewed,
    exit: {
      reason: kind === "completed" ? "passed" : "system-error",
      message: "done",
      occurredAt: "2026-01-01T00:04:00.000Z",
    },
    closure: {
      summary: "done",
      synthesized: false,
      facts: buildClosureFacts(current),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushAcceptedTurns(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function port(session: AdvancementSession): AdvancementDetailReadPort {
  return { loadLatestSession: async () => session };
}

function createConversationLifecycleApplication(
  overrides: Partial<AdvancementConversationLifecycleApplicationOptions> = {},
): AdvancementConversationLifecycleApplicationService {
  return new AdvancementConversationLifecycleApplicationService({
    mechanism: overrides.mechanism ?? {
      loadOpenConversationLifecycleSession: async () => null,
      persistConversationLifecycleCancellation: async () => {
        throw new Error("unused lifecycle cancellation");
      },
      removeConversationData: async () => undefined,
      listConversationDataCandidates: async () => [],
      removeConversationDataCandidate: async () => undefined,
    },
    conversationAlive: overrides.conversationAlive ?? {
      isConversationDataAlive: async () => true,
    },
  });
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
    activeState: overrides.activeState ?? fixture.options.activeState,
    detail: overrides.detail ?? fixture.options.detail,
    maintenance: overrides.maintenance ?? fixture.options.maintenance,
    newTask: overrides.newTask ?? fixture.options.newTask,
    newTaskConversation:
      overrides.newTaskConversation ?? fixture.options.newTaskConversation,
    activeUserTurn:
      overrides.activeUserTurn ?? fixture.options.activeUserTurn,
    activeUserTurnRuntime:
      overrides.activeUserTurnRuntime ?? fixture.options.activeUserTurnRuntime,
    rubricRevision:
      overrides.rubricRevision ?? fixture.options.rubricRevision,
    rubricCancellation:
      overrides.rubricCancellation ?? fixture.options.rubricCancellation,
    awaitingRubricAdmission:
      overrides.awaitingRubricAdmission ??
      fixture.options.awaitingRubricAdmission,
    rubricConfirmation:
      overrides.rubricConfirmation ?? fixture.options.rubricConfirmation,
    rubricPublication:
      overrides.rubricPublication ?? fixture.options.rubricPublication,
    originalTask: overrides.originalTask ?? fixture.options.originalTask,
    confirmedOriginalTask:
      overrides.confirmedOriginalTask ?? fixture.options.confirmedOriginalTask,
  });
}

function activeCommand(
  surface: Parameters<AdvancementApplicationService["prepareActiveUserTurn"]>[0]["surface"],
  text = "继续推进",
): Parameters<AdvancementApplicationService["prepareActiveUserTurn"]>[0] {
  return {
    conversationId: "conv-1",
    turnId: "turn-active",
    userInput: { parts: [{ type: "text", text }] },
    surface,
  };
}

function testActiveSurface(): Parameters<
  AdvancementApplicationService["prepareActiveUserTurn"]
>[0]["surface"] {
  return {
    publishExit: vi.fn(),
    publishDraft: vi.fn(),
    publishContractFailure: vi.fn(),
    handoff: vi.fn(async ({ conversationId, turnId }) => ({
      conversationId,
      turnId,
    })),
  };
}

function createActiveFixture(overrides: Readonly<{
  admission?: "continue-active" | "take-over-active" | "revise-rubric";
  confirmedRubric?: ReturnType<typeof confirmedRubric> | undefined;
  interruption?: Readonly<{ interrupted: boolean; proxyMessageId?: string }>;
  maintenanceStatus?: "done" | "busy";
  revisionError?: Error;
  settlementError?: Error;
  handoffError?: Error;
  recoveryError?: Error;
}> = {}) {
  const order: string[] = [];
  let current = session({
    outstandingProxyMessageId: "proxy-1",
    ...(Object.prototype.hasOwnProperty.call(overrides, "confirmedRubric")
      ? { confirmedRubric: overrides.confirmedRubric }
      : {}),
  });
  let loads = 0;
  const activeUserTurn: AdvancementApplicationOptions["activeUserTurn"] = {
    loadActiveUserTurnSession: async () => {
      loads += 1;
      if (loads > 1) order.push("load-current");
      return current;
    },
    decideActiveUserTurnAdmission: async () => {
      order.push("admission");
      return {
        kind: "advancement-task",
        action: overrides.admission ?? "continue-active",
        reason: "test",
      };
    },
    activeUserTurnNow: () => "2026-01-01T00:06:00.000Z",
    createActiveRubricDraftId: () => "draft-regenerated",
    reviseActiveRubricDraft: async ({ currentDraft, userFeedback }) => {
      order.push("revise");
      if (overrides.revisionError) throw overrides.revisionError;
      return {
        ...currentDraft,
        content: {
          ...currentDraft.content,
          passCriteria: [
            ...currentDraft.content.passCriteria,
            userFeedback,
          ],
        },
      };
    },
    persistActiveUserTurnExit: async ({ exit }) => {
      order.push("exit");
      current = { ...current, status: "exited", exit };
      return current;
    },
    composeActiveUserTurnClosure: async (committed) => {
      order.push("closure");
      const facts = buildClosureFacts(committed);
      return {
        summary: renderClosureReport(facts),
        synthesized: false,
        facts,
      };
    },
    persistRegeneratedRubricSession: async ({
      advancementSessionId,
      conversationId,
      originalUserTask,
      draft,
    }) => {
      order.push("create");
      current = session({
        id: advancementSessionId,
        conversationId,
        status: "awaiting-rubric-confirmation",
        originalUserTask,
        pendingRubricDraft: draft,
        confirmedRubric: undefined,
        outstandingProxyMessageId: undefined,
      });
      return current;
    },
    settleInterruptedProxy: async () => {
      order.push("settle");
      if (overrides.settlementError) throw overrides.settlementError;
      current = { ...current, outstandingProxyMessageId: undefined };
      return current;
    },
  };
  const application = createApplication({
    maintenance: {
      runNew: async (_conversationId, operation) => ({
        status: "done",
        value: await operation(),
      }),
      runExisting: async (_conversationId, operation) => {
        order.push("maintenance");
        return overrides.maintenanceStatus === "busy"
          ? { status: "busy" as const }
          : { status: "done" as const, value: await operation() };
      },
    },
    activeUserTurn,
    activeUserTurnRuntime: {
      interruptProxy: async () => {
        order.push("interrupt");
        return overrides.interruption ?? { interrupted: false };
      },
      recoverInterruptedProxy: async () => {
        order.push("recover");
        if (overrides.recoveryError) throw overrides.recoveryError;
      },
    },
  });
  const surface: Parameters<
    AdvancementApplicationService["prepareActiveUserTurn"]
  >[0]["surface"] = {
    publishExit: async () => {
      order.push("publish-exit");
    },
    publishDraft: async () => {
      order.push("publish-draft");
    },
    publishContractFailure: async () => {
      order.push("publish-failure");
    },
    handoff: async (input) => {
      order.push("handoff");
      if (overrides.handoffError) throw overrides.handoffError;
      return {
        conversationId: input.conversationId,
        turnId: input.turnId,
      };
    },
  };
  return {
    application,
    current: () => current,
    order,
    surface,
  };
}

type RevisionFixtureOverrides =
  Partial<AdvancementRubricRevisionMechanismPort> &
  Partial<AdvancementRubricCancellationMechanismPort> &
  Partial<AdvancementAwaitingRubricAdmissionMechanismPort> &
  Partial<AdvancementRubricConfirmationMechanismPort> &
  Readonly<{
    maintenance?: AdvancementConversationMaintenancePort;
    newTask?: AdvancementApplicationOptions["newTask"];
    newTaskConversation?: AdvancementApplicationOptions["newTaskConversation"];
    activeUserTurn?: AdvancementApplicationOptions["activeUserTurn"];
    activeUserTurnRuntime?: AdvancementApplicationOptions["activeUserTurnRuntime"];
    originalTask?: AdvancementOriginalTaskExecutionPort;
    confirmedOriginalTask?: AdvancementConfirmedOriginalTaskAdmissionPort;
    rubricPublication?: RubricPublicationPort;
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
      runNew: async (_conversationId, operation) => ({
        status: "done",
        value: await operation(),
      }),
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
  const awaitingRubricAdmission: AdvancementAwaitingRubricAdmissionMechanismPort = {
    decideAwaitingRubricAdmission:
      overrides.decideAwaitingRubricAdmission ??
      (async () => ({
        kind: "question",
        action: "keep-awaiting-confirmation",
        reason: "test",
      })),
  };
  const rubricConfirmation: AdvancementRubricConfirmationMechanismPort = {
    loadRubricConfirmationSession:
      overrides.loadRubricConfirmationSession ?? (async () => current),
    confirmRubricDraftContent:
      overrides.confirmRubricDraftContent ??
      (async (draft) => ({
        source: {
          kind: "generated" as const,
          draftId: draft.draftId,
          candidateRubricIds: draft.candidateRubricIds,
        },
        title: draft.title,
        description: draft.description,
        content: {
          passCriteria: draft.content.passCriteria.map((text, index) => ({
            id: `pc-${index + 1}`,
            text,
          })),
          evidenceRequirements: draft.content.evidenceRequirements.map(
            (text, index) => ({ id: `er-${index + 1}`, text }),
          ),
          failureHandling: draft.content.failureHandling.map((text, index) => ({
            id: `fh-${index + 1}`,
            text,
          })),
        },
        confirmedAt: "2026-01-01T00:05:00.000Z",
        confirmedBy: "user" as const,
      })),
    persistRubricConfirmation:
      overrides.persistRubricConfirmation ??
      (async ({ confirmedRubric, admissionIntent }) => {
        current = {
          ...current,
          status: "active",
          confirmedRubric,
          pendingRubricDraft: undefined,
          originalTaskAdmission: {
            status: "pending",
            intent: admissionIntent,
          },
        };
        return current;
      }),
    persistOriginalTaskAdmissionSettlement:
      overrides.persistOriginalTaskAdmissionSettlement ??
      (async ({ runId }) => {
        const pending = current.originalTaskAdmission;
        if (!pending) throw new Error("missing admission intent");
        current = {
          ...current,
          originalTaskAdmission: {
            status: "admitted",
            intent: pending.intent,
            runId,
          },
        };
        return current;
      }),
  };
  const options: AdvancementApplicationOptions = {
    activeState: overrides.activeState ?? {
      queryActiveState: async () => null,
    },
    detail: port(current),
    maintenance,
    newTask: overrides.newTask ?? {
      loadOpenNewTaskSession: async () => null,
      decideNewTaskAdmission: async () => ({
        kind: "direct-task",
        action: "run-direct",
        reason: "test",
      }),
      buildNewTaskRubricDraft: async () => pendingRubric("新任务标准"),
      persistNewTaskAwaitingSession: async ({
        conversationId,
        originalUserTask,
        draft,
      }) => {
        current = session({
          id: `adv_${draft.draftId}`,
          conversationId,
          status: "awaiting-rubric-confirmation",
          originalUserTask,
          pendingRubricDraft: draft,
          confirmedRubric: undefined,
        });
        return current;
      },
    },
    newTaskConversation: overrides.newTaskConversation ?? {
      ensureShell: async () => undefined,
    },
    activeUserTurn: overrides.activeUserTurn ?? {
      loadActiveUserTurnSession: async () => current,
      decideActiveUserTurnAdmission: async () => ({
        kind: "advancement-task",
        action: "continue-active",
        reason: "test",
      }),
      activeUserTurnNow: () => "2026-01-01T00:06:00.000Z",
      createActiveRubricDraftId: () => "draft-regenerated",
      reviseActiveRubricDraft: async ({ currentDraft }) => currentDraft,
      persistActiveUserTurnExit: async ({ exit }) => {
        current = { ...current, status: "exited", exit };
        return current;
      },
      composeActiveUserTurnClosure: async (committed) => {
        const facts = buildClosureFacts(committed);
        return {
          summary: renderClosureReport(facts),
          synthesized: false,
          facts,
        };
      },
      persistRegeneratedRubricSession: async ({
        advancementSessionId,
        conversationId,
        originalUserTask,
        draft,
      }) => {
        current = session({
          id: advancementSessionId,
          conversationId,
          status: "awaiting-rubric-confirmation",
          originalUserTask,
          pendingRubricDraft: draft,
          confirmedRubric: undefined,
        });
        return current;
      },
      settleInterruptedProxy: async () => {
        current = { ...current, outstandingProxyMessageId: undefined };
        return current;
      },
    },
    activeUserTurnRuntime: overrides.activeUserTurnRuntime ?? {
      interruptProxy: async () => ({ interrupted: false }),
      recoverInterruptedProxy: async () => undefined,
    },
    rubricRevision,
    rubricCancellation,
    awaitingRubricAdmission,
    rubricConfirmation,
    ...(overrides.rubricPublication
      ? { rubricPublication: overrides.rubricPublication }
      : {}),
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
    confirmedOriginalTask:
      overrides.confirmedOriginalTask ??
      {
        admit: async (input) => ({
          conversationId: input.conversationId,
          turnId: input.admissionIntent.turnId,
          runId: "run-1",
          status: "immediate",
        }),
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

function confirmationCommand(
  overrides: Partial<
    Parameters<AdvancementApplicationService["confirmRubric"]>[0]
  > = {},
): Parameters<AdvancementApplicationService["confirmRubric"]>[0] {
  return {
    conversationId: "conv-1",
    advancementSessionId: "adv-1",
    expectedRubricDraftId: "draft-1",
    originalTaskTurnOrigin: {
      channel: "rpc",
      triggeredBy: "surface-test",
    },
    fact: { publish: vi.fn() },
    surface: testSurface(),
    ...overrides,
  };
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
