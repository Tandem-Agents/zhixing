import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { isProtocolIdentifier } from "../protocol/index.js";
import type { RunRecordWithRef } from "../transcript/shard/reader.js";
import {
  isNonEmptyUserTurnInput,
  type UserTurnInput,
} from "../types/user-input.js";
import type { TurnOrigin } from "../types/tools.js";
import type { ExplicitEnvironmentSelection } from "../contracts/protocol.js";
import type { ContextBudget } from "../context/types.js";
import type { TaskItem, TaskListState } from "./types.js";

/** Persisted Conversation identity projected by the domain storage port. */
export interface ConversationDirectoryRecord {
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
}

export interface ConversationHistoryCursor {
  readonly shardId: string;
  readonly runIndex: number;
}

export interface ConversationHistoryPage {
  readonly runs: readonly RunRecordWithRef[];
  readonly hasMore: boolean;
}

export interface ConversationRuntimeProjection {
  readonly lastActiveAt?: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly observerCount: number;
  readonly pendingCount: number;
}

export interface ConversationAdvancementRubricDraftProjection {
  readonly draftId: string;
  readonly originalTurnId: string;
  readonly source: "matched" | "generated";
  readonly candidateRubricIds: readonly string[];
  readonly candidateRubrics?: readonly Readonly<{
    id: string;
    title: string;
    description: string;
    source: "own" | "linked";
    matchScore?: number;
  }>[];
  readonly title: string;
  readonly description: string;
  readonly content: Readonly<{
    passCriteria: readonly string[];
    evidenceRequirements?: readonly Readonly<{
      id: string;
      kind:
        | "file-diff"
        | "test-result"
        | "build-result"
        | "log"
        | "artifact"
        | "conversation-fact"
        | "none";
      description: string;
      required?: boolean;
      locator?: Readonly<{ paths?: readonly string[] }>;
    }>[];
    failureHandling: readonly Readonly<{
      id: string;
      scenario: string;
      reply: string;
    }>[];
  }>;
  readonly createdAt: string;
}

export interface ConversationAdvancementProjection {
  readonly advancementSessionId: string;
  readonly status: "awaiting-rubric-confirmation" | "active";
  readonly rubricTitle?: string;
  readonly rubricDraftId?: string;
  readonly pendingRubricDraft?: ConversationAdvancementRubricDraftProjection;
  readonly outstandingProxyMessageId?: string;
  readonly lastReview?: Readonly<{
    id: string;
    runIndex: number;
    round: number;
    decision: "passed" | "failed" | "exit";
    reviewedAt: string;
  }>;
}

export interface ConversationDirectoryEntry extends ConversationDirectoryRecord {
  readonly active: boolean;
  readonly busy: boolean;
  readonly observerCount: number;
  readonly pendingCount: number;
  readonly advancement?: ConversationAdvancementProjection;
}

export type ConversationAvailability =
  | Readonly<{ mode: "anchor" }>
  | Readonly<{
      mode: "local-only";
      unavailableCapabilities: readonly string[];
    }>;

export interface ConversationDirectoryView {
  readonly conversations: readonly ConversationDirectoryEntry[];
  readonly availability?: ConversationAvailability;
}

/** Conversation-owned demand-side storage contract. */
export interface ConversationDirectoryStorage {
  list(): Promise<readonly ConversationDirectoryRecord[]>;
  create(): Promise<ConversationDirectoryRecord>;
  rename(
    conversationId: string,
    name: string,
  ): Promise<ConversationDirectoryRecord | null>;
  readHistory(
    conversationId: string,
    input: Readonly<{
      limit: number;
      before?: ConversationHistoryCursor;
    }>,
  ): Promise<ConversationHistoryPage>;
}

/** Conversation-owned clear projection; storage/Owner mechanics stay behind it. */
export interface ConversationClearProjectionPort {
  clearStoredView(conversationId: string): Promise<boolean>;
  clearRuntimeView(
    conversationId: string,
    persist: () => Promise<boolean>,
  ): Promise<"cleared" | "cleared-inactive" | "busy" | "not-found">;
}

/** Correctness boundary used by the clear application command. */
export interface ConversationClearCommitPort {
  readonly requiresStableOperationIdentity: boolean;
  createOperationIdentity(): string;
  commit(input: Readonly<{
    conversationId: string;
    operationId: string;
    caller: ConversationCommandCaller;
  }>): Promise<
    | Readonly<{ status: "cleared" }>
    | Readonly<{
        status: "busy";
        reason: "active-turn" | "pending-lifecycle";
      }>
    | Readonly<{ status: "not-found" }>
  >;
}

export type ConversationCommandCaller =
  | Readonly<{
      kind: "surface";
      surfacePrincipal: string;
      connectionId: string;
    }>
  | Readonly<{ kind: "host"; component: string }>;

export type ConversationAgentTurnIdentity =
  | Readonly<{
      kind: "existing";
      conversationId: string;
      exists: () => Promise<boolean>;
    }>
  | Readonly<{
      kind: "create";
      create: () => Promise<string>;
    }>;

const preparedAgentTurnIdentity = Symbol("prepared-agent-turn-identity");

export interface ConversationPreparedAgentTurnIdentity {
  readonly turnId: string;
  readonly [preparedAgentTurnIdentity]: true;
}

export interface ConversationAgentTurnExecutionPort {
  execute(input: Readonly<{
    conversationId: string;
    turnId: string;
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

export interface ConversationAgentTurnAdmissionPort {
  readonly requiresStableTurnIdentity: boolean;
  createTurnIdentity(): string;
  admit(input: Readonly<{
    identity: ConversationAgentTurnIdentity;
    input: UserTurnInput;
    turnId: string;
    caller: Extract<ConversationCommandCaller, { readonly kind: "surface" }>;
    turnOrigin?: TurnOrigin;
    environment?: ExplicitEnvironmentSelection;
    execution: ConversationAgentTurnExecutionPort;
  }>): Promise<
    | Readonly<{
        status: "immediate";
        conversationId: string;
        runId?: string;
        start: () => Promise<void>;
      }>
    | Readonly<{
        status: "queued" | "replayed";
        conversationId: string;
        runId?: string;
      }>
    | Readonly<{ status: "full"; conversationId: string }>
    | Readonly<{ status: "not-found"; conversationId: string }>
    | Readonly<{ status: "lifecycle-busy"; conversationId: string }>
  >;
}

export interface ConversationAgentTurnIdentityPort {
  exists(conversationId: string): Promise<boolean>;
  create(): Promise<string>;
  ensure(conversationId: string): Promise<void>;
}

export type ConversationTaskListAction =
  | Readonly<{ kind: "add"; content: string }>
  | Readonly<{ kind: "done"; token: string }>;

export type ConversationTaskListMutationDecision =
  | Readonly<{
      outcome: "added";
      taskContent: string;
      next: TaskListState;
    }>
  | Readonly<{
      outcome: "completed";
      taskContent: string;
      next: TaskListState;
    }>
  | Readonly<{
      outcome: "invalid-add";
      token: string;
    }>
  | Readonly<{
      outcome: "invalid-done";
      token: string;
    }>
  | Readonly<{
      outcome: "not-found";
      token: string;
    }>
  | Readonly<{
      outcome: "already-completed";
      taskContent: string;
    }>;

/**
 * Owner/Correctness mechanism consumed by Conversation task-list use cases.
 * The callback is evaluated while the implementation holds its existing
 * per-conversation maintenance boundary; only the returned state is written.
 */
export interface ConversationTaskListPort {
  readonly requiresStableOperationIdentity: boolean;
  createOperationIdentity(): string;
  createTaskIdentity(input: Readonly<{
    conversationId: string;
    operationId: string;
    content: string;
  }>): string;
  read(conversationId: string): Promise<TaskListState | null>;
  maintain(input: Readonly<{
    conversationId: string;
    operationId: string;
    decide(current: TaskListState): ConversationTaskListMutationDecision;
  }>): Promise<
    | Readonly<{ status: "busy" }>
    | Readonly<{ status: "not-found" }>
    | Readonly<{
        status: "done";
        decision: ConversationTaskListMutationDecision;
        taskList: TaskListState;
      }>
  >;
}

export interface ConversationCompactMechanismOutcome {
  readonly runtimeModified: boolean;
  readonly windowApplied: boolean;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly emergencyFloor?: Readonly<{
    droppedTurns: number;
    error: string;
  }>;
}

/** Owner/runtime mechanisms consumed by the Conversation compact use case. */
export interface ConversationCompactPort {
  compactExisting(conversationId: string): Promise<
    | Readonly<{
        status: "done";
        outcome: ConversationCompactMechanismOutcome;
      }>
    | Readonly<{
        status: "busy" | "not-found" | "unsupported" | "unavailable";
      }>
  >;
}

export interface ConversationSubAgentUsage {
  readonly index: number;
  readonly description: string;
  readonly tokens: number;
  readonly toolUses: number;
  readonly durationMs?: number;
  readonly subId?: string;
  readonly status: "succeeded" | "failed" | "aborted";
}

export interface ConversationContextBudgetMechanismOutcome {
  readonly budget: ContextBudget;
  readonly turnCount: number;
  readonly calibrationFactor: number;
}

export interface ConversationUsageMechanismOutcome
  extends ConversationContextBudgetMechanismOutcome {
  readonly subUsages: readonly ConversationSubAgentUsage[];
}

/** Owner/runtime mechanisms consumed by the two Conversation usage queries. */
export interface ConversationUsageProjectionPort {
  inspectContextBudgetExisting(conversationId: string): Promise<
    | Readonly<{
        status: "done";
        outcome: ConversationContextBudgetMechanismOutcome;
      }>
    | Readonly<{ status: "not-found" | "unsupported" | "unavailable" }>
  >;
  inspectUsageExisting(conversationId: string): Promise<
    | Readonly<{
        status: "done";
        outcome: ConversationUsageMechanismOutcome;
      }>
    | Readonly<{ status: "not-found" | "unsupported" | "unavailable" }>
  >;
}

export type ConversationSecurityContextId =
  | Readonly<{ kind: "main" }>
  | Readonly<{ kind: "workspace"; hash: string }>
  | Readonly<{ kind: "scene"; sceneId: string }>;

export type ConversationSecurityMatchSpec =
  | Readonly<{ type: "command"; pattern: string; flags?: string }>
  | Readonly<{ type: "command_prefix"; prefixes: readonly string[] }>
  | Readonly<{
      type: "path";
      paths: readonly string[];
      access: "read" | "write" | "any";
    }>
  | Readonly<{
      type: "network";
      hosts?: readonly string[];
      ports?: readonly number[];
      direction?: "inbound" | "outbound";
    }>
  | Readonly<{ type: "env_var"; names: readonly string[] }>
  | Readonly<{ type: "tool"; tools: readonly string[] }>
  | Readonly<{ type: "interpreter"; languages: readonly string[] }>
  | Readonly<{
      type: "composite";
      op: "and" | "or" | "not";
      specs: readonly ConversationSecurityMatchSpec[];
    }>;

export interface ConversationSecurityPermissionRule {
  readonly id: string;
  readonly pattern: Readonly<{ tool: string; argument: string }>;
  readonly decision: "allow" | "deny";
  readonly scope: "session" | "context" | "global" | "builtin";
  readonly createdAt: number;
  readonly lastMatchedAt: number;
  readonly matchCount: number;
  readonly contextId?: ConversationSecurityContextId;
  readonly contextPath?: string;
  readonly contributors?: readonly Readonly<{
    origin: "user" | "steward";
    timestamp: number;
  }>[];
}

export interface ConversationSecurityBuiltinRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly match: ConversationSecurityMatchSpec;
  readonly action: "block" | "confirm" | "audit";
  readonly bypassImmune: boolean;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly category:
    | "data_exfiltration"
    | "privilege_escalation"
    | "code_injection"
    | "path_traversal"
    | "env_manipulation"
    | "network_abuse"
    | "destructive_operation"
    | "prompt_injection"
    | "supply_chain";
  readonly source: "builtin" | "project" | "user" | "community";
  readonly message: string;
  readonly suggestion?: string;
}

export interface ConversationSecurityResult {
  readonly contextId: ConversationSecurityContextId;
  readonly workspacePath: string | null;
  readonly permissionRules: readonly ConversationSecurityPermissionRule[];
  readonly builtinRules: readonly ConversationSecurityBuiltinRule[];
  readonly rateLimits: readonly Readonly<{
    key: string;
    used: number;
    limit: number;
  }>[];
  readonly confirmations: readonly Readonly<{
    key: string;
    count: number;
    highestRisk: "low" | "medium" | "high" | "critical";
  }>[];
}

/** Security/Owner mechanism consumed by the Conversation security query. */
export interface ConversationSecurityProjectionPort {
  inspectSecurityExisting(conversationId: string): Promise<
    | Readonly<{
        status: "done";
        snapshot: ConversationSecurityResult;
      }>
    | Readonly<{ status: "not-found" | "unsupported" | "unavailable" }>
  >;
}

export type ConversationAdoptionReviewProjection =
  | Readonly<{
      status: "ready";
      mergedConversationCount: number;
      appliedRuleCount: number;
      pendingScheduleCount: number;
      pendingRuleCount: number;
      message: string;
    }>
  | Readonly<{
      status: "retry";
      mergedConversationCount: number;
      pendingScheduleCount: number;
      pendingRuleCount: number;
      message: string;
    }>;

/** Owner/recovery mechanisms consumed by the Conversation resume command. */
export interface ConversationResumePort {
  restoreIdentity(
    conversationId: string,
  ): Promise<ConversationDirectoryRecord | null>;
  recoverDependentLifecycle(conversationId: string): Promise<void>;
  reviewAdoption?(
    input: Readonly<{
      conversationId: string;
      caller: ConversationCommandCaller;
    }>,
  ): Promise<ConversationAdoptionReviewProjection | undefined>;
}

/** Correctness boundary used by the delete application command. */
export interface ConversationDeleteCommitPort {
  readonly requiresStableOperationIdentity: boolean;
  createOperationIdentity(): string;
  commit(input: Readonly<{
    conversationId: string;
    operationId: string;
    caller: ConversationCommandCaller;
  }>): Promise<
    | Readonly<{ status: "deleted" }>
    | Readonly<{
        status: "busy";
        reason: "active-turn" | "pending-lifecycle";
      }>
    | Readonly<{ status: "not-found" }>
  >;
}

/** Owner/storage and cross-domain mechanisms required by delete projection. */
export interface ConversationDeleteProjectionPort {
  deleteRuntimeAndStorage(input: Readonly<{
    conversationId: string;
    deletionAlreadyCommitted: boolean;
    onDeleted: () => void;
  }>): Promise<"deleted" | "busy" | "not-found">;
  cancelDependentLifecycle?(conversationId: string): Promise<void>;
  removeDependentData?(conversationId: string): Promise<void>;
}

export type ConversationUncertainResolutionDecision =
  | "user-verified-side-effects"
  | "user-abandoned"
  | "user-retry-acknowledged";

export interface ConversationCancellationProjection {
  readonly matchedDurableRuns: number;
  readonly abortedInFlight: boolean;
  readonly cancelledPending: number;
  readonly dependentLifecycleIngressId?: string;
}

export interface ConversationUncertainResolutionResult {
  readonly state: "queued" | "cancelled" | "failed";
  readonly factDigest: string;
}

/** Owner/Authority mechanisms consumed by the Conversation run-control use cases. */
export interface ConversationRunControlPort {
  readonly requiresStableCancellationIdentity: boolean;
  readonly requiresAuthoritativeRunIdentity: boolean;
  readonly emptyCancellationIsSuccess: boolean;
  createCancellationIdentity(): string;
  cancel(input: Readonly<{
    conversationId: string;
    operationId: string;
    runId?: string;
    caller: ConversationCommandCaller;
    occurredAt: number;
  }>): Promise<ConversationCancellationProjection>;
  settleDependentCancellation?(input: Readonly<{
    conversationId: string;
    ingressId: string;
  }>): Promise<void>;
  recoverDependentCancellation?(conversationId: string): Promise<void>;
  resolveUncertain(input: Readonly<{
    conversationId: string;
    runId: string;
    operationId: string;
    ownerEpoch: number;
    openFactDigest: string;
    decision: ConversationUncertainResolutionDecision;
    caller: ConversationCommandCaller;
  }>): Promise<ConversationUncertainResolutionResult>;
}

/** Read-only external facts used to decorate the durable directory. */
export interface ConversationRuntimeProjectionReader {
  read(conversationId: string): ConversationRuntimeProjection | undefined;
}

/** Advancement remains a separate domain; Conversation only consumes its projection. */
export interface ConversationAdvancementProjectionReader {
  read(
    conversationId: string,
  ): Promise<ConversationAdvancementProjection | undefined>;
}

export type ConversationDirectoryQuery =
  | Readonly<{ kind: "list" }>
  | Readonly<{
      kind: "task-list";
      conversationId: string;
    }>
  | Readonly<{
      kind: "history";
      conversationId: string;
      limit?: number;
      before?: ConversationHistoryCursor;
    }>
  | Readonly<{
      kind: "context-budget";
      conversationId: string;
    }>
  | Readonly<{
      kind: "usage";
      conversationId: string;
    }>
  | Readonly<{
      kind: "security";
      conversationId: string;
    }>;

export type ConversationDirectoryCommand =
  | Readonly<{ kind: "create" }>
  | Readonly<{
      kind: "resume";
      conversationId: string;
      caller: ConversationCommandCaller;
    }>
  | Readonly<{
      kind: "rename";
      conversationId: string;
      name: string;
    }>
  | Readonly<{
      kind: "clear";
      conversationId: string;
      operationId?: string;
      caller: ConversationCommandCaller;
    }>
  | Readonly<{
      kind: "delete";
      conversationId: string;
      operationId?: string;
      caller: ConversationCommandCaller;
    }>
  | Readonly<{
      kind: "abort";
      conversationId: string;
      operationId?: string;
      runId?: string;
      caller: ConversationCommandCaller;
    }>
  | Readonly<{
      kind: "resolve-uncertain";
      conversationId: string;
      runId: string;
      operationId: string;
      ownerEpoch: number;
      openFactDigest: string;
      decision: ConversationUncertainResolutionDecision;
      caller: ConversationCommandCaller;
    }>
  | Readonly<{
      kind: "prepare-agent-turn-identity";
      turnId?: unknown;
      identitySource: "provided" | "legacy-generated";
      caller: ConversationCommandCaller;
    }>
  | Readonly<{
      kind: "admit-agent-turn";
      conversationId?: string;
      preallocatedConversationId?: string;
      input: UserTurnInput;
      turnIdentity: ConversationPreparedAgentTurnIdentity;
      caller: ConversationCommandCaller;
      turnOrigin?: TurnOrigin;
      environment?: ExplicitEnvironmentSelection;
      execution: ConversationAgentTurnExecutionPort;
    }>
  | Readonly<{
      kind: "update-task-list";
      conversationId: string;
      action: ConversationTaskListAction;
      operationId?: string;
    }>
  | Readonly<{
      kind: "compact";
      conversationId: string;
    }>;

export interface ConversationCreatedResult {
  readonly conversationId: string;
  readonly name: string;
}

export interface ConversationResumeResult {
  readonly conversationId: string;
  readonly name: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly advancement?: ConversationAdvancementProjection;
  readonly adoptionReview?: ConversationAdoptionReviewProjection;
}

export interface ConversationRenamedFact {
  readonly kind: "conversation-renamed";
  readonly conversationId: string;
  readonly name: string;
}

export interface ConversationRenamedResult {
  readonly conversationId: string;
  readonly name: string;
  readonly fact: ConversationRenamedFact;
}

export interface ConversationClearedFact {
  readonly kind: "conversation-cleared";
  readonly conversationId: string;
  readonly operationId: string;
}

export interface ConversationClearedResult {
  readonly cleared: true;
  readonly fact: ConversationClearedFact;
}

export interface ConversationDeletedFact {
  readonly kind: "conversation-deleted";
  readonly conversationId: string;
  readonly operationId: string;
}

export interface ConversationDeletedResult {
  readonly deleted: true;
  readonly fact: ConversationDeletedFact;
}

export interface ConversationAbortedResult {
  readonly cancelled: true;
}

export interface ConversationAgentTurnAdmissionResult {
  readonly conversationId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly status: "immediate" | "queued" | "replayed";
}

export interface ConversationTaskListView {
  readonly taskList: TaskListState | null;
}

export interface ConversationTaskListChangedFact {
  readonly kind: "conversation-task-list-changed";
  readonly conversationId: string;
  readonly taskList: TaskListState;
}

export interface ConversationTaskListUpdateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly taskList: TaskListState;
}

export interface ConversationTaskListUpdateOutcome {
  readonly result: ConversationTaskListUpdateResult;
  readonly fact?: ConversationTaskListChangedFact;
}

export interface ConversationCompactResult {
  readonly modified: boolean;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly emergencyFloor?: Readonly<{
    droppedTurns: number;
    error: string;
  }>;
}

export interface ConversationContextBudgetResult {
  readonly budget: ContextBudget;
  readonly turnCount: number;
  readonly calibrationFactor: number;
}

export interface ConversationUsageResult extends ConversationContextBudgetResult {
  readonly subUsages: readonly ConversationSubAgentUsage[];
}

export type ConversationLifecycleFact =
  | ConversationClearedFact
  | ConversationDeletedFact;

export class ConversationApplicationError extends Error {
  constructor(
    readonly code: "invalid-input" | "not-found" | "busy" | "unsupported",
    message: string,
    readonly reason?:
      | "active-turn"
      | "pending-lifecycle"
      | "abort-run-without-operation"
      | "abort-operation-required"
      | "abort-run-required"
      | "control-identity-invalid"
      | "uncertain-resolution-invalid"
      | "surface-caller-invalid"
      | "turn-identity-required"
      | "turn-identity-invalid"
      | "turn-conversation-not-found"
      | "turn-queue-full"
      | "turn-lifecycle-busy"
      | "task-list-operation-required"
      | "task-list-operation-invalid"
      | "task-list-conversation-not-found"
      | "task-list-busy"
      | "compact-conversation-not-found"
      | "compact-busy"
      | "compact-unsupported"
      | "compact-unavailable"
      | "context-budget-conversation-not-found"
      | "context-budget-unsupported"
      | "context-budget-unavailable"
      | "usage-conversation-not-found"
      | "usage-unsupported"
      | "usage-unavailable"
      | "security-conversation-not-found"
      | "security-unsupported"
      | "security-unavailable",
  ) {
    super(message);
    this.name = "ConversationApplicationError";
  }
}

export interface ConversationDirectoryApplication {
  queryList(): Promise<ConversationDirectoryView>;
  queryTaskList(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "task-list" }>,
  ): Promise<ConversationTaskListView>;
  queryHistory(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "history" }>,
  ): Promise<ConversationHistoryPage>;
  queryContextBudget(
    query: Extract<
      ConversationDirectoryQuery,
      { readonly kind: "context-budget" }
    >,
  ): Promise<ConversationContextBudgetResult>;
  queryUsage(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "usage" }>,
  ): Promise<ConversationUsageResult>;
  querySecurity(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "security" }>,
  ): Promise<ConversationSecurityResult>;
  create(): Promise<ConversationCreatedResult>;
  resume(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "resume" }>,
  ): Promise<ConversationResumeResult>;
  rename(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "rename" }>,
  ): Promise<ConversationRenamedResult>;
  clear(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "clear" }>,
  ): Promise<ConversationClearedResult>;
  delete(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "delete" }>,
  ): Promise<ConversationDeletedResult>;
  abort(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "abort" }>,
  ): Promise<ConversationAbortedResult>;
  resolveUncertain(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "resolve-uncertain" }
    >,
  ): Promise<ConversationUncertainResolutionResult>;
  prepareAgentTurnIdentity(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "prepare-agent-turn-identity" }
    >,
  ): ConversationPreparedAgentTurnIdentity;
  admitAgentTurn(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "admit-agent-turn" }
    >,
  ): Promise<ConversationAgentTurnAdmissionResult>;
  updateTaskList(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "update-task-list" }
    >,
  ): Promise<ConversationTaskListUpdateOutcome>;
  compact(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "compact" }
    >,
  ): Promise<ConversationCompactResult>;
}

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 200;

function orderDurableConversationRecords(
  records: readonly ConversationDirectoryRecord[],
): ConversationDirectoryRecord[] {
  return [...records].sort(
    (left, right) =>
      new Date(right.lastActiveAt).getTime() -
      new Date(left.lastActiveAt).getTime(),
  );
}

export class ConversationDirectoryApplicationService
  implements ConversationDirectoryApplication
{
  constructor(
    private readonly input: Readonly<{
      storage: ConversationDirectoryStorage;
      runtime?: ConversationRuntimeProjectionReader;
      advancement?: ConversationAdvancementProjectionReader;
      availability?: ConversationAvailability;
      resume?: ConversationResumePort;
      clear?: ConversationClearCommitPort;
      delete?: ConversationDeleteCommitPort;
      runControl?: ConversationRunControlPort;
      agentTurns?: ConversationAgentTurnAdmissionPort;
      agentTurnIdentity?: ConversationAgentTurnIdentityPort;
      taskLists?: ConversationTaskListPort;
      compact?: ConversationCompactPort;
      usage?: ConversationUsageProjectionPort;
      security?: ConversationSecurityProjectionPort;
      clock?: () => number;
    }>,
  ) {}

  async queryList(): Promise<ConversationDirectoryView> {
    const records = orderDurableConversationRecords(
      await this.input.storage.list(),
    );
    const conversations = await Promise.all(
      records.map(async (record): Promise<ConversationDirectoryEntry> => {
        const runtime = this.input.runtime?.read(record.conversationId);
        const advancement = await this.input.advancement?.read(
          record.conversationId,
        );
        return Object.freeze({
          ...record,
          lastActiveAt: runtime?.lastActiveAt ?? record.lastActiveAt,
          active: runtime?.active ?? false,
          busy: runtime?.busy ?? false,
          observerCount: runtime?.observerCount ?? 0,
          pendingCount: runtime?.pendingCount ?? 0,
          ...(advancement ? { advancement } : {}),
        });
      }),
    );
    return Object.freeze({
      conversations: Object.freeze(conversations),
      ...(this.input.availability
        ? { availability: this.input.availability }
        : {}),
    });
  }

  async queryTaskList(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "task-list" }>,
  ): Promise<ConversationTaskListView> {
    if (
      typeof query.conversationId !== "string" ||
      query.conversationId.trim().length === 0
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation task-list query requires a conversation id",
      );
    }
    const port = this.input.taskLists;
    if (!port) {
      throw new Error("Conversation task-list application is not assembled");
    }
    const taskList = await port.read(query.conversationId);
    return Object.freeze({
      taskList: taskList ? freezeTaskListState(taskList) : null,
    });
  }

  async queryHistory(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "history" }>,
  ): Promise<ConversationHistoryPage> {
    if (typeof query.conversationId !== "string") {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation history requires a conversation id",
      );
    }
    if (
      query.limit !== undefined &&
      (!Number.isInteger(query.limit) || query.limit < 1)
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation history limit must be a positive integer",
      );
    }
    if (
      query.before !== undefined &&
      (typeof query.before.shardId !== "string" ||
        !Number.isInteger(query.before.runIndex))
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation history cursor is invalid",
      );
    }
    return this.input.storage.readHistory(query.conversationId, {
      limit: Math.min(query.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
      ...(query.before ? { before: query.before } : {}),
    });
  }

  async queryContextBudget(
    query: Extract<
      ConversationDirectoryQuery,
      { readonly kind: "context-budget" }
    >,
  ): Promise<ConversationContextBudgetResult> {
    assertConversationInspectionQueryIdentity(query.conversationId, "context budget");
    const port = this.input.usage;
    if (!port) {
      throw new Error("Conversation usage application is not assembled");
    }
    const inspected = await port.inspectContextBudgetExisting(
      query.conversationId,
    );
    if (inspected.status !== "done") {
      throwConversationUsageInspectionError(
        "context-budget",
        query.conversationId,
        inspected.status,
      );
    }
    return freezeConversationContextBudgetResult(inspected.outcome);
  }

  async queryUsage(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "usage" }>,
  ): Promise<ConversationUsageResult> {
    assertConversationInspectionQueryIdentity(query.conversationId, "usage");
    const port = this.input.usage;
    if (!port) {
      throw new Error("Conversation usage application is not assembled");
    }
    const inspected = await port.inspectUsageExisting(query.conversationId);
    if (inspected.status !== "done") {
      throwConversationUsageInspectionError(
        "usage",
        query.conversationId,
        inspected.status,
      );
    }
    return Object.freeze({
      ...freezeConversationContextBudgetResult(inspected.outcome),
      subUsages: Object.freeze(
        inspected.outcome.subUsages.map((usage) =>
          Object.freeze({
            index: usage.index,
            description: usage.description,
            tokens: usage.tokens,
            toolUses: usage.toolUses,
            ...(usage.durationMs !== undefined
              ? { durationMs: usage.durationMs }
              : {}),
            ...(usage.subId !== undefined ? { subId: usage.subId } : {}),
            status: usage.status,
          }),
        ),
      ),
    });
  }

  async querySecurity(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "security" }>,
  ): Promise<ConversationSecurityResult> {
    assertConversationInspectionQueryIdentity(query.conversationId, "security");
    const port = this.input.security;
    if (!port) {
      throw new Error("Conversation security application is not assembled");
    }
    const inspected = await port.inspectSecurityExisting(query.conversationId);
    if (inspected.status !== "done") {
      throwConversationSecurityInspectionError(
        query.conversationId,
        inspected.status,
      );
    }
    return freezeConversationSecurityResult(inspected.snapshot);
  }

  async create(): Promise<ConversationCreatedResult> {
    const created = await this.input.storage.create();
    return Object.freeze({
      conversationId: created.conversationId,
      name: created.name,
    });
  }

  async resume(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "resume" }>,
  ): Promise<ConversationResumeResult> {
    if (
      typeof command.conversationId !== "string" ||
      command.conversationId.trim().length === 0
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation resume requires a conversation id",
      );
    }
    const port = this.input.resume;
    if (!port) {
      throw new Error("Conversation resume application is not assembled");
    }
    const restored = await port.restoreIdentity(command.conversationId);
    if (!restored) {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    await port.recoverDependentLifecycle(command.conversationId);
    const runtime = this.input.runtime?.read(command.conversationId);
    const adoptionReview = await port.reviewAdoption?.({
      conversationId: command.conversationId,
      caller: command.caller,
    });
    const advancement = await this.input.advancement?.read(
      command.conversationId,
    );
    return Object.freeze({
      conversationId: command.conversationId,
      name: restored.name,
      active: runtime?.active ?? false,
      busy: runtime?.busy ?? false,
      ...(advancement ? { advancement } : {}),
      ...(adoptionReview
        ? { adoptionReview: freezeConversationAdoptionReview(adoptionReview) }
        : {}),
    });
  }

  async rename(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "rename" }>,
  ): Promise<ConversationRenamedResult> {
    if (typeof command.conversationId !== "string") {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation rename requires a conversation id",
      );
    }
    if (typeof command.name !== "string" || command.name.trim().length === 0) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation name must be non-empty",
      );
    }
    const renamed = await this.input.storage.rename(
      command.conversationId,
      command.name.trim(),
    );
    if (!renamed) {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    const fact = Object.freeze({
      kind: "conversation-renamed" as const,
      conversationId: command.conversationId,
      name: renamed.name,
    });
    return Object.freeze({
      conversationId: command.conversationId,
      name: renamed.name,
      fact,
    });
  }

  async clear(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "clear" }>,
  ): Promise<ConversationClearedResult> {
    if (typeof command.conversationId !== "string") {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation clear requires a conversation id",
      );
    }
    const port = this.input.clear;
    if (!port) {
      throw new Error("Conversation clear application is not assembled");
    }
    let operationId = command.operationId;
    if (operationId === undefined) {
      if (port.requiresStableOperationIdentity) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Conversation clear requires a stable operation identity",
        );
      }
      operationId = port.createOperationIdentity();
    }
    if (!isProtocolIdentifier(operationId) || operationId.trim().length === 0) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation clear operation identity is invalid",
      );
    }
    const outcome = await port.commit({
      conversationId: command.conversationId,
      operationId,
      caller: command.caller,
    });
    if (outcome.status === "busy") {
      throw new ConversationApplicationError(
        "busy",
        outcome.reason === "pending-lifecycle"
          ? "Conversation has an in-flight or pending lifecycle operation; retry before clearing"
          : "Conversation has an in-flight turn; abort it before clearing",
        outcome.reason,
      );
    }
    if (outcome.status === "not-found") {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    return Object.freeze({
      cleared: true as const,
      fact: conversationClearedFact(command.conversationId, operationId),
    });
  }

  async delete(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "delete" }>,
  ): Promise<ConversationDeletedResult> {
    if (typeof command.conversationId !== "string") {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation delete requires a conversation id",
      );
    }
    const port = this.input.delete;
    if (!port) {
      throw new Error("Conversation delete application is not assembled");
    }
    let operationId = command.operationId;
    if (operationId === undefined) {
      if (port.requiresStableOperationIdentity) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Conversation delete requires a stable operation identity",
        );
      }
      operationId = port.createOperationIdentity();
    }
    if (!isProtocolIdentifier(operationId) || operationId.trim().length === 0) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation delete operation identity is invalid",
      );
    }
    const outcome = await port.commit({
      conversationId: command.conversationId,
      operationId,
      caller: command.caller,
    });
    if (outcome.status === "busy") {
      throw new ConversationApplicationError(
        "busy",
        outcome.reason === "pending-lifecycle"
          ? "Conversation has an in-flight or pending lifecycle operation; retry before deleting"
          : "Conversation has an in-flight turn; abort it before deleting",
        outcome.reason,
      );
    }
    if (outcome.status === "not-found") {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    return Object.freeze({
      deleted: true as const,
      fact: conversationDeletedFact(command.conversationId, operationId),
    });
  }

  async abort(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "abort" }>,
  ): Promise<ConversationAbortedResult> {
    assertConversationControlCaller(command.caller);
    if (
      typeof command.conversationId !== "string" ||
      command.conversationId.trim().length === 0
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation abort requires a conversation id",
        "control-identity-invalid",
      );
    }
    const port = this.input.runControl;
    if (!port) {
      throw new Error("Conversation run-control application is not assembled");
    }
    if (command.runId !== undefined && command.operationId === undefined) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation abort requires an operation identity when a run identity is present",
        "abort-run-without-operation",
      );
    }
    let operationId = command.operationId;
    if (operationId === undefined) {
      if (port.requiresStableCancellationIdentity) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Conversation abort requires a stable operation identity",
          "abort-operation-required",
        );
      }
      operationId = port.createCancellationIdentity();
    }
    if (port.requiresAuthoritativeRunIdentity && command.runId === undefined) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation abort requires an authoritative run identity",
        "abort-run-required",
      );
    }
    if (
      !isProtocolIdentifier(operationId) ||
      (command.runId !== undefined && !isProtocolIdentifier(command.runId))
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation abort control identity is invalid",
        "control-identity-invalid",
      );
    }
    const cancellation = await port.cancel({
      conversationId: command.conversationId,
      operationId,
      ...(command.runId ? { runId: command.runId } : {}),
      caller: command.caller,
      occurredAt: (this.input.clock ?? Date.now)(),
    });
    if (cancellation.dependentLifecycleIngressId) {
      try {
        await port.settleDependentCancellation?.({
          conversationId: command.conversationId,
          ingressId: cancellation.dependentLifecycleIngressId,
        });
      } catch {
        void port
          .recoverDependentCancellation?.(command.conversationId)
          .catch(() => {});
      }
    }
    if (
      !port.emptyCancellationIsSuccess &&
      cancellation.matchedDurableRuns === 0 &&
      !cancellation.abortedInFlight &&
      cancellation.cancelledPending === 0
    ) {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation has no cancellable work: ${command.conversationId}`,
      );
    }
    return Object.freeze({ cancelled: true as const });
  }

  async resolveUncertain(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "resolve-uncertain" }
    >,
  ): Promise<ConversationUncertainResolutionResult> {
    assertConversationControlCaller(command.caller);
    if (
      !isProtocolIdentifier(command.conversationId) ||
      !isProtocolIdentifier(command.operationId) ||
      !isProtocolIdentifier(command.runId) ||
      !Number.isSafeInteger(command.ownerEpoch) ||
      command.ownerEpoch < 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(command.openFactDigest) ||
      !isConversationResolutionDecision(command.decision)
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation uncertain resolution is invalid",
        "uncertain-resolution-invalid",
      );
    }
    const port = this.input.runControl;
    if (!port) {
      throw new Error("Conversation run-control application is not assembled");
    }
    return port.resolveUncertain({
      conversationId: command.conversationId,
      runId: command.runId,
      operationId: command.operationId,
      ownerEpoch: command.ownerEpoch,
      openFactDigest: command.openFactDigest,
      decision: command.decision,
      caller: command.caller,
    });
  }

  async updateTaskList(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "update-task-list" }
    >,
  ): Promise<ConversationTaskListUpdateOutcome> {
    if (
      typeof command.conversationId !== "string" ||
      command.conversationId.trim().length === 0
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation task-list update requires a conversation id",
      );
    }
    const port = this.input.taskLists;
    if (!port) {
      throw new Error("Conversation task-list application is not assembled");
    }
    let operationId = command.operationId;
    if (operationId === undefined) {
      if (port.requiresStableOperationIdentity) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Conversation task-list update requires a stable operation identity",
          "task-list-operation-required",
        );
      }
      operationId = port.createOperationIdentity();
    }
    if (!isProtocolIdentifier(operationId)) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation task-list operation identity is invalid",
        "task-list-operation-invalid",
      );
    }
    const maintained = await port.maintain({
      conversationId: command.conversationId,
      operationId,
      decide: (current) =>
        decideTaskListMutation({
          conversationId: command.conversationId,
          operationId,
          action: command.action,
          current,
          createTaskIdentity: (input) => port.createTaskIdentity(input),
        }),
    });
    if (maintained.status === "busy") {
      throw new ConversationApplicationError(
        "busy",
        "Conversation has an in-flight turn or maintenance operation; update tasks after it completes",
        "task-list-busy",
      );
    }
    if (maintained.status === "not-found") {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${command.conversationId}`,
        "task-list-conversation-not-found",
      );
    }
    const taskList = freezeTaskListState(maintained.taskList);
    const decision = maintained.decision;
    if (decision.outcome === "added" || decision.outcome === "completed") {
      const fact = createConversationTaskListChangedFact(
        command.conversationId,
        taskList,
      );
      return Object.freeze({
        result: Object.freeze({
          ok: true,
          message:
            decision.outcome === "added"
              ? `✓ 添加：“${decision.taskContent}”`
              : `✓ 完成：“${decision.taskContent}”`,
          taskList,
        }),
        fact,
      });
    }
    const message =
      decision.outcome === "invalid-add"
        ? "用法：/task new <内容>"
        : decision.outcome === "invalid-done"
          ? "用法：/task done <序号或 id>"
          : decision.outcome === "not-found"
            ? `未找到任务："${decision.token}"。使用 /tasklist 查看当前列表。`
            : `任务已是 completed 状态："${decision.taskContent}"`;
    return Object.freeze({
      result: Object.freeze({ ok: false, message, taskList }),
    });
  }

  async compact(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "compact" }
    >,
  ): Promise<ConversationCompactResult> {
    if (
      typeof command.conversationId !== "string" ||
      command.conversationId.trim().length === 0
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation compact requires a conversation id",
      );
    }
    const port = this.input.compact;
    if (!port) {
      throw new Error("Conversation compact application is not assembled");
    }
    const compacted = await port.compactExisting(command.conversationId);
    switch (compacted.status) {
      case "busy":
        throw new ConversationApplicationError(
          "busy",
          "Conversation has an in-flight turn; compact after it completes",
          "compact-busy",
        );
      case "not-found":
        throw new ConversationApplicationError(
          "not-found",
          `Conversation not found: ${command.conversationId}`,
          "compact-conversation-not-found",
        );
      case "unsupported":
        throw new ConversationApplicationError(
          "unsupported",
          "Runtime does not support manual compaction",
          "compact-unsupported",
        );
      case "unavailable":
        throw new ConversationApplicationError(
          "busy",
          "这项查看或维护暂不可用；你仍可继续本机对话，重新连接后再试。",
          "compact-unavailable",
        );
      case "done": {
        const outcome = compacted.outcome;
        return Object.freeze({
          modified: outcome.runtimeModified && outcome.windowApplied,
          ...(outcome.tokensBefore !== undefined
            ? { tokensBefore: outcome.tokensBefore }
            : {}),
          ...(outcome.tokensAfter !== undefined
            ? { tokensAfter: outcome.tokensAfter }
            : {}),
          ...(outcome.emergencyFloor
            ? {
                emergencyFloor: Object.freeze({
                  droppedTurns: outcome.emergencyFloor.droppedTurns,
                  error: outcome.emergencyFloor.error,
                }),
              }
            : {}),
        });
      }
    }
  }

  async admitAgentTurn(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "admit-agent-turn" }
    >,
  ): Promise<ConversationAgentTurnAdmissionResult> {
    assertConversationControlCaller(command.caller);
    if (!isNonEmptyUserTurnInput(command.input)) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation turn requires non-empty user input",
      );
    }
    if (
      command.conversationId !== undefined &&
      !isProtocolIdentifier(command.conversationId)
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation turn identity is invalid",
        "turn-identity-invalid",
      );
    }
    if (
      command.preallocatedConversationId !== undefined &&
      (!isProtocolIdentifier(command.preallocatedConversationId) ||
        command.conversationId !== undefined)
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation turn preallocated identity is invalid",
        "turn-identity-invalid",
      );
    }
    const admission = this.input.agentTurns;
    const identity = this.input.agentTurnIdentity;
    if (!admission || !identity) {
      throw new Error("Conversation agent-turn application is not assembled");
    }
    if (!isPreparedAgentTurnIdentity(command.turnIdentity)) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation turn identity is invalid",
        "turn-identity-invalid",
      );
    }
    const { turnId } = command.turnIdentity;
    const conversationIdentity: ConversationAgentTurnIdentity =
      command.conversationId !== undefined
        ? {
            kind: "existing",
            conversationId: command.conversationId,
            exists: () => identity.exists(command.conversationId!),
          }
        : command.preallocatedConversationId !== undefined
          ? {
              kind: "create",
              create: async () => {
                await identity.ensure(command.preallocatedConversationId!);
                return command.preallocatedConversationId!;
              },
            }
          : {
              kind: "create",
              create: async () => (await identity.create()),
            };
    const outcome = await admission.admit({
      identity: conversationIdentity,
      input: command.input,
      turnId,
      caller: command.caller,
      ...(command.turnOrigin ? { turnOrigin: command.turnOrigin } : {}),
      ...(command.environment
        ? { environment: structuredClone(command.environment) }
        : {}),
      execution: command.execution,
    });
    if (outcome.status === "not-found") {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${outcome.conversationId}`,
        "turn-conversation-not-found",
      );
    }
    if (outcome.status === "full") {
      throw new ConversationApplicationError(
        "busy",
        "Conversation has too many pending messages",
        "turn-queue-full",
      );
    }
    if (outcome.status === "lifecycle-busy") {
      throw new ConversationApplicationError(
        "busy",
        "Conversation lifecycle is changing",
        "turn-lifecycle-busy",
      );
    }
    command.execution.onAdmitted?.({
      conversationId: outcome.conversationId,
      turnId,
      ...(outcome.runId ? { runId: outcome.runId } : {}),
      status: outcome.status,
    });
    if (outcome.status === "immediate") void outcome.start();
    return Object.freeze({
      conversationId: outcome.conversationId,
      turnId,
      ...(outcome.runId ? { runId: outcome.runId } : {}),
      status: outcome.status,
    });
  }

  prepareAgentTurnIdentity(
    command: Extract<
      ConversationDirectoryCommand,
      { readonly kind: "prepare-agent-turn-identity" }
    >,
  ): ConversationPreparedAgentTurnIdentity {
    assertConversationControlCaller(command.caller);
    const admission = this.input.agentTurns;
    if (!admission) {
      throw new Error("Conversation agent-turn application is not assembled");
    }
    let turnId = command.turnId;
    if (command.identitySource === "legacy-generated") {
      if (turnId !== undefined) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Conversation turn identity is invalid",
          "turn-identity-invalid",
        );
      }
      if (admission.requiresStableTurnIdentity) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Conversation turn requires a stable turn identity",
          "turn-identity-required",
        );
      }
      turnId = admission.createTurnIdentity();
    }
    if (!isProtocolIdentifier(turnId)) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation turn identity is invalid",
        "turn-identity-invalid",
      );
    }
    return Object.freeze({
      turnId,
      [preparedAgentTurnIdentity]: true as const,
    });
  }
}

function isPreparedAgentTurnIdentity(
  value: ConversationPreparedAgentTurnIdentity,
): value is ConversationPreparedAgentTurnIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    value[preparedAgentTurnIdentity] === true &&
    isProtocolIdentifier(value.turnId)
  );
}

function decideTaskListMutation(input: Readonly<{
  conversationId: string;
  operationId: string;
  action: ConversationTaskListAction;
  current: TaskListState;
  createTaskIdentity(
    input: Readonly<{
      conversationId: string;
      operationId: string;
      content: string;
    }>,
  ): string;
}>): ConversationTaskListMutationDecision {
  if (input.action.kind === "add") {
    const content = input.action.content.trim();
    if (!content) {
      return Object.freeze({ outcome: "invalid-add" as const, token: content });
    }
    const taskId = input.createTaskIdentity({
      conversationId: input.conversationId,
      operationId: input.operationId,
      content,
    });
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("Conversation task-list mechanism returned an invalid task identity");
    }
    return Object.freeze({
      outcome: "added" as const,
      taskContent: content,
      next: {
        items: [
          ...input.current.items,
          { id: taskId, content, status: "pending" as const },
        ],
      },
    });
  }

  const token = input.action.token.trim();
  if (!token) {
    return Object.freeze({ outcome: "invalid-done" as const, token });
  }
  const target = locateTaskListTarget(input.current.items, token);
  if (!target) {
    return Object.freeze({ outcome: "not-found" as const, token });
  }
  if (target.status === "completed") {
    return Object.freeze({
      outcome: "already-completed" as const,
      taskContent: target.content,
    });
  }
  return Object.freeze({
    outcome: "completed" as const,
    taskContent: target.content,
    next: {
      items: input.current.items.map((item) =>
        item.id === target.id
          ? { ...item, status: "completed" as const }
          : item,
      ),
    },
  });
}

function locateTaskListTarget(
  items: readonly TaskItem[],
  token: string,
): TaskItem | null {
  if (/^\d+$/u.test(token)) {
    const index = Number.parseInt(token, 10);
    if (index >= 1 && index <= items.length) return items[index - 1] ?? null;
  }
  const matches = items.filter((item) => item.id.startsWith(token));
  return matches.length === 1 ? matches[0]! : null;
}

function freezeTaskListState(state: TaskListState): TaskListState {
  return Object.freeze({
    items: Object.freeze(
      state.items.map((item) =>
        Object.freeze({
          id: item.id,
          content: item.content,
          status: item.status,
        }),
      ),
    ),
  });
}

export function createConversationTaskListChangedFact(
  conversationId: string,
  taskList: TaskListState,
): ConversationTaskListChangedFact {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new TypeError("Conversation task-list fact requires a conversation id");
  }
  return Object.freeze({
    kind: "conversation-task-list-changed" as const,
    conversationId,
    taskList: freezeTaskListState(taskList),
  });
}

/**
 * Projects one authoritative clear fact. The domain owns the ordering and
 * outcome; Owner/storage implementations only supply serialization mechanics.
 */
export async function projectConversationClear(input: Readonly<{
  conversationId: string;
  operationId: string;
  projection: ConversationClearProjectionPort;
  publishFact?: (fact: ConversationClearedFact) => void | Promise<void>;
}>): Promise<ConversationClearedFact> {
  const outcome = await input.projection.clearRuntimeView(
    input.conversationId,
    () => input.projection.clearStoredView(input.conversationId),
  );
  if (outcome === "busy") {
    throw new ConversationApplicationError(
      "busy",
      "Conversation lifecycle projection is busy",
      "pending-lifecycle",
    );
  }
  if (outcome === "not-found") {
    throw new ConversationApplicationError(
      "not-found",
      `Conversation lifecycle projection lost its identity: ${input.conversationId}`,
    );
  }
  const fact = conversationClearedFact(input.conversationId, input.operationId);
  await input.publishFact?.(fact);
  return fact;
}

function conversationClearedFact(
  conversationId: string,
  operationId: string,
): ConversationClearedFact {
  return Object.freeze({
    kind: "conversation-cleared" as const,
    conversationId,
    operationId,
  });
}

/**
 * Projects one committed delete through Owner/storage, then its dependent
 * lifecycle. Legacy callers retain best-effort dependency cleanup; durable
 * projection stays pending when a dependency fails.
 */
export async function projectConversationDelete(input: Readonly<{
  conversationId: string;
  operationId: string;
  deletionAlreadyCommitted: boolean;
  dependentFailure: "propagate" | "best-effort";
  projection: ConversationDeleteProjectionPort;
  publishFact?: (fact: ConversationDeletedFact) => void;
  onDependentFailure?: (
    step: "cancel-lifecycle" | "remove-data",
    error: unknown,
  ) => void;
}>): Promise<ConversationDeletedFact> {
  const fact = conversationDeletedFact(input.conversationId, input.operationId);
  const outcome = await input.projection.deleteRuntimeAndStorage({
    conversationId: input.conversationId,
    deletionAlreadyCommitted: input.deletionAlreadyCommitted,
    onDeleted: () => input.publishFact?.(fact),
  });
  if (outcome === "busy") {
    throw new ConversationApplicationError(
      "busy",
      "Conversation lifecycle projection is busy",
      "pending-lifecycle",
    );
  }
  if (outcome === "not-found") {
    throw new ConversationApplicationError(
      "not-found",
      `Conversation lifecycle projection lost its identity: ${input.conversationId}`,
    );
  }

  const dependentSteps = [
    [
      "cancel-lifecycle",
      input.projection.cancelDependentLifecycle
        ? () => input.projection.cancelDependentLifecycle!(input.conversationId)
        : undefined,
    ],
    [
      "remove-data",
      input.projection.removeDependentData
        ? () => input.projection.removeDependentData!(input.conversationId)
        : undefined,
    ],
  ] as const;
  for (const [step, project] of dependentSteps) {
    if (!project) continue;
    try {
      await project();
    } catch (error) {
      if (input.dependentFailure === "propagate") throw error;
      input.onDependentFailure?.(step, error);
    }
  }
  return fact;
}

function conversationDeletedFact(
  conversationId: string,
  operationId: string,
): ConversationDeletedFact {
  return Object.freeze({
    kind: "conversation-deleted" as const,
    conversationId,
    operationId,
  });
}

export const CONVERSATION_RENAMED_FACT_EVENT = defineProductApiFactEvent<
  "conversation-renamed",
  ConversationRenamedFact
>("conversation-renamed");

export const CONVERSATION_CLEARED_FACT_EVENT = defineProductApiFactEvent<
  "conversation-cleared",
  ConversationClearedFact
>("conversation-cleared");

export const CONVERSATION_DELETED_FACT_EVENT = defineProductApiFactEvent<
  "conversation-deleted",
  ConversationDeletedFact
>("conversation-deleted");

export const CONVERSATION_TASK_LIST_CHANGED_FACT_EVENT =
  defineProductApiFactEvent<
    "conversation-task-list-changed",
    ConversationTaskListChangedFact
  >("conversation-task-list-changed");

export const CONVERSATION_LIST_QUERY = defineProductApiQuery<
  "conversation-directory.query.list",
  Extract<ConversationDirectoryQuery, { readonly kind: "list" }>,
  ConversationDirectoryView
>("conversation-directory.query.list");

export const CONVERSATION_HISTORY_QUERY = defineProductApiQuery<
  "conversation-directory.query.history",
  Extract<ConversationDirectoryQuery, { readonly kind: "history" }>,
  ConversationHistoryPage
>("conversation-directory.query.history");

export const CONVERSATION_TASK_LIST_QUERY = defineProductApiQuery<
  "conversation-task-list.query.current",
  Extract<ConversationDirectoryQuery, { readonly kind: "task-list" }>,
  ConversationTaskListView
>("conversation-task-list.query.current");

export const CONVERSATION_CONTEXT_BUDGET_QUERY = defineProductApiQuery<
  "conversation-window.query.context-budget",
  Extract<ConversationDirectoryQuery, { readonly kind: "context-budget" }>,
  ConversationContextBudgetResult
>("conversation-window.query.context-budget");

export const CONVERSATION_USAGE_QUERY = defineProductApiQuery<
  "conversation-window.query.usage",
  Extract<ConversationDirectoryQuery, { readonly kind: "usage" }>,
  ConversationUsageResult
>("conversation-window.query.usage");

export const CONVERSATION_SECURITY_QUERY = defineProductApiQuery<
  "conversation-security.query.current",
  Extract<ConversationDirectoryQuery, { readonly kind: "security" }>,
  ConversationSecurityResult
>("conversation-security.query.current");

export const CONVERSATION_CREATE_COMMAND = defineProductApiCommand<
  "conversation-directory.command.create",
  Extract<ConversationDirectoryCommand, { readonly kind: "create" }>,
  ConversationCreatedResult,
  never
>("conversation-directory.command.create", []);

export const CONVERSATION_RESUME_COMMAND = defineProductApiCommand<
  "conversation-directory.command.resume",
  Extract<ConversationDirectoryCommand, { readonly kind: "resume" }>,
  ConversationResumeResult,
  never
>("conversation-directory.command.resume", []);

export const CONVERSATION_RENAME_COMMAND = defineProductApiCommand<
  "conversation-directory.command.rename",
  Extract<ConversationDirectoryCommand, { readonly kind: "rename" }>,
  ConversationRenamedResult,
  ConversationRenamedFact
>("conversation-directory.command.rename", [CONVERSATION_RENAMED_FACT_EVENT]);

export const CONVERSATION_CLEAR_COMMAND = defineProductApiCommand<
  "conversation-directory.command.clear",
  Extract<ConversationDirectoryCommand, { readonly kind: "clear" }>,
  ConversationClearedResult,
  ConversationClearedFact
>("conversation-directory.command.clear", [CONVERSATION_CLEARED_FACT_EVENT]);

export const CONVERSATION_DELETE_COMMAND = defineProductApiCommand<
  "conversation-directory.command.delete",
  Extract<ConversationDirectoryCommand, { readonly kind: "delete" }>,
  ConversationDeletedResult,
  ConversationDeletedFact
>("conversation-directory.command.delete", [CONVERSATION_DELETED_FACT_EVENT]);

export const CONVERSATION_ABORT_COMMAND = defineProductApiCommand<
  "conversation-run.command.abort",
  Extract<ConversationDirectoryCommand, { readonly kind: "abort" }>,
  ConversationAbortedResult,
  never
>("conversation-run.command.abort", []);

export const CONVERSATION_RESOLVE_UNCERTAIN_COMMAND = defineProductApiCommand<
  "conversation-run.command.resolve-uncertain",
  Extract<
    ConversationDirectoryCommand,
    { readonly kind: "resolve-uncertain" }
  >,
  ConversationUncertainResolutionResult,
  never
>("conversation-run.command.resolve-uncertain", []);

export const CONVERSATION_ADMIT_AGENT_TURN_COMMAND = defineProductApiCommand<
  "conversation-run.command.admit-agent-turn",
  Extract<
    ConversationDirectoryCommand,
    { readonly kind: "admit-agent-turn" }
  >,
  ConversationAgentTurnAdmissionResult,
  never
>("conversation-run.command.admit-agent-turn", []);

export const CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND =
  defineProductApiCommand<
    "conversation-run.command.prepare-agent-turn-identity",
    Extract<
      ConversationDirectoryCommand,
      { readonly kind: "prepare-agent-turn-identity" }
    >,
    ConversationPreparedAgentTurnIdentity,
    never
  >("conversation-run.command.prepare-agent-turn-identity", []);

export const CONVERSATION_UPDATE_TASK_LIST_COMMAND = defineProductApiCommand<
  "conversation-task-list.command.update",
  Extract<
    ConversationDirectoryCommand,
    { readonly kind: "update-task-list" }
  >,
  ConversationTaskListUpdateResult,
  ConversationTaskListChangedFact
>("conversation-task-list.command.update", [
  CONVERSATION_TASK_LIST_CHANGED_FACT_EVENT,
], { factEmission: "subset" });

export const CONVERSATION_COMPACT_COMMAND = defineProductApiCommand<
  "conversation-window.command.compact",
  Extract<ConversationDirectoryCommand, { readonly kind: "compact" }>,
  ConversationCompactResult,
  never
>("conversation-window.command.compact", []);

export const CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET =
  defineProductApiExactSet({
    operations: [
      CONVERSATION_LIST_QUERY,
      CONVERSATION_HISTORY_QUERY,
      CONVERSATION_TASK_LIST_QUERY,
      CONVERSATION_CONTEXT_BUDGET_QUERY,
      CONVERSATION_USAGE_QUERY,
      CONVERSATION_SECURITY_QUERY,
      CONVERSATION_CREATE_COMMAND,
      CONVERSATION_RESUME_COMMAND,
      CONVERSATION_RENAME_COMMAND,
      CONVERSATION_CLEAR_COMMAND,
      CONVERSATION_DELETE_COMMAND,
      CONVERSATION_ABORT_COMMAND,
      CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
      CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
      CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
      CONVERSATION_UPDATE_TASK_LIST_COMMAND,
      CONVERSATION_COMPACT_COMMAND,
    ],
    factEvents: [
      CONVERSATION_RENAMED_FACT_EVENT,
      CONVERSATION_CLEARED_FACT_EVENT,
      CONVERSATION_DELETED_FACT_EVENT,
      CONVERSATION_TASK_LIST_CHANGED_FACT_EVENT,
    ],
  });

export function createConversationDirectoryProductApiContribution(
  application: ConversationDirectoryApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(CONVERSATION_LIST_QUERY, async () => ({
        result: await application.queryList(),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_HISTORY_QUERY, async (query) => ({
        result: await application.queryHistory(query),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_TASK_LIST_QUERY, async (query) => ({
        result: await application.queryTaskList(query),
        facts: [],
      })),
      bindProductApiOperation(
        CONVERSATION_CONTEXT_BUDGET_QUERY,
        async (query) => ({
          result: await application.queryContextBudget(query),
          facts: [],
        }),
      ),
      bindProductApiOperation(CONVERSATION_USAGE_QUERY, async (query) => ({
        result: await application.queryUsage(query),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_SECURITY_QUERY, async (query) => ({
        result: await application.querySecurity(query),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_CREATE_COMMAND, async () => ({
        result: await application.create(),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_RESUME_COMMAND, async (command) => ({
        result: await application.resume(command),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_RENAME_COMMAND, async (command) => {
        const result = await application.rename(command);
        return { result, facts: [result.fact] };
      }),
      bindProductApiOperation(CONVERSATION_CLEAR_COMMAND, async (command) => {
        const result = await application.clear(command);
        return { result, facts: [result.fact] };
      }),
      bindProductApiOperation(CONVERSATION_DELETE_COMMAND, async (command) => {
        const result = await application.delete(command);
        return { result, facts: [result.fact] };
      }),
      bindProductApiOperation(CONVERSATION_ABORT_COMMAND, async (command) => ({
        result: await application.abort(command),
        facts: [],
      })),
      bindProductApiOperation(
        CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
        async (command) => ({
          result: await application.resolveUncertain(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
        async (command) => ({
          result: application.prepareAgentTurnIdentity(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
        async (command) => ({
          result: await application.admitAgentTurn(command),
          facts: [],
        }),
      ),
      bindProductApiOperation(
        CONVERSATION_UPDATE_TASK_LIST_COMMAND,
        async (command) => {
          const outcome = await application.updateTaskList(command);
          return {
            result: outcome.result,
            facts: outcome.fact ? [outcome.fact] : [],
          };
        },
      ),
      bindProductApiOperation(CONVERSATION_COMPACT_COMMAND, async (command) => ({
        result: await application.compact(command),
        facts: [],
      })),
    ],
    factEvents: [
      CONVERSATION_RENAMED_FACT_EVENT,
      CONVERSATION_CLEARED_FACT_EVENT,
      CONVERSATION_DELETED_FACT_EVENT,
      CONVERSATION_TASK_LIST_CHANGED_FACT_EVENT,
    ],
  });
}

function assertConversationInspectionQueryIdentity(
  conversationId: unknown,
  name: string,
): asserts conversationId is string {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new ConversationApplicationError(
      "invalid-input",
      `Conversation ${name} query requires a conversation id`,
    );
  }
}

function throwConversationUsageInspectionError(
  kind: "context-budget" | "usage",
  conversationId: string,
  status: "not-found" | "unsupported" | "unavailable",
): never {
  const prefix = kind === "context-budget" ? "context-budget" : "usage";
  if (status === "not-found") {
    throw new ConversationApplicationError(
      "not-found",
      `Conversation not found: ${conversationId}`,
      `${prefix}-conversation-not-found`,
    );
  }
  if (status === "unsupported") {
    throw new ConversationApplicationError(
      "unsupported",
      kind === "context-budget"
        ? "Runtime does not support context budget inspection"
        : "Runtime does not support usage inspection",
      `${prefix}-unsupported`,
    );
  }
  throw new ConversationApplicationError(
    "busy",
    "这项查看或维护暂不可用；你仍可继续本机对话，重新连接后再试。",
    `${prefix}-unavailable`,
  );
}

function freezeConversationContextBudgetResult(
  outcome: ConversationContextBudgetMechanismOutcome,
): ConversationContextBudgetResult {
  return Object.freeze({
    budget: Object.freeze({
      contextWindow: outcome.budget.contextWindow,
      effectiveWindow: outcome.budget.effectiveWindow,
      currentTokens: outcome.budget.currentTokens,
      usageRatio: outcome.budget.usageRatio,
      status: outcome.budget.status,
    }),
    turnCount: outcome.turnCount,
    calibrationFactor: outcome.calibrationFactor,
  });
}

function throwConversationSecurityInspectionError(
  conversationId: string,
  status: "not-found" | "unsupported" | "unavailable",
): never {
  if (status === "not-found") {
    throw new ConversationApplicationError(
      "not-found",
      `Conversation not found: ${conversationId}`,
      "security-conversation-not-found",
    );
  }
  if (status === "unsupported") {
    throw new ConversationApplicationError(
      "unsupported",
      "Runtime does not support security inspection",
      "security-unsupported",
    );
  }
  throw new ConversationApplicationError(
    "busy",
    "这项查看或维护暂不可用；你仍可继续本机对话，重新连接后再试。",
    "security-unavailable",
  );
}

function freezeConversationSecurityResult(
  snapshot: ConversationSecurityResult,
): ConversationSecurityResult {
  return Object.freeze({
    contextId: freezeConversationSecurityContextId(snapshot.contextId),
    workspacePath: snapshot.workspacePath,
    permissionRules: Object.freeze(
      snapshot.permissionRules.map((rule) =>
        Object.freeze({
          id: rule.id,
          pattern: Object.freeze({
            tool: rule.pattern.tool,
            argument: rule.pattern.argument,
          }),
          decision: rule.decision,
          scope: rule.scope,
          createdAt: rule.createdAt,
          lastMatchedAt: rule.lastMatchedAt,
          matchCount: rule.matchCount,
          ...(rule.contextId
            ? { contextId: freezeConversationSecurityContextId(rule.contextId) }
            : {}),
          ...(rule.contextPath !== undefined
            ? { contextPath: rule.contextPath }
            : {}),
          ...(rule.contributors
            ? {
                contributors: Object.freeze(
                  rule.contributors.map((entry) =>
                    Object.freeze({
                      origin: entry.origin,
                      timestamp: entry.timestamp,
                    }),
                  ),
                ),
              }
            : {}),
        }),
      ),
    ),
    builtinRules: Object.freeze(
      snapshot.builtinRules.map((rule) =>
        Object.freeze({
          id: rule.id,
          name: rule.name,
          description: rule.description,
          enabled: rule.enabled,
          match: freezeConversationSecurityMatch(rule.match),
          action: rule.action,
          bypassImmune: rule.bypassImmune,
          severity: rule.severity,
          category: rule.category,
          source: rule.source,
          message: rule.message,
          ...(rule.suggestion !== undefined
            ? { suggestion: rule.suggestion }
            : {}),
        }),
      ),
    ),
    rateLimits: Object.freeze(
      snapshot.rateLimits.map((entry) =>
        Object.freeze({
          key: entry.key,
          used: entry.used,
          limit: entry.limit,
        }),
      ),
    ),
    confirmations: Object.freeze(
      snapshot.confirmations.map((entry) =>
        Object.freeze({
          key: entry.key,
          count: entry.count,
          highestRisk: entry.highestRisk,
        }),
      ),
    ),
  });
}

function freezeConversationSecurityContextId(
  contextId: ConversationSecurityContextId,
): ConversationSecurityContextId {
  switch (contextId.kind) {
    case "main":
      return Object.freeze({ kind: "main" });
    case "workspace":
      return Object.freeze({ kind: "workspace", hash: contextId.hash });
    case "scene":
      return Object.freeze({ kind: "scene", sceneId: contextId.sceneId });
  }
}

function freezeConversationSecurityMatch(
  match: ConversationSecurityMatchSpec,
): ConversationSecurityMatchSpec {
  switch (match.type) {
    case "command":
      return Object.freeze({
        type: match.type,
        pattern: match.pattern,
        ...(match.flags !== undefined ? { flags: match.flags } : {}),
      });
    case "command_prefix":
      return Object.freeze({
        type: match.type,
        prefixes: Object.freeze([...match.prefixes]),
      });
    case "path":
      return Object.freeze({
        type: match.type,
        paths: Object.freeze([...match.paths]),
        access: match.access,
      });
    case "network":
      return Object.freeze({
        type: match.type,
        ...(match.hosts
          ? { hosts: Object.freeze([...match.hosts]) }
          : {}),
        ...(match.ports
          ? { ports: Object.freeze([...match.ports]) }
          : {}),
        ...(match.direction !== undefined
          ? { direction: match.direction }
          : {}),
      });
    case "env_var":
      return Object.freeze({
        type: match.type,
        names: Object.freeze([...match.names]),
      });
    case "tool":
      return Object.freeze({
        type: match.type,
        tools: Object.freeze([...match.tools]),
      });
    case "interpreter":
      return Object.freeze({
        type: match.type,
        languages: Object.freeze([...match.languages]),
      });
    case "composite":
      return Object.freeze({
        type: match.type,
        op: match.op,
        specs: Object.freeze(match.specs.map(freezeConversationSecurityMatch)),
      });
  }
}

function assertConversationControlCaller(
  caller: ConversationCommandCaller,
): asserts caller is Extract<ConversationCommandCaller, { kind: "surface" }> {
  if (
    caller.kind !== "surface" ||
    !isProtocolIdentifier(caller.surfacePrincipal) ||
    !isProtocolIdentifier(caller.connectionId)
  ) {
    throw new ConversationApplicationError(
      "invalid-input",
      "Conversation control requires an authenticated surface caller",
      "surface-caller-invalid",
    );
  }
}

function isConversationResolutionDecision(
  value: unknown,
): value is ConversationUncertainResolutionDecision {
  return (
    value === "user-verified-side-effects" ||
    value === "user-abandoned" ||
    value === "user-retry-acknowledged"
  );
}

function freezeConversationAdoptionReview(
  review: ConversationAdoptionReviewProjection,
): ConversationAdoptionReviewProjection {
  return review.status === "ready"
    ? Object.freeze({
        status: review.status,
        mergedConversationCount: review.mergedConversationCount,
        appliedRuleCount: review.appliedRuleCount,
        pendingScheduleCount: review.pendingScheduleCount,
        pendingRuleCount: review.pendingRuleCount,
        message: review.message,
      })
    : Object.freeze({
        status: review.status,
        mergedConversationCount: review.mergedConversationCount,
        pendingScheduleCount: review.pendingScheduleCount,
        pendingRuleCount: review.pendingRuleCount,
        message: review.message,
      });
}

/** Cross-owner list merge remains Conversation-owned; topology supplies inputs only. */
export function mergeConversationDirectoryViews(
  local: ConversationDirectoryView,
  remoteEntries: readonly ConversationDirectoryEntry[],
): ConversationDirectoryView {
  const conversations = [...local.conversations, ...remoteEntries];
  conversations.sort(
    (left, right) =>
      right.lastActiveAt.localeCompare(left.lastActiveAt, "en-US") ||
      left.conversationId.localeCompare(right.conversationId, "en-US"),
  );
  return Object.freeze({
    conversations: Object.freeze(conversations),
    ...(local.availability ? { availability: local.availability } : {}),
  });
}
