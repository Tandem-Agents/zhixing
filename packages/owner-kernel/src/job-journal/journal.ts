import { Buffer } from "node:buffer";
import {
  collectArtifactRefs,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveDispatchArtifactClosure,
  TransactionArtifactReferenceError,
  type ArtifactStore,
  type AuthorityCommitLog,
  type RebuildableDurableProjectionIndex,
} from "@zhixing-ai/core/authority";
import type {
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AuthorityCallContext,
  AuthorityError,
  CancelProofBody,
  ChannelInteractionGrant,
  ChannelMessageRef,
  ChannelResponderRef,
  DataPlaneTicket,
  DispatchResult,
  InteractionMirrorBatch,
  InteractionSettlementStreamProof,
  JobChannelChallengeToken,
  JobOccurrence,
  JobRunState,
  JobStatusNotice,
  LedgerEvidencePage,
  LedgerSnapshot,
  SealedBundle,
  StreamFrame,
  SupersedeProof,
  SystemHandlerId,
  SystemJobFence,
  SystemJobResourceLease,
  TaskDefinition,
  TrustRuleHitMirrorEntry,
  TrustSedimentMirrorEntry,
} from "@zhixing-ai/core/contracts";
import {
  acceptedRemoteIntervalRemainingMs,
  applyValidatedAssignmentEntry,
  assertProtocolIdentifier as assertIdentifier,
  buildJobActivationPayload,
  canonicalize,
  controlLeaseBindsDispatchEnvelope,
  createAssignmentLedgerValidationState,
  createSignedJobEnvelope,
  dispatchEnvelopeArtifact,
  interactionMirrorBatchDigest,
  interactionSettlementNeedsStreamProof,
  matchManifest,
  StreamFrameVerifier,
  streamLogicalFrameDigest,
  systemJobParamsDigest,
  validateAssignmentEntry,
  validateAssignmentInteractionMirrorBatch,
  validateAssignmentTerminationProof,
  validateCancelProof,
  validateChannelChallengeToken,
  validateChannelResponderRef,
  validateDispatchConflictProof,
  validateDispatchResult,
  validateExecutionManifest,
  validateInteractionSettlementStreamProof,
  validateJobActivation,
  validateLedgerEvidencePage,
  validateLedgerSnapshot,
  validateStreamFrame,
  validateSupersedeProof,
  validateSystemJobFence,
  validateTaskDefinition,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamVerifierCheckpoint,
  type UnsignedJobEnvelope,
} from "@zhixing-ai/core/protocol";
import type { ScheduleOccurrence } from "@zhixing-ai/core/scheduler/application";
import type { PendingChannelChallenge } from "../channel-challenge-outbox.js";
import {
  validateChannelInteractionRelayRecord,
  type ChannelInteractionRelayRecord,
  type JobChannelChallengePreparedRecord,
} from "../channel-interaction-records.js";
import type {
  ControlAdmissionJournal,
  ControlAdmissionOutcome,
  JobControlEnvelope,
  TrustedControlSource,
} from "../control-admission.js";
import { ManifestSelectionError } from "../conversation-assignment-authority.js";
import {
  assertSystemJobDefinitionReplayContract,
  corruptJobJournal,
  validateSystemJobResultDetail,
  validateSystemJobSummary,
  type JobJournalRecord,
  type MaterializedSystemJobResult,
} from "../job-run-contracts.js";
import { registerJobRunStateProjection } from "../job-run-state-index.js";
import type { AssignmentResourceCoordinator } from "../resource-governor.js";
import type { SchedulerUserNoticeJournal } from "../scheduler-user-notices.js";
import type {
  AssignmentSubmissionIdentity,
  AssignmentSubmissionPreflightPort,
  AssignmentSubmissionPreflightResult,
  DataPlaneTicketFacts,
  DataPlaneTicketIssueRequest,
} from "../shared-protocol/contracts.js";
import { validateDataPlaneTicketIssueRequest } from "../shared-protocol/data-plane-ticket-authority.js";
import {
  prepareSharedTrustRuleHitMirrorSession,
  prepareSharedTrustSediments,
} from "../shared-protocol/interaction-mirror-preparation.js";
import {
  AssignmentSerialQueue,
  type TrustRuleHitBatchState,
  type TrustRuleHitPort,
} from "../trust-rule-hits.js";
import type {
  AssignedJob,
  JobAssignmentPlan,
  JobCancelResult,
  JobChannelChallengePreparation,
  JobChannelRelayAdoption,
  JobCommitParticipant,
  JobIngressAuthorizer,
  JobInteractionRoute,
  JobJournalOptions,
  JobLifecycleEvent,
  JobRecoveryCandidate,
  JobReductionOptions,
  JobResolutionFact,
  JobSchedulerReadView,
  PendingJobDispatch,
  PendingJobFence,
  SystemJobHandler,
  SystemJobResourceCoordinator,
} from "./contracts.js";
import {
  decideAdoptChannelRelayFrame,
  decideCloseChannelChallenge,
  decideCommitInteractionMirror,
  decideCompleteInteractionSettlement,
  decideDataPlaneTicketFacts,
  decideGrantChannelChallenge,
  decideIssueDataPlaneTicket,
  decideRecordChannelChallengeDelivered,
  decideRevokeDataPlaneTicket,
  precheckJobMirrorRuleHits,
  selectChannelRelayPreparation,
  selectInteractionRoute,
  selectPendingChannelChallenges,
  selectPendingChannelGrantDeliveries,
  selectPendingInteractionSettlements,
  selectTrustRuleHitBatchState,
  selectTrustSedimentPreparationTarget,
} from "./operations/channel-tickets-mirror.js";
import {
  decideAcceptDispatchRejection,
  decideAcceptSupersedeProof,
  decideCancelJob,
  decideMarkUncertain,
  decideRequestSupersede,
  decideSubmitCancelProof,
  selectPendingCancellations,
  selectPendingSupersedes,
} from "./operations/control-cancel-supersede.js";
import {
  decideAcknowledgeDispatch,
  decideAssignOccurrence,
  decideOpenInteractionSettlementFence,
  decideReconcileStarted,
  decideRecordDispatchConflict,
  materializeRecoveryCandidates,
  selectDispatchesAwaitingStarted,
  selectExistingAssignmentForPlan,
  selectPendingDispatches,
  selectRecoveryCandidatesFromFacts,
  selectReplayAssignment,
} from "./operations/dispatch-assign.js";
import {
  decideApplyJobControl,
  decideCloseQueued,
  decideDefineTask,
  decideNoteCapabilityGap,
  decideSettleSchedulerAutoDisable,
  decideTriggerOccurrence,
  selectOccurrence,
  selectOccurrencesPage,
  selectPendingMissedOccurrences,
  selectSchedulerPolicy,
  selectSchedulerReadView,
  selectTaskMutationRevision,
} from "./operations/task-schedule.js";
import {
  decideFailAssigned,
  decideObserveBundleAcknowledgement,
  decideReportStarted,
  decideSystemJobActivation,
  decideSystemJobRecoveryReplacement,
  decideSystemJobTerminal,
  selectBundleAcknowledgementPreflight,
  selectResumableSystemJobs,
} from "./operations/terminal-commit-system.js";
import {
  assertLedgerAcknowledgesCommittedBundle,
  jobStatusNotice,
} from "./replay/bundle-closure.js";
import { JobReduction } from "./replay/reduction.js";
import { materializeDispatch } from "./state/assignment-control.js";
import {
  assertArtifactsPresent,
  assertCanonicalTime,
  assertPositive,
  errorMessage,
  jobStream,
  prepareJobStored,
  rejected,
  snapshot,
  withoutSignature,
} from "./state/common.js";
import {
  assertForeignRecords,
  assertSystemLease,
  taskRevisionRecord,
} from "./state/task-schedule.js";
import {
  decideLockedJobBundleSubmission,
  preflightJobBundleGuard,
  prepareJobBundleSubmission,
  type JobSubmissionGuardAccess,
} from "./submission/prepared-submission.js";
import { JobTransactionCoordinator } from "./transaction/coordinator.js";

/**
 * 为日志登记作业域持久投影。同一运行时的作业日志共用这组协议与资源服务；在任何作业日志
 * 建立之前（例如启动时列出要恢复的任务）也可先登记。
 */
export function registerJobJournalProjection(
  log: AuthorityCommitLog,
  services: Omit<JobReductionOptions, "taskId">,
): RebuildableDurableProjectionIndex {
  return registerJobRunStateProjection(
    log,
    (taskId) => new JobReduction({ ...services, taskId }),
  );
}

export class JobJournal implements AssignmentSubmissionPreflightPort {
  readonly #taskId: string;
  readonly #anchorEpoch: number;
  readonly #artifacts: ArtifactStore;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #snapshotFor: JobJournalOptions["snapshotFor"];
  readonly #ingress: JobIngressAuthorizer;
  readonly #legacyAbortTickets: JobJournalOptions["legacyAbortTickets"];
  readonly #delivery: JobJournalOptions["delivery"];
  readonly #commitParticipant: JobCommitParticipant | undefined;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #systemResources: SystemJobResourceCoordinator | undefined;
  readonly #systemHandlers: ReadonlyMap<SystemHandlerId, SystemJobHandler>;
  readonly #clock: () => string;
  readonly #schedulerNotices: SchedulerUserNoticeJournal | undefined;
  readonly #localExecutorId: string | undefined;
  readonly #trustSediments: JobJournalOptions["trustSediments"];
  readonly #trustRuleHits: TrustRuleHitPort | undefined;
  readonly #mirrorQueue = new AssignmentSerialQueue();
  readonly #systemRuns = new Map<string, Promise<"committed" | "failed">>();
  readonly #coordinator: JobTransactionCoordinator;
  readonly #guardAccess: JobSubmissionGuardAccess;

  constructor(options: JobJournalOptions) {
    assertIdentifier(options.taskId, "Task id");
    assertPositive(options.anchorEpoch, "Anchor epoch");
    this.#taskId = options.taskId;
    this.#anchorEpoch = options.anchorEpoch;
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#snapshotFor = options.snapshotFor;
    this.#ingress = options.ingress;
    this.#legacyAbortTickets = options.legacyAbortTickets;
    this.#delivery = options.delivery;
    this.#commitParticipant = options.commitParticipant;
    this.#resources = options.resources;
    this.#systemResources = options.systemResources;
    this.#systemHandlers = options.systemHandlers ?? new Map();
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#schedulerNotices = options.schedulerNotices;
    this.#localExecutorId = options.localExecutorId;
    this.#trustSediments = options.trustSediments;
    this.#trustRuleHits = options.trustRuleHits;
    this.#coordinator = new JobTransactionCoordinator({
      taskId: this.#taskId,
      anchorEpoch: this.#anchorEpoch,
      log: options.log,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      submission: options.submission,
      ...(this.#legacyAbortTickets
        ? { legacyAbortTickets: this.#legacyAbortTickets }
        : {}),
      delivery: this.#delivery,
      ...(this.#resources ? { resources: this.#resources } : {}),
      ...(this.#systemResources
        ? { systemResources: this.#systemResources }
        : {}),
      clock: this.#clock,
      ...(options.schedulerFailureThreshold !== undefined
        ? { schedulerFailureThreshold: options.schedulerFailureThreshold }
        : {}),
      ...(this.#schedulerNotices
        ? { schedulerNotices: this.#schedulerNotices }
        : {}),
      ...(this.#localExecutorId
        ? { localExecutorId: this.#localExecutorId }
        : {}),
    });
    const coordinator = this.#coordinator;
    this.#guardAccess = {
      taskId: this.#taskId,
      authenticateSubmission: (context, identity) =>
        coordinator.authenticateSubmission(context, identity),
      loadSubmissionGuard: (context, identity) =>
        coordinator.loadSubmissionGuard(context, identity),
      hasCurrentSubmissionAuthority: (context) =>
        coordinator.hasCurrentSubmissionAuthority(context),
      authorizeGuardSubmission: (guard, context, authorization) =>
        coordinator.authorizeGuardSubmission(guard, context, authorization),
      assertAssignmentUsageFinal: (assigned, usageFinal) =>
        coordinator.assertAssignmentUsageFinal(assigned, usageFinal),
    };
  }

  onStatus(
    listener: (notice: JobStatusNotice) => void | Promise<void>,
  ): () => void {
    return this.#coordinator.onStatus(listener);
  }

  onLifecycle(
    listener: (event: JobLifecycleEvent) => void | Promise<void>,
  ): () => void {
    return this.#coordinator.onLifecycle(listener);
  }

  async channelRelayCheckpoint(
    assignmentId: string,
  ): Promise<StreamVerifierCheckpoint | undefined> {
    assertIdentifier(assignmentId, "Channel relay assignmentId");
    return this.#coordinator.select((facts) => {
      const cursor =
        facts.channel.channelInteractions.cursorByAssignment.get(assignmentId);
      return cursor ? structuredClone(cursor.checkpoint) : undefined;
    });
  }

  async prepareChannelRelayRequest(
    frameInput: StreamFrame,
  ): Promise<JobChannelChallengePreparation> {
    const frame = validateStreamFrame(frameInput);
    const ref = frame.ref;
    const payload = frame.payload;
    if (
      ref.execution !== "job" ||
      ref.taskId !== this.#taskId ||
      ref.anchorEpoch !== this.#anchorEpoch ||
      payload.kind !== "interaction" ||
      payload.event.t !== "requested"
    ) {
      throw new TypeError(
        "Job channel preparation requires a requested interaction frame",
      );
    }
    const event = payload.event;
    const acceptedAt = this.#clock();
    const remainingMs = acceptedRemoteIntervalRemainingMs({
      issuedAt: event.issuedAt,
      expiry: event.expiresAt,
      acceptedAt,
      maxTtlMs: 24 * 60 * 60 * 1_000,
    });
    const issuedAt = new Date(
      Math.max(Date.parse(acceptedAt), Date.parse(event.issuedAt)),
    ).toISOString();
    const expiry = new Date(
      Math.min(Date.parse(event.expiresAt), Date.parse(acceptedAt) + remainingMs),
    ).toISOString();
    if (Date.parse(expiry) <= Date.parse(issuedAt)) {
      return { kind: "no-interactive-surface" };
    }
    return this.#coordinator.select((facts) =>
      selectChannelRelayPreparation({
        frame,
        ref,
        event,
        issuedAt,
        expiry,
        signer: this.#signer,
        verifier: this.#verifier,
        facts,
      }),
    );
  }

  async adoptChannelRelayFrame(input: {
    readonly frame: StreamFrame;
    readonly checkpoint: StreamVerifierCheckpoint;
    readonly prepared?: JobChannelChallengePreparedRecord;
  }): Promise<JobChannelRelayAdoption> {
    const frame = validateStreamFrame(input.frame);
    const checkpoint = new StreamFrameVerifier(input.checkpoint).checkpoint();
    const ref = frame.ref;
    if (
      ref.execution !== "job" ||
      ref.taskId !== this.#taskId ||
      ref.anchorEpoch !== this.#anchorEpoch ||
      checkpoint.assignmentId !== frame.assignmentId ||
      canonicalize(checkpoint.ref) !== canonicalize(frame.ref) ||
      checkpoint.lastSeq !== frame.seq ||
      checkpoint.streamEpoch !== frame.streamEpoch ||
      checkpoint.lastLogicalDigest !== streamLogicalFrameDigest(frame)
    ) {
      throw new TypeError(
        "Channel relay frame and verifier checkpoint are inconsistent",
      );
    }
    const prepared =
      input.prepared === undefined
        ? undefined
        : ((await verifyProtocolStep(() =>
            validateChannelInteractionRelayRecord(
              input.prepared,
              this.#verifier,
            ),
          )) as JobChannelChallengePreparedRecord);
    const cursor = (await verifyProtocolStep(() =>
      validateChannelInteractionRelayRecord(
        {
          t: "channel-relay-cursor",
          jobRunId: ref.jobRunId,
          assignmentId: frame.assignmentId,
          upToSeq: frame.seq,
          checkpoint,
        },
        this.#verifier,
      ),
    )) as Extract<
      ChannelInteractionRelayRecord,
      { readonly t: "channel-relay-cursor" }
    >;
    const candidateReferences = prepared ? collectArtifactRefs(prepared) : [];
    const transaction = await this.#coordinator.transact<JobChannelRelayAdoption>(
      (facts, context) =>
        decideAdoptChannelRelayFrame({
          taskId: this.#taskId,
          frame,
          ref,
          checkpoint,
          prepared,
          cursor,
          at: context.at,
          facts,
        }),
      candidateReferences,
    );
    return transaction.value;
  }

  async grantChannelChallenge(input: {
    readonly token: JobChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly decision: {
      readonly allowed: boolean;
      readonly reason?: string;
    };
    readonly at?: string;
  }): Promise<ChannelInteractionGrant> {
    const token = await verifyProtocolStep(() =>
      validateChannelChallengeToken(input.token, this.#verifier),
    );
    if (token.ref.execution !== "job") {
      throw new TypeError("Job channel callback requires a job token");
    }
    const jobToken = token as JobChannelChallengeToken;
    const responder = validateChannelResponderRef(input.responder);
    const at = input.at ?? this.#clock();
    const transaction = await this.#coordinator.transact<ChannelInteractionGrant>(
      (facts) =>
        decideGrantChannelChallenge({
          taskId: this.#taskId,
          jobToken,
          responder,
          decision: input.decision,
          at,
          signer: this.#signer,
          verifier: this.#verifier,
          facts,
        }),
    );
    return transaction.value;
  }

  async taskMutationRevision(
    operationId: string,
    operationDigest: string,
  ): Promise<number | undefined> {
    assertIdentifier(operationId, "Task mutation operationId");
    return this.#coordinator.select((facts) =>
      selectTaskMutationRevision(facts.task, operationId, operationDigest),
    );
  }

  async schedulerPolicy(jobRunIds: readonly string[] = []): Promise<{
    readonly legacyNextFire?: Extract<JobJournalRecord, { t: "legacy-next-fire" }>;
    readonly missedNextFireByRun: ReadonlyMap<
      string,
      Extract<JobJournalRecord, { t: "missed-next-fire" }>
    >;
    readonly failurePolicyByRun: ReadonlyMap<
      string,
      Extract<JobJournalRecord, { t: "failure-policy" }>
    >;
    readonly pendingAutoDisable: readonly Extract<
      JobJournalRecord,
      { t: "failure-policy" }
    >[];
  }> {
    for (const jobRunId of jobRunIds) {
      assertIdentifier(jobRunId, "Scheduler policy jobRunId");
    }
    return this.#coordinator.select((facts) =>
      selectSchedulerPolicy(facts, jobRunIds),
    );
  }

  async noteCapabilityGap(input: {
    readonly jobRunId: string;
    readonly capabilityRevision: number;
    readonly reason: string;
    readonly context: AuthorityCallContext;
  }): Promise<void> {
    if (!this.#schedulerNotices) {
      throw new Error("Scheduler notice authority is unavailable");
    }
    if (input.context.principal.kind !== "host") {
      throw new Error("Scheduler capability-gap observation is host-owned");
    }
    assertIdentifier(input.jobRunId, "Capability gap jobRunId");
    assertPositive(input.capabilityRevision, "Capability gap revision");
    if (input.reason.length === 0) {
      throw new TypeError("Capability gap reason is required");
    }
    const schedulerNotices = this.#schedulerNotices;
    await this.#coordinator.transact<void>((facts, prefix) =>
      decideNoteCapabilityGap({
        taskId: this.#taskId,
        jobRunId: input.jobRunId,
        capabilityRevision: input.capabilityRevision,
        reason: input.reason,
        now: this.#clock(),
        prefix,
        schedulerNotices,
        facts,
      }),
    );
    await schedulerNotices.publishNew();
  }

  async settleSchedulerAutoDisable(input: {
    readonly jobRunId: string;
    readonly disabledTaskRevision: number;
    readonly context: AuthorityCallContext;
  }): Promise<void> {
    if (input.context.principal.kind !== "host") {
      throw new Error("Scheduler policy settlement is host-owned");
    }
    await this.#coordinator.transact<void>((facts) =>
      decideSettleSchedulerAutoDisable({
        taskId: this.#taskId,
        jobRunId: input.jobRunId,
        disabledTaskRevision: input.disabledTaskRevision,
        facts,
      }),
    );
  }

  async pendingChannelGrantDeliveries(): Promise<
    readonly ChannelInteractionGrant[]
  > {
    return this.#coordinator.select((facts) =>
      selectPendingChannelGrantDeliveries(facts),
    );
  }

  async interactionRoute(assignmentId: string): Promise<JobInteractionRoute> {
    assertIdentifier(assignmentId, "Interaction route assignmentId");
    return this.#coordinator.select((facts) =>
      selectInteractionRoute(facts, assignmentId),
    );
  }

  async pendingChannelChallenges(): Promise<readonly PendingChannelChallenge[]> {
    return this.#coordinator.select((facts) =>
      selectPendingChannelChallenges(facts),
    );
  }

  async recordChannelChallengeDelivered(input: {
    readonly challengeId: string;
    readonly receipt: {
      readonly acceptedAt: string;
      readonly platformMessage?: ChannelMessageRef;
    };
  }): Promise<void> {
    const record = (await verifyProtocolStep(() =>
      validateChannelInteractionRelayRecord(
        {
          t: "channel-challenge-delivered",
          challengeId: input.challengeId,
          receipt: input.receipt,
        },
        this.#verifier,
      ),
    )) as Extract<
      ChannelInteractionRelayRecord,
      { readonly t: "channel-challenge-delivered" }
    >;
    await this.#coordinator.transact<void>((facts) =>
      decideRecordChannelChallengeDelivered(
        facts,
        this.#taskId,
        input.challengeId,
        record,
      ),
    );
  }

  async closeChannelChallenge(input: {
    readonly challengeId: string;
    readonly outcome: "cancelled" | "expired";
    readonly at: string;
  }): Promise<void> {
    const record = (await verifyProtocolStep(() =>
      validateChannelInteractionRelayRecord(
        {
          t: "channel-challenge-closed",
          challengeId: input.challengeId,
          outcome: input.outcome,
          at: input.at,
        },
        this.#verifier,
      ),
    )) as Extract<
      ChannelInteractionRelayRecord,
      { readonly t: "channel-challenge-closed" }
    >;
    await this.#coordinator.transact<void>((facts) =>
      decideCloseChannelChallenge(
        facts,
        this.#taskId,
        input.challengeId,
        record,
      ),
    );
  }

  async define(
    definition: TaskDefinition,
    context: AuthorityCallContext,
    policy?: {
      readonly kind: "legacy-import";
      readonly nextFire: string;
      readonly scheduleDigest: string;
      readonly legacyDigest: string;
    },
    operation?: {
      readonly operationId: string;
      readonly operationDigest: string;
      readonly expectedRevision?: number;
    },
  ): Promise<{ readonly taskRevision: number; readonly replayed: boolean }> {
    const candidate = validateTaskDefinition(definition);
    if (candidate.taskId !== this.#taskId) {
      throw new TypeError("Task definition belongs to a different job journal");
    }
    this.#ingress.authorize(
      context,
      candidate.definition.kind === "system" ? "system-trigger" : "user-trigger",
      candidate,
    );
    if (operation) {
      assertIdentifier(operation.operationId, "Task mutation operationId");
      if (!/^sha256:[a-f0-9]{64}$/.test(operation.operationDigest)) {
        throw new TypeError("Task mutation operation digest is invalid");
      }
      const replay = await this.taskMutationRevision(
        operation.operationId,
        operation.operationDigest,
      );
      if (replay !== undefined) {
        return { taskRevision: replay, replayed: true };
      }
    }
    const prepared = await prepareJobStored(
      candidate,
      (stored) => taskRevisionRecord(candidate, stored, operation),
      this.#artifacts,
    );
    const revision = await this.#coordinator.transact<{
      readonly taskRevision: number;
      readonly replayed: boolean;
    }>(
      (facts, prefix) =>
        decideDefineTask({
          taskId: this.#taskId,
          candidate,
          stored: prepared.stored,
          ...(policy ? { policy } : {}),
          ...(operation ? { operation } : {}),
          nextLsn: prefix.nextLsn,
          resources: this.#resources,
          systemResources: this.#systemResources,
          facts,
        }),
      prepared.references,
    );
    return revision.value;
  }

  async trigger(input: {
    readonly jobRunId: string;
    readonly scheduledFor: string;
    readonly context: AuthorityCallContext;
    readonly source: "user" | "system";
    /** User tasks missed while the anchor was offline are recorded, never backfilled. */
    readonly disposition?: "due" | "missed-offline";
    readonly missedNextFire?: {
      readonly readyBoundary: string;
      readonly nextFire?: string;
    };
  }): Promise<JobOccurrence> {
    assertIdentifier(input.jobRunId, "Job run id");
    assertCanonicalTime(input.scheduledFor, "Job scheduled time");
    const transaction = await this.#coordinator.transact<JobOccurrence>(
      (facts) =>
        decideTriggerOccurrence({
          taskId: this.#taskId,
          jobRunId: input.jobRunId,
          scheduledFor: input.scheduledFor,
          source: input.source,
          ...(input.disposition ? { disposition: input.disposition } : {}),
          ...(input.missedNextFire
            ? { missedNextFire: input.missedNextFire }
            : {}),
          authorize: (definition) =>
            this.#ingress.authorize(
              input.context,
              input.source === "user" ? "user-trigger" : "system-trigger",
              definition,
            ),
          resources: this.#resources,
          facts,
        }),
    );
    return transaction.value;
  }

  async assign(plan: JobAssignmentPlan): Promise<PendingJobDispatch> {
    if (plan.taskId !== this.#taskId) {
      throw new TypeError("Dispatch belongs to a different task journal");
    }
    if (plan.anchorEpoch !== this.#anchorEpoch) {
      throw new TypeError("Dispatch belongs to a different anchor epoch");
    }
    assertIdentifier(plan.assignmentId, "Assignment id");
    assertIdentifier(plan.executorId, "Executor id");
    const manifest = validateExecutionManifest(plan.manifest);
    if (
      manifest.baseRef.execution !== "job" ||
      manifest.baseRef.taskId !== plan.taskId ||
      manifest.baseRef.jobRunId !== plan.jobRunId
    ) {
      throw new TypeError(
        "Assignment plan manifest does not bind the job occurrence",
      );
    }
    const existingState = await this.#coordinator.select((facts) =>
      selectExistingAssignmentForPlan(facts, plan.jobRunId, plan.assignmentId),
    );
    if (existingState.currentAssignment) {
      throw new Error(
        "Job occurrence is already assigned; replay its durable assignment",
      );
    }
    if (existingState.assignmentIdInUse) {
      throw new Error("Assignment id already belongs to another occurrence");
    }
    const target = this.#snapshotFor(plan.executorId);
    if (target === undefined) {
      throw new ManifestSelectionError({
        code: "capability-gap",
        message: "Executor capability snapshot is unavailable",
        retryable: true,
      });
    }
    const compatibility = matchManifest(
      manifest,
      target.descriptor,
      target.inventory,
    );
    if (!compatibility.ok) throw new ManifestSelectionError(compatibility.error);
    const unsigned = plan.materialize();
    if (
      unsigned.work.taskId !== plan.taskId ||
      unsigned.work.jobRunId !== plan.jobRunId ||
      unsigned.work.fence.anchorEpoch !== plan.anchorEpoch ||
      unsigned.assignmentId !== plan.assignmentId ||
      unsigned.executorId !== plan.executorId ||
      canonicalize(unsigned.manifest) !== canonicalize(manifest)
    ) {
      throw new TypeError(
        "Materialized assignment does not match its preflight plan",
      );
    }
    const envelope = createSignedJobEnvelope(
      unsigned,
      this.#signer,
      this.#verifier,
    );
    const references = [
      ...(await resolveDispatchArtifactClosure(envelope, this.#artifacts))
        .transfer,
    ];
    const artifact = dispatchEnvelopeArtifact(envelope);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Dispatch artifact store returned a different reference");
    }
    const transaction = await this.#coordinator.transact<string>(
      (facts) =>
        decideAssignOccurrence({
          taskId: this.#taskId,
          anchorEpoch: this.#anchorEpoch,
          envelope,
          dispatchRef: artifact.ref,
          resources: this.#resources,
          facts,
        }),
      [artifact.ref, ...references],
    );
    const assigned = transaction.facts.assignment.getAssigned(transaction.value);
    if (!assigned) {
      throw corruptJobJournal("Assigned job did not replay its outbox fact");
    }
    return transaction.facts.assignment.materializeDispatch(
      assigned,
      this.#signer,
    );
  }

  async replayAssignment(unsigned: UnsignedJobEnvelope): Promise<PendingJobDispatch> {
    if (unsigned.work.taskId !== this.#taskId) {
      throw new TypeError("Dispatch belongs to a different task journal");
    }
    const current = await this.#coordinator.select((facts) =>
      selectReplayAssignment(facts, unsigned.work.jobRunId),
    );
    if (
      current === undefined ||
      current.record.assignmentId !== unsigned.assignmentId ||
      canonicalize(withoutSignature(current.envelope)) !== canonicalize(unsigned)
    ) {
      throw new Error("Durable job assignment does not match the replay request");
    }
    return materializeDispatch(current, this.#signer);
  }

  async pendingDispatches(): Promise<PendingJobDispatch[]> {
    const assignments = await this.#coordinator.select((facts) =>
      selectPendingDispatches(facts),
    );
    return assignments.map((assigned) =>
      materializeDispatch(assigned, this.#signer),
    );
  }

  async dispatchesAwaitingStarted(): Promise<PendingJobDispatch[]> {
    const assignments = await this.#coordinator.select((facts) =>
      selectDispatchesAwaitingStarted(facts),
    );
    return assignments.map((assigned) =>
      materializeDispatch(assigned, this.#signer),
    );
  }

  async assignmentsAwaitingRecovery(): Promise<JobRecoveryCandidate[]> {
    const assignments = await this.#coordinator.select((facts) =>
      selectRecoveryCandidatesFromFacts(
        facts,
        facts.assignment.listRecoveryAndAckOutboxAssignmentIdsByCommit(),
      ),
    );
    return assignments.map(({ assigned, ...candidate }) => ({
      ...candidate,
      dispatch: materializeDispatch(
        assigned as unknown as AssignedJob,
        this.#signer,
      ),
    }));
  }

  async assignmentAwaitingRecovery(
    assignmentId: string,
  ): Promise<JobRecoveryCandidate | undefined> {
    assertIdentifier(assignmentId, "Recovery assignment id");
    const assignments = await this.#coordinator.select((facts) => {
      const candidateIds =
        facts.assignment.hasRecoveryAssignment(assignmentId) ||
        facts.channel.hasBundleAckOutbox(assignmentId)
          ? [assignmentId]
          : [];
      return materializeRecoveryCandidates(
        facts,
        selectRecoveryCandidatesFromFacts(facts, candidateIds),
        this.#signer,
      );
    });
    return assignments.at(0);
  }

  async observeBundleAcknowledgement(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const ledger = await verifyProtocolStep(() =>
      validateLedgerSnapshot(rawSnapshot, this.#verifier),
    );
    if (
      ledger.assignmentId !== assignmentId ||
      ledger.phase !== "acked" ||
      ledger.sealedBundleRef === undefined ||
      ledger.acknowledgedCommitRevision === undefined
    ) {
      throw new TypeError(
        "Ledger snapshot does not prove acknowledgement of the committed job bundle",
      );
    }
    const preflight = await this.#coordinator.select((facts) =>
      selectBundleAcknowledgementPreflight(facts, assignmentId),
    );
    assertLedgerAcknowledgesCommittedBundle(ledger, preflight.expected);
    if (preflight.existing) {
      if (
        canonicalize(preflight.existing) !== canonicalize(preflight.expected)
      ) {
        throw corruptJobJournal(
          "Bundle acknowledgement observation is inconsistent",
        );
      }
      return;
    }
    await this.#coordinator.transact<void>(
      (facts) =>
        decideObserveBundleAcknowledgement({
          taskId: this.#taskId,
          assignmentId,
          ledger,
          preflightExpected: preflight.expected,
          facts,
        }),
      [preflight.expected.bundleRef],
    );
  }

  async validateExecutorLedgerSnapshot(input: unknown): Promise<LedgerSnapshot> {
    return verifyProtocolStep(() =>
      validateLedgerSnapshot(input, this.#verifier),
    );
  }

  async reconcileStarted(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const ledger = await verifyProtocolStep(() =>
      validateLedgerSnapshot(rawSnapshot, this.#verifier),
    );
    if (
      ledger.assignmentId !== assignmentId ||
      (ledger.phase !== "started" &&
        ledger.phase !== "sealed" &&
        ledger.phase !== "acked")
    ) {
      throw new TypeError(
        "Ledger snapshot does not prove a started job assignment",
      );
    }
    await this.#coordinator.transact<void>((facts) =>
      decideReconcileStarted(facts, this.#taskId, assignmentId),
    );
  }

  async reconcileCancellationEvidence(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
    pages: AsyncIterable<LedgerEvidencePage>,
  ): Promise<boolean> {
    const ledger = await verifyProtocolStep(() =>
      validateLedgerSnapshot(rawSnapshot, this.#verifier),
    );
    if (
      ledger.assignmentId !== assignmentId ||
      ledger.lastSeq <= 0 ||
      ledger.cancelProof !== undefined ||
      ledger.sealedBundleRef !== undefined ||
      ledger.phase === "halted" ||
      ledger.phase === "failed" ||
      ledger.phase === "sealed" ||
      ledger.phase === "acked"
    ) {
      throw new TypeError(
        "Ledger snapshot is not an unresolved job cancellation prefix",
      );
    }
    const assigned = await this.#coordinator.select((facts) => {
      const candidate = facts.assignment.getAssigned(assignmentId);
      if (
        !candidate ||
        facts.assignment.getAssignmentIdForJob(candidate.record.jobRunId) !==
          assignmentId
      ) {
        return undefined;
      }
      return snapshot(candidate as unknown as AssignedJob);
    });
    if (!assigned) {
      throw new Error("Ledger evidence names a historical job assignment");
    }
    let expectedSeq = 1;
    const validation = createAssignmentLedgerValidationState(assignmentId);
    for await (const rawPage of pages) {
      const page = await verifyProtocolStep(() =>
        validateLedgerEvidencePage(rawPage, this.#verifier),
      );
      if (
        page.assignmentId !== assignmentId ||
        page.executorId !== assigned.record.executorId ||
        page.fromSeq !== expectedSeq ||
        page.toSeq > ledger.lastSeq
      ) {
        throw new TypeError(
          "Ledger evidence page does not bind the job assignment prefix",
        );
      }
      for (const rawEntry of page.entries) {
        let body: AssignmentRecord;
        if ("ref" in rawEntry.body) {
          const bytes = await this.#artifacts.get(rawEntry.body.ref);
          const text = Buffer.from(bytes).toString("utf8");
          const parsed = JSON.parse(text) as unknown;
          if (canonicalize(parsed) !== text) {
            throw new TypeError("Ledger evidence artifact is not canonical");
          }
          body = (
            await verifyProtocolStep(() =>
              validateAssignmentEntry(
                { recordSeq: rawEntry.recordSeq, body: parsed },
                this.#verifier,
              ),
            )
          ).body;
        } else {
          body = (
            await verifyProtocolStep(() =>
              validateAssignmentEntry(rawEntry, this.#verifier),
            )
          ).body;
        }
        if (
          body.t === "control-lease-renewed" &&
          !controlLeaseBindsDispatchEnvelope(body.lease, assigned.envelope)
        ) {
          throw new TypeError(
            "Control lease evidence does not bind the durable job assignment",
          );
        }
        if (body.t === "received") {
          const activation = await verifyProtocolStep(() =>
            validateJobActivation({
              envelope: assigned.envelope,
              activation: body.activation as AssignmentActivationProof<"job">,
              dispatchRef: assigned.record.dispatchRef,
              verifier: this.#verifier,
            }),
          );
          const expectedActivation = buildJobActivationPayload({
            envelope: assigned.envelope,
            dispatchRef: assigned.record.dispatchRef,
            commit: {
              lsn: assigned.commit.lsn,
              envelopeDigest: assigned.commit.envelopeDigest,
            },
            issuedAt: assigned.commit.at,
          });
          if (
            canonicalize(body.envelope.ref) !==
              canonicalize(assigned.record.dispatchRef) ||
            canonicalize(activation) !== canonicalize(expectedActivation)
          ) {
            throw new TypeError(
              "Received evidence does not bind the durable job assignment",
            );
          }
        }
        const entry: AssignmentEntry = { recordSeq: rawEntry.recordSeq, body };
        applyValidatedAssignmentEntry(validation, entry);
        expectedSeq += 1;
      }
      if (page.chainDigest !== validation.chainDigest) {
        throw new TypeError(
          "Ledger evidence page chain digest is invalid",
        );
      }
    }
    if (
      expectedSeq !== ledger.lastSeq + 1 ||
      validation.lastSeq !== ledger.lastSeq ||
      validation.phase !== ledger.phase
    ) {
      throw new TypeError(
        "Ledger evidence does not close the job snapshot prefix",
      );
    }
    if (validation.aborts.size === 0) return false;
    const abortTicket = [...validation.aborts.values()].find(
      (
        abort,
      ): abort is Extract<
        (typeof validation.aborts extends Map<string, infer T> ? T : never),
        { readonly via: "abort-ticket" }
      > => abort.via === "abort-ticket",
    );
    if (!abortTicket || validation.unmirroredFinished.size === 0) {
      await this.markUncertain(assignmentId, "job-cancel-unknown");
      return true;
    }
    const targetUpTo = Math.max(...validation.unmirroredFinished.keys());
    const settlement =
      validation.streamProjectionEnabledAfter !== undefined
        ? {
            v: 2 as const,
            t: "interaction-settlement-fence" as const,
            assignmentId,
            executorId: assigned.record.executorId,
            ticketDigest: abortTicket.refId,
            sourceLastSeq: abortTicket.recordSeq,
            sourceChainDigest: abortTicket.ledgerDigest,
            targetUpTo,
            targetOrdinal: validation.finishedInteractionCount,
            targetMirrorDigest: validation.interactionMirrorDigest,
            ...(interactionSettlementNeedsStreamProof(validation)
              ? {
                  targetInteractionRecordSeq:
                    validation.lastFinishedInteractionRecordSeq,
                }
              : {}),
          }
        : {
            t: "interaction-settlement-fence" as const,
            assignmentId,
            ticketDigest: abortTicket.refId,
            sourceLastSeq: abortTicket.recordSeq,
            sourceChainDigest: abortTicket.ledgerDigest,
            targetUpTo,
            targetOrdinal: validation.finishedInteractionCount,
            targetMirrorDigest: validation.interactionMirrorDigest,
          };
    await this.#coordinator.transact<void>((facts) =>
      decideOpenInteractionSettlementFence({
        taskId: this.#taskId,
        anchorEpoch: this.#anchorEpoch,
        assignmentId,
        settlement,
        openedAt: this.#clock(),
        facts,
      }),
    );
    return true;
  }

  async acknowledgeDispatch(assignmentId: string): Promise<void> {
    assertIdentifier(assignmentId, "Assignment id");
    await this.#coordinator.transact<void>((facts) =>
      decideAcknowledgeDispatch(facts, this.#taskId, assignmentId),
    );
  }

  async issueDataPlaneTicket(
    input: DataPlaneTicketIssueRequest,
  ): Promise<DataPlaneTicket> {
    validateDataPlaneTicketIssueRequest(input);
    const transaction = await this.#coordinator.transact<DataPlaneTicket>(
      (facts, authorityPrefix) =>
        decideIssueDataPlaneTicket({
          taskId: this.#taskId,
          request: input,
          issuedAt: authorityPrefix.at,
          signer: this.#signer,
          facts,
        }),
    );
    return transaction.value;
  }

  async revokeDataPlaneTicket(ticketId: string): Promise<boolean> {
    assertIdentifier(ticketId, "Revoked ticket id");
    const transaction = await this.#coordinator.transact<boolean>((facts) =>
      decideRevokeDataPlaneTicket(facts, this.#taskId, ticketId),
    );
    return transaction.value;
  }

  async dataPlaneTicketFacts(): Promise<DataPlaneTicketFacts> {
    const transaction = await this.#coordinator.transact<DataPlaneTicketFacts>(
      (facts, authorityPrefix) =>
        decideDataPlaneTicketFacts(facts, this.#taskId, authorityPrefix.at),
    );
    return transaction.value;
  }

  async preflightSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<AssignmentSubmissionPreflightResult> {
    return preflightJobBundleGuard({
      context,
      identity,
      guardAccess: this.#guardAccess,
    });
  }

  async reportStarted(
    assignmentId: string,
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#coordinator.authenticateSubmission(context, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#coordinator.loadSubmissionGuard(context, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#coordinator.transact<void>((facts) =>
      decideReportStarted({
        taskId: this.#taskId,
        assignmentId,
        authorizeReplay: () =>
          this.#coordinator.authorizeSubmission(facts, context, {
            mode: "durable-replay",
            method: "submission.reportStarted",
            assignmentId,
          }),
        authorizeActive: () =>
          this.#coordinator.authorizeSubmission(facts, context, {
            mode: "active",
            method: "submission.reportStarted",
            assignmentId,
          }),
        facts,
      }),
    );
  }

  async mirrorInteractions(
    assignmentId: string,
    rawBatch: InteractionMirrorBatch,
    context: AuthorityCallContext,
  ): Promise<{
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }> {
    this.#coordinator.authenticateSubmission(context, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    await this.#coordinator.loadSubmissionGuard(context, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    if (
      Buffer.byteLength(
        canonicalize({
          t: "interaction-mirror",
          assignmentId,
          batch: rawBatch,
        }),
        "utf8",
      ) > MAX_INLINE_LOGICAL_RECORD_BYTES
    ) {
      throw new TypeError(
        "Interaction mirror batch exceeds the durable record limit",
      );
    }
    const batch = await verifyProtocolStep(() =>
      validateAssignmentInteractionMirrorBatch(rawBatch, this.#verifier),
    );
    if (batch.assignmentId !== assignmentId) {
      throw new TypeError(
        "Interaction mirror batch names a different assignment",
      );
    }
    return this.#mirrorQueue.run(assignmentId, () =>
      this.#commitInteractionMirror(assignmentId, batch, context),
    );
  }

  async #commitInteractionMirror(
    assignmentId: string,
    batch: InteractionMirrorBatch,
    context: AuthorityCallContext,
  ): Promise<{
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }> {
    const sediments = this.#trustSediments
      ? batch.entries.filter(
          (entry): entry is TrustSedimentMirrorEntry =>
            entry.kind === "trust-sediment",
        )
      : [];
    const hits = this.#trustRuleHits
      ? batch.entries.filter(
          (entry): entry is TrustRuleHitMirrorEntry =>
            entry.kind === "trust-rule-hit",
        )
      : [];
    const batchDigest = interactionMirrorBatchDigest(batch);
    const batchKey = `${assignmentId}:${batchDigest}`;
    if (sediments.length > 0) {
      let durableOutcomes = new Map<
        string,
        import("@zhixing-ai/core/contracts").InteractionAnswerMirrorEntry["outcome"]
      >();
      await prepareSharedTrustSediments({
        assignmentId,
        sediments,
        selectAssigned: async () => {
          const target = await this.#coordinator.select((facts) =>
            selectTrustSedimentPreparationTarget(facts, assignmentId, batchKey),
          );
          if (!target) return undefined;
          durableOutcomes = new Map(target.outcomes);
          return {
            executorId: target.executorId,
            environment: target.environment,
          };
        },
        isAnswered: async (requestId) =>
          batch.entries.some(
            (entry) =>
              entry.kind === "allow-once" &&
              entry.requestId === requestId &&
              entry.outcome.t === "answered",
          ) || durableOutcomes.get(requestId)?.t === "answered",
        prepareOne: async (item) =>
          this.#trustSediments!.prepare({
            taskId: this.#taskId,
            assignmentId: item.assignmentId,
            executorId: item.executorId,
            environment: item.environment,
            entry: item.entry,
            answered: item.answered,
          }),
      });
    }
    const hitSession = await prepareSharedTrustRuleHitMirrorSession({
      origin: { taskId: this.#taskId },
      assignmentId,
      batchDigest,
      hits,
      trustRuleHits: this.#trustRuleHits,
      selectPrecheck: () =>
        this.#coordinator.select((facts) =>
          precheckJobMirrorRuleHits({
            assignmentId,
            batch,
            batchDigest,
            facts,
          }),
        ),
      selectBatchCommitted: () =>
        this.#coordinator.select((facts) =>
          facts.channel.hasInteractionMirrorBatch(batchKey),
        ),
    });
    const mirrored = (
      await this.#coordinator
        .transact<{
          readonly mirroredUpTo: number;
          readonly ordinal: number;
          readonly mirrorDigest: string;
        }>((facts) =>
          decideCommitInteractionMirror({
            taskId: this.#taskId,
            assignmentId,
            batch,
            authorizeReplay: () =>
              this.#coordinator.authorizeSubmission(facts, context, {
                mode: "durable-replay",
                method: "submission.mirrorInteractions",
                assignmentId,
              }),
            authorizeActiveOrSettlement: (mode) =>
              this.#coordinator.authorizeSubmission(facts, context, {
                mode,
                method: "submission.mirrorInteractions",
                assignmentId,
              }),
            facts,
          }),
        )
        .catch(async (error: unknown) => {
          await hitSession.settleAfterError();
          throw error;
        })
    ).value;
    for (const entry of sediments) {
      await this.#trustSediments!
        .accept({ taskId: this.#taskId, assignmentId, entry })
        .catch(() => undefined);
    }
    await hitSession.acceptCommitted();
    return mirrored;
  }

  async trustRuleHitBatchState(
    assignmentId: string,
    batchDigest: string,
  ): Promise<TrustRuleHitBatchState> {
    assertIdentifier(assignmentId, "Assignment id");
    if (
      typeof batchDigest !== "string" ||
      batchDigest.length === 0 ||
      batchDigest.length > 256
    ) {
      throw new TypeError("Interaction mirror batch digest is invalid");
    }
    return this.#coordinator.select((facts) =>
      selectTrustRuleHitBatchState(facts, assignmentId, batchDigest),
    );
  }

  async trustSedimentMirrored(
    assignmentId: string,
    requestId: string,
  ): Promise<boolean> {
    assertIdentifier(assignmentId, "Assignment id");
    assertIdentifier(requestId, "Trust sediment identity");
    return this.#coordinator.select(
      (facts) =>
        facts.channel.getInteractionMirror(assignmentId)?.requestIds.has(
          requestId,
        ) ?? false,
    );
  }

  async completeInteractionSettlement(
    assignmentId: string,
    rawProof: InteractionSettlementStreamProof | undefined,
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#coordinator.authenticateSubmission(context, {
      method: "submission.completeInteractionSettlement",
      assignmentId,
    });
    await this.#coordinator.loadSubmissionGuard(context, {
      method: "submission.completeInteractionSettlement",
      assignmentId,
    });
    const proof =
      rawProof === undefined
        ? undefined
        : await verifyProtocolStep(() =>
            validateInteractionSettlementStreamProof(rawProof, this.#verifier),
          );
    await this.#coordinator.transact<void>((facts) =>
      decideCompleteInteractionSettlement({
        taskId: this.#taskId,
        assignmentId,
        proof,
        authorizeReplay: () =>
          this.#coordinator.authorizeSubmission(facts, context, {
            mode: "durable-replay",
            method: "submission.completeInteractionSettlement",
            assignmentId,
          }),
        authorizeSettlement: () =>
          this.#coordinator.authorizeSubmission(facts, context, {
            mode: "settlement",
            method: "submission.completeInteractionSettlement",
            assignmentId,
          }),
        facts,
      }),
    );
  }

  async pendingInteractionSettlements(): Promise<
    readonly Extract<
      JobJournalRecord,
      { readonly t: "interaction-settlement-fence" }
    >[]
  > {
    return this.#coordinator.select((facts) =>
      selectPendingInteractionSettlements(facts),
    );
  }

  async failQueued(jobRunId: string): Promise<boolean> {
    return this.#closeQueued(jobRunId, "failed");
  }

  async failAssigned(
    jobRunId: string,
    assignmentId: string,
    executorFailure: {
      readonly lastSeq: number;
      readonly failure: NonNullable<LedgerSnapshot["failure"]>;
    },
  ): Promise<void> {
    assertIdentifier(jobRunId, "Failed job run id");
    assertIdentifier(assignmentId, "Failed job assignment id");
    await this.#coordinator.transact<void>((facts) =>
      decideFailAssigned({
        taskId: this.#taskId,
        jobRunId,
        assignmentId,
        executorFailure,
        facts,
      }),
    );
  }

  async expireQueued(jobRunId: string): Promise<boolean> {
    return this.#closeQueued(jobRunId, "expired");
  }

  async cancel(input: {
    readonly jobRunId: string;
    readonly requestId: string;
    readonly context: AuthorityCallContext;
  }): Promise<JobCancelResult> {
    assertIdentifier(input.jobRunId, "Cancelled job id");
    assertIdentifier(input.requestId, "Cancellation request id");
    const result = await this.#coordinator.transact<JobCancelResult>(
      (facts, prefix) =>
        decideCancelJob({
          taskId: this.#taskId,
          jobRunId: input.jobRunId,
          requestId: input.requestId,
          nextLsn: prefix.nextLsn,
          authorize: (definition) =>
            this.#ingress.authorize(
              input.context,
              definition.definition.kind === "system"
                ? "system-cancel"
                : "user-cancel",
              definition,
            ),
          resources: this.#resources,
          systemResources: this.#systemResources,
          facts,
        }),
    );
    return result.value;
  }

  async applyControl(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: JobControlEnvelope;
    readonly source: TrustedControlSource;
  }): Promise<ControlAdmissionOutcome> {
    return this.#coordinator.applyControlTransaction({
      admission: input.admission,
      envelope: input.envelope,
      source: input.source,
      decide: (facts, context) =>
        decideApplyJobControl({
          taskId: this.#taskId,
          anchorEpoch: this.#anchorEpoch,
          context,
          resources: this.#resources,
          facts,
        }),
    });
  }

  async pendingCancellations(): Promise<PendingJobFence[]> {
    return this.#coordinator.select((facts) =>
      selectPendingCancellations(facts),
    );
  }

  async requestSupersede(
    assignmentId: string,
    requestId: string,
  ): Promise<PendingJobFence["fence"]> {
    assertIdentifier(assignmentId, "Assignment id");
    assertIdentifier(requestId, "Supersede request id");
    const result = await this.#coordinator.transact<PendingJobFence["fence"]>(
      (facts, prefix) =>
        decideRequestSupersede({
          taskId: this.#taskId,
          assignmentId,
          requestId,
          nextLsn: prefix.nextLsn,
          facts,
        }),
    );
    return result.value;
  }

  async pendingSupersedes(): Promise<PendingJobFence[]> {
    return this.#coordinator.select((facts) => selectPendingSupersedes(facts));
  }

  async markUncertain(
    assignmentId: string,
    cause: Exclude<JobResolutionFact["cause"], "dispatch-conflict">,
  ): Promise<JobResolutionFact> {
    assertIdentifier(assignmentId, "Assignment id");
    const transaction = await this.#coordinator.transact<JobResolutionFact>(
      (facts) =>
        decideMarkUncertain({
          taskId: this.#taskId,
          anchorEpoch: this.#anchorEpoch,
          assignmentId,
          cause,
          openedAt: this.#clock(),
          facts,
        }),
    );
    return transaction.value;
  }

  async acceptSupersedeProof(rawProof: SupersedeProof): Promise<void> {
    const proof = await verifyProtocolStep(() =>
      validateSupersedeProof(rawProof, this.#verifier),
    );
    await this.#coordinator.transact<void>((facts) =>
      decideAcceptSupersedeProof({
        taskId: this.#taskId,
        anchorEpoch: this.#anchorEpoch,
        proof,
        at: this.#clock(),
        legacyAbortTickets: this.#legacyAbortTickets,
        facts,
      }),
    );
  }

  async acceptDispatchRejection(
    rawResult: Extract<
      DispatchResult,
      { accepted: false; outcome: "rejected-before-received" }
    >,
  ): Promise<void> {
    const result = await verifyProtocolStep(() =>
      validateDispatchResult(rawResult, this.#verifier),
    );
    if (result.accepted || result.outcome !== "rejected-before-received") {
      throw new TypeError(
        "Dispatch rejection path requires a rejection result",
      );
    }
    const proof = await verifyProtocolStep(() =>
      validateAssignmentTerminationProof(result.proof, this.#verifier),
    );
    await this.#coordinator.transact<void>((facts) =>
      decideAcceptDispatchRejection({
        taskId: this.#taskId,
        anchorEpoch: this.#anchorEpoch,
        proof,
        at: this.#clock(),
        legacyAbortTickets: this.#legacyAbortTickets,
        facts,
      }),
    );
  }

  async submitCancelProof(
    assignmentId: string,
    rawProof: CancelProofBody,
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#coordinator.authenticateSubmission(context, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    await this.#coordinator.loadSubmissionGuard(context, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    const proof = await verifyProtocolStep(() =>
      validateCancelProof(rawProof, this.#verifier),
    );
    await this.#coordinator.transact<void>((facts) =>
      decideSubmitCancelProof({
        taskId: this.#taskId,
        anchorEpoch: this.#anchorEpoch,
        assignmentId,
        proof,
        at: this.#clock(),
        legacyAbortTickets: this.#legacyAbortTickets,
        authorizeReplay: () =>
          this.#coordinator.authorizeSubmission(facts, context, {
            mode: "durable-replay",
            method: "submission.submitCancelProof",
            assignmentId,
          }),
        authorizeSettlement: () =>
          this.#coordinator.authorizeSubmission(facts, context, {
            mode: "settlement",
            method: "submission.submitCancelProof",
            assignmentId,
          }),
        assertAssignmentUsageFinal: (assigned, usageFinal) =>
          this.#coordinator.assertAssignmentUsageFinal(assigned, usageFinal),
        facts,
      }),
    );
  }

  async recordDispatchConflict(
    sent: PendingJobDispatch,
    rawResult: DispatchResult,
  ): Promise<"acked-original" | "opened-uncertain"> {
    const result = await verifyProtocolStep(() =>
      validateDispatchResult(rawResult, this.#verifier),
    );
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new TypeError("Dispatch conflict path requires a conflict result");
    }
    const proof = await verifyProtocolStep(() =>
      validateDispatchConflictProof(result.proof, this.#verifier),
    );
    const conflictReferences = await assertArtifactsPresent(
      proof,
      this.#artifacts,
    );
    const transaction = await this.#coordinator.transact<
      "acked-original" | "opened-uncertain"
    >(
      (facts, prefix) =>
        decideRecordDispatchConflict({
          taskId: this.#taskId,
          anchorEpoch: this.#anchorEpoch,
          sent,
          proof,
          nextLsn: prefix.nextLsn,
          openedAt: this.#clock(),
          facts,
        }),
      conflictReferences,
    );
    return transaction.value;
  }

  async submitBundle(
    rawBundle: SealedBundle,
    context: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  > {
    const p1 = await prepareJobBundleSubmission({
      rawBundle,
      context,
      artifacts: this.#artifacts,
      commitParticipant: this.#commitParticipant,
      guardAccess: this.#guardAccess,
    });
    if (p1.kind === "return") return p1.result;
    const { submission } = p1;
    const transaction = await this.#coordinator
      .transact<
        | { readonly committed: true; readonly commitRevision: number }
        | { readonly committed: false; readonly error: AuthorityError }
      >(
        (facts, prefix) =>
          decideLockedJobBundleSubmission({
            taskId: this.#taskId,
            localExecutorId: this.#localExecutorId,
            context,
            submission,
            prefix,
            closedAt: this.#clock(),
            delivery: this.#delivery,
            commitParticipant: this.#commitParticipant,
            schedulerNotices: this.#schedulerNotices,
            authorizeSubmission: (decisionFacts, callContext, authorization) =>
              this.#coordinator.authorizeSubmission(
                decisionFacts,
                callContext,
                authorization,
              ),
            assertAssignmentUsageFinal: (assigned, usageFinal) =>
              this.#coordinator.assertAssignmentUsageFinal(
                assigned,
                usageFinal,
              ),
            facts,
          }),
        submission.candidateReferences,
        submission.readProjectionIds,
      )
      .catch((error: unknown) => {
        if (error instanceof TransactionArtifactReferenceError) {
          return {
            value: rejected(
              "missing-base",
              "Staged artifact dependencies changed; resubmit the bundle",
              true,
            ),
          };
        }
        throw error;
      });
    if (transaction.value.committed) {
      this.#commitParticipant?.wakePendingPublishing?.(this.#taskId);
    }
    return transaction.value;
  }

  async runSystem(
    jobRunId: string,
    context: AuthorityCallContext,
  ): Promise<"committed" | "failed"> {
    return this.#executeSystem(jobRunId, context, false);
  }

  async resumeSystemJobs(context: AuthorityCallContext): Promise<number> {
    const resumable = await this.#coordinator.select((facts) =>
      selectResumableSystemJobs(facts),
    );
    let completed = 0;
    for (const jobRunId of resumable) {
      await this.#executeSystem(jobRunId, context, true);
      completed += 1;
    }
    return completed;
  }

  async occurrence(jobRunId: string): Promise<JobOccurrence | undefined> {
    return this.#coordinator.select((facts) =>
      selectOccurrence(facts, jobRunId),
    );
  }

  async scheduleOccurrence(
    jobRunId: string,
  ): Promise<ScheduleOccurrence | undefined> {
    return this.#coordinator.select((facts) =>
      facts.task.getScheduleOccurrence(jobRunId),
    );
  }

  async schedulerReadView(): Promise<JobSchedulerReadView> {
    return this.#coordinator.select((facts) => selectSchedulerReadView(facts));
  }

  async pendingMissedOccurrences(): Promise<readonly ScheduleOccurrence[]> {
    return this.#coordinator.select((facts) =>
      selectPendingMissedOccurrences(facts),
    );
  }

  async openOccurrences(): Promise<readonly ScheduleOccurrence[]> {
    return (await this.schedulerReadView()).open;
  }

  async occurrencesPage(input: {
    readonly before?: string;
    readonly limit: number;
  }): Promise<readonly ScheduleOccurrence[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > 256
    ) {
      throw new TypeError("Occurrence page limit must be 1-256");
    }
    if (input.before !== undefined) {
      assertIdentifier(input.before, "Occurrence page cursor");
    }
    return this.#coordinator.select((facts) =>
      selectOccurrencesPage(facts, input.before, input.limit),
    );
  }

  async currentState(jobRunId: string): Promise<JobRunState | undefined> {
    return this.#coordinator.select(
      (facts) => facts.assignment.getRunState(jobRunId)?.state,
    );
  }

  async statusHistory(
    jobRunId: string,
    afterStatusRevision: number,
  ): Promise<JobStatusNotice[]> {
    assertIdentifier(jobRunId, "Job run id");
    if (!Number.isSafeInteger(afterStatusRevision) || afterStatusRevision < 0) {
      throw new TypeError("Last-seen job status revision must be non-negative");
    }
    return this.#coordinator.select((facts) =>
      (facts.assignment.getStatusHistory(jobRunId) ?? [])
        .filter((entry) => entry.statusRevision > afterStatusRevision)
        .map((entry) =>
          jobStatusNotice(
            this.#taskId,
            this.#anchorEpoch,
            jobRunId,
            entry as unknown as import("./contracts.js").JobStatusHistoryEntry,
          ),
        )
        .filter((notice): notice is JobStatusNotice => notice !== undefined),
    );
  }

  async currentResolution(
    jobRunId: string,
  ): Promise<JobResolutionFact | undefined> {
    return this.#coordinator.select((facts) => {
      const fact = facts.assignment.getResolution(jobRunId);
      return fact ? snapshot(fact as unknown as JobResolutionFact) : undefined;
    });
  }

  async systemResult(
    jobRunId: string,
  ): Promise<MaterializedSystemJobResult | undefined> {
    return this.#coordinator.select((facts) => {
      const result = facts.task.getSystemResult(jobRunId);
      return result
        ? snapshot(result as unknown as MaterializedSystemJobResult)
        : undefined;
    });
  }

  async taskDefinition(): Promise<TaskDefinition | undefined> {
    return this.#coordinator.select((facts) =>
      facts.task.definition
        ? snapshot(facts.task.definition as unknown as TaskDefinition)
        : undefined,
    );
  }

  async validateExecutorDispatchResult(
    result: DispatchResult,
  ): Promise<DispatchResult> {
    return verifyProtocolStep(() =>
      validateDispatchResult(result, this.#verifier),
    );
  }

  async #closeQueued(
    jobRunId: string,
    target: "failed" | "expired",
  ): Promise<boolean> {
    assertIdentifier(jobRunId, "Job run id");
    const result = await this.#coordinator.transact<boolean>((facts) =>
      decideCloseQueued({
        taskId: this.#taskId,
        jobRunId,
        target,
        resources: this.#resources,
        facts,
      }),
    );
    return result.value;
  }

  async #executeSystem(
    jobRunId: string,
    context: AuthorityCallContext,
    recoverRunning: boolean,
  ): Promise<"committed" | "failed"> {
    const running = this.#systemRuns.get(jobRunId);
    if (running) return running;
    const operation = this.#runSystem(
      jobRunId,
      context,
      recoverRunning,
    ).finally(() => {
      if (this.#systemRuns.get(jobRunId) === operation) {
        this.#systemRuns.delete(jobRunId);
      }
    });
    this.#systemRuns.set(jobRunId, operation);
    return operation;
  }

  async #runSystem(
    jobRunId: string,
    context: AuthorityCallContext,
    recoverRunning: boolean,
  ): Promise<"committed" | "failed"> {
    const active = await this.#coordinator.select((facts) => {
      const occurrence = facts.task.getOccurrence(jobRunId) as
        | JobOccurrence
        | undefined;
      return {
        occurrence,
        current: facts.assignment.getRunState(jobRunId),
        fence: facts.task.getSystemFence(jobRunId) as
          | SystemJobFence
          | undefined,
        definition: occurrence
          ? (facts.task.requireDefinitionRevision(
              occurrence.taskRevision,
            ) as TaskDefinition)
          : undefined,
      };
    });
    const definition = active.definition;
    if (!definition) throw new Error("System job occurrence is unknown");
    if (definition.definition.kind !== "system") {
      throw new Error("User jobs cannot enter the local system handler path");
    }
    this.#ingress.authorize(context, "system-trigger", definition);
    const handler = this.#systemHandlers.get(definition.definition.handler);
    if (!handler) {
      throw new Error("System job handler is not registered in this host");
    }
    if (!this.#systemResources) {
      throw new Error("System job resource coordination is not configured");
    }
    if (!active.occurrence || !active.current) {
      throw new Error("System job occurrence is unknown");
    }
    if (
      active.current.state === "committed" ||
      active.current.state === "failed"
    ) {
      return active.current.state;
    }
    let lease: SystemJobResourceLease;
    let fence: SystemJobFence;
    if (active.current.state === "queued") {
      const prepared = await this.#systemResources.prepare({
        taskId: this.#taskId,
        jobRunId,
        anchorEpoch: this.#anchorEpoch,
        attempt: 1,
      });
      await verifyProtocolStep(() =>
        assertSystemLease(
          prepared.lease,
          this.#taskId,
          jobRunId,
          this.#anchorEpoch,
          1,
          this.#verifier,
        ),
      );
      fence = validateSystemJobFence({
        taskId: this.#taskId,
        jobRunId,
        scheduledFor: active.occurrence.scheduledFor,
        taskRevision: active.occurrence.taskRevision,
        anchorEpoch: this.#anchorEpoch,
        handler: definition.definition.handler,
        paramsDigest: systemJobParamsDigest(definition.definition.params),
        reservationId: prepared.lease.reservationId,
        attempt: 1,
      });
      assertSystemJobDefinitionReplayContract({ definition, fence });
      assertForeignRecords(prepared.records, jobStream(this.#taskId));
      this.#systemResources.assertActivationRecords({
        fence,
        records: prepared.records,
      });
      const systemResources = this.#systemResources;
      const activation = await this.#coordinator.transact<boolean>((facts) =>
        decideSystemJobActivation({
          taskId: this.#taskId,
          jobRunId,
          anchorEpoch: this.#anchorEpoch,
          definitionKind: definition.definition.kind,
          occurrence: active.occurrence!,
          fence,
          preparedRecords: prepared.records,
          systemResources,
          facts,
        }),
      );
      if (!activation.value) {
        const current = await this.currentState(jobRunId);
        if (current === "committed" || current === "failed") return current;
        throw new Error("System job activation was won by another runner");
      }
      lease = prepared.lease;
    } else if (active.current.state === "running" && active.fence) {
      if (!recoverRunning) {
        throw new Error("System job is already owned by an active runner");
      }
      const durableFence = active.fence;
      const recovered = await this.#systemResources.recover({
        fence: durableFence,
      });
      if (recovered.kind === "reuse") {
        await verifyProtocolStep(() =>
          assertSystemLease(
            recovered.lease,
            this.#taskId,
            jobRunId,
            this.#anchorEpoch,
            durableFence.attempt,
            this.#verifier,
          ),
        );
        if (recovered.lease.reservationId !== active.fence.reservationId) {
          throw new TypeError(
            "Reused system lease does not bind the durable fence",
          );
        }
        lease = recovered.lease;
        fence = active.fence;
      } else {
        const attempt = active.fence.attempt + 1;
        await verifyProtocolStep(() =>
          assertSystemLease(
            recovered.lease,
            this.#taskId,
            jobRunId,
            this.#anchorEpoch,
            attempt,
            this.#verifier,
          ),
        );
        fence = validateSystemJobFence({
          ...active.fence,
          reservationId: recovered.lease.reservationId,
          attempt,
        });
        assertSystemJobDefinitionReplayContract({ definition, fence });
        assertForeignRecords(recovered.records, jobStream(this.#taskId));
        this.#systemResources.assertActivationRecords({
          previousFence: active.fence,
          fence,
          records: recovered.records,
        });
        const systemResources = this.#systemResources;
        const replacement = await this.#coordinator.transact<boolean>((facts) =>
          decideSystemJobRecoveryReplacement({
            taskId: this.#taskId,
            jobRunId,
            anchorEpoch: this.#anchorEpoch,
            definitionKind: definition.definition.kind,
            occurrence: active.occurrence!,
            expectedPreviousFence: active.fence!,
            fence,
            recoveredRecords: recovered.records,
            systemResources,
            facts,
          }),
        );
        if (!replacement.value) {
          const current = await this.currentState(jobRunId);
          if (current === "committed" || current === "failed") return current;
          throw new Error("System job recovery was won by another runner");
        }
        lease = recovered.lease;
      }
    } else {
      throw new Error("System job is not executable from its current state");
    }
    const params = definition.definition.params;
    let outcome: "committed" | "failed" = "committed";
    let summary: string | undefined;
    let failure: string | undefined;
    try {
      const result = await handler({
        taskId: this.#taskId,
        jobRunId,
        attempt: fence.attempt,
        params,
      });
      summary = validateSystemJobSummary(
        (result as { readonly summary?: unknown }).summary,
      );
    } catch (error) {
      outcome = "failed";
      failure = errorMessage(error);
    }
    const detail = validateSystemJobResultDetail(
      {
        ...(summary === undefined ? {} : { summary }),
        ...(failure === undefined ? {} : { error: failure }),
      },
      outcome,
    );
    const preparedDetail = await prepareJobStored(
      detail,
      (stored) => ({
        t: "system-result" as const,
        jobRunId,
        fence,
        outcome,
        detail: stored,
      }),
      this.#artifacts,
    );
    // 终态资源预检在事务之外：激活提交后工作集已换，缺键时与事务同一机制锁外装入后重做
    const systemResources = this.#systemResources;
    const terminalRecords = await this.#coordinator.repeatState(async () =>
      systemResources.terminal({ lease, outcome }),
    );
    assertForeignRecords(terminalRecords, jobStream(this.#taskId));
    this.#systemResources.assertTerminalRecords({
      fence,
      outcome,
      records: terminalRecords,
    });
    await this.#coordinator.transact<void>(
      (facts) =>
        decideSystemJobTerminal({
          taskId: this.#taskId,
          jobRunId,
          definitionKind: definition.definition.kind,
          fence,
          outcome,
          storedDetail: preparedDetail.stored,
          terminalRecords,
          systemResources,
          facts,
        }),
      preparedDetail.references,
    );
    return outcome;
  }
}
