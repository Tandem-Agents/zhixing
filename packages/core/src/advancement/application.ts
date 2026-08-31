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

export interface AdvancementApplicationOptions {
  readonly detail: AdvancementDetailReadPort;
  readonly maintenance: AdvancementConversationMaintenancePort;
  readonly rubricRevision: AdvancementRubricRevisionMechanismPort;
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

export type AdvancementApplicationErrorCode =
  | "conversation-not-found"
  | "conversation-busy"
  | "advancement-session-not-found"
  | "not-awaiting-rubric-confirmation"
  | "pending-rubric-draft-missing"
  | "committed-rubric-draft-missing";

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
}

/** Advancement-owned application decisions exposed through one finite Product API contribution. */
export class AdvancementApplicationService implements AdvancementApplication {
  readonly #detail: AdvancementDetailReadPort;
  readonly #maintenance: AdvancementConversationMaintenancePort;
  readonly #rubricRevision: AdvancementRubricRevisionMechanismPort;

  constructor(options: AdvancementApplicationOptions) {
    this.#detail = options.detail;
    this.#maintenance = options.maintenance;
    this.#rubricRevision = options.rubricRevision;
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

export const ADVANCEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [ADVANCEMENT_DETAIL_QUERY, ADVANCEMENT_REVISE_RUBRIC_COMMAND],
  factEvents: [ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT],
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
    ],
    factEvents: [ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT],
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
