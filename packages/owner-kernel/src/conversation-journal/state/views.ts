import {
  isOpenAdvancementSession,
  type AdvancementControlEvent,
  type AdvancementSubmissionReceipt,
} from "@zhixing-ai/core/advancement";
import type { Message } from "@zhixing-ai/core";
import type {
  ArtifactRef,
  ContentAssetRef,
  ConversationRunState,
  DataPlaneTicket,
  GovernorRecord,
  LogicalRecord,
  MutationBatch,
  PublishConflictNotice,
  PublishRecord,
  SegmentRecord,
  TaskListState,
  TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import type { ChannelInteractionJournalState } from "../../channel-interaction-records.js";
import type {
  AssignmentTerminationProofKind,
  ConversationRunJournalRecord,
  DurableSourceBoundProof,
} from "../../conversation-run-contracts.js";
import type { StatusHistoryEntry } from "../../conversation-status-projection.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import {
  rejectedNotStartedKey,
  type AdmittedProjection,
  type AssignedProjection,
  type ConversationAbortTicketAuthorizer,
  type ConversationCommitLogRecord,
  type ConversationRunControlDescriptor,
  type ConversationUncertainResolutionFact,
  type FinalOutboxProjection,
  type FinalOutboxProjectionEntry,
  type PendingLifecycleProjection,
  type PublishDomainPlan,
  type PublishProjection,
  type RunProjection,
  type SubmissionCommitSidecars,
  type SubmissionGuardProjection,
} from "../contracts.js";
import {
  cancellableRunDescriptors,
  capabilityRevocations,
  hasAssignmentControlDurableStarted,
  hasRejectedNotStarted,
  nextConversationAssignmentAttempt,
  prepareRunQueuedTerminal,
  proofBindsConversationSource,
  selectActiveAssignment,
  type GuardAssignedEntry,
} from "./assignment-control.js";
import { firstCommitIndexAfter } from "./commit-publish.js";
import { snapshot, type DeepReadonly } from "./common.js";
export type { DeepReadonly };
import {
  assertRunInputCommit,
  hasQueuedPositionUsed,
  isEarliestQueuedPosition,
  listOrderedQueuedEntries,
  listQueuedEntriesSnapshot,
  peekEarliestQueuedEntry,
  type AppendedInputEntry,
  type GuardAdmittedEntry,
  type QueuedRunEntry,
} from "./run-queue-input.js";
import {
  assertLegalAdvancementEvents,
  findActiveAdvancementSessionId,
} from "./session-domain.js";

export type ReadonlyAdmittedFact = DeepReadonly<AdmittedProjection>;
export type ReadonlyAppendedInputFact = DeepReadonly<AppendedInputEntry>;
export type ReadonlyAssignedFact = DeepReadonly<AssignedProjection>;
export type ReadonlyGuardAssignedFact = DeepReadonly<GuardAssignedEntry>;

export interface ReadonlyMirrorStateFact {
  readonly ordinal: number;
  readonly mirrorDigest: string;
  readonly mirroredUpTo: number;
  readonly requestIds: {
    has(requestId: string): boolean;
  };
}

function freezeAdmittedFact(entry: AdmittedProjection): ReadonlyAdmittedFact {
  return Object.freeze({ ...entry }) as ReadonlyAdmittedFact;
}

function freezeAppendedFact(
  entry: AppendedInputEntry,
): ReadonlyAppendedInputFact {
  return Object.freeze({ ...entry }) as ReadonlyAppendedInputFact;
}

function freezeAssignedFact(entry: AssignedProjection): ReadonlyAssignedFact {
  return Object.freeze({ ...entry }) as ReadonlyAssignedFact;
}

function freezeGuardAssignedFact(
  entry: GuardAssignedEntry,
): ReadonlyGuardAssignedFact {
  return Object.freeze({ ...entry }) as ReadonlyGuardAssignedFact;
}

function freezeTicketFact(
  entry: DataPlaneTicket,
): DeepReadonly<DataPlaneTicket> {
  return Object.freeze({
    ...entry,
    ref: Object.freeze({ ...entry.ref }),
    signature: Object.freeze({ ...entry.signature }),
  }) as DeepReadonly<DataPlaneTicket>;
}

export interface SessionDomainFacts {
  readonly domainRevision: number;
  readonly deleted: boolean;
  readonly clearedThroughLsn: number;
  readonly clearedThroughRevision?: number;
  readonly hasDurableIdentity?: boolean;
  readonly pendingLifecycleCount?: number;
  readonly sessionName?: string;
  readonly modelSelection?: DeepReadonly<import("@zhixing-ai/core/contracts").SessionModelSelection>;
  readonly lastActiveAt?: string;
  readonly sessionMeta?: DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "session-meta" }>
  >;
  readonly activeAdvancementSessionId?: string;
  readonly taskList: DeepReadonly<TaskListState>;
  readonly segments: readonly DeepReadonly<
    Pick<SegmentRecord, "segmentId" | "timestamp">
  >[];
  hasAnyLifecycleRequests(): boolean;
  hasTaskListRequestId(requestId: string): boolean;
  getAdvancementStatus(sessionId: string): string | undefined;
  findActiveAdvancementSessionId(): string | undefined;
  hasOpenAdvancementSession(): boolean;
  assertLegalAdvancementBatch(events: readonly AdvancementControlEvent[]): void;
  getAdvancementWrite(
    requestId: string,
  ):
    | {
        readonly domainRevision: number;
        readonly eventsDigest: string;
        readonly receipt?: DeepReadonly<AdvancementSubmissionReceipt>;
      }
    | undefined;
  getSessionMutationDigest(
    requestId: string,
  ): { readonly digest: string; readonly domainRevision: number } | undefined;
  getSessionMetaByRequest(
    requestId: string,
  ):
    | DeepReadonly<Extract<ConversationRunJournalRecord, { t: "session-meta" }>>
    | undefined;
  getLifecycleByRequest(
    requestId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "session-lifecycle" }>
      >
    | undefined;
  getPendingLifecycleProjection(
    domainRevision: number,
  ): Readonly<PendingLifecycleProjection> | undefined;
  readonly pendingLifecycleProjectionSize: number;
  listPendingLifecycleProjections(): readonly Readonly<PendingLifecycleProjection>[];
  hasProjectedLifecycleRevision(domainRevision: number): boolean;
  getWorksceneControl(
    runId: string,
  ):
    | {
        readonly record: DeepReadonly<TranscriptRunRecord>;
        readonly advancementSessionId?: string;
      }
    | undefined;
}

export interface RunQueueInputFacts {
  getAdmitted(runId: string): ReadonlyAdmittedFact | undefined;
  hasAdmitted(runId: string): boolean;
  hasAnyAdmitted(): boolean;
  listAdmitted(): readonly ReadonlyAdmittedFact[];
  listAdmittedForRuns(selectedRunIds: ReadonlySet<string>): readonly ReadonlyAdmittedFact[];
  listAdmittedForIngress(
    ingressId: string,
    source: AdmittedProjection["record"]["invocation"]["source"],
  ): readonly ReadonlyAdmittedFact[];
  getRunIdByIngress(ingressKey: string): string | undefined;
  hasQueuedPosition(position: number): boolean;
  peekEarliestQueued(): QueuedRunEntry | undefined;
  isEarliestQueuedPosition(position: number): boolean;
  listOrderedQueuedEntries(): readonly QueuedRunEntry[];
  listQueuedEntriesSnapshot(): readonly QueuedRunEntry[];
  getOpenInputAssignment(runId: string): string | undefined;
  isInputAssignmentClosed(assignmentId: string): boolean;
  getAppendedInput(ingressKey: string): ReadonlyAppendedInputFact | undefined;
  listAppendedInputs(): readonly ReadonlyAppendedInputFact[];
  collectUnconsumedInputKeys(runId: string, assignmentId: string): readonly string[];
  hasInputConsumption(key: string): boolean;
  getInputConsumption(
    key: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "run-input-consumed" }>
      >
    | undefined;
  listInputConsumptionsForAssignment(
    assignmentId: string,
  ): readonly DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "run-input-consumed" }>
  >[];
  assertClosedInputMatches(
    runId: string,
    assignmentId: string,
    messages: readonly Message[],
  ): void;
}

export interface GuardQueueInputFacts {
  getAdmitted(runId: string): DeepReadonly<GuardAdmittedEntry> | undefined;
  getRunIdByIngress(ingressKey: string): string | undefined;
  hasQueuedPosition(position: number): boolean;
  isEarliestQueuedPosition(position: number): boolean;
}

export interface AssignmentControlFacts {
  readonly activeRunId?: string;
  getRunState(
    runId: string,
  ): { readonly state: ConversationRunState; readonly statusRevision: number } | undefined;
  listRunStates(): readonly {
    readonly runId: string;
    readonly state: ConversationRunState;
    readonly statusRevision: number;
  }[];
  hasRunStateMatching(predicate: (state: ConversationRunState) => boolean): boolean;
  getAssignmentIdForRun(runId: string): string | undefined;
  getAssigned(assignmentId: string): ReadonlyAssignedFact | undefined;
  listAssigned(): readonly ReadonlyAssignedFact[];
  hasReservationId(reservationId: string): boolean;
  hasAssigned(assignmentId: string): boolean;
  isAssignmentClosed(assignmentId: string): boolean;
  listRecoveryAssignmentIds(): readonly string[];
  getUncertainOrigin(
    assignmentId: string,
  ): "dispatched" | "running" | "cancel-requested" | undefined;
  getStatusHistory(
    runId: string,
  ): readonly DeepReadonly<StatusHistoryEntry>[] | undefined;
  getConflictByKey(
    key: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "dispatch-conflict" }>
      >
    | undefined;
  getConflictByAssignment(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "dispatch-conflict" }>
      >
    | undefined;
  hasContainedFact(openFactDigest: string): boolean;
  getContainmentByAssignment(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<
          ConversationRunJournalRecord,
          { t: "dispatch-conflict-contained" | "cancel-contained" }
        >
      >
    | undefined;
  getSuperseded(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "assignment-superseded" }>
      >
    | undefined;
  getSupersedeRequest(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "supersede-requested" }>
      >
    | undefined;
  getSupersedeStartedObservation(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<
          ConversationRunJournalRecord,
          { t: "supersede-started-observed" }
        >
      >
    | undefined;
  getCancelFence(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<ConversationRunJournalRecord, { t: "cancel-fence" }>>
    | undefined;
  getCancelOrigin(assignmentId: string): "dispatched" | "running" | undefined;
  getAcceptedCancellation(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "cancel-proof-accepted" }>
      >
    | undefined;
  getRejectedNotStarted(
    assignmentId: string,
    kind: AssignmentTerminationProofKind,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "not-started-rejected" }>
      >
    | undefined;
  hasRejectedNotStarted(
    assignmentId: string,
    kind: AssignmentTerminationProofKind,
  ): boolean;
  isCapabilityRevoked(assignmentId: string, capId: string): boolean;
  getResolution(
    runId: string,
  ): DeepReadonly<ConversationUncertainResolutionFact> | undefined;
  hasDurableStarted(assignmentId: string): boolean;
  nextAssignmentAttempt(runId: string): number;
  prepareQueuedTerminalRecords(
    coordinator: AssignmentResourceCoordinator | undefined,
    runId: string,
    reason: "cancelled" | "failed" | "expired",
  ): readonly LogicalRecord<GovernorRecord>[];
  capabilityRevocationsFor(
    conversationId: string,
    assigned: {
      readonly record: {
        readonly assignmentId: string;
        readonly capIds: readonly string[];
      };
    },
  ): LogicalRecord<ConversationCommitLogRecord>[];
  proofBindsSource(
    assigned: {
      readonly record: DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "assigned" }>
      >;
    },
    proof: DurableSourceBoundProof,
    conversationId: string,
    legacy?: ConversationAbortTicketAuthorizer,
  ): boolean;
  listCancellableRuns(): ConversationRunControlDescriptor[];
  selectActive<Value>(
    select: (
      assigned: ReadonlyAssignedFact,
      current: ConversationRunState,
    ) => Value | undefined,
  ): Value | undefined;
}

export interface GuardAssignmentControlFacts {
  readonly activeRunId?: string;
  getRunState(
    runId: string,
  ): { readonly state: ConversationRunState; readonly statusRevision: number } | undefined;
  getAssignmentIdForRun(runId: string): string | undefined;
  getAssigned(assignmentId: string): ReadonlyGuardAssignedFact | undefined;
  isAssignmentClosed(assignmentId: string): boolean;
  hasConflict(assignmentId: string): boolean;
  hasOpenConflict(assignmentId: string): boolean;
  getSupersedeRequest(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "supersede-requested" }>
      >
    | undefined;
  hasSupersedeStarted(assignmentId: string): boolean;
  getCancelFence(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<ConversationRunJournalRecord, { t: "cancel-fence" }>>
    | undefined;
  hasAcceptedCancellation(assignmentId: string): boolean;
  hasDurableStarted(assignmentId: string): boolean;
  getResolution(
    runId: string,
  ): DeepReadonly<ConversationUncertainResolutionFact> | undefined;
  isCapabilityRevoked(assignmentId: string, capId: string): boolean;
}

export interface ChannelTicketFacts {
  readonly ticketSyncFrontier?: string;
  readonly channelInteractions: ChannelInteractionJournalState;
  getTicket(ticketId: string): DeepReadonly<DataPlaneTicket> | undefined;
  hasTicket(ticketId: string): boolean;
  listTickets(): readonly DeepReadonly<DataPlaneTicket>[];
  ticketsIterable(): Iterable<DeepReadonly<DataPlaneTicket>>;
  getTicketIdsForAssignment(assignmentId: string): ReadonlySet<string>;
  getTicketReplacement(ticketId: string): string | undefined;
  isTicketRevoked(ticketId: string): boolean;
  listUnrevokedTicketIds(assignmentId: string): readonly string[];
}

export interface GuardChannelTicketFacts {
  readonly ticketSyncFrontier?: string;
  getTicket(ticketId: string): DeepReadonly<DataPlaneTicket> | undefined;
  isTicketRevoked(ticketId: string): boolean;
  getTicketReplacement(ticketId: string): string | undefined;
  getTicketIdsForAssignment(assignmentId: string): ReadonlySet<string>;
}

export interface CommitPublishFacts {
  readonly latestCommit?: DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
  commitsAfter(
    afterCommitRevision: number,
  ): readonly DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >[];
  findCommittedByRunId(
    runId: string,
  ):
    | DeepReadonly<Extract<ConversationRunJournalRecord, { t: "committed" }>>
    | undefined;
  findAllowOnceInteractionOutcome(
    requestId: string,
  ):
    | { readonly t: "answered"; readonly decisionDigest: string }
    | { readonly t: "closed" }
    | undefined;
  getMirrorState(assignmentId: string): ReadonlyMirrorStateFact | undefined;
  getMirrorBatch(
    batchDigest: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "interaction-mirror" }>
      >
    | undefined;
  hasMirrorBatch(batchDigest: string): boolean;
  listMirrorBatches(): readonly DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "interaction-mirror" }>
  >[];
  getCommitted(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<ConversationRunJournalRecord, { t: "committed" }>>
    | undefined;
  hasCommitted(assignmentId: string): boolean;
  getBundleAcknowledgement(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>
      >
    | undefined;
  hasBundleAcknowledgement(assignmentId: string): boolean;
  listBundleAcknowledgementOutbox(): readonly string[];
  getAssignmentByCommitRevision(commitRevision: number): string | undefined;
  getContentByRevision(
    commitRevision: number,
  ): readonly DeepReadonly<ContentAssetRef>[] | undefined;
  hasProjectedCommit(assignmentId: string): boolean;
  listPendingCommitProjections(): readonly DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >[];
}

export interface GuardCommitPublishFacts {
  getCommitted(
    assignmentId: string,
  ):
    | {
        readonly bundle: { readonly ref: Readonly<ArtifactRef> };
        readonly commitRevision: number;
        readonly sidecars: DeepReadonly<SubmissionCommitSidecars>;
      }
    | undefined;
  hasBundleAcknowledgement(assignmentId: string): boolean;
}

export interface PublishFacts {
  getDecision(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<PublishRecord, { t: "publish-decision" }>>
    | undefined;
  getBatch(assignmentId: string): DeepReadonly<MutationBatch> | undefined;
  getCommitRevision(assignmentId: string): number | undefined;
  getProgress(
    assignmentId: string,
    domain: "session" | "global",
  ):
    | DeepReadonly<Extract<PublishRecord, { t: "publish-progress" }>>
    | undefined;
  getDomainPlan(
    assignmentId: string,
    domain: "session" | "global",
  ): DeepReadonly<PublishDomainPlan> | undefined;
  getPendingAssignmentsForConversation(conversationId: string): readonly string[];
  isCompleted(assignmentId: string): boolean;
  getConflicts(
    assignmentId: string,
  ): DeepReadonly<PublishConflictNotice["conflicts"]> | undefined;
}

export interface FinalOutboxFacts {
  getEntry(key: string): DeepReadonly<FinalOutboxProjectionEntry> | undefined;
  getActiveKeyForRevision(
    conversationId: string,
    commitRevision: number,
  ): string | undefined;
  listPendingForConversation(
    conversationId: string,
  ): readonly DeepReadonly<FinalOutboxProjectionEntry>[];
  listPublishedForConversation(
    conversationId: string,
  ): readonly DeepReadonly<FinalOutboxProjectionEntry>[];
}

export interface ConversationDecisionFacts {
  readonly session: SessionDomainFacts;
  readonly queueInput: RunQueueInputFacts;
  readonly assignment: AssignmentControlFacts;
  readonly tickets: ChannelTicketFacts;
  readonly commitPublish: CommitPublishFacts;
}

export interface ConversationGuardDecisionFacts {
  readonly queueInput: GuardQueueInputFacts;
  readonly assignment: GuardAssignmentControlFacts;
  readonly tickets: GuardChannelTicketFacts;
  readonly commitPublish: GuardCommitPublishFacts;
}

export function readSessionDomainFacts(state: RunProjection): SessionDomainFacts {
  return {
    get domainRevision() {
      return state.domainRevision;
    },
    get deleted() {
      return state.deleted;
    },
    get clearedThroughLsn() {
      return state.clearedThroughLsn;
    },
    get clearedThroughRevision() {
      return state.clearedThroughRevision;
    },
    get hasDurableIdentity() {
      return state.hasDurableIdentity;
    },
    get pendingLifecycleCount() {
      return state.pendingLifecycleCount;
    },
    get sessionName() {
      return state.sessionName;
    },
    get modelSelection() {
      return state.modelSelection
        ? (structuredClone(state.modelSelection) as DeepReadonly<import("@zhixing-ai/core/contracts").SessionModelSelection>)
        : undefined;
    },
    get lastActiveAt() {
      return state.lastActiveAt;
    },
    get sessionMeta() {
      const meta = state.sessionMeta;
      return meta ? (Object.freeze({ ...meta }) as DeepReadonly<typeof meta>) : undefined;
    },
    get activeAdvancementSessionId() {
      return state.activeAdvancementSessionId;
    },
    get taskList() {
      return Object.freeze({
        items: [...state.taskList.items],
      }) as DeepReadonly<TaskListState>;
    },
    get segments() {
      return [...state.segments];
    },
    hasAnyLifecycleRequests: () => state.lifecycleByRequest.size > 0,
    hasTaskListRequestId: (requestId) => state.taskListRequestIds.has(requestId),
    getAdvancementStatus: (sessionId) =>
      state.advancementStatuses?.get(sessionId) ??
      state.advancementSessions.get(sessionId)?.status,
    findActiveAdvancementSessionId: () => findActiveAdvancementSessionId(state),
    hasOpenAdvancementSession: () =>
      state.hasOpenAdvancement === true ||
      [...state.advancementSessions.values()].some((session) =>
        isOpenAdvancementSession(session),
      ) ||
      [...(state.advancementStatuses?.values() ?? [])].some((status) =>
        isOpenAdvancementSession({ status } as Parameters<
          typeof isOpenAdvancementSession
        >[0]),
      ),
    assertLegalAdvancementBatch: (events) =>
      assertLegalAdvancementEvents(state, events),
    getAdvancementWrite: (requestId) => {
      const write = state.advancementWrites.get(requestId);
      return write ? Object.freeze({ ...write }) : undefined;
    },
    getSessionMutationDigest: (requestId) => {
      const entry = state.sessionMutationDigests.get(requestId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getSessionMetaByRequest: (requestId) => {
      const entry = state.sessionMetaByRequest.get(requestId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getLifecycleByRequest: (requestId) => {
      const entry = state.lifecycleByRequest.get(requestId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getPendingLifecycleProjection: (domainRevision) => {
      const entry = state.pendingLifecycleProjections.get(domainRevision);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    get pendingLifecycleProjectionSize() {
      return state.pendingLifecycleProjections.size;
    },
    listPendingLifecycleProjections: () =>
      [...state.pendingLifecycleProjections.values()].map((entry) =>
        Object.freeze({ ...entry }),
      ),
    hasProjectedLifecycleRevision: (domainRevision) =>
      state.projectedLifecycleRevisions.has(domainRevision),
    getWorksceneControl: (runId) => {
      const entry = state.worksceneControls.get(runId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
  };
}

export function readRunQueueInputFacts(state: RunProjection): RunQueueInputFacts {
  return {
    getAdmitted: (runId) => {
      const entry = state.admittedByRun.get(runId);
      return entry ? freezeAdmittedFact(entry) : undefined;
    },
    hasAdmitted: (runId) => state.admittedByRun.has(runId),
    hasAnyAdmitted: () => state.admittedByRun.size > 0,
    listAdmitted: () => [...state.admittedByRun.values()].map(freezeAdmittedFact),
    listAdmittedForRuns: (selectedRunIds) => {
      const matched: ReadonlyAdmittedFact[] = [];
      for (const entry of state.admittedByRun.values()) {
        if (selectedRunIds.has(entry.record.runId)) {
          matched.push(freezeAdmittedFact(entry));
        }
      }
      return matched;
    },
    listAdmittedForIngress: (ingressId, source) => {
      const matched: ReadonlyAdmittedFact[] = [];
      for (const entry of state.admittedByRun.values()) {
        if (
          entry.record.ingress.ingressId === ingressId &&
          entry.record.invocation.source === source
        ) {
          matched.push(freezeAdmittedFact(entry));
        }
      }
      return matched;
    },
    getRunIdByIngress: (ingressKey) => state.runByIngress.get(ingressKey),
    hasQueuedPosition: (position) => hasQueuedPositionUsed(state, position),
    peekEarliestQueued: () => peekEarliestQueuedEntry(state),
    isEarliestQueuedPosition: (position) =>
      isEarliestQueuedPosition(state, position),
    listOrderedQueuedEntries: () => listOrderedQueuedEntries(state),
    listQueuedEntriesSnapshot: () => listQueuedEntriesSnapshot(state),
    getOpenInputAssignment: (runId) => state.openInputAssignments.get(runId),
    isInputAssignmentClosed: (assignmentId) =>
      state.closedInputAssignments.has(assignmentId),
    getAppendedInput: (ingressKey) => {
      const entry = state.appendedInputs.get(ingressKey);
      return entry ? freezeAppendedFact(entry) : undefined;
    },
    listAppendedInputs: () =>
      [...state.appendedInputs.values()].map(freezeAppendedFact),
    collectUnconsumedInputKeys: (runId, assignmentId) => {
      const consumed = new Set<string>();
      for (const entry of state.inputConsumptions.values()) {
        if (entry.assignmentId === assignmentId) {
          for (const key of entry.ingressKeys) consumed.add(key);
        }
      }
      const candidates: Array<{ readonly key: string; readonly position: number }> = [];
      for (const appended of state.appendedInputs.values()) {
        if (
          appended.record.runId === runId &&
          !consumed.has(appended.record.ingressKey)
        ) {
          candidates.push({
            key: appended.record.ingressKey,
            position: appended.record.position,
          });
        }
      }
      candidates.sort((a, b) => a.position - b.position);
      return candidates.map((entry) => entry.key);
    },
    hasInputConsumption: (key) => state.inputConsumptions.has(key),
    getInputConsumption: (key) => {
      const entry = state.inputConsumptions.get(key);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    listInputConsumptionsForAssignment: (assignmentId) =>
      [...state.inputConsumptions.values()]
        .filter((entry) => entry.assignmentId === assignmentId)
        .map(
          (entry) =>
            snapshot(entry, "Run input consumption") as DeepReadonly<typeof entry>,
        ),
    assertClosedInputMatches: (runId, assignmentId, messages) =>
      assertRunInputCommit(state, runId, assignmentId, messages),
  };
}

export function readGuardQueueInputFacts(
  guard: SubmissionGuardProjection,
): GuardQueueInputFacts {
  return {
    getAdmitted: (runId) => {
      const entry = guard.admittedByRun.get(runId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<GuardAdmittedEntry>)
        : undefined;
    },
    getRunIdByIngress: (ingressKey) => guard.runByIngress.get(ingressKey),
    hasQueuedPosition: (position) => hasQueuedPositionUsed(guard, position),
    isEarliestQueuedPosition: (position) =>
      isEarliestQueuedPosition(guard, position),
  };
}

export function readAssignmentControlFacts(
  state: RunProjection,
): AssignmentControlFacts {
  return {
    get activeRunId() {
      return state.activeRunId;
    },
    getRunState: (runId) => {
      const entry = state.stateByRun.get(runId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    listRunStates: () =>
      [...state.stateByRun.entries()].map(([runId, entry]) =>
        Object.freeze({
          runId,
          state: entry.state,
          statusRevision: entry.statusRevision,
        }),
      ),
    hasRunStateMatching: (predicate) => {
      for (const entry of state.stateByRun.values()) {
        if (predicate(entry.state)) return true;
      }
      return false;
    },
    getAssignmentIdForRun: (runId) => state.assignmentByRun.get(runId),
    getAssigned: (assignmentId) => {
      const entry = state.assignedById.get(assignmentId);
      return entry ? freezeAssignedFact(entry) : undefined;
    },
    listAssigned: () =>
      [...state.assignedById.values()].map(freezeAssignedFact),
    hasReservationId: (reservationId) => {
      for (const assigned of state.assignedById.values()) {
        if (assigned.record.reservation.reservationId === reservationId) {
          return true;
        }
      }
      return false;
    },
    hasAssigned: (assignmentId) => state.assignedById.has(assignmentId),
    isAssignmentClosed: (assignmentId) =>
      state.closedAssignments.has(assignmentId),
    listRecoveryAssignmentIds: () => [...state.recoveryAssignments],
    getUncertainOrigin: (assignmentId) =>
      state.uncertainOrigins.get(assignmentId),
    getStatusHistory: (runId) => {
      const history = state.statusHistoryByRun.get(runId);
      return history ? [...history] : undefined;
    },
    getConflictByKey: (key) => {
      const entry = state.conflicts.get(key);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    getConflictByAssignment: (assignmentId) => {
      const entry = state.conflictByAssignment.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasContainedFact: (openFactDigest) =>
      state.containedFacts.has(openFactDigest),
    getContainmentByAssignment: (assignmentId) => {
      const entry = state.containmentByAssignment.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    getSuperseded: (assignmentId) => {
      const entry = state.superseded.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    getSupersedeRequest: (assignmentId) => {
      const entry = state.supersedeRequests.get(assignmentId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getSupersedeStartedObservation: (assignmentId) => {
      const entry = state.supersedeStartedObservations.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    getCancelFence: (assignmentId) => {
      const entry = state.cancelFences.get(assignmentId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getCancelOrigin: (assignmentId) => state.cancelOrigins.get(assignmentId),
    getAcceptedCancellation: (assignmentId) => {
      const entry = state.acceptedCancellations.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    getRejectedNotStarted: (assignmentId, kind) => {
      const entry = state.rejectedNotStarted.get(
        rejectedNotStartedKey(assignmentId, kind),
      );
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasRejectedNotStarted: (assignmentId, kind) =>
      hasRejectedNotStarted(state, assignmentId, kind),
    isCapabilityRevoked: (assignmentId, capId) =>
      state.revokedCapabilities.has(`${assignmentId}\0${capId}`),
    getResolution: (runId) => {
      const entry = state.resolutionsByRun.get(runId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasDurableStarted: (assignmentId) =>
      hasAssignmentControlDurableStarted(state, assignmentId),
    nextAssignmentAttempt: (runId) =>
      nextConversationAssignmentAttempt(state, runId),
    prepareQueuedTerminalRecords: (coordinator, runId, reason) =>
      prepareRunQueuedTerminal(coordinator, state, runId, reason),
    capabilityRevocationsFor: (conversationId, assigned) =>
      capabilityRevocations(
        conversationId,
        state.revokedCapabilities,
        state,
        assigned,
      ),
    proofBindsSource: (assigned, proof, conversationId, legacy) =>
      proofBindsConversationSource(
        state,
        state,
        assigned,
        proof,
        conversationId,
        legacy,
      ),
    listCancellableRuns: () =>
      cancellableRunDescriptors({
        state,
        queuedRunIds: listQueuedEntriesSnapshot(state).map(({ runId }) => runId),
        getAdmittedDescriptorMeta: (runId) => {
          const admitted = state.admittedByRun.get(runId);
          return admitted
            ? {
                source: admitted.record.invocation.source,
                ingressId: admitted.record.ingress.ingressId,
              }
            : undefined;
        },
      }),
    selectActive: (select) =>
      selectActiveAssignment(state, (assigned, current) =>
        select(freezeAssignedFact(assigned), current),
      ),
  };
}

export function readGuardAssignmentControlFacts(
  guard: SubmissionGuardProjection,
): GuardAssignmentControlFacts {
  return {
    get activeRunId() {
      return guard.activeRunId;
    },
    getRunState: (runId) => {
      const entry = guard.stateByRun.get(runId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getAssignmentIdForRun: (runId) => guard.assignmentByRun.get(runId),
    getAssigned: (assignmentId) => {
      const entry = guard.assignedById.get(assignmentId);
      return entry ? freezeGuardAssignedFact(entry) : undefined;
    },
    isAssignmentClosed: (assignmentId) =>
      guard.closedAssignments.has(assignmentId),
    hasConflict: (assignmentId) => guard.conflictAssignments.has(assignmentId),
    hasOpenConflict: (assignmentId) =>
      guard.openConflictAssignments.has(assignmentId),
    getSupersedeRequest: (assignmentId) => {
      const entry = guard.supersedeRequests.get(assignmentId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    hasSupersedeStarted: (assignmentId) =>
      guard.supersedeStartedAssignments.has(assignmentId),
    getCancelFence: (assignmentId) => {
      const entry = guard.cancelFences.get(assignmentId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    hasAcceptedCancellation: (assignmentId) =>
      guard.acceptedCancellations.has(assignmentId),
    hasDurableStarted: (assignmentId) =>
      guard.durableStartedAssignments.has(assignmentId),
    getResolution: (runId) => {
      const entry = guard.resolutionsByRun.get(runId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    isCapabilityRevoked: (assignmentId, capId) =>
      guard.revokedCapabilities.has(`${assignmentId}\0${capId}`),
  };
}

export function readChannelTicketFacts(state: RunProjection): ChannelTicketFacts {
  return {
    get ticketSyncFrontier() {
      return state.ticketSyncFrontier;
    },
    get channelInteractions() {
      return state.channelInteractions;
    },
    getTicket: (ticketId) => {
      const entry = state.ticketsById.get(ticketId);
      return entry ? freezeTicketFact(entry) : undefined;
    },
    hasTicket: (ticketId) => state.ticketsById.has(ticketId),
    listTickets: () => [...state.ticketsById.values()].map(freezeTicketFact),
    ticketsIterable: () => ({
      *[Symbol.iterator]() {
        for (const entry of state.ticketsById.values()) {
          yield freezeTicketFact(entry);
        }
      },
    }),
    getTicketIdsForAssignment: (assignmentId) =>
      new Set(state.ticketIdsByAssignment.get(assignmentId) ?? []),
    getTicketReplacement: (ticketId) => state.ticketReplacementsById.get(ticketId),
    isTicketRevoked: (ticketId) => state.revokedTickets.has(ticketId),
    listUnrevokedTicketIds: (assignmentId) =>
      [...(state.ticketIdsByAssignment.get(assignmentId) ?? [])].filter(
        (ticketId) => !state.revokedTickets.has(ticketId),
      ),
  };
}

export function readGuardChannelTicketFacts(
  guard: SubmissionGuardProjection,
): GuardChannelTicketFacts {
  return {
    get ticketSyncFrontier() {
      return guard.ticketSyncFrontier;
    },
    getTicket: (ticketId) => {
      const entry = guard.ticketsById.get(ticketId);
      return entry ? freezeTicketFact(entry) : undefined;
    },
    isTicketRevoked: (ticketId) => guard.revokedTickets.has(ticketId),
    getTicketReplacement: (ticketId) => guard.ticketReplacementsById.get(ticketId),
    getTicketIdsForAssignment: (assignmentId) =>
      new Set(guard.ticketIdsByAssignment.get(assignmentId) ?? []),
  };
}

export function readCommitPublishFacts(
  state: RunProjection,
): CommitPublishFacts {
  return {
    get latestCommit() {
      const entry = state.commits.at(-1);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    commitsAfter: (afterCommitRevision) => {
      const start = firstCommitIndexAfter(state.commits, afterCommitRevision);
      return state.commits
        .slice(start)
        .map(
          (entry) => Object.freeze({ ...entry }) as DeepReadonly<typeof entry>,
        );
    },
    findCommittedByRunId: (runId) => {
      const entry = state.commits.find((candidate) => candidate.runId === runId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    findAllowOnceInteractionOutcome: (requestId) => {
      for (const batch of state.mirrorBatches.values()) {
        for (const entry of batch.batch.entries) {
          if (entry.kind !== "allow-once" || entry.requestId !== requestId) {
            continue;
          }
          return entry.outcome.t === "answered"
            ? {
                t: "answered" as const,
                decisionDigest: entry.outcome.decisionDigest,
              }
            : { t: "closed" as const };
        }
      }
      return undefined;
    },
    getMirrorState: (assignmentId) => {
      const mirror = state.mirrorStateByAssignment.get(assignmentId);
      if (!mirror) return undefined;
      return Object.freeze({
        ordinal: mirror.ordinal,
        mirrorDigest: mirror.mirrorDigest,
        mirroredUpTo: mirror.mirroredUpTo,
        requestIds: Object.freeze({
          has: (requestId: string) => mirror.requestIds.has(requestId),
        }),
      });
    },
    getMirrorBatch: (batchDigest) => {
      const entry = state.mirrorBatches.get(batchDigest);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasMirrorBatch: (batchDigest) => state.mirrorBatches.has(batchDigest),
    listMirrorBatches: () =>
      [...state.mirrorBatches.values()].map(
        (entry) => Object.freeze({ ...entry }) as DeepReadonly<typeof entry>,
      ),
    getCommitted: (assignmentId) => {
      const entry = state.committedByAssignment.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasCommitted: (assignmentId) => state.committedByAssignment.has(assignmentId),
    getBundleAcknowledgement: (assignmentId) => {
      const entry = state.bundleAcknowledgements.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasBundleAcknowledgement: (assignmentId) =>
      state.bundleAcknowledgements.has(assignmentId),
    listBundleAcknowledgementOutbox: () => [
      ...state.bundleAcknowledgementOutbox,
    ],
    getAssignmentByCommitRevision: (commitRevision) =>
      state.assignmentByCommitRevision.get(commitRevision),
    getContentByRevision: (commitRevision) => {
      const entries = state.contentByRevision.get(commitRevision);
      return entries ? [...entries] : undefined;
    },
    hasProjectedCommit: (assignmentId) =>
      state.projectedByAssignment.has(assignmentId),
    listPendingCommitProjections: () =>
      [...state.pendingCommitProjections.values()].map(
        (entry) => Object.freeze({ ...entry }) as DeepReadonly<typeof entry>,
      ),
  };
}

export function readGuardCommitPublishFacts(
  guard: SubmissionGuardProjection,
): GuardCommitPublishFacts {
  return {
    getCommitted: (assignmentId) => {
      const entry = guard.committedByAssignment.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    hasBundleAcknowledgement: (assignmentId) =>
      guard.bundleAcknowledgements.has(assignmentId),
  };
}

export function readPublishFacts(state: PublishProjection): PublishFacts {
  return {
    getDecision: (assignmentId) => {
      const entry = state.decisions.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<typeof entry>)
        : undefined;
    },
    getBatch: (assignmentId) => {
      const entry = state.batches.get(assignmentId);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<MutationBatch>)
        : undefined;
    },
    getCommitRevision: (assignmentId) => state.commitRevisions.get(assignmentId),
    getProgress: (assignmentId, domain) => {
      const entry = state.progress.get(`${assignmentId}\0${domain}`);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getDomainPlan: (assignmentId, domain) => {
      const entry = state.domainPlans.get(`${assignmentId}\0${domain}`);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<PublishDomainPlan>)
        : undefined;
    },
    getPendingAssignmentsForConversation: (conversationId) => [
      ...(state.pendingAssignmentsByConversation.get(conversationId) ?? []),
    ],
    isCompleted: (assignmentId) => state.completedAssignments.has(assignmentId),
    getConflicts: (assignmentId) => {
      const entries = state.conflictsByAssignment.get(assignmentId);
      return entries ? [...entries] : undefined;
    },
  };
}

export function readFinalOutboxFacts(
  projection: FinalOutboxProjection,
): FinalOutboxFacts {
  return {
    getEntry: (key) => {
      const entry = projection.entries.get(key);
      return entry
        ? (Object.freeze({ ...entry }) as DeepReadonly<FinalOutboxProjectionEntry>)
        : undefined;
    },
    getActiveKeyForRevision: (conversationId, commitRevision) =>
      projection.activeKeyByConversationRevision.get(
        `${conversationId}\0${commitRevision}`,
      ),
    listPendingForConversation: (conversationId) =>
      [...(projection.pendingByConversation.get(conversationId)?.values() ?? [])].map(
        (entry) =>
          Object.freeze({ ...entry }) as DeepReadonly<FinalOutboxProjectionEntry>,
      ),
    listPublishedForConversation: (conversationId) =>
      [
        ...(projection.publishedByConversation.get(conversationId)?.values() ??
          []),
      ].map(
        (entry) =>
          Object.freeze({ ...entry }) as DeepReadonly<FinalOutboxProjectionEntry>,
      ),
  };
}

export function readConversationDecisionFacts(
  state: RunProjection,
): ConversationDecisionFacts {
  return {
    session: readSessionDomainFacts(state),
    queueInput: readRunQueueInputFacts(state),
    assignment: readAssignmentControlFacts(state),
    tickets: readChannelTicketFacts(state),
    commitPublish: readCommitPublishFacts(state),
  };
}

export function readConversationGuardDecisionFacts(
  guard: SubmissionGuardProjection,
): ConversationGuardDecisionFacts {
  return {
    queueInput: readGuardQueueInputFacts(guard),
    assignment: readGuardAssignmentControlFacts(guard),
    tickets: readGuardChannelTicketFacts(guard),
    commitPublish: readGuardCommitPublishFacts(guard),
  };
}
