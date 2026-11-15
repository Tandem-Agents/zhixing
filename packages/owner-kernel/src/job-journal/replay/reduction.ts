import { Buffer } from "node:buffer";
import {
  AuthorityPreparationRequired,
  resolveDispatchArtifactClosure,
  type ArtifactStore,
  type AuthorityCommitLog,
  type RebuildableDurableProjectionIndex,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  CommitEnvelope,
  IngressContext,
  InteractionAnswerMirrorEntry,
  JobRunState,
  LogicalRecord,
  SealedBundle,
  SystemJobFence,
} from "@zhixing-ai/core/contracts";
import { SCHEDULER_USER_NOTICE_STREAM } from "@zhixing-ai/core/delivery";
import {
  assertQueuedTerminalDequeue,
  canonicalize,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  interactionMirrorBatchDigest,
  interactionMirrorSeed,
  permissionSnapshotLeaseDigest,
  requiresFormalResourceCoordination,
  rethrowUnloadedProtocolIdentity,
  validateAssignmentInteractionMirrorBatch,
  validateJobEnvelope,
  validateJobSealedBundle,
  validateTaskDefinition,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import { applyChannelInteractionRecord } from "../../channel-interaction-records.js";
import type { ConversationAbortTicketAuthorizer } from "../../conversation-journal/contracts.js";
import {
  assertAssignmentReplayContract,
  assertAssignmentSupersededReplayContract,
  assertCancelProofAcceptedReplayContract,
  assertCapabilityRevocationReplayContract,
  assertCommittedReplayContract,
  assertDispatchAcknowledgementReplayContract,
  assertDispatchConflictHandlingReplayContract,
  assertDispatchConflictReplayContract,
  assertResolutionCloseAtomicReplayContract,
  assertResolutionClosureReplayContract,
  assertResolutionOpenReplayContract,
  assertStateAtomicReplayContract,
  assertSupersedeRequestReplayContract,
  assertSupersedeStartedObservationReplayContract,
  assignmentTerminationProofKind,
  bundleAcknowledgementBindsCommitted,
  isOpenResolutionFact,
  jobUncertainClosure,
  projectUncertainStatusTransition,
  resolutionTargetState,
  validateResolutionFact,
} from "../../conversation-run-contracts.js";
import type { JobDeliveryParticipant } from "../../delivery-participant.js";
import {
  assertJobAdmissionReplayContract,
  assertJobCancelFenceReplayContract,
  assertJobConflictContainmentReplayContract,
  assertJobInteractionSettlementCompletionReplayContract,
  assertJobInteractionSettlementFenceReplayContract,
  assertJobMirrorReplayContract,
  assertJobOccurrenceReplayContract,
  assertJobResolutionBinding,
  assertJobStateReplayContract,
  assertSystemJobActivationReplayContract,
  assertSystemJobDefinitionReplayContract,
  assertSystemJobTerminalReplayContract,
  assertSystemMissCoalescedReplayContract,
  assertTaskRevisionReplayContract,
  corruptJobJournal,
  notStartedRejectionKey,
  registerPendingSystemMiss,
  taskCreationProvenanceMatches,
  validateJobJournalRecord,
  validateSystemJobResultDetail,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import { registerJobRunStateProjection } from "../../job-run-state-index.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import { batchRepeatsDurableRequestId } from "../../shared-protocol/interaction-mirror-preparation.js";
import {
  occurrenceOrderKey,
  type JobChannelInteractions,
  type JobEnvelope,
  type JobProjection,
  type JobReductionOptions,
  type JobResolutionFact,
  type JobStateEntry,
  type JobSubmissionGuardProjection,
  type SystemJobResourceCoordinator,
} from "../contracts.js";
import {
  allJobCapabilitiesRevoked,
  assertExecutionFailureAcceptanceReplay,
  assignedActivationDigest,
  envelopeHasManualJobRunApplied,
  envelopeHasSuccessfulJobUncertainControl,
  notStartedTargetState,
  proofBindsJobSource,
  recordsAcceptExecutionFailure,
  recordsCloseJobAssignment,
  recordsHaveJobState,
  taskRevisionAtomicFacts,
  terminationProofKind,
  type JobCapabilityRevocationSlice,
  type JobSourceProofBindingSlice,
} from "../state/assignment-control.js";
import {
  applyJobTicketRecord,
  applyJobTicketSyncFrontier,
  type JobTicketMutableStateSlice,
} from "../state/channel-tickets-mirror.js";
import {
  assertNever,
  isTerminal,
  jobStream,
  loadJobStored,
  revokedCapabilityKey,
  sameTerminationProofIdentity,
  snapshot,
} from "../state/common.js";
import {
  refreshFailureSummary,
  refreshJobDirectories,
} from "../state/directories-failure-summary.js";
import {
  assertDispatchMatchesOccurrence,
  assertForeignRecords,
  deliveryPlan,
  nextJobAssignmentAttempt,
  type JobAttemptStateSlice,
} from "../state/task-schedule.js";
import {
  requireDefinitionRevision,
  requireReplayAssignment,
} from "../state/views.js";
import {
  jobBundleBindsAssignedOccurrence,
  jobStatusDeliveryInputs,
  validateJobBundleClosure,
} from "./bundle-closure.js";

type MainOnlyJobJournalRecord = Extract<
  JobJournalRecord,
  {
    t:
      | "legacy-next-fire"
      | "missed-next-fire"
      | "failure-policy"
      | "auto-disable-settled"
      | "capability-gap-opened"
      | "capability-gap-updated"
      | "capability-gap-closed"
      | "dispatch-conflict-contained"
      | "cancel-contained"
      | "not-started-rejected";
  }
>;

interface SharedAssignedTargetEntry {
  readonly record: Extract<JobJournalRecord, { t: "assigned" }>;
  readonly commit: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
  acked: boolean;
  hasCapId(capId: string): boolean;
}

interface SharedOccurrenceTargetSummary {
  readonly scheduledFor: string;
  readonly taskRevision: number;
  readonly deliveryPlanDigest: string;
  readonly stateIfMain?: JobJournalRecord extends never ? never : string;
}

interface JobReductionTarget {
  readonly kind: "main" | "guard";
  activeJobRunId: string | undefined;
  pendingSystemMissedJobRunId: string | undefined;
  nextJobRevision: number;
  readonly taskOperations: {
    has(operationId: string): boolean;
    set(
      operationId: string,
      value: { readonly digest: string; readonly taskRevision: number },
    ): void;
  };
  readonly states: {
    get(jobRunId: string): JobStateEntry | undefined;
    has(jobRunId: string): boolean;
    set(jobRunId: string, value: JobStateEntry): void;
  };
  readonly admittedJobs: {
    has(jobRunId: string): boolean;
    add(jobRunId: string): void;
  };
  readonly ingressByJob: {
    get(jobRunId: string): IngressContext | undefined;
    set(jobRunId: string, value: IngressContext): void;
  };
  readonly assignmentByJob: {
    get(jobRunId: string): string | undefined;
    has(jobRunId: string): boolean;
    set(jobRunId: string, assignmentId: string): void;
    delete(jobRunId: string): void;
  };
  readonly assignmentAttemptByRun: {
    get(jobRunId: string): number | undefined;
    set(jobRunId: string, attempt: number): void;
  };
  readonly supersedeRequests: {
    get(
      assignmentId: string,
    ): Extract<JobJournalRecord, { t: "supersede-requested" }> | undefined;
    has(assignmentId: string): boolean;
    set(
      assignmentId: string,
      value: Extract<JobJournalRecord, { t: "supersede-requested" }>,
    ): void;
  };
  readonly cancelFences: {
    get(
      assignmentId: string,
    ): Extract<JobJournalRecord, { t: "cancel-fence" }> | undefined;
    has(assignmentId: string): boolean;
    set(
      assignmentId: string,
      value: Extract<JobJournalRecord, { t: "cancel-fence" }>,
    ): void;
  };
  readonly interactionSettlementFences: {
    get(
      assignmentId: string,
    ):
      | Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
      | undefined;
    has(assignmentId: string): boolean;
    set(
      assignmentId: string,
      value: Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>,
    ): void;
  };
  readonly completedInteractionSettlements: {
    has(assignmentId: string): boolean;
    set(
      assignmentId: string,
      value: Extract<
        JobJournalRecord,
        { t: "interaction-settlement-completed" }
      >,
    ): void;
  };
  readonly durableStarted: {
    has(assignmentId: string): boolean;
    add(assignmentId: string): void;
  };
  readonly revokedCapabilities: {
    has(key: string): boolean;
    add(key: string): void;
  };
  readonly interactionMirrors: {
    get(assignmentId: string):
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
    set(
      assignmentId: string,
      value: {
        readonly upTo: number;
        readonly ordinal: number;
        readonly digest: string;
        readonly requestIds: ReadonlySet<string>;
        readonly outcomes: ReadonlyMap<
          string,
          InteractionAnswerMirrorEntry["outcome"]
        >;
      },
    ): void;
  };
  readonly interactionMirrorBatches: {
    has(batchKey: string): boolean;
    add(batchKey: string): void;
  };
  readonly resolutions: {
    get(jobRunId: string): JobResolutionFact | undefined;
    set(jobRunId: string, fact: JobResolutionFact): void;
  };
  readonly bundleAcknowledgements: {
    has(assignmentId: string): boolean;
    set(
      assignmentId: string,
      record: Extract<JobJournalRecord, { t: "bundle-ack-observed" }>,
    ): void;
  };
  readonly systemFences: {
    get(jobRunId: string): SystemJobFence | undefined;
    has(jobRunId: string): boolean;
    set(jobRunId: string, fence: SystemJobFence): void;
  };
  readonly channelInteractions: JobChannelInteractions;
  readonly ticketSlice: JobTicketMutableStateSlice;
  readonly sourceProofSlice: JobSourceProofBindingSlice;
  readonly revocationSlice: JobCapabilityRevocationSlice;
  readonly attemptSlice: JobAttemptStateSlice;

  // Semantic adapter hooks isolating main vs guard storage shape differences:
  applyTaskRevision(
    body: Extract<JobJournalRecord, { t: "task-revision" }>,
    envelope: CommitEnvelope<unknown>,
    envelopeRecords: readonly JobJournalRecord[],
  ): Promise<void>;
  getCurrentDefinitionMeta(): {
    readonly present: boolean;
    readonly state: "enabled" | "disabled" | "deleted" | undefined;
    readonly revision: number | undefined;
    readonly kindForRevision: (
      taskRevision: number,
    ) => "user" | "system" | undefined;
  };
  isRunIdentifierUnused(jobRunId: string): boolean;
  getOccurrenceSummary(
    jobRunId: string,
  ): SharedOccurrenceTargetSummary | undefined;
  getCoalescedOccurrenceState(
    coalescedJobRunId: string,
  ): JobRunState | undefined;
  getAdmittedOccurrenceState(jobRunId: string): JobRunState | undefined;
  applyOccurrence(
    body: Extract<JobJournalRecord, { t: "occurrence" }>,
    definitionKind: "user" | "system" | undefined,
    envelope: CommitEnvelope<unknown>,
  ): void;
  applySystemMissAlias(
    body: Extract<JobJournalRecord, { t: "system-miss-coalesced" }>,
  ): void;
  getAssigned(assignmentId: string): SharedAssignedTargetEntry | undefined;
  hasAssigned(assignmentId: string): boolean;
  applyAssigned(
    body: Extract<JobJournalRecord, { t: "assigned" }>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<void>;
  isAssignmentClosedForFence(assignmentId: string): boolean;
  hasConflictSeen(assignmentId: string): boolean;
  recordConflict(
    body: Extract<JobJournalRecord, { t: "dispatch-conflict" }>,
  ): void;
  recordSupersede(
    assigned: SharedAssignedTargetEntry,
    body: Extract<JobJournalRecord, { t: "assignment-superseded" }>,
  ): void;
  hasSupersedeStarted(assignmentId: string): boolean;
  recordSupersedeStarted(
    body: Extract<JobJournalRecord, { t: "supersede-started-observed" }>,
  ): void;
  hasAcceptedCancellation(assignmentId: string): boolean;
  recordAcceptedCancellation(
    body: Extract<JobJournalRecord, { t: "cancel-proof-accepted" }>,
  ): void;
  assertExecutionFailureAccepted(
    body: Extract<JobJournalRecord, { t: "execution-failure-accepted" }>,
    envelopeRecords: readonly JobJournalRecord[],
  ): void;
  isTicketAssignmentClosed(assignmentId: string): boolean;
  validateChannelChallengeSource(
    assigned: SharedAssignedTargetEntry | undefined,
    body: Extract<JobJournalRecord, { t: "channel-challenge-prepared" }>,
  ): void;
  validateRelayCursorBinding(
    assigned: SharedAssignedTargetEntry | undefined,
    body: Extract<JobJournalRecord, { t: "channel-relay-cursor" }>,
  ): void;
  onResolutionRecorded(jobFact: JobResolutionFact): void;
  hasCommitted(assignmentId: string): boolean;
  applyCommitted(
    assigned: SharedAssignedTargetEntry,
    body: Extract<JobJournalRecord, { t: "committed" }>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<void>;
  getCommittedAckExpected(
    assignmentId: string,
  ): { readonly ref: ArtifactRef; readonly jobRevision: number } | undefined;
  onBundleAckObserved(assignmentId: string): void;
  validateSystemStartedDefinition(
    taskRevision: number,
    fence: SystemJobFence,
  ): void;
  hasSystemResult(jobRunId: string): boolean;
  loadSystemResultDetail(
    body: Extract<JobJournalRecord, { t: "system-result" }>,
  ): Promise<ReturnType<typeof validateSystemJobResultDetail> | undefined>;
  recordSystemResult(
    body: Extract<JobJournalRecord, { t: "system-result" }>,
    detail: ReturnType<typeof validateSystemJobResultDetail> | undefined,
  ): void;
  validateStateDeliveryAndClosure(
    body: Extract<JobJournalRecord, { t: "state" }>,
    previous: JobStateEntry,
    occurrence: SharedOccurrenceTargetSummary,
    envelope: CommitEnvelope<unknown>,
    envelopeRecords: readonly JobJournalRecord[],
  ): { readonly closedEarlierInEnvelope: boolean; readonly definitionKind: "user" | "system" | undefined };
  onStateRecorded(
    body: Extract<JobJournalRecord, { t: "state" }>,
    previous: JobStateEntry,
    envelope: CommitEnvelope<unknown>,
    envelopeRecords: readonly JobJournalRecord[],
  ): void;
  applyMainOnlyRecord(
    body: MainOnlyJobJournalRecord,
    envelope: CommitEnvelope<unknown>,
    envelopeRecords: readonly JobJournalRecord[],
  ): void;
}

export class JobReduction {
  readonly #taskId: string;
  readonly #anchorEpoch: number;
  readonly #artifacts: ArtifactStore;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly #delivery: JobDeliveryParticipant;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #systemResources: SystemJobResourceCoordinator | undefined;
  readonly #localExecutorId: string | undefined;

  constructor(options: JobReductionOptions) {
    this.#taskId = options.taskId;
    this.#anchorEpoch = options.anchorEpoch;
    this.#artifacts = options.artifacts;
    this.#verifier = options.verifier;
    this.#legacyAbortTickets = options.legacyAbortTickets;
    this.#delivery = options.delivery;
    this.#resources = options.resources;
    this.#systemResources = options.systemResources;
    this.#localExecutorId = options.localExecutorId;
  }

  get taskId(): string {
    return this.#taskId;
  }

  forTask(taskId: string): JobReduction {
    return new JobReduction({
      taskId,
      anchorEpoch: this.#anchorEpoch,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      delivery: this.#delivery,
      ...(this.#legacyAbortTickets
        ? { legacyAbortTickets: this.#legacyAbortTickets }
        : {}),
      ...(this.#resources ? { resources: this.#resources } : {}),
      ...(this.#systemResources
        ? { systemResources: this.#systemResources }
        : {}),
      ...(this.#localExecutorId
        ? { localExecutorId: this.#localExecutorId }
        : {}),
    });
  }

  readonly reduce = async (
    state: JobProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobProjection> => {
    if (raw.stream !== jobStream(this.#taskId)) {
      return state;
    }
    await this.#reduceSharedRecord(
      this.#createMainTarget(state),
      raw,
      envelope,
    );
    refreshJobDirectories(state);
    refreshFailureSummary(state);
    return state;
  };

  readonly reduceSubmissionGuard = async (
    state: JobSubmissionGuardProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobSubmissionGuardProjection> => {
    if (raw.stream !== jobStream(this.#taskId)) {
      throw corruptJobJournal(
        "Job submission guard received a different stream",
      );
    }
    await this.#reduceSharedRecord(
      this.#createGuardTarget(state),
      raw,
      envelope,
    );
    return state;
  };

  #createMainTarget(state: JobProjection): JobReductionTarget {
    return {
      kind: "main",
      get activeJobRunId() {
        return state.activeJobRunId;
      },
      set activeJobRunId(value) {
        state.activeJobRunId = value;
      },
      get pendingSystemMissedJobRunId() {
        return state.pendingSystemMissedJobRunId;
      },
      set pendingSystemMissedJobRunId(value) {
        state.pendingSystemMissedJobRunId = value;
      },
      get nextJobRevision() {
        return state.nextJobRevision;
      },
      set nextJobRevision(value) {
        state.nextJobRevision = value;
      },
      taskOperations: state.taskOperations,
      states: state.states,
      admittedJobs: state.admittedJobs,
      ingressByJob: state.ingressByJob,
      assignmentByJob: state.assignmentByJob,
      assignmentAttemptByRun: state.assignmentAttemptByRun,
      supersedeRequests: state.supersedeRequests,
      cancelFences: state.cancelFences,
      interactionSettlementFences: state.interactionSettlementFences,
      completedInteractionSettlements: state.completedInteractionSettlements,
      durableStarted: state.durableStarted,
      revokedCapabilities: state.revokedCapabilities,
      interactionMirrors: state.interactionMirrors,
      interactionMirrorBatches: state.interactionMirrorBatches,
      resolutions: state.resolutions,
      bundleAcknowledgements: state.bundleAcknowledgements,
      systemFences: state.systemFences,
      channelInteractions: state.channelInteractions,
      ticketSlice: state,
      sourceProofSlice: state,
      revocationSlice: state,
      attemptSlice: state,
      applyTaskRevision: async (body, envelope, envelopeRecords) => {
        const definition = validateTaskDefinition(
          await loadJobStored(body.def, this.#artifacts, "TaskDefinition"),
        );
        if (
          body.taskId !== this.#taskId ||
          definition.taskId !== body.taskId ||
          definition.taskRevision !== body.taskRevision ||
          definition.state !== body.state ||
          definition.definition.kind !== body.kind
        ) {
          throw corruptJobJournal("Task revision belongs to a different stream");
        }
        const current = state.definition;
        if (current && !taskCreationProvenanceMatches(current, definition)) {
          throw corruptJobJournal("Task creation provenance is immutable");
        }
        const activeJobRunId = state.activeJobRunId;
        const active = activeJobRunId
          ? state.states.get(activeJobRunId)
          : undefined;
        assertTaskRevisionReplayContract({
          taskIdMatches: body.taskId === this.#taskId,
          taskRevision: body.taskRevision,
          state: body.state,
          kind: body.kind,
          previousRevision: current?.taskRevision,
          previousState: current?.state,
          previousKind: current?.definition.kind,
          activeState: active?.state,
          ...taskRevisionAtomicFacts({
            records: envelopeRecords,
            taskRevision: body.taskRevision,
            activeJobRunId,
            active,
            assignmentId: activeJobRunId
              ? state.assignmentByJob.get(activeJobRunId)
              : undefined,
            cancelFences: state.cancelFences,
            envelopeLsn: envelope.lsn,
          }),
        });
        if (body.operationId !== undefined) {
          if (state.taskOperations.has(body.operationId)) {
            throw corruptJobJournal("Task mutation operation is duplicated");
          }
          state.taskOperations.set(body.operationId, {
            digest: body.operationDigest!,
            taskRevision: body.taskRevision,
          });
        }
        state.definition = snapshot(definition);
        state.definitions.set(definition.taskRevision, snapshot(definition));
      },
      getCurrentDefinitionMeta: () => ({
        present: state.definition !== undefined,
        state: state.definition?.state,
        revision: state.definition?.taskRevision,
        kindForRevision: (taskRevision) =>
          state.definitions.get(taskRevision)?.definition.kind,
      }),
      isRunIdentifierUnused: (jobRunId) =>
        !state.occurrences.has(jobRunId) &&
        !state.systemMissAliases.has(jobRunId),
      getOccurrenceSummary: (jobRunId) => {
        const occ = state.occurrences.get(jobRunId);
        return occ
          ? {
              scheduledFor: occ.scheduledFor,
              taskRevision: occ.taskRevision,
              deliveryPlanDigest: occ.deliveryPlan.planDigest,
              stateIfMain: occ.state,
            }
          : undefined;
      },
      getCoalescedOccurrenceState: (coalescedJobRunId) =>
        state.occurrences.get(coalescedJobRunId)?.state,
      getAdmittedOccurrenceState: (jobRunId) =>
        state.occurrences.get(jobRunId)?.state,
      applyOccurrence: (body, _definitionKind, envelope) => {
        const definition = state.definition;
        if (
          !definition ||
          canonicalize(body.occ.deliveryPlan) !==
            canonicalize(deliveryPlan(definition.definition))
        ) {
          throw corruptJobJournal(
            "Job occurrence does not bind the current task definition",
          );
        }
        state.occurrences.set(body.occ.jobRunId, snapshot(body.occ));
        state.occurrenceOrder.add(
          occurrenceOrderKey(body.occ),
          body.occ.jobRunId,
        );
        if (body.occ.state !== "missed") state.runCount += 1;
        else if (definition.definition.kind === "user") {
          state.pendingMissed.add(body.occ.jobRunId);
        }
        state.states.set(body.occ.jobRunId, {
          state: body.occ.state,
          statusRevision: 1,
        });
        if (state.statusHistoryByRun.has(body.occ.jobRunId)) {
          throw corruptJobJournal(
            "Job occurrence duplicates its status history",
          );
        }
        state.statusHistoryByRun.set(body.occ.jobRunId, [
          { state: body.occ.state, statusRevision: 1, at: envelope.at },
        ]);
      },
      applySystemMissAlias: (body) => {
        state.systemMissAliases.set(body.requestedJobRunId, {
          scheduledFor: body.scheduledFor,
          coalescedJobRunId: body.coalescedJobRunId,
        });
      },
      getAssigned: (assignmentId) => {
        const assigned = state.assignedById.get(assignmentId);
        if (!assigned) return undefined;
        return {
          record: assigned.record,
          commit: assigned.commit,
          get acked() {
            return assigned.acked;
          },
          set acked(value: boolean) {
            assigned.acked = value;
          },
          hasCapId: (capId) => assigned.record.capIds.includes(capId),
        };
      },
      hasAssigned: (assignmentId) => state.assignedById.has(assignmentId),
      applyAssigned: async (body, envelope) => {
        const occurrence = state.occurrences.get(body.jobRunId)!;
        const bytes = await this.#artifacts.get(body.dispatchRef);
        const dispatch = await verifyProtocolStep(() =>
          validateJobEnvelope(
            JSON.parse(Buffer.from(bytes).toString("utf8")) as JobEnvelope,
            this.#verifier,
          ),
        );
        await resolveDispatchArtifactClosure(dispatch, this.#artifacts);
        const dispatchArtifact = dispatchEnvelopeArtifact(dispatch);
        if (
          canonicalize(dispatchArtifact.ref) !==
            canonicalize(body.dispatchRef) ||
          dispatch.assignmentId !== body.assignmentId ||
          dispatch.executorId !== body.executorId ||
          dispatchEnvelopeDigest(dispatch) !== body.dispatchDigest ||
          dispatch.manifest.digest !== body.manifestDigest ||
          permissionSnapshotLeaseDigest(dispatch) !==
            body.permissionLeaseDigest ||
          canonicalize(
            dispatch.capabilities.map((capability) => capability.capId),
          ) !== canonicalize(body.capIds) ||
          dispatch.resourceLease.reservationId !==
            body.reservation.reservationId ||
          dispatch.resourceLease.workload.attempt !== body.reservation.attempt
        ) {
          throw corruptJobJournal(
            "Job assignment dispatch artifact is inconsistent",
          );
        }
        assertDispatchMatchesOccurrence(
          dispatch,
          occurrence,
          requireDefinitionRevision(state, occurrence.taskRevision),
          this.#anchorEpoch,
        );
        if (requiresFormalResourceCoordination(dispatch.resourceLease)) {
          if (!this.#resources) {
            throw corruptJobJournal(
              "Job assignment has no resource coordinator",
            );
          }
          this.#resources.assertActivationRecords({
            lease: dispatch.resourceLease,
            records: envelope.entries,
            acceptedAt: envelope.at,
          });
        }
        state.assignedById.set(body.assignmentId, {
          record: body,
          envelope: dispatch,
          commit: {
            lsn: envelope.lsn,
            envelopeDigest: envelope.envelopeDigest,
            at: envelope.at,
          },
          acked: false,
        });
        state.recoveryAssignments.add(body.assignmentId);
      },
      isAssignmentClosedForFence: (assignmentId) =>
        state.superseded.has(assignmentId),
      hasConflictSeen: (assignmentId) => state.conflicts.has(assignmentId),
      recordConflict: (body) => {
        state.conflicts.set(body.assignmentId, body);
      },
      recordSupersede: (_assigned, body) => {
        state.superseded.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
      },
      hasSupersedeStarted: (assignmentId) =>
        state.supersedeStarted.has(assignmentId),
      recordSupersedeStarted: (body) => {
        state.supersedeStarted.set(body.assignmentId, body);
      },
      hasAcceptedCancellation: (assignmentId) =>
        state.acceptedCancellations.has(assignmentId),
      recordAcceptedCancellation: (body) => {
        state.acceptedCancellations.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
      },
      assertExecutionFailureAccepted: (body, envelopeRecords) => {
        assertExecutionFailureAcceptanceReplay(state, body, envelopeRecords);
      },
      isTicketAssignmentClosed: () => false,
      validateChannelChallengeSource: (assigned, body) => {
        const occurrence = assigned
          ? state.occurrences.get(assigned.record.jobRunId)
          : undefined;
        const definition = occurrence
          ? requireDefinitionRevision(state, occurrence.taskRevision)
          : undefined;
        if (
          !assigned ||
          !definition ||
          definition.definition.kind !== "user" ||
          !definition.definition.origin ||
          !definition.definition.interactionResponder ||
          body.ref.taskId !== this.#taskId ||
          body.ref.jobRunId !== assigned.record.jobRunId ||
          body.ref.anchorEpoch !== assigned.record.anchorEpoch ||
          canonicalize(body.responder) !==
            canonicalize(definition.definition.interactionResponder) ||
          canonicalize(body.token.route) !==
            canonicalize(definition.definition.origin)
        ) {
          throw corruptJobJournal(
            "Job channel challenge does not bind its assignment source",
          );
        }
      },
      validateRelayCursorBinding: (assigned, body) => {
        if (!assigned || assigned.record.jobRunId !== body.jobRunId) {
          throw corruptJobJournal(
            "Channel relay cursor does not bind its assignment",
          );
        }
        if (
          body.checkpoint.ref.execution !== "job" ||
          body.checkpoint.ref.taskId !== this.#taskId ||
          body.checkpoint.ref.jobRunId !== assigned.record.jobRunId ||
          body.checkpoint.ref.anchorEpoch !== assigned.record.anchorEpoch
        ) {
          throw corruptJobJournal(
            "Channel relay checkpoint does not bind its assignment authority",
          );
        }
      },
      onResolutionRecorded: () => undefined,
      hasCommitted: (assignmentId) => state.committed.has(assignmentId),
      applyCommitted: async (_assignedTarget, body, envelope) => {
        const assigned = state.assignedById.get(body.assignmentId);
        const occurrence = state.occurrences.get(body.jobRunId);
        const current = state.states.get(body.jobRunId);
        if (
          !assigned ||
          !occurrence ||
          !current ||
          (current.state !== "dispatched" &&
            current.state !== "running" &&
            current.state !== "cancel-requested" &&
            current.state !== "uncertain")
        ) {
          throw corruptJobJournal(
            "Job commit is invalid or lacks its atomic state",
          );
        }
        try {
          const bytes = await this.#artifacts.get(body.bundle.ref);
          const bundle = validateJobSealedBundle(
            JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
          );
          const closure = await validateJobBundleClosure(
            bundle,
            this.#artifacts,
          );
          if (
            canonicalize(closure.artifact.ref) !==
              canonicalize(body.bundle.ref) ||
            !jobBundleBindsAssignedOccurrence(bundle, assigned, occurrence)
          ) {
            throw new Error("bundle identity does not match");
          }
          this.assertAssignmentUsageFinal(assigned.record, bundle.usageFinal);
          state.outcomeByRun.set(body.jobRunId, snapshot(bundle.body.outcome));
          this.#delivery.assertJobCommit(
            {
              at: envelope.at,
              occurrence,
              definition: requireDefinitionRevision(
                state,
                occurrence.taskRevision,
              ),
              bundle,
              assignmentLifecycleSource: {
                owner: "assignment",
                id: `${assigned.record.executorId === this.#localExecutorId ? "local" : "relay"}:${body.assignmentId}`,
                revision: assigned.record.dispatchDigest,
              },
              ...(closure.batch ? { mutationBatch: closure.batch } : {}),
            },
            envelope,
          );
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
          throw corruptJobJournal(
            error instanceof Error
              ? `Committed job bundle is invalid: ${error.message}`
              : "Committed job bundle is invalid",
          );
        }
        this.assertAssignmentResourceTerminal(
          assigned.record,
          "settle-release",
          envelope.entries,
        );
        state.committed.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        state.bundleAcknowledgementOutbox.add(body.assignmentId);
      },
      getCommittedAckExpected: (assignmentId) => {
        const committed = state.committed.get(assignmentId);
        return committed
          ? { ref: committed.bundle.ref, jobRevision: committed.jobRevision }
          : undefined;
      },
      onBundleAckObserved: (assignmentId) => {
        state.recoveryAssignments.delete(assignmentId);
        state.bundleAcknowledgementOutbox.delete(assignmentId);
      },
      validateSystemStartedDefinition: (taskRevision, fence) => {
        const definition = requireDefinitionRevision(state, taskRevision);
        assertSystemJobDefinitionReplayContract({ definition, fence });
      },
      hasSystemResult: (jobRunId) => state.systemResults.has(jobRunId),
      loadSystemResultDetail: async (body) =>
        validateSystemJobResultDetail(
          await loadJobStored(
            body.detail,
            this.#artifacts,
            "SystemJobResultDetail",
          ),
          body.outcome,
        ),
      recordSystemResult: (body, detail) => {
        state.systemResults.set(body.jobRunId, {
          t: "system-result",
          jobRunId: body.jobRunId,
          fence: snapshot(body.fence),
          outcome: body.outcome,
          ...detail!,
        });
      },
      validateStateDeliveryAndClosure: (
        _body,
        _previous,
        occurrence,
        envelope,
      ) => {
        const definition = requireDefinitionRevision(
          state,
          occurrence.taskRevision,
        );
        try {
          this.#delivery.assertJobStatuses(
            jobStatusDeliveryInputs(
              this.#taskId,
              state,
              envelope.entries,
              envelope.at,
            ),
            envelope,
          );
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
          throw corruptJobJournal(
            error instanceof Error
              ? `Job status delivery is invalid: ${error.message}`
              : "Job status delivery is invalid",
          );
        }
        return {
          closedEarlierInEnvelope: false,
          definitionKind: definition.definition.kind,
        };
      },
      onStateRecorded: (body, previous, envelope, envelopeRecords) => {
        const history = state.statusHistoryByRun.get(body.jobRunId);
        if (!history || history.length + 1 !== body.statusRevision) {
          throw corruptJobJournal(
            "Job status history index is not contiguous",
          );
        }
        const uncertainStatus = projectUncertainStatusTransition({
          currentState: previous.state,
          nextState: body.state,
          resolutionFacts: envelopeRecords.flatMap((record) =>
            record.t === "resolution" && record.jobRunId === body.jobRunId
              ? [record.fact]
              : [],
          ),
        });
        history.push({
          state: body.state,
          statusRevision: body.statusRevision,
          at: envelope.at,
          ...(uncertainStatus.kind === "opened"
            ? {
                uncertainTransition: "opened" as const,
                openFactDigest: uncertainStatus.openFactDigest,
              }
            : uncertainStatus.kind === "closed"
              ? {
                  uncertainTransition: "closed" as const,
                  openFactDigest: uncertainStatus.openFactDigest,
                  ...jobUncertainClosure(uncertainStatus.resolutionKind),
                }
              : {}),
        });
        if (body.state === "queued") {
          if (body.assignmentId) {
            state.assignmentByJob.delete(body.jobRunId);
            state.recoveryAssignments.delete(body.assignmentId);
          }
          state.activeJobRunId = body.jobRunId;
        } else if (isTerminal(body.state)) {
          if (body.assignmentId) state.assignmentByJob.delete(body.jobRunId);
          if (body.assignmentId && body.state !== "committed") {
            state.recoveryAssignments.delete(body.assignmentId);
          }
          if (state.activeJobRunId === body.jobRunId) {
            state.activeJobRunId = undefined;
            state.pendingSystemMissedJobRunId = undefined;
          }
        } else {
          state.activeJobRunId = body.jobRunId;
        }
      },
      applyMainOnlyRecord: (body, envelope, envelopeRecords) => {
        this.#applyMainOnlyRecord(state, body, envelope, envelopeRecords);
      },
    };
  }

  #createGuardTarget(state: JobSubmissionGuardProjection): JobReductionTarget {
    return {
      kind: "guard",
      get activeJobRunId() {
        return state.activeJobRunId;
      },
      set activeJobRunId(value) {
        state.activeJobRunId = value;
      },
      get pendingSystemMissedJobRunId() {
        return state.pendingSystemMissedJobRunId;
      },
      set pendingSystemMissedJobRunId(value) {
        state.pendingSystemMissedJobRunId = value;
      },
      get nextJobRevision() {
        return state.nextJobRevision;
      },
      set nextJobRevision(value) {
        state.nextJobRevision = value;
      },
      taskOperations: state.taskOperations,
      states: state.states,
      admittedJobs: state.admittedJobs,
      ingressByJob: state.ingressByJob,
      assignmentByJob: state.assignmentByJob,
      assignmentAttemptByRun: state.assignmentAttemptByRun,
      supersedeRequests: state.supersedeRequests,
      cancelFences: state.cancelFences,
      interactionSettlementFences: state.interactionSettlementFences,
      completedInteractionSettlements: state.completedInteractionSettlements,
      durableStarted: state.durableStarted,
      revokedCapabilities: state.revokedCapabilities,
      interactionMirrors: state.interactionMirrors,
      interactionMirrorBatches: state.interactionMirrorBatches,
      resolutions: state.resolutions,
      bundleAcknowledgements: state.bundleAcknowledgements,
      systemFences: state.systemFences,
      channelInteractions: state.channelInteractions,
      ticketSlice: state,
      sourceProofSlice: state,
      revocationSlice: state,
      attemptSlice: state,
      applyTaskRevision: async (body, envelope, envelopeRecords) => {
        const previousRevision = state.latestDefinitionRevision;
        const activeJobRunId = state.activeJobRunId;
        const active = activeJobRunId
          ? state.states.get(activeJobRunId)
          : undefined;
        assertTaskRevisionReplayContract({
          taskIdMatches: body.taskId === this.#taskId,
          taskRevision: body.taskRevision,
          state: body.state,
          kind: body.kind,
          previousRevision,
          previousState:
            previousRevision === undefined
              ? undefined
              : state.latestDefinitionState,
          previousKind:
            previousRevision === undefined
              ? undefined
              : state.definitionKinds.get(previousRevision),
          activeState: active?.state,
          ...taskRevisionAtomicFacts({
            records: envelopeRecords,
            taskRevision: body.taskRevision,
            activeJobRunId,
            active,
            assignmentId: activeJobRunId
              ? state.assignmentByJob.get(activeJobRunId)
              : undefined,
            cancelFences: state.cancelFences,
            envelopeLsn: envelope.lsn,
          }),
        });
        if (body.operationId !== undefined) {
          if (state.taskOperations.has(body.operationId)) {
            throw corruptJobJournal("Task mutation operation is duplicated");
          }
          state.taskOperations.set(body.operationId, {
            digest: body.operationDigest!,
            taskRevision: body.taskRevision,
          });
        }
        state.definitionKinds.set(body.taskRevision, body.kind);
        state.latestDefinitionState = body.state;
        state.latestDefinitionRevision = body.taskRevision;
      },
      getCurrentDefinitionMeta: () => ({
        present: state.latestDefinitionRevision !== undefined,
        state: state.latestDefinitionState,
        revision: state.latestDefinitionRevision,
        kindForRevision: (taskRevision) =>
          state.definitionKinds.get(taskRevision),
      }),
      isRunIdentifierUnused: (jobRunId) =>
        !state.states.has(jobRunId) && !state.systemMissAliases.has(jobRunId),
      getOccurrenceSummary: (jobRunId) => state.occurrences.get(jobRunId),
      getCoalescedOccurrenceState: (coalescedJobRunId) =>
        state.states.get(coalescedJobRunId)?.state,
      getAdmittedOccurrenceState: (jobRunId) =>
        state.states.get(jobRunId)?.state,
      applyOccurrence: (body) => {
        state.occurrences.set(body.occ.jobRunId, {
          scheduledFor: body.occ.scheduledFor,
          taskRevision: body.occ.taskRevision,
          deliveryPlanDigest: body.occ.deliveryPlan.planDigest,
          deliveryRequired: body.occ.deliveryPlan.delivery.kind !== "none",
        });
        state.states.set(body.occ.jobRunId, {
          state: body.occ.state,
          statusRevision: 1,
        });
      },
      applySystemMissAlias: (body) => {
        state.systemMissAliases.add(body.requestedJobRunId);
      },
      getAssigned: (assignmentId) => {
        const assigned = state.assignedById.get(assignmentId);
        if (!assigned) return undefined;
        return {
          record: assigned.record,
          commit: assigned.commit,
          get acked() {
            return assigned.acked;
          },
          set acked(value: boolean) {
            assigned.acked = value;
          },
          hasCapId: (capId) => assigned.capIds.has(capId),
        };
      },
      hasAssigned: (assignmentId) => state.assignedById.has(assignmentId),
      applyAssigned: async (body, envelope) => {
        state.assignedById.set(body.assignmentId, {
          record: body,
          commit: {
            lsn: envelope.lsn,
            envelopeDigest: envelope.envelopeDigest,
            at: envelope.at,
          },
          capIds: new Set(body.capIds),
          acked: false,
        });
      },
      isAssignmentClosedForFence: (assignmentId) =>
        state.closedAssignments.has(assignmentId),
      hasConflictSeen: (assignmentId) =>
        state.conflictAssignments.has(assignmentId),
      recordConflict: (body) => {
        state.conflictAssignments.add(body.assignmentId);
        if (body.handling === "opened-uncertain") {
          state.openConflictAssignments.add(body.assignmentId);
        }
      },
      recordSupersede: (assigned, body) => {
        state.assignmentByJob.delete(assigned.record.jobRunId);
        state.closedAssignments.add(body.assignmentId);
        state.openConflictAssignments.delete(body.assignmentId);
      },
      hasSupersedeStarted: (assignmentId) =>
        state.supersedeStartedAssignments.has(assignmentId),
      recordSupersedeStarted: (body) => {
        state.supersedeStartedAssignments.add(body.assignmentId);
      },
      hasAcceptedCancellation: (assignmentId) =>
        state.acceptedCancellations.has(assignmentId),
      recordAcceptedCancellation: (body) => {
        state.acceptedCancellations.add(body.assignmentId);
      },
      assertExecutionFailureAccepted: (body, envelopeRecords) => {
        assertExecutionFailureAcceptanceReplay(state, body, envelopeRecords);
      },
      isTicketAssignmentClosed: (assignmentId) =>
        state.closedAssignments.has(assignmentId),
      validateChannelChallengeSource: (assigned, body) => {
        if (
          !assigned ||
          body.ref.taskId !== this.#taskId ||
          body.ref.jobRunId !== assigned.record.jobRunId ||
          body.ref.anchorEpoch !== assigned.record.anchorEpoch
        ) {
          throw corruptJobJournal(
            "Job channel challenge does not bind its assignment source",
          );
        }
      },
      validateRelayCursorBinding: (assigned, body) => {
        if (
          !assigned ||
          assigned.record.jobRunId !== body.jobRunId ||
          body.checkpoint.ref.execution !== "job" ||
          body.checkpoint.ref.taskId !== this.#taskId ||
          body.checkpoint.ref.jobRunId !== assigned.record.jobRunId ||
          body.checkpoint.ref.anchorEpoch !== assigned.record.anchorEpoch
        ) {
          throw corruptJobJournal(
            "Channel relay cursor does not bind its assignment authority",
          );
        }
      },
      onResolutionRecorded: (jobFact) => {
        if (jobFact.resolution) {
          state.assignmentByJob.delete(jobFact.subject.jobRunId);
          state.closedAssignments.add(jobFact.subject.assignmentId);
          state.openConflictAssignments.delete(jobFact.subject.assignmentId);
        }
      },
      hasCommitted: (assignmentId) =>
        state.committedByAssignment.has(assignmentId),
      applyCommitted: async (assigned, body, envelope) => {
        this.assertAssignmentResourceTerminal(
          assigned.record,
          "settle-release",
          envelope.entries,
        );
        state.committedByAssignment.set(body.assignmentId, {
          ref: body.bundle.ref,
          jobRevision: body.jobRevision,
        });
      },
      getCommittedAckExpected: (assignmentId) =>
        state.committedByAssignment.get(assignmentId),
      onBundleAckObserved: () => undefined,
      validateSystemStartedDefinition: () => undefined,
      hasSystemResult: (jobRunId) => state.systemResults.has(jobRunId),
      loadSystemResultDetail: async () => undefined,
      recordSystemResult: (body) => {
        state.systemResults.add(body.jobRunId);
      },
      validateStateDeliveryAndClosure: (
        body,
        _previous,
        occurrence,
        _envelope,
        envelopeRecords,
      ) => ({
        closedEarlierInEnvelope:
          body.assignmentId !== undefined &&
          state.assignmentByJob.get(body.jobRunId) === undefined &&
          state.closedAssignments.has(body.assignmentId) &&
          recordsCloseJobAssignment(
            envelopeRecords,
            body.jobRunId,
            body.assignmentId,
          ),
        definitionKind: state.definitionKinds.get(occurrence.taskRevision),
      }),
      onStateRecorded: (body) => {
        if (body.state === "queued") {
          state.activeJobRunId = body.jobRunId;
        } else if (isTerminal(body.state)) {
          if (state.activeJobRunId === body.jobRunId) {
            state.activeJobRunId = undefined;
            state.pendingSystemMissedJobRunId = undefined;
          }
        } else {
          state.activeJobRunId = body.jobRunId;
        }
      },
      applyMainOnlyRecord: () => undefined,
    };
  }

  #applyMainOnlyRecord(
    state: JobProjection,
    body: MainOnlyJobJournalRecord,
    envelope: CommitEnvelope<unknown>,
    envelopeRecords: readonly JobJournalRecord[],
  ): void {
    switch (body.t) {
      case "legacy-next-fire": {
        const definitionRecord = envelopeRecords.find(
          (record) =>
            record.t === "task-revision" &&
            record.taskRevision === body.taskRevision,
        );
        if (!definitionRecord || state.legacyNextFire) {
          throw corruptJobJournal(
            "Legacy next-fire lacks its atomic imported definition",
          );
        }
        state.legacyNextFire = body;
        return;
      }
      case "missed-next-fire": {
        const occurrence = envelopeRecords.find(
          (record) =>
            record.t === "occurrence" &&
            record.occ.jobRunId === body.jobRunId &&
            record.occ.state === "missed",
        );
        if (!occurrence || state.missedNextFireByRun.has(body.jobRunId)) {
          throw corruptJobJournal(
            "Missed next-fire lacks its atomic missed occurrence",
          );
        }
        state.missedNextFireByRun.set(body.jobRunId, body);
        return;
      }
      case "failure-policy": {
        const terminal = envelopeRecords.find(
          (record) =>
            record.t === "state" &&
            record.jobRunId === body.jobRunId &&
            (record.state === "failed" ||
              record.state === "expired" ||
              (record.state === "committed" &&
                state.outcomeByRun.get(body.jobRunId)?.status === "failed")) &&
            record.statusRevision === body.statusRevision,
        );
        const occurrence = state.occurrences.get(body.jobRunId);
        if (
          !terminal ||
          !occurrence ||
          occurrence.taskRevision !== body.taskRevision ||
          state.failurePolicyByRun.has(body.jobRunId)
        ) {
          throw corruptJobJournal(
            "Failure policy lacks its atomic failed terminal",
          );
        }
        state.failurePolicyByRun.set(body.jobRunId, body);
        return;
      }
      case "auto-disable-settled": {
        const policy = state.failurePolicyByRun.get(body.jobRunId);
        if (
          !policy?.autoDisableRequired ||
          state.definition?.state !== "disabled" ||
          state.definition.taskRevision !== body.disabledTaskRevision ||
          state.autoDisableSettledRuns.has(body.jobRunId)
        ) {
          throw corruptJobJournal(
            "Auto-disable settlement is invalid or duplicated",
          );
        }
        state.autoDisableSettledRuns.add(body.jobRunId);
        return;
      }
      case "capability-gap-opened":
      case "capability-gap-updated": {
        if (
          !envelope.entries.some(
            (entry) =>
              entry.stream === SCHEDULER_USER_NOTICE_STREAM &&
              typeof entry.body === "object" &&
              entry.body !== null &&
              (entry.body as { noticeId?: unknown }).noticeId === body.noticeId,
          )
        ) {
          throw corruptJobJournal(
            "Capability gap lacks its atomic user notice",
          );
        }
        const current = state.states.get(body.jobRunId);
        if (current?.state !== "queued") {
          throw corruptJobJournal(
            "Capability gap does not bind a queued occurrence",
          );
        }
        const previous = state.capabilityGapByRun.get(body.jobRunId);
        if (body.t === "capability-gap-opened") {
          if (previous?.open || body.round !== (previous?.round ?? 0) + 1) {
            throw corruptJobJournal("Capability gap opening round is invalid");
          }
        } else if (
          !previous?.open ||
          previous.round !== body.round ||
          previous.noticeId !== body.noticeId
        ) {
          throw corruptJobJournal(
            "Capability gap update does not bind the open round",
          );
        }
        state.capabilityGapByRun.set(body.jobRunId, {
          round: body.round,
          noticeId: body.noticeId,
          capabilityRevision: body.capabilityRevision,
          reasonDigest: body.reasonDigest,
          reason: body.reason,
          open: true,
        });
        return;
      }
      case "capability-gap-closed": {
        if (
          !envelope.entries.some(
            (entry) =>
              entry.stream === SCHEDULER_USER_NOTICE_STREAM &&
              typeof entry.body === "object" &&
              entry.body !== null &&
              (entry.body as { noticeId?: unknown }).noticeId === body.noticeId,
          )
        ) {
          throw corruptJobJournal(
            "Capability gap close lacks its atomic notice update",
          );
        }
        const previous = state.capabilityGapByRun.get(body.jobRunId);
        if (
          !previous?.open ||
          previous.round !== body.round ||
          previous.noticeId !== body.noticeId
        ) {
          throw corruptJobJournal(
            "Capability gap close does not bind the open round",
          );
        }
        state.capabilityGapByRun.set(body.jobRunId, {
          ...previous,
          open: false,
        });
        return;
      }
      case "dispatch-conflict-contained":
      case "cancel-contained": {
        const assigned = requireReplayAssignment(state, body.assignmentId);
        const open = state.resolutions.get(assigned.record.jobRunId);
        if (
          state.assignmentByJob.get(assigned.record.jobRunId) !==
            body.assignmentId ||
          !proofBindsJobSource(
            state,
            assigned,
            body.proof,
            this.#anchorEpoch,
            this.#legacyAbortTickets,
          ) ||
          !open ||
          open.resolution ||
          open.openFactDigest !== body.openFactDigest ||
          state.containedFacts.has(body.openFactDigest) ||
          (body.t === "dispatch-conflict-contained" &&
            (open.cause !== "dispatch-conflict" ||
              !state.conflicts.has(body.assignmentId) ||
              body.proof.lastRecordSeq <=
                state.conflicts.get(body.assignmentId)!.proof
                  .receivedRecordSeq)) ||
          (body.t === "cancel-contained" &&
            (open.cause === "dispatch-conflict" ||
              body.proof.decision !== "halted"))
        ) {
          throw corruptJobJournal(
            "Containment does not bind one open uncertain fact",
          );
        }
        if (body.t === "dispatch-conflict-contained") {
          const current = state.states.get(assigned.record.jobRunId);
          const targetState = current
            ? notStartedTargetState(state.definition?.state, current)
            : "queued";
          const notStartedProof =
            body.proof.decision === "halted" ? undefined : body.proof;
          assertJobConflictContainmentReplayContract({
            proofDecision: notStartedProof ? "not-started" : "halted",
            conflictOpen: open.cause === "dispatch-conflict",
            hasAtomicSupersedeWithSameProof:
              notStartedProof !== undefined &&
              envelopeRecords.some(
                (record) =>
                  record.t === "assignment-superseded" &&
                  record.assignmentId === body.assignmentId &&
                  sameTerminationProofIdentity(record.proof, notStartedProof),
              ),
            hasAtomicResolutionClose: envelopeRecords.some(
              (record) =>
                record.t === "resolution" &&
                record.jobRunId === assigned.record.jobRunId &&
                record.fact.openFactDigest === open.openFactDigest &&
                (record.fact.resolution?.kind ===
                  "proven-not-started-redispatched" ||
                  record.fact.resolution?.kind ===
                    "proven-not-started-cancelled"),
            ),
            hasAtomicTargetState:
              current !== undefined &&
              recordsHaveJobState(
                envelopeRecords,
                assigned.record.jobRunId,
                targetState,
                current.statusRevision + 1,
                body.assignmentId,
              ),
            allCapabilitiesRevoked: allJobCapabilitiesRevoked(
              envelopeRecords,
              state,
              assigned,
            ),
          });
        }
        state.containedFacts.add(body.openFactDigest);
        state.containments.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        return;
      }
      case "not-started-rejected": {
        const assigned = requireReplayAssignment(state, body.assignmentId);
        const current = state.states.get(assigned.record.jobRunId);
        const open = state.resolutions.get(assigned.record.jobRunId);
        const contradictory =
          state.durableStarted.has(body.assignmentId) ||
          ("dispatchDigest" in body.proof &&
            open?.cause === "dispatch-conflict");
        const expectedCause =
          "cause" in body.proof ? "job-cancel-unknown" : "ledger-unknown";
        if (
          state.assignmentByJob.get(assigned.record.jobRunId) !==
            body.assignmentId ||
          !proofBindsJobSource(
            state,
            assigned,
            body.proof,
            this.#anchorEpoch,
            this.#legacyAbortTickets,
          ) ||
          !current ||
          !contradictory ||
          (current.state !== "uncertain" &&
            (!envelopeRecords.some(
              (record) =>
                record.t === "resolution" &&
                record.jobRunId === assigned.record.jobRunId &&
                record.fact.subject.assignmentId === body.assignmentId &&
                record.fact.cause === expectedCause &&
                record.fact.resolution === undefined,
            ) ||
              !envelopeRecords.some(
                (record) =>
                  record.t === "state" &&
                  record.jobRunId === assigned.record.jobRunId &&
                  record.assignmentId === body.assignmentId &&
                  record.state === "uncertain" &&
                  record.statusRevision === current.statusRevision + 1,
              ) ||
              !allJobCapabilitiesRevoked(envelopeRecords, state, assigned)))
        ) {
          throw corruptJobJournal("Rejected not-started proof is historical");
        }
        const key = notStartedRejectionKey(
          body.assignmentId,
          terminationProofKind(body.proof),
        );
        if (state.rejectedNotStarted.has(key)) {
          throw corruptJobJournal("Rejected not-started proof is duplicated");
        }
        state.rejectedNotStarted.set(key, body);
        return;
      }
    }
  }

  async #reduceSharedRecord(
    target: JobReductionTarget,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<void> {
    const body = await verifyProtocolStep(() =>
      validateJobJournalRecord(raw.body, this.#verifier),
    );
    const envelopeRecords = envelope.entries
      .filter((entry) => entry.stream === jobStream(this.#taskId))
      .map((entry) => entry.body as JobJournalRecord);

    switch (body.t) {
      case "task-revision":
        await target.applyTaskRevision(body, envelope, envelopeRecords);
        return;

      case "occurrence": {
        const defMeta = target.getCurrentDefinitionMeta();
        const active = target.activeJobRunId
          ? target.states.get(target.activeJobRunId)
          : undefined;
        const definitionKind = defMeta.kindForRevision(body.occ.taskRevision);
        assertJobOccurrenceReplayContract({
          taskIdMatches: body.occ.taskId === this.#taskId,
          definitionPresent: defMeta.present,
          definitionState: defMeta.state,
          definitionRevisionMatches:
            defMeta.present && body.occ.taskRevision === defMeta.revision,
          definitionKind,
          identifierUnused: target.isRunIdentifierUnused(body.occ.jobRunId),
          occurrenceState: body.occ.state,
          activeState: active?.state,
          hasAtomicAdmission: envelopeRecords.some(
            (record) =>
              record.t === "admitted" && record.jobRunId === body.occ.jobRunId,
          ),
          hasAtomicOfflineMissPolicy: envelopeRecords.some(
            (record) =>
              record.t === "missed-next-fire" &&
              record.jobRunId === body.occ.jobRunId,
          ),
        });
        target.applyOccurrence(body, definitionKind, envelope);
        if (body.occ.state === "queued") {
          target.activeJobRunId = body.occ.jobRunId;
        }
        target.pendingSystemMissedJobRunId = registerPendingSystemMiss({
          currentPendingJobRunId: target.pendingSystemMissedJobRunId,
          jobRunId: body.occ.jobRunId,
          definitionKind,
          occurrenceState: body.occ.state,
        });
        return;
      }

      case "legacy-next-fire":
      case "missed-next-fire":
      case "failure-policy":
      case "auto-disable-settled":
      case "capability-gap-opened":
      case "capability-gap-updated":
      case "capability-gap-closed":
      case "dispatch-conflict-contained":
      case "cancel-contained":
      case "not-started-rejected":
        target.applyMainOnlyRecord(body, envelope, envelopeRecords);
        return;

      case "system-miss-coalesced": {
        const defMeta = target.getCurrentDefinitionMeta();
        const coalesced = target.getOccurrenceSummary(body.coalescedJobRunId);
        const active = target.activeJobRunId
          ? target.states.get(target.activeJobRunId)
          : undefined;
        const definitionKind =
          target.kind === "main"
            ? defMeta.present && defMeta.revision !== undefined
              ? defMeta.kindForRevision(defMeta.revision)
              : undefined
            : coalesced
              ? defMeta.kindForRevision(coalesced.taskRevision)
              : undefined;
        assertSystemMissCoalescedReplayContract({
          definitionKind,
          requestedIdentifierUnused: target.isRunIdentifierUnused(
            body.requestedJobRunId,
          ),
          pendingMatchesCoalesced:
            target.pendingSystemMissedJobRunId === body.coalescedJobRunId,
          coalescedState: target.getCoalescedOccurrenceState(
            body.coalescedJobRunId,
          ),
          activeState: active?.state,
        });
        target.applySystemMissAlias(body);
        return;
      }

      case "admitted": {
        const defMeta = target.getCurrentDefinitionMeta();
        const occurrence = target.getOccurrenceSummary(body.jobRunId);
        assertJobAdmissionReplayContract({
          taskIdMatches: body.taskId === this.#taskId,
          occurrencePresent: occurrence !== undefined,
          scheduleMatches: occurrence?.scheduledFor === body.scheduledFor,
          occurrenceState: target.getAdmittedOccurrenceState(body.jobRunId),
          definitionKind: occurrence
            ? defMeta.kindForRevision(occurrence.taskRevision)
            : undefined,
          admissionAlreadyExists: target.admittedJobs.has(body.jobRunId),
          ingressPresent: body.ingress !== undefined,
          hasAtomicManualControlResult: envelopeHasManualJobRunApplied(
            envelope,
            body.jobRunId,
          ),
        });
        target.admittedJobs.add(body.jobRunId);
        if (body.ingress) target.ingressByJob.set(body.jobRunId, body.ingress);
        return;
      }

      case "assigned": {
        const occurrence = target.getOccurrenceSummary(body.jobRunId);
        const current = target.states.get(body.jobRunId);
        assertAssignmentReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          runAlreadyAssigned: target.assignmentByJob.has(body.jobRunId),
          assignmentAlreadyKnown: target.hasAssigned(body.assignmentId),
          isEarliestQueuedRun: target.activeJobRunId === body.jobRunId,
          hasAtomicDispatchedState:
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              body.jobRunId,
              "dispatched",
              current.statusRevision + 1,
              body.assignmentId,
            ),
        });
        if (
          !occurrence ||
          body.taskId !== this.#taskId ||
          body.anchorEpoch !== this.#anchorEpoch ||
          body.taskRevision !== occurrence.taskRevision ||
          body.deliveryPlanDigest !== occurrence.deliveryPlanDigest
        ) {
          throw corruptJobJournal(
            "Job assignment is invalid or lacks its atomic state",
          );
        }
        await target.applyAssigned(body, envelope);
        target.assignmentByJob.set(body.jobRunId, body.assignmentId);
        target.assignmentAttemptByRun.set(
          body.jobRunId,
          Math.max(
            target.assignmentAttemptByRun.get(body.jobRunId) ?? 0,
            body.reservation.attempt,
          ),
        );
        return;
      }

      case "dispatch-acked": {
        const assigned = target.getAssigned(body.assignmentId);
        const current = assigned
          ? target.states.get(assigned.record.jobRunId)
          : undefined;
        const closed = target.isAssignmentClosedForFence(body.assignmentId);
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          alreadyAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: closed,
          assignmentClosed: closed,
        });
        if (!assigned) {
          throw corruptJobJournal(
            "Dispatch acknowledgement is missing or duplicated",
          );
        }
        assigned.acked = true;
        return;
      }

      case "dispatch-conflict": {
        const assigned = target.getAssigned(body.assignmentId);
        const current = assigned
          ? target.states.get(assigned.record.jobRunId)
          : undefined;
        const closed = target.isAssignmentClosedForFence(body.assignmentId);
        assertDispatchConflictReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          proofBindsAssignment:
            assigned !== undefined &&
            body.proof.assignmentId === body.assignmentId &&
            body.proof.executorId === assigned.record.executorId,
          handling: body.handling,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: closed,
          assignmentClosed: closed,
          conflictAlreadySeen: target.hasConflictSeen(body.assignmentId),
        });
        if (!assigned || !current) {
          throw corruptJobJournal(
            "Dispatch conflict identity is invalid or duplicated",
          );
        }
        const expectedActivationDigest = assignedActivationDigest(assigned);
        const acceptedMatches =
          canonicalize(body.proof.acceptedDispatchRef) ===
            canonicalize(assigned.record.dispatchRef) &&
          body.proof.acceptedActivationDigest === expectedActivationDigest;
        const conflictingMatches =
          canonicalize(body.proof.conflictingDispatchRef) ===
            canonicalize(assigned.record.dispatchRef) &&
          body.proof.conflictingActivationDigest === expectedActivationDigest;
        assertDispatchConflictHandlingReplayContract({
          handling: body.handling,
          acceptedMatches,
          conflictingMatches,
          atomicHandling:
            body.handling === "acked-original"
              ? envelopeRecords.some(
                  (record) =>
                    record.t === "dispatch-acked" &&
                    record.assignmentId === body.assignmentId,
                )
              : envelopeRecords.some(
                  (record) =>
                    record.t === "resolution" &&
                    record.jobRunId === assigned.record.jobRunId &&
                    record.fact.subject.assignmentId === body.assignmentId &&
                    record.fact.cause === "dispatch-conflict" &&
                    record.fact.resolution === undefined,
                ) &&
                recordsHaveJobState(
                  envelopeRecords,
                  assigned.record.jobRunId,
                  "uncertain",
                  current.statusRevision + 1,
                  body.assignmentId,
                ) &&
                envelopeRecords.some(
                  (record) =>
                    record.t === "cancel-fence" &&
                    record.assignmentId === body.assignmentId,
                ) &&
                allJobCapabilitiesRevoked(
                  envelopeRecords,
                  target.revocationSlice,
                  { record: assigned.record },
                ),
        });
        target.recordConflict(body);
        return;
      }

      case "assignment-superseded": {
        const assigned = target.getAssigned(body.assignmentId);
        const current = assigned
          ? target.states.get(assigned.record.jobRunId)
          : undefined;
        const open = assigned
          ? target.resolutions.get(assigned.record.jobRunId)
          : undefined;
        const defState = target.getCurrentDefinitionMeta().state;
        const targetState = current
          ? notStartedTargetState(defState, current)
          : "queued";
        assertAssignmentSupersededReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          assignmentAlreadyClosed: target.isAssignmentClosedForFence(
            body.assignmentId,
          ),
          currentState: current?.state,
          durableStartedObserved: target.durableStarted.has(body.assignmentId),
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              target.sourceProofSlice,
              assigned,
              body.proof,
              this.#anchorEpoch,
              this.#legacyAbortTickets,
            ),
          proofKind: assignmentTerminationProofKind(body.proof),
          hasAtomicTargetState:
            assigned !== undefined &&
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              assigned.record.jobRunId,
              targetState,
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            allJobCapabilitiesRevoked(
              envelopeRecords,
              target.revocationSlice,
              { record: assigned.record },
            ),
          hasAtomicResolutionClose:
            assigned !== undefined &&
            open !== undefined &&
            open.resolution === undefined &&
            envelopeRecords.some(
              (record) =>
                record.t === "resolution" &&
                record.jobRunId === assigned.record.jobRunId &&
                record.fact.openFactDigest === open.openFactDigest &&
                (record.fact.resolution?.kind ===
                  "proven-not-started-redispatched" ||
                  record.fact.resolution?.kind ===
                    "proven-not-started-cancelled"),
            ),
          conflictOpen:
            open !== undefined &&
            open.resolution === undefined &&
            open.cause === "dispatch-conflict",
          hasAtomicConflictContainment:
            open !== undefined &&
            envelopeRecords.some(
              (record) =>
                record.t === "dispatch-conflict-contained" &&
                record.assignmentId === body.assignmentId &&
                record.openFactDigest === open.openFactDigest &&
                record.proof.decision !== "halted" &&
                sameTerminationProofIdentity(record.proof, body.proof),
            ),
        });
        if (!assigned) {
          throw corruptJobJournal(
            target.kind === "main"
              ? "Assignment supersede has no assignment"
              : "Assignment supersede is historical or duplicated",
          );
        }
        this.assertAssignmentResourceTerminal(
          assigned.record,
          "release",
          envelope.entries,
        );
        target.recordSupersede(assigned, body);
        return;
      }

      case "supersede-requested": {
        const assigned = target.getAssigned(body.assignmentId);
        assertSupersedeRequestReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: assigned
            ? target.states.get(assigned.record.jobRunId)?.state
            : undefined,
          requestAlreadyExists: target.supersedeRequests.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
        });
        target.supersedeRequests.set(body.assignmentId, body);
        return;
      }

      case "supersede-started-observed": {
        const assigned = target.getAssigned(body.assignmentId);
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: assigned
            ? target.states.get(assigned.record.jobRunId)?.state
            : undefined,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              target.sourceProofSlice,
              assigned,
              body.proof,
              this.#anchorEpoch,
              this.#legacyAbortTickets,
            ),
          observationAlreadyExists: target.hasSupersedeStarted(
            body.assignmentId,
          ),
        });
        target.recordSupersedeStarted(body);
        target.durableStarted.add(body.assignmentId);
        return;
      }

      case "cancel-fence": {
        const assigned = target.getAssigned(body.assignmentId);
        const current = assigned
          ? target.states.get(assigned.record.jobRunId)
          : undefined;
        assertJobCancelFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: target.cancelFences.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
          hasAtomicCancelRequestedState:
            assigned !== undefined &&
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              assigned.record.jobRunId,
              "cancel-requested",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          hasAtomicOpenedConflict:
            assigned !== undefined &&
            target.resolutions.get(assigned.record.jobRunId)?.cause ===
              "dispatch-conflict" &&
            envelopeRecords.some(
              (record) =>
                record.t === "dispatch-conflict" &&
                record.assignmentId === body.assignmentId &&
                record.handling === "opened-uncertain",
            ),
          hasAtomicDeletedTaskRevision: envelopeRecords.some(
            (record) =>
              record.t === "task-revision" &&
              record.state === "deleted" &&
              body.requestId === `task-revision:${record.taskRevision}`,
          ),
        });
        target.cancelFences.set(body.assignmentId, body);
        return;
      }

      case "interaction-settlement-fence": {
        const assigned = target.getAssigned(body.assignmentId);
        if (
          "v" in body &&
          body.v === 2 &&
          assigned?.record.executorId !== body.executorId
        ) {
          throw corruptJobJournal(
            "Versioned interaction settlement names a different executor",
          );
        }
        const current = assigned
          ? target.states.get(assigned.record.jobRunId)
          : undefined;
        assertJobInteractionSettlementFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: target.interactionSettlementFences.has(
            body.assignmentId,
          ),
          hasAtomicUncertainState:
            assigned !== undefined &&
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              assigned.record.jobRunId,
              "uncertain",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          hasAtomicUnknownCancellationResolution:
            assigned !== undefined &&
            ((target.resolutions.get(assigned.record.jobRunId)?.cause ===
              "job-cancel-unknown" &&
              target.resolutions.get(assigned.record.jobRunId)?.resolution ===
                undefined) ||
              envelopeRecords.some(
                (record) =>
                  record.t === "resolution" &&
                  record.jobRunId === assigned.record.jobRunId &&
                  record.fact.subject.assignmentId === body.assignmentId &&
                  record.fact.cause === "job-cancel-unknown" &&
                  record.fact.resolution === undefined,
              )),
        });
        target.interactionSettlementFences.set(body.assignmentId, body);
        return;
      }

      case "interaction-settlement-completed": {
        assertJobInteractionSettlementCompletionReplayContract({
          fence: target.interactionSettlementFences.get(body.assignmentId),
          completion: body,
          completionAlreadyExists: target.completedInteractionSettlements.has(
            body.assignmentId,
          ),
          mirrored: target.interactionMirrors.get(body.assignmentId),
          ...("v" in body && body.v === 2 && body.streamProof
            ? { streamProof: body.streamProof }
            : {}),
        });
        target.completedInteractionSettlements.set(body.assignmentId, body);
        return;
      }

      case "cancel-proof-accepted": {
        const assigned = target.getAssigned(body.assignmentId);
        const current = assigned
          ? target.states.get(assigned.record.jobRunId)
          : undefined;
        assertCancelProofAcceptedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          acceptanceAlreadyExists: target.hasAcceptedCancellation(
            body.assignmentId,
          ),
          durableStartedObserved: target.durableStarted.has(body.assignmentId),
          proofDecision: body.proof.decision,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              target.sourceProofSlice,
              assigned,
              body.proof,
              this.#anchorEpoch,
              this.#legacyAbortTickets,
            ),
          hasAtomicCancelledState:
            assigned !== undefined &&
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              assigned.record.jobRunId,
              "cancelled",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            allJobCapabilitiesRevoked(
              envelopeRecords,
              target.revocationSlice,
              { record: assigned.record },
            ),
        });
        if (!assigned) {
          throw corruptJobJournal(
            target.kind === "main"
              ? "Accepted cancellation has no assignment"
              : "Submission guard cancellation has no assignment",
          );
        }
        this.assertAssignmentUsageFinal(assigned.record, body.proof.usageFinal);
        this.assertAssignmentResourceTerminal(
          assigned.record,
          body.proof.decision === "not-started" ? "release" : "settle-release",
          envelope.entries,
        );
        target.recordAcceptedCancellation(body);
        return;
      }

      case "execution-failure-accepted":
        target.assertExecutionFailureAccepted(body, envelopeRecords);
        return;

      case "capability-revoked": {
        const assigned = target.getAssigned(body.assignmentId);
        const key = revokedCapabilityKey(body.assignmentId, body.capId);
        assertCapabilityRevocationReplayContract({
          assignmentExists: assigned !== undefined,
          capabilityBelongsToAssignment:
            assigned?.hasCapId(body.capId) ?? false,
          alreadyRevoked: target.revokedCapabilities.has(key),
        });
        target.revokedCapabilities.add(key);
        return;
      }

      case "ticket-issued": {
        const assigned = target.getAssigned(body.ticket.assignmentId);
        const runState = assigned
          ? target.states.get(assigned.record.jobRunId)?.state
          : undefined;
        await applyJobTicketRecord({
          state: target.ticketSlice,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          taskId: this.#taskId,
          assigned: assigned?.record,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              assigned.record.assignmentId,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentClosed: target.isTicketAssignmentClosed(
            body.ticket.assignmentId,
          ),
          assignmentActive:
            assigned !== undefined &&
            (runState === "dispatched" || runState === "running") &&
            !target.cancelFences.has(body.ticket.assignmentId),
          originalSurfacePrincipal: assigned
            ? target.ingressByJob.get(assigned.record.jobRunId)?.surfacePrincipal
            : undefined,
          hasAtomicReplacementRevocation:
            body.replacesTicketId === undefined ||
            envelopeRecords.some(
              (candidate) =>
                candidate.t === "ticket-revoked" &&
                candidate.ticketId === body.replacesTicketId,
            ),
        });
        return;
      }

      case "ticket-revoked":
        await applyJobTicketRecord({
          state: target.ticketSlice,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          taskId: this.#taskId,
          assignmentIsCurrent: false,
          assignmentAcknowledged: false,
          assignmentClosed: false,
          assignmentActive: false,
        });
        return;

      case "ticket-sync-frontier":
        applyJobTicketSyncFrontier(
          target.ticketSlice,
          body.expiresThrough,
          envelope.at,
        );
        return;

      case "interaction-mirror": {
        const assigned = target.getAssigned(body.assignmentId);
        const batch = await verifyProtocolStep(() =>
          validateAssignmentInteractionMirrorBatch(body.batch, this.#verifier),
        );
        const batchKey = `${body.assignmentId}:${interactionMirrorBatchDigest(batch)}`;
        const mirrored = target.interactionMirrors.get(body.assignmentId) ?? {
          upTo: 0,
          ordinal: 0,
          digest: interactionMirrorSeed(body.assignmentId),
          requestIds: new Set<string>(),
          outcomes: new Map(),
        };
        const first = batch.entries[0]!;
        const last = batch.entries.at(-1)!;
        const auditSettlement = target.completedInteractionSettlements.has(
          body.assignmentId,
        )
          ? undefined
          : target.interactionSettlementFences.get(body.assignmentId);
        assertJobMirrorReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            target.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          executorMatches: assigned?.record.executorId === batch.executorId,
          batchBindsRecord: batch.assignmentId === body.assignmentId,
          currentState: assigned
            ? target.states.get(assigned.record.jobRunId)?.state
            : undefined,
          hasDurableCancelFence: target.cancelFences.has(body.assignmentId),
          ...(auditSettlement
            ? {
                auditSettlementTarget: {
                  upTo: auditSettlement.targetUpTo,
                  ordinal: auditSettlement.targetOrdinal,
                  mirrorDigest: auditSettlement.targetMirrorDigest,
                },
              }
            : {}),
          batchTarget: {
            upTo: last.seq,
            ordinal: last.ordinal,
            mirrorDigest: batch.mirrorDigest,
          },
          batchAlreadyMirrored: target.interactionMirrorBatches.has(batchKey),
          extendsCursor:
            batch.previousDigest === mirrored.digest &&
            first.ordinal === mirrored.ordinal + 1 &&
            first.seq > mirrored.upTo,
          repeatsRequestId: batchRepeatsDurableRequestId(
            batch,
            mirrored.requestIds,
          ),
        });
        target.interactionMirrorBatches.add(batchKey);
        target.interactionMirrors.set(body.assignmentId, {
          upTo: last.seq,
          ordinal: last.ordinal,
          digest: batch.mirrorDigest,
          requestIds: new Set([
            ...mirrored.requestIds,
            ...batch.entries.map((entry) => entry.requestId),
          ]),
          outcomes: new Map([
            ...mirrored.outcomes,
            ...batch.entries.flatMap((entry) =>
              entry.kind === "allow-once"
                ? [[entry.requestId, snapshot(entry.outcome)] as const]
                : [],
            ),
          ]),
        });
        return;
      }

      case "channel-challenge-prepared": {
        const assigned = target.getAssigned(body.assignmentId);
        target.validateChannelChallengeSource(assigned, body);
        try {
          await verifyProtocolStep(() =>
            applyChannelInteractionRecord(
              target.channelInteractions,
              body,
              this.#verifier,
            ),
          );
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
          rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      case "channel-challenge-delivered":
      case "channel-challenge-closed":
      case "channel-challenge-granted":
        try {
          await verifyProtocolStep(() =>
            applyChannelInteractionRecord(
              target.channelInteractions,
              body,
              this.#verifier,
            ),
          );
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
          rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return;

      case "channel-relay-cursor": {
        const assigned = target.getAssigned(body.assignmentId);
        target.validateRelayCursorBinding(assigned, body);
        const preparedInEnvelope = envelopeRecords.find(
          (
            candidate,
          ): candidate is Extract<
            JobJournalRecord,
            { t: "channel-challenge-prepared" }
          > =>
            candidate.t === "channel-challenge-prepared" &&
            candidate.assignmentId === body.assignmentId,
        );
        if (
          preparedInEnvelope &&
          preparedInEnvelope.frameSeq !== body.upToSeq
        ) {
          throw corruptJobJournal(
            "Prepared challenge and relay cursor must adopt the same frame",
          );
        }
        try {
          await verifyProtocolStep(() =>
            applyChannelInteractionRecord(
              target.channelInteractions,
              body,
              this.#verifier,
            ),
          );
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
          rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      case "resolution": {
        const fact = validateResolutionFact(body.fact);
        if (fact.subject.execution !== "job") {
          throw corruptJobJournal(
            "Job resolution contains a conversation subject",
          );
        }
        const jobFact = fact as JobResolutionFact;
        assertJobResolutionBinding({
          execution: jobFact.subject.execution,
          subjectTaskId: jobFact.subject.taskId,
          subjectJobRunId: jobFact.subject.jobRunId,
          recordJobRunId: body.jobRunId,
          authorityTaskId: this.#taskId,
          subjectAnchorEpoch: jobFact.subject.anchorEpoch,
          authorityAnchorEpoch: this.#anchorEpoch,
        });
        const current = target.resolutions.get(body.jobRunId);
        const assigned = target.getAssigned(jobFact.subject.assignmentId);
        const runState = target.states.get(body.jobRunId);
        if (!jobFact.resolution) {
          assertResolutionOpenReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
            assignmentIsCurrent:
              target.assignmentByJob.get(body.jobRunId) ===
              jobFact.subject.assignmentId,
            currentState: runState?.state,
            alreadyOpen: isOpenResolutionFact(current),
            cause: jobFact.cause,
            hasAtomicUncertainState:
              runState !== undefined &&
              recordsHaveJobState(
                envelopeRecords,
                body.jobRunId,
                "uncertain",
                runState.statusRevision + 1,
                jobFact.subject.assignmentId,
              ),
            hasAtomicDispatchConflict: envelopeRecords.some(
              (record) =>
                record.t === "dispatch-conflict" &&
                record.assignmentId === jobFact.subject.assignmentId &&
                record.handling === "opened-uncertain",
            ),
          });
        } else {
          const resolution = jobFact.resolution;
          if (!current || jobFact.openFactDigest !== current.openFactDigest) {
            throw corruptJobJournal(
              "Job resolution does not close its current open fact",
            );
          }
          const closesEarlierInEnvelope =
            target.assignmentByJob.get(body.jobRunId) === undefined &&
            recordsCloseJobAssignment(
              envelopeRecords,
              body.jobRunId,
              jobFact.subject.assignmentId,
            );
          assertResolutionClosureReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
            assignmentIsCurrentOrAtomicallyClosed:
              target.assignmentByJob.get(body.jobRunId) ===
                jobFact.subject.assignmentId || closesEarlierInEnvelope,
            conflictOpen: current.cause === "dispatch-conflict",
            resolutionKind: resolution.kind,
          });
          const targetState = resolutionTargetState(resolution.kind);
          assertResolutionCloseAtomicReplayContract({
            cause: current.cause,
            kind: resolution.kind,
            existingOpenMatches:
              current.openFactDigest === jobFact.openFactDigest &&
              current.resolution === undefined,
            hasAtomicTargetState:
              runState !== undefined &&
              recordsHaveJobState(
                envelopeRecords,
                body.jobRunId,
                targetState,
                runState.statusRevision +
                  (runState.state === "uncertain" ? 1 : 0),
                jobFact.subject.assignmentId,
              ),
            allCapabilitiesRevoked:
              assigned !== undefined &&
              allJobCapabilitiesRevoked(
                envelopeRecords,
                target.revocationSlice,
                { record: assigned.record },
              ),
            hasRequiredCompanion:
              resolution.kind === "late-bundle-committed"
                ? envelopeRecords.some(
                    (record) =>
                      record.t === "committed" &&
                      record.jobRunId === body.jobRunId &&
                      record.assignmentId === jobFact.subject.assignmentId,
                  )
                : resolution.kind === "proven-not-started-redispatched" ||
                    resolution.kind === "proven-not-started-cancelled"
                  ? envelopeRecords.some(
                      (record) =>
                        record.t === "assignment-superseded" &&
                        record.assignmentId === jobFact.subject.assignmentId,
                    )
                  : envelopeHasSuccessfulJobUncertainControl(
                      envelope,
                      targetState,
                      resolution.factDigest,
                    ),
          });
        }
        if (!assigned || assigned.record.jobRunId !== body.jobRunId) {
          throw corruptJobJournal("Job resolution sequence is invalid");
        }
        if (jobFact.resolution?.kind.startsWith("user-")) {
          this.assertAssignmentResourceTerminal(
            assigned.record,
            "reclaim",
            envelope.entries,
          );
        }
        target.resolutions.set(body.jobRunId, snapshot(jobFact));
        target.onResolutionRecorded(jobFact);
        return;
      }

      case "committed": {
        const assigned = target.getAssigned(body.assignmentId);
        const current = target.states.get(body.jobRunId);
        const open = target.resolutions.get(body.jobRunId);
        assertCommittedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
          assignmentIsCurrent:
            target.assignmentByJob.get(body.jobRunId) === body.assignmentId,
          currentState: current?.state,
          alreadyCommitted: target.hasCommitted(body.assignmentId),
          conflictOpen:
            open?.cause === "dispatch-conflict" &&
            open.resolution === undefined,
          commitRevisionMatchesAssignedBase:
            body.jobRevision === target.nextJobRevision,
          hasAtomicCommittedState:
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              body.jobRunId,
              "committed",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            allJobCapabilitiesRevoked(
              envelopeRecords,
              target.revocationSlice,
              { record: assigned.record },
            ),
        });
        if (!assigned) {
          throw corruptJobJournal(
            target.kind === "main"
              ? "Job commit is invalid or lacks its atomic state"
              : "Submission guard commit has no assignment",
          );
        }
        await target.applyCommitted(assigned, body, envelope);
        target.nextJobRevision += 1;
        return;
      }

      case "bundle-ack-observed": {
        const committed = target.getCommittedAckExpected(body.assignmentId);
        if (
          !committed ||
          target.bundleAcknowledgements.has(body.assignmentId) ||
          !bundleAcknowledgementBindsCommitted({
            observedBundleRef: body.bundleRef,
            observedCommitRevision: body.jobRevision,
            expectedBundleRef: committed.ref,
            expectedCommitRevision: committed.jobRevision,
          })
        ) {
          throw corruptJobJournal(
            target.kind === "main"
              ? "Bundle acknowledgement observation does not bind one committed job bundle"
              : "Submission guard bundle acknowledgement is invalid or duplicated",
          );
        }
        target.bundleAcknowledgements.set(body.assignmentId, body);
        target.onBundleAckObserved(body.assignmentId);
        return;
      }

      case "system-started": {
        const defMeta = target.getCurrentDefinitionMeta();
        const occurrence = target.getOccurrenceSummary(body.jobRunId);
        const current = target.states.get(body.jobRunId);
        const previous = target.systemFences.get(body.jobRunId);
        assertSystemJobActivationReplayContract({
          taskId: this.#taskId,
          jobRunId: body.jobRunId,
          anchorEpoch: this.#anchorEpoch,
          definitionKind: occurrence
            ? defMeta.kindForRevision(occurrence.taskRevision)
            : undefined,
          occurrence,
          currentState: current?.state,
          previousFence: previous,
          fence: body.fence,
          hasForeignRecords: envelope.entries.some(
            (record) => record.stream !== jobStream(this.#taskId),
          ),
          hasAtomicRunningState:
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              body.jobRunId,
              "running",
              current.statusRevision + 1,
              undefined,
            ),
        });
        if (occurrence) {
          target.validateSystemStartedDefinition(
            occurrence.taskRevision,
            body.fence,
          );
        }
        this.assertReplayedSystemActivation(previous, body.fence, envelope);
        target.systemFences.set(body.jobRunId, snapshot(body.fence));
        return;
      }

      case "system-result": {
        const detail = await target.loadSystemResultDetail(body);
        const defMeta = target.getCurrentDefinitionMeta();
        const current = target.states.get(body.jobRunId);
        const fence = target.systemFences.get(body.jobRunId);
        const occurrence = target.getOccurrenceSummary(body.jobRunId);
        assertSystemJobTerminalReplayContract({
          jobRunId: body.jobRunId,
          definitionKind: occurrence
            ? defMeta.kindForRevision(occurrence.taskRevision)
            : undefined,
          currentState: current?.state,
          currentFence: fence,
          resultFence: body.fence,
          resultAlreadyExists: target.hasSystemResult(body.jobRunId),
          hasForeignRecords: envelope.entries.some(
            (record) => record.stream !== jobStream(this.#taskId),
          ),
          hasAtomicTerminalState:
            current !== undefined &&
            recordsHaveJobState(
              envelopeRecords,
              body.jobRunId,
              body.outcome,
              current.statusRevision + 1,
              undefined,
            ),
        });
        this.assertReplayedSystemTerminal(body.fence, body.outcome, envelope);
        target.recordSystemResult(body, detail);
        return;
      }

      case "state": {
        const previous = target.states.get(body.jobRunId);
        const occurrence = target.getOccurrenceSummary(body.jobRunId);
        if (!previous || !occurrence) {
          throw corruptJobJournal("Job state transition is invalid");
        }
        const { closedEarlierInEnvelope, definitionKind } =
          target.validateStateDeliveryAndClosure(
            body,
            previous,
            occurrence,
            envelope,
            envelopeRecords,
          );
        const assigned = body.assignmentId
          ? target.getAssigned(body.assignmentId)
          : undefined;
        assertJobStateReplayContract({
          currentState: previous.state,
          currentRevision: previous.statusRevision,
          nextState: body.state,
          nextRevision: body.statusRevision,
          assignmentId: body.assignmentId,
          assignmentBindingValid:
            assigned !== undefined &&
            assigned.record.jobRunId === body.jobRunId &&
            (target.assignmentByJob.get(body.jobRunId) === body.assignmentId ||
              closedEarlierInEnvelope),
          systemFencePresent: target.systemFences.has(body.jobRunId),
          definitionKind,
          hasAtomicAssignment:
            body.state !== "dispatched" ||
            envelopeRecords.some(
              (record) =>
                record.t === "assigned" &&
                record.jobRunId === body.jobRunId &&
                record.assignmentId === body.assignmentId,
            ),
          hasAtomicSystemActivation: envelopeRecords.some(
            (record) =>
              record.t === "system-started" &&
              record.jobRunId === body.jobRunId,
          ),
          hasAtomicSystemResult: envelopeRecords.some(
            (record) =>
              record.t === "system-result" &&
              record.jobRunId === body.jobRunId &&
              record.outcome === body.state,
          ),
          hasAtomicExecutionFailure: recordsAcceptExecutionFailure(
            envelopeRecords,
            body,
          ),
        });
        if (
          previous.state === "queued" &&
          (body.state === "cancelled" ||
            body.state === "failed" ||
            body.state === "expired")
        ) {
          try {
            assertQueuedTerminalDequeue(
              envelope.entries,
              {
                kind: "job",
                id: body.jobRunId,
                attempt: nextJobAssignmentAttempt(
                  target.attemptSlice,
                  body.jobRunId,
                ),
              },
              body.state,
            );
          } catch (error) {
            if (error instanceof AuthorityPreparationRequired) throw error;
            throw corruptJobJournal(
              error instanceof Error
                ? error.message
                : "Queued job resource dequeue is invalid",
            );
          }
        }
        assertStateAtomicReplayContract({
          currentState: previous.state,
          nextState: body.state,
          hasAtomicCancelFence: envelopeRecords.some(
            (record) =>
              record.t === "cancel-fence" &&
              record.assignmentId === body.assignmentId,
          ),
          hasAtomicOpenResolution: envelopeRecords.some(
            (record) =>
              record.t === "resolution" &&
              record.jobRunId === body.jobRunId &&
              record.fact.subject.assignmentId === body.assignmentId &&
              record.fact.resolution === undefined,
          ),
          hasAtomicSupersede: envelopeRecords.some(
            (record) =>
              record.t === "assignment-superseded" &&
              record.assignmentId === body.assignmentId,
          ),
          hasAtomicTermination: envelopeRecords.some(
            (record) =>
              (record.t === "cancel-proof-accepted" ||
                record.t === "assignment-superseded") &&
              record.assignmentId === body.assignmentId,
          ),
          hasAtomicResolutionClose: envelopeRecords.some(
            (record) =>
              record.t === "resolution" &&
              record.jobRunId === body.jobRunId &&
              record.fact.resolution !== undefined,
          ),
          hasAtomicCommit:
            body.assignmentId === undefined ||
            envelopeRecords.some(
              (record) =>
                record.t === "committed" &&
                record.jobRunId === body.jobRunId &&
                record.assignmentId === body.assignmentId,
            ),
        });
        if (body.state === "failed" && assigned) {
          if (
            !allJobCapabilitiesRevoked(envelopeRecords, target.revocationSlice, {
              record: assigned.record,
            })
          ) {
            throw corruptJobJournal(
              "Assigned job failure is not atomic with revocation",
            );
          }
          if (body.usageFinal) {
            this.assertAssignmentUsageFinal(assigned.record, body.usageFinal);
          }
          this.assertAssignmentResourceTerminal(
            assigned.record,
            body.usageFinal ? "settle-release" : "reclaim",
            envelope.entries,
          );
        }
        target.states.set(body.jobRunId, {
          state: body.state,
          statusRevision: body.statusRevision,
        });
        if (body.state === "running" && body.assignmentId) {
          target.durableStarted.add(body.assignmentId);
        }
        target.onStateRecorded(body, previous, envelope, envelopeRecords);
        return;
      }

      default:
        return assertNever(body);
    }
  }

  assertReplayedSystemActivation(
    previousFence: SystemJobFence | undefined,
    fence: SystemJobFence,
    envelope: CommitEnvelope<unknown>,
  ): void {
    const records = envelope.entries.filter(
      (record) => record.stream !== jobStream(this.#taskId),
    );
    try {
      if (!this.#systemResources) {
        throw new Error("System job resource coordination is not configured");
      }
      assertForeignRecords(records, jobStream(this.#taskId));
      this.#systemResources.assertActivationRecords({
        ...(previousFence ? { previousFence } : {}),
        fence,
        records,
      });
    } catch (error) {
      if (error instanceof AuthorityPreparationRequired) throw error;
      throw corruptJobJournal(
        error instanceof Error
          ? `System activation resource records are invalid: ${error.message}`
          : "System activation resource records are invalid",
      );
    }
  }

  assertReplayedSystemTerminal(
    fence: SystemJobFence,
    outcome: "committed" | "failed",
    envelope: CommitEnvelope<unknown>,
  ): void {
    const records = envelope.entries.filter(
      (record) => record.stream !== jobStream(this.#taskId),
    );
    try {
      if (!this.#systemResources) {
        throw new Error("System job resource coordination is not configured");
      }
      assertForeignRecords(records, jobStream(this.#taskId));
      this.#systemResources.assertTerminalRecords({ fence, outcome, records });
    } catch (error) {
      if (error instanceof AuthorityPreparationRequired) throw error;
      throw corruptJobJournal(
        error instanceof Error
          ? `System terminal resource records are invalid: ${error.message}`
          : "System terminal resource records are invalid",
      );
    }
  }

  assertAssignmentResourceTerminal(
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    mode: "settle-release" | "release" | "reclaim",
    records: readonly LogicalRecord<unknown>[],
  ): void {
    if (
      !requiresFormalResourceCoordination({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
      })
    ) {
      return;
    }
    if (!this.#resources) {
      throw corruptJobJournal(
        "Governed job assignment has no resource coordinator",
      );
    }
    try {
      this.#resources.assertTerminalRecords({
        reservationId: assigned.reservation.reservationId,
        mode,
        records,
      });
    } catch (error) {
      if (error instanceof AuthorityPreparationRequired) throw error;
      throw corruptJobJournal(
        error instanceof Error
          ? `Job assignment resource terminal is invalid: ${error.message}`
          : "Job assignment resource terminal is invalid",
      );
    }
  }

  assertAssignmentUsageFinal(
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): void {
    if (
      !requiresFormalResourceCoordination({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
      })
    ) {
      return;
    }
    if (!this.#resources) {
      throw corruptJobJournal(
        "Governed job assignment has no resource coordinator",
      );
    }
    try {
      this.#resources.assertUsageFinal({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
        executorId: assigned.executorId,
        usageFinal,
      });
    } catch (error) {
      if (error instanceof AuthorityPreparationRequired) throw error;
      throw corruptJobJournal(
        error instanceof Error
          ? `Job assignment final usage is invalid: ${error.message}`
          : "Job assignment final usage is invalid",
      );
    }
  }
}

export function registerJobJournalProjection(
  log: AuthorityCommitLog,
  services: Omit<JobReductionOptions, "taskId">,
): RebuildableDurableProjectionIndex {
  return registerJobRunStateProjection(
    log,
    (taskId) => new JobReduction({ ...services, taskId }),
  );
}
