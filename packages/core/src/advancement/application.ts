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
import { canonicalize, protocolDigest } from "../protocol/canonical.js";
import type { AdvancementAdmissionDecision } from "./admission.js";
import { buildClosureFacts, type AdvancementClosureFacts } from "./closure.js";
import type {
  AdvancementExit,
  AdvancementOriginalTaskAdmissionIntent,
  AdvancementRunReview,
  AdvancementSession,
  AdvancementSessionStatus,
  ConfirmedRubricSnapshot,
  RubricContractDraftSnapshot,
  RubricDraftPersistenceChoice,
} from "./types.js";
import {
  isNonEmptyUserTurnInput,
  type UserTurnInput,
} from "../types/user-input.js";
import type { TurnOrigin } from "../types/tools.js";

/** Path-free read mechanism for the current Advancement owner projection. */
export interface AdvancementDetailReadPort {
  loadLatestSession(conversationId: string): Promise<AdvancementSession | null>;
}

/** Conversation-owned exclusivity mechanism; Advancement owns the enclosed decision. */
export interface AdvancementConversationMaintenancePort {
  runNew<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<
    | { readonly status: "done"; readonly value: T }
    | { readonly status: "busy" }
  >;
  runExisting<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<
    | { readonly status: "done"; readonly value: T }
    | { readonly status: "busy" }
    | { readonly status: "not-found" }
  >;
}

/** Path-free mechanisms used by the no-open-session new-task decision. */
export interface AdvancementNewTaskMechanismPort {
  loadOpenNewTaskSession(
    conversationId: string,
  ): Promise<AdvancementSession | null>;
  decideNewTaskAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAdmissionDecision>;
  buildNewTaskRubricDraft(input: Readonly<{
    originalTurnId: string;
    originalUserTask: Readonly<UserTurnInput>;
  }>): Promise<RubricContractDraftSnapshot>;
  persistNewTaskAwaitingSession(input: Readonly<{
    conversationId: string;
    originalUserTask: Readonly<UserTurnInput>;
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession>;
}

/** Conversation application boundary used only after a draft has been built. */
export interface AdvancementNewTaskConversationPort {
  ensureShell(conversationId: string): Promise<void>;
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

export type AdvancementAwaitingRubricAdmissionDecision = Omit<
  AdvancementAdmissionDecision,
  "action"
> & Readonly<{
  action:
    | "keep-awaiting-confirmation"
    | "downgrade-to-direct"
    | "cancel-pending-task";
}>;

/** Path-free natural-language admission mechanism for an already-awaiting Rubric. */
export interface AdvancementAwaitingRubricAdmissionMechanismPort {
  decideAwaitingRubricAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAwaitingRubricAdmissionDecision>;
}

/** Path-free mechanisms for confirming a Rubric and settling its durable handoff. */
export interface AdvancementRubricConfirmationMechanismPort {
  loadRubricConfirmationSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null>;
  confirmRubricDraftContent(
    draft: RubricContractDraftSnapshot,
  ): Promise<ConfirmedRubricSnapshot>;
  persistRubricConfirmation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    confirmedRubric: ConfirmedRubricSnapshot;
    admissionIntent: AdvancementOriginalTaskAdmissionIntent;
  }>): Promise<AdvancementSession>;
  persistOriginalTaskAdmissionSettlement(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    turnId: string;
    inputDigest: AdvancementOriginalTaskAdmissionIntent["inputDigest"];
    runId: string;
  }>): Promise<AdvancementSession>;
}

export type RubricPublicationOutcome =
  | Readonly<{ kind: "saved"; rubricId: string; revision: number }>
  | Readonly<{ kind: "deferred"; message: string }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "unavailable" }>;

/** Optional infrastructure effect. Advancement alone decides when publication applies. */
export interface RubricPublicationPort {
  publish(input: Readonly<{
    conversationId: string;
    draft: RubricContractDraftSnapshot;
    persistence: RubricDraftPersistenceChoice;
  }>): Promise<RubricPublicationOutcome>;
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

export type AdvancementOriginalTaskAdmissionFailureReason =
  | "conversation-not-found"
  | "idempotency-conflict"
  | "queue-full"
  | "lifecycle-busy"
  | "turn-identity-invalid";

/**
 * Typed cross-domain failure used only so Advancement can decide compensation.
 * The original Conversation error is rethrown after that decision, preserving
 * the existing transport mapping without importing it into the domain.
 */
export class AdvancementOriginalTaskAdmissionError extends Error {
  constructor(
    readonly reason: AdvancementOriginalTaskAdmissionFailureReason,
    readonly originalError: unknown,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : "Original-task admission failed",
    );
    this.name = "AdvancementOriginalTaskAdmissionError";
  }
}

/** Cross-domain admission application invoked after the confirmed Fact is visible. */
export interface AdvancementConfirmedOriginalTaskAdmissionPort {
  admit(input: Readonly<{
    conversationId: string;
    originalUserTask: Readonly<UserTurnInput>;
    admissionIntent: AdvancementOriginalTaskAdmissionIntent;
    surface: AdvancementOriginalTaskSurfacePort;
  }>): Promise<Readonly<{
    conversationId: string;
    turnId: string;
    runId?: string;
    status: "immediate" | "queued" | "replayed";
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

/** Surface projection effect for the confirmation transaction and compensation. */
export interface AdvancementRubricConfirmationFactPort {
  publish(
    fact: AdvancementContractConfirmedFact | AdvancementContractCancelledFact,
  ): void | Promise<void>;
}

export interface AdvancementApplicationOptions {
  readonly detail: AdvancementDetailReadPort;
  readonly maintenance: AdvancementConversationMaintenancePort;
  readonly newTask: AdvancementNewTaskMechanismPort;
  readonly newTaskConversation: AdvancementNewTaskConversationPort;
  readonly rubricRevision: AdvancementRubricRevisionMechanismPort;
  readonly rubricCancellation: AdvancementRubricCancellationMechanismPort;
  readonly awaitingRubricAdmission: AdvancementAwaitingRubricAdmissionMechanismPort;
  readonly rubricConfirmation: AdvancementRubricConfirmationMechanismPort;
  readonly rubricPublication?: RubricPublicationPort;
  readonly originalTask: AdvancementOriginalTaskExecutionPort;
  readonly confirmedOriginalTask: AdvancementConfirmedOriginalTaskAdmissionPort;
}

export interface AdvancementNewTaskCommand {
  readonly conversationId: string;
  readonly conversationScope: "existing" | "new";
  readonly turnId: string;
  readonly userInput: Readonly<UserTurnInput>;
}

export type AdvancementNewTaskResult =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{
      kind: "run-direct";
      admission: AdvancementAdmissionDecision;
    }>
  | Readonly<{ kind: "owner-busy" }>
  | Readonly<{
      kind: "contract-failed";
      conversationId: string;
      originalTurnId: string;
      error: Readonly<{ message: string }>;
    }>
  | Readonly<{
      kind: "awaiting-rubric-confirmation";
      conversationId: string;
      advancementSessionId: string;
      draft: RubricContractDraftSnapshot;
      admission: AdvancementAdmissionDecision;
    }>;

export interface AdvancementContractDraftCreatedFact extends ProductApiFact {
  readonly kind: "advancement-contract-draft-created";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraft: RubricContractDraftSnapshot;
  readonly admission: AdvancementAdmissionDecision;
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

export interface AdvancementAwaitingRubricControlCommand {
  readonly conversationId: string;
  readonly userInput: Readonly<UserTurnInput>;
  readonly fact: AdvancementRubricCancellationFactPort;
  readonly surface: AdvancementOriginalTaskSurfacePort;
}

export type AdvancementAwaitingRubricControlResult =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{
      kind: "keep-awaiting";
      conversationId: string;
      advancementSessionId: string;
      rubricDraft: RubricContractDraftSnapshot;
    }>
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

export interface AdvancementRubricConfirmationCommand {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly expectedRubricDraftId: string;
  readonly persistence?: RubricDraftPersistenceChoice;
  readonly originalTaskTurnOrigin: TurnOrigin;
  readonly fact: AdvancementRubricConfirmationFactPort;
  readonly surface: AdvancementOriginalTaskSurfacePort;
}

export interface AdvancementRubricConfirmationResult {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly runStatus: "immediate" | "queued";
  readonly rubricPublicationMessage?: string;
}

export interface AdvancementContractConfirmedFact extends ProductApiFact {
  readonly kind: "advancement-contract-confirmed";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly controlSeq: number;
  readonly rubricId?: string;
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
  readonly reason?: "original-task-admission-failed" | "user-cancelled";
}

export type AdvancementApplicationErrorCode =
  | "conversation-not-found"
  | "conversation-busy"
  | "advancement-session-not-found"
  | "advancement-session-identity-mismatch"
  | "not-awaiting-rubric-confirmation"
  | "pending-rubric-draft-missing"
  | "rubric-draft-stale"
  | "committed-rubric-draft-missing"
  | "committed-rubric-confirmation-missing"
  | "committed-original-task-admission-missing"
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
  prepareNewTask(
    command: AdvancementNewTaskCommand,
  ): Promise<Readonly<{
    result: AdvancementNewTaskResult;
    fact?: AdvancementContractDraftCreatedFact;
  }>>;
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
  controlAwaitingRubric(
    command: AdvancementAwaitingRubricControlCommand,
  ): Promise<Readonly<{
    result: AdvancementAwaitingRubricControlResult;
    fact?: AdvancementContractCancelledFact;
  }>>;
  confirmRubric(
    command: AdvancementRubricConfirmationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricConfirmationResult;
    fact: AdvancementContractConfirmedFact;
  }>>;
}

/** Advancement-owned application decisions exposed through one finite Product API contribution. */
export class AdvancementApplicationService implements AdvancementApplication {
  readonly #detail: AdvancementDetailReadPort;
  readonly #maintenance: AdvancementConversationMaintenancePort;
  readonly #newTask: AdvancementNewTaskMechanismPort;
  readonly #newTaskConversation: AdvancementNewTaskConversationPort;
  readonly #rubricRevision: AdvancementRubricRevisionMechanismPort;
  readonly #rubricCancellation: AdvancementRubricCancellationMechanismPort;
  readonly #awaitingRubricAdmission: AdvancementAwaitingRubricAdmissionMechanismPort;
  readonly #rubricConfirmation: AdvancementRubricConfirmationMechanismPort;
  readonly #rubricPublication?: RubricPublicationPort;
  readonly #originalTask: AdvancementOriginalTaskExecutionPort;
  readonly #confirmedOriginalTask: AdvancementConfirmedOriginalTaskAdmissionPort;

  constructor(options: AdvancementApplicationOptions) {
    this.#detail = options.detail;
    this.#maintenance = options.maintenance;
    this.#newTask = options.newTask;
    this.#newTaskConversation = options.newTaskConversation;
    this.#rubricRevision = options.rubricRevision;
    this.#rubricCancellation = options.rubricCancellation;
    this.#awaitingRubricAdmission = options.awaitingRubricAdmission;
    this.#rubricConfirmation = options.rubricConfirmation;
    this.#rubricPublication = options.rubricPublication;
    this.#originalTask = options.originalTask;
    this.#confirmedOriginalTask = options.confirmedOriginalTask;
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

  async prepareNewTask(
    command: AdvancementNewTaskCommand,
  ): Promise<Readonly<{
    result: AdvancementNewTaskResult;
    fact?: AdvancementContractDraftCreatedFact;
  }>> {
    assertConversationId(command.conversationId);
    assertRubricRevisionIdentity(command.turnId, "Turn");
    if (
      command.conversationScope !== "existing" &&
      command.conversationScope !== "new"
    ) {
      throw new TypeError("Advancement new task requires a conversation scope");
    }
    if (!isNonEmptyUserTurnInput(command.userInput)) {
      throw new TypeError("Advancement new task requires non-empty user input");
    }

    const decide = async () => {
      const open = await this.#newTask.loadOpenNewTaskSession(
        command.conversationId,
      );
      if (open) {
        return Object.freeze({
          result: Object.freeze<AdvancementNewTaskResult>({
            kind: "not-applicable",
          }),
        });
      }

      const admission = await this.#newTask.decideNewTaskAdmission({
        conversationId: command.conversationId,
        userInput: command.userInput,
      });
      if (admission.action !== "start-advancement") {
        if (admission.action !== "run-direct") {
          throw new TypeError(
            `Advancement new-task admission returned invalid action: ${admission.action}`,
          );
        }
        return Object.freeze({
          result: Object.freeze<AdvancementNewTaskResult>({
            kind: "run-direct",
            admission: freezeSnapshot(admission),
          }),
        });
      }

      let draft: RubricContractDraftSnapshot;
      try {
        draft = await this.#newTask.buildNewTaskRubricDraft({
          originalTurnId: command.turnId,
          originalUserTask: command.userInput,
        });
      } catch (error) {
        return Object.freeze({
          result: Object.freeze<AdvancementNewTaskResult>({
            kind: "contract-failed",
            conversationId: command.conversationId,
            originalTurnId: command.turnId,
            error: Object.freeze({ message: applicationErrorMessage(error) }),
          }),
        });
      }

      if (command.conversationScope === "new") {
        await this.#newTaskConversation.ensureShell(command.conversationId);
      }
      const committed = await this.#newTask.persistNewTaskAwaitingSession({
        conversationId: command.conversationId,
        originalUserTask: command.userInput,
        draft,
      });
      assertCommittedNewTaskSession(committed, command, draft);
      const admissionSnapshot = freezeSnapshot(admission);
      const draftSnapshot = freezeSnapshot(draft);
      const result = Object.freeze<AdvancementNewTaskResult>({
        kind: "awaiting-rubric-confirmation",
        conversationId: committed.conversationId,
        advancementSessionId: committed.id,
        draft: draftSnapshot,
        admission: admissionSnapshot,
      });
      const fact = Object.freeze<AdvancementContractDraftCreatedFact>({
        kind: "advancement-contract-draft-created",
        conversationId: committed.conversationId,
        originalTurnId: command.turnId,
        advancementSessionId: committed.id,
        rubricDraftId: draftSnapshot.draftId,
        rubricDraft: draftSnapshot,
        admission: admissionSnapshot,
      });
      return Object.freeze({ result, fact });
    };

    const maintained =
      command.conversationScope === "existing"
        ? await this.#maintenance.runExisting(command.conversationId, decide)
        : await this.#maintenance.runNew(command.conversationId, decide);
    if (maintained.status === "busy") {
      return Object.freeze({
        result: Object.freeze<AdvancementNewTaskResult>({ kind: "owner-busy" }),
      });
    }
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    return maintained.value;
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

  async confirmRubric(
    command: AdvancementRubricConfirmationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricConfirmationResult;
    fact: AdvancementContractConfirmedFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    assertRubricRevisionIdentity(
      command.advancementSessionId,
      "Advancement session",
    );
    assertRubricRevisionIdentity(command.expectedRubricDraftId, "Rubric draft");
    assertOriginalTaskSurface(command.surface);
    if (typeof command.fact?.publish !== "function") {
      throw new TypeError("Advancement rubric confirmation requires a Fact projection port");
    }
    if (
      command.originalTaskTurnOrigin.triggeredBy !==
      command.surface.caller.surfacePrincipal
    ) {
      throw new TypeError(
        "Advancement rubric confirmation origin must bind its surface principal",
      );
    }

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session =
          await this.#rubricConfirmation.loadRubricConfirmationSession(
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
        assertAdvancementSessionIdentity(session, command);
        if (session.status !== "awaiting-rubric-confirmation") {
          throw new AdvancementApplicationError(
            "not-awaiting-rubric-confirmation",
            `Advancement session is not awaiting rubric confirmation: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const draft = session.pendingRubricDraft;
        if (!draft) {
          throw new AdvancementApplicationError(
            "pending-rubric-draft-missing",
            `Advancement session has no pending rubric draft: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        if (draft.draftId !== command.expectedRubricDraftId) {
          throw new AdvancementApplicationError(
            "rubric-draft-stale",
            "推进准则草案已被修订，请查看最新内容后再确认。",
            { advancementSessionId: session.id },
          );
        }

        const confirmedRubric =
          await this.#rubricConfirmation.confirmRubricDraftContent(draft);
        const admissionIntent = Object.freeze<AdvancementOriginalTaskAdmissionIntent>({
          turnId: draft.originalTurnId,
          surfacePrincipal: command.surface.caller.surfacePrincipal,
          turnOrigin: freezeSnapshot(command.originalTaskTurnOrigin),
          inputDigest: protocolDigest(
            "AdvancementOriginalTaskInput",
            1,
            session.originalUserTask,
          ),
        });
        const committed =
          await this.#rubricConfirmation.persistRubricConfirmation({
            conversationId: command.conversationId,
            advancementSessionId: command.advancementSessionId,
            confirmedRubric,
            admissionIntent,
          });
        assertCommittedRubricConfirmation(committed, command, admissionIntent);
        const committedRubric = committed.confirmedRubric!;
        const fact = Object.freeze<AdvancementContractConfirmedFact>({
          kind: "advancement-contract-confirmed",
          conversationId: committed.conversationId,
          originalTurnId: committed.originalTaskAdmission!.intent.turnId,
          advancementSessionId: committed.id,
          controlSeq: committed.rubricDraftVersion + 1,
          ...(committedRubric.source.kind === "library"
            ? { rubricId: committedRubric.source.rubricId }
            : {}),
        });
        return Object.freeze({
          committed,
          draft: freezeSnapshot(draft),
          fact,
          originalUserTask: freezeSnapshot(committed.originalUserTask),
        });
      },
    );

    if (maintained.status === "not-found") {
      await this.#cancelPreConfirmationNotFound(command);
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

    const publication =
      decision.draft.source === "generated" && command.persistence
        ? this.#publishRubric(decision.committed.conversationId, decision.draft, command.persistence)
        : undefined;

    let admitted: Awaited<
      ReturnType<AdvancementConfirmedOriginalTaskAdmissionPort["admit"]>
    >;
    try {
      admitted = await this.#confirmedOriginalTask.admit({
        conversationId: decision.committed.conversationId,
        originalUserTask: decision.originalUserTask,
        admissionIntent: decision.committed.originalTaskAdmission!.intent,
        surface: command.surface,
      });
    } catch (error) {
      if (error instanceof AdvancementOriginalTaskAdmissionError) {
        if (
          error.reason === "conversation-not-found" ||
          error.reason === "idempotency-conflict"
        ) {
          await this.#cancelFailedOriginalTaskAdmission(
            command,
            decision.committed,
            error.reason,
          );
        }
        throw error.originalError;
      }
      throw error;
    }
    if (
      admitted.conversationId !== decision.committed.conversationId ||
      admitted.turnId !== decision.committed.originalTaskAdmission!.intent.turnId
    ) {
      throw new TypeError(
        "Advancement original-task admission returned a mismatched identity",
      );
    }

    let settled = decision.committed;
    let settlementCommitted = false;
    if (admitted.runId) {
      try {
        settled =
          await this.#rubricConfirmation.persistOriginalTaskAdmissionSettlement({
            conversationId: decision.committed.conversationId,
            advancementSessionId: decision.committed.id,
            turnId: decision.committed.originalTaskAdmission!.intent.turnId,
            inputDigest:
              decision.committed.originalTaskAdmission!.intent.inputDigest,
            runId: admitted.runId,
          });
        settlementCommitted = true;
      } catch {
        // Admission is already durable. Recovery owns retrying the pending intent.
      }
    }
    const settledAdmission =
      admitted.runId && settlementCommitted
        ? assertCommittedOriginalTaskAdmission(
            settled,
            command,
            decision.committed.originalTaskAdmission!.intent,
            admitted.runId,
          )
        : decision.committed.originalTaskAdmission!;

    const rubricPublicationMessage = publication
      ? publicationMessage(await publication)
      : undefined;
    return Object.freeze({
      result: Object.freeze<AdvancementRubricConfirmationResult>({
        conversationId: settled.conversationId,
        advancementSessionId: settled.id,
        turnId: settledAdmission.intent.turnId,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        runStatus: admitted.status === "replayed" ? "queued" : admitted.status,
        ...(rubricPublicationMessage ? { rubricPublicationMessage } : {}),
      }),
      fact: decision.fact,
    });
  }

  async #cancelPreConfirmationNotFound(
    command: AdvancementRubricConfirmationCommand,
  ): Promise<void> {
    try {
      const source =
        await this.#rubricCancellation.loadRubricCancellationSession(
          command.conversationId,
          command.advancementSessionId,
        );
      if (!source) return;
      assertAdvancementSessionIdentity(source, command);
      await this.#rubricCancellation.persistRubricCancellation({
        conversationId: command.conversationId,
        advancementSessionId: command.advancementSessionId,
        reason: "system-error",
        message: "原始对话已不存在，推进会话已取消以避免悬空状态。",
      });
    } catch {
      // Preserve the maintenance NOT_FOUND; recovery can retry cancellation.
    }
  }

  async #cancelFailedOriginalTaskAdmission(
    command: AdvancementRubricConfirmationCommand,
    confirmed: AdvancementSession | undefined,
    reason: "conversation-not-found" | "idempotency-conflict" =
      "conversation-not-found",
  ): Promise<void> {
    try {
      const source =
        confirmed ??
        (await this.#rubricCancellation.loadRubricCancellationSession(
          command.conversationId,
          command.advancementSessionId,
        ));
      if (!source) return;
      assertAdvancementSessionIdentity(source, command);
      const cancelled =
        await this.#rubricCancellation.persistRubricCancellation({
          conversationId: command.conversationId,
          advancementSessionId: command.advancementSessionId,
          reason: "system-error",
          message:
            reason === "idempotency-conflict"
              ? "原始任务的耐久准入身份发生冲突，推进会话已安全取消。"
              : "原始对话已不存在，推进会话已取消以避免悬空状态。",
        });
      if (cancelled.status !== "cancelled") return;
      const originalTurnId =
        source.originalTaskAdmission?.intent.turnId ??
        source.pendingRubricDraft?.originalTurnId ??
        source.id;
      await command.fact.publish(
        Object.freeze<AdvancementContractCancelledFact>({
          kind: "advancement-contract-cancelled",
          conversationId: cancelled.conversationId,
          originalTurnId,
          advancementSessionId: cancelled.id,
          controlSeq:
            source.rubricDraftVersion +
            (source.originalTaskAdmission ? 2 : 1),
          executeOriginal: false,
          reason: "original-task-admission-failed",
        }),
      );
    } catch {
      // Preserve the original Conversation error; recovery can retry cancellation.
    }
  }

  #publishRubric(
    conversationId: string,
    draft: RubricContractDraftSnapshot,
    persistence: RubricDraftPersistenceChoice,
  ): Promise<RubricPublicationOutcome> {
    if (!this.#rubricPublication) {
      return Promise.resolve({
        kind: "deferred",
        message: "准则已用于本任务，连接值班设备后可保存到准则库。",
      });
    }
    return this.#rubricPublication
      .publish({ conversationId, draft, persistence })
      .catch(() => ({
        kind: "failed",
        message: "任务已继续执行，但准则暂未保存；稍后可重新保存。",
      }));
  }

  async controlAwaitingRubric(
    command: AdvancementAwaitingRubricControlCommand,
  ): Promise<Readonly<{
    result: AdvancementAwaitingRubricControlResult;
    fact?: AdvancementContractCancelledFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    if (!isNonEmptyUserTurnInput(command.userInput)) {
      throw new TypeError(
        "Advancement awaiting-Rubric control requires non-empty user input",
      );
    }
    if (typeof command.fact?.publish !== "function") {
      throw new TypeError(
        "Advancement awaiting-Rubric control requires a Fact projection port",
      );
    }
    assertOriginalTaskSurface(command.surface);

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session = await this.#detail.loadLatestSession(
          command.conversationId,
        );
        if (!session || session.status !== "awaiting-rubric-confirmation") {
          return Object.freeze({ kind: "not-applicable" as const });
        }
        if (session.conversationId !== command.conversationId) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Advancement awaiting-Rubric read returned a mismatched conversation identity",
            { advancementSessionId: session.id },
          );
        }
        const draft = session.pendingRubricDraft;
        if (!draft) {
          throw new AdvancementApplicationError(
            "pending-rubric-draft-missing",
            `Advancement session has no pending rubric draft: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const admission =
          await this.#awaitingRubricAdmission.decideAwaitingRubricAdmission({
            conversationId: command.conversationId,
            userInput: freezeSnapshot(command.userInput),
          });
        if (admission.action === "keep-awaiting-confirmation") {
          return Object.freeze({
            kind: "keep-awaiting" as const,
            session,
            draft: freezeSnapshot(draft),
          });
        }
        if (
          admission.action !== "downgrade-to-direct" &&
          admission.action !== "cancel-pending-task"
        ) {
          throw new TypeError(
            "Advancement awaiting-Rubric admission returned an unsupported action",
          );
        }

        const executeOriginal = admission.action === "downgrade-to-direct";
        const committed =
          await this.#rubricCancellation.persistRubricCancellation({
            conversationId: command.conversationId,
            advancementSessionId: session.id,
            reason: "user-cancelled",
            message: executeOriginal
              ? "用户选择直接执行原始任务"
              : "用户取消待确认任务",
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
          committed.id !== session.id
        ) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Committed Advancement cancellation has a mismatched session identity",
            { advancementSessionId: session.id },
          );
        }
        const fact = Object.freeze<AdvancementContractCancelledFact>({
          kind: "advancement-contract-cancelled",
          conversationId: committed.conversationId,
          originalTurnId: draft.originalTurnId,
          advancementSessionId: committed.id,
          controlSeq: committed.rubricDraftVersion + 1,
          executeOriginal,
          ...(!executeOriginal ? { reason: "user-cancelled" as const } : {}),
        });
        return Object.freeze({
          kind: executeOriginal
            ? ("direct-original-task" as const)
            : ("cancelled" as const),
          committed,
          fact,
          draft: freezeSnapshot(draft),
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
    if (decision.kind === "not-applicable") {
      return Object.freeze({ result: decision });
    }
    if (decision.kind === "keep-awaiting") {
      return Object.freeze({
        result: Object.freeze<AdvancementAwaitingRubricControlResult>({
          kind: "keep-awaiting",
          conversationId: decision.session.conversationId,
          advancementSessionId: decision.session.id,
          rubricDraft: decision.draft,
        }),
      });
    }

    await command.fact.publish(decision.fact);
    if (decision.kind === "cancelled") {
      return Object.freeze({
        result: Object.freeze<AdvancementAwaitingRubricControlResult>({
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
      result: Object.freeze<AdvancementAwaitingRubricControlResult>({
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

export const ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-draft-created",
    AdvancementContractDraftCreatedFact
  >("advancement-contract-draft-created");

export const ADVANCEMENT_PREPARE_NEW_TASK_COMMAND = defineProductApiCommand<
  "advancement.command.prepare-new-task",
  AdvancementNewTaskCommand,
  AdvancementNewTaskResult,
  AdvancementContractDraftCreatedFact
>("advancement.command.prepare-new-task", [
  ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
], { factEmission: "subset" });

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

export const ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-confirmed",
    AdvancementContractConfirmedFact
  >("advancement-contract-confirmed");

export const ADVANCEMENT_CONFIRM_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.confirm-rubric",
  AdvancementRubricConfirmationCommand,
  AdvancementRubricConfirmationResult,
  AdvancementContractConfirmedFact
>("advancement.command.confirm-rubric", [
  ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
]);

export const ADVANCEMENT_CANCEL_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.cancel-rubric",
  AdvancementRubricCancellationCommand,
  AdvancementRubricCancellationResult,
  AdvancementContractCancelledFact
>("advancement.command.cancel-rubric", [
  ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
]);

export const ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND =
  defineProductApiCommand<
    "advancement.command.control-awaiting-rubric",
    AdvancementAwaitingRubricControlCommand,
    AdvancementAwaitingRubricControlResult,
    AdvancementContractCancelledFact
  >("advancement.command.control-awaiting-rubric", [
    ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
  ], { factEmission: "subset" });

export const ADVANCEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    ADVANCEMENT_DETAIL_QUERY,
    ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,
    ADVANCEMENT_REVISE_RUBRIC_COMMAND,
    ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
    ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
    ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
  ],
  factEvents: [
    ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
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
        ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,
        async (command) => {
          const prepared = await application.prepareNewTask(command);
          return {
            result: prepared.result,
            facts: prepared.fact ? [prepared.fact] : [],
          };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_REVISE_RUBRIC_COMMAND,
        async (command) => {
          const revised = await application.reviseRubricDraft(command);
          return { result: revised.result, facts: [revised.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
        async (command) => {
          const confirmed = await application.confirmRubric(command);
          return { result: confirmed.result, facts: [confirmed.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
        async (command) => {
          const cancelled = await application.cancelRubric(command);
          return { result: cancelled.result, facts: [cancelled.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
        async (command) => {
          const controlled = await application.controlAwaitingRubric(command);
          return {
            result: controlled.result,
            facts: controlled.fact ? [controlled.fact] : [],
          };
        },
      ),
    ],
    factEvents: [
      ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
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

function assertOriginalTaskSurface(
  surface: AdvancementOriginalTaskSurfacePort,
): void {
  if (
    typeof surface?.caller?.surfacePrincipal !== "string" ||
    surface.caller.surfacePrincipal.length === 0 ||
    typeof surface.caller.connectionId !== "string" ||
    surface.caller.connectionId.length === 0 ||
    typeof surface.execute !== "function" ||
    typeof surface.cancelPending !== "function"
  ) {
    throw new TypeError("Advancement rubric confirmation requires a surface effect port");
  }
}

function assertAdvancementSessionIdentity(
  session: AdvancementSession,
  command: Pick<
    AdvancementRubricConfirmationCommand,
    "conversationId" | "advancementSessionId"
  >,
): void {
  if (
    session.conversationId !== command.conversationId ||
    session.id !== command.advancementSessionId
  ) {
    throw new AdvancementApplicationError(
      "advancement-session-identity-mismatch",
      "Advancement confirmation mechanism returned a mismatched session identity",
      { advancementSessionId: command.advancementSessionId },
    );
  }
}

function assertCommittedNewTaskSession(
  session: AdvancementSession,
  command: AdvancementNewTaskCommand,
  draft: RubricContractDraftSnapshot,
): void {
  if (
    session.status !== "awaiting-rubric-confirmation" ||
    session.conversationId !== command.conversationId ||
    session.id !== `adv_${draft.draftId}` ||
    !session.pendingRubricDraft ||
    canonicalize(session.pendingRubricDraft) !== canonicalize(draft) ||
    canonicalize(session.originalUserTask) !== canonicalize(command.userInput)
  ) {
    throw new AdvancementApplicationError(
      "committed-rubric-draft-missing",
      `Committed Advancement session has no matching new-task draft: ${session.id}`,
      { advancementSessionId: session.id },
    );
  }
}

function assertCommittedRubricConfirmation(
  session: AdvancementSession,
  command: AdvancementRubricConfirmationCommand,
  intent: AdvancementOriginalTaskAdmissionIntent,
): void {
  assertAdvancementSessionIdentity(session, command);
  const committed = session.originalTaskAdmission;
  if (
    session.status !== "active" ||
    !session.confirmedRubric ||
    !committed ||
    committed.status !== "pending" ||
    committed.intent.turnId !== intent.turnId ||
    committed.intent.inputDigest !== intent.inputDigest ||
    committed.intent.surfacePrincipal !== intent.surfacePrincipal
  ) {
    throw new AdvancementApplicationError(
      "committed-rubric-confirmation-missing",
      `Committed Advancement session has no matching Rubric confirmation: ${session.id}`,
      { advancementSessionId: session.id },
    );
  }
}

function assertCommittedOriginalTaskAdmission(
  session: AdvancementSession,
  command: AdvancementRubricConfirmationCommand,
  intent: AdvancementOriginalTaskAdmissionIntent,
  runId: string,
): Extract<
  NonNullable<AdvancementSession["originalTaskAdmission"]>,
  { readonly status: "admitted" }
> {
  assertAdvancementSessionIdentity(session, command);
  const admitted = session.originalTaskAdmission;
  if (
    session.status !== "active" ||
    !admitted ||
    admitted.status !== "admitted" ||
    admitted.runId !== runId ||
    admitted.intent.turnId !== intent.turnId ||
    admitted.intent.inputDigest !== intent.inputDigest
  ) {
    throw new AdvancementApplicationError(
      "committed-original-task-admission-missing",
      `Committed Advancement session has no matching original-task admission: ${session.id}`,
      { advancementSessionId: session.id },
    );
  }
  return admitted;
}

function publicationMessage(outcome: RubricPublicationOutcome): string {
  return outcome.kind === "saved"
    ? "准则已保存到准则库。"
    : outcome.kind === "unavailable"
      ? "准则已用于本任务，连接值班设备后可保存到准则库。"
    : outcome.message;
}

function applicationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
