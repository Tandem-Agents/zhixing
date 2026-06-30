import {
  AdvancementStore,
  ConservativeAdvancementAdmissionStrategy,
  RubricContractBuilder,
  type AdvancementAdmissionDecision,
  type AdvancementAdmissionStrategy,
  type AdvancementExit,
  type AdvancementSession,
  type RubricContractDraftSnapshot,
  type UserTurnInput,
} from "@zhixing/core";

export type AdvancementPrepareResult =
  | {
      readonly kind: "run-direct";
      readonly admission: AdvancementAdmissionDecision;
    }
  | {
      readonly kind: "awaiting-rubric-confirmation";
      readonly session: AdvancementSession;
      readonly draft: RubricContractDraftSnapshot;
      readonly admission: AdvancementAdmissionDecision;
    }
  | {
      readonly kind: "direct-original-task";
      readonly session: AdvancementSession;
      readonly originalTurnId: string;
      readonly originalUserTask: UserTurnInput;
    }
  | {
      readonly kind: "cancelled-pending-task";
      readonly session: AdvancementSession;
      readonly originalTurnId: string;
    }
  | {
      readonly kind: "contract-failed";
      readonly conversationId: string;
      readonly originalTurnId: string;
      readonly error: { readonly message: string };
    }
  | {
      readonly kind: "await-existing-confirmation";
      readonly session: AdvancementSession;
      readonly draft: RubricContractDraftSnapshot;
    };

export interface AdvancementConfirmedTurn {
  readonly session: AdvancementSession;
  readonly originalTurnId: string;
  readonly originalUserTask: UserTurnInput;
}

export interface AdvancementRevisedDraft {
  readonly session: AdvancementSession;
  readonly draft: RubricContractDraftSnapshot;
}

export type AdvancementCancelResult =
  | {
      readonly kind: "cancelled";
      readonly session: AdvancementSession;
      readonly originalTurnId?: string;
    }
  | {
      readonly kind: "direct-original-task";
      readonly session: AdvancementSession;
      readonly originalTurnId: string;
      readonly originalUserTask: UserTurnInput;
    };

export interface AdvancementControllerOptions {
  readonly store?: AdvancementStore;
  readonly contractBuilder?: RubricContractBuilder;
  readonly admissionStrategy?: AdvancementAdmissionStrategy;
  readonly now?: () => string;
}

export class AdvancementController {
  private readonly store: AdvancementStore;
  private readonly contractBuilder: RubricContractBuilder;
  private readonly admissionStrategy: AdvancementAdmissionStrategy;
  private readonly now: () => string;

  constructor(options: AdvancementControllerOptions = {}) {
    this.store = options.store ?? new AdvancementStore();
    this.contractBuilder = options.contractBuilder ?? new RubricContractBuilder();
    this.admissionStrategy =
      options.admissionStrategy ?? new ConservativeAdvancementAdmissionStrategy();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepareUserTurn(input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly userInput: UserTurnInput;
    readonly beforeCreateSession?: () => Promise<void>;
  }): Promise<AdvancementPrepareResult> {
    const open = await this.store.loadActiveSession(input.conversationId);
    if (open?.status === "awaiting-rubric-confirmation") {
      const admission = await this.admissionStrategy.decide({
        input: input.userInput,
        hasOpenAdvancementSession: true,
      });
      if (admission.action === "downgrade-to-direct") {
        const cancelled = await this.cancelSession(
          input.conversationId,
          open.id,
          "用户选择直接执行原始任务",
        );
        return {
          kind: "direct-original-task",
          session: cancelled,
          originalTurnId: open.pendingRubricDraft!.originalTurnId,
          originalUserTask: open.originalUserTask,
        };
      }
      if (admission.action === "cancel-pending-task") {
        const cancelled = await this.cancelSession(
          input.conversationId,
          open.id,
          "用户取消待确认任务",
        );
        return {
          kind: "cancelled-pending-task",
          session: cancelled,
          originalTurnId: open.pendingRubricDraft!.originalTurnId,
        };
      }
      return {
        kind: "await-existing-confirmation",
        session: open,
        draft: open.pendingRubricDraft!,
      };
    }

    if (open?.status === "active") {
      return {
        kind: "run-direct",
        admission: {
          kind: "direct-task",
          action: "run-direct",
          reason: "active-session-user-turn",
        },
      };
    }

    const admission = await this.admissionStrategy.decide({
      input: input.userInput,
    });
    if (admission.action !== "start-advancement") {
      return { kind: "run-direct", admission };
    }

    let draft: RubricContractDraftSnapshot;
    try {
      draft = await this.contractBuilder.buildDraft({
        originalTurnId: input.turnId,
        originalUserTask: input.userInput,
      });
    } catch (err) {
      return {
        kind: "contract-failed",
        conversationId: input.conversationId,
        originalTurnId: input.turnId,
        error: { message: errorMessage(err) },
      };
    }

    await input.beforeCreateSession?.();
    const session = await this.store.createSession({
      id: `adv_${draft.draftId}`,
      conversationId: input.conversationId,
      originalUserTask: input.userInput,
      pendingRubricDraft: draft,
      createdAt: draft.createdAt,
    });

    return {
      kind: "awaiting-rubric-confirmation",
      session,
      draft,
      admission,
    };
  }

  async confirmRubric(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
  }): Promise<AdvancementConfirmedTurn> {
    const session = await this.requireSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (session.status !== "awaiting-rubric-confirmation") {
      throw new Error(
        `AdvancementController: session "${session.id}" is not awaiting rubric confirmation`,
      );
    }
    const draft = session.pendingRubricDraft;
    if (!draft) {
      throw new Error(
        `AdvancementController: session "${session.id}" has no pending rubric draft`,
      );
    }
    const confirmedRubric = await this.contractBuilder.confirmDraft(draft);
    const confirmed = await this.store.confirmRubric(
      input.conversationId,
      input.advancementSessionId,
      confirmedRubric,
      confirmedRubric.confirmedAt,
    );
    return {
      session: confirmed,
      originalTurnId: draft.originalTurnId,
      originalUserTask: confirmed.originalUserTask,
    };
  }

  async reviseRubricDraft(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly userFeedback: string;
  }): Promise<AdvancementRevisedDraft> {
    const session = await this.requireSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (session.status !== "awaiting-rubric-confirmation") {
      throw new Error(
        `AdvancementController: session "${session.id}" is not awaiting rubric confirmation`,
      );
    }
    const draft = session.pendingRubricDraft;
    if (!draft) {
      throw new Error(
        `AdvancementController: session "${session.id}" has no pending rubric draft`,
      );
    }
    const revised = await this.contractBuilder.reviseDraft({
      currentDraft: draft,
      originalUserTask: session.originalUserTask,
      userFeedback: input.userFeedback,
    });
    const updated = await this.store.reviseRubricDraft(
      input.conversationId,
      input.advancementSessionId,
      revised,
      revised.createdAt,
    );
    return { session: updated, draft: revised };
  }

  async cancelRubric(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly executeOriginal?: boolean;
    readonly reason?: AdvancementExit["reason"];
    readonly message?: string;
  }): Promise<AdvancementCancelResult> {
    const session = await this.requireSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (session.status !== "awaiting-rubric-confirmation") {
      throw new Error(
        `AdvancementController: session "${session.id}" is not awaiting rubric confirmation`,
      );
    }
    const draft = session.pendingRubricDraft;
    const cancelled = await this.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      input.message ??
        (input.executeOriginal
          ? "用户选择直接执行原始任务"
          : "用户取消 Rubric 确认"),
      input.reason,
    );
    if (input.executeOriginal && draft) {
      return {
        kind: "direct-original-task",
        session: cancelled,
        originalTurnId: draft.originalTurnId,
        originalUserTask: session.originalUserTask,
      };
    }
    return {
      kind: "cancelled",
      session: cancelled,
      originalTurnId: draft?.originalTurnId,
    };
  }

  async cancelOpenSession(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly reason?: AdvancementExit["reason"];
    readonly message: string;
  }): Promise<AdvancementSession> {
    await this.requireSession(input.conversationId, input.advancementSessionId);
    return await this.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      input.message,
      input.reason,
    );
  }

  async cancelOpenConversationSession(input: {
    readonly conversationId: string;
    readonly reason?: AdvancementExit["reason"];
    readonly message: string;
  }): Promise<AdvancementSession | null> {
    const session = await this.store.loadActiveSession(input.conversationId);
    if (!session) return null;
    return await this.cancelSession(
      input.conversationId,
      session.id,
      input.message,
      input.reason,
    );
  }

  private async cancelSession(
    conversationId: string,
    sessionId: string,
    message: string,
    reason: AdvancementExit["reason"] = "user-cancelled",
  ): Promise<AdvancementSession> {
    return await this.store.cancelSession(conversationId, sessionId, {
      reason,
      message,
      occurredAt: this.now(),
    } satisfies AdvancementExit);
  }

  private async requireSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession> {
    const session = await this.store.loadSession(conversationId, sessionId);
    if (!session) {
      throw new Error(`AdvancementController: session "${sessionId}" not found`);
    }
    return session;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim().length > 0
    ? err.message
    : "Rubric contract draft generation failed";
}
