import type {
  ArtifactRef,
  AssignmentTerminationProof,
  CancelProofBody,
  DataPlaneTicket,
  GovernorRecord,
  IngressContext,
  InteractionAnswerMirrorEntry,
  JobOccurrence,
  LogicalRecord,
  SupersedeProof,
  SystemJobFence,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import type { ProtocolSigner } from "@zhixing-ai/core/protocol";
import type {
  ScheduleCapabilityGapState,
  ScheduleOccurrence,
} from "@zhixing-ai/core/scheduler/application";
import type { ConversationAbortTicketAuthorizer } from "../../conversation-journal/contracts.js";
import {
  failuresBefore,
  latestFailures,
} from "../../job-failure-summary.js";
import {
  corruptJobJournal,
  NOT_STARTED_PROOF_KINDS,
  notStartedRejectionKey,
  type JobJournalRecord,
  type MaterializedSystemJobResult,
  type NotStartedProofKind,
} from "../../job-run-contracts.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import type {
  AssignedJob,
  JobBundle,
  JobChannelInteractions,
  JobProjection,
  JobResolutionFact,
  JobStateEntry,
  JobStatusHistoryEntry,
  JobSubmissionGuardProjection,
  PendingJobDispatch,
  SystemJobResourceCoordinator,
} from "../contracts.js";
import {
  allJobCapabilitiesRevoked,
  byAssignmentCommit,
  capabilityRevocations,
  dataPlaneTicketRevocations,
  materializeDispatch,
  proofBindsJobSource,
} from "./assignment-control.js";
import {
  jobGrantPending,
  jobMirrorClosed,
  ticketsBetween,
} from "./channel-tickets-mirror.js";
import { revokedCapabilityKey, snapshot, type DeepReadonly } from "./common.js";
import {
  byOccurrenceOrder,
  latestOccurrence,
  nextJobAssignmentAttempt,
  prepareJobQueuedTerminal,
  scheduleOccurrenceOf,
  walkOccurrencesBackward,
} from "./task-schedule.js";

export type { DeepReadonly };

export interface JobTaskScheduleFacts {
  readonly definition?: DeepReadonly<TaskDefinition>;
  readonly legacyNextFire?: DeepReadonly<
    Extract<JobJournalRecord, { t: "legacy-next-fire" }>
  >;
  readonly pendingSystemMissedJobRunId?: string;
  readonly runCount: number;
  getDefinitionRevision(
    taskRevision: number,
  ): DeepReadonly<TaskDefinition> | undefined;
  requireDefinition(): DeepReadonly<TaskDefinition>;
  requireDefinitionRevision(taskRevision: number): DeepReadonly<TaskDefinition>;
  getTaskOperation(
    operationId: string,
  ): { readonly digest: string; readonly taskRevision: number } | undefined;
  getMissedNextFire(
    jobRunId: string,
  ): DeepReadonly<Extract<JobJournalRecord, { t: "missed-next-fire" }>> | undefined;
  getFailurePolicy(
    jobRunId: string,
  ): DeepReadonly<Extract<JobJournalRecord, { t: "failure-policy" }>> | undefined;
  hasAutoDisableSettled(jobRunId: string): boolean;
  hasPendingAutoDisable(): boolean;
  listPendingAutoDisableRunIds(): readonly string[];
  listPendingAutoDisableRunIdsOrdered(): readonly string[];
  getCapabilityGap(
    jobRunId: string,
  ): DeepReadonly<ScheduleCapabilityGapState> | undefined;
  getSystemMissAlias(
    jobRunId: string,
  ): { readonly scheduledFor: string; readonly coalescedJobRunId: string } | undefined;
  latestFailureCount(): number;
  failuresBeforeOccurrence(occurrence: JobOccurrence): number;
  getOccurrence(jobRunId: string): DeepReadonly<JobOccurrence> | undefined;
  getScheduleOccurrence(jobRunId: string): ScheduleOccurrence | undefined;
  getLatestScheduleOccurrence(): ScheduleOccurrence | undefined;
  projectScheduleOccurrence(occurrence: JobOccurrence): ScheduleOccurrence;
  walkOccurrencesBackward(
    before: Pick<JobOccurrence, "jobRunId" | "scheduledFor"> | undefined,
    accept: (occurrence: JobOccurrence) => boolean,
  ): void;
  listOpenRunIdsOrdered(): readonly string[];
  listPendingMissedRunIdsOrdered(): readonly string[];
  hasAdmitted(jobRunId: string): boolean;
  getIngress(jobRunId: string): DeepReadonly<IngressContext> | undefined;
  getOutcome(
    jobRunId: string,
  ): DeepReadonly<JobBundle["body"]["outcome"]> | undefined;
  getSystemFence(jobRunId: string): DeepReadonly<SystemJobFence> | undefined;
  getSystemResult(
    jobRunId: string,
  ): DeepReadonly<MaterializedSystemJobResult> | undefined;
  nextAssignmentAttempt(jobRunId: string): number;
  prepareQueuedTerminalRecords(
    coordinator:
      | AssignmentResourceCoordinator
      | SystemJobResourceCoordinator
      | undefined,
    jobRunId: string,
    reason: "cancelled" | "failed" | "expired",
  ): readonly LogicalRecord<GovernorRecord>[];
}

export interface JobAssignmentControlFacts {
  readonly activeJobRunId?: string;
  getRunState(jobRunId: string): JobStateEntry | undefined;
  getStatusHistory(
    jobRunId: string,
  ): readonly DeepReadonly<JobStatusHistoryEntry>[] | undefined;
  getAssignmentIdForJob(jobRunId: string): string | undefined;
  getAssigned(assignmentId: string): DeepReadonly<AssignedJob> | undefined;
  requireReplayAssignment(assignmentId: string): DeepReadonly<AssignedJob>;
  requireCurrentAssignment(assignmentId: string): DeepReadonly<AssignedJob>;
  listOpenAssignmentIdsByCommit(): readonly string[];
  listRecoveryAssignmentIdsByCommit(): readonly string[];
  listRecoveryAndAckOutboxAssignmentIdsByCommit(): readonly string[];
  orderAssignmentIdsByCommit(assignmentIds: readonly string[]): readonly string[];
  hasRecoveryAssignment(assignmentId: string): boolean;
  getConflict(
    assignmentId: string,
  ): DeepReadonly<Extract<JobJournalRecord, { t: "dispatch-conflict" }>> | undefined;
  hasContainedFact(openFactDigest: string): boolean;
  getContainment(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<
          JobJournalRecord,
          { t: "dispatch-conflict-contained" | "cancel-contained" }
        >
      >
    | undefined;
  getSuperseded(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<JobJournalRecord, { t: "assignment-superseded" }>>
    | undefined;
  getSupersedeRequest(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<JobJournalRecord, { t: "supersede-requested" }>>
    | undefined;
  getSupersedeStarted(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<JobJournalRecord, { t: "supersede-started-observed" }>
      >
    | undefined;
  getCancelFence(
    assignmentId: string,
  ): DeepReadonly<Extract<JobJournalRecord, { t: "cancel-fence" }>> | undefined;
  getAcceptedCancellation(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<JobJournalRecord, { t: "cancel-proof-accepted" }>>
    | undefined;
  getRejectedNotStarted(
    assignmentId: string,
    kind: NotStartedProofKind,
  ):
    | DeepReadonly<Extract<JobJournalRecord, { t: "not-started-rejected" }>>
    | undefined;
  listPresentStoppedProofKinds(
    assignmentId: string,
  ): readonly NotStartedProofKind[];
  hasDurableStarted(assignmentId: string): boolean;
  isCapabilityRevoked(assignmentId: string, capId: string): boolean;
  getResolution(jobRunId: string): DeepReadonly<JobResolutionFact> | undefined;
  proofBindsSource(
    assigned: {
      readonly record: {
        readonly assignmentId: string;
        readonly executorId: string;
        readonly taskId: string;
        readonly dispatchDigest: string;
      };
    },
    proof: AssignmentTerminationProof | CancelProofBody | SupersedeProof,
    anchorEpoch: number,
    legacy: ConversationAbortTicketAuthorizer | undefined,
  ): boolean;
  capabilityRevocationsFor(
    taskId: string,
    assigned: {
      readonly record: {
        readonly assignmentId: string;
        readonly capIds: readonly string[];
      };
    },
  ): LogicalRecord<JobJournalRecord>[];
  dataPlaneTicketRevocationsFor(
    taskId: string,
    assignmentId: string,
  ): LogicalRecord<JobJournalRecord>[];
  allCapabilitiesRevoked(
    envelopeRecords: readonly JobJournalRecord[],
    assigned: {
      readonly record: {
        readonly assignmentId: string;
        readonly capIds: readonly string[];
      };
    },
  ): boolean;
  materializeDispatch(
    assigned: DeepReadonly<AssignedJob>,
    signer: ProtocolSigner,
  ): PendingJobDispatch;
}

export interface JobChannelTicketMirrorFacts {
  readonly nextJobRevision: number;
  readonly ticketSyncFrontier?: string;
  readonly channelInteractions: JobChannelInteractions;
  getTicket(ticketId: string): DeepReadonly<DataPlaneTicket> | undefined;
  hasTicket(ticketId: string): boolean;
  getTicketReplacement(ticketId: string): string | undefined;
  isTicketRevoked(ticketId: string): boolean;
  getTicketIdsForAssignment(assignmentId: string): ReadonlySet<string>;
  ticketsBetween(
    after: string | undefined,
    through: string | undefined,
  ): readonly { readonly sortKey: string; readonly ticket: DeepReadonly<DataPlaneTicket> }[];
  getInteractionMirror(
    assignmentId: string,
  ):
    | {
        readonly upTo: number;
        readonly ordinal: number;
        readonly digest: string;
        readonly requestIds: ReadonlySet<string>;
        readonly outcomes: ReadonlyMap<
          string,
          InteractionAnswerMirrorEntry["outcome"]
        >;
      }
    | undefined;
  hasInteractionMirrorBatch(batchKey: string): boolean;
  getSettlementFence(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
      >
    | undefined;
  getCompletedSettlement(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
      >
    | undefined;
  listPendingSettlementIdsByCommit(): readonly string[];
  listPendingSettlementIdsSorted(): readonly string[];
  isMirrorClosed(assignmentId: string): boolean;
  listOpenChallengeIds(): readonly string[];
  listPendingGrantChallengeIds(): readonly string[];
  isGrantPending(challengeId: string): boolean;
  getCommitted(
    assignmentId: string,
  ): DeepReadonly<Extract<JobJournalRecord, { t: "committed" }>> | undefined;
  getBundleAcknowledgement(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<JobJournalRecord, { t: "bundle-ack-observed" }>>
    | undefined;
  hasBundleAckOutbox(assignmentId: string): boolean;
  listBundleAckOutboxByCommit(): readonly string[];
}

export interface JobDecisionFacts {
  readonly task: JobTaskScheduleFacts;
  readonly assignment: JobAssignmentControlFacts;
  readonly channel: JobChannelTicketMirrorFacts;
}

export interface GuardAssignedJobFact {
  readonly record: DeepReadonly<Extract<JobJournalRecord, { t: "assigned" }>>;
  readonly commit: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
  readonly capIds: ReadonlySet<string>;
  readonly acked: boolean;
}

export interface JobGuardDecisionFacts {
  readonly latestDefinitionState: "enabled" | "disabled" | "deleted";
  readonly latestDefinitionRevision?: number;
  readonly activeJobRunId?: string;
  readonly pendingSystemMissedJobRunId?: string;
  readonly nextJobRevision: number;
  readonly ticketSyncFrontier?: string;
  getDefinitionKind(revision: number): "user" | "system" | undefined;
  getOccurrence(
    jobRunId: string,
  ):
    | {
        readonly scheduledFor: string;
        readonly taskRevision: number;
        readonly deliveryPlanDigest: string;
        readonly deliveryRequired: boolean;
      }
    | undefined;
  getRunState(jobRunId: string): JobStateEntry | undefined;
  getIngress(jobRunId: string): DeepReadonly<IngressContext> | undefined;
  getAssigned(assignmentId: string): GuardAssignedJobFact | undefined;
  getAssignmentIdForJob(jobRunId: string): string | undefined;
  hasConflict(assignmentId: string): boolean;
  hasOpenConflict(assignmentId: string): boolean;
  getSupersedeRequest(
    assignmentId: string,
  ):
    | DeepReadonly<Extract<JobJournalRecord, { t: "supersede-requested" }>>
    | undefined;
  hasSupersedeStarted(assignmentId: string): boolean;
  getCancelFence(
    assignmentId: string,
  ): DeepReadonly<Extract<JobJournalRecord, { t: "cancel-fence" }>> | undefined;
  getSettlementFence(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
      >
    | undefined;
  getCompletedSettlement(
    assignmentId: string,
  ):
    | DeepReadonly<
        Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
      >
    | undefined;
  hasAcceptedCancellation(assignmentId: string): boolean;
  hasDurableStarted(assignmentId: string): boolean;
  isAssignmentClosed(assignmentId: string): boolean;
  isCapabilityRevoked(assignmentId: string, capId: string): boolean;
  getInteractionMirror(
    assignmentId: string,
  ):
    | {
        readonly upTo: number;
        readonly ordinal: number;
        readonly digest: string;
        readonly requestIds: ReadonlySet<string>;
        readonly outcomes: ReadonlyMap<
          string,
          InteractionAnswerMirrorEntry["outcome"]
        >;
      }
    | undefined;
  hasInteractionMirrorBatch(batchKey: string): boolean;
  isMirrorClosed(assignmentId: string): boolean;
  getResolution(jobRunId: string): DeepReadonly<JobResolutionFact> | undefined;
  getCommitted(
    assignmentId: string,
  ): { readonly ref: Readonly<ArtifactRef>; readonly jobRevision: number } | undefined;
  hasBundleAcknowledgement(assignmentId: string): boolean;
  proofBindsSource(
    assigned: {
      readonly record: {
        readonly assignmentId: string;
        readonly executorId: string;
        readonly taskId: string;
        readonly dispatchDigest: string;
      };
    },
    proof: AssignmentTerminationProof | CancelProofBody | SupersedeProof,
    anchorEpoch: number,
    legacy: ConversationAbortTicketAuthorizer | undefined,
  ): boolean;
}

export function requireDefinition(state: JobProjection): TaskDefinition {
  if (!state.definition) {
    throw corruptJobJournal("Job journal has no task definition");
  }
  return state.definition;
}

export function requireDefinitionRevision(
  state: JobProjection,
  taskRevision: number,
): TaskDefinition {
  const definition = state.definitions.get(taskRevision);
  if (!definition) {
    throw corruptJobJournal(
      "Job occurrence names an unknown task definition revision",
    );
  }
  return definition;
}

export function requireReplayAssignment(
  state: JobProjection,
  assignmentId: string,
): AssignedJob {
  const assigned = state.assignedById.get(assignmentId);
  if (!assigned) {
    throw corruptJobJournal("Job record names an unknown assignment");
  }
  return assigned;
}

export function requireCurrentAssignment(
  state: JobProjection,
  assignmentId: string,
): AssignedJob {
  const assigned = requireReplayAssignment(state, assignmentId);
  if (state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId) {
    throw new Error("Job operation names a historical assignment");
  }
  return assigned;
}

function freezeAssigned(entry: AssignedJob): DeepReadonly<AssignedJob> {
  return Object.freeze({
    record: entry.record,
    envelope: entry.envelope,
    commit: Object.freeze({ ...entry.commit }),
    acked: entry.acked,
  }) as DeepReadonly<AssignedJob>;
}

function freezeJobTicket(entry: DataPlaneTicket): DeepReadonly<DataPlaneTicket> {
  return Object.freeze({
    ...entry,
    ref: Object.freeze({ ...entry.ref }),
    signature: Object.freeze({ ...entry.signature }),
  }) as DeepReadonly<DataPlaneTicket>;
}

export function readJobDecisionFacts(state: JobProjection): JobDecisionFacts {
  const task: JobTaskScheduleFacts = {
    get definition() {
      return state.definition as DeepReadonly<TaskDefinition> | undefined;
    },
    get legacyNextFire() {
      return state.legacyNextFire as
        | DeepReadonly<Extract<JobJournalRecord, { t: "legacy-next-fire" }>>
        | undefined;
    },
    get pendingSystemMissedJobRunId() {
      return state.pendingSystemMissedJobRunId;
    },
    get runCount() {
      return state.runCount;
    },
    getDefinitionRevision: (taskRevision) =>
      state.definitions.get(taskRevision) as
        | DeepReadonly<TaskDefinition>
        | undefined,
    requireDefinition: () =>
      requireDefinition(state) as DeepReadonly<TaskDefinition>,
    requireDefinitionRevision: (taskRevision) =>
      requireDefinitionRevision(state, taskRevision) as DeepReadonly<TaskDefinition>,
    getTaskOperation: (operationId) => {
      const entry = state.taskOperations.get(operationId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getMissedNextFire: (jobRunId) =>
      state.missedNextFireByRun.get(jobRunId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "missed-next-fire" }>>
        | undefined,
    getFailurePolicy: (jobRunId) =>
      state.failurePolicyByRun.get(jobRunId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "failure-policy" }>>
        | undefined,
    hasAutoDisableSettled: (jobRunId) =>
      state.autoDisableSettledRuns.has(jobRunId),
    hasPendingAutoDisable: () => state.pendingAutoDisable.values().length > 0,
    listPendingAutoDisableRunIds: () => state.pendingAutoDisable.values(),
    listPendingAutoDisableRunIdsOrdered: () =>
      byOccurrenceOrder(state, state.pendingAutoDisable.values()),
    getCapabilityGap: (jobRunId) => {
      const gap = state.capabilityGapByRun.get(jobRunId);
      return gap ? (Object.freeze({ ...gap }) as DeepReadonly<ScheduleCapabilityGapState>) : undefined;
    },
    getSystemMissAlias: (jobRunId) => {
      const alias = state.systemMissAliases.get(jobRunId);
      return alias ? Object.freeze({ ...alias }) : undefined;
    },
    latestFailureCount: () => latestFailures(state),
    failuresBeforeOccurrence: (occurrence) => failuresBefore(state, occurrence),
    getOccurrence: (jobRunId) =>
      state.occurrences.get(jobRunId) as DeepReadonly<JobOccurrence> | undefined,
    getScheduleOccurrence: (jobRunId) => {
      const occurrence = state.occurrences.get(jobRunId);
      return occurrence ? scheduleOccurrenceOf(state, occurrence) : undefined;
    },
    getLatestScheduleOccurrence: () => {
      const latest = latestOccurrence(state);
      return latest ? scheduleOccurrenceOf(state, latest) : undefined;
    },
    projectScheduleOccurrence: (occurrence) =>
      scheduleOccurrenceOf(state, occurrence),
    walkOccurrencesBackward: (before, accept) =>
      walkOccurrencesBackward(state, before, accept),
    listOpenRunIdsOrdered: () => byOccurrenceOrder(state, state.openRuns.values()),
    listPendingMissedRunIdsOrdered: () =>
      byOccurrenceOrder(state, state.pendingMissed.values()),
    hasAdmitted: (jobRunId) => state.admittedJobs.has(jobRunId),
    getIngress: (jobRunId) =>
      state.ingressByJob.get(jobRunId) as DeepReadonly<IngressContext> | undefined,
    getOutcome: (jobRunId) =>
      state.outcomeByRun.get(jobRunId) as
        | DeepReadonly<JobBundle["body"]["outcome"]>
        | undefined,
    getSystemFence: (jobRunId) =>
      state.systemFences.get(jobRunId) as DeepReadonly<SystemJobFence> | undefined,
    getSystemResult: (jobRunId) =>
      state.systemResults.get(jobRunId) as
        | DeepReadonly<MaterializedSystemJobResult>
        | undefined,
    nextAssignmentAttempt: (jobRunId) => nextJobAssignmentAttempt(state, jobRunId),
    prepareQueuedTerminalRecords: (coordinator, jobRunId, reason) =>
      prepareJobQueuedTerminal(coordinator, state, jobRunId, reason),
  };

  const assignment: JobAssignmentControlFacts = {
    get activeJobRunId() {
      return state.activeJobRunId;
    },
    getRunState: (jobRunId) => {
      const entry = state.states.get(jobRunId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getStatusHistory: (jobRunId) => {
      const history = state.statusHistoryByRun.get(jobRunId);
      return history ? snapshot(history) : undefined;
    },
    getAssignmentIdForJob: (jobRunId) => state.assignmentByJob.get(jobRunId),
    getAssigned: (assignmentId) => {
      const entry = state.assignedById.get(assignmentId);
      return entry ? freezeAssigned(entry) : undefined;
    },
    requireReplayAssignment: (assignmentId) =>
      freezeAssigned(requireReplayAssignment(state, assignmentId)),
    requireCurrentAssignment: (assignmentId) =>
      freezeAssigned(requireCurrentAssignment(state, assignmentId)),
    listOpenAssignmentIdsByCommit: () =>
      byAssignmentCommit(state, state.openAssignments.values()),
    listRecoveryAssignmentIdsByCommit: () =>
      byAssignmentCommit(state, state.recoveryAssignments.values()),
    listRecoveryAndAckOutboxAssignmentIdsByCommit: () =>
      byAssignmentCommit(state, [
        ...new Set([
          ...state.recoveryAssignments.values(),
          ...state.bundleAcknowledgementOutbox.values(),
        ]),
      ]),
    orderAssignmentIdsByCommit: (assignmentIds) =>
      byAssignmentCommit(state, assignmentIds),
    hasRecoveryAssignment: (assignmentId) =>
      state.recoveryAssignments.has(assignmentId),
    getConflict: (assignmentId) =>
      state.conflicts.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "dispatch-conflict" }>>
        | undefined,
    hasContainedFact: (openFactDigest) =>
      state.containedFacts.has(openFactDigest),
    getContainment: (assignmentId) =>
      state.containments.get(assignmentId) as
        | DeepReadonly<
            Extract<
              JobJournalRecord,
              { t: "dispatch-conflict-contained" | "cancel-contained" }
            >
          >
        | undefined,
    getSuperseded: (assignmentId) =>
      state.superseded.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "assignment-superseded" }>>
        | undefined,
    getSupersedeRequest: (assignmentId) =>
      state.supersedeRequests.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "supersede-requested" }>>
        | undefined,
    getSupersedeStarted: (assignmentId) =>
      state.supersedeStarted.get(assignmentId) as
        | DeepReadonly<
            Extract<JobJournalRecord, { t: "supersede-started-observed" }>
          >
        | undefined,
    getCancelFence: (assignmentId) =>
      state.cancelFences.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "cancel-fence" }>>
        | undefined,
    getAcceptedCancellation: (assignmentId) =>
      state.acceptedCancellations.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "cancel-proof-accepted" }>>
        | undefined,
    getRejectedNotStarted: (assignmentId, kind) =>
      state.rejectedNotStarted.get(
        notStartedRejectionKey(assignmentId, kind),
      ) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "not-started-rejected" }>>
        | undefined,
    listPresentStoppedProofKinds: (assignmentId) =>
      NOT_STARTED_PROOF_KINDS.filter((kind) =>
        state.rejectedNotStarted.has(notStartedRejectionKey(assignmentId, kind)),
      ),
    hasDurableStarted: (assignmentId) => state.durableStarted.has(assignmentId),
    isCapabilityRevoked: (assignmentId, capId) =>
      state.revokedCapabilities.has(revokedCapabilityKey(assignmentId, capId)),
    getResolution: (jobRunId) =>
      state.resolutions.get(jobRunId) as
        | DeepReadonly<JobResolutionFact>
        | undefined,
    proofBindsSource: (assigned, proof, anchorEpoch, legacy) =>
      proofBindsJobSource(state, assigned, proof, anchorEpoch, legacy),
    capabilityRevocationsFor: (taskId, assigned) =>
      capabilityRevocations(taskId, state, assigned),
    dataPlaneTicketRevocationsFor: (taskId, assignmentId) =>
      dataPlaneTicketRevocations(taskId, state, assignmentId),
    allCapabilitiesRevoked: (envelopeRecords, assigned) =>
      allJobCapabilitiesRevoked(envelopeRecords, state, assigned),
    materializeDispatch: (assigned, signer) =>
      materializeDispatch(assigned as unknown as AssignedJob, signer),
  };

  const channel: JobChannelTicketMirrorFacts = {
    get nextJobRevision() {
      return state.nextJobRevision;
    },
    get ticketSyncFrontier() {
      return state.ticketSyncFrontier;
    },
    get channelInteractions() {
      return state.channelInteractions;
    },
    getTicket: (ticketId) => {
      const entry = state.ticketsById.get(ticketId);
      return entry ? freezeJobTicket(entry) : undefined;
    },
    hasTicket: (ticketId) => state.ticketsById.has(ticketId),
    getTicketReplacement: (ticketId) =>
      state.ticketReplacementsById.get(ticketId),
    isTicketRevoked: (ticketId) => state.revokedTickets.has(ticketId),
    getTicketIdsForAssignment: (assignmentId) =>
      new Set(state.ticketIdsByAssignment.get(assignmentId) ?? []),
    ticketsBetween: (after, through) =>
      ticketsBetween(state, after, through).map(({ sortKey, ticket }) =>
        Object.freeze({ sortKey, ticket: freezeJobTicket(ticket) }),
      ),
    getInteractionMirror: (assignmentId) =>
      state.interactionMirrors.get(assignmentId),
    hasInteractionMirrorBatch: (batchKey) =>
      state.interactionMirrorBatches.has(batchKey),
    getSettlementFence: (assignmentId) =>
      state.interactionSettlementFences.get(assignmentId) as
        | DeepReadonly<
            Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
          >
        | undefined,
    getCompletedSettlement: (assignmentId) =>
      state.completedInteractionSettlements.get(assignmentId) as
        | DeepReadonly<
            Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
          >
        | undefined,
    listPendingSettlementIdsByCommit: () =>
      byAssignmentCommit(state, state.pendingSettlements.values()),
    listPendingSettlementIdsSorted: () =>
      state.pendingSettlements.values().sort(),
    isMirrorClosed: (assignmentId) => jobMirrorClosed(state, assignmentId, false),
    listOpenChallengeIds: () => state.openChallenges.values(),
    listPendingGrantChallengeIds: () => state.pendingGrants.values(),
    isGrantPending: (challengeId) => jobGrantPending(state, challengeId),
    getCommitted: (assignmentId) =>
      state.committed.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "committed" }>>
        | undefined,
    getBundleAcknowledgement: (assignmentId) =>
      state.bundleAcknowledgements.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "bundle-ack-observed" }>>
        | undefined,
    hasBundleAckOutbox: (assignmentId) =>
      state.bundleAcknowledgementOutbox.has(assignmentId),
    listBundleAckOutboxByCommit: () =>
      byAssignmentCommit(state, state.bundleAcknowledgementOutbox.values()),
  };

  return { task, assignment, channel };
}

export function readJobGuardDecisionFacts(
  guard: JobSubmissionGuardProjection,
): JobGuardDecisionFacts {
  return {
    get latestDefinitionState() {
      return guard.latestDefinitionState;
    },
    get latestDefinitionRevision() {
      return guard.latestDefinitionRevision;
    },
    get activeJobRunId() {
      return guard.activeJobRunId;
    },
    get pendingSystemMissedJobRunId() {
      return guard.pendingSystemMissedJobRunId;
    },
    get nextJobRevision() {
      return guard.nextJobRevision;
    },
    get ticketSyncFrontier() {
      return guard.ticketSyncFrontier;
    },
    getDefinitionKind: (revision) => guard.definitionKinds.get(revision),
    getOccurrence: (jobRunId) => {
      const occ = guard.occurrences.get(jobRunId);
      return occ ? Object.freeze({ ...occ }) : undefined;
    },
    getRunState: (jobRunId) => {
      const entry = guard.states.get(jobRunId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    getIngress: (jobRunId) =>
      guard.ingressByJob.get(jobRunId) as DeepReadonly<IngressContext> | undefined,
    getAssigned: (assignmentId) => {
      const entry = guard.assignedById.get(assignmentId);
      if (!entry) return undefined;
      return Object.freeze({
        record: entry.record as DeepReadonly<
          Extract<JobJournalRecord, { t: "assigned" }>
        >,
        commit: Object.freeze({ ...entry.commit }),
        capIds: entry.capIds,
        acked: entry.acked,
      });
    },
    getAssignmentIdForJob: (jobRunId) => guard.assignmentByJob.get(jobRunId),
    hasConflict: (assignmentId) => guard.conflictAssignments.has(assignmentId),
    hasOpenConflict: (assignmentId) =>
      guard.openConflictAssignments.has(assignmentId),
    getSupersedeRequest: (assignmentId) =>
      guard.supersedeRequests.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "supersede-requested" }>>
        | undefined,
    hasSupersedeStarted: (assignmentId) =>
      guard.supersedeStartedAssignments.has(assignmentId),
    getCancelFence: (assignmentId) =>
      guard.cancelFences.get(assignmentId) as
        | DeepReadonly<Extract<JobJournalRecord, { t: "cancel-fence" }>>
        | undefined,
    getSettlementFence: (assignmentId) =>
      guard.interactionSettlementFences.get(assignmentId) as
        | DeepReadonly<
            Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
          >
        | undefined,
    getCompletedSettlement: (assignmentId) =>
      guard.completedInteractionSettlements.get(assignmentId) as
        | DeepReadonly<
            Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
          >
        | undefined,
    hasAcceptedCancellation: (assignmentId) =>
      guard.acceptedCancellations.has(assignmentId),
    hasDurableStarted: (assignmentId) => guard.durableStarted.has(assignmentId),
    isAssignmentClosed: (assignmentId) =>
      guard.closedAssignments.has(assignmentId),
    isCapabilityRevoked: (assignmentId, capId) =>
      guard.revokedCapabilities.has(revokedCapabilityKey(assignmentId, capId)),
    getInteractionMirror: (assignmentId) =>
      guard.interactionMirrors.get(assignmentId),
    hasInteractionMirrorBatch: (batchKey) =>
      guard.interactionMirrorBatches.has(batchKey),
    isMirrorClosed: (assignmentId) =>
      jobMirrorClosed(
        guard,
        assignmentId,
        guard.closedAssignments.has(assignmentId),
      ),
    getResolution: (jobRunId) =>
      guard.resolutions.get(jobRunId) as
        | DeepReadonly<JobResolutionFact>
        | undefined,
    getCommitted: (assignmentId) => {
      const committed = guard.committedByAssignment.get(assignmentId);
      return committed
        ? Object.freeze({
            ref: Object.freeze({ ...committed.ref }),
            jobRevision: committed.jobRevision,
          })
        : undefined;
    },
    hasBundleAcknowledgement: (assignmentId) =>
      guard.bundleAcknowledgements.has(assignmentId),
    proofBindsSource: (assigned, proof, anchorEpoch, legacy) =>
      proofBindsJobSource(guard, assigned, proof, anchorEpoch, legacy),
  };
}
