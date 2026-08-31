import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiFact,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { buildClosureFacts, type AdvancementClosureFacts } from "./closure.js";
import type {
  AdvancementExit,
  AdvancementRunReview,
  AdvancementSession,
  AdvancementSessionStatus,
  RubricContractDraftSnapshot,
} from "./types.js";
import type { UserTurnInput } from "../types/user-input.js";
import type { TurnOrigin } from "../types/tools.js";

/** Path-free read mechanism for the current Advancement owner projection. */
export interface AdvancementDetailReadPort {
  loadLatestSession(conversationId: string): Promise<AdvancementSession | null>;
}

/** Conversation-owned exclusivity mechanism; Advancement owns the enclosed decision. */
export interface AdvancementConversationMaintenancePort {
  runExisting<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<
    | { readonly status: "done"; readonly value: T }
    | { readonly status: "busy" }
    | { readonly status: "not-found" }
  >;
}

/** Path-free mechanisms used by the Advancement rubric-revision application decision. */
export interface AdvancementRubricRevisionMechanismPort {
  loadRubricRevisionSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null>;
  reviseRubricDraftContent(input: Readonly<{
    currentDraft: RubricContractDraftSnapshot;
    originalUserTask: AdvancementSession["originalUserTask"];
    userFeedback: string;
  }>): Promise<RubricContractDraftSnapshot>;
  persistRubricDraftRevision(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession>;
}

/** Path-free mechanisms for the durable Advancement cancellation transition. */
export interface AdvancementRubricCancellationMechanismPort {
  loadRubricCancellationSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null>;
  persistRubricCancellation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession>;
}

/** Cross-domain execution effect invoked only after the cancellation Fact is visible. */
export interface AdvancementOriginalTaskExecutionPort {
  execute(input: Readonly<{
    conversationId: string;
    originalTurnId: string;
    originalUserTask: Readonly<UserTurnInput>;
    surface: AdvancementOriginalTaskSurfacePort;
  }>): Promise<Readonly<{
    conversationId: string;
    turnId: string;
    runId?: string;
    runStatus: "immediate" | "queued";
  }>>;
}

/** Surface-owned effects needed by the Anchor cross-domain execution adapter. */
export interface AdvancementOriginalTaskSurfacePort {
  readonly caller: Readonly<{
    surfacePrincipal: string;
    connectionId: string;
  }>;
  readonly turnOrigin?: TurnOrigin;
  execute(input: Readonly<{
    conversationId: string;
    turnId: string;
    originalUserTask: Readonly<UserTurnInput>;
  }>): Promise<void>;
  cancelPending(input: Readonly<{
    conversationId: string;
    turnId: string;
  }>): void;
  onAdmitted?(input: Readonly<{
    conversationId: string;
    turnId: string;
    runId?: string;
    status: "immediate" | "queued" | "replayed";
  }>): void;
}

/** Surface projection effect; it cannot decide or persist Advancement state. */
export interface AdvancementRubricCancellationFactPort {
  publish(fact: AdvancementContractCancelledFact): void | Promise<void>;
}

export interface AdvancementApplicationOptions {
  readonly detail: AdvancementDetailReadPort;
  readonly maintenance: AdvancementConversationMaintenancePort;
  readonly rubricRevision: AdvancementRubricRevisionMechanismPort;
  readonly rubricCancellation: AdvancementRubricCancellationMechanismPort;
  readonly originalTask: AdvancementOriginalTaskExecutionPort;
}

export interface AdvancementDetailQuery {
  readonly conversationId: string;
}

export interface AdvancementDetailProjection {
  readonly advancementSessionId: string;
  readonly status: AdvancementSessionStatus;
  readonly rubricTitle?: string;
  readonly exit?: AdvancementExit;
  readonly facts: AdvancementClosureFacts;
  readonly lastReview?: AdvancementRunReview;
}

export type AdvancementDetailResult = AdvancementDetailProjection | null;

export interface AdvancementRubricRevisionCommand {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly userFeedback: string;
}

export interface AdvancementRubricRevisionResult {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraftVersion: number;
  readonly rubricDraft: RubricContractDraftSnapshot;
}

export interface AdvancementContractDraftRevisedFact extends ProductApiFact {
  readonly kind: "advancement-contract-draft-revised";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraftVersion: number;
  readonly rubricDraft: RubricContractDraftSnapshot;
  readonly revised: true;
}

export interface AdvancementRubricCancellationCommand {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly executeOriginal: boolean;
  readonly fact: AdvancementRubricCancellationFactPort;
  readonly surface: AdvancementOriginalTaskSurfacePort;
}

export type AdvancementRubricCancellationResult =
  | Readonly<{
      kind: "cancelled";
      conversationId: string;
      advancementSessionId: string;
    }>
  | Readonly<{
      kind: "direct-original-task";
      conversationId: string;
      advancementSessionId: string;
      turnId: string;
      runId?: string;
      runStatus: "immediate" | "queued";
    }>;

export interface AdvancementContractCancelledFact extends ProductApiFact {
  readonly kind: "advancement-contract-cancelled";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly controlSeq: number;
  readonly executeOriginal: boolean;
}

export type AdvancementApplicationErrorCode =
  | "conversation-not-found"
  | "conversation-busy"
  | "advancement-session-not-found"
  | "advancement-session-identity-mismatch"
  | "not-awaiting-rubric-confirmation"
  | "pending-rubric-draft-missing"
  | "committed-rubric-draft-missing"
  | "committed-cancellation-missing";

export class AdvancementApplicationError extends Error {
  readonly code: AdvancementApplicationErrorCode;
  readonly advancementSessionId?: string;

  constructor(
    code: AdvancementApplicationErrorCode,
    message: string,
    options: Readonly<{ advancementSessionId?: string }> = {},
  ) {
    super(message);
    this.name = "AdvancementApplicationError";
    this.code = code;
    this.advancementSessionId = options.advancementSessionId;
  }
}

export interface AdvancementApplication {
  queryDetail(query: AdvancementDetailQuery): Promise<AdvancementDetailResult>;
  reviseRubricDraft(
    command: AdvancementRubricRevisionCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricRevisionResult;
    fact: AdvancementContractDraftRevisedFact;
  }>>;
  cancelRubric(
    command: AdvancementRubricCancellationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricCancellationResult;
    fact: AdvancementContractCancelledFact;
  }>>;
}

/** Advancement-owned application decisions exposed through one finite Product API contribution. */
export class AdvancementApplicationService implements AdvancementApplication {
  readonly #detail: AdvancementDetailReadPort;
  readonly #maintenance: AdvancementConversationMaintenancePort;
  readonly #rubricRevision: AdvancementRubricRevisionMechanismPort;
  readonly #rubricCancellation: AdvancementRubricCancellationMechanismPort;
  readonly #originalTask: AdvancementOriginalTaskExecutionPort;

  constructor(options: AdvancementApplicationOptions) {
    this.#detail = options.detail;
    this.#maintenance = options.maintenance;
    this.#rubricRevision = options.rubricRevision;
    this.#rubricCancellation = options.rubricCancellation;
    this.#originalTask = options.originalTask;
  }

  async queryDetail(
    query: AdvancementDetailQuery,
  ): Promise<AdvancementDetailResult> {
    assertConversationId(query.conversationId);
    const session = await this.#detail.loadLatestSession(query.conversationId);
    if (!session) return null;

    const lastReview = session.runs[session.runs.length - 1];
    return freezeSnapshot({
      advancementSessionId: session.id,
      status: session.status,
      ...(session.confirmedRubric?.title
        ? { rubricTitle: session.confirmedRubric.title }
        : session.pendingRubricDraft?.title
          ? { rubricTitle: session.pendingRubricDraft.title }
          : {}),
      ...(session.exit ? { exit: session.exit } : {}),
      facts: buildClosureFacts(session),
      ...(lastReview ? { lastReview } : {}),
    });
  }

  async reviseRubricDraft(
    command: AdvancementRubricRevisionCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricRevisionResult;
    fact: AdvancementContractDraftRevisedFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    assertRubricRevisionIdentity(
      command.advancementSessionId,
      "Advancement session",
    );
    const userFeedback = normalizeUserFeedback(command.userFeedback);
    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session = await this.#rubricRevision.loadRubricRevisionSession(
          command.conversationId,
          command.advancementSessionId,
        );
        if (!session) {
          throw new AdvancementApplicationError(
            "advancement-session-not-found",
            `Advancement session not found: ${command.advancementSessionId}`,
            { advancementSessionId: command.advancementSessionId },
          );
        }
        if (session.status !== "awaiting-rubric-confirmation") {
          throw new AdvancementApplicationError(
            "not-awaiting-rubric-confirmation",
            `Advancement session is not awaiting rubric confirmation: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const currentDraft = session.pendingRubricDraft;
        if (!currentDraft) {
          throw new AdvancementApplicationError(
            "pending-rubric-draft-missing",
            `Advancement session has no pending rubric draft: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const revisedDraft =
          await this.#rubricRevision.reviseRubricDraftContent({
            currentDraft,
            originalUserTask: session.originalUserTask,
            userFeedback,
          });
        const updated =
          await this.#rubricRevision.persistRubricDraftRevision({
            conversationId: command.conversationId,
            advancementSessionId: command.advancementSessionId,
            draft: revisedDraft,
          });
        const committedDraft = updated.pendingRubricDraft;
        if (!committedDraft) {
          throw new AdvancementApplicationError(
            "committed-rubric-draft-missing",
            `Committed Advancement session has no pending rubric draft: ${updated.id}`,
            { advancementSessionId: updated.id },
          );
        }
        const rubricDraft = freezeSnapshot(committedDraft);
        const result = Object.freeze<AdvancementRubricRevisionResult>({
          conversationId: updated.conversationId,
          advancementSessionId: updated.id,
          rubricDraftId: rubricDraft.draftId,
          rubricDraftVersion: updated.rubricDraftVersion,
          rubricDraft,
        });
        const fact = Object.freeze<AdvancementContractDraftRevisedFact>({
          kind: "advancement-contract-draft-revised",
          conversationId: updated.conversationId,
          originalTurnId: rubricDraft.originalTurnId,
          advancementSessionId: updated.id,
          rubricDraftId: rubricDraft.draftId,
          rubricDraftVersion: updated.rubricDraftVersion,
          rubricDraft,
          revised: true,
        });
        return Object.freeze({ result, fact });
      },
    );
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    if (maintained.status === "busy") {
      throw new AdvancementApplicationError(
        "conversation-busy",
        `Conversation is busy: ${command.conversationId}`,
      );
    }
    return maintained.value;
  }

  async cancelRubric(
    command: AdvancementRubricCancellationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricCancellationResult;
    fact: AdvancementContractCancelledFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    assertRubricRevisionIdentity(
      command.advancementSessionId,
      "Advancement session",
    );
    if (typeof command.executeOriginal !== "boolean") {
      throw new TypeError("Advancement rubric cancellation requires an executeOriginal decision");
    }
    if (typeof command.fact?.publish !== "function") {
      throw new TypeError("Advancement rubric cancellation requires a Fact projection port");
    }
    if (
      typeof command.surface?.caller?.surfacePrincipal !== "string" ||
      command.surface.caller.surfacePrincipal.length === 0 ||
      typeof command.surface.caller.connectionId !== "string" ||
      command.surface.caller.connectionId.length === 0 ||
      typeof command.surface.execute !== "function" ||
      typeof command.surface.cancelPending !== "function"
    ) {
      throw new TypeError("Advancement rubric cancellation requires a surface effect port");
    }

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session =
          await this.#rubricCancellation.loadRubricCancellationSession(
            command.conversationId,
            command.advancementSessionId,
          );
        if (!session) {
          throw new AdvancementApplicationError(
            "advancement-session-not-found",
            `Advancement session not found: ${command.advancementSessionId}`,
            { advancementSessionId: command.advancementSessionId },
          );
        }
        if (
          session.conversationId !== command.conversationId ||
          session.id !== command.advancementSessionId
        ) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Advancement cancellation mechanism returned a mismatched session identity",
            { advancementSessionId: command.advancementSessionId },
          );
        }
        if (session.status !== "awaiting-rubric-confirmation") {
          throw new AdvancementApplicationError(
            "not-awaiting-rubric-confirmation",
            `Advancement session is not awaiting rubric confirmation: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }

        const committed =
          await this.#rubricCancellation.persistRubricCancellation({
            conversationId: command.conversationId,
            advancementSessionId: command.advancementSessionId,
            reason: "user-cancelled",
            message: command.executeOriginal
              ? "用户选择直接执行原始任务"
              : "用户取消 Rubric 确认",
          });
        if (committed.status !== "cancelled") {
          throw new AdvancementApplicationError(
            "committed-cancellation-missing",
            `Committed Advancement session is not cancelled: ${committed.id}`,
            { advancementSessionId: committed.id },
          );
        }
        if (
          committed.conversationId !== command.conversationId ||
          committed.id !== command.advancementSessionId
        ) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Committed Advancement cancellation has a mismatched session identity",
            { advancementSessionId: command.advancementSessionId },
          );
        }
        const draft = committed.pendingRubricDraft;
        const executeOriginal = command.executeOriginal && draft !== undefined;
        const fact = Object.freeze<AdvancementContractCancelledFact>({
          kind: "advancement-contract-cancelled",
          conversationId: committed.conversationId,
          originalTurnId: draft?.originalTurnId ?? committed.id,
          advancementSessionId: committed.id,
          controlSeq: committed.rubricDraftVersion + 1,
          executeOriginal,
        });
        return Object.freeze({
          committed,
          draft,
          executeOriginal,
          fact,
          originalUserTask: freezeSnapshot(committed.originalUserTask),
        });
      },
    );
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    if (maintained.status === "busy") {
      throw new AdvancementApplicationError(
        "conversation-busy",
        `Conversation is busy: ${command.conversationId}`,
      );
    }

    const decision = maintained.value;
    await command.fact.publish(decision.fact);
    if (!decision.executeOriginal || !decision.draft) {
      return Object.freeze({
        result: Object.freeze<AdvancementRubricCancellationResult>({
          kind: "cancelled",
          conversationId: decision.committed.conversationId,
          advancementSessionId: decision.committed.id,
        }),
        fact: decision.fact,
      });
    }

    const executed = await this.#originalTask.execute({
      conversationId: decision.committed.conversationId,
      originalTurnId: decision.draft.originalTurnId,
      originalUserTask: decision.originalUserTask,
      surface: command.surface,
    });
    if (
      executed.conversationId !== decision.committed.conversationId ||
      executed.turnId !== decision.draft.originalTurnId
    ) {
      throw new TypeError(
        "Advancement original-task execution returned a mismatched identity",
      );
    }
    return Object.freeze({
      result: Object.freeze<AdvancementRubricCancellationResult>({
        kind: "direct-original-task",
        conversationId: executed.conversationId,
        advancementSessionId: decision.committed.id,
        turnId: executed.turnId,
        ...(executed.runId ? { runId: executed.runId } : {}),
        runStatus: executed.runStatus,
      }),
      fact: decision.fact,
    });
  }
}

export const ADVANCEMENT_DETAIL_QUERY = defineProductApiQuery<
  "advancement.query.detail",
  AdvancementDetailQuery,
  AdvancementDetailResult
>("advancement.query.detail");

export const ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-draft-revised",
    AdvancementContractDraftRevisedFact
  >("advancement-contract-draft-revised");

export const ADVANCEMENT_REVISE_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.revise-rubric",
  AdvancementRubricRevisionCommand,
  AdvancementRubricRevisionResult,
  AdvancementContractDraftRevisedFact
>("advancement.command.revise-rubric", [
  ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
]);

export const ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-cancelled",
    AdvancementContractCancelledFact
  >("advancement-contract-cancelled");

export const ADVANCEMENT_CANCEL_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.cancel-rubric",
  AdvancementRubricCancellationCommand,
  AdvancementRubricCancellationResult,
  AdvancementContractCancelledFact
>("advancement.command.cancel-rubric", [
  ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
]);

export const ADVANCEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    ADVANCEMENT_DETAIL_QUERY,
    ADVANCEMENT_REVISE_RUBRIC_COMMAND,
    ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
  ],
  factEvents: [
    ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
  ],
});

export function createAdvancementProductApiContribution(
  application: AdvancementApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(ADVANCEMENT_DETAIL_QUERY, async (query) => ({
        result: await application.queryDetail(query),
        facts: [],
      })),
      bindProductApiOperation(
        ADVANCEMENT_REVISE_RUBRIC_COMMAND,
        async (command) => {
          const revised = await application.reviseRubricDraft(command);
          return { result: revised.result, facts: [revised.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
        async (command) => {
          const cancelled = await application.cancelRubric(command);
          return { result: cancelled.result, facts: [cancelled.fact] };
        },
      ),
    ],
    factEvents: [
      ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
    ],
  });
}

function assertConversationId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Advancement detail requires a conversation identity");
  }
}

function assertRubricRevisionIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} identity must be non-empty`);
  }
}

function normalizeUserFeedback(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Advancement rubric revision requires non-empty user feedback");
  }
  return value.trim();
}

function freezeSnapshot<T>(value: T): Readonly<T> {
  const snapshot = structuredClone(value);
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
