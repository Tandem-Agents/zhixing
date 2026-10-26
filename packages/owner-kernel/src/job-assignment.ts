import { verifyProtocolStep, rethrowUnloadedProtocolIdentity } from "@zhixing/core/protocol";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { SCHEDULER_USER_NOTICE_STREAM } from "@zhixing/core/delivery";
import {
  DEFAULT_SCHEDULE_FAILURE_THRESHOLD,
  decideScheduleCapabilityGap,
  decideScheduleCapabilityGapClosure,
  projectSchedulePublishNotices,
  type ScheduleCapabilityGapState,
  isScheduleFailure,
  scheduleFailurePolicyForCount,
  ScheduleRuntimePolicyError,
  type ScheduleFailurePolicyDecision,
  type ScheduleOccurrence,
} from "@zhixing/core/scheduler/application";
import {
  AuthorityStorageError,
  TransactionArtifactReferenceError,
  collectArtifactRefs,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveDispatchArtifactClosure,
  resolveSealedBundleArtifactClosure,
  type ArtifactStore,
  type AuthorityCommitLog,
  type ProjectionCursor,
  type RebuildableDurableProjectionIndex,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
  AuthorityPreparationRequired,
  awaitAuthorityPreparation,
} from "@zhixing/core/authority";
import {
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError,
  waitForMaintenanceRetry,
} from "@zhixing/core/resources";
import type {
  ArtifactRef,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentTerminationProof,
  AuthorityCallContext,
  AuthorityError,
  CancelProofBody,
  ChannelInteractionGrant,
  ChannelResponderRef,
  DataPlaneTicket,
  CommitEnvelope,
  DispatchResult,
  GovernorRecord,
  JobOccurrence,
  JobChannelChallengeToken,
  JobRunState,
  JobStatusNotice,
  JobUncertainClosure,
  InteractionMirrorEntry,
  InteractionMirrorBatch,
  InteractionSettlementStreamProof,
  IngressContext,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  RootResourceWorkload,
  RunExecutorPort,
  SealedBundle,
  SupersedeProof,
  SystemHandlerId,
  SystemJobFence,
  SystemJobResourceLease,
  TaskDefinition,
  TaskDefinitionBody,
  StreamFrame,
  UncertainResolutionFact,
} from "@zhixing/core/contracts";
import {
  assertProtocolIdentifier as assertIdentifier,
  assertChannelChallengeActiveAt,
  assertDataPlaneTicketTtlMs,
  assertActivatedAssignmentCapability,
  assertQueuedTerminalDequeue,
  assignmentActivationDigest,
  buildJobActivationPayload,
  buildJobActivationPayloadFromBinding,
  applyValidatedAssignmentEntry,
  canonicalize,
  acceptedRemoteIntervalRemainingMs,
  controlLeaseBindsDispatchEnvelope,
  createAssignmentLedgerValidationState,
  createSignedDataPlaneTicket,
  createSignedChannelChallengeToken,
  createSignedChannelInteractionGrant,
  createJobCommitFence,
  createSignedJobEnvelope,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  jobDeliveryPlanDigest,
  matchManifest,
  interactionMirrorBatchDigest,
  interactionMirrorSeed,
  interactionDisplayDigest,
  mutationBatchArtifact,
  permissionSnapshotLeaseDigest,
  protocolDigest,
  queuedTerminalDequeueRecord,
  requiresFormalResourceCoordination,
  sealedBundleArtifact,
  signJobActivation,
  streamLogicalFrameDigest,
  StreamFrameVerifier,
  systemJobParamsDigest,
  validateAssignmentTerminationProof,
  validateAssignmentEntry,
  validateCancelProof,
  validateChannelChallengeToken,
  validateChannelInteractionGrant,
  validateChannelResponderRef,
  validateDispatchConflictProof,
  validateDispatchResult,
  validateDataPlaneTicket,
  validateExecutionManifest,
  validateJobCommitFence,
  compareJobOccurrences,
  validateJobActivation,
  validateJobEnvelope,
  validateJobOccurrence,
  validateIngressContext,
  validateAssignmentInteractionMirrorBatch,
  validateInteractionSettlementStreamProof,
  validateJobSealedBundle,
  validateLedgerEvidencePage,
  validateLedgerSnapshot,
  validateJobMutationBatch,
  validatePublishDecisionForBatch,
  validateSupersedeProof,
  validateStreamFrame,
  validateSystemJobFence,
  validateSystemJobResourceLease,
  validateTaskDefinition,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamVerifierCheckpoint,
  type ExecutorCapabilitySnapshot,
  type UnsignedJobEnvelope,
} from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import { ManifestSelectionError } from "./conversation-assignment-authority.js";
import type { AssignmentResourceCoordinator } from "./resource-governor.js";
import { compileDeliveryContent, DeliveryContentValidationError, type CompiledDeliveryContent } from "@zhixing/core/delivery";
import type {
  AssignmentSubmissionAuthorizer,
  AssignmentSubmissionAuthorization,
  AssignmentSubmissionIdentity,
  AssignmentSubmissionPreflightPort,
  AssignmentSubmissionPreflightResult,
  ConversationAbortTicketAuthorizer,
  DataPlaneTicketFacts,
  DataPlaneTicketIssueRequest,
  InProcessBundleSubmission,
  InProcessDispatchContextFactory,
} from "./conversation-assignment.js";
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
  resolutionFactDigest,
  resolutionTargetState,
  terminationProofBindsDurableSource,
  validateResolutionFact,
  type Stored,
} from "./conversation-run-contracts.js";
import {
  assertJobCancelFenceReplayContract,
  assertJobAdmissionReplayContract,
  assertJobConflictContainmentReplayContract,
  assertJobInteractionSettlementCompletionReplayContract,
  assertJobInteractionSettlementFenceReplayContract,
  assertJobOccurrenceReplayContract,
  assertJobMirrorReplayContract,
  assertJobResolutionBinding,
  assertJobStateReplayContract,
  assertSystemJobActivationReplayContract,
  assertSystemJobDefinitionReplayContract,
  assertSystemMissCoalescedReplayContract,
  assertSystemJobTerminalReplayContract,
  assertTaskRevisionReplayContract,
  corruptJobJournal,
  isTerminalJobState,
  NOT_STARTED_PROOF_KINDS,
  notStartedRejectionKey,
  registerPendingSystemMiss,
  sameJobInteractionSettlement,
  taskCreationProvenanceMatches,
  taskRevisionReplayViolation,
  validateJobJournalRecord,
  validateSystemJobResultDetail,
  validateSystemJobSummary,
  type JobJournalRecord,
  type MaterializedSystemJobResult,
  type NotStartedProofKind,
  type TaskRevisionReplayViolation,
} from "./job-run-contracts.js";
import { abortTicketProofBindsOwnerHistory } from "./data-plane-ticket-proof.js";
import {
  dataPlaneTicketIssueMatches,
  dataPlaneTicketSyncBoundary,
  nextDataPlaneTicketSyncFrontier,
  ticketPrecedesSyncFrontier,
} from "./data-plane-ticket-lifecycle.js";
import type {
  JobStatusDeliveryInput,
  JobDeliveryParticipant,
} from "./delivery-participant.js";
import type { PendingChannelChallenge } from "./channel-challenge-outbox.js";
import { SCHEDULER_NOTICE_STREAM, type SchedulerUserNoticeJournal } from "./scheduler-user-notices.js";
// 权威记录注册表随公开 job 模块再导出:执行点行为矩阵(生产/full/guard/
// 恢复/对抗)按它做类型级闭合,新增记录类型缺行即编译失败。
export {
  JOB_JOURNAL_RECORD_SHAPES,
  type JobJournalRecordType,
} from "./job-run-contracts.js";
import {
  type AtomicControlApplicationContext,
  type ControlAdmissionJournal,
  type ControlAdmissionOutcome,
  type JobControlEnvelope,
  type TrustedControlSource,
} from "./control-admission.js";
import {
  applyChannelInteractionRecord,
  validateChannelInteractionRelayRecord,
  type ChannelInteractionRelayRecord,
  type ChannelInteractionJournalState,
  type JobChannelChallengePreparedRecord,
} from "./channel-interaction-records.js";
import {
  JobStateBinding,
  JobStateExhausted,
  JobStateRequired,
  JobStateSet,
  loadJobState,
  MAX_JOB_STATE_ROUNDS,
  runWithJobState,
  tallyJobStateNeeds,
  KeyedMap,
  KeyedOrder,
  KeyedSet,
  jobStateTaskBase,
  type JobStateField,
} from "./job-run-state.js";
import {
  JOB_RUN_STATE_PROJECTION_ID,
  jobStateHeadKey,
  registerJobRunStateProjection,
} from "./job-run-state-index.js";
import {
  failuresBefore,
  latestFailures,
  missingFailureSummaryNodes,
  requireFailureSummaryPaths,
  setFailureSummaryEntry,
  type FailureSummaryNode,
  type FailureSummaryPosition,
} from "./job-failure-summary.js";

type ChannelTables = Omit<ChannelInteractionJournalState, "domain">;
/** 作业的频道交互状态：与会话共用同一份规则，按键落盘。 */
type JobChannelInteractions = { readonly domain: "job" } & {
  readonly [Name in keyof ChannelTables]: ChannelTables[Name] extends ReadonlyMap<infer K, infer V>
    ? KeyedMap<K & string, V> : never;
};

type JobEnvelope = Extract<
  import("@zhixing/core/contracts").DispatchEnvelope,
  { execution: "job" }
>;
type JobBundle = ReturnType<typeof validateJobSealedBundle>;
type JobResolutionFact = Extract<
  UncertainResolutionFact,
  { subject: { execution: "job" } }
>;

interface AssignedJob {
  readonly record: Extract<JobJournalRecord, { t: "assigned" }>;
  readonly envelope: JobEnvelope;
  readonly commit: { readonly lsn: number; readonly envelopeDigest: string; readonly at: string };
  acked: boolean;
}

interface JobStateEntry {
  readonly state: JobRunState;
  readonly statusRevision: number;
}

type JobStatusHistoryEntry = JobStateEntry & {
  readonly at: string;
} & (
    | { readonly uncertainTransition?: undefined }
    | { readonly uncertainTransition: "opened"; readonly openFactDigest: string }
    | ({ readonly uncertainTransition: "closed"; readonly openFactDigest: string } &
        JobUncertainClosure)
  );

/**
 * Zero-ArtifactStore submission guard projection (RunSubmissionPort
 * submission contract): consumes job-stream
 * inline facts only, executes the same shared replay predicates as the full
 * reducer with a compact data closure, and never dereferences dispatch or
 * bundle closures. Preflights stable rejections and exact committed replays.
 */
interface JobSubmissionGuardProjection {
  latestDefinitionState: "enabled" | "disabled" | "deleted";
  latestDefinitionRevision: number | undefined;
  readonly definitionKinds: KeyedMap<number, "user" | "system">;
  readonly taskOperations: KeyedMap<
    string,
    { readonly digest: string; readonly taskRevision: number }
  >;
  readonly systemMissAliases: KeyedSet<string>;
  pendingSystemMissedJobRunId: string | undefined;
  readonly occurrences: KeyedMap<
    string,
    {
      readonly scheduledFor: string;
      readonly taskRevision: number;
      readonly deliveryPlanDigest: string;
      readonly deliveryRequired: boolean;
    }
  >;
  readonly states: KeyedMap<string, JobStateEntry>;
  readonly admittedJobs: KeyedSet<string>;
  readonly ingressByJob: KeyedMap<string, IngressContext>;
  activeJobRunId: string | undefined;
  readonly assignedById: KeyedMap<
    string,
    {
      readonly record: Extract<JobJournalRecord, { t: "assigned" }>;
      readonly commit: {
        readonly lsn: number;
        readonly envelopeDigest: string;
        readonly at: string;
      };
      readonly capIds: ReadonlySet<string>;
      acked: boolean;
    }
  >;
  readonly assignmentByJob: KeyedMap<string, string>;
  readonly conflictAssignments: KeyedSet<string>;
  readonly openConflictAssignments: KeyedSet<string>;
  readonly supersedeRequests: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "supersede-requested" }>
  >;
  readonly supersedeStartedAssignments: KeyedSet<string>;
  readonly cancelFences: KeyedMap<string, Extract<JobJournalRecord, { t: "cancel-fence" }>>;
  readonly interactionSettlementFences: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
  >;
  readonly completedInteractionSettlements: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
  >;
  readonly acceptedCancellations: KeyedSet<string>;
  readonly durableStarted: KeyedSet<string>;
  readonly closedAssignments: KeyedSet<string>;
  readonly revokedCapabilities: KeyedSet<string>;
  readonly ticketsById: KeyedMap<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: KeyedMap<string, Set<string>>;
  readonly ticketReplacementsById: KeyedMap<string, string>;
  readonly revokedTickets: KeyedSet<string>;
  ticketSyncFrontier: string | undefined;
  readonly interactionMirrors: KeyedMap<
    string,
    {
      readonly upTo: number;
      readonly ordinal: number;
      readonly digest: string;
      readonly requestIds: ReadonlySet<string>;
      readonly outcomes: ReadonlyMap<
        string,
        import("@zhixing/core/contracts").InteractionMirrorEntry["outcome"]
      >;
    }
  >;
  readonly interactionMirrorBatches: KeyedSet<string>;
  readonly resolutions: KeyedMap<string, JobResolutionFact>;
  readonly committedByAssignment: KeyedMap<
    string,
    { readonly ref: ArtifactRef; readonly jobRevision: number }
  >;
  readonly bundleAcknowledgements: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "bundle-ack-observed" }>
  >;
  readonly systemFences: KeyedMap<string, SystemJobFence>;
  readonly systemResults: KeyedSet<string>;
  readonly channelInteractions: JobChannelInteractions;
  /** 每个 run 已用过的最大派发尝试序号：下一次派发据此取号，不遍历全部派发。 */
  readonly assignmentAttemptByRun: KeyedMap<string, number>;
  /** 票据按同步边界排序：前沿推进与在用票据按区间读取。 */
  readonly ticketExpiry: KeyedOrder<string>;
  nextJobRevision: number;
}

interface JobProjection {
  definition?: TaskDefinition;
  readonly definitions: KeyedMap<number, TaskDefinition>;
  readonly taskOperations: KeyedMap<
    string,
    { readonly digest: string; readonly taskRevision: number }
  >;
  readonly occurrences: KeyedMap<string, JobOccurrence>;
  legacyNextFire?: Extract<JobJournalRecord, { t: "legacy-next-fire" }>;
  readonly missedNextFireByRun: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "missed-next-fire" }>
  >;
  readonly failurePolicyByRun: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "failure-policy" }>
  >;
  readonly autoDisableSettledRuns: KeyedSet<string>;
  readonly capabilityGapByRun: KeyedMap<string, ScheduleCapabilityGapState>;
  readonly systemMissAliases: KeyedMap<
    string,
    { readonly scheduledFor: string; readonly coalescedJobRunId: string }
  >;
  readonly admittedJobs: KeyedSet<string>;
  readonly ingressByJob: KeyedMap<string, IngressContext>;
  readonly states: KeyedMap<string, JobStateEntry>;
  activeJobRunId?: string;
  pendingSystemMissedJobRunId?: string;
  readonly assignedById: KeyedMap<string, AssignedJob>;
  readonly assignmentByJob: KeyedMap<string, string>;
  readonly conflicts: KeyedMap<string, Extract<JobJournalRecord, { t: "dispatch-conflict" }>>;
  readonly containedFacts: KeyedSet<string>;
  readonly superseded: KeyedMap<string, Extract<JobJournalRecord, { t: "assignment-superseded" }>>;
  readonly supersedeRequests: KeyedMap<string, Extract<JobJournalRecord, { t: "supersede-requested" }>>;
  readonly supersedeStarted: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "supersede-started-observed" }>
  >;
  readonly cancelFences: KeyedMap<string, Extract<JobJournalRecord, { t: "cancel-fence" }>>;
  readonly interactionSettlementFences: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "interaction-settlement-fence" }>
  >;
  readonly completedInteractionSettlements: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "interaction-settlement-completed" }>
  >;
  readonly acceptedCancellations: KeyedMap<string, Extract<JobJournalRecord, { t: "cancel-proof-accepted" }>>;
  readonly rejectedNotStarted: KeyedMap<string, Extract<JobJournalRecord, { t: "not-started-rejected" }>>;
  readonly durableStarted: KeyedSet<string>;
  readonly revokedCapabilities: KeyedSet<string>;
  readonly ticketsById: KeyedMap<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: KeyedMap<string, Set<string>>;
  readonly ticketReplacementsById: KeyedMap<string, string>;
  readonly revokedTickets: KeyedSet<string>;
  ticketSyncFrontier: string | undefined;
  readonly interactionMirrors: KeyedMap<
    string,
    {
      readonly upTo: number;
      readonly ordinal: number;
      readonly digest: string;
      readonly requestIds: ReadonlySet<string>;
      readonly outcomes: ReadonlyMap<
        string,
        import("@zhixing/core/contracts").InteractionMirrorEntry["outcome"]
      >;
    }
  >;
  readonly interactionMirrorBatches: KeyedSet<string>;
  readonly containments: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "dispatch-conflict-contained" | "cancel-contained" }>
  >;
  readonly resolutions: KeyedMap<string, JobResolutionFact>;
  readonly statusHistoryByRun: KeyedMap<string, JobStatusHistoryEntry[]>;
  readonly committed: KeyedMap<string, Extract<JobJournalRecord, { t: "committed" }>>;
  readonly outcomeByRun: KeyedMap<string, JobBundle["body"]["outcome"]>;
  readonly bundleAcknowledgements: KeyedMap<
    string,
    Extract<JobJournalRecord, { t: "bundle-ack-observed" }>
  >;
  readonly recoveryAssignments: KeyedSet<string>;
  readonly bundleAcknowledgementOutbox: KeyedSet<string>;
  nextJobRevision: number;
  readonly systemFences: KeyedMap<string, SystemJobFence>;
  readonly systemResults: KeyedMap<
    string,
    MaterializedSystemJobResult
  >;
  readonly channelInteractions: JobChannelInteractions;
  readonly assignmentAttemptByRun: KeyedMap<string, number>;
  readonly ticketExpiry: KeyedOrder<string>;
  /** occurrence 按计划时间倒序：最近一次与历史分页按区间读取。 */
  readonly occurrenceOrder: KeyedOrder<string>;
  /**
   * 连续失败的可合并摘要（job-failure-summary.ts）：非错过的 occurrence 按完整次序成树，错过的不计也不打断。
   * 是否错过在 occurrence 写入时就定了（错过没有后继状态，也没有状态迁入错过），成员此后不变。
   * 调度视图与失败策略由定位路径上的摘要合成计数，不倒扫失败历史。
   */
  readonly failureSummaryNodes: KeyedMap<number, FailureSummaryNode>;
  failureSummaryRoot: number | undefined;
  failureSummaryNextNode: number;
  /** 摘要里记下的这一条是否失败；不在即尚未进摘要。状态推进而失败与否不变时，只读这一行。 */
  readonly failureFlagByRun: KeyedMap<string, boolean>;
  /** 已有的非错过 occurrence 数：调度视图的运行次数。 */
  runCount: number;
  // 当前义务目录：由同一归约在每条记录后维护，只含仍未完成的主体
  readonly openRuns: KeyedSet<string>;
  readonly openAssignments: KeyedSet<string>;
  readonly pendingSettlements: KeyedSet<string>;
  readonly openChallenges: KeyedSet<string>;
  readonly pendingGrants: KeyedSet<string>;
  readonly pendingAutoDisable: KeyedSet<string>;
  /** 错过且尚未汇总通知的用户任务 run；汇总通知提交时由持久投影移出。 */
  readonly pendingMissed: KeyedSet<string>;
}

// ---- 按键工作集上的两份投影 ----

interface JobStateLayout {
  readonly maps: readonly string[];
  readonly sets: readonly string[];
  /** 只含当前义务、可整体列出的集合。 */
  readonly enumerable: readonly string[];
  readonly orders: readonly string[];
  /** 根行里的标量字段及其缺省值。 */
  readonly root: Readonly<Record<string, unknown>>;
}

const JOB_CHANNEL_FIELDS = {
  preparedByChallenge: "chPrepared",
  challengeByInteraction: "chInteraction",
  deliveredByChallenge: "chDelivered",
  closedByChallenge: "chClosed",
  grantByChallenge: "chGranted",
  cursorByAssignment: "chCursor",
} as const;

const JOB_MAIN_LAYOUT: JobStateLayout = {
  maps: [
    "definitions", "taskOperations", "occurrences", "missedNextFireByRun", "failurePolicyByRun", "failureFlagByRun",
    "failureSummaryNodes", "capabilityGapByRun", "systemMissAliases", "ingressByJob", "states", "assignedById", "assignmentByJob",
    "conflicts", "superseded", "supersedeRequests", "supersedeStarted", "cancelFences",
    "interactionSettlementFences", "completedInteractionSettlements", "acceptedCancellations",
    "rejectedNotStarted", "ticketsById", "ticketIdsByAssignment", "ticketReplacementsById",
    "interactionMirrors", "containments", "resolutions", "statusHistoryByRun", "committed", "outcomeByRun",
    "bundleAcknowledgements", "systemFences", "systemResults", "assignmentAttemptByRun",
  ],
  sets: [
    "autoDisableSettledRuns", "admittedJobs", "containedFacts", "durableStarted", "revokedCapabilities",
    "revokedTickets", "interactionMirrorBatches",
  ],
  enumerable: [
    "recoveryAssignments", "bundleAcknowledgementOutbox", "openRuns", "openAssignments", "pendingSettlements",
    "openChallenges", "pendingGrants", "pendingAutoDisable", "pendingMissed",
  ],
  orders: ["ticketExpiry", "occurrenceOrder"],
  root: {
    definition: undefined, legacyNextFire: undefined, activeJobRunId: undefined,
    pendingSystemMissedJobRunId: undefined, ticketSyncFrontier: undefined, nextJobRevision: 1, runCount: 0,
    failureSummaryRoot: undefined, failureSummaryNextNode: 1,
  },
};

const JOB_GUARD_LAYOUT: JobStateLayout = {
  maps: [
    "definitionKinds", "taskOperations", "occurrences", "states", "ingressByJob", "assignedById",
    "assignmentByJob", "supersedeRequests", "cancelFences", "interactionSettlementFences",
    "completedInteractionSettlements", "ticketsById", "ticketIdsByAssignment", "ticketReplacementsById",
    "interactionMirrors", "resolutions", "committedByAssignment", "bundleAcknowledgements", "systemFences",
    "assignmentAttemptByRun",
  ],
  sets: [
    "systemMissAliases", "admittedJobs", "conflictAssignments", "openConflictAssignments",
    "supersedeStartedAssignments", "acceptedCancellations", "durableStarted", "closedAssignments",
    "revokedCapabilities", "revokedTickets", "interactionMirrorBatches", "systemResults",
  ],
  enumerable: [],
  orders: ["ticketExpiry"],
  root: {
    latestDefinitionState: "enabled", latestDefinitionRevision: undefined, pendingSystemMissedJobRunId: undefined,
    activeJobRunId: undefined, ticketSyncFrontier: undefined, nextJobRevision: 1,
  },
};

const layoutFields = (layout: JobStateLayout): ReadonlyMap<string, JobStateField> => new Map<string, JobStateField>([
  ...layout.maps.map((name) => [name, { name, kind: "map" }] as const),
  ...Object.values(JOB_CHANNEL_FIELDS).map((name) => [name, { name, kind: "map" }] as const),
  ...layout.sets.map((name) => [name, { name, kind: "set" }] as const),
  ...layout.enumerable.map((name) => [name, { name, kind: "set", enumerable: true }] as const),
  ...layout.orders.map((name) => [name, { name, kind: "order" }] as const),
]);
const JOB_MAIN_FIELDS = layoutFields(JOB_MAIN_LAYOUT);
const JOB_GUARD_FIELDS = layoutFields(JOB_GUARD_LAYOUT);

export function jobMainStatePrefix(taskId: string): string { return `${jobStateTaskBase(taskId)}m/`; }
export function jobGuardStatePrefix(taskId: string): string { return `${jobStateTaskBase(taskId)}g/`; }

/** 主投影的工作集；complete 用于从零重放（未装入即不存在）。 */
export function createJobMainState(taskId: string, complete = false): JobStateSet {
  return new JobStateSet(jobMainStatePrefix(taskId), JOB_MAIN_FIELDS, complete);
}

export function createJobGuardState(taskId: string, complete = false): JobStateSet {
  return new JobStateSet(jobGuardStatePrefix(taskId), JOB_GUARD_FIELDS, complete);
}

function buildJobView(binding: JobStateBinding, layout: JobStateLayout): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const name of layout.maps) view[name] = new KeyedMap(binding, name);
  for (const name of [...layout.sets, ...layout.enumerable]) view[name] = new KeyedSet(binding, name);
  for (const name of layout.orders) view[name] = new KeyedOrder(binding, name);
  view.channelInteractions = {
    domain: "job",
    ...Object.fromEntries(Object.entries(JOB_CHANNEL_FIELDS).map(([property, field]) => [property, new KeyedMap(binding, field)])),
  };
  for (const [name, fallback] of Object.entries(layout.root)) {
    Object.defineProperty(view, name, {
      enumerable: true,
      get: () => {
        const root = binding.store.root;
        return name in root ? root[name] : fallback;
      },
      set: (value: unknown) => { binding.store.root[name] = value; },
    });
  }
  return view;
}

/** 绑定之上的主投影对象：读写都落到绑定当前持有的工作集。 */
export function jobProjectionView(binding: JobStateBinding): JobProjection {
  return buildJobView(binding, JOB_MAIN_LAYOUT) as unknown as JobProjection;
}

export function jobSubmissionGuardView(binding: JobStateBinding): JobSubmissionGuardProjection {
  return buildJobView(binding, JOB_GUARD_LAYOUT) as unknown as JobSubmissionGuardProjection;
}

/** 投影对象所在的工作集（目录维护按它查改动）。 */
function jobViewStore(state: { readonly states: KeyedMap<string, unknown> }): JobStateSet {
  return state.states.binding.store;
}

// ---- 当前义务目录 ----

/** occurrence 的倒序时间键：计划时间越晚越靠前。 */
export function occurrenceSortKey(scheduledFor: string): string {
  const at = Date.parse(scheduledFor);
  if (!Number.isFinite(at) || at < 0) throw new TypeError("Occurrence time is invalid");
  return String(8_640_000_000_000_000 - at).padStart(16, "0");
}

const ORDER_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * occurrence 在次序索引里的键：倒序时间键，加 jobRunId 的倒序定宽编码与终止符 `~`，正向读取即
 * compareJobOccurrences 的逆序（新到旧，同一时间 id 大的在前）。每个码元编成 3 位 base-62，取 65535 减码元，
 * 字母表按码元升序，于是同一时间里 id 大的键小；一个 id 是另一个的前缀时，长者多出的首字符不大于 `z`，
 * 小于终止符，长者在前。各键以 `~` 结尾、内部没有 `~`，整条存储键的次序就是次序键的次序。
 * 最长 480 码元的 id 编成 1440 字符，加前缀与主体哈希仍在投影键上限内。
 */
export function occurrenceOrderKey(occurrence: Pick<JobOccurrence, "scheduledFor" | "jobRunId">): string {
  let encoded = "";
  for (let index = 0; index < occurrence.jobRunId.length; index += 1) {
    const value = 65535 - occurrence.jobRunId.charCodeAt(index);
    encoded += ORDER_DIGITS[Math.floor(value / 3844)]! + ORDER_DIGITS[Math.floor(value / 62) % 62]! + ORDER_DIGITS[value % 62]!;
  }
  return `${occurrenceSortKey(occurrence.scheduledFor)}${encoded}~`;
}

/**
 * 每条记录归约后，按本工作集里改动过的主体重算各当前义务目录。只看改动过的主体，
 * 目录与原遍历判定逐条一致：run 未结束、当前派发未结束、结算未完成、挑战未关闭、
 * 授权未镜像、自动停用未落定。
 */
function refreshJobDirectories(state: JobProjection): void {
  const store = jobViewStore(state);
  const changed = (field: string) => store.changedSubjects(field).map(String);
  const toggle = (directory: KeyedSet<string>, subject: string, present: boolean) => {
    if (directory.has(subject) === present) return;
    if (present) directory.add(subject);
    else directory.delete(subject);
  };
  const runOpen = (jobRunId: string) => {
    const current = state.states.get(jobRunId);
    return current !== undefined && !isTerminal(current.state);
  };
  const runs = new Set(changed("states"));
  for (const jobRunId of runs) toggle(state.openRuns, jobRunId, runOpen(jobRunId));
  const assignments = new Set(changed("assignedById"));
  for (const jobRunId of new Set([...runs, ...changed("assignmentByJob")])) {
    const current = state.assignmentByJob.get(jobRunId);
    if (current) assignments.add(current);
    const previous = store.baseOf("assignmentByJob", jobRunId);
    if (previous?.present) assignments.add(previous.value as string);
  }
  for (const assignmentId of assignments) {
    const assigned = state.assignedById.get(assignmentId);
    toggle(state.openAssignments, assignmentId, assigned !== undefined &&
      state.assignmentByJob.get(assigned.record.jobRunId) === assignmentId && runOpen(assigned.record.jobRunId));
  }
  for (const assignmentId of new Set([...changed("interactionSettlementFences"), ...changed("completedInteractionSettlements")])) {
    toggle(state.pendingSettlements, assignmentId,
      state.interactionSettlementFences.has(assignmentId) && !state.completedInteractionSettlements.has(assignmentId));
  }
  const channel = state.channelInteractions;
  for (const challengeId of new Set([...changed(JOB_CHANNEL_FIELDS.preparedByChallenge), ...changed(JOB_CHANNEL_FIELDS.closedByChallenge)])) {
    toggle(state.openChallenges, challengeId,
      channel.preparedByChallenge.get(challengeId)?.ref.execution === "job" && !channel.closedByChallenge.has(challengeId));
  }
  const grants = new Set(changed(JOB_CHANNEL_FIELDS.grantByChallenge));
  for (const assignmentId of changed("interactionMirrors")) {
    const previous = store.baseOf("interactionMirrors", assignmentId)?.value as
      { readonly outcomes: ReadonlyMap<string, unknown> } | undefined;
    for (const outcomes of [state.interactionMirrors.get(assignmentId)?.outcomes, previous?.outcomes]) {
      for (const interactionRequestId of outcomes?.keys() ?? []) {
        const challengeId = channel.challengeByInteraction.get(`${assignmentId}\u0000${interactionRequestId}`);
        if (challengeId) grants.add(challengeId);
      }
    }
  }
  for (const challengeId of grants) toggle(state.pendingGrants, challengeId, jobGrantPending(state, challengeId));
  for (const jobRunId of new Set([...changed("failurePolicyByRun"), ...changed("autoDisableSettledRuns")])) {
    toggle(state.pendingAutoDisable, jobRunId,
      state.failurePolicyByRun.get(jobRunId)?.autoDisableRequired === true && !state.autoDisableSettledRuns.has(jobRunId));
  }
}

/** 频道授权尚未由交互镜像落定；镜像的回答与授权不符即日志损坏。 */
function jobGrantPending(state: JobProjection, challengeId: string): boolean {
  const granted = state.channelInteractions.grantByChallenge.get(challengeId);
  if (!granted || granted.grant.ref.execution !== "job") return false;
  const outcome = state.interactionMirrors
    .get(granted.grant.assignmentId)
    ?.outcomes.get(granted.grant.interactionRequestId);
  if (!outcome) return true;
  if (outcome.t !== "answered") return false;
  if (
    outcome.authority.via !== "channel-grant" ||
    canonicalize(outcome.authority.grant) !== canonicalize(granted.grant)
  ) {
    throw corruptJobJournal("Mirrored job answer conflicts with its durable channel grant");
  }
  return false;
}

/**
 * 按完整次序（compareJobOccurrences）从后往前逐条给出 occurrence，accept 返回 false 即停。
 * 给了 before 时从它之前那一条开始。次序键已含 id，同一时间的多条也逐条按页读，不整组装入。
 */
function walkOccurrencesBackward(
  state: Pick<JobProjection, "occurrenceOrder" | "occurrences">,
  before: Pick<JobOccurrence, "jobRunId" | "scheduledFor"> | undefined,
  accept: (occurrence: JobOccurrence) => boolean,
): void {
  let after = before ? occurrenceOrderKey(before) : undefined;
  let limit = 16;
  for (;;) {
    const rows = state.occurrenceOrder.range({ ...(after === undefined ? {} : { after }), limit });
    for (const row of rows) {
      const occurrence = state.occurrences.get(row.subject);
      if (!occurrence) throw corruptJobJournal("Occurrence order names an unknown occurrence");
      if (!accept(occurrence)) return;
    }
    if (rows.length < limit) return;
    after = rows.at(-1)!.sortKey;
    // 长的倒扫逐页放大，减少装入往返
    limit = Math.min(limit * 2, 256);
  }
}

/** 一条 occurrence 当前的调度事实：最新状态与结果。 */
function scheduleOccurrenceOf(state: Pick<JobProjection, "states" | "outcomeByRun">, occurrence: JobOccurrence): ScheduleOccurrence {
  const current = state.states.get(occurrence.jobRunId);
  const projected = validateJobOccurrence({ ...snapshot(occurrence), state: current?.state ?? occurrence.state });
  const outcome = state.outcomeByRun.get(occurrence.jobRunId);
  return { ...projected, ...(outcome ? { outcome: snapshot(outcome) } : {}) };
}

/**
 * 每条作业流记录后维护连续失败摘要。对本信封里改动过的非错过 occurrence，比较它现在是否失败与摘要里记下的值，
 * 不同才写摘要（不在摘要里即插入）。按完整次序逐条写：同样的记录与归约前状态总得出同样的节点，
 * 持久投影、会话工作集与完整重放三处逐行一致（会话会从持久行补装未装入的节点）。
 * 状态推进而失败与否不变时只读 failureFlagByRun 一行，不碰摘要。
 */
function refreshFailureSummary(state: JobProjection): void {
  const store = jobViewStore(state);
  const changed = new Set(["occurrences", "states", "outcomeByRun"].flatMap((field) => store.changedSubjects(field).map(String)));
  const updates = [...changed]
    .map((jobRunId) => state.occurrences.get(jobRunId))
    .filter((occurrence): occurrence is JobOccurrence => occurrence !== undefined && occurrence.state !== "missed")
    .map((occurrence) => ({ occurrence, failed: isScheduleFailure(scheduleOccurrenceOf(state, occurrence)) }))
    .filter(({ occurrence, failed }) => state.failureFlagByRun.get(occurrence.jobRunId) !== failed)
    .sort((left, right) => compareJobOccurrences(left.occurrence, right.occurrence));
  // 先把各条的定位路径按层一并装入，再逐条写
  requireFailureSummaryPaths(state, updates.map(({ occurrence }) => occurrence));
  for (const { occurrence, failed } of updates) {
    setFailureSummaryEntry(state, occurrence, failed);
    state.failureFlagByRun.set(occurrence.jobRunId, failed);
  }
}

const SCHEDULE_FAILURE_STATES: ReadonlySet<unknown> = new Set(["failed", "expired", "committed"]);

/**
 * 这些作业流记录可能改动连续失败摘要的位置：新的非错过 occurrence，以及进入 failed、expired、committed 的 run
 * （只有这三种状态能让 isScheduleFailure 成立；终态不再改变）。普通状态推进不在其中。
 * 只用已装入的 occurrence：没装入的留给归约时的逐层报缺。
 */
function failureSummaryCandidates(
  state: Pick<JobProjection, "occurrences">,
  bodies: readonly unknown[],
): FailureSummaryPosition[] {
  const positions: FailureSummaryPosition[] = [];
  for (const raw of bodies) {
    const body = raw as { readonly t?: unknown; readonly occ?: JobOccurrence; readonly state?: unknown; readonly jobRunId?: unknown };
    if (body.t === "occurrence" && body.occ && body.occ.state !== "missed") positions.push(body.occ);
    if (body.t !== "state" || typeof body.jobRunId !== "string" || !SCHEDULE_FAILURE_STATES.has(body.state)) continue;
    const occurrence = state.occurrences.peek(body.jobRunId);
    if (occurrence && occurrence.state !== "missed") positions.push(occurrence);
  }
  return positions;
}

/**
 * 归约这些记录之前，把它们在连续失败摘要里的定位路径按层成批装入：每层一次读取，
 * 归约时不再逐层缺键重做（重做会再走一遍整封信封，committed 记录还要重读密封包）。
 */
export async function preloadFailureSummaryPaths(
  set: JobStateSet,
  bodies: readonly unknown[],
  read: import("@zhixing/core/authority").DurableProjectionReadContext,
): Promise<void> {
  // 根行由按主体预装一并装入；没有根行就没有可定位的路径
  if (!set.isLoaded(set.rootKey)) return;
  const view = jobProjectionView(new JobStateBinding(set));
  const positions = failureSummaryCandidates(view, bodies);
  for (;;) {
    const missing = missingFailureSummaryNodes(view, positions);
    if (!missing.length) return;
    await loadJobState(set, missing.map((key) => ({ key })), read);
  }
}

/** 最近一次 occurrence：次序索引的第一行。 */
function latestOccurrence(state: Pick<JobProjection, "occurrenceOrder" | "occurrences">): JobOccurrence | undefined {
  const row = state.occurrenceOrder.range({ limit: 1 })[0];
  if (!row) return undefined;
  const occurrence = state.occurrences.get(row.subject);
  if (!occurrence) throw corruptJobJournal("Occurrence order names an unknown occurrence");
  return occurrence;
}

/** 派发按提交位置排序（与原先按写入次序列出一致）。 */
function byAssignmentCommit(
  state: { readonly assignedById: Pick<KeyedMap<string, { readonly commit: { readonly lsn: number } }>, "get"> },
  assignmentIds: readonly string[],
): string[] {
  return assignmentIds
    .map((assignmentId) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw corruptJobJournal("Assignment directory names an unknown assignment");
      return { assignmentId, lsn: assigned.commit.lsn };
    })
    .sort((left, right) => left.lsn - right.lsn || left.assignmentId.localeCompare(right.assignmentId))
    .map(({ assignmentId }) => assignmentId);
}

/** run 按 occurrence 次序（计划时间、id 升序）排序。 */
function byOccurrenceOrder(
  state: Pick<JobProjection, "occurrences">,
  jobRunIds: readonly string[],
): string[] {
  return jobRunIds
    .map((jobRunId) => {
      const occurrence = state.occurrences.get(jobRunId);
      if (!occurrence) throw corruptJobJournal("Run directory names an unknown occurrence");
      return occurrence;
    })
    .sort(compareJobOccurrences)
    .map((occurrence) => occurrence.jobRunId);
}

/** 调度读取的当前视图：不含历史 run 的全集。 */
export interface JobSchedulerReadView {
  readonly definition?: TaskDefinition;
  /** 非错过 occurrence 的总数。 */
  readonly runCount: number;
  /** 最近一次起向前的连续失败次数。 */
  readonly consecutiveFailures: number;
  readonly last?: ScheduleOccurrence;
  /** 未结束的 occurrence，按计划时间、id 升序。 */
  readonly open: readonly ScheduleOccurrence[];
}

// ---- 按主体预先装入：一条记录或一次决定通常只碰到少数 run/派发/票据/挑战 ----

type JobSubjectKind = "run" | "assignment" | "ticket" | "challenge" | "revision" | "operation";

const JOB_MAIN_SUBJECTS: Readonly<Record<string, JobSubjectKind>> = {
  occurrences: "run", missedNextFireByRun: "run", failurePolicyByRun: "run", failureFlagByRun: "run", capabilityGapByRun: "run",
  systemMissAliases: "run", ingressByJob: "run", states: "run", assignmentByJob: "run", resolutions: "run",
  statusHistoryByRun: "run", outcomeByRun: "run", systemFences: "run", systemResults: "run",
  assignmentAttemptByRun: "run", autoDisableSettledRuns: "run", admittedJobs: "run", openRuns: "run",
  pendingAutoDisable: "run", pendingMissed: "run",
  assignedById: "assignment", superseded: "assignment", supersedeRequests: "assignment",
  supersedeStarted: "assignment", cancelFences: "assignment", interactionSettlementFences: "assignment",
  completedInteractionSettlements: "assignment", acceptedCancellations: "assignment",
  ticketIdsByAssignment: "assignment", interactionMirrors: "assignment", committed: "assignment",
  bundleAcknowledgements: "assignment", durableStarted: "assignment", recoveryAssignments: "assignment",
  bundleAcknowledgementOutbox: "assignment", openAssignments: "assignment", pendingSettlements: "assignment",
  [JOB_CHANNEL_FIELDS.cursorByAssignment]: "assignment",
  ticketsById: "ticket", ticketReplacementsById: "ticket", revokedTickets: "ticket",
  [JOB_CHANNEL_FIELDS.preparedByChallenge]: "challenge", [JOB_CHANNEL_FIELDS.deliveredByChallenge]: "challenge",
  [JOB_CHANNEL_FIELDS.closedByChallenge]: "challenge", [JOB_CHANNEL_FIELDS.grantByChallenge]: "challenge",
  openChallenges: "challenge", pendingGrants: "challenge",
  definitions: "revision", taskOperations: "operation",
};

const JOB_GUARD_SUBJECTS: Readonly<Record<string, JobSubjectKind>> = {
  occurrences: "run", states: "run", ingressByJob: "run", assignmentByJob: "run", resolutions: "run",
  systemFences: "run", systemResults: "run", assignmentAttemptByRun: "run", admittedJobs: "run",
  systemMissAliases: "run",
  assignedById: "assignment", supersedeRequests: "assignment", cancelFences: "assignment",
  interactionSettlementFences: "assignment", completedInteractionSettlements: "assignment",
  ticketIdsByAssignment: "assignment", interactionMirrors: "assignment", committedByAssignment: "assignment",
  bundleAcknowledgements: "assignment", conflictAssignments: "assignment", openConflictAssignments: "assignment",
  supersedeStartedAssignments: "assignment", acceptedCancellations: "assignment", durableStarted: "assignment",
  closedAssignments: "assignment", [JOB_CHANNEL_FIELDS.cursorByAssignment]: "assignment",
  ticketsById: "ticket", ticketReplacementsById: "ticket", revokedTickets: "ticket",
  [JOB_CHANNEL_FIELDS.preparedByChallenge]: "challenge", [JOB_CHANNEL_FIELDS.deliveredByChallenge]: "challenge",
  [JOB_CHANNEL_FIELDS.closedByChallenge]: "challenge", [JOB_CHANNEL_FIELDS.grantByChallenge]: "challenge",
  definitionKinds: "revision", taskOperations: "operation",
};

/** 一次归约或决定涉及的主体。 */
export interface JobScope {
  readonly runs: Set<string>;
  readonly assignments: Set<string>;
  readonly tickets: Set<string>;
  readonly challenges: Set<string>;
  readonly revisions: Set<number>;
  readonly operations: Set<string>;
}

const JOB_SCOPE_NAMES: Readonly<Record<string, Exclude<keyof JobScope, "revisions">>> = {
  jobRunId: "runs", requestedJobRunId: "runs", coalescedJobRunId: "runs", assignmentId: "assignments",
  ticketId: "tickets", replacesTicketId: "tickets", challengeId: "challenges", operationId: "operations",
};

/** 从记录或请求里收集主体标识：只看协议标识字段，不进入正文与载荷。 */
export function jobScopeOf(...inputs: unknown[]): JobScope {
  const scope: JobScope = {
    runs: new Set(), assignments: new Set(), tickets: new Set(), challenges: new Set(),
    revisions: new Set(), operations: new Set(),
  };
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (++visited > 4096 || depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      const target = JOB_SCOPE_NAMES[name];
      if (target && typeof item === "string") scope[target].add(item);
      if ((name === "taskRevision" || name === "disabledTaskRevision") && typeof item === "number") scope.revisions.add(item);
      if (name !== "input" && name !== "output" && name !== "display" && name !== "spec") visit(item, depth + 1);
    }
  };
  for (const input of inputs) visit(input, 0);
  return scope;
}

function scopeKeys(set: JobStateSet, subjects: Readonly<Record<string, JobSubjectKind>>, scope: JobScope): string[] {
  const values: Record<JobSubjectKind, Iterable<string | number>> = {
    run: scope.runs, assignment: scope.assignments, ticket: scope.tickets, challenge: scope.challenges,
    revision: scope.revisions, operation: scope.operations,
  };
  const keys = [set.rootKey];
  for (const [field, kind] of Object.entries(subjects)) {
    for (const subject of values[kind]) keys.push(set.storageKey(field, subject));
  }
  return keys.filter((key) => !set.isLoaded(key));
}

/** 本作业流上的记录正文。 */
function jobStreamBodies(entries: readonly LogicalRecord<unknown>[], taskId: string): unknown[] {
  return entries.filter((entry) => entry.stream === jobStream(taskId)).map((entry) => entry.body);
}

/** 这些记录归约时会读、而本工作集还没装入的主体行。 */
function candidateStateNeeds(
  set: JobStateSet,
  entries: readonly LogicalRecord<unknown>[],
  taskId: string,
): { readonly key: string }[] {
  const scope = jobScopeOf(entries.filter((entry) => entry.stream === jobStream(taskId)).map((entry) => entry.body));
  return scopeKeys(set, JOB_MAIN_SUBJECTS, scope).map((key) => ({ key }));
}

/**
 * 按主体成批装入两份投影的行：先装记录直接涉及的主体，再按装入的结果补齐它们连带的
 * run、当前派发与定义版本（第二轮）。之后仍缺的由重做补齐。
 */
export async function preloadJobScope(
  sets: { readonly main?: JobStateSet; readonly guard?: JobStateSet },
  scope: JobScope,
  read: import("@zhixing/core/authority").DurableProjectionReadContext,
): Promise<void> {
  const load = async () => {
    for (const [set, subjects] of [[sets.main, JOB_MAIN_SUBJECTS], [sets.guard, JOB_GUARD_SUBJECTS]] as const) {
      if (!set) continue;
      await loadJobState(set, scopeKeys(set, subjects, scope).map((key) => ({ key })), read);
    }
  };
  await load();
  const grown = { runs: scope.runs.size, assignments: scope.assignments.size, revisions: scope.revisions.size };
  for (const set of [sets.main, sets.guard]) {
    if (!set) continue;
    const view = (set === sets.main ? jobProjectionView : jobSubmissionGuardView)(new JobStateBinding(set)) as unknown as {
      readonly activeJobRunId?: string; readonly pendingSystemMissedJobRunId?: string;
      readonly assignedById: KeyedMap<string, { readonly record: { readonly jobRunId: string } }>;
      readonly assignmentByJob: KeyedMap<string, string>;
      readonly occurrences: KeyedMap<string, { readonly taskRevision: number }>;
    };
    for (const jobRunId of [view.activeJobRunId, view.pendingSystemMissedJobRunId]) if (jobRunId) scope.runs.add(jobRunId);
    for (const assignmentId of scope.assignments) {
      const jobRunId = view.assignedById.peek(assignmentId)?.record.jobRunId;
      if (jobRunId) scope.runs.add(jobRunId);
    }
    for (const jobRunId of scope.runs) {
      const assignmentId = view.assignmentByJob.peek(jobRunId);
      if (assignmentId) scope.assignments.add(assignmentId);
      const revision = view.occurrences.peek(jobRunId)?.taskRevision;
      if (revision !== undefined) scope.revisions.add(revision);
    }
  }
  if (scope.runs.size !== grown.runs || scope.assignments.size !== grown.assignments || scope.revisions.size !== grown.revisions) await load();
}

/** 作业日志的工作集会话。 */
interface JobJournalSession {
  main: JobStateSet;
  guard: JobStateSet;
  /** 已装入的行对应的持久头位置（最后一封触及本作业的信封）；undefined 表示尚无写入。 */
  head: number | undefined;
  /** 上一次事务结束时的日志游标：下一次事务只续读其后的尾部。 */
  cursor: ProjectionCursor | undefined;
}

/** 会话复用的工作集上限：超过后换新会话，进程内常驻的已装入行有界。 */
const MAX_JOB_SESSION_ROWS = 4096;

export interface PendingJobDispatch {
  readonly assignmentId: string;
  readonly envelope: JobEnvelope;
  readonly activation: AssignmentActivationProof<"job">;
}

export interface PendingJobFence {
  readonly assignmentId: string;
  readonly fence: { readonly fenceSeq: number; readonly requestId: string };
}

/**
 * Process-local wakeups derived only after the authoritative journal commit.
 * They are never replay or recovery facts; consumers rebuild from JobJournal.
 */
export type JobLifecycleEvent =
  | {
      readonly kind: "job-state-changed";
      readonly ref: {
        readonly execution: "job";
        readonly taskId: string;
        readonly jobRunId: string;
        readonly anchorEpoch: number;
      };
      readonly state: JobRunState;
      readonly statusRevision: number;
      readonly assignmentId?: string;
      readonly at: string;
    }
  | {
      readonly kind: "assignment-retired";
      readonly ref: {
        readonly execution: "job";
        readonly taskId: string;
        readonly jobRunId: string;
        readonly anchorEpoch: number;
      };
      readonly assignmentId: string;
      readonly at: string;
    };

export interface InProcessJobCancellationSubmission {
  submitCancellation(assignmentId: string): Promise<boolean>;
}

export type InProcessJobBundleSubmission = InProcessBundleSubmission;

interface InProcessJobDispatcherBaseOptions {
  readonly journal: JobJournal;
  readonly executor: RunExecutorPort;
  readonly contexts: InProcessDispatchContextFactory;
  /**
   * dispatch 被 executor 接受后的进程内执行接缝——与 mesh 服务端
   * onDispatchAccepted 对称;耐久事实已在 executor 账本,这里只是加速
   * 通知,漏通知由 executor 恢复枚举兜底。
   */
  readonly onDispatchAccepted?: (
    envelope: Extract<
      import("@zhixing/core/contracts").DispatchEnvelope,
      { execution: "job" }
    >,
  ) => void | Promise<void>;
  readonly onCancelAccepted?: (
    assignmentId: string,
  ) => void | Promise<void>;
  readonly onRecoveryError?: (error: Error) => void;
}

export type InProcessJobDispatcherOptions = InProcessJobDispatcherBaseOptions &
  (
    | {
        readonly enabled: false;
        readonly cancellationSubmission?: InProcessJobCancellationSubmission;
        readonly bundleSubmission?: InProcessJobBundleSubmission;
      }
    | {
        readonly enabled: true;
        readonly cancellationSubmission: InProcessJobCancellationSubmission;
        readonly bundleSubmission: InProcessJobBundleSubmission;
      }
  );

export interface JobCommitParticipant {
  readonly readProjectionIds?: readonly string[];
  collectStagedReferences?(batch: MutationBatch): Promise<readonly ArtifactRef[]>;
  prepare(input: {
    readonly authorityPrefixLsn: number;
    readonly authorityContext: ProjectionTransactionContext;
    readonly occurrence: JobOccurrence;
    readonly bundle: JobBundle;
    readonly mutationBatch: MutationBatch;
  }): Promise<
    | {
        readonly accepted: true;
        readonly records: readonly LogicalRecord[];
        readonly outcomes: ReadonlyMap<
          number,
          Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"]
        >;
      }
    | { readonly accepted: false; readonly error: AuthorityError }>;
  applyGranted?(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly mutationBatch: MutationBatch;
    readonly outcome: Extract<
      Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"],
      { readonly t: "granted" }
    >;
  }): Promise<void>;
  wakePendingPublishing?(taskId: string): void;
  resumePendingPublishing?(taskId: string): Promise<void>;
}

export interface SystemJobResourceCoordinator {
  /** Read-only callbacks must not append authority records. */
  coordinate<T>(operation: () => Promise<T>, options?: { readonly readOnly: true }): Promise<T>;
  prepareQueuedTerminal(input: {
    readonly workload: Extract<RootResourceWorkload, { readonly kind: "job" }>;
    readonly reason: "cancelled" | "failed" | "expired";
  }): readonly LogicalRecord<unknown>[];
  prepare(input: {
    readonly taskId: string;
    readonly jobRunId: string;
    readonly anchorEpoch: number;
    readonly attempt: number;
  }): Promise<{
    readonly lease: SystemJobResourceLease;
    readonly records: readonly LogicalRecord<unknown>[];
  }>;
  recover(input: {
    readonly fence: SystemJobFence;
  }): Promise<
    | { readonly kind: "reuse"; readonly lease: SystemJobResourceLease }
    | {
        readonly kind: "replace";
        readonly lease: SystemJobResourceLease;
        readonly records: readonly LogicalRecord<unknown>[];
      }
  >;
  terminal(input: {
    readonly lease: SystemJobResourceLease;
    readonly outcome: "committed" | "failed";
  }): readonly LogicalRecord<unknown>[];
  preflightActivationRecords(input: {
    readonly previousFence?: SystemJobFence;
    readonly fence: SystemJobFence;
    readonly records: readonly LogicalRecord<unknown>[];
  }): void;
  preflightTerminalRecords(input: {
    readonly fence: SystemJobFence;
    readonly outcome: "committed" | "failed";
    readonly records: readonly LogicalRecord<unknown>[];
  }): void;
  assertActivationRecords(input: {
    readonly previousFence?: SystemJobFence;
    readonly fence: SystemJobFence;
    readonly records: readonly LogicalRecord<unknown>[];
  }): void;
  assertTerminalRecords(input: {
    readonly fence: SystemJobFence;
    readonly outcome: "committed" | "failed";
    readonly records: readonly LogicalRecord<unknown>[];
  }): void;
}

export interface SystemJobHandlerContext {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly attempt: number;
  readonly params: import("@zhixing/core/contracts").JsonValue | undefined;
}

export type SystemJobHandler = (
  context: SystemJobHandlerContext,
) => Promise<{ readonly summary?: string }>;

export interface JobIngressAuthorizer {
  authorize(
    context: AuthorityCallContext,
    action: "user-trigger" | "user-cancel" | "system-trigger" | "system-cancel",
    definition: TaskDefinition,
  ): void;
}

export interface JobJournalOptions {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly snapshotFor: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
  readonly submission: AssignmentSubmissionAuthorizer;
  readonly ingress: JobIngressAuthorizer;
  readonly legacyAbortTickets?: ConversationAbortTicketAuthorizer;
  readonly delivery: JobDeliveryParticipant;
  readonly commitParticipant?: JobCommitParticipant;
  readonly resources?: AssignmentResourceCoordinator;
  readonly systemResources?: SystemJobResourceCoordinator;
  readonly systemHandlers?: ReadonlyMap<SystemHandlerId, SystemJobHandler>;
  readonly clock?: () => string;
  readonly schedulerFailureThreshold?: number;
  readonly schedulerNotices?: SchedulerUserNoticeJournal;
  readonly localExecutorId?: string;
}

/** Pure assignment metadata checked before the authority is allowed to issue credentials. */
export interface JobAssignmentPlan {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly anchorEpoch: number;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly manifest: UnsignedJobEnvelope["manifest"];
  readonly materialize: () => UnsignedJobEnvelope;
}

export interface JobChannelRelayAdoption {
  readonly checkpoint: StreamVerifierCheckpoint;
  readonly prepared?: JobChannelChallengePreparedRecord;
  readonly closed?: Extract<
    ChannelInteractionRelayRecord,
    { readonly t: "channel-challenge-closed" }
  >;
}

export type JobChannelChallengePreparation =
  | {
      readonly kind: "prepared";
      readonly prepared: JobChannelChallengePreparedRecord;
    }
  | {
      readonly kind: "no-interactive-surface";
    };

/** Durable interaction route derived from the admitted occurrence. */
export type JobInteractionRoute =
  | { readonly kind: "surface-ticket"; readonly ingress: IngressContext }
  | { readonly kind: "channel-grant" }
  | { readonly kind: "no-interactive-surface" };

export type JobCancelResult =
  | { readonly state: "cancelled"; readonly assignmentId?: string }
  | {
      readonly state: "cancel-requested";
      readonly assignmentId: string;
      readonly fence: { readonly fenceSeq: number; readonly requestId: string };
    }
  | { readonly state: Exclude<JobRunState, "cancelled" | "cancel-requested"> };

/** Anchor-owned durable authority for one task and all of its immutable occurrences. */
export interface JobReductionOptions {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly artifacts: ArtifactStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly legacyAbortTickets?: ConversationAbortTicketAuthorizer;
  readonly delivery: JobDeliveryParticipant;
  readonly resources?: AssignmentResourceCoordinator;
  readonly systemResources?: SystemJobResourceCoordinator;
  readonly localExecutorId?: string;
}

/**
 * 作业日志的归约规则：作业日志自身、按键持久投影与对照用例共用这一份。
 * 只持有校验所需的协议与资源服务，不持有任何状态。
 */
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

  get taskId(): string { return this.#taskId; }

  /** 同一组协议与资源服务下另一个作业的归约（持久投影为任意作业归约）。 */
  forTask(taskId: string): JobReduction {
    return new JobReduction({
      taskId,
      anchorEpoch: this.#anchorEpoch,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      delivery: this.#delivery,
      ...(this.#legacyAbortTickets ? { legacyAbortTickets: this.#legacyAbortTickets } : {}),
      ...(this.#resources ? { resources: this.#resources } : {}),
      ...(this.#systemResources ? { systemResources: this.#systemResources } : {}),
      ...(this.#localExecutorId ? { localExecutorId: this.#localExecutorId } : {}),
    });
  }

  /** 一条记录的归约；作业流上的记录之后重算当前义务目录。 */
  readonly reduce = async (
    state: JobProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobProjection> => {
    const next = await this.#reduceRecord(state, raw, envelope);
    if (raw.stream === jobStream(this.#taskId)) {
      refreshJobDirectories(next);
      refreshFailureSummary(next);
    }
    return next;
  };

  readonly #reduceRecord = async (
    state: JobProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobProjection> => {
    if (raw.stream !== jobStream(this.#taskId)) {
      return state;
    }
    const body = await verifyProtocolStep(() => validateJobJournalRecord(raw.body, this.#verifier));
    const envelopeRecords = envelope.entries
      .filter((entry) => entry.stream === jobStream(this.#taskId))
      .map((entry) => entry.body as JobJournalRecord);
    switch (body.t) {
      case "task-revision": {
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
        return state;
      }
      case "occurrence": {
        const definition = state.definition;
        const active = state.activeJobRunId
          ? state.states.get(state.activeJobRunId)
          : undefined;
        assertJobOccurrenceReplayContract({
          taskIdMatches: body.occ.taskId === this.#taskId,
          definitionPresent: definition !== undefined,
          definitionState: definition?.state,
          definitionRevisionMatches:
            definition !== undefined &&
            body.occ.taskRevision === definition.taskRevision,
          definitionKind: definition?.definition.kind,
          identifierUnused:
            !state.occurrences.has(body.occ.jobRunId) &&
            !state.systemMissAliases.has(body.occ.jobRunId),
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
        if (
          !definition ||
          canonicalize(body.occ.deliveryPlan) !==
            canonicalize(deliveryPlan(definition.definition))
        ) {
          throw corruptJobJournal("Job occurrence does not bind the current task definition");
        }
        state.occurrences.set(body.occ.jobRunId, snapshot(body.occ));
        state.occurrenceOrder.add(occurrenceOrderKey(body.occ), body.occ.jobRunId);
        if (body.occ.state !== "missed") state.runCount += 1;
        else if (definition.definition.kind === "user") state.pendingMissed.add(body.occ.jobRunId);
        state.states.set(body.occ.jobRunId, {
          state: body.occ.state,
          statusRevision: 1,
        });
        if (state.statusHistoryByRun.has(body.occ.jobRunId)) {
          throw corruptJobJournal("Job occurrence duplicates its status history");
        }
        state.statusHistoryByRun.set(body.occ.jobRunId, [
          { state: body.occ.state, statusRevision: 1, at: envelope.at },
        ]);
        if (body.occ.state === "queued") state.activeJobRunId = body.occ.jobRunId;
        state.pendingSystemMissedJobRunId = registerPendingSystemMiss({
          currentPendingJobRunId: state.pendingSystemMissedJobRunId,
          jobRunId: body.occ.jobRunId,
          definitionKind: definition.definition.kind,
          occurrenceState: body.occ.state,
        });
        return state;
      }
      case "legacy-next-fire": {
        const definitionRecord = envelopeRecords.find(
          (record) =>
            record.t === "task-revision" &&
            record.taskRevision === body.taskRevision,
        );
        if (!definitionRecord || state.legacyNextFire) {
          throw corruptJobJournal("Legacy next-fire lacks its atomic imported definition");
        }
        state.legacyNextFire = body;
        return state;
      }
      case "missed-next-fire": {
        const occurrence = envelopeRecords.find(
          (record) =>
            record.t === "occurrence" &&
            record.occ.jobRunId === body.jobRunId &&
            record.occ.state === "missed",
        );
        if (!occurrence || state.missedNextFireByRun.has(body.jobRunId)) {
          throw corruptJobJournal("Missed next-fire lacks its atomic missed occurrence");
        }
        state.missedNextFireByRun.set(body.jobRunId, body);
        return state;
      }
      case "failure-policy": {
        const terminal = envelopeRecords.find(
          (record) =>
            record.t === "state" &&
            record.jobRunId === body.jobRunId &&
            (record.state === "failed" || record.state === "expired" ||
              (record.state === "committed" && state.outcomeByRun.get(body.jobRunId)?.status === "failed")) &&
            record.statusRevision === body.statusRevision,
        );
        const occurrence = state.occurrences.get(body.jobRunId);
        if (
          !terminal ||
          !occurrence ||
          occurrence.taskRevision !== body.taskRevision ||
          state.failurePolicyByRun.has(body.jobRunId)
        ) {
          throw corruptJobJournal("Failure policy lacks its atomic failed terminal");
        }
        state.failurePolicyByRun.set(body.jobRunId, body);
        return state;
      }
      case "auto-disable-settled": {
        const policy = state.failurePolicyByRun.get(body.jobRunId);
        if (
          !policy?.autoDisableRequired ||
          state.definition?.state !== "disabled" ||
          state.definition.taskRevision !== body.disabledTaskRevision ||
          state.autoDisableSettledRuns.has(body.jobRunId)
        ) {
          throw corruptJobJournal("Auto-disable settlement is invalid or duplicated");
        }
        state.autoDisableSettledRuns.add(body.jobRunId);
        return state;
      }
      case "capability-gap-opened":
      case "capability-gap-updated": {
        if (!envelope.entries.some((entry) =>
          entry.stream === SCHEDULER_USER_NOTICE_STREAM &&
          typeof entry.body === "object" && entry.body !== null &&
          (entry.body as { noticeId?: unknown }).noticeId === body.noticeId,
        )) {
          throw corruptJobJournal("Capability gap lacks its atomic user notice");
        }
        const current = state.states.get(body.jobRunId);
        if (current?.state !== "queued") {
          throw corruptJobJournal("Capability gap does not bind a queued occurrence");
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
          throw corruptJobJournal("Capability gap update does not bind the open round");
        }
        state.capabilityGapByRun.set(body.jobRunId, {
          round: body.round,
          noticeId: body.noticeId,
          capabilityRevision: body.capabilityRevision,
          reasonDigest: body.reasonDigest,
          reason: body.reason,
          open: true,
        });
        return state;
      }
      case "capability-gap-closed": {
        if (!envelope.entries.some((entry) =>
          entry.stream === SCHEDULER_USER_NOTICE_STREAM &&
          typeof entry.body === "object" && entry.body !== null &&
          (entry.body as { noticeId?: unknown }).noticeId === body.noticeId,
        )) {
          throw corruptJobJournal("Capability gap close lacks its atomic notice update");
        }
        const previous = state.capabilityGapByRun.get(body.jobRunId);
        if (
          !previous?.open ||
          previous.round !== body.round ||
          previous.noticeId !== body.noticeId
        ) {
          throw corruptJobJournal("Capability gap close does not bind the open round");
        }
        state.capabilityGapByRun.set(body.jobRunId, { ...previous, open: false });
        return state;
      }
      case "system-miss-coalesced": {
        const definition = state.definition;
        const coalesced = state.occurrences.get(body.coalescedJobRunId);
        const active = state.activeJobRunId
          ? state.states.get(state.activeJobRunId)
          : undefined;
        assertSystemMissCoalescedReplayContract({
          definitionKind: definition?.definition.kind,
          requestedIdentifierUnused:
            !state.occurrences.has(body.requestedJobRunId) &&
            !state.systemMissAliases.has(body.requestedJobRunId),
          pendingMatchesCoalesced:
            state.pendingSystemMissedJobRunId === body.coalescedJobRunId,
          coalescedState: coalesced?.state,
          activeState: active?.state,
        });
        state.systemMissAliases.set(body.requestedJobRunId, {
          scheduledFor: body.scheduledFor,
          coalescedJobRunId: body.coalescedJobRunId,
        });
        return state;
      }
      case "admitted": {
        const occurrence = state.occurrences.get(body.jobRunId);
        const definition = occurrence
          ? state.definitions.get(occurrence.taskRevision)
          : undefined;
        assertJobAdmissionReplayContract({
          taskIdMatches: body.taskId === this.#taskId,
          occurrencePresent: occurrence !== undefined,
          scheduleMatches: occurrence?.scheduledFor === body.scheduledFor,
          occurrenceState: occurrence?.state,
          definitionKind: definition?.definition.kind,
          admissionAlreadyExists: state.admittedJobs.has(body.jobRunId),
          ingressPresent: body.ingress !== undefined,
          hasAtomicManualControlResult: envelopeHasManualJobRunApplied(
            envelope,
            body.jobRunId,
          ),
        });
        state.admittedJobs.add(body.jobRunId);
        if (body.ingress) state.ingressByJob.set(body.jobRunId, body.ingress);
        return state;
      }
      case "assigned": {
        const occurrence = state.occurrences.get(body.jobRunId);
        const current = state.states.get(body.jobRunId);
        assertAssignmentReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          runAlreadyAssigned: state.assignmentByJob.has(body.jobRunId),
          assignmentAlreadyKnown: state.assignedById.has(body.assignmentId),
          isEarliestQueuedRun: state.activeJobRunId === body.jobRunId,
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
          body.deliveryPlanDigest !== occurrence.deliveryPlan.planDigest
        ) {
          throw corruptJobJournal("Job assignment is invalid or lacks its atomic state");
        }
        const bytes = await this.#artifacts.get(body.dispatchRef);
        const dispatch = await verifyProtocolStep(() => validateJobEnvelope(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as JobEnvelope,
          this.#verifier,
        ));
        await resolveDispatchArtifactClosure(dispatch, this.#artifacts);
        const dispatchArtifact = dispatchEnvelopeArtifact(dispatch);
        if (
          canonicalize(dispatchArtifact.ref) !== canonicalize(body.dispatchRef) ||
          dispatch.assignmentId !== body.assignmentId ||
          dispatch.executorId !== body.executorId ||
          dispatchEnvelopeDigest(dispatch) !== body.dispatchDigest ||
          dispatch.manifest.digest !== body.manifestDigest ||
          permissionSnapshotLeaseDigest(dispatch) !== body.permissionLeaseDigest ||
          canonicalize(dispatch.capabilities.map((capability) => capability.capId)) !==
            canonicalize(body.capIds) ||
          dispatch.resourceLease.reservationId !== body.reservation.reservationId ||
          dispatch.resourceLease.workload.attempt !== body.reservation.attempt
        ) {
          throw corruptJobJournal("Job assignment dispatch artifact is inconsistent");
        }
        assertDispatchMatchesOccurrence(
          dispatch,
          occurrence,
          requireDefinitionRevision(state, occurrence.taskRevision),
          this.#anchorEpoch,
        );
        if (requiresFormalResourceCoordination(dispatch.resourceLease)) {
          if (!this.#resources) {
            throw corruptJobJournal("Job assignment has no resource coordinator");
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
        state.assignmentByJob.set(body.jobRunId, body.assignmentId);
        state.assignmentAttemptByRun.set(body.jobRunId,
          Math.max(state.assignmentAttemptByRun.get(body.jobRunId) ?? 0, body.reservation.attempt));
        state.recoveryAssignments.add(body.assignmentId);
        return state;
      }
      case "dispatch-acked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          alreadyAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.superseded.has(body.assignmentId),
          assignmentClosed: state.superseded.has(body.assignmentId),
        });
        if (!assigned) {
          throw corruptJobJournal("Dispatch acknowledgement is missing or duplicated");
        }
        assigned.acked = true;
        return state;
      }
      case "dispatch-conflict": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertDispatchConflictReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          proofBindsAssignment:
            assigned !== undefined &&
            body.proof.assignmentId === body.assignmentId &&
            body.proof.executorId === assigned.record.executorId,
          handling: body.handling,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.superseded.has(body.assignmentId),
          assignmentClosed: state.superseded.has(body.assignmentId),
          conflictAlreadySeen: state.conflicts.has(body.assignmentId),
        });
        if (!assigned || !current) {
          throw corruptJobJournal("Dispatch conflict identity is invalid or duplicated");
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
                allJobCapabilitiesRevoked(envelopeRecords, state, assigned),
        });
        state.conflicts.set(body.assignmentId, body);
        return state;
      }
      case "dispatch-conflict-contained":
      case "cancel-contained": {
        const assigned = requireReplayAssignment(state, body.assignmentId);
        const open = state.resolutions.get(assigned.record.jobRunId);
        if (
          state.assignmentByJob.get(assigned.record.jobRunId) !== body.assignmentId ||
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
                state.conflicts.get(body.assignmentId)!.proof.receivedRecordSeq)) ||
          (body.t === "cancel-contained" &&
            (open.cause === "dispatch-conflict" || body.proof.decision !== "halted"))
        ) {
          throw corruptJobJournal("Containment does not bind one open uncertain fact");
        }
        if (body.t === "dispatch-conflict-contained") {
          const current = state.states.get(assigned.record.jobRunId);
          const targetState = current
            ? notStartedTargetState(state, current)
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
        return state;
      }
      case "assignment-superseded": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        const open = assigned
          ? state.resolutions.get(assigned.record.jobRunId)
          : undefined;
        const targetState = current
          ? notStartedTargetState(state, current)
          : "queued";
        assertAssignmentSupersededReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          assignmentAlreadyClosed: state.superseded.has(body.assignmentId),
          currentState: current?.state,
          durableStartedObserved: state.durableStarted.has(body.assignmentId),
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              state,
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
            allJobCapabilitiesRevoked(envelopeRecords, state, assigned),
          hasAtomicResolutionClose:
            assigned !== undefined &&
            open !== undefined &&
            open.resolution === undefined &&
            envelopeRecords.some(
              (record) =>
                record.t === "resolution" &&
                record.jobRunId === assigned.record.jobRunId &&
                record.fact.openFactDigest === open.openFactDigest &&
                (record.fact.resolution?.kind === "proven-not-started-redispatched" ||
                  record.fact.resolution?.kind === "proven-not-started-cancelled"),
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
        if (!assigned) throw corruptJobJournal("Assignment supersede has no assignment");
        this.assertAssignmentResourceTerminal(
          assigned.record,
          "release",
          envelope.entries,
        );
        state.superseded.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        return state;
      }
      case "supersede-requested": {
        const assigned = state.assignedById.get(body.assignmentId);
        assertSupersedeRequestReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: assigned
            ? state.states.get(assigned.record.jobRunId)?.state
            : undefined,
          requestAlreadyExists: state.supersedeRequests.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
        });
        state.supersedeRequests.set(body.assignmentId, body);
        return state;
      }
      case "supersede-started-observed": {
        const assigned = state.assignedById.get(body.assignmentId);
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: assigned
            ? state.states.get(assigned.record.jobRunId)?.state
            : undefined,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              state,
              assigned,
              body.proof,
              this.#anchorEpoch,
              this.#legacyAbortTickets,
            ),
          observationAlreadyExists: state.supersedeStarted.has(body.assignmentId),
        });
        state.supersedeStarted.set(body.assignmentId, body);
        state.durableStarted.add(body.assignmentId);
        return state;
      }
      case "cancel-fence": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertJobCancelFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: state.cancelFences.has(body.assignmentId),
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
            state.resolutions.get(assigned.record.jobRunId)?.cause ===
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
        state.cancelFences.set(body.assignmentId, body);
        return state;
      }
      case "interaction-settlement-fence": {
        const assigned = state.assignedById.get(body.assignmentId);
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
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertJobInteractionSettlementFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: state.interactionSettlementFences.has(
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
            ((
              state.resolutions.get(assigned.record.jobRunId)?.cause ===
                "job-cancel-unknown" &&
              state.resolutions.get(assigned.record.jobRunId)?.resolution ===
                undefined
            ) ||
              envelopeRecords.some(
                (record) =>
                  record.t === "resolution" &&
                  record.jobRunId === assigned.record.jobRunId &&
                  record.fact.subject.assignmentId === body.assignmentId &&
                  record.fact.cause === "job-cancel-unknown" &&
                  record.fact.resolution === undefined,
              )),
        });
        state.interactionSettlementFences.set(body.assignmentId, body);
        return state;
      }
      case "interaction-settlement-completed": {
        assertJobInteractionSettlementCompletionReplayContract({
          fence: state.interactionSettlementFences.get(body.assignmentId),
          completion: body,
          completionAlreadyExists:
            state.completedInteractionSettlements.has(body.assignmentId),
          mirrored: state.interactionMirrors.get(body.assignmentId),
          ...("v" in body && body.v === 2
            ? { streamProof: body.streamProof }
            : {}),
        });
        state.completedInteractionSettlements.set(body.assignmentId, body);
        return state;
      }
      case "cancel-proof-accepted": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertCancelProofAcceptedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          acceptanceAlreadyExists: state.acceptedCancellations.has(body.assignmentId),
          durableStartedObserved: state.durableStarted.has(body.assignmentId),
          proofDecision: body.proof.decision,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              state,
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
            allJobCapabilitiesRevoked(envelopeRecords, state, assigned),
        });
        if (!assigned) throw corruptJobJournal("Accepted cancellation has no assignment");
        this.assertAssignmentUsageFinal(assigned.record, body.proof.usageFinal);
        this.assertAssignmentResourceTerminal(
          assigned.record,
          body.proof.decision === "not-started" ? "release" : "settle-release",
          envelope.entries,
        );
        state.acceptedCancellations.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        return state;
      }
      case "not-started-rejected": {
        const assigned = requireReplayAssignment(state, body.assignmentId);
        const current = state.states.get(assigned.record.jobRunId);
        const open = state.resolutions.get(assigned.record.jobRunId);
        const contradictory =
          state.durableStarted.has(body.assignmentId) ||
          ("dispatchDigest" in body.proof && open?.cause === "dispatch-conflict");
        const expectedCause = "cause" in body.proof
          ? "job-cancel-unknown"
          : "ledger-unknown";
        if (
          state.assignmentByJob.get(assigned.record.jobRunId) !== body.assignmentId ||
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
        return state;
      }
      case "capability-revoked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const key = revokedCapabilityKey(body.assignmentId, body.capId);
        assertCapabilityRevocationReplayContract({
          assignmentExists: assigned !== undefined,
          capabilityBelongsToAssignment:
            assigned?.record.capIds.includes(body.capId) ?? false,
          alreadyRevoked: state.revokedCapabilities.has(key),
        });
        state.revokedCapabilities.add(key);
        return state;
      }
      case "ticket-issued": {
        const assigned = state.assignedById.get(body.ticket.assignmentId);
        await applyJobTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          taskId: this.#taskId,
          assigned: assigned?.record,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) ===
              assigned.record.assignmentId,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentClosed: false,
          assignmentActive:
            assigned !== undefined &&
            (state.states.get(assigned.record.jobRunId)?.state ===
              "dispatched" ||
              state.states.get(assigned.record.jobRunId)?.state ===
                "running") &&
            !state.cancelFences.has(body.ticket.assignmentId),
          originalSurfacePrincipal: assigned
            ? state.ingressByJob.get(assigned.record.jobRunId)?.surfacePrincipal
            : undefined,
          hasAtomicReplacementRevocation:
            body.replacesTicketId === undefined ||
            envelopeRecords.some(
              (candidate) =>
                candidate.t === "ticket-revoked" &&
                candidate.ticketId === body.replacesTicketId,
            ),
        });
        return state;
      }
      case "ticket-revoked":
        await applyJobTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          taskId: this.#taskId,
          assignmentIsCurrent: false,
          assignmentAcknowledged: false,
          assignmentClosed: false,
          assignmentActive: false,
        });
        return state;
      case "ticket-sync-frontier":
        applyJobTicketSyncFrontier(
          state,
          body.expiresThrough,
          envelope.at,
        );
        return state;
      case "interaction-mirror": {
        const assigned = state.assignedById.get(body.assignmentId);
        const batch = await verifyProtocolStep(() => validateAssignmentInteractionMirrorBatch(
          body.batch,
          this.#verifier,
        ));
        const batchKey = `${body.assignmentId}:${interactionMirrorBatchDigest(batch)}`;
        const mirrored = state.interactionMirrors.get(body.assignmentId) ?? {
          upTo: 0,
          ordinal: 0,
          digest: interactionMirrorSeed(body.assignmentId),
          requestIds: new Set<string>(),
          outcomes: new Map(),
        };
        const first = batch.entries[0]!;
        const last = batch.entries.at(-1)!;
        const auditSettlement =
          state.completedInteractionSettlements.has(body.assignmentId)
            ? undefined
            : state.interactionSettlementFences.get(body.assignmentId);
        assertJobMirrorReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          executorMatches: assigned?.record.executorId === batch.executorId,
          batchBindsRecord: batch.assignmentId === body.assignmentId,
          currentState: assigned
            ? state.states.get(assigned.record.jobRunId)?.state
            : undefined,
          hasDurableCancelFence: state.cancelFences.has(body.assignmentId),
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
          batchAlreadyMirrored: state.interactionMirrorBatches.has(batchKey),
          extendsCursor:
            batch.previousDigest === mirrored.digest &&
            first.ordinal === mirrored.ordinal + 1 &&
            first.seq > mirrored.upTo,
          repeatsRequestId: batchRepeatsRequestId(batch, mirrored.requestIds),
        });
        state.interactionMirrorBatches.add(batchKey);
        state.interactionMirrors.set(body.assignmentId, {
          upTo: last.seq,
          ordinal: last.ordinal,
          digest: batch.mirrorDigest,
          requestIds: new Set([
            ...mirrored.requestIds,
            ...batch.entries.map((entry) => entry.requestId),
          ]),
          outcomes: new Map([
            ...mirrored.outcomes,
            ...batch.entries.map(
              (entry) => [entry.requestId, snapshot(entry.outcome)] as const,
            ),
          ]),
        });
        return state;
      }
      case "channel-challenge-prepared": {
        const assigned = state.assignedById.get(body.assignmentId);
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
        try {
          await verifyProtocolStep(() => applyChannelInteractionRecord(
            state.channelInteractions,
            body,
            this.#verifier,
          ));
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
    rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      }
      case "channel-challenge-delivered":
      case "channel-challenge-closed":
      case "channel-challenge-granted":
        try {
          await verifyProtocolStep(() => applyChannelInteractionRecord(
            state.channelInteractions,
            body,
            this.#verifier,
          ));
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
    rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      case "channel-relay-cursor": {
        const assigned = state.assignedById.get(body.assignmentId);
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
          await verifyProtocolStep(() => applyChannelInteractionRecord(
            state.channelInteractions,
            body,
            this.#verifier,
          ));
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
    rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      }
      case "resolution": {
        const fact = validateResolutionFact(body.fact);
        if (fact.subject.execution !== "job") {
          throw corruptJobJournal("Job resolution contains a conversation subject");
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
        const current = state.resolutions.get(body.jobRunId);
        const assigned = state.assignedById.get(jobFact.subject.assignmentId);
        const runState = state.states.get(body.jobRunId);
        if (!jobFact.resolution) {
          assertResolutionOpenReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
            assignmentIsCurrent:
              state.assignmentByJob.get(body.jobRunId) ===
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
            throw corruptJobJournal("Job resolution does not close its current open fact");
          }
          const closesEarlierInEnvelope =
            state.assignmentByJob.get(body.jobRunId) === undefined &&
            recordsCloseJobAssignment(
              envelopeRecords,
              body.jobRunId,
              jobFact.subject.assignmentId,
            );
          assertResolutionClosureReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
            assignmentIsCurrentOrAtomicallyClosed:
              state.assignmentByJob.get(body.jobRunId) ===
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
              allJobCapabilitiesRevoked(envelopeRecords, state, assigned),
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
        state.resolutions.set(body.jobRunId, snapshot(jobFact));
        return state;
      }
      case "committed": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = state.states.get(body.jobRunId);
        const open = state.resolutions.get(body.jobRunId);
        const occurrence = state.occurrences.get(body.jobRunId);
        assertCommittedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
          assignmentIsCurrent:
            state.assignmentByJob.get(body.jobRunId) === body.assignmentId,
          currentState: current?.state,
          alreadyCommitted: state.committed.has(body.assignmentId),
          conflictOpen:
            open?.cause === "dispatch-conflict" && open.resolution === undefined,
          commitRevisionMatchesAssignedBase:
            body.jobRevision === state.nextJobRevision,
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
            allJobCapabilitiesRevoked(envelopeRecords, state, assigned),
        });
        if (
          !assigned ||
          !occurrence ||
          !current ||
          (current.state !== "dispatched" &&
            current.state !== "running" &&
            current.state !== "cancel-requested" &&
            current.state !== "uncertain")
        ) {
          throw corruptJobJournal("Job commit is invalid or lacks its atomic state");
        }
        try {
          const bytes = await this.#artifacts.get(body.bundle.ref);
          const bundle = validateJobSealedBundle(
            JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
          );
          const closure = await validateJobBundleClosure(bundle, this.#artifacts);
          if (
            canonicalize(closure.artifact.ref) !== canonicalize(body.bundle.ref) ||
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
              definition: requireDefinitionRevision(state, occurrence.taskRevision),
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
          // 调控状态待装入是可重做的准备，不是日志损坏
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
        state.nextJobRevision += 1;
        return state;
      }
      case "bundle-ack-observed": {
        const committed = state.committed.get(body.assignmentId);
        if (
          !committed ||
          state.bundleAcknowledgements.has(body.assignmentId) ||
          !bundleAcknowledgementBindsCommitted({
            observedBundleRef: body.bundleRef,
            observedCommitRevision: body.jobRevision,
            expectedBundleRef: committed.bundle.ref,
            expectedCommitRevision: committed.jobRevision,
          })
        ) {
          throw corruptJobJournal(
            "Bundle acknowledgement observation does not bind one committed job bundle",
          );
        }
        state.bundleAcknowledgements.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        state.bundleAcknowledgementOutbox.delete(body.assignmentId);
        return state;
      }
      case "system-started": {
        const occurrence = state.occurrences.get(body.jobRunId);
        const current = state.states.get(body.jobRunId);
        const previous = state.systemFences.get(body.jobRunId);
        const definition = occurrence
          ? requireDefinitionRevision(state, occurrence.taskRevision)
          : undefined;
        assertSystemJobActivationReplayContract({
          taskId: this.#taskId,
          jobRunId: body.jobRunId,
          anchorEpoch: this.#anchorEpoch,
          definitionKind: definition?.definition.kind,
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
        assertSystemJobDefinitionReplayContract({ definition, fence: body.fence });
        this.assertReplayedSystemActivation(previous, body.fence, envelope);
        state.systemFences.set(body.jobRunId, snapshot(body.fence));
        return state;
      }
      case "system-result": {
        const detail = validateSystemJobResultDetail(
          await loadJobStored(body.detail, this.#artifacts, "SystemJobResultDetail"),
          body.outcome,
        );
        const current = state.states.get(body.jobRunId);
        const fence = state.systemFences.get(body.jobRunId);
        const occurrence = state.occurrences.get(body.jobRunId);
        const definition = occurrence
          ? requireDefinitionRevision(state, occurrence.taskRevision)
          : undefined;
        assertSystemJobTerminalReplayContract({
          jobRunId: body.jobRunId,
          definitionKind: definition?.definition.kind,
          currentState: current?.state,
          currentFence: fence,
          resultFence: body.fence,
          resultAlreadyExists: state.systemResults.has(body.jobRunId),
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
        state.systemResults.set(body.jobRunId, {
          t: "system-result",
          jobRunId: body.jobRunId,
          fence: snapshot(body.fence),
          outcome: body.outcome,
          ...detail,
        });
        return state;
      }
      case "state": {
        const previous = state.states.get(body.jobRunId);
        const occurrence = state.occurrences.get(body.jobRunId);
        if (!previous || !occurrence) {
          throw corruptJobJournal("Job state transition is invalid");
        }
        const definition = requireDefinitionRevision(state, occurrence.taskRevision);
        try {
          this.#delivery.assertJobStatuses(
            jobStatusDeliveryInputs(this.#taskId, state, envelope.entries, envelope.at),
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
        const assigned = body.assignmentId
          ? state.assignedById.get(body.assignmentId)
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
            state.assignmentByJob.get(body.jobRunId) === body.assignmentId,
          systemFencePresent: state.systemFences.has(body.jobRunId),
          definitionKind: definition.definition.kind,
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
              record.t === "system-started" && record.jobRunId === body.jobRunId,
          ),
          hasAtomicSystemResult: envelopeRecords.some(
            (record) =>
              record.t === "system-result" &&
              record.jobRunId === body.jobRunId &&
              record.outcome === body.state,
          ),
        });
        if (
          previous.state === "queued" &&
          (body.state === "cancelled" || body.state === "failed" || body.state === "expired")
        ) {
          try {
            assertQueuedTerminalDequeue(
              envelope.entries,
              {
                kind: "job",
                id: body.jobRunId,
                attempt: nextJobAssignmentAttempt(state, body.jobRunId),
              },
              body.state,
            );
          } catch (error) {
            if (error instanceof AuthorityPreparationRequired) throw error;
            throw corruptJobJournal(
              error instanceof Error ? error.message : "Queued job resource dequeue is invalid",
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
          if (!allJobCapabilitiesRevoked(envelopeRecords, state, assigned)) {
            throw corruptJobJournal("Assigned job failure is not atomic with revocation");
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
        state.states.set(body.jobRunId, {
          state: body.state,
          statusRevision: body.statusRevision,
        });
        const history = state.statusHistoryByRun.get(body.jobRunId);
        if (!history || history.length + 1 !== body.statusRevision) {
          throw corruptJobJournal("Job status history index is not contiguous");
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
        if (body.state === "running" && body.assignmentId) {
          state.durableStarted.add(body.assignmentId);
        }
        if (body.state === "queued") {
          if (body.assignmentId) state.assignmentByJob.delete(body.jobRunId);
          if (body.assignmentId) state.recoveryAssignments.delete(body.assignmentId);
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
        return state;
      }
      default:
        return assertNever(body);
    }
  };

  readonly reduceSubmissionGuard = async (
    state: JobSubmissionGuardProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobSubmissionGuardProjection> => {
    if (raw.stream !== jobStream(this.#taskId)) {
      throw corruptJobJournal("Job submission guard received a different stream");
    }
    const body = await verifyProtocolStep(() => validateJobJournalRecord(raw.body, this.#verifier));
    const envelopeRecords = envelope.entries
      .filter((entry) => entry.stream === jobStream(this.#taskId))
      .map((entry) => entry.body as JobJournalRecord);
    switch (body.t) {
      case "task-revision": {
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
        return state;
      }
      case "occurrence": {
        const active = state.activeJobRunId
          ? state.states.get(state.activeJobRunId)
          : undefined;
        const definitionKind = state.definitionKinds.get(body.occ.taskRevision);
        assertJobOccurrenceReplayContract({
          taskIdMatches: body.occ.taskId === this.#taskId,
          definitionPresent: state.latestDefinitionRevision !== undefined,
          definitionState: state.latestDefinitionState,
          definitionRevisionMatches:
            body.occ.taskRevision === state.latestDefinitionRevision,
          definitionKind,
          identifierUnused:
            !state.states.has(body.occ.jobRunId) &&
            !state.systemMissAliases.has(body.occ.jobRunId),
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
        if (body.occ.state === "queued") state.activeJobRunId = body.occ.jobRunId;
        state.pendingSystemMissedJobRunId = registerPendingSystemMiss({
          currentPendingJobRunId: state.pendingSystemMissedJobRunId,
          jobRunId: body.occ.jobRunId,
          definitionKind,
          occurrenceState: body.occ.state,
        });
        return state;
      }
      case "legacy-next-fire":
      case "missed-next-fire":
      case "failure-policy":
      case "auto-disable-settled":
      case "capability-gap-opened":
      case "capability-gap-updated":
      case "capability-gap-closed":
        return state;
      case "system-miss-coalesced": {
        const coalesced = state.occurrences.get(body.coalescedJobRunId);
        const active = state.activeJobRunId
          ? state.states.get(state.activeJobRunId)
          : undefined;
        assertSystemMissCoalescedReplayContract({
          definitionKind: coalesced
            ? state.definitionKinds.get(coalesced.taskRevision)
            : undefined,
          requestedIdentifierUnused:
            !state.states.has(body.requestedJobRunId) &&
            !state.systemMissAliases.has(body.requestedJobRunId),
          pendingMatchesCoalesced:
            state.pendingSystemMissedJobRunId === body.coalescedJobRunId,
          coalescedState: state.states.get(body.coalescedJobRunId)?.state,
          activeState: active?.state,
        });
        state.systemMissAliases.add(body.requestedJobRunId);
        return state;
      }
      case "admitted": {
        const occurrence = state.occurrences.get(body.jobRunId);
        assertJobAdmissionReplayContract({
          taskIdMatches: body.taskId === this.#taskId,
          occurrencePresent: occurrence !== undefined,
          scheduleMatches: occurrence?.scheduledFor === body.scheduledFor,
          occurrenceState: state.states.get(body.jobRunId)?.state,
          definitionKind: occurrence
            ? state.definitionKinds.get(occurrence.taskRevision)
            : undefined,
          admissionAlreadyExists: state.admittedJobs.has(body.jobRunId),
          ingressPresent: body.ingress !== undefined,
          hasAtomicManualControlResult: envelopeHasManualJobRunApplied(
            envelope,
            body.jobRunId,
          ),
        });
        state.admittedJobs.add(body.jobRunId);
        if (body.ingress) state.ingressByJob.set(body.jobRunId, body.ingress);
        return state;
      }
      case "assigned": {
        const current = state.states.get(body.jobRunId);
        const occurrence = state.occurrences.get(body.jobRunId);
        assertAssignmentReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          runAlreadyAssigned: state.assignmentByJob.has(body.jobRunId),
          assignmentAlreadyKnown: state.assignedById.has(body.assignmentId),
          isEarliestQueuedRun: state.activeJobRunId === body.jobRunId,
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
          throw corruptJobJournal("Job assignment is invalid or lacks its atomic state");
        }
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
        state.assignmentByJob.set(body.jobRunId, body.assignmentId);
        state.assignmentAttemptByRun.set(body.jobRunId,
          Math.max(state.assignmentAttemptByRun.get(body.jobRunId) ?? 0, body.reservation.attempt));
        return state;
      }
      case "dispatch-acked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          alreadyAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.closedAssignments.has(body.assignmentId),
          assignmentClosed: state.closedAssignments.has(body.assignmentId),
        });
        if (!assigned) {
          throw corruptJobJournal("Dispatch acknowledgement is missing or duplicated");
        }
        assigned.acked = true;
        return state;
      }
      case "dispatch-conflict": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertDispatchConflictReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          proofBindsAssignment:
            assigned !== undefined &&
            body.proof.assignmentId === body.assignmentId &&
            body.proof.executorId === assigned.record.executorId,
          handling: body.handling,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.closedAssignments.has(body.assignmentId),
          assignmentClosed: state.closedAssignments.has(body.assignmentId),
          conflictAlreadySeen: state.conflictAssignments.has(body.assignmentId),
        });
        if (!assigned || !current) {
          throw corruptJobJournal("Dispatch conflict identity is invalid or duplicated");
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
                allJobCapabilitiesRevoked(envelopeRecords, state, {
                  record: assigned.record,
                }),
        });
        state.conflictAssignments.add(body.assignmentId);
        if (body.handling === "opened-uncertain") {
          state.openConflictAssignments.add(body.assignmentId);
        }
        return state;
      }
      case "assignment-superseded": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        const open = assigned
          ? state.resolutions.get(assigned.record.jobRunId)
          : undefined;
        const targetState =
          current !== undefined &&
          (current.state === "cancel-requested" ||
            state.latestDefinitionState !== "enabled")
            ? "cancelled"
            : "queued";
        assertAssignmentSupersededReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          assignmentAlreadyClosed: state.closedAssignments.has(body.assignmentId),
          currentState: current?.state,
          durableStartedObserved: state.durableStarted.has(body.assignmentId),
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              state,
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
            allJobCapabilitiesRevoked(envelopeRecords, state, {
              record: assigned.record,
            }),
          hasAtomicResolutionClose:
            assigned !== undefined &&
            open !== undefined &&
            open.resolution === undefined &&
            envelopeRecords.some(
              (record) =>
                record.t === "resolution" &&
                record.jobRunId === assigned.record.jobRunId &&
                record.fact.openFactDigest === open.openFactDigest &&
                (record.fact.resolution?.kind === "proven-not-started-redispatched" ||
                  record.fact.resolution?.kind === "proven-not-started-cancelled"),
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
        if (!assigned) throw corruptJobJournal("Assignment supersede is historical or duplicated");
        this.assertAssignmentResourceTerminal(
          assigned.record,
          "release",
          envelope.entries,
        );
        state.assignmentByJob.delete(assigned.record.jobRunId);
        state.closedAssignments.add(body.assignmentId);
        state.openConflictAssignments.delete(body.assignmentId);
        return state;
      }
      case "supersede-requested": {
        const assigned = state.assignedById.get(body.assignmentId);
        assertSupersedeRequestReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: assigned
            ? state.states.get(assigned.record.jobRunId)?.state
            : undefined,
          requestAlreadyExists: state.supersedeRequests.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
        });
        state.supersedeRequests.set(body.assignmentId, body);
        return state;
      }
      case "supersede-started-observed": {
        const assigned = state.assignedById.get(body.assignmentId);
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: assigned
            ? state.states.get(assigned.record.jobRunId)?.state
            : undefined,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              state,
              assigned,
              body.proof,
              this.#anchorEpoch,
              this.#legacyAbortTickets,
            ),
          observationAlreadyExists: state.supersedeStartedAssignments.has(
            body.assignmentId,
          ),
        });
        state.supersedeStartedAssignments.add(body.assignmentId);
        state.durableStarted.add(body.assignmentId);
        return state;
      }
      case "cancel-fence": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertJobCancelFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: state.cancelFences.has(body.assignmentId),
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
            state.resolutions.get(assigned.record.jobRunId)?.cause ===
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
        state.cancelFences.set(body.assignmentId, body);
        return state;
      }
      case "interaction-settlement-fence": {
        const assigned = state.assignedById.get(body.assignmentId);
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
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertJobInteractionSettlementFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: state.interactionSettlementFences.has(
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
            ((
              state.resolutions.get(assigned.record.jobRunId)?.cause ===
                "job-cancel-unknown" &&
              state.resolutions.get(assigned.record.jobRunId)?.resolution ===
                undefined
            ) ||
              envelopeRecords.some(
                (record) =>
                  record.t === "resolution" &&
                  record.jobRunId === assigned.record.jobRunId &&
                  record.fact.subject.assignmentId === body.assignmentId &&
                  record.fact.cause === "job-cancel-unknown" &&
                  record.fact.resolution === undefined,
              )),
        });
        state.interactionSettlementFences.set(body.assignmentId, body);
        return state;
      }
      case "interaction-settlement-completed": {
        assertJobInteractionSettlementCompletionReplayContract({
          fence: state.interactionSettlementFences.get(body.assignmentId),
          completion: body,
          completionAlreadyExists:
            state.completedInteractionSettlements.has(body.assignmentId),
          mirrored: state.interactionMirrors.get(body.assignmentId),
          ...("v" in body && body.v === 2
            ? { streamProof: body.streamProof }
            : {}),
        });
        state.completedInteractionSettlements.set(body.assignmentId, body);
        return state;
      }
      case "interaction-mirror": {
        const assigned = state.assignedById.get(body.assignmentId);
        const batch = await verifyProtocolStep(() => validateAssignmentInteractionMirrorBatch(
          body.batch,
          this.#verifier,
        ));
        const batchKey = `${body.assignmentId}:${interactionMirrorBatchDigest(batch)}`;
        const mirrored = state.interactionMirrors.get(body.assignmentId) ?? {
          upTo: 0,
          ordinal: 0,
          digest: interactionMirrorSeed(body.assignmentId),
          requestIds: new Set<string>(),
          outcomes: new Map(),
        };
        const first = batch.entries[0]!;
        const last = batch.entries.at(-1)!;
        const auditSettlement =
          state.completedInteractionSettlements.has(body.assignmentId)
            ? undefined
            : state.interactionSettlementFences.get(body.assignmentId);
        assertJobMirrorReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) ===
              body.assignmentId,
          executorMatches: assigned?.record.executorId === batch.executorId,
          batchBindsRecord: batch.assignmentId === body.assignmentId,
          currentState: assigned
            ? state.states.get(assigned.record.jobRunId)?.state
            : undefined,
          hasDurableCancelFence: state.cancelFences.has(body.assignmentId),
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
          batchAlreadyMirrored: state.interactionMirrorBatches.has(batchKey),
          extendsCursor:
            batch.previousDigest === mirrored.digest &&
            first.ordinal === mirrored.ordinal + 1 &&
            first.seq > mirrored.upTo,
          repeatsRequestId: batchRepeatsRequestId(batch, mirrored.requestIds),
        });
        state.interactionMirrorBatches.add(batchKey);
        state.interactionMirrors.set(body.assignmentId, {
          upTo: last.seq,
          ordinal: last.ordinal,
          digest: batch.mirrorDigest,
          requestIds: new Set([
            ...mirrored.requestIds,
            ...batch.entries.map((entry) => entry.requestId),
          ]),
          outcomes: new Map([
            ...mirrored.outcomes,
            ...batch.entries.map(
              (entry) => [entry.requestId, snapshot(entry.outcome)] as const,
            ),
          ]),
        });
        return state;
      }
      case "channel-challenge-prepared": {
        const assigned = state.assignedById.get(body.assignmentId);
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
        try {
          await verifyProtocolStep(() => applyChannelInteractionRecord(
            state.channelInteractions,
            body,
            this.#verifier,
          ));
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
    rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      }
      case "channel-challenge-delivered":
      case "channel-challenge-closed":
      case "channel-challenge-granted":
        try {
          await verifyProtocolStep(() => applyChannelInteractionRecord(
            state.channelInteractions,
            body,
            this.#verifier,
          ));
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
    rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      case "channel-relay-cursor": {
        const assigned = state.assignedById.get(body.assignmentId);
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
          await verifyProtocolStep(() => applyChannelInteractionRecord(
            state.channelInteractions,
            body,
            this.#verifier,
          ));
        } catch (error) {
          if (error instanceof AuthorityPreparationRequired) throw error;
    rethrowUnloadedProtocolIdentity(error);
          throw corruptJobJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      }
      case "cancel-proof-accepted": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.states.get(assigned.record.jobRunId)
          : undefined;
        assertCancelProofAcceptedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
          currentState: current?.state,
          acceptanceAlreadyExists: state.acceptedCancellations.has(body.assignmentId),
          durableStartedObserved: state.durableStarted.has(body.assignmentId),
          proofDecision: body.proof.decision,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsJobSource(
              state,
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
            allJobCapabilitiesRevoked(envelopeRecords, state, {
              record: assigned.record,
            }),
        });
        if (!assigned) throw corruptJobJournal("Submission guard cancellation has no assignment");
        this.assertAssignmentUsageFinal(assigned.record, body.proof.usageFinal);
        this.assertAssignmentResourceTerminal(
          assigned.record,
          body.proof.decision === "not-started" ? "release" : "settle-release",
          envelope.entries,
        );
        state.acceptedCancellations.add(body.assignmentId);
        return state;
      }
      case "capability-revoked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const key = revokedCapabilityKey(body.assignmentId, body.capId);
        assertCapabilityRevocationReplayContract({
          assignmentExists: assigned !== undefined,
          capabilityBelongsToAssignment: assigned?.capIds.has(body.capId) ?? false,
          alreadyRevoked: state.revokedCapabilities.has(key),
        });
        state.revokedCapabilities.add(key);
        return state;
      }
      case "ticket-issued": {
        const assigned = state.assignedById.get(body.ticket.assignmentId);
        await applyJobTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          taskId: this.#taskId,
          assigned: assigned?.record,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) ===
              assigned.record.assignmentId,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentClosed: state.closedAssignments.has(
            body.ticket.assignmentId,
          ),
          assignmentActive:
            assigned !== undefined &&
            (state.states.get(assigned.record.jobRunId)?.state ===
              "dispatched" ||
              state.states.get(assigned.record.jobRunId)?.state ===
                "running") &&
            !state.cancelFences.has(body.ticket.assignmentId),
          originalSurfacePrincipal: assigned
            ? state.ingressByJob.get(assigned.record.jobRunId)?.surfacePrincipal
            : undefined,
          hasAtomicReplacementRevocation:
            body.replacesTicketId === undefined ||
            envelopeRecords.some(
              (candidate) =>
                candidate.t === "ticket-revoked" &&
                candidate.ticketId === body.replacesTicketId,
            ),
        });
        return state;
      }
      case "ticket-revoked":
        await applyJobTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          taskId: this.#taskId,
          assignmentIsCurrent: false,
          assignmentAcknowledged: false,
          assignmentClosed: false,
          assignmentActive: false,
        });
        return state;
      case "ticket-sync-frontier":
        applyJobTicketSyncFrontier(
          state,
          body.expiresThrough,
          envelope.at,
        );
        return state;
      case "resolution": {
        const fact = validateResolutionFact(body.fact);
        if (fact.subject.execution !== "job") {
          throw corruptJobJournal("Job resolution contains a conversation subject");
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
        const current = state.resolutions.get(body.jobRunId);
        const assigned = state.assignedById.get(jobFact.subject.assignmentId);
        const runState = state.states.get(body.jobRunId);
        if (!jobFact.resolution) {
          assertResolutionOpenReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
            assignmentIsCurrent:
              state.assignmentByJob.get(body.jobRunId) ===
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
            throw corruptJobJournal("Job resolution does not close its current open fact");
          }
          const closesEarlierInEnvelope =
            state.assignmentByJob.get(body.jobRunId) === undefined &&
            recordsCloseJobAssignment(
              envelopeRecords,
              body.jobRunId,
              jobFact.subject.assignmentId,
            );
          assertResolutionClosureReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
            assignmentIsCurrentOrAtomicallyClosed:
              state.assignmentByJob.get(body.jobRunId) ===
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
              allJobCapabilitiesRevoked(envelopeRecords, state, {
                record: assigned.record,
              }),
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
        state.resolutions.set(body.jobRunId, snapshot(jobFact));
        if (jobFact.resolution) {
          state.assignmentByJob.delete(body.jobRunId);
          state.closedAssignments.add(jobFact.subject.assignmentId);
          state.openConflictAssignments.delete(jobFact.subject.assignmentId);
        }
        return state;
      }
      case "committed": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = state.states.get(body.jobRunId);
        const open = state.resolutions.get(body.jobRunId);
        assertCommittedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.jobRunId === body.jobRunId,
          assignmentIsCurrent:
            state.assignmentByJob.get(body.jobRunId) === body.assignmentId,
          currentState: current?.state,
          alreadyCommitted: state.committedByAssignment.has(body.assignmentId),
          conflictOpen:
            open?.cause === "dispatch-conflict" && open.resolution === undefined,
          commitRevisionMatchesAssignedBase:
            body.jobRevision === state.nextJobRevision,
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
            allJobCapabilitiesRevoked(envelopeRecords, state, {
              record: assigned.record,
            }),
        });
        if (!assigned) throw corruptJobJournal("Submission guard commit has no assignment");
        this.assertAssignmentResourceTerminal(
          assigned.record,
          "settle-release",
          envelope.entries,
        );
        state.committedByAssignment.set(body.assignmentId, {
          ref: body.bundle.ref,
          jobRevision: body.jobRevision,
        });
        state.nextJobRevision += 1;
        return state;
      }
      case "bundle-ack-observed": {
        const committed = state.committedByAssignment.get(body.assignmentId);
        if (
          !committed ||
          state.bundleAcknowledgements.has(body.assignmentId) ||
          !bundleAcknowledgementBindsCommitted({
            observedBundleRef: body.bundleRef,
            observedCommitRevision: body.jobRevision,
            expectedBundleRef: committed.ref,
            expectedCommitRevision: committed.jobRevision,
          })
        ) {
          throw corruptJobJournal(
            "Submission guard bundle acknowledgement is invalid or duplicated",
          );
        }
        state.bundleAcknowledgements.set(body.assignmentId, body);
        return state;
      }
      case "system-started": {
        const occurrence = state.occurrences.get(body.jobRunId);
        const current = state.states.get(body.jobRunId);
        const previous = state.systemFences.get(body.jobRunId);
        assertSystemJobActivationReplayContract({
          taskId: this.#taskId,
          jobRunId: body.jobRunId,
          anchorEpoch: this.#anchorEpoch,
          definitionKind: occurrence
            ? state.definitionKinds.get(occurrence.taskRevision)
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
        this.assertReplayedSystemActivation(previous, body.fence, envelope);
        state.systemFences.set(body.jobRunId, snapshot(body.fence));
        return state;
      }
      case "system-result": {
        const current = state.states.get(body.jobRunId);
        const fence = state.systemFences.get(body.jobRunId);
        const occurrence = state.occurrences.get(body.jobRunId);
        assertSystemJobTerminalReplayContract({
          jobRunId: body.jobRunId,
          definitionKind: occurrence
            ? state.definitionKinds.get(occurrence.taskRevision)
            : undefined,
          currentState: current?.state,
          currentFence: fence,
          resultFence: body.fence,
          resultAlreadyExists: state.systemResults.has(body.jobRunId),
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
        state.systemResults.add(body.jobRunId);
        return state;
      }
      case "state": {
        const previous = state.states.get(body.jobRunId);
        const occurrence = state.occurrences.get(body.jobRunId);
        if (!previous || !occurrence) {
          throw corruptJobJournal("Job state transition is invalid");
        }
        const assigned = body.assignmentId
          ? state.assignedById.get(body.assignmentId)
          : undefined;
        const closedEarlierInEnvelope =
          body.assignmentId !== undefined &&
          state.assignmentByJob.get(body.jobRunId) === undefined &&
          state.closedAssignments.has(body.assignmentId) &&
          recordsCloseJobAssignment(
            envelopeRecords,
            body.jobRunId,
            body.assignmentId,
          );
        assertJobStateReplayContract({
          currentState: previous.state,
          currentRevision: previous.statusRevision,
          nextState: body.state,
          nextRevision: body.statusRevision,
          assignmentId: body.assignmentId,
          assignmentBindingValid:
            assigned !== undefined &&
            assigned.record.jobRunId === body.jobRunId &&
            (state.assignmentByJob.get(body.jobRunId) === body.assignmentId ||
              closedEarlierInEnvelope),
          systemFencePresent: state.systemFences.has(body.jobRunId),
          definitionKind: state.definitionKinds.get(occurrence.taskRevision),
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
              record.t === "system-started" && record.jobRunId === body.jobRunId,
          ),
          hasAtomicSystemResult: envelopeRecords.some(
            (record) =>
              record.t === "system-result" &&
              record.jobRunId === body.jobRunId &&
              record.outcome === body.state,
          ),
        });
        if (
          previous.state === "queued" &&
          (body.state === "cancelled" || body.state === "failed" || body.state === "expired")
        ) {
          try {
            assertQueuedTerminalDequeue(
              envelope.entries,
              {
                kind: "job",
                id: body.jobRunId,
                attempt: nextJobAssignmentAttempt(state, body.jobRunId),
              },
              body.state,
            );
          } catch (error) {
            if (error instanceof AuthorityPreparationRequired) throw error;
            throw corruptJobJournal(
              error instanceof Error ? error.message : "Queued job resource dequeue is invalid",
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
          if (!allJobCapabilitiesRevoked(envelopeRecords, state, assigned)) {
            throw corruptJobJournal("Assigned job failure is not atomic with revocation");
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
        state.states.set(body.jobRunId, {
          state: body.state,
          statusRevision: body.statusRevision,
        });
        if (body.state === "running" && body.assignmentId) {
          state.durableStarted.add(body.assignmentId);
        }
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
        return state;
      }
      default:
        return state;
    }
  };

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
    if (!requiresFormalResourceCoordination({
      reservationId: assigned.reservation.reservationId,
      assignmentId: assigned.assignmentId,
    })) return;
    if (!this.#resources) {
      throw corruptJobJournal("Governed job assignment has no resource coordinator");
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
    if (!requiresFormalResourceCoordination({
      reservationId: assigned.reservation.reservationId,
      assignmentId: assigned.assignmentId,
    })) return;
    if (!this.#resources) {
      throw corruptJobJournal("Governed job assignment has no resource coordinator");
    }
    try {
      this.#resources.assertUsageFinal({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
        executorId: assigned.executorId,
        usageFinal,
      });
    } catch (error) {
      // 调控状态待装入是可重做的准备，不是日志损坏
      if (error instanceof AuthorityPreparationRequired) throw error;
      throw corruptJobJournal(
        error instanceof Error
          ? `Job assignment final usage is invalid: ${error.message}`
          : "Job assignment final usage is invalid",
      );
    }
  }
}

/**
 * 为日志登记作业域持久投影。同一运行时的作业日志共用这组协议与资源服务；在任何作业日志
 * 建立之前（例如启动时列出要恢复的任务）也可先登记。
 */
export function registerJobJournalProjection(
  log: AuthorityCommitLog,
  services: Omit<JobReductionOptions, "taskId">,
): RebuildableDurableProjectionIndex {
  return registerJobRunStateProjection(log, (taskId) => new JobReduction({ ...services, taskId }));
}

export class JobJournal implements AssignmentSubmissionPreflightPort {
  readonly #taskId: string;
  readonly #anchorEpoch: number;
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #snapshotFor: JobJournalOptions["snapshotFor"];
  readonly #submission: AssignmentSubmissionAuthorizer;
  readonly #ingress: JobIngressAuthorizer;
  readonly #legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly #delivery: JobDeliveryParticipant;
  readonly #commitParticipant: JobCommitParticipant | undefined;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #systemResources: SystemJobResourceCoordinator | undefined;
  readonly #systemHandlers: ReadonlyMap<SystemHandlerId, SystemJobHandler>;
  readonly #clock: () => string;
  readonly #schedulerFailureThreshold: number;
  readonly #schedulerNotices: SchedulerUserNoticeJournal | undefined;
  readonly #localExecutorId: string | undefined;
  readonly #reduction: JobReduction;
  readonly #operations = new SerialTaskQueue();
  readonly #statusListeners = new Set<
    (notice: JobStatusNotice) => void | Promise<void>
  >();
  readonly #lifecycleListeners = new Set<
    (event: JobLifecycleEvent) => void | Promise<void>
  >();
  readonly #systemRuns = new Map<string, Promise<"committed" | "failed">>();
  readonly #index: RebuildableDurableProjectionIndex;
  #session: JobJournalSession | undefined;

  constructor(options: JobJournalOptions) {
    assertIdentifier(options.taskId, "Task id");
    assertPositive(options.anchorEpoch, "Anchor epoch");
    this.#taskId = options.taskId;
    this.#anchorEpoch = options.anchorEpoch;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#snapshotFor = options.snapshotFor;
    this.#submission = options.submission;
    this.#ingress = options.ingress;
    this.#legacyAbortTickets = options.legacyAbortTickets;
    this.#delivery = options.delivery;
    this.#commitParticipant = options.commitParticipant;
    this.#resources = options.resources;
    this.#systemResources = options.systemResources;
    this.#systemHandlers = options.systemHandlers ?? new Map();
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#schedulerFailureThreshold =
      options.schedulerFailureThreshold ?? DEFAULT_SCHEDULE_FAILURE_THRESHOLD;
    this.#schedulerNotices = options.schedulerNotices;
    this.#localExecutorId = options.localExecutorId;
    this.#reduction = new JobReduction({
      taskId: this.#taskId,
      anchorEpoch: this.#anchorEpoch,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      delivery: this.#delivery,
      ...(this.#legacyAbortTickets ? { legacyAbortTickets: this.#legacyAbortTickets } : {}),
      ...(this.#resources ? { resources: this.#resources } : {}),
      ...(this.#systemResources ? { systemResources: this.#systemResources } : {}),
      ...(this.#localExecutorId ? { localExecutorId: this.#localExecutorId } : {}),
    });
    const services = this.#reduction;
    this.#index = registerJobRunStateProjection(this.#log, (taskId) => services.forTask(taskId));
    assertPositive(this.#schedulerFailureThreshold, "Scheduler failure threshold");
  }

  onStatus(listener: (notice: JobStatusNotice) => void | Promise<void>): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onLifecycle(
    listener: (event: JobLifecycleEvent) => void | Promise<void>,
  ): () => void {
    this.#lifecycleListeners.add(listener);
    return () => this.#lifecycleListeners.delete(listener);
  }

  async channelRelayCheckpoint(
    assignmentId: string,
  ): Promise<StreamVerifierCheckpoint | undefined> {
    assertIdentifier(assignmentId, "Channel relay assignmentId");
    return this.#select((state) => {
      const cursor = state.channelInteractions.cursorByAssignment.get(assignmentId);
      return cursor
        ? structuredClone(cursor.checkpoint)
        : undefined;
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
      Math.max(
        Date.parse(acceptedAt),
        Date.parse(event.issuedAt),
      ),
    ).toISOString();
    const expiry = new Date(
      Math.min(
        Date.parse(event.expiresAt),
        Date.parse(acceptedAt) + remainingMs,
      ),
    ).toISOString();
    if (Date.parse(expiry) <= Date.parse(issuedAt)) {
      return { kind: "no-interactive-surface" };
    }
    return this.#select((state) => {
      const assigned = state.assignedById.get(frame.assignmentId);
      const occurrence = assigned
        ? state.occurrences.get(assigned.record.jobRunId)
        : undefined;
      const definition = occurrence
        ? requireDefinitionRevision(state, occurrence.taskRevision)
        : undefined;
      if (
        !assigned ||
        assigned.record.jobRunId !== ref.jobRunId ||
        assigned.record.anchorEpoch !== ref.anchorEpoch
      ) {
        throw new TypeError(
          "Job channel request does not bind the current assignment",
        );
      }
      if (state.ingressByJob.has(assigned.record.jobRunId)) {
        throw new Error(
          "Manual jobs cannot use the scheduled channel-grant route",
        );
      }
      if (
        !definition ||
        definition.definition.kind !== "user" ||
        !definition.definition.origin ||
        !definition.definition.interactionResponder
      ) {
        return { kind: "no-interactive-surface" as const };
      }
      const challengeId = protocolDigest("ChannelChallengeIdentity", 1, {
        ref,
        assignmentId: frame.assignmentId,
        interactionRequestId: event.requestId,
      });
      const token = createSignedChannelChallengeToken(
        {
          v: 1,
          challengeId,
          ref,
          assignmentId: frame.assignmentId,
          interactionRequestId: event.requestId,
          route: definition.definition.origin,
          displayDigest: interactionDisplayDigest(
            event.toolName,
            event.display,
          ),
          issuedAt,
          expiry,
        },
        this.#signer,
      );
      const prepared = validateChannelInteractionRelayRecord(
        {
          t: "channel-challenge-prepared",
          ref,
          assignmentId: frame.assignmentId,
          frameSeq: frame.seq,
          token,
          responder: definition.definition.interactionResponder,
          toolName: event.toolName,
          display: event.display,
        },
        this.#verifier,
      ) as JobChannelChallengePreparedRecord;
      return { kind: "prepared" as const, prepared };
    });
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
        : (await verifyProtocolStep(() => validateChannelInteractionRelayRecord(
            input.prepared,
            this.#verifier,
          )) as JobChannelChallengePreparedRecord);
    const cursor = await verifyProtocolStep(() => validateChannelInteractionRelayRecord(
      {
        t: "channel-relay-cursor",
        jobRunId: ref.jobRunId,
        assignmentId: frame.assignmentId,
        upToSeq: frame.seq,
        checkpoint,
      },
      this.#verifier,
    )) as Extract<
      ChannelInteractionRelayRecord,
      { readonly t: "channel-relay-cursor" }
    >;
    const candidateReferences = prepared
      ? collectArtifactRefs(prepared)
      : [];

    const transaction = await this.#transact<JobChannelRelayAdoption>(
      (state, context) => {
        const assigned = state.assignedById.get(frame.assignmentId);
        if (
          !assigned ||
          assigned.record.jobRunId !== ref.jobRunId ||
          assigned.record.anchorEpoch !== ref.anchorEpoch
        ) {
          throw new TypeError(
            "Channel relay frame does not bind the current assignment",
          );
        }
        const current =
          state.channelInteractions.cursorByAssignment.get(frame.assignmentId);
        if (current) {
          if (frame.seq < current.upToSeq) {
            throw new TypeError("Channel relay frame precedes the durable cursor");
          }
          if (frame.seq === current.upToSeq) {
            if (canonicalize(current) !== canonicalize(cursor)) {
              throw new TypeError(
                "Channel relay frame conflicts with the durable cursor",
              );
            }
            return {
              kind: "return",
              value: relayAdoptionAtCursor(
                state.channelInteractions,
                frame.assignmentId,
                frame,
                current.checkpoint,
              ),
            };
          }
        }
        if (frame.seq !== (current?.upToSeq ?? 0) + 1) {
          throw new TypeError("Channel relay frame skips the durable cursor");
        }

        const records: ChannelInteractionRelayRecord[] = [];
        let adoptedPrepared: JobChannelChallengePreparedRecord | undefined;
        let closed:
          | Extract<
              ChannelInteractionRelayRecord,
              { readonly t: "channel-challenge-closed" }
            >
          | undefined;
        if (
          frame.payload.kind === "interaction" &&
          frame.payload.event.t === "requested"
        ) {
          if (!prepared) {
            const mirroredOutcome = state.interactionMirrors
              .get(frame.assignmentId)
              ?.outcomes.get(frame.payload.event.requestId);
            if (!mirroredOutcome || mirroredOutcome.t === "answered") {
              throw new TypeError(
                "Channel interaction request without a prepared challenge requires a matching non-answered durable terminal result",
              );
            }
          } else {
            if (
              canonicalize(prepared.ref) !== canonicalize(frame.ref) ||
              prepared.assignmentId !== frame.assignmentId ||
              prepared.frameSeq !== frame.seq ||
              prepared.token.interactionRequestId !== frame.payload.event.requestId ||
              prepared.toolName !== frame.payload.event.toolName ||
              canonicalize(prepared.display) !==
                canonicalize(frame.payload.event.display) ||
              prepared.token.issuedAt < frame.payload.event.issuedAt ||
              prepared.token.expiry > frame.payload.event.expiresAt
            ) {
              throw new TypeError(
                "Prepared channel challenge does not bind its stream frame",
              );
            }
            adoptedPrepared = prepared;
            records.push(prepared);
          }
        } else if (prepared) {
          throw new TypeError(
            "Only an interaction request can carry a prepared record",
          );
        }

        if (
          frame.payload.kind === "interaction" &&
          frame.payload.event.t === "finished"
        ) {
          const interactionKey =
            `${frame.assignmentId}\u0000${frame.payload.event.requestId}`;
          const challengeId =
            state.channelInteractions.challengeByInteraction.get(interactionKey);
          if (!challengeId) {
            const mirroredOutcome = state.interactionMirrors
              .get(frame.assignmentId)
              ?.outcomes.get(frame.payload.event.requestId);
            if (
              !mirroredOutcome ||
              mirroredOutcome.t === "answered" ||
              channelRelayFinishedOutcome(mirroredOutcome) !==
                frame.payload.event.outcome
            ) {
              throw new TypeError(
                "Channel interaction completion without a prepared challenge does not match a non-answered durable terminal result",
              );
            }
          } else {
            closed = {
              t: "channel-challenge-closed",
              challengeId,
              outcome: frame.payload.event.outcome,
              at: context.at,
            };
            records.push(closed);
          }
        }
        records.push(cursor);

        return {
          kind: "append",
          entries: records.map((record) => jobRecord(this.#taskId, record)),
          value: {
            checkpoint,
            ...(adoptedPrepared ? { prepared: adoptedPrepared } : {}),
            ...(closed ? { closed } : {}),
          },
        };
      },
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
    const token = await verifyProtocolStep(() => validateChannelChallengeToken(input.token, this.#verifier));
    if (token.ref.execution !== "job") {
      throw new TypeError("Job channel callback requires a job token");
    }
    const jobToken = token as JobChannelChallengeToken;
    const responder = validateChannelResponderRef(input.responder);
    const at = input.at ?? this.#clock();
    return (
      await this.#transact<ChannelInteractionGrant>((state) => {
        const prepared =
          state.channelInteractions.preparedByChallenge.get(jobToken.challengeId);
        if (
          !prepared ||
          prepared.ref.execution !== "job" ||
          canonicalize(prepared.token) !== canonicalize(jobToken) ||
          canonicalize(prepared.responder) !== canonicalize(responder) ||
          state.channelInteractions.closedByChallenge.has(jobToken.challengeId)
        ) {
          throw new TypeError(
            "Job channel callback does not bind a pending challenge",
          );
        }
        const existing =
          state.channelInteractions.grantByChallenge.get(jobToken.challengeId);
        if (existing) {
          if (
            canonicalize(existing.grant.responder) !==
              canonicalize(responder) ||
            canonicalize(existing.grant.decision) !==
              canonicalize(input.decision)
          ) {
            throw new TypeError(
              "Job channel challenge already has a different grant",
            );
          }
          return {
            kind: "return",
            value: structuredClone(existing.grant),
          };
        }
        assertChannelChallengeActiveAt(jobToken, at);
        const expiry = jobToken.expiry;
        const grant = createSignedChannelInteractionGrant(
          {
            v: 1,
            grantId: protocolDigest("ChannelInteractionGrantIdentity", 1, {
              challengeId: jobToken.challengeId,
            }),
            ref: jobToken.ref,
            assignmentId: jobToken.assignmentId,
            interactionRequestId: jobToken.interactionRequestId,
            challengeToken: jobToken,
            route: jobToken.route,
            responder,
            decision: input.decision,
            issuedAt: at,
            expiry,
          },
          this.#signer,
          this.#verifier,
        );
        const record = validateChannelInteractionRelayRecord(
          {
            t: "channel-challenge-granted",
            jobRunId: jobToken.ref.jobRunId,
            challengeId: jobToken.challengeId,
            grant,
          },
          this.#verifier,
        );
        return {
          kind: "append",
          entries: [jobRecord(this.#taskId, record)],
          value: validateChannelInteractionGrant(grant, this.#verifier),
        };
      })
    ).value;
  }

  async taskMutationRevision(
    operationId: string,
    operationDigest: string,
  ): Promise<number | undefined> {
    assertIdentifier(operationId, "Task mutation operationId");
    return this.#select((state) => {
      const receipt = state.taskOperations.get(operationId);
      if (!receipt) return undefined;
      if (receipt.digest !== operationDigest) {
        throw new Error("Task mutation operation id has a conflicting payload");
      }
      return receipt.taskRevision;
    });
  }

  /**
   * 调度策略事实：给定 run 的错过/失败策略（调度器传最近一次 occurrence），以及尚待自动停用的策略
   * （按 occurrence 次序）。不遍历历史 run。
   */
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
    for (const jobRunId of jobRunIds) assertIdentifier(jobRunId, "Scheduler policy jobRunId");
    return this.#select((state) => {
      const exact = <V>(map: KeyedMap<string, V>) => new Map(jobRunIds.flatMap((jobRunId) => {
        const value = map.get(jobRunId);
        return value === undefined ? [] : [[jobRunId, structuredClone(value)] as const];
      }));
      const pending = state.pendingAutoDisable.values().map((jobRunId) => {
        const policy = state.failurePolicyByRun.get(jobRunId);
        const occurrence = state.occurrences.get(jobRunId);
        if (!policy || !occurrence) throw corruptJobJournal("Pending auto-disable has no durable policy");
        return { policy, occurrence };
      }).sort((left, right) => compareJobOccurrences(left.occurrence, right.occurrence));
      return {
        ...(state.legacyNextFire
          ? { legacyNextFire: structuredClone(state.legacyNextFire) }
          : {}),
        missedNextFireByRun: exact(state.missedNextFireByRun),
        failurePolicyByRun: exact(state.failurePolicyByRun),
        pendingAutoDisable: pending.map(({ policy }) => structuredClone(policy)),
      };
    });
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
    if (input.reason.length === 0) throw new TypeError("Capability gap reason is required");
    await this.#transact<void>((state) => {
      const occurrence = state.occurrences.get(input.jobRunId);
      const current = state.states.get(input.jobRunId);
      const definition = occurrence
        ? requireDefinitionRevision(state, occurrence.taskRevision)
        : undefined;
      const decision = decideScheduleCapabilityGap({
        taskId: this.#taskId, jobRunId: input.jobRunId,
        ...(definition ? { definition } : {}),
        ...(current ? { state: current.state } : {}),
        previous: state.capabilityGapByRun.get(input.jobRunId),
        capabilityRevision: input.capabilityRevision, reason: input.reason,
      });
      if (!decision) return { kind: "return", value: undefined };
      const entries: LogicalRecord<unknown>[] = [
        jobRecord(this.#taskId, {
          t: decision.kind, jobRunId: input.jobRunId,
          round: decision.round, noticeId: decision.noticeId,
          capabilityRevision: input.capabilityRevision,
          reasonDigest: decision.reasonDigest, reason: input.reason,
        }),
        ...this.#schedulerNotices!.prepareRecords({ ...decision.notice, at: this.#clock() }),
      ];
      return { kind: "append", entries, value: undefined };
    });
    await this.#schedulerNotices.publishNew();
  }

  async settleSchedulerAutoDisable(input: {
    readonly jobRunId: string;
    readonly disabledTaskRevision: number;
    readonly context: AuthorityCallContext;
  }): Promise<void> {
    if (input.context.principal.kind !== "host") {
      throw new Error("Scheduler policy settlement is host-owned");
    }
    await this.#transact<void>((state) => {
      if (state.autoDisableSettledRuns.has(input.jobRunId)) {
        return { kind: "return", value: undefined };
      }
      const policy = state.failurePolicyByRun.get(input.jobRunId);
      if (!policy?.autoDisableRequired) {
        throw new Error("Scheduler auto-disable has no durable obligation");
      }
      if (
        state.definition?.state !== "disabled" ||
        state.definition.taskRevision !== input.disabledTaskRevision
      ) {
        throw new Error("Scheduler auto-disable settlement lacks its disabled definition");
      }
      return {
        kind: "append",
        entries: [jobRecord(this.#taskId, {
          t: "auto-disable-settled",
          jobRunId: input.jobRunId,
          disabledTaskRevision: input.disabledTaskRevision,
        })],
        value: undefined,
      };
    });
  }

  async pendingChannelGrantDeliveries(): Promise<
    readonly ChannelInteractionGrant[]
  > {
    // 待镜像目录与原判定一致：授权仍没有镜像结果；镜像与授权不符在写入时已被拒绝
    return this.#select((state) =>
      state.pendingGrants.values()
        .map((challengeId) => {
          const granted = state.channelInteractions.grantByChallenge.get(challengeId);
          if (!granted) throw corruptJobJournal("Pending channel grant has no durable grant");
          return granted.grant;
        })
        .sort((left, right) =>
          left.assignmentId.localeCompare(right.assignmentId) ||
          left.challengeToken.challengeId.localeCompare(right.challengeToken.challengeId))
        .map((grant) => structuredClone(grant)),
    );
  }

  async interactionRoute(assignmentId: string): Promise<JobInteractionRoute> {
    assertIdentifier(assignmentId, "Interaction route assignmentId");
    return this.#select((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Interaction route assignment is unknown");
      if (state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId) {
        throw new Error("Interaction route requires the current assignment");
      }
      const ingress = state.ingressByJob.get(assigned.record.jobRunId);
      if (ingress) {
        return {
          kind: "surface-ticket" as const,
          ingress: snapshot(ingress),
        };
      }
      const occurrence = state.occurrences.get(assigned.record.jobRunId);
      const definition = occurrence
        ? requireDefinitionRevision(state, occurrence.taskRevision)
        : undefined;
      return definition?.definition.kind === "user" &&
        definition.definition.origin &&
        definition.definition.interactionResponder
        ? { kind: "channel-grant" as const }
        : { kind: "no-interactive-surface" as const };
    });
  }

  async pendingChannelChallenges(): Promise<readonly PendingChannelChallenge[]> {
    return this.#select((state) =>
      state.openChallenges.values()
        .map((challengeId) => {
          const prepared = state.channelInteractions.preparedByChallenge.get(challengeId);
          if (prepared?.ref.execution !== "job") {
            throw corruptJobJournal("Open channel challenge has no durable job preparation");
          }
          return prepared as JobChannelChallengePreparedRecord;
        })
        .sort((left, right) =>
          left.assignmentId.localeCompare(right.assignmentId) || left.frameSeq - right.frameSeq)
        .map((prepared) => {
          const delivered =
            state.channelInteractions.deliveredByChallenge.get(
              prepared.token.challengeId,
            );
          return {
            prepared: structuredClone(prepared),
            ...(delivered ? { delivered: structuredClone(delivered) } : {}),
          };
        }),
    );
  }

  async recordChannelChallengeDelivered(input: {
    readonly challengeId: string;
    readonly receipt: {
      readonly acceptedAt: string;
      readonly platformMessage?: import("@zhixing/core/contracts").ChannelMessageRef;
    };
  }): Promise<void> {
    const record = await verifyProtocolStep(() => validateChannelInteractionRelayRecord(
      {
        t: "channel-challenge-delivered",
        challengeId: input.challengeId,
        receipt: input.receipt,
      },
      this.#verifier,
    ));
    await this.#transact<void>((state) => {
      const current =
        state.channelInteractions.deliveredByChallenge.get(input.challengeId);
      if (current && canonicalize(current) === canonicalize(record)) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [jobRecord(this.#taskId, record)],
        value: undefined,
      };
    });
  }

  async closeChannelChallenge(input: {
    readonly challengeId: string;
    readonly outcome: "cancelled" | "expired";
    readonly at: string;
  }): Promise<void> {
    const record = await verifyProtocolStep(() => validateChannelInteractionRelayRecord(
      {
        t: "channel-challenge-closed",
        challengeId: input.challengeId,
        outcome: input.outcome,
        at: input.at,
      },
      this.#verifier,
    ));
    await this.#transact<void>((state) => {
      const current =
        state.channelInteractions.closedByChallenge.get(input.challengeId);
      if (current && canonicalize(current) === canonicalize(record)) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [jobRecord(this.#taskId, record)],
        value: undefined,
      };
    });
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
    this.#authorizeDefinition(context, candidate);
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
    const revision = await this.#transact<{
      readonly taskRevision: number;
      readonly replayed: boolean;
    }>((state, prefix) => {
      if (operation) {
        const replay = state.taskOperations.get(operation.operationId);
        if (replay) {
          if (replay.digest !== operation.operationDigest) {
            throw new Error("Task mutation operation id has a conflicting payload");
          }
          return {
            kind: "return",
            value: { taskRevision: replay.taskRevision, replayed: true },
          };
        }
      }
      const current = state.definition;
      if (
        operation?.expectedRevision !== undefined &&
        current?.taskRevision !== operation.expectedRevision
      ) {
        throw new Error("Schedule task revision conflict");
      }
      if (current && canonicalize(current) === canonicalize(candidate)) {
        return {
          kind: "return",
          value: { taskRevision: current.taskRevision, replayed: true },
        };
      }
      if (current && !taskCreationProvenanceMatches(current, candidate)) {
        throw new Error("Task creation provenance is immutable");
      }
      const entries: LogicalRecord<JobJournalRecord | GovernorRecord>[] = [
        jobRecord(
          this.#taskId,
          taskRevisionRecord(candidate, prepared.stored, operation),
        ),
      ];
      if (policy) {
        entries.push(jobRecord(this.#taskId, {
          t: "legacy-next-fire",
          taskRevision: candidate.taskRevision,
          nextFire: policy.nextFire,
          scheduleDigest: policy.scheduleDigest,
          legacyDigest: policy.legacyDigest,
        }));
      }
      if (taskRevisionStopsQueued(candidate) && state.activeJobRunId) {
        const active = state.states.get(state.activeJobRunId);
        const assignmentId = state.assignmentByJob.get(state.activeJobRunId);
        if (active?.state === "queued") {
          const resourceRecords = prepareJobQueuedTerminal(
            candidate.definition.kind === "system"
              ? this.#systemResources
              : this.#resources,
            state,
            state.activeJobRunId,
            "cancelled",
          );
          entries.push(
            ...resourceRecords,
            stateRecord(
              this.#taskId,
              state.activeJobRunId,
              "cancelled",
              active.statusRevision + 1,
            ),
          );
        } else if (
          taskRevisionStopsAssigned(candidate) &&
          assignmentId &&
          (active?.state === "dispatched" || active?.state === "running")
        ) {
          entries.push(
            jobRecord(this.#taskId, {
              t: "cancel-fence",
              assignmentId,
              fenceSeq: prefix.nextLsn,
              requestId: `task-revision:${candidate.taskRevision}`,
            }),
            ...dataPlaneTicketRevocations(this.#taskId, state, assignmentId),
            stateRecord(
              this.#taskId,
              state.activeJobRunId,
              "cancel-requested",
              active.statusRevision + 1,
              assignmentId,
            ),
          );
        } else if (
          taskRevisionStopsAssigned(candidate) &&
          assignmentId &&
          active?.state === "uncertain" &&
          !state.cancelFences.has(assignmentId)
        ) {
          // 删除时对无停止栅栏的 uncertain 占用建立唯一取消栅栏：状态保持
          // uncertain、open fact 保留，后续 bundle/proof 仍按账本顺序裁决；
          // 已有栅栏（冲突或既有取消）则幂等复用、零追加。
          entries.push(
            jobRecord(this.#taskId, {
              t: "cancel-fence",
              assignmentId,
              fenceSeq: prefix.nextLsn,
              requestId: `task-revision:${candidate.taskRevision}`,
            }),
            ...dataPlaneTicketRevocations(this.#taskId, state, assignmentId),
          );
        }
      }
      const activeJobRunId = state.activeJobRunId;
      const active = activeJobRunId
        ? state.states.get(activeJobRunId)
        : undefined;
      const atomicFacts = taskRevisionAtomicFacts({
        records: entries
          .filter(
            (entry): entry is LogicalRecord<JobJournalRecord> =>
              entry.stream === jobStream(this.#taskId),
          )
          .map((entry) => entry.body),
        taskRevision: candidate.taskRevision,
        activeJobRunId,
        active,
        assignmentId: activeJobRunId
          ? state.assignmentByJob.get(activeJobRunId)
          : undefined,
        cancelFences: state.cancelFences,
        envelopeLsn: prefix.nextLsn,
      });
      const violation = taskRevisionReplayViolation({
        taskIdMatches: candidate.taskId === this.#taskId,
        taskRevision: candidate.taskRevision,
        state: candidate.state,
        kind: candidate.definition.kind,
        previousRevision: current?.taskRevision,
        previousState: current?.state,
        previousKind: current?.definition.kind,
        activeState: active?.state,
        ...atomicFacts,
      });
      if (violation !== undefined) throwTaskDefinitionViolation(violation);
      return {
        kind: "append",
        entries,
        value: { taskRevision: candidate.taskRevision, replayed: false },
      };
    }, prepared.references);
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
    const transaction = await this.#transact<JobOccurrence>((state) => {
      const definition = requireDefinition(state);
      if (definition.definition.kind !== input.source) {
        throw new Error("Trigger source does not match the task definition kind");
      }
      this.#ingress.authorize(
        input.context,
        input.source === "user" ? "user-trigger" : "system-trigger",
        definition,
      );
      const existing = state.occurrences.get(input.jobRunId);
      if (existing) {
        if (existing.scheduledFor !== input.scheduledFor) {
          throw new Error("Job occurrence id has a conflicting schedule time");
        }
        return { kind: "return", value: snapshot(existing) };
      }
      const alias = state.systemMissAliases.get(input.jobRunId);
      if (alias) {
        if (alias.scheduledFor !== input.scheduledFor) {
          throw new Error("Job occurrence alias has a conflicting schedule time");
        }
        const coalesced = state.occurrences.get(alias.coalescedJobRunId);
        if (!coalesced) {
          throw corruptJobJournal("System missed-occurrence alias is dangling");
        }
        return { kind: "return", value: snapshot(coalesced) };
      }
      if (definition.state !== "enabled") {
        throw new Error("Disabled or deleted tasks cannot create occurrences");
      }
      if (
        state.pendingAutoDisable.values().length > 0
      ) {
        throw new Error("Task is pending automatic disablement");
      }
      let occurrenceState: JobRunState =
        input.disposition === "missed-offline" && input.source === "user"
          ? "missed"
          : "queued";
      let effectiveActiveState: JobRunState | undefined;
      const entries: LogicalRecord<unknown>[] = [];
      if (state.activeJobRunId && occurrenceState !== "missed") {
        const active = state.states.get(state.activeJobRunId);
        effectiveActiveState = active?.state;
        if (active?.state === "uncertain") {
          occurrenceState = "missed";
        } else if (active?.state === "queued") {
          if (definition.definition.kind === "system") {
            occurrenceState = "missed";
          } else {
            entries.push(
              ...prepareJobQueuedTerminal(
                this.#resources,
                state,
                state.activeJobRunId,
                "expired",
              ),
              stateRecord(
                this.#taskId,
                state.activeJobRunId,
                "expired",
                active.statusRevision + 1,
              ),
            );
            effectiveActiveState = undefined;
          }
        } else if (active && !isTerminal(active.state)) {
          occurrenceState = "missed";
        }
      }
      if (
        occurrenceState === "missed" &&
        definition.definition.kind === "system" &&
        state.pendingSystemMissedJobRunId
      ) {
        const coalesced = state.occurrences.get(state.pendingSystemMissedJobRunId);
        if (!coalesced) {
          throw corruptJobJournal("System missed-occurrence index is dangling");
        }
        const active = state.activeJobRunId
          ? state.states.get(state.activeJobRunId)
          : undefined;
        assertSystemMissCoalescedReplayContract({
          definitionKind: definition.definition.kind,
          requestedIdentifierUnused:
            !state.occurrences.has(input.jobRunId) &&
            !state.systemMissAliases.has(input.jobRunId),
          pendingMatchesCoalesced:
            state.pendingSystemMissedJobRunId === coalesced.jobRunId,
          coalescedState: coalesced.state,
          activeState: active?.state,
        });
        return {
          kind: "append",
          entries: [
            jobRecord(this.#taskId, {
              t: "system-miss-coalesced",
              requestedJobRunId: input.jobRunId,
              scheduledFor: input.scheduledFor,
              coalescedJobRunId: coalesced.jobRunId,
            }),
          ],
          value: snapshot(coalesced),
        };
      }
      const occurrence: JobOccurrence = validateJobOccurrence({
        taskId: this.#taskId,
        jobRunId: input.jobRunId,
        scheduledFor: input.scheduledFor,
        taskRevision: definition.taskRevision,
        deliveryPlan: deliveryPlan(definition.definition),
        state: occurrenceState,
      });
      assertJobOccurrenceReplayContract({
        taskIdMatches: occurrence.taskId === this.#taskId,
        definitionPresent: true,
        definitionState: definition.state,
        definitionRevisionMatches:
          occurrence.taskRevision === definition.taskRevision,
        definitionKind: definition.definition.kind,
        identifierUnused:
          !state.occurrences.has(occurrence.jobRunId) &&
          !state.systemMissAliases.has(occurrence.jobRunId),
        occurrenceState: occurrence.state,
        activeState: effectiveActiveState,
        hasAtomicAdmission: occurrence.state === "queued",
        hasAtomicOfflineMissPolicy:
          occurrence.state === "missed" &&
          input.source === "user" &&
          input.missedNextFire !== undefined,
      });
      entries.push(jobRecord(this.#taskId, { t: "occurrence", occ: occurrence }));
      if (occurrenceState === "missed" && input.source === "user") {
        if (!input.missedNextFire) {
          throw new TypeError("Missed user occurrence requires a frozen next-fire policy");
        }
        entries.push(jobRecord(this.#taskId, {
          t: "missed-next-fire",
          jobRunId: input.jobRunId,
          readyBoundary: input.missedNextFire.readyBoundary,
          ...(input.missedNextFire.nextFire
            ? { nextFire: input.missedNextFire.nextFire }
            : {}),
        }));
      }
      if (occurrenceState === "queued") {
        const admission: Extract<JobJournalRecord, { t: "admitted" }> = {
          t: "admitted",
          taskId: this.#taskId,
          jobRunId: input.jobRunId,
          scheduledFor: input.scheduledFor,
        };
        assertJobAdmissionReplayContract({
          taskIdMatches: admission.taskId === this.#taskId,
          occurrencePresent: true,
          scheduleMatches: admission.scheduledFor === occurrence.scheduledFor,
          occurrenceState: occurrence.state,
          definitionKind: definition.definition.kind,
          admissionAlreadyExists: false,
          ingressPresent: false,
          hasAtomicManualControlResult: false,
        });
        entries.push(
          jobRecord(this.#taskId, admission),
        );
      }
      return { kind: "append", entries, value: occurrence };
    });
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
      throw new TypeError("Assignment plan manifest does not bind the job occurrence");
    }
    const existingState = await this.#select((state) => {
      const currentAssignmentId = state.assignmentByJob.get(plan.jobRunId);
      const currentAssignment = currentAssignmentId
        ? state.assignedById.get(currentAssignmentId)
        : undefined;
      return {
        currentAssignment: currentAssignment ? snapshot(currentAssignment) : undefined,
        assignmentIdInUse: state.assignedById.has(plan.assignmentId),
      };
    });
    if (existingState.currentAssignment) {
      throw new Error("Job occurrence is already assigned; replay its durable assignment");
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
      throw new TypeError("Materialized assignment does not match its preflight plan");
    }
    const envelope = createSignedJobEnvelope(unsigned, this.#signer, this.#verifier);
    const references = [
      ...(await resolveDispatchArtifactClosure(envelope, this.#artifacts)).transfer,
    ];
    const artifact = dispatchEnvelopeArtifact(envelope);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Dispatch artifact store returned a different reference");
    }
    const transaction = await this.#transact<string>(
      (state) => {
        const occurrence = state.occurrences.get(envelope.work.jobRunId);
        const current = state.states.get(envelope.work.jobRunId);
        const currentAssignmentId = state.assignmentByJob.get(envelope.work.jobRunId);
        const currentAssignment = currentAssignmentId
          ? state.assignedById.get(currentAssignmentId)
          : undefined;
        if (currentAssignment) {
          if (
            currentAssignment.record.assignmentId !== envelope.assignmentId ||
            canonicalize(withoutSignature(currentAssignment.envelope)) !==
              canonicalize(withoutSignature(envelope))
          ) {
            throw new Error("Job occurrence already has a different assignment");
          }
          return { kind: "return", value: currentAssignment.record.assignmentId };
        }
        if (state.assignedById.has(envelope.assignmentId)) {
          throw new Error("Assignment id already belongs to another occurrence");
        }
        if (!occurrence || current?.state !== "queued") {
          throw new Error("Only a durable queued occurrence can be assigned");
        }
        if (requireDefinition(state).state !== "enabled") {
          throw new Error("Disabled or deleted tasks cannot activate queued work");
        }
        const definition = requireDefinitionRevision(state, occurrence.taskRevision);
        if (definition.definition.kind !== "user") {
          throw new Error("System jobs cannot enter the assignment protocol");
        }
        assertDispatchMatchesOccurrence(
          envelope,
          occurrence,
          definition,
          this.#anchorEpoch,
        );
        const assigned: Extract<JobJournalRecord, { t: "assigned" }> = {
          t: "assigned",
          taskId: this.#taskId,
          jobRunId: occurrence.jobRunId,
          assignmentId: envelope.assignmentId,
          executorId: envelope.executorId,
          anchorEpoch: this.#anchorEpoch,
          taskRevision: occurrence.taskRevision,
          deliveryPlanDigest: occurrence.deliveryPlan.planDigest,
          dispatchDigest: dispatchEnvelopeDigest(envelope),
          manifestDigest: envelope.manifest.digest,
          dispatchRef: artifact.ref,
          permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
          capIds: envelope.capabilities.map((capability) => capability.capId),
          reservation: {
            reservationId: envelope.resourceLease.reservationId,
            attempt: envelope.resourceLease.workload.attempt,
          },
        };
        const resourceRecords = requiresFormalResourceCoordination(envelope.resourceLease)
          ? this.#resources?.prepareActivation(envelope.resourceLease)
          : [];
        if (requiresFormalResourceCoordination(envelope.resourceLease) && !this.#resources) {
          throw new Error("Job assignment resource coordination is not configured");
        }
        return {
          kind: "append",
          entries: [
            ...(resourceRecords ?? []),
            jobRecord(this.#taskId, assigned),
            stateRecord(
              this.#taskId,
              occurrence.jobRunId,
              "dispatched",
              current.statusRevision + 1,
              envelope.assignmentId,
            ),
          ],
          value: envelope.assignmentId,
        };
      },
      [artifact.ref, ...references],
    );
    const assigned = transaction.state.assignedById.get(transaction.value);
    if (!assigned) throw corruptJobJournal("Assigned job did not replay its outbox fact");
    return materializeDispatch(assigned, this.#signer);
  }

  async replayAssignment(unsigned: UnsignedJobEnvelope): Promise<PendingJobDispatch> {
    if (unsigned.work.taskId !== this.#taskId) {
      throw new TypeError("Dispatch belongs to a different task journal");
    }
    const current = await this.#select((state) => {
      const assignmentId = state.assignmentByJob.get(unsigned.work.jobRunId);
      const assigned = assignmentId === undefined
        ? undefined
        : state.assignedById.get(assignmentId);
      return assigned === undefined ? undefined : snapshot(assigned);
    });
    if (
      current === undefined ||
      current.record.assignmentId !== unsigned.assignmentId ||
      canonicalize(withoutSignature(current.envelope)) !== canonicalize(unsigned)
    ) {
      throw new Error("Durable job assignment does not match the replay request");
    }
    const dispatch = materializeDispatch(current, this.#signer);
    return dispatch;
  }

  async pendingDispatches(): Promise<PendingJobDispatch[]> {
    const assignments = await this.#select((state) =>
      byAssignmentCommit(state, state.openAssignments.values())
        .map((assignmentId) => state.assignedById.get(assignmentId)!)
        .filter((assigned) => {
          const current = state.states.get(assigned.record.jobRunId);
          return (
            current?.state === "dispatched" &&
            state.assignmentByJob.get(assigned.record.jobRunId) ===
              assigned.record.assignmentId &&
            !assigned.acked &&
            !state.superseded.has(assigned.record.assignmentId)
          );
        })
        .map((assigned) => snapshot(assigned)),
    );
    return assignments.map((assigned) => materializeDispatch(assigned, this.#signer));
  }

  async dispatchesAwaitingStarted(): Promise<PendingJobDispatch[]> {
    const assignments = await this.#select((state) =>
      byAssignmentCommit(state, state.openAssignments.values())
        .map((assignmentId) => state.assignedById.get(assignmentId)!)
        .filter((assigned) => {
          const assignmentId = assigned.record.assignmentId;
          return (
            state.assignmentByJob.get(assigned.record.jobRunId) === assignmentId &&
            state.states.get(assigned.record.jobRunId)?.state === "dispatched" &&
            !state.superseded.has(assignmentId)
          );
        })
        .map((assigned) => snapshot(assigned)),
    );
    return assignments.map((assigned) => materializeDispatch(assigned, this.#signer));
  }

  async assignmentsAwaitingRecovery(): Promise<
    Array<{
      readonly assignmentId: string;
      readonly state:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain"
        | "committed";
      readonly stoppedProofKinds: readonly NotStartedProofKind[];
      readonly dispatch: PendingJobDispatch;
    }>
  > {
    type RecoveryCandidate = {
      readonly assignmentId: string;
      readonly state:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain"
        | "committed";
      readonly stoppedProofKinds: readonly NotStartedProofKind[];
      readonly assigned: AssignedJob;
    };
    const assignments = await this.#select((state): RecoveryCandidate[] =>
      byAssignmentCommit(state, [...new Set([
        ...state.recoveryAssignments.values(),
        ...state.bundleAcknowledgementOutbox.values(),
      ])])
        .flatMap<RecoveryCandidate>((assignmentId) => {
          const assigned = state.assignedById.get(assignmentId);
          if (!assigned) {
            throw corruptJobJournal("Recovery outbox names an unknown assignment");
          }
          const current = state.states.get(assigned.record.jobRunId)?.state;
          const committed = state.committed.get(assignmentId);
          if (state.bundleAcknowledgementOutbox.has(assignmentId)) {
            if (
              current !== "committed" ||
              committed?.jobRunId !== assigned.record.jobRunId ||
              state.bundleAcknowledgements.has(assignmentId)
            ) {
              throw corruptJobJournal(
                "Bundle acknowledgement outbox does not bind one pending committed assignment",
              );
            }
            return [{
              assignmentId,
              state: current,
              stoppedProofKinds: [],
              assigned: snapshot(assigned),
            }];
          }
          const isCurrent =
            state.assignmentByJob.get(assigned.record.jobRunId) === assignmentId;
          if (
            !isCurrent ||
            state.superseded.has(assignmentId) ||
            (current !== "dispatched" &&
              current !== "running" &&
              current !== "cancel-requested" &&
              current !== "uncertain")
          ) {
            return [];
          }
          const open = state.resolutions.get(assigned.record.jobRunId);
          if (open && state.containedFacts.has(open.openFactDigest)) return [];
          const stoppedProofKinds = NOT_STARTED_PROOF_KINDS.filter((kind) =>
            state.rejectedNotStarted.has(notStartedRejectionKey(assignmentId, kind)),
          );
          return [
            { assignmentId, state: current, stoppedProofKinds, assigned: snapshot(assigned) },
          ];
        }),
    );
    return assignments.map(({ assigned, ...candidate }) => ({
      ...candidate,
      dispatch: materializeDispatch(assigned, this.#signer),
    }));
  }

  async observeBundleAcknowledgement(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const ledger = await verifyProtocolStep(() => validateLedgerSnapshot(rawSnapshot, this.#verifier));
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
    const preflight = await this.#select((state) => {
      const committed = state.committed.get(assignmentId);
      if (!committed) {
        throw new Error("Bundle acknowledgement names an uncommitted job assignment");
      }
      return {
        expected: bundleAcknowledgementRecord(assignmentId, committed),
        existing: state.bundleAcknowledgements.get(assignmentId),
      };
    });
    assertLedgerAcknowledgesCommittedBundle(ledger, preflight.expected);
    if (preflight.existing) {
      if (canonicalize(preflight.existing) !== canonicalize(preflight.expected)) {
        throw corruptJobJournal("Bundle acknowledgement observation is inconsistent");
      }
      return;
    }
    await this.#transact<void>((state) => {
      const committed = state.committed.get(assignmentId);
      const existing = state.bundleAcknowledgements.get(assignmentId);
      if (!committed) {
        throw new Error("Bundle acknowledgement names an uncommitted job assignment");
      }
      const expected = bundleAcknowledgementRecord(assignmentId, committed);
      if (canonicalize(expected) !== canonicalize(preflight.expected)) {
        throw corruptJobJournal("Committed bundle acknowledgement binding changed");
      }
      assertLedgerAcknowledgesCommittedBundle(ledger, expected);
      if (existing) {
        if (canonicalize(existing) !== canonicalize(expected)) {
          throw corruptJobJournal("Bundle acknowledgement observation is inconsistent");
        }
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [jobRecord(this.#taskId, expected)],
        value: undefined,
      };
    }, [preflight.expected.bundleRef]);
  }

  async validateExecutorLedgerSnapshot(input: unknown): Promise<LedgerSnapshot> {
    return verifyProtocolStep(() => validateLedgerSnapshot(input, this.#verifier));
  }

  async reconcileStarted(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const ledger = await verifyProtocolStep(() => validateLedgerSnapshot(rawSnapshot, this.#verifier));
    if (
      ledger.assignmentId !== assignmentId ||
      (ledger.phase !== "started" &&
        ledger.phase !== "sealed" &&
        ledger.phase !== "acked")
    ) {
      throw new TypeError("Ledger snapshot does not prove a started job assignment");
    }
    await this.#transact<void>((state) => {
      const assigned = requireCurrentAssignment(state, assignmentId);
      const current = state.states.get(assigned.record.jobRunId);
      if (current?.state === "running" || current?.state === "committed") {
        return { kind: "return", value: undefined };
      }
      if (current?.state !== "dispatched") {
        throw new Error("Started ledger snapshot is late for the current job state");
      }
      return {
        kind: "append",
        entries: [
          ...(!assigned.acked
            ? [jobRecord(this.#taskId, { t: "dispatch-acked", assignmentId })]
            : []),
          stateRecord(
            this.#taskId,
            assigned.record.jobRunId,
            "running",
            current.statusRevision + 1,
            assignmentId,
          ),
        ],
        value: undefined,
      };
    });
  }

  async reconcileCancellationEvidence(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
    pages: AsyncIterable<LedgerEvidencePage>,
  ): Promise<boolean> {
    const ledger = await verifyProtocolStep(() => validateLedgerSnapshot(rawSnapshot, this.#verifier));
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
      throw new TypeError("Ledger snapshot is not an unresolved job cancellation prefix");
    }
    const assigned = await this.#select((state) => {
      const candidate = state.assignedById.get(assignmentId);
      if (
        !candidate ||
        state.assignmentByJob.get(candidate.record.jobRunId) !== assignmentId
      ) {
        return undefined;
      }
      return snapshot(candidate);
    });
    if (!assigned) throw new Error("Ledger evidence names a historical job assignment");
    let expectedSeq = 1;
    const validation = createAssignmentLedgerValidationState(assignmentId);
    for await (const rawPage of pages) {
      const page = await verifyProtocolStep(() => validateLedgerEvidencePage(rawPage, this.#verifier));
      if (
        page.assignmentId !== assignmentId ||
        page.executorId !== assigned.record.executorId ||
        page.fromSeq !== expectedSeq ||
        page.toSeq > ledger.lastSeq
      ) {
        throw new TypeError("Ledger evidence page does not bind the job assignment prefix");
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
          body = (await verifyProtocolStep(() => validateAssignmentEntry(
            { recordSeq: rawEntry.recordSeq, body: parsed },
            this.#verifier,
          ))).body;
        } else {
          body = (await verifyProtocolStep(() => validateAssignmentEntry(rawEntry, this.#verifier))).body;
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
          const activation = await verifyProtocolStep(() => validateJobActivation({
            envelope: assigned.envelope,
            activation: body.activation as AssignmentActivationProof<"job">,
            dispatchRef: assigned.record.dispatchRef,
            verifier: this.#verifier,
          }));
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
            throw new TypeError("Received evidence does not bind the durable job assignment");
          }
        }
        const entry: AssignmentEntry = { recordSeq: rawEntry.recordSeq, body };
        applyValidatedAssignmentEntry(validation, entry);
        expectedSeq += 1;
      }
      if (page.chainDigest !== validation.chainDigest) {
        throw new TypeError("Ledger evidence page chain digest is invalid");
      }
    }
    if (
      expectedSeq !== ledger.lastSeq + 1 ||
      validation.lastSeq !== ledger.lastSeq ||
      validation.phase !== ledger.phase
    ) {
      throw new TypeError("Ledger evidence does not close the job snapshot prefix");
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
      validation.streamProjectionEnabledAfter !== undefined &&
      targetUpTo > validation.streamProjectionEnabledAfter
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
            targetInteractionRecordSeq: targetUpTo,
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
    await this.#transact<void>((state) => {
      const assignedState = requireCurrentAssignment(state, assignmentId);
      const current = state.states.get(assignedState.record.jobRunId);
      if (!current) throw corruptJobJournal("Assigned job has no state");
      const existingFence =
        state.interactionSettlementFences.get(assignmentId);
      if (existingFence) {
        if (!sameJobInteractionSettlement(existingFence, settlement)) {
          throw new Error(
            "Job cancellation evidence conflicts with its durable interaction settlement",
          );
        }
        return { kind: "return", value: undefined };
      }
      const existingResolution = state.resolutions.get(
        assignedState.record.jobRunId,
      );
      if (
        isOpenResolutionFact(existingResolution) &&
        existingResolution.cause !== "job-cancel-unknown"
      ) {
        throw new Error("Job occurrence already has a different uncertain fact");
      }
      if (
        current.state !== "dispatched" &&
        current.state !== "running" &&
        current.state !== "cancel-requested" &&
        !(
          current.state === "uncertain" &&
          isOpenResolutionFact(existingResolution) &&
          existingResolution.cause === "job-cancel-unknown"
        )
      ) {
        throw new Error(
          "Only an active or matching uncertain assignment can open interaction settlement",
        );
      }
      const entries: LogicalRecord<JobJournalRecord>[] = [];
      if (current.state !== "uncertain") {
        const fact = openResolution(
          this.#taskId,
          assignedState.record.jobRunId,
          this.#anchorEpoch,
          assignmentId,
          "job-cancel-unknown",
          this.#clock(),
        );
        entries.push(
          jobRecord(this.#taskId, {
            t: "resolution",
            jobRunId: assignedState.record.jobRunId,
            fact,
          }),
          stateRecord(
            this.#taskId,
            assignedState.record.jobRunId,
            "uncertain",
            current.statusRevision + 1,
            assignmentId,
          ),
        );
      }
      entries.push(jobRecord(this.#taskId, settlement));
      return { kind: "append", entries, value: undefined };
    });
    return true;
  }

  async acknowledgeDispatch(assignmentId: string): Promise<void> {
    assertIdentifier(assignmentId, "Assignment id");
    await this.#transact<void>((state) => {
      const assigned = requireCurrentAssignment(state, assignmentId);
      if (assigned.acked) return { kind: "return", value: undefined };
      return {
        kind: "append",
        entries: [jobRecord(this.#taskId, { t: "dispatch-acked", assignmentId })],
        value: undefined,
      };
    });
  }

  async issueDataPlaneTicket(
    input: DataPlaneTicketIssueRequest,
  ): Promise<DataPlaneTicket> {
    validateJobTicketIssueRequest(input);
    const transaction = await this.#transact<DataPlaneTicket>(
      (state, authorityPrefix) => {
        const existing = state.ticketsById.get(input.ticketId);
        if (existing) {
          if (
            !dataPlaneTicketIssueMatches(
              existing,
              state.ticketReplacementsById.get(input.ticketId),
              input,
            )
          ) {
            throw new Error("Ticket id already belongs to a different grant");
          }
          return { kind: "return", value: snapshot(existing) };
        }
        const assigned = state.assignedById.get(input.assignmentId);
        const runState = assigned
          ? state.states.get(assigned.record.jobRunId)?.state
          : undefined;
        if (
          !assigned ||
          !assigned.acked ||
          state.assignmentByJob.get(assigned.record.jobRunId) !== input.assignmentId ||
          (runState !== "dispatched" && runState !== "running") ||
          state.cancelFences.has(input.assignmentId)
        ) {
          throw new Error("Ticket requires a current acknowledged assignment");
        }
        const ingress = state.ingressByJob.get(assigned.record.jobRunId);
        if (!ingress) {
          throw new Error("Scheduled jobs cannot receive data-plane tickets");
        }
        if (
          input.kind !== "run-observe" &&
          input.surfacePrincipal !== ingress.surfacePrincipal
        ) {
          throw new Error("Interactive tickets are restricted to the original surface");
        }
        const replaced = input.replacesTicketId
          ? state.ticketsById.get(input.replacesTicketId)
          : undefined;
        if (input.kind === "abort" && input.replacesTicketId !== undefined) {
          throw new Error("Abort tickets are not renewable");
        }
        if (
          input.replacesTicketId !== undefined &&
          (!replaced ||
            state.revokedTickets.has(input.replacesTicketId) ||
            !replaced.renewable ||
            replaced.assignmentId !== input.assignmentId ||
            replaced.surfacePrincipal !== input.surfacePrincipal ||
            replaced.kind !== input.kind)
        ) {
          throw new Error("Ticket renewal does not continue an active renewable grant");
        }
        const issuedAt = authorityPrefix.at;
        const ticket = createSignedDataPlaneTicket(
          {
            v: 1,
            ticketId: input.ticketId,
            ref: {
              execution: "job",
              jobRunId: assigned.record.jobRunId,
              taskId: this.#taskId,
              anchorEpoch: assigned.record.anchorEpoch,
            },
            assignmentId: input.assignmentId,
            surfacePrincipal: input.surfacePrincipal,
            executorId: assigned.record.executorId,
            issuedAt,
            expiry: new Date(Date.parse(issuedAt) + input.ttlMs).toISOString(),
            kind: input.kind,
            renewable: input.kind !== "abort",
          } as Parameters<typeof createSignedDataPlaneTicket>[0],
          this.#signer,
        );
        return {
          kind: "append",
          entries: [
            jobRecord(this.#taskId, {
              t: "ticket-issued",
              ticket,
              ...(input.replacesTicketId === undefined
                ? {}
                : { replacesTicketId: input.replacesTicketId }),
            }),
            ...(input.replacesTicketId === undefined
              ? []
              : [
                  jobRecord(this.#taskId, {
                    t: "ticket-revoked" as const,
                    ticketId: input.replacesTicketId,
                  }),
                ]),
          ],
          value: ticket,
        };
      },
    );
    return transaction.value;
  }

  async revokeDataPlaneTicket(ticketId: string): Promise<boolean> {
    assertIdentifier(ticketId, "Revoked ticket id");
    const transaction = await this.#transact<boolean>((state) => {
      if (!state.ticketsById.has(ticketId)) {
        throw new Error("Cannot revoke an unknown data-plane ticket");
      }
      if (state.revokedTickets.has(ticketId)) {
        return { kind: "return", value: false };
      }
      return {
        kind: "append",
        entries: [jobRecord(this.#taskId, { t: "ticket-revoked", ticketId })],
        value: true,
      };
    });
    return transaction.value;
  }

  async dataPlaneTicketFacts(): Promise<DataPlaneTicketFacts> {
    const transaction = await this.#transact<DataPlaneTicketFacts>(
      (state, authorityPrefix) => {
        // 只读同步边界在前沿之后的票据：已过前沿的不再同步，读量不随历史票据增长
        const nextFrontier = nextDataPlaneTicketSyncFrontier(
          ticketsBetween(state, state.ticketSyncFrontier, authorityPrefix.at).map((row) => row.ticket),
          state.ticketSyncFrontier,
          authorityPrefix.at,
        );
        const frontier = nextFrontier ?? state.ticketSyncFrontier;
        const issued = ticketsBetween(state, frontier, undefined)
          .map((row) => row.ticket)
          .filter((ticket) => !ticketPrecedesSyncFrontier(ticket, frontier))
          .sort((left, right) => left.ticketId.localeCompare(right.ticketId))
          .map((ticket) => snapshot(ticket));
        const value = {
          issued,
          revokedTicketIds: issued
            .map((ticket) => ticket.ticketId)
            .filter((ticketId) => state.revokedTickets.has(ticketId))
            .sort(),
        };
        return nextFrontier === undefined
          ? { kind: "return", value }
          : {
              kind: "append",
              entries: [
                jobRecord(this.#taskId, {
                  t: "ticket-sync-frontier",
                  expiresThrough: nextFrontier,
                }),
              ],
              value,
            };
      },
    );
    return transaction.value;
  }

  /** Runs the submission guard before a remote adapter dereferences request assets. */
  async preflightSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<AssignmentSubmissionPreflightResult> {
    this.#authenticateSubmission(context, identity);
    const guard = await this.#loadSubmissionGuard(context, identity);
    if (identity.method !== "submission.submitBundle") {
      return { kind: "continue" };
    }
    const assigned = guard.assignedById.get(identity.assignmentId);
    if (!assigned) {
      throw new Error("Bundle capability is not activated by a durable job assignment");
    }
    if (!guard.occurrences.has(assigned.record.jobRunId)) {
      throw new Error("Bundle assignment has no durable occurrence");
    }
    if (guard.committedByAssignment.has(identity.assignmentId)) {
      return { kind: "continue" };
    }
    const rejectionMessage = this.#submissionBundleRejection(
      guard,
      context,
      identity.assignmentId,
      assigned.record.jobRunId,
    );
    if (!rejectionMessage) return { kind: "continue" };
    await verifyProtocolStep(() => this.#authorizeGuardSubmission(guard, context, {
      mode: "durable-rejection",
      method: "submission.submitBundle",
      assignmentId: identity.assignmentId,
    }));
    return {
      kind: "return",
      result: rejected("fence-rejected", rejectionMessage, false),
    };
  }

  async reportStarted(
    assignmentId: string,
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#authenticateSubmission(context, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#loadSubmissionGuard(context, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Started report names an unknown assignment");
      const current = state.states.get(assigned.record.jobRunId);
      if (
        state.durableStarted.has(assignmentId) ||
        state.committed.has(assignmentId)
      ) {
        this.#authorizeSubmission(state, context, {
          mode: "durable-replay",
          method: "submission.reportStarted",
          assignmentId,
        });
        return { kind: "return", value: undefined };
      }
      if (state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId) {
        throw new Error("Started report names a historical assignment");
      }
      if (current?.state !== "dispatched") {
        throw new Error("Started report is invalid for the current job state");
      }
      this.#authorizeSubmission(state, context, {
        mode: "active",
        method: "submission.reportStarted",
        assignmentId,
      });
      return {
        kind: "append",
        entries: [
          stateRecord(
            this.#taskId,
            assigned.record.jobRunId,
            "running",
            current.statusRevision + 1,
            assignmentId,
          ),
        ],
        value: undefined,
      };
    });
  }

  async mirrorInteractions(
    assignmentId: string,
    rawBatch: InteractionMirrorBatch,
    context: AuthorityCallContext,
  ): Promise<{ readonly mirroredUpTo: number; readonly ordinal: number; readonly mirrorDigest: string }> {
    this.#authenticateSubmission(context, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    await this.#loadSubmissionGuard(context, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    if (
      Buffer.byteLength(
        canonicalize({ t: "interaction-mirror", assignmentId, batch: rawBatch }),
        "utf8",
      ) > MAX_INLINE_LOGICAL_RECORD_BYTES
    ) {
      throw new TypeError("Interaction mirror batch exceeds the durable record limit");
    }
    const batch = await verifyProtocolStep(() => validateAssignmentInteractionMirrorBatch(
      rawBatch,
      this.#verifier,
    ));
    if (batch.assignmentId !== assignmentId) {
      throw new TypeError("Interaction mirror batch names a different assignment");
    }
    return (
      await this.#transact<{
        mirroredUpTo: number;
        ordinal: number;
        mirrorDigest: string;
      }>((state) => {
        const last = batch.entries.at(-1)!;
        const batchKey = `${assignmentId}:${interactionMirrorBatchDigest(batch)}`;
        if (state.interactionMirrorBatches.has(batchKey)) {
          this.#authorizeSubmission(state, context, {
            mode: "durable-replay",
            method: "submission.mirrorInteractions",
            assignmentId,
          });
          return {
            kind: "return",
            value: {
              mirroredUpTo: last.seq,
              ordinal: last.ordinal,
              mirrorDigest: batch.mirrorDigest,
            },
          };
        }
        const assigned = state.assignedById.get(assignmentId);
        const currentState = assigned
          ? state.states.get(assigned.record.jobRunId)?.state
          : undefined;
        const mirrored = state.interactionMirrors.get(assignmentId) ?? {
          upTo: 0,
          ordinal: 0,
          digest: interactionMirrorSeed(assignmentId),
          requestIds: new Set<string>(),
          outcomes: new Map(),
        };
        const first = batch.entries[0]!;
        const auditSettlement =
          state.completedInteractionSettlements.has(assignmentId)
            ? undefined
            : state.interactionSettlementFences.get(assignmentId);
        assertJobMirrorReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === assignmentId,
          executorMatches: assigned?.record.executorId === batch.executorId,
          batchBindsRecord: batch.assignmentId === assignmentId,
          currentState,
          hasDurableCancelFence: state.cancelFences.has(assignmentId),
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
          batchAlreadyMirrored: false,
          extendsCursor:
            batch.previousDigest === mirrored.digest &&
            first.ordinal === mirrored.ordinal + 1 &&
            first.seq > mirrored.upTo,
          repeatsRequestId: batchRepeatsRequestId(batch, mirrored.requestIds),
        });
        this.#authorizeSubmission(state, context, {
          mode:
            auditSettlement ||
            currentState === "uncertain" ||
            currentState === "cancel-requested"
              ? "settlement"
              : "active",
          method: "submission.mirrorInteractions",
          assignmentId,
        });
        return {
          kind: "append",
          entries: [
            jobRecord(this.#taskId, {
              t: "interaction-mirror",
              assignmentId,
              batch,
            }),
          ],
          value: {
            mirroredUpTo: last.seq,
            ordinal: last.ordinal,
            mirrorDigest: batch.mirrorDigest,
          },
        };
      })
    ).value;
  }

  async completeInteractionSettlement(
    assignmentId: string,
    rawProof: InteractionSettlementStreamProof | undefined,
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#authenticateSubmission(context, {
      method: "submission.completeInteractionSettlement",
      assignmentId,
    });
    await this.#loadSubmissionGuard(context, {
      method: "submission.completeInteractionSettlement",
      assignmentId,
    });
    const proof =
      rawProof === undefined
        ? undefined
        : await verifyProtocolStep(() => validateInteractionSettlementStreamProof(
            rawProof,
            this.#verifier,
          ));
    await this.#transact<void>((state) => {
      const completed =
        state.completedInteractionSettlements.get(assignmentId);
      if (completed) {
        if (
          ("v" in completed && completed.v === 2
            ? !proof ||
              canonicalize(completed.streamProof) !== canonicalize(proof)
            : proof !== undefined)
        ) {
          throw new Error(
            "Job interaction settlement replay has a conflicting stream proof",
          );
        }
        this.#authorizeSubmission(state, context, {
          mode: "durable-replay",
          method: "submission.completeInteractionSettlement",
          assignmentId,
        });
        return { kind: "return", value: undefined };
      }
      const fence = state.interactionSettlementFences.get(assignmentId);
      if (!fence) {
        throw new Error(
          "Job interaction settlement has no durable audit obligation",
        );
      }
      const mirrored = state.interactionMirrors.get(assignmentId);
      if (
        mirrored?.upTo !== fence.targetUpTo ||
        mirrored.ordinal !== fence.targetOrdinal ||
        mirrored.digest !== fence.targetMirrorDigest
      ) {
        throw new Error(
          "Job interaction settlement has not reached its durable mirror target",
        );
      }
      if ("v" in fence && fence.v === 2) {
        if (
          !proof ||
          proof.assignmentId !== assignmentId ||
          proof.executorId !== fence.executorId ||
          proof.ticketDigest !== fence.ticketDigest ||
          proof.sourceLastSeq !== fence.sourceLastSeq ||
          proof.sourceChainDigest !== fence.sourceChainDigest ||
          proof.targetInteractionRecordSeq !==
            fence.targetInteractionRecordSeq ||
          proof.upToRecordSeq < fence.targetInteractionRecordSeq
        ) {
          throw new Error(
            "Versioned interaction settlement lacks its executor stream proof",
          );
        }
      } else if (proof !== undefined) {
        throw new Error(
          "Legacy interaction settlement cannot consume a versioned stream proof",
        );
      }
      this.#authorizeSubmission(state, context, {
        mode: "settlement",
        method: "submission.completeInteractionSettlement",
        assignmentId,
      });
      return {
        kind: "append",
        entries: [
          jobRecord(this.#taskId, {
            ...fence,
            t: "interaction-settlement-completed",
            ...("v" in fence && fence.v === 2
              ? { streamProof: proof! }
              : {}),
          }),
        ],
        value: undefined,
      };
    });
  }

  async pendingInteractionSettlements(): Promise<
    readonly Extract<
      JobJournalRecord,
      { readonly t: "interaction-settlement-fence" }
    >[]
  > {
    return this.#select((state) =>
      state.pendingSettlements.values().sort()
        .map((assignmentId) => state.interactionSettlementFences.get(assignmentId)!)
        .filter(
          (fence) =>
            !state.completedInteractionSettlements.has(fence.assignmentId),
        )
        .map((fence) => snapshot(fence)),
    );
  }

  async failQueued(jobRunId: string): Promise<boolean> {
    return this.#closeQueued(jobRunId, "failed");
  }

  async failAssigned(
    jobRunId: string,
    assignmentId: string,
    usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): Promise<void> {
    assertIdentifier(jobRunId, "Failed job run id");
    assertIdentifier(assignmentId, "Failed job assignment id");
    await this.#transact<void>((state) => {
      const current = state.states.get(jobRunId);
      if (current?.state === "failed") return { kind: "return", value: undefined };
      const assigned = state.assignedById.get(assignmentId);
      if (
        !assigned ||
        assigned.record.jobRunId !== jobRunId ||
        state.assignmentByJob.get(jobRunId) !== assignmentId ||
        (current?.state !== "dispatched" && current?.state !== "running")
      ) {
        throw new Error("Only the current active job assignment may report failure");
      }
      return {
        kind: "append",
        entries: [
          ...capabilityRevocations(this.#taskId, state, assigned),
          stateRecord(
            this.#taskId,
            jobRunId,
            "failed",
            current.statusRevision + 1,
            assignmentId,
            usageFinal,
          ),
        ],
        value: undefined,
      };
    });
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
    const result = await this.#transact<JobCancelResult>((state, prefix) => {
        const definition = requireDefinition(state);
        this.#ingress.authorize(
          input.context,
          definition.definition.kind === "system" ? "system-cancel" : "user-cancel",
          definition,
        );
        const current = state.states.get(input.jobRunId);
        if (!current) throw new Error("Cannot cancel an unknown job occurrence");
        const assignmentId = state.assignmentByJob.get(input.jobRunId);
        if (current.state === "queued") {
          const resourceRecords = prepareJobQueuedTerminal(
            definition.definition.kind === "system"
              ? this.#systemResources
              : this.#resources,
            state,
            input.jobRunId,
            "cancelled",
          );
          return {
            kind: "append",
            entries: [
              ...resourceRecords,
              stateRecord(
                this.#taskId,
                input.jobRunId,
                "cancelled",
                current.statusRevision + 1,
              ),
            ],
            value: { state: "cancelled" },
          };
        }
        if (
          assignmentId &&
          (current.state === "dispatched" || current.state === "running")
        ) {
          const existing = state.cancelFences.get(assignmentId);
          if (existing) {
            if (existing.requestId !== input.requestId) {
              throw new Error("Assignment already has a different cancellation fence");
            }
            return {
              kind: "return",
              value: {
                state: "cancel-requested",
                assignmentId,
                fence: { fenceSeq: existing.fenceSeq, requestId: existing.requestId },
              },
            };
          }
          const fence = { fenceSeq: prefix.nextLsn, requestId: input.requestId };
          return {
            kind: "append",
            entries: [
              jobRecord(this.#taskId, {
                t: "cancel-fence",
                assignmentId,
                ...fence,
              }),
              ...dataPlaneTicketRevocations(this.#taskId, state, assignmentId),
              stateRecord(
                this.#taskId,
                input.jobRunId,
                "cancel-requested",
                current.statusRevision + 1,
                assignmentId,
              ),
            ],
            value: { state: "cancel-requested", assignmentId, fence },
          };
        }
        if (current.state === "cancel-requested") {
          if (!assignmentId) {
            throw corruptJobJournal("Cancel-requested job has no current assignment");
          }
          const existing = state.cancelFences.get(assignmentId);
          if (!existing) {
            throw corruptJobJournal("Cancel-requested job has no durable fence");
          }
          if (existing.requestId !== input.requestId) {
            throw new Error("Assignment already has a different cancellation fence");
          }
          return {
            kind: "return",
            value: {
              state: "cancel-requested",
              assignmentId,
              fence: { fenceSeq: existing.fenceSeq, requestId: existing.requestId },
            },
          };
        }
        if (current.state === "cancelled") {
          return { kind: "return", value: { state: "cancelled" } };
        }
        return { kind: "return", value: { state: current.state } };
      });
    return result.value;
  }

  async applyControl(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: JobControlEnvelope;
    readonly source: TrustedControlSource;
  }): Promise<ControlAdmissionOutcome> {
    // 控制目标的工作集取自同一锁内的持久投影：只归约本次候选，不重放作业流；
    // 锁外装入的行在重做之间保留
    const base = createJobMainState(this.#taskId);
    base.bindLoader((needs) => loadJobState(base, needs, this.#index));
    const binding = new JobStateBinding(base);
    const target = jobProjectionView(binding);
    const scope = jobScopeOf(input.envelope.body);
    const outcome = await this.#repeatState(async () => {
    await input.admission.prepareRecovery();
    const cursor = await this.#headCursor();
    return this.#delivery.coordinate(() => input.admission.applyAuthority<
      JobProjection,
      JobControlEnvelope
    >({
      envelope: input.envelope,
      source: input.source,
      stream: jobStream(this.#taskId),
      initial: target,
      onProjected: () => undefined,
      targetBase: {
        state: target,
        cursor,
        createState: () => target,
        readProjectionIds: [JOB_RUN_STATE_PROJECTION_ID],
        validateAtPrefix: async (context) => {
          await preloadJobScope({ main: base }, scope, context.readProjection(JOB_RUN_STATE_PROJECTION_ID));
        },
      },
      reducer: (state, record, commit) => this.#reduce(state, record, commit),
      companionStreams: ["delivery", "governor", ...(this.#schedulerNotices ? [SCHEDULER_NOTICE_STREAM] : [])],
      prepareCompanions: (state, context, plan) => {
        const statuses = jobStatusDeliveryInputs(
          this.#taskId,
          state,
          plan.authorityEntries ?? [],
          context.authorityPrefix.at,
        );
        const prepared = this.#delivery.prepareJobStatuses(statuses);
        if (!prepared.accepted) throw corruptJobJournal(prepared.error.message);
        return [
          ...this.#prepareCapabilityGapClosureRecords(
            state, plan.authorityEntries ?? [], context.authorityPrefix.at,
          ),
          ...prepared.records,
        ];
      },
      onCommitted: (state, commit) => {
        this.#publishStatusNotices(
          jobStatusNoticesForCommit(
            state,
            commit,
            this.#taskId,
            this.#anchorEpoch,
          ),
        );
        this.#publishLifecycleEvents(
          jobLifecycleEventsForCommit(
            state,
            commit,
            this.#taskId,
            this.#anchorEpoch,
          ),
        );
      },
      decide: (state, context) => runWithJobState(
        [[binding, base]], context.authorityPrefix.readProjection(JOB_RUN_STATE_PROJECTION_ID), () => {
        const body = context.envelope.body;
        const definition = state.definition;
        if (!definition) {
          return { result: rejectedControl("not-found", "Task definition is unknown") };
        }
        if (definition.definition.kind === "system") {
          return {
            result: rejectedControl(
              "unauthorized",
              "System tasks cannot be controlled from a surface",
            ),
          };
        }
        if (body.t === "job-run") {
          if (body.taskId !== this.#taskId || body.anchorEpoch !== this.#anchorEpoch) {
            return {
              result: rejectedControl(
                "epoch-stale",
                "Job run request does not bind the current task anchor",
              ),
            };
          }
          if (definition.state !== "enabled") {
            return { result: rejectedControl("fence-rejected", "Task is not enabled") };
          }
          if (
            state.pendingAutoDisable.values().length > 0
          ) {
            return {
              result: rejectedControl(
                "fence-rejected",
                "Task is pending automatic disablement",
              ),
            };
          }
          const replacementEntries: LogicalRecord<unknown>[] = [];
          if (state.activeJobRunId) {
            const active = state.states.get(state.activeJobRunId);
            if (!active) {
              throw corruptJobJournal("Active job occurrence has no state");
            }
            if (active.state === "queued") {
              replacementEntries.push(
                ...prepareJobQueuedTerminal(
                  this.#resources,
                  state,
                  state.activeJobRunId,
                  "expired",
                ),
                stateRecord(
                  this.#taskId,
                  state.activeJobRunId,
                  "expired",
                  active.statusRevision + 1,
                ),
              );
            } else {
              return {
                result: rejectedControl(
                  active.state === "uncertain" ? "busy" : "fence-rejected",
                  "Task already has an active occurrence",
                ),
              };
            }
          }
          const jobRunId = createManualJobRunId({
            taskId: this.#taskId,
            requestId: context.canonicalRequestId,
            scheduledFor: context.envelope.at,
          });
          const occurrence = validateJobOccurrence({
            taskId: this.#taskId,
            jobRunId,
            scheduledFor: context.envelope.at,
            taskRevision: definition.taskRevision,
            deliveryPlan: deliveryPlan(definition.definition),
            state: "queued",
          });
          const ingress = requireControlIngress(context);
          const admission: Extract<JobJournalRecord, { t: "admitted" }> = {
            t: "admitted",
            taskId: this.#taskId,
            jobRunId,
            scheduledFor: occurrence.scheduledFor,
            ingress,
          };
          assertJobAdmissionReplayContract({
            taskIdMatches: admission.taskId === this.#taskId,
            occurrencePresent: true,
            scheduleMatches: admission.scheduledFor === occurrence.scheduledFor,
            occurrenceState: occurrence.state,
            definitionKind: definition.definition.kind,
            admissionAlreadyExists: false,
            ingressPresent: true,
            hasAtomicManualControlResult: true,
          });
          return {
            result: {
              v: 1,
              status: "ok",
              body: { t: "job-run", jobRunId },
            },
            authorityEntries: [
              ...replacementEntries,
              jobRecord(this.#taskId, { t: "occurrence", occ: occurrence }),
              jobRecord(this.#taskId, admission),
            ],
          };
        }
        if (body.t === "job-cancel") {
          if (body.taskId !== this.#taskId || body.anchorEpoch !== this.#anchorEpoch) {
            return {
              result: rejectedControl(
                "epoch-stale",
                "Job cancellation does not bind the current task anchor",
              ),
            };
          }
          const current = state.states.get(body.jobRunId);
          if (!current) {
            return { result: rejectedControl("not-found", "Job occurrence is unknown") };
          }
          if (current.state === "queued") {
            return {
              result: {
                v: 1,
                status: "ok",
                body: { t: "job-cancel", runState: "cancelled" },
              },
              authorityEntries: [
                ...prepareJobQueuedTerminal(
                  this.#resources,
                  state,
                  body.jobRunId,
                  "cancelled",
                ),
                stateRecord(
                  this.#taskId,
                  body.jobRunId,
                  "cancelled",
                  current.statusRevision + 1,
                ),
              ],
            };
          }
          const assignmentId = state.assignmentByJob.get(body.jobRunId);
          if (
            !assignmentId ||
            (current.state !== "dispatched" && current.state !== "running")
          ) {
            return {
              result: rejectedControl(
                "fence-rejected",
                "Job occurrence is not cancellable",
              ),
            };
          }
          const fence = {
            fenceSeq: context.authorityPrefix.nextLsn,
            requestId: context.canonicalRequestId,
          };
          return {
            result: {
              v: 1,
              status: "ok",
              body: { t: "job-cancel", runState: "cancel-requested" },
            },
            authorityEntries: [
              jobRecord(this.#taskId, {
                t: "cancel-fence",
                assignmentId,
                ...fence,
              }),
              ...dataPlaneTicketRevocations(this.#taskId, state, assignmentId),
              stateRecord(
                this.#taskId,
                body.jobRunId,
                "cancel-requested",
                current.statusRevision + 1,
                assignmentId,
              ),
            ],
          };
        }
        if (
          body.ref.execution !== "job" ||
          body.ref.taskId !== this.#taskId ||
          body.ref.anchorEpoch !== this.#anchorEpoch
        ) {
          return {
            result: rejectedControl(
              "epoch-stale",
              "Uncertain resolution does not bind the current task anchor",
            ),
          };
        }
        const current = state.states.get(body.ref.jobRunId);
        const open = state.resolutions.get(body.ref.jobRunId);
        const assigned = open
          ? state.assignedById.get(open.subject.assignmentId)
          : undefined;
        if (
          !current ||
          current.state !== "uncertain" ||
          !open ||
          open.resolution ||
          open.openFactDigest !== body.openFactDigest ||
          !assigned ||
          state.assignmentByJob.get(body.ref.jobRunId) !== assigned.record.assignmentId
        ) {
          return {
            result: rejectedControl(
              "fence-rejected",
              "Uncertain resolution targets a closed or different job fact",
            ),
          };
        }
        const nextState: JobRunState =
          body.decision === "user-verified-side-effects"
            ? "failed"
            : body.decision === "user-abandoned"
              ? "cancelled"
              : "queued";
        if (
          nextState === "queued" &&
          definition.state !== "enabled"
        ) {
          return {
            result: rejectedControl(
              "fence-rejected",
              "Task must be enabled before uncertain work can be retried",
            ),
          };
        }
        const fact = closeResolution(
          open,
          body.decision,
          context.envelope.principal.surfacePrincipal,
          context.envelope.at,
        );
        return {
          result: {
            v: 1,
            status: "ok",
            body: {
              t: "uncertain-resolve",
              state: nextState,
              factDigest: fact.resolution!.factDigest,
            },
          },
          authorityEntries: [
            jobRecord(this.#taskId, {
              t: "resolution",
              jobRunId: body.ref.jobRunId,
              fact,
            }),
            ...capabilityRevocations(this.#taskId, state, assigned),
            stateRecord(
              this.#taskId,
              body.ref.jobRunId,
              nextState,
              current.statusRevision + 1,
              assigned.record.assignmentId,
            ),
          ],
        };
      }),
    }));
    });
    await this.#schedulerNotices?.publishNew();
    return outcome;
  }

  async pendingCancellations(): Promise<PendingJobFence[]> {
    return this.#select((state) =>
      byAssignmentCommit(state, state.openAssignments.values())
        .flatMap((assignmentId) => {
          const fence = state.cancelFences.get(assignmentId);
          return fence ? [fence] : [];
        })
        .filter((fence) => {
          const assigned = state.assignedById.get(fence.assignmentId);
          const current = assigned
            ? state.states.get(assigned.record.jobRunId)
            : undefined;
          return (
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === fence.assignmentId &&
            (current?.state === "cancel-requested" || current?.state === "uncertain") &&
            !state.acceptedCancellations.has(fence.assignmentId) &&
            !state.superseded.has(fence.assignmentId) &&
            !state.containedFacts.has(
              state.resolutions.get(assigned.record.jobRunId)?.openFactDigest ?? "",
            ) &&
            !state.rejectedNotStarted.has(
              notStartedRejectionKey(fence.assignmentId, "cancel-owner-fence"),
            )
          );
        })
        .map((fence) => ({
          assignmentId: fence.assignmentId,
          fence: { fenceSeq: fence.fenceSeq, requestId: fence.requestId },
        })),
    );
  }

  async requestSupersede(
    assignmentId: string,
    requestId: string,
  ): Promise<PendingJobFence["fence"]> {
    assertIdentifier(assignmentId, "Assignment id");
    assertIdentifier(requestId, "Supersede request id");
    return (
      await this.#transact<PendingJobFence["fence"]>((state, prefix) => {
        const known = state.assignedById.get(assignmentId);
        if (!known) throw new Error("Supersede request names an unknown assignment");
        const existing = state.supersedeRequests.get(assignmentId);
        if (existing) {
          if (existing.requestId !== requestId) {
            throw new Error("Assignment already has a different supersede request");
          }
          return {
            kind: "return",
            value: { fenceSeq: existing.fenceSeq, requestId: existing.requestId },
          };
        }
        const assigned = requireCurrentAssignment(state, assignmentId);
        const current = state.states.get(assigned.record.jobRunId);
        if (current?.state !== "dispatched") {
          throw new Error("Only a dispatched assignment can be superseded");
        }
        const fence = { fenceSeq: prefix.nextLsn, requestId };
        return {
          kind: "append",
          entries: [
            jobRecord(this.#taskId, {
              t: "supersede-requested",
              assignmentId,
              ...fence,
            }),
          ],
          value: fence,
        };
      })
    ).value;
  }

  async pendingSupersedes(): Promise<PendingJobFence[]> {
    return this.#select((state) =>
      byAssignmentCommit(state, state.openAssignments.values())
        .flatMap((assignmentId) => {
          const request = state.supersedeRequests.get(assignmentId);
          return request ? [request] : [];
        })
        .filter((request) => {
          const assigned = state.assignedById.get(request.assignmentId);
          const current = assigned
            ? state.states.get(assigned.record.jobRunId)
            : undefined;
          return (
            assigned !== undefined &&
            state.assignmentByJob.get(assigned.record.jobRunId) === request.assignmentId &&
            (current?.state === "dispatched" ||
              current?.state === "cancel-requested" ||
              current?.state === "uncertain") &&
            !state.superseded.has(request.assignmentId) &&
            !state.supersedeStarted.has(request.assignmentId) &&
            !state.rejectedNotStarted.has(
              notStartedRejectionKey(request.assignmentId, "supersede"),
            )
          );
        })
        .map((request) => ({
          assignmentId: request.assignmentId,
          fence: { fenceSeq: request.fenceSeq, requestId: request.requestId },
        })),
    );
  }

  async markUncertain(
    assignmentId: string,
    cause: Exclude<JobResolutionFact["cause"], "dispatch-conflict">,
  ): Promise<JobResolutionFact> {
    assertIdentifier(assignmentId, "Assignment id");
    const transaction = await this.#transact<JobResolutionFact>((state) => {
        const assigned = requireCurrentAssignment(state, assignmentId);
        const current = state.states.get(assigned.record.jobRunId);
        if (!current) throw corruptJobJournal("Assigned job has no state");
        const existing = state.resolutions.get(assigned.record.jobRunId);
        if (isOpenResolutionFact(existing)) {
          if (existing.cause !== cause) {
            throw new Error("Job occurrence already has a different uncertain fact");
          }
          return { kind: "return", value: snapshot(existing) };
        }
        if (
          current.state !== "dispatched" &&
          current.state !== "running" &&
          current.state !== "cancel-requested"
        ) {
          throw new Error("Only an active assignment can become uncertain");
        }
        const fact = openResolution(
          this.#taskId,
          assigned.record.jobRunId,
          this.#anchorEpoch,
          assignmentId,
          cause,
          this.#clock(),
        );
        return {
          kind: "append",
          entries: [
            jobRecord(this.#taskId, {
              t: "resolution",
              jobRunId: assigned.record.jobRunId,
              fact,
            }),
            stateRecord(
              this.#taskId,
              assigned.record.jobRunId,
              "uncertain",
              current.statusRevision + 1,
              assignmentId,
            ),
          ],
          value: fact,
        };
      });
    return transaction.value;
  }

  async acceptSupersedeProof(rawProof: SupersedeProof): Promise<void> {
    const proof = await verifyProtocolStep(() => validateSupersedeProof(rawProof, this.#verifier));
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(proof.assignmentId);
      if (!assigned) throw new Error("Supersede proof names an unknown assignment");
      if (
        !proofBindsJobSource(
          state,
          assigned,
          proof,
          this.#anchorEpoch,
          this.#legacyAbortTickets,
        )
      ) {
        throw new Error("Supersede proof does not bind the durable fence");
      }
      const prior = state.superseded.get(proof.assignmentId);
      if (prior && proof.decision === "not-started-fenced") {
        if (
          canonicalize(withoutSignature(prior.proof)) !==
          canonicalize(withoutSignature(proof))
        ) {
          throw new Error("Assignment already has a different termination proof");
        }
        return { kind: "return", value: undefined };
      }
      const observed = state.supersedeStarted.get(proof.assignmentId);
      if (observed && proof.decision === "already-started") {
        if (
          canonicalize(withoutSignature(observed.proof)) !==
          canonicalize(withoutSignature(proof))
        ) {
          throw new Error("Assignment already observed a different started proof");
        }
        return { kind: "return", value: undefined };
      }
      const current = state.states.get(assigned.record.jobRunId);
      if (!current) throw corruptJobJournal("Supersede target has no state");
      if (state.assignmentByJob.get(assigned.record.jobRunId) !== proof.assignmentId) {
        if (proof.decision === "already-started" && state.durableStarted.has(proof.assignmentId)) {
          return { kind: "return", value: undefined };
        }
        throw new Error("Supersede proof names a historical assignment");
      }
      if (proof.decision === "already-started") {
        if (current.state === "running" || isTerminal(current.state)) {
          return { kind: "return", value: undefined };
        }
        if (current.state === "uncertain" || current.state === "cancel-requested") {
          return {
            kind: "append",
            entries: [
              jobRecord(this.#taskId, {
                t: "supersede-started-observed",
                assignmentId: proof.assignmentId,
                proof,
              }),
            ],
            value: undefined,
          };
        }
        if (current.state !== "dispatched") {
          throw new Error("Already-started proof is invalid for the current state");
        }
        return {
          kind: "append",
          entries: [
            ...(!assigned.acked
              ? [jobRecord(this.#taskId, { t: "dispatch-acked" as const, assignmentId: proof.assignmentId })]
              : []),
            stateRecord(
              this.#taskId,
              assigned.record.jobRunId,
              "running",
              current.statusRevision + 1,
              proof.assignmentId,
            ),
          ],
          value: undefined,
        };
      }
      if (state.durableStarted.has(proof.assignmentId) || current.state === "running") {
        return this.#rejectContradictoryNotStarted(state, assigned, proof, current);
      }
      const open = state.resolutions.get(assigned.record.jobRunId);
      return this.#acceptNotStarted(
        state,
        assigned,
        proof,
        current,
        current.state === "uncertain" ? open : undefined,
      );
    });
  }

  async acceptDispatchRejection(
    rawResult: Extract<
      DispatchResult,
      { accepted: false; outcome: "rejected-before-received" }
    >,
  ): Promise<void> {
    const result = await verifyProtocolStep(() => validateDispatchResult(rawResult, this.#verifier));
    if (result.accepted || result.outcome !== "rejected-before-received") {
      throw new TypeError("Dispatch rejection path requires a rejection result");
    }
    const proof = await verifyProtocolStep(() => validateAssignmentTerminationProof(result.proof, this.#verifier));
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(proof.assignmentId);
      if (!assigned) throw new Error("Dispatch rejection names an unknown assignment");
      const prior = state.superseded.get(proof.assignmentId);
      if (prior) {
        if (
          canonicalize(withoutSignature(prior.proof)) !==
          canonicalize(withoutSignature(proof))
        ) {
          throw new Error("Assignment already has a different termination proof");
        }
        return { kind: "return", value: undefined };
      }
      const current = state.states.get(assigned.record.jobRunId);
      if (
        state.assignmentByJob.get(assigned.record.jobRunId) !== proof.assignmentId ||
        !proofBindsJobSource(
          state,
          assigned,
          proof,
          this.#anchorEpoch,
          this.#legacyAbortTickets,
        ) ||
        (current?.state !== "dispatched" && current?.state !== "uncertain")
      ) {
        throw new Error("Dispatch rejection does not bind the current assignment");
      }
      const open = state.resolutions.get(assigned.record.jobRunId);
      if (
        state.durableStarted.has(proof.assignmentId) ||
        open?.cause === "dispatch-conflict"
      ) {
        return this.#rejectContradictoryNotStarted(state, assigned, proof, current);
      }
      return this.#acceptNotStarted(
        state,
        assigned,
        proof,
        current,
        current.state === "uncertain" ? open : undefined,
      );
    });
  }

  async submitCancelProof(
    assignmentId: string,
    rawProof: CancelProofBody,
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#authenticateSubmission(context, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    await this.#loadSubmissionGuard(context, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    const proof = await verifyProtocolStep(() => validateCancelProof(rawProof, this.#verifier));
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) {
        throw new Error("Cancel proof does not bind the job assignment authority");
      }
      if (
        !proofBindsJobSource(
          state,
          assigned,
          proof,
          this.#anchorEpoch,
          this.#legacyAbortTickets,
        )
      ) {
        throw new Error(
          proof.cause === "abort-ticket"
            ? "Abort proof does not bind an owner-issued abort ticket"
            : "Cancel proof does not bind the job assignment authority",
        );
      }
      const durableProofs = [
        state.acceptedCancellations.get(assignmentId)?.proof,
        state.superseded.get(assignmentId)?.proof,
        state.containments.get(assignmentId)?.proof,
        state.rejectedNotStarted.get(
          notStartedRejectionKey(assignmentId, terminationProofKind(proof)),
        )?.proof,
      ].filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== undefined,
      );
      if (durableProofs.length > 0) {
        if (
          durableProofs.some(
            (candidate) =>
              canonicalize(withoutSignature(candidate)) !==
              canonicalize(withoutSignature(proof)),
          )
        ) {
          throw new Error(
            "Assignment already has a different durable termination proof",
          );
        }
        this.#authorizeSubmission(state, context, {
          mode: "durable-replay",
          method: "submission.submitCancelProof",
          assignmentId,
        });
        return { kind: "return", value: undefined };
      }
      if (state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId) {
        throw new Error("Job operation names a historical assignment");
      }
      const current = state.states.get(assigned.record.jobRunId);
      if (!current) throw corruptJobJournal("Cancel proof target has no state");
      this.#authorizeSubmission(state, context, {
        mode: "settlement",
        method: "submission.submitCancelProof",
        assignmentId,
      });
      if (
        proof.decision === "not-started" &&
        (state.durableStarted.has(assignmentId) || current.state === "running")
      ) {
        return this.#rejectContradictoryNotStarted(state, assigned, proof, current);
      }
      if (current.state === "uncertain") {
        const fact = state.resolutions.get(assigned.record.jobRunId);
        if (!fact || fact.resolution) {
          throw corruptJobJournal("Uncertain job has no open resolution fact");
        }
        if (fact.cause === "dispatch-conflict") {
          if (proof.decision === "halted") {
            const conflict = state.conflicts.get(assignmentId);
            if (
              !conflict ||
              proof.lastRecordSeq <= conflict.proof.receivedRecordSeq
            ) {
              throw new Error("Conflict containment proof does not follow the received prefix");
            }
            if (state.containedFacts.has(fact.openFactDigest)) {
              throw corruptJobJournal("Contained cancel proof was not replayed durably");
            }
            return {
              kind: "append",
              entries: [
                jobRecord(this.#taskId, {
                  t: "dispatch-conflict-contained",
                  assignmentId,
                  openFactDigest: fact.openFactDigest,
                  proof,
                }),
              ],
              value: undefined,
            };
          }
          this.#assertAssignmentUsageFinal(assigned.record, proof.usageFinal);
          return this.#acceptNotStarted(state, assigned, proof, current, fact);
        }
        if (proof.decision === "not-started") {
          this.#assertAssignmentUsageFinal(assigned.record, proof.usageFinal);
          return this.#acceptNotStarted(state, assigned, proof, current, fact);
        }
        if (state.containedFacts.has(fact.openFactDigest)) {
          throw corruptJobJournal("Contained cancel proof was not replayed durably");
        }
        return {
          kind: "append",
          entries: [
            jobRecord(this.#taskId, {
              t: "cancel-contained",
              assignmentId,
              openFactDigest: fact.openFactDigest,
              proof,
            }),
          ],
          value: undefined,
        };
      }
      if (
        current.state !== "cancel-requested" &&
        !(proof.cause === "abort-ticket" &&
          (current.state === "dispatched" || current.state === "running"))
      ) {
        throw new Error("Cancel proof is invalid for the current job state");
      }
      this.#assertAssignmentUsageFinal(assigned.record, proof.usageFinal);
      return this.#acceptCancellation(state, assigned, proof, current);
    });
  }

  async recordDispatchConflict(
    sent: PendingJobDispatch,
    rawResult: DispatchResult,
  ): Promise<"acked-original" | "opened-uncertain"> {
    const result = await verifyProtocolStep(() => validateDispatchResult(rawResult, this.#verifier));
    if (result.accepted || result.outcome !== "conflicting-redelivery") {
      throw new TypeError("Dispatch conflict path requires a conflict result");
    }
    const conflictReferences = await assertArtifactsPresent(result, this.#artifacts);
    const transaction = await this.#transact<"acked-original" | "opened-uncertain">(
        (state, prefix) => {
          const assignmentId = sent.assignmentId;
          const assigned = state.assignedById.get(assignmentId);
          if (!assigned) throw new Error("Dispatch conflict names an unknown assignment");
          const proof = validateDispatchConflictProof(result.proof, this.#verifier);
          if (
            proof.assignmentId !== assignmentId ||
            proof.executorId !== assigned.record.executorId ||
            canonicalize(proof.conflictingDispatchRef) !==
              canonicalize(dispatchEnvelopeArtifact(sent.envelope).ref) ||
            proof.conflictingActivationDigest !==
              protocolDigest(
                "AssignmentActivationPayload",
                1,
                withoutSignature(sent.activation),
              )
          ) {
            throw new Error("Dispatch conflict proof does not bind the sent dispatch");
          }
          const existing = state.conflicts.get(assignmentId);
          if (existing) {
            if (
              canonicalize(withoutSignature(existing.proof)) !==
              canonicalize(withoutSignature(proof))
            ) {
              throw new Error("Assignment already has a different dispatch conflict");
            }
            return { kind: "return", value: existing.handling };
          }
          const current = state.states.get(assigned.record.jobRunId);
          if (
            state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId ||
            current?.state !== "dispatched" ||
            assigned.acked
          ) {
            throw new Error("Dispatch conflict is invalid for the current job state");
          }
          const expectedActivation = buildJobActivationPayloadFromBinding({
            binding: {
              jobRunId: assigned.record.jobRunId,
              taskId: this.#taskId,
              anchorEpoch: assigned.record.anchorEpoch,
              assignmentId,
              executorId: assigned.record.executorId,
              dispatchRef: assigned.record.dispatchRef,
              manifestDigest: assigned.record.manifestDigest,
              permissionLeaseDigest: assigned.record.permissionLeaseDigest,
              capIds: assigned.record.capIds,
              reservation: assigned.record.reservation,
            },
            commit: {
              lsn: assigned.commit.lsn,
              envelopeDigest: assigned.commit.envelopeDigest,
            },
            issuedAt: assigned.commit.at,
          });
          const expectedDigest = protocolDigest(
            "AssignmentActivationPayload",
            1,
            expectedActivation,
          );
          const handling =
            canonicalize(proof.acceptedDispatchRef) ===
              canonicalize(assigned.record.dispatchRef) &&
            proof.acceptedActivationDigest === expectedDigest
              ? "acked-original"
              : "opened-uncertain";
          const entries: LogicalRecord<JobJournalRecord>[] = [
            jobRecord(this.#taskId, {
              t: "dispatch-conflict",
              assignmentId,
              proof,
              handling,
            }),
          ];
          if (handling === "acked-original") {
            entries.push(jobRecord(this.#taskId, { t: "dispatch-acked", assignmentId }));
          } else {
            const fact = openResolution(
              this.#taskId,
              assigned.record.jobRunId,
              this.#anchorEpoch,
              assignmentId,
              "dispatch-conflict",
              this.#clock(),
            );
            entries.push(
              jobRecord(this.#taskId, {
                t: "resolution",
                jobRunId: assigned.record.jobRunId,
                fact,
              }),
              stateRecord(
                this.#taskId,
                assigned.record.jobRunId,
                "uncertain",
                current.statusRevision + 1,
                assignmentId,
              ),
              jobRecord(this.#taskId, {
                t: "cancel-fence",
                assignmentId,
                fenceSeq: prefix.nextLsn,
                requestId: `dispatch-conflict:${fact.openFactDigest}`,
              }),
              ...capabilityRevocations(this.#taskId, state, assigned),
            );
          }
          return { kind: "append", entries, value: handling };
        },
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
    if (context.principal.kind !== "assignment") {
      throw new Error("Bundle submission requires an assignment capability");
    }
    const assignmentId = context.principal.capability.assignmentId;
    this.#authenticateSubmission(context, {
      method: "submission.submitBundle",
      assignmentId,
    });
    const guard = await this.#loadSubmissionGuard(context, {
      method: "submission.submitBundle",
      assignmentId,
    });
    const guardAssigned = guard.assignedById.get(assignmentId);
    if (!guardAssigned) {
      throw new Error("Bundle capability is not activated by a durable job assignment");
    }
    const guardOccurrence = guard.occurrences.get(guardAssigned.record.jobRunId);
    if (!guardOccurrence) throw new Error("Bundle assignment has no durable occurrence");
    const guardCommitted = guard.committedByAssignment.get(assignmentId);
    if (!guardCommitted) {
      const guardState = guard.states.get(guardAssigned.record.jobRunId)?.state;
      const rejectionMessage = this.#submissionBundleRejection(
        guard,
        context,
        assignmentId,
        guardAssigned.record.jobRunId,
      );
      if (rejectionMessage) {
        await verifyProtocolStep(() => this.#authorizeGuardSubmission(guard, context, {
          mode: "durable-rejection",
          method: "submission.submitBundle",
          assignmentId,
        }));
        return rejected("fence-rejected", rejectionMessage, false);
      }
      await verifyProtocolStep(() => this.#authorizeGuardSubmission(guard, context, {
        mode: guardState === "uncertain" ? "settlement" : "active",
        method: "submission.submitBundle",
        assignmentId,
      }));
    }
    let bundle: JobBundle;
    try {
      bundle = validateJobSealedBundle(rawBundle);
    } catch (error) {
      return rejected("invalid", error instanceof Error ? error.message : "Invalid job bundle", false);
    }
    if (bundle.assignmentId !== assignmentId) {
      return rejected(
        "fence-rejected",
        "Bundle does not bind the authenticated assignment",
        false,
      );
    }
    if (guardCommitted) {
      const artifact = sealedBundleArtifact(bundle);
      if (canonicalize(guardCommitted.ref) !== canonicalize(artifact.ref)) {
        await verifyProtocolStep(() => this.#authorizeGuardSubmission(guard, context, {
          mode: "active",
          method: "submission.submitBundle",
          assignmentId,
        }));
        return rejected("fence-rejected", "Assignment committed another bundle", false);
      }
      const occurrence = guard.occurrences.get(guardAssigned.record.jobRunId);
      if (!occurrence) {
        throw corruptJobJournal("Committed job assignment has no durable occurrence");
      }
      const capability = context.principal.capability;
      const expectedFence = createJobCommitFence({
        taskId: this.#taskId,
        jobRunId: guardAssigned.record.jobRunId,
        scheduledFor: occurrence.scheduledFor,
        taskRevision: guardAssigned.record.taskRevision,
        deliveryPlanDigest: guardAssigned.record.deliveryPlanDigest,
        anchorEpoch: guardAssigned.record.anchorEpoch,
        assignmentId,
        executorId: guardAssigned.record.executorId,
      });
      if (
        capability.scope.execution !== "job" ||
        !("anchorEpoch" in capability) ||
        capability.anchorEpoch !== guardAssigned.record.anchorEpoch ||
        bundle.body.taskId !== this.#taskId ||
        bundle.body.jobRunId !== guardAssigned.record.jobRunId ||
        bundle.executorId !== guardAssigned.record.executorId ||
        canonicalize(bundle.body.fence) !== canonicalize(expectedFence)
      ) {
        throw corruptJobJournal(
          "Committed bundle does not match its durable assignment fence",
        );
      }
      await verifyProtocolStep(() => this.#authorizeGuardSubmission(guard, context, {
        mode: "durable-replay",
        method: "submission.submitBundle",
        assignmentId,
      }));
      // 已提交的重放在日志事务之外核对用量终值：调控状态待装入时补齐后重做
      for (let rounds = 0; ; rounds++) {
        try {
          this.#assertAssignmentUsageFinal(guardAssigned.record, bundle.usageFinal);
          break;
        } catch (error) {
          if (rounds >= 64 || !(await awaitAuthorityPreparation(error))) throw error;
        }
      }
      this.#commitParticipant?.wakePendingPublishing?.(this.#taskId);
      return { committed: true, commitRevision: guardCommitted.jobRevision };
    }
    let closure: ValidatedJobBundleClosure;
    try {
      closure = await validateJobBundleClosure(bundle, this.#artifacts);
    } catch (error) {
      if (error instanceof JobBundleClosureError) {
        return rejected(error.code, error.message, false);
      }
      throw error;
    }
    const { artifact } = closure;
    const compiledDelivery = await compileJobDeliveryContents(
      bundle,
      closure.batch,
      this.#artifacts,
      guardOccurrence.deliveryRequired,
    );
    const stagedReferences = closure.batch
      ? await this.#commitParticipant?.collectStagedReferences?.(closure.batch) ?? []
      : [];
    const transaction = await this.#transact<
      | { readonly committed: true; readonly commitRevision: number }
      | { readonly committed: false; readonly error: AuthorityError }
    >(
      async (state, prefix) => {
        const exact = state.committed.get(assignmentId);
        if (exact) {
          if (canonicalize(exact.bundle) !== canonicalize({ ref: artifact.ref })) {
            return {
              kind: "return",
              value: rejected("fence-rejected", "Assignment committed another bundle", false),
            };
          }
          this.#authorizeSubmission(state, context, {
            mode: "durable-replay",
            method: "submission.submitBundle",
            assignmentId,
          });
          return {
            kind: "return",
            value: { committed: true, commitRevision: exact.jobRevision },
          };
        }
        const assigned = state.assignedById.get(assignmentId);
        if (
          !assigned ||
          state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId
        ) {
          this.#authorizeSubmission(state, context, {
            mode: "durable-rejection",
            method: "submission.submitBundle",
            assignmentId,
          });
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle belongs to a historical assignment", false),
          };
        }
        const occurrence = state.occurrences.get(assigned.record.jobRunId);
        const current = state.states.get(assigned.record.jobRunId);
        const open = state.resolutions.get(assigned.record.jobRunId);
        if (!occurrence || !current) throw corruptJobJournal("Bundle assignment is incomplete");
        if (!jobBundleBindsAssignedOccurrence(bundle, assigned, occurrence)) {
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle fence does not match the occurrence", false),
          };
        }
        if (
          current.state === "uncertain" &&
          open?.cause === "dispatch-conflict" &&
          !open.resolution
        ) {
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle is blocked by an open dispatch conflict", false),
          };
        }
        if (
          current.state !== "dispatched" &&
          current.state !== "running" &&
          current.state !== "cancel-requested" &&
          current.state !== "uncertain"
        ) {
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle is late for the current job state", false),
          };
        }
        this.#authorizeSubmission(state, context, {
          mode: current.state === "uncertain" ? "settlement" : "active",
          method: "submission.submitBundle",
          assignmentId,
        });
        this.#assertAssignmentUsageFinal(assigned.record, bundle.usageFinal);
        const mutationBatch = closure.batch;
        const definition = requireDefinitionRevision(state, occurrence.taskRevision);
        const delivery = this.#delivery.prepareJobCommit({
          at: prefix.at,
          occurrence,
          definition,
          bundle,
          assignmentLifecycleSource: {
            owner: "assignment",
            id: `${assigned.record.executorId === this.#localExecutorId ? "local" : "relay"}:${assignmentId}`,
            revision: assigned.record.dispatchDigest,
          },
          ...(mutationBatch ? { mutationBatch } : {}),
          ...(compiledDelivery.result
            ? { resultContent: compiledDelivery.result.content }
            : {}),
          stagedContents: compiledDelivery.stagedContents,
          stagedContentErrors: compiledDelivery.stagedContentErrors,
        });
        if (!delivery.accepted) {
          return {
            kind: "return",
            value: { committed: false as const, error: delivery.error },
          };
        }
        if (delivery.records.length > 0) {
          assertForeignRecords(
            delivery.records,
            jobStream(this.#taskId),
            "Job delivery participant",
          );
        }
        const requiresMutationParticipant =
          mutationBatch?.records.some(
            (record) => record.mutation.kind !== "delivery-enqueue",
          ) === true;
        let mutationRecords: readonly LogicalRecord<unknown>[] = [];
        let mutationOutcomes: ReadonlyMap<
          number,
          Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"]
        > = new Map();
        if (requiresMutationParticipant) {
          if (!mutationBatch || !this.#commitParticipant) {
            return {
              kind: "return",
              value: rejected(
                "capability-gap",
                "Job staged mutation requires its owning commit participant",
                false,
              ),
            };
          }
          const prepared = await this.#commitParticipant.prepare({
            authorityPrefixLsn: prefix.lastLsn,
            authorityContext: prefix,
            occurrence,
            bundle,
            mutationBatch,
          });
          if (!prepared.accepted) {
            return {
              kind: "return",
              value: { committed: false as const, error: prepared.error },
            };
          }
          assertForeignRecords(
            prepared.records,
            jobStream(this.#taskId),
            "Job mutation commit participant",
          );
          if (prepared.records.some((record) => record.stream === "delivery")) {
            throw new Error("Job mutation commit participant cannot write the delivery stream");
          }
          mutationRecords = prepared.records;
          mutationOutcomes = prepared.outcomes;
        }
        const publishOutcomes: Extract<
          PublishRecord,
          { t: "publish-decision" }
        >["outcomes"] = [];
        for (const record of mutationBatch?.records ?? []) {
          const outcome =
            record.mutation.kind === "delivery-enqueue"
              ? delivery.stagedRevisions.has(record.seq)
                ? {
                    t: "granted" as const,
                    targetRevision: delivery.stagedRevisions.get(record.seq)!,
                  }
                : delivery.stagedConflicts.has(record.seq)
                  ? {
                      t: "conflicted" as const,
                      error: delivery.stagedConflicts.get(record.seq)!,
                    }
                  : undefined
              : mutationOutcomes.get(record.seq);
          if (!outcome) {
            throw new Error("Job publish decision omitted a staged mutation");
          }
          publishOutcomes.push({ seq: record.seq, outcome });
        }
        const jobRevision = state.nextJobRevision;
        const entries: LogicalRecord<unknown>[] = [
          jobRecord(this.#taskId, {
            t: "committed",
            jobRunId: assigned.record.jobRunId,
            assignmentId,
            bundle: { ref: artifact.ref },
            jobRevision,
          }),
          ...capabilityRevocations(this.#taskId, state, assigned),
          stateRecord(
            this.#taskId,
            assigned.record.jobRunId,
            "committed",
            current.statusRevision + 1,
            assignmentId,
          ),
          ...delivery.records,
          ...mutationRecords,
        ];
        if (mutationBatch && bundle.body.mutationBatch) {
          const decision = {
            t: "publish-decision",
            assignmentId,
            batch: { ref: bundle.body.mutationBatch.ref },
            sessionCount: 0,
            globalCount: bundle.body.mutationBatch.globalCount,
            outcomes: publishOutcomes,
          } satisfies Extract<PublishRecord, { t: "publish-decision" }>;
          validatePublishDecisionForBatch(decision, mutationBatch);
          entries.push({
            stream: "publish",
            body: decision,
          });
          if (
            mutationBatch.records.some((record) =>
              record.domain === "global" && record.mutation.kind !== "delivery-enqueue"
            )
          ) {
            entries.push({
              stream: "publish",
              body: {
                t: "publish-progress",
                assignmentId,
                domain: "global",
                upToSeq: 0,
                state: "pending",
              } satisfies Extract<PublishRecord, { t: "publish-progress" }>,
            });
          }
          if (this.#schedulerNotices) {
            for (const draft of projectSchedulePublishNotices({
              taskId: this.#taskId, jobRunId: occurrence.jobRunId, assignmentId,
              definition, batch: mutationBatch, outcomes: publishOutcomes, at: prefix.at,
            })) entries.push(...this.#schedulerNotices.prepareRecords(draft));
          }
        }
        if (current.state === "uncertain") {
          if (!open || open.resolution) throw corruptJobJournal("Uncertain job has no open fact");
          entries.push(jobRecord(this.#taskId, {
            t: "resolution",
            jobRunId: assigned.record.jobRunId,
            fact: closeResolution(
              open,
              "late-bundle-committed",
              bundle.executorId,
              this.#clock(),
            ),
          }));
        }
        return {
          kind: "append",
          entries,
          value: { committed: true, commitRevision: jobRevision },
        };
      },
      [...closure.references, ...compiledDelivery.references, ...stagedReferences],
      this.#commitParticipant?.readProjectionIds ?? [],
    ).catch((error: unknown) => {
      if (error instanceof TransactionArtifactReferenceError) {
        return { value: rejected("missing-base", "Staged artifact dependencies changed; resubmit the bundle", true) };
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

  async #executeSystem(
    jobRunId: string,
    context: AuthorityCallContext,
    recoverRunning: boolean,
  ): Promise<"committed" | "failed"> {
    const running = this.#systemRuns.get(jobRunId);
    if (running) return running;
    const operation = this.#runSystem(jobRunId, context, recoverRunning).finally(() => {
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
    const active = await this.#select((state) => {
      const occurrence = state.occurrences.get(jobRunId);
      return {
        occurrence,
        current: state.states.get(jobRunId),
        fence: state.systemFences.get(jobRunId),
        definition: occurrence
          ? requireDefinitionRevision(state, occurrence.taskRevision)
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
    if (!handler) throw new Error("System job handler is not registered in this host");
    if (!this.#systemResources) {
      throw new Error("System job resource coordination is not configured");
    }
    if (!active.occurrence || !active.current) {
      throw new Error("System job occurrence is unknown");
    }
    if (active.current.state === "committed" || active.current.state === "failed") {
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
      await verifyProtocolStep(() => assertSystemLease(
        prepared.lease,
        this.#taskId,
        jobRunId,
        this.#anchorEpoch,
        1,
        this.#verifier,
      ));
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
      const activation = await this.#transact<boolean>((state) => {
        const current = state.states.get(jobRunId);
        if (current?.state !== "queued") {
          return { kind: "return", value: false };
        }
        const activationRecords = [
          { t: "system-started", jobRunId, fence },
          {
            t: "state",
            jobRunId,
            state: "running",
            statusRevision: current.statusRevision + 1,
          },
        ] satisfies readonly JobJournalRecord[];
        assertSystemJobActivationReplayContract({
          taskId: this.#taskId,
          jobRunId,
          anchorEpoch: this.#anchorEpoch,
          definitionKind: definition.definition.kind,
          occurrence: active.occurrence,
          currentState: current.state,
          previousFence: undefined,
          fence,
          hasForeignRecords: prepared.records.length > 0,
          hasAtomicRunningState: recordsHaveJobState(
            activationRecords,
            jobRunId,
            "running",
            current.statusRevision + 1,
            undefined,
          ),
        });
        this.#systemResources!.preflightActivationRecords({
          fence,
          records: prepared.records,
        });
        return {
          kind: "append",
          entries: [
            ...prepared.records,
            ...activationRecords.map((record) => jobRecord(this.#taskId, record)),
          ],
          value: true,
        };
      });
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
      const recovered = await this.#systemResources.recover({ fence: durableFence });
      if (recovered.kind === "reuse") {
        await verifyProtocolStep(() => assertSystemLease(
          recovered.lease,
          this.#taskId,
          jobRunId,
          this.#anchorEpoch,
          durableFence.attempt,
          this.#verifier,
        ));
        if (recovered.lease.reservationId !== active.fence.reservationId) {
          throw new TypeError("Reused system lease does not bind the durable fence");
        }
        lease = recovered.lease;
        fence = active.fence;
      } else {
        const attempt = active.fence.attempt + 1;
        await verifyProtocolStep(() => assertSystemLease(
          recovered.lease,
          this.#taskId,
          jobRunId,
          this.#anchorEpoch,
          attempt,
          this.#verifier,
        ));
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
        const replacement = await this.#transact<boolean>((state) => {
          const currentFence = state.systemFences.get(jobRunId);
          const current = state.states.get(jobRunId);
          if (
            current?.state !== "running" ||
            !currentFence ||
            canonicalize(currentFence) !== canonicalize(active.fence)
          ) {
            return { kind: "return", value: false };
          }
          const activationRecords = [
            { t: "system-started", jobRunId, fence },
          ] satisfies readonly JobJournalRecord[];
          assertSystemJobActivationReplayContract({
            taskId: this.#taskId,
            jobRunId,
            anchorEpoch: this.#anchorEpoch,
            definitionKind: definition.definition.kind,
            occurrence: active.occurrence,
            currentState: current.state,
            previousFence: currentFence,
            fence,
            hasForeignRecords: recovered.records.length > 0,
            hasAtomicRunningState: recordsHaveJobState(
              activationRecords,
              jobRunId,
              "running",
              current.statusRevision + 1,
              undefined,
            ),
          });
          this.#systemResources!.preflightActivationRecords({
            previousFence: active.fence,
            fence,
            records: recovered.records,
          });
          return {
            kind: "append",
            entries: [
              ...recovered.records,
              ...activationRecords.map((record) => jobRecord(this.#taskId, record)),
            ],
            value: true,
          };
        });
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
      summary = validateSystemJobSummary((result as { readonly summary?: unknown }).summary);
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
    const terminalRecords = this.#systemResources.terminal({ lease, outcome });
    assertForeignRecords(terminalRecords, jobStream(this.#taskId));
    this.#systemResources.assertTerminalRecords({
      fence,
      outcome,
      records: terminalRecords,
    });
    await this.#transact<void>((state) => {
      const current = state.states.get(jobRunId);
      if (current?.state === outcome) return { kind: "return", value: undefined };
      if (current?.state !== "running") {
        throw new Error("System job terminal result raced with another terminal transition");
      }
      const currentFence = state.systemFences.get(jobRunId);
      if (!currentFence || canonicalize(currentFence) !== canonicalize(fence)) {
        throw new Error("System job terminal result belongs to a stale attempt");
      }
      const terminalJobRecords = [
        {
          t: "system-result",
          jobRunId,
          fence,
          outcome,
          detail: preparedDetail.stored,
        },
        {
          t: "state",
          jobRunId,
          state: outcome,
          statusRevision: current.statusRevision + 1,
        },
      ] satisfies readonly JobJournalRecord[];
      assertSystemJobTerminalReplayContract({
        jobRunId,
        definitionKind: definition.definition.kind,
        currentState: current.state,
        currentFence,
        resultFence: fence,
        resultAlreadyExists: state.systemResults.has(jobRunId),
        hasForeignRecords: terminalRecords.length > 0,
        hasAtomicTerminalState: recordsHaveJobState(
          terminalJobRecords,
          jobRunId,
          outcome,
          current.statusRevision + 1,
          undefined,
        ),
      });
      this.#systemResources!.preflightTerminalRecords({
        fence,
        outcome,
        records: terminalRecords,
      });
      return {
        kind: "append",
        entries: [
          ...terminalRecords,
          ...terminalJobRecords.map((record) => jobRecord(this.#taskId, record)),
        ],
        value: undefined,
      };
    }, preparedDetail.references);
    return outcome;
  }

  async resumeSystemJobs(context: AuthorityCallContext): Promise<number> {
    const resumable = await this.#select((state) =>
      byOccurrenceOrder(state, state.openRuns.values())
        .map((jobRunId) => [jobRunId, state.states.get(jobRunId)!] as const)
        .filter(([jobRunId, value]) => {
          if (value.state === "running") return state.systemFences.has(jobRunId);
          if (value.state !== "queued") return false;
          const occurrence = state.occurrences.get(jobRunId);
          if (!occurrence) return false;
          const definition = requireDefinitionRevision(state, occurrence.taskRevision);
          return definition.state === "enabled" && definition.definition.kind === "system";
        })
        .map(([jobRunId]) => jobRunId),
    );
    let completed = 0;
    for (const jobRunId of resumable) {
      await this.#executeSystem(jobRunId, context, true);
      completed += 1;
    }
    return completed;
  }

  async occurrence(jobRunId: string): Promise<JobOccurrence | undefined> {
    return this.#select((state) => {
      const occurrence = state.occurrences.get(jobRunId);
      const current = state.states.get(jobRunId);
      return occurrence
        ? validateJobOccurrence({
            ...snapshot(occurrence),
            state: current?.state ?? occurrence.state,
          })
        : undefined;
    });
  }

  /** 一条 occurrence 的调度事实（含结果），精确读取。 */
  async scheduleOccurrence(jobRunId: string): Promise<ScheduleOccurrence | undefined> {
    return this.#select((state) => {
      const occurrence = state.occurrences.get(jobRunId);
      return occurrence ? scheduleOccurrenceOf(state, occurrence) : undefined;
    });
  }

  /**
   * 调度视图：当前定义，运行次数、连续失败、最近一次 occurrence，以及全部未结束的 occurrence（按次序）。
   * 同一份投影快照，不读历史 run。
   */
  async schedulerReadView(): Promise<JobSchedulerReadView> {
    return this.#select((state) => {
      const last = latestOccurrence(state);
      return {
        ...(state.definition ? { definition: snapshot(state.definition) } : {}),
        runCount: state.runCount,
        consecutiveFailures: latestFailures(state),
        ...(last ? { last: scheduleOccurrenceOf(state, last) } : {}),
        open: byOccurrenceOrder(state, state.openRuns.values())
          .map((jobRunId) => scheduleOccurrenceOf(state, state.occurrences.get(jobRunId)!)),
      };
    });
  }

  /** 错过且尚未汇总通知的 occurrence，按计划时间、id 升序。 */
  async pendingMissedOccurrences(): Promise<readonly ScheduleOccurrence[]> {
    return this.#select((state) =>
      byOccurrenceOrder(state, state.pendingMissed.values())
        .map((jobRunId) => scheduleOccurrenceOf(state, state.occurrences.get(jobRunId)!)));
  }

  /** 未结束的 occurrence，按计划时间、id 升序。 */
  async openOccurrences(): Promise<readonly ScheduleOccurrence[]> {
    return (await this.schedulerReadView()).open;
  }

  /**
   * 历史 occurrence 分页：从最近一次（或 before 这条之前）往前，至多 limit 条，按从近到远。
   */
  async occurrencesPage(input: { readonly before?: string; readonly limit: number }): Promise<readonly ScheduleOccurrence[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 256) {
      throw new TypeError("Occurrence page limit must be 1-256");
    }
    if (input.before !== undefined) assertIdentifier(input.before, "Occurrence page cursor");
    return this.#select((state) => {
      const before = input.before === undefined ? undefined : state.occurrences.get(input.before);
      if (input.before !== undefined && !before) throw new TypeError("Occurrence page cursor is unknown");
      const page: ScheduleOccurrence[] = [];
      walkOccurrencesBackward(state, before, (occurrence) => {
        page.push(scheduleOccurrenceOf(state, occurrence));
        return page.length < input.limit;
      });
      return page;
    });
  }

  async currentState(jobRunId: string): Promise<JobRunState | undefined> {
    return this.#select((state) => state.states.get(jobRunId)?.state);
  }

  async statusHistory(
    jobRunId: string,
    afterStatusRevision: number,
  ): Promise<JobStatusNotice[]> {
    assertIdentifier(jobRunId, "Job run id");
    if (!Number.isSafeInteger(afterStatusRevision) || afterStatusRevision < 0) {
      throw new TypeError("Last-seen job status revision must be non-negative");
    }
    return this.#select((state) =>
      (state.statusHistoryByRun.get(jobRunId) ?? [])
        .filter((entry) => entry.statusRevision > afterStatusRevision)
        .map((entry) =>
          jobStatusNotice(this.#taskId, this.#anchorEpoch, jobRunId, entry),
        )
        .filter((notice): notice is JobStatusNotice => notice !== undefined),
    );
  }

  async currentResolution(jobRunId: string): Promise<JobResolutionFact | undefined> {
    return this.#select((state) => {
      const fact = state.resolutions.get(jobRunId);
      return fact ? snapshot(fact) : undefined;
    });
  }

  async systemResult(
    jobRunId: string,
  ): Promise<MaterializedSystemJobResult | undefined> {
    return this.#select((state) => {
      const result = state.systemResults.get(jobRunId);
      return result ? snapshot(result) : undefined;
    });
  }

  async taskDefinition(): Promise<TaskDefinition | undefined> {
    return this.#select((state) =>
      state.definition ? snapshot(state.definition) : undefined,
    );
  }

  async validateExecutorDispatchResult(result: DispatchResult): Promise<DispatchResult> {
    return verifyProtocolStep(() => validateDispatchResult(result, this.#verifier));
  }

  async #closeQueued(
    jobRunId: string,
    target: "failed" | "expired",
  ): Promise<boolean> {
    assertIdentifier(jobRunId, "Job run id");
    const result = await this.#transact<boolean>((state) => {
      const current = state.states.get(jobRunId);
      const occurrence = state.occurrences.get(jobRunId);
      if (!current) throw new Error("Job occurrence is unknown");
      if (
        !occurrence ||
        requireDefinitionRevision(state, occurrence.taskRevision).definition.kind !==
          "user"
      ) {
        throw new Error("Only user job occurrences use queued selection outcomes");
      }
      if (current.state === target) return { kind: "return", value: false };
      if (current.state !== "queued") {
        throw new Error(`Only a queued job can become ${target}`);
      }
      return {
        kind: "append",
        entries: [
          ...prepareJobQueuedTerminal(this.#resources, state, jobRunId, target),
          stateRecord(
            this.#taskId,
            jobRunId,
            target,
            current.statusRevision + 1,
          ),
        ],
        value: true,
      };
    });
    return result.value;
  }

  #acceptCancellation(
    state: JobProjection,
    assigned: AssignedJob,
    proof: CancelProofBody,
    current: JobStateEntry,
  ): ProjectionTransactionDecision<unknown, void> {
    return {
      kind: "append",
      entries: [
        jobRecord(this.#taskId, {
          t: "cancel-proof-accepted",
          assignmentId: assigned.record.assignmentId,
          proof,
        }),
        ...capabilityRevocations(this.#taskId, state, assigned),
        stateRecord(
          this.#taskId,
          assigned.record.jobRunId,
          "cancelled",
          current.statusRevision + 1,
          assigned.record.assignmentId,
        ),
      ],
      value: undefined,
    };
  }

  #acceptNotStarted(
    state: JobProjection,
    assigned: AssignedJob,
    proof: AssignmentTerminationProof,
    current: JobStateEntry,
    open?: JobResolutionFact,
  ): ProjectionTransactionDecision<unknown, void> {
    const targetState = notStartedTargetState(state, current);
    const entries: LogicalRecord<unknown>[] = [
      jobRecord(this.#taskId, {
        t: "assignment-superseded",
        assignmentId: assigned.record.assignmentId,
        proof,
      }),
      ...capabilityRevocations(this.#taskId, state, assigned),
      stateRecord(
        this.#taskId,
        assigned.record.jobRunId,
        targetState,
        current.statusRevision + 1,
        assigned.record.assignmentId,
      ),
    ];
    if (open) {
      if (open.cause === "dispatch-conflict") {
        if ("dispatchDigest" in proof) {
          throw new Error(
            "Dispatch rejection cannot resolve an uncertain dispatch conflict",
          );
        }
        const conflict = state.conflicts.get(assigned.record.assignmentId);
        if (
          !conflict ||
          proof.lastRecordSeq <= conflict.proof.receivedRecordSeq
        ) {
          throw new Error("Conflict containment proof does not follow the received prefix");
        }
        entries.unshift(jobRecord(this.#taskId, {
          t: "dispatch-conflict-contained",
          assignmentId: assigned.record.assignmentId,
          openFactDigest: open.openFactDigest,
          proof: proof as CancelProofBody | Extract<SupersedeProof, { decision: "not-started-fenced" }>,
        }));
      }
      entries.push(jobRecord(this.#taskId, {
        t: "resolution",
        jobRunId: assigned.record.jobRunId,
        fact: closeResolution(
          open,
          notStartedResolutionKind(targetState),
          proof.executorId,
          this.#clock(),
        ),
      }));
    }
    if (open?.cause === "dispatch-conflict") {
      const records = entries
        .filter((entry) => entry.stream === jobStream(this.#taskId))
        .map((entry) => entry.body as JobJournalRecord);
      assertJobConflictContainmentReplayContract({
        proofDecision: "not-started",
        conflictOpen: true,
        hasAtomicSupersedeWithSameProof: records.some(
          (record) =>
            record.t === "assignment-superseded" &&
            record.assignmentId === assigned.record.assignmentId &&
            sameTerminationProofIdentity(record.proof, proof),
        ),
        hasAtomicResolutionClose: records.some(
          (record) =>
            record.t === "resolution" &&
            record.jobRunId === assigned.record.jobRunId &&
            record.fact.openFactDigest === open.openFactDigest &&
            record.fact.resolution !== undefined,
        ),
        hasAtomicTargetState: recordsHaveJobState(
          records,
          assigned.record.jobRunId,
          targetState,
          current.statusRevision + 1,
          assigned.record.assignmentId,
        ),
        allCapabilitiesRevoked: allJobCapabilitiesRevoked(
          records,
          state,
          assigned,
        ),
      });
    }
    return { kind: "append", entries, value: undefined };
  }

  #rejectContradictoryNotStarted(
    state: JobProjection,
    assigned: AssignedJob,
    proof: AssignmentTerminationProof,
    current: JobStateEntry,
  ): ProjectionTransactionDecision<unknown, void> {
    const proofKind = terminationProofKind(proof);
    const key = notStartedRejectionKey(assigned.record.assignmentId, proofKind);
    const existingRejection = state.rejectedNotStarted.get(key);
    if (existingRejection) {
      if (
        canonicalize(withoutSignature(existingRejection.proof)) !==
        canonicalize(withoutSignature(proof))
      ) {
        throw new Error(
          "Assignment already has a different durable termination proof",
        );
      }
      return { kind: "return", value: undefined };
    }
    const entries: LogicalRecord<unknown>[] = [
      jobRecord(this.#taskId, {
        t: "not-started-rejected",
        assignmentId: assigned.record.assignmentId,
        proof,
      }),
    ];
    if (current.state !== "uncertain") {
      const fact = openResolution(
        this.#taskId,
        assigned.record.jobRunId,
        this.#anchorEpoch,
        assigned.record.assignmentId,
        "cause" in proof ? "job-cancel-unknown" : "ledger-unknown",
        this.#clock(),
      );
      entries.push(
        jobRecord(this.#taskId, {
          t: "resolution",
          jobRunId: assigned.record.jobRunId,
          fact,
        }),
        ...capabilityRevocations(this.#taskId, state, assigned),
        stateRecord(
          this.#taskId,
          assigned.record.jobRunId,
          "uncertain",
          current.statusRevision + 1,
          assigned.record.assignmentId,
        ),
      );
    }
    return { kind: "append", entries, value: undefined };
  }

  #authenticateSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    this.#submission.authenticate(context, identity);
    this.#assertSubmissionContextIdentity(context, identity);
  }

  #authorizeSubmission(
    state: JobProjection,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    this.#submission.authorize(context, authorization);
    this.#assertSubmissionContextIdentity(context, authorization);
    if (
      (authorization.mode === "active" || authorization.mode === "settlement") &&
      !this.#hasCurrentSubmissionAuthority(context)
    ) {
      throw new Error("Assignment capability belongs to a stale job authority");
    }
    if (context.principal.kind !== "assignment") return;
    const capability = context.principal.capability;
    const assigned = state.assignedById.get(authorization.assignmentId);
    assertActivatedAssignmentCapability({
      capability,
      activation: assigned
        ? {
            capIds: assigned.record.capIds,
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            authority: {
              execution: "job",
              taskId: this.#taskId,
              anchorEpoch: assigned.record.anchorEpoch,
            },
          }
        : undefined,
      verifier: this.#verifier,
      method: authorization.method,
      resource: `task:${this.#taskId}`,
      mode: authorization.mode,
      revoked: state.revokedCapabilities.has(
        revokedCapabilityKey(authorization.assignmentId, capability.capId),
      ),
      now: this.#clock(),
      deadlineAt: context.deadlineAt,
    });
    if (assigned) {
      assertCapabilityMatchesAssignedEnvelope(capability, assigned.envelope);
    }
  }

  #assertSubmissionContextIdentity(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    if (
      context.principal.kind !== "assignment" ||
      context.principal.capability.assignmentId !== identity.assignmentId ||
      !context.principal.capability.methods.includes(identity.method)
    ) {
      throw new Error("Assignment submission identity does not bind the job call");
    }
  }

  #hasCurrentSubmissionAuthority(context: AuthorityCallContext): boolean {
    if (context.principal.kind !== "assignment") return false;
    const capability = context.principal.capability;
    return (
      capability.scope.execution === "job" &&
      capability.scope.taskId === this.#taskId &&
      "anchorEpoch" in capability &&
      capability.anchorEpoch === this.#anchorEpoch
    );
  }

  #submissionBundleRejection(
    guard: JobSubmissionGuardProjection,
    context: AuthorityCallContext,
    assignmentId: string,
    jobRunId: string,
  ): string | undefined {
    const state = guard.states.get(jobRunId)?.state;
    return !this.#hasCurrentSubmissionAuthority(context)
      ? "Bundle capability belongs to a stale job authority"
      : guard.assignmentByJob.get(jobRunId) !== assignmentId
        ? "Bundle belongs to a historical assignment"
        : guard.openConflictAssignments.has(assignmentId)
          ? "Bundle is blocked by an open dispatch conflict"
          : state !== "dispatched" &&
              state !== "running" &&
              state !== "cancel-requested" &&
              state !== "uncertain"
            ? "Bundle is late for the current job state"
            : undefined;
  }

  #authorizeDefinition(
    context: AuthorityCallContext,
    definition: TaskDefinition,
  ): void {
    this.#ingress.authorize(
      context,
      definition.definition.kind === "system" ? "system-trigger" : "user-trigger",
      definition,
    );
  }

  /**
   * 本作业的工作集会话：两份投影已装入的行与它们对应的持久头位置。头位置没变（期间没有别的写入
   * 触及本作业）就沿用已装入的行，否则换新会话；行数超过上限也换新，常驻工作集有界。
   */
  async #sessionAt(view: import("@zhixing/core/authority").DurableProjectionReadContext): Promise<JobJournalSession> {
    const head = await view.get(jobStateHeadKey(this.#taskId)) as number | undefined;
    const current = this.#session;
    if (current && current.head === head &&
        current.main.loadedRows + current.guard.loadedRows < MAX_JOB_SESSION_ROWS) return current;
    const session: JobJournalSession = { main: this.#loadableSet("main"), guard: this.#loadableSet("guard"), head, cursor: current?.cursor };
    this.#session = session;
    return session;
  }

  /** 一份新的工作集：锁外缺键时经持久投影成批装入。 */
  #loadableSet(kind: "main" | "guard"): JobStateSet {
    const set = kind === "main" ? createJobMainState(this.#taskId) : createJobGuardState(this.#taskId);
    set.bindLoader((needs) => loadJobState(set, needs, this.#index));
    return set;
  }

  /**
   * 在本作业的串行队列之外重做：工作集缺的行装入后重来；持久投影仍在准备时等它完成；
   * 暂时的容量背压在有限窗口内重试。持有别的互斥区时不在这里等待，交给外层所有者重驱。
   */
  async #repeatState<Value>(operation: () => Promise<Value>): Promise<Value> {
    const abort = currentMaintenanceAbortSignal();
    let deadline: number | undefined;
    // 缺键装入的轮数单独计：准备等待与背压重试不占用它
    let loads = 0;
    const loaded: Record<string, number> = {};
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof JobStateRequired && error.prepareOutside) {
          // 装了上限轮仍缺即耗尽：不再交给外层准备循环原样重开
          if (loads >= MAX_JOB_STATE_ROUNDS) throw new JobStateExhausted("rounds", loads + 1, loaded, error.needs);
          loads += 1;
          tallyJobStateNeeds(error.needs, loaded);
          await error.prepareOutside();
          continue;
        }
        if (await awaitAuthorityPreparation(error)) continue;
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || abort.aborted) throw error;
        deadline ??= performance.now() + 5_000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, deadline - performance.now()));
      }
    }
  }

  async #select<Value>(select: (state: JobProjection) => Value, scope?: JobScope): Promise<Value> {
    return this.#repeatState(() => this.#operations.run(async () => {
      const read = () => this.#log.transactDurableProjection<never, Value>(JOB_RUN_STATE_PROJECTION_ID, async (view) => {
        const session = await this.#sessionAt(view);
        if (scope) await preloadJobScope({ main: session.main }, scope, view);
        const binding = new JobStateBinding(session.main);
        // 读取不改动工作集：成功后已装入的行留在会话里，尝试用的复制直接丢弃
        const value = await runWithJobState([[binding, session.main]], view, () => select(jobProjectionView(binding)));
        return { kind: "return", value };
      });
      const result = await (this.#resources ? this.#resources.coordinate(read, { readOnly: true }) : read());
      return result.value;
    }));
  }

  /** 日志当前头部的游标：之后的事务只续读其后的尾部。 */
  async #headCursor(): Promise<ProjectionCursor> {
    const cursor = this.#session?.cursor;
    if (cursor) return cursor;
    return (await this.#log.transactDurableProjection<never, undefined>(
      JOB_RUN_STATE_PROJECTION_ID,
      async () => ({ kind: "return", value: undefined }),
    )).cursor;
  }

  async #transact<Value>(
    decide: (
      state: JobProjection,
      prefix: ProjectionTransactionContext,
    ) => ProjectionTransactionDecision<unknown, Value> | Promise<ProjectionTransactionDecision<unknown, Value>>,
    candidateReferences: readonly ArtifactRef[] = [],
    readProjectionIds: readonly string[] = [],
    scope?: JobScope,
  ) {
    const transaction = await this.#repeatState(() => this.#operations.run(async () => {
      const cursor = await this.#headCursor();
      const binding = new JobStateBinding(createJobMainState(this.#taskId));
      const state = jobProjectionView(binding);
      let session: JobJournalSession | undefined;
      let candidateLsn: number | undefined;
      const transact = () => this.#delivery.coordinate(() =>
        this.#log.transactProjection<JobProjection, unknown, Value>(
          state,
          // 工作集取自同一锁内的持久投影：游标之后的尾部不再重放，只归约本次候选
          (current, record, envelope) => envelope.lsn === candidateLsn ? this.#reduce(current, record, envelope) : current,
          async (_current, context) => {
            const view = context.readProjection(JOB_RUN_STATE_PROJECTION_ID);
            const active = session = await this.#sessionAt(view);
            await preloadJobScope({ main: active.main }, scope ?? jobScopeOf(), view);
            candidateLsn = context.nextLsn;
            return runWithJobState([[binding, active.main]], view, async () => {
              const decision = await decide(state, context);
              if (decision.kind !== "append") return decision;
              const resourceRecords = this.#prepareAssignmentResourceTerminalRecords(
                state,
                decision.entries,
              );
              const policyRecords = await this.#prepareSchedulerPolicyRecords(
                state,
                decision.entries,
                context.at,
              );
              const statuses = jobStatusDeliveryInputs(
                this.#taskId,
                state,
                decision.entries,
                context.at,
              );
              const prepared = this.#delivery.prepareJobStatuses(statuses);
              if (!prepared.accepted) throw corruptJobJournal(prepared.error.message);
              const entries = [
                ...resourceRecords,
                ...decision.entries,
                ...policyRecords,
                ...prepared.records,
              ];
              // 候选归约要读的行在锁内一并装入，免得归约时才缺而整笔事务重来
              const needs = candidateStateNeeds(active.main, entries, this.#taskId);
              if (needs.length) throw new JobStateRequired(needs);
              // 候选会改动连续失败摘要时，它的定位路径也在锁内按层装入
              requireFailureSummaryPaths(state, failureSummaryCandidates(state, jobStreamBodies(entries, this.#taskId)));
              return { ...decision, entries };
            });
          },
          {
            stream: jobStream(this.#taskId),
            cursor,
            candidateReferences,
            readProjectionIds: [...new Set([JOB_RUN_STATE_PROJECTION_ID, ...readProjectionIds])],
            createState: () => {
              candidateLsn = undefined;
              return state;
            },
          },
        ));
      const coordinateSystem = () =>
        this.#systemResources ? this.#systemResources.coordinate(transact) : transact();
      const sameCoordinator =
        this.#resources !== undefined &&
        (this.#resources as unknown) === (this.#systemResources as unknown);
      const transaction = await (
        sameCoordinator
          ? this.#resources!.coordinate(transact)
          : this.#resources
            ? this.#resources.coordinate(coordinateSystem)
            : coordinateSystem()
      );
      if (session && this.#session === session) {
        if (transaction.commit) {
          // 提交后的主投影工作集正是持久归约写下的行：采纳并作为新的基准；守卫另由持久投影更新，换新
          session.main.adopt(binding.store);
          session.main.settle();
          session.guard = this.#loadableSet("guard");
          session.head = transaction.commit.lsn;
        }
        session.cursor = transaction.cursor;
      }
      return transaction;
    }));
    // 提交已持久：通知只读候选归约装入过的行，不再重做事务
    {
      if (transaction.commit) {
        this.#publishStatusNotices(
          jobStatusNoticesForCommit(
            transaction.state,
            transaction.commit,
            this.#taskId,
            this.#anchorEpoch,
          ),
        );
        this.#publishLifecycleEvents(
          jobLifecycleEventsForCommit(
            transaction.state,
            transaction.commit,
            this.#taskId,
            this.#anchorEpoch,
          ),
        );
        await this.#schedulerNotices?.publishNew();
      }
    }
    return transaction;
  }

  #prepareAssignmentResourceTerminalRecords(
    state: JobProjection,
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const bodies = entries
      .filter((entry) => entry.stream === jobStream(this.#taskId))
      .map((entry) => entry.body)
      .filter(isTaggedJobRecord);
    const committed = bodies.find((body) => body.t === "committed");
    const cancelled = bodies.find((body) => body.t === "cancel-proof-accepted");
    const superseded = bodies.find((body) => body.t === "assignment-superseded");
    const closedResolution = bodies.find(
      (body) => body.t === "resolution" && body.fact.resolution !== undefined,
    );
    const failed = bodies.find(
      (body) => body.t === "state" && body.state === "failed" && body.assignmentId !== undefined,
    );
    const assignmentId =
      (committed?.t === "committed" ? committed.assignmentId : undefined) ??
      (cancelled?.t === "cancel-proof-accepted" ? cancelled.assignmentId : undefined) ??
      (superseded?.t === "assignment-superseded" ? superseded.assignmentId : undefined) ??
      (closedResolution?.t === "resolution"
        ? closedResolution.fact.subject.assignmentId
        : undefined) ??
      (failed?.t === "state" ? failed.assignmentId : undefined);
    if (!assignmentId) return [];
    const assigned = state.assignedById.get(assignmentId);
    if (!assigned) throw corruptJobJournal("Resource terminal has no durable assignment");
    if (!requiresFormalResourceCoordination(assigned.envelope.resourceLease)) return [];
    if (!this.#resources) {
      throw corruptJobJournal("Job assignment has no resource coordinator");
    }
    const mode = committed
      ? "settle-release"
      : cancelled?.t === "cancel-proof-accepted"
        ? cancelled.proof.decision === "not-started"
          ? "release"
          : "settle-release"
        : superseded
          ? "release"
          : failed?.t === "state" && failed.usageFinal
            ? "settle-release"
            : "reclaim";
    return this.#resources.prepareTerminal({
      lease: assigned.envelope.resourceLease,
      mode,
    });
  }

  #assertAssignmentUsageFinal(
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): void {
    this.#reduction.assertAssignmentUsageFinal(assigned, usageFinal);
  }

  #publishStatusNotices(notices: readonly JobStatusNotice[]): void {
    for (const notice of notices) {
      for (const listener of this.#statusListeners) {
        void Promise.resolve()
          .then(() => listener(notice))
          .catch(() => undefined);
      }
    }
  }

  readonly #reduce = (
    state: JobProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobProjection> => this.#reduction.reduce(state, raw, envelope);

  async #loadSubmissionGuard(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<JobSubmissionGuardProjection> {
    this.#assertSubmissionContextIdentity(context, identity);
    return this.#repeatState(() => this.#operations.run(async () => {
      const read = () => this.#log.transactDurableProjection<never, JobStateSet>(JOB_RUN_STATE_PROJECTION_ID, async (view) => {
        const session = await this.#sessionAt(view);
        // 提交守卫只按这一派发与它的 run 读取，不重放作业流
        await preloadJobScope({ guard: session.guard }, jobScopeOf({ assignmentId: identity.assignmentId }), view);
        const binding = new JobStateBinding(session.guard);
        // 守卫的使用者会读的行一并在锁内装入：派发、它的 run、提交与冲突、本能力的撤销
        await runWithJobState([[binding, session.guard]], view, () => {
          const guard = jobSubmissionGuardView(binding);
          const assigned = guard.assignedById.get(identity.assignmentId);
          guard.committedByAssignment.has(identity.assignmentId);
          guard.openConflictAssignments.has(identity.assignmentId);
          if (context.principal.kind === "assignment") {
            guard.revokedCapabilities.has(revokedCapabilityKey(identity.assignmentId, context.principal.capability.capId));
          }
          if (!assigned) return;
          guard.occurrences.has(assigned.record.jobRunId);
          guard.states.get(assigned.record.jobRunId);
          guard.assignmentByJob.get(assigned.record.jobRunId);
        });
        return { kind: "return", value: session.guard };
      });
      const transaction = await (
        this.#resources ? this.#resources.coordinate(read, { readOnly: true }) : read()
      );
      // 守卫是只读视图：之后读到未装入的行时抛出待装入，由调用方在锁外装入后重来
      const guard = jobSubmissionGuardView(new JobStateBinding(transaction.value));
      if (context.principal.kind !== "assignment") return guard;
      const capability = context.principal.capability;
      const assigned = guard.assignedById.get(identity.assignmentId);
      await verifyProtocolStep(() => assertActivatedAssignmentCapability({
        capability,
        activation: assigned
          ? {
              capIds: assigned.record.capIds,
              assignmentId: assigned.record.assignmentId,
              executorId: assigned.record.executorId,
              authority: {
                execution: "job",
                taskId: this.#taskId,
                anchorEpoch: assigned.record.anchorEpoch,
              },
            }
          : undefined,
        verifier: this.#verifier,
        method: identity.method,
        resource: `task:${this.#taskId}`,
        mode: "durable-replay",
        revoked: false,
        now: this.#clock(),
        deadlineAt: context.deadlineAt,
      }));
      return guard;
    }));
  }

  #authorizeGuardSubmission(
    state: JobSubmissionGuardProjection,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    this.#submission.authorize(context, authorization);
    this.#assertSubmissionContextIdentity(context, authorization);
    if (
      (authorization.mode === "active" || authorization.mode === "settlement") &&
      !this.#hasCurrentSubmissionAuthority(context)
    ) {
      throw new Error("Assignment capability belongs to a stale job authority");
    }
    if (context.principal.kind !== "assignment") return;
    const capability = context.principal.capability;
    const assigned = state.assignedById.get(authorization.assignmentId);
    assertActivatedAssignmentCapability({
      capability,
      activation: assigned
        ? {
            capIds: assigned.record.capIds,
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            authority: {
              execution: "job",
              taskId: this.#taskId,
              anchorEpoch: assigned.record.anchorEpoch,
            },
          }
        : undefined,
      verifier: this.#verifier,
      method: authorization.method,
      resource: `task:${this.#taskId}`,
      mode: authorization.mode,
      revoked: state.revokedCapabilities.has(
        revokedCapabilityKey(authorization.assignmentId, capability.capId),
      ),
      now: this.#clock(),
      deadlineAt: context.deadlineAt,
    });
  }


  async #prepareSchedulerPolicyRecords(
    state: JobProjection,
    entries: readonly LogicalRecord<unknown>[],
    at: string,
  ): Promise<readonly LogicalRecord<unknown>[]> {
    const definition = state.definition;
    if (!definition || definition.definition.kind !== "user") return [];
    const result: LogicalRecord<unknown>[] = [];
    // 一批里可能有多条失败终态（例如较新的触发让多条排队者过期）：先把它们的定位路径按层一并装入
    requireFailureSummaryPaths(state, failureSummaryCandidates(state, jobStreamBodies(entries, this.#taskId)));
    for (const entry of entries) {
      if (entry.stream !== jobStream(this.#taskId)) continue;
      const body = entry.body as Partial<JobJournalRecord>;
      if (
        body.t !== "state" ||
        (body.state !== "failed" && body.state !== "expired" && body.state !== "committed") ||
        typeof body.jobRunId !== "string" ||
        typeof body.statusRevision !== "number"
      ) {
        continue;
      }
      if (body.state === "committed") {
        const committed = entries.find((item) => item.stream === jobStream(this.#taskId) &&
          (item.body as Partial<JobJournalRecord>).t === "committed" &&
          (item.body as { jobRunId?: string }).jobRunId === body.jobRunId)?.body as
          Extract<JobJournalRecord, { t: "committed" }> | undefined;
        if (!committed) continue; // System jobs have their own terminal state.
        const bundle = validateJobSealedBundle(JSON.parse(Buffer.from(
          await this.#artifacts.get(committed.bundle.ref)).toString("utf8")) as SealedBundle);
        if (bundle.body.outcome.status !== "failed") continue;
      }
      const occurrence = state.occurrences.get(body.jobRunId);
      if (!occurrence) {
        throw corruptJobJournal("Scheduler failure policy has no occurrence");
      }
      let policy: ScheduleFailurePolicyDecision;
      try {
        // 连续失败数 = 这一次 + 完整次序里它之前的连续失败数（由摘要的定位路径合成，不倒扫失败历史）
        policy = scheduleFailurePolicyForCount({
          taskId: this.#taskId,
          jobRunId: occurrence.jobRunId,
          schedule: definition.definition.spec.schedule,
          scheduledFor: occurrence.scheduledFor,
          failureCount: 1 + failuresBefore(state, occurrence),
          threshold: this.#schedulerFailureThreshold,
          decidedAt: at,
        });
      } catch (error) {
        if (error instanceof AuthorityPreparationRequired) throw error;
        if (error instanceof ScheduleRuntimePolicyError) {
          throw corruptJobJournal(error.message);
        }
        throw error;
      }
      result.push(jobRecord(this.#taskId, {
        t: "failure-policy",
        jobRunId: occurrence.jobRunId,
        taskRevision: occurrence.taskRevision,
        statusRevision: body.statusRevision,
        failureCount: policy.failureCount,
        threshold: policy.threshold,
        ...(policy.nextFire ? { nextFire: policy.nextFire } : {}),
        autoDisableRequired: policy.autoDisableRequired,
      }));
    }
    return [...result, ...this.#prepareCapabilityGapClosureRecords(state, entries, at)];
  }

  #prepareCapabilityGapClosureRecords(
    state: JobProjection,
    entries: readonly LogicalRecord<unknown>[],
    at: string,
  ): readonly LogicalRecord<unknown>[] {
    const result: LogicalRecord<unknown>[] = [];
    if (this.#schedulerNotices) {
      const decision = decideScheduleCapabilityGapClosure({
        taskId: this.#taskId,
        events: entries.filter((entry) => entry.stream === jobStream(this.#taskId))
          .flatMap((entry): { kind: "assigned" | "terminal"; jobRunId: string }[] => {
            const body = entry.body as Partial<JobJournalRecord>;
            if (body.t !== "assigned" && body.t !== "state") return [];
            if (typeof body.jobRunId !== "string") return [];
            if (body.t === "assigned") return [{ kind: "assigned", jobRunId: body.jobRunId }];
            if (body.t === "state" && body.state !== undefined && isTerminal(body.state))
              return [{ kind: "terminal", jobRunId: body.jobRunId }];
            return [];
          }),
        gaps: state.capabilityGapByRun, at,
      });
      if (decision) {
        result.push(jobRecord(this.#taskId, {
          t: "capability-gap-closed", jobRunId: decision.jobRunId,
          round: decision.round, noticeId: decision.noticeId,
        }));
        result.push(...this.#schedulerNotices.prepareRecords(decision.notice));
      }
    }
    return result;
  }

  #publishLifecycleEvents(events: readonly JobLifecycleEvent[]): void {
    for (const event of events) {
      for (const listener of this.#lifecycleListeners) {
        void Promise.resolve()
          .then(() => listener(event))
          .catch(() => undefined);
      }
    }
  }
}


/** Explicitly gated same-process transport for user jobs. */
export class InProcessJobDispatcher {
  readonly #enabled: boolean;
  readonly #journal: JobJournal;
  readonly #executor: RunExecutorPort;
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #cancellationSubmission: InProcessJobCancellationSubmission | undefined;
  readonly #bundleSubmission: InProcessJobBundleSubmission | undefined;
  readonly #onDispatchAccepted:
    | ((envelope: JobEnvelope) => void | Promise<void>)
    | undefined;
  readonly #onCancelAccepted:
    | ((assignmentId: string) => void | Promise<void>)
    | undefined;
  readonly #onRecoveryError: ((error: Error) => void) | undefined;
  readonly #cancellationDispatches = new Map<
    string,
    {
      readonly fence: PendingJobFence["fence"];
      readonly task: Promise<boolean>;
    }
  >();
  readonly #cancellationRetry = new Map<
    string,
    { readonly delayMs: number; readonly nextAttemptAt: number }
  >();
  readonly #stoppedCancellationRecovery = new Set<string>();
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #recoveryRunning: Promise<void> | undefined;
  #recoveryStopped = true;

  constructor(options: InProcessJobDispatcherOptions) {
    this.#enabled = options.enabled;
    this.#journal = options.journal;
    this.#executor = options.executor;
    this.#contexts = options.contexts;
    this.#cancellationSubmission = options.cancellationSubmission;
    this.#bundleSubmission = options.bundleSubmission;
    this.#onDispatchAccepted = options.onDispatchAccepted;
    this.#onCancelAccepted = options.onCancelAccepted;
    this.#onRecoveryError = options.onRecoveryError;
  }

  /**
   * Owner 生命周期持有的耐久 outbox 驱动器。每轮都重读 journal；失败只结束
   * 当前尝试，未完成 fence 仍由下一轮用同一身份继续推进。
   */
  startRecoveryLoop(intervalMs = 1_000): void {
    if (!this.#enabled || this.#recoveryRunning || this.#recoveryTimer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new TypeError("Job recovery interval must be a positive integer");
    }
    this.#recoveryStopped = false;
    const run = () => {
      if (this.#recoveryStopped) return;
      const active = this.#recoverDurableOutboxes();
      this.#recoveryRunning = active;
      void active
        .catch((error) =>
          this.#onRecoveryError?.(
            error instanceof Error ? error : new Error(String(error)),
          ),
        )
        .finally(() => {
          if (this.#recoveryRunning === active) {
            this.#recoveryRunning = undefined;
          }
          if (!this.#recoveryStopped) {
            this.#recoveryTimer = setTimeout(() => {
              this.#recoveryTimer = undefined;
              run();
            }, intervalMs);
            this.#recoveryTimer.unref?.();
          }
        });
    };
    run();
  }

  async stopRecoveryLoop(): Promise<void> {
    this.#recoveryStopped = true;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    await this.#recoveryRunning?.catch(() => undefined);
  }

  async #recoverDurableOutboxes(): Promise<void> {
    await this.recoverCancellations();
  }

  async dispatchPending(): Promise<readonly DispatchResult[]> {
    if (!this.#enabled) return [];
    const pending = await this.#journal.pendingDispatches();
    const outcomes: DispatchResult[] = [];
    for (const item of pending) {
      const outcome = await this.#journal.validateExecutorDispatchResult(
        await this.#executor.dispatch(
          item.envelope,
          item.activation,
          this.#dispatchContext(item),
        ),
      );
      outcomes.push(outcome);
      if (outcome.accepted) {
        await this.#journal.acknowledgeDispatch(item.assignmentId);
        await this.#onDispatchAccepted?.(item.envelope);
      } else if (outcome.outcome === "rejected-before-received") {
        await this.#journal.acceptDispatchRejection(outcome);
      } else {
        await this.#journal.recordDispatchConflict(item, outcome);
      }
    }
    return outcomes;
  }

  async recoverStarted(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.dispatchesAwaitingStarted();
    let recovered = 0;
    for (const item of pending) {
      const ledger = await this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          item.assignmentId,
          this.#queryContext(item.assignmentId),
        ),
      );
      if (
        ledger.phase === "started" ||
        ledger.phase === "sealed" ||
        ledger.phase === "acked"
      ) {
        await this.#journal.reconcileStarted(item.assignmentId, ledger);
        recovered += 1;
      }
    }
    return recovered;
  }

  async cancel(input: {
    readonly jobRunId: string;
    readonly requestId: string;
    readonly context: AuthorityCallContext;
  }): Promise<JobCancelResult> {
    const result = await this.#journal.cancel(input);
    if (!this.#enabled || result.state !== "cancel-requested") return result;
    await this.#dispatchCancellation(
      result.assignmentId,
      result.fence,
    );
    return result;
  }

  async recoverCancellations(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingCancellations();
    const now = Date.now();
    const due = pending.filter((item) => {
      if (this.#stoppedCancellationRecovery.has(item.assignmentId)) return false;
      const retry = this.#cancellationRetry.get(item.assignmentId);
      return retry === undefined || retry.nextAttemptAt <= now;
    });
    await Promise.all(
      due.map((item) =>
        this.#dispatchCancellation(item.assignmentId, item.fence),
      ),
    );
    return due.length;
  }

  #dispatchCancellation(
    assignmentId: string,
    fence: PendingJobFence["fence"],
  ): Promise<boolean> {
    const existing = this.#cancellationDispatches.get(assignmentId);
    if (existing) {
      if (canonicalize(existing.fence) !== canonicalize(fence)) {
        throw new Error(
          "Job cancellation retry changed its durable fence identity",
        );
      }
      return existing.task;
    }
    const task = this.#dispatchCancellationOnce(assignmentId, fence)
      .then((completed) => {
        if (completed) {
          this.#cancellationRetry.delete(assignmentId);
          this.#stoppedCancellationRecovery.delete(assignmentId);
        } else {
          this.#deferCancellationRecovery(assignmentId);
        }
        return completed;
      })
      .catch((error) => {
        if (error instanceof TypeError) {
          this.#stoppedCancellationRecovery.add(assignmentId);
        } else {
          this.#deferCancellationRecovery(assignmentId);
        }
        throw error;
      })
      .finally(() => {
        if (this.#cancellationDispatches.get(assignmentId)?.task === task) {
          this.#cancellationDispatches.delete(assignmentId);
        }
      });
    this.#cancellationDispatches.set(assignmentId, { fence, task });
    return task;
  }

  #deferCancellationRecovery(assignmentId: string): void {
    const previous = this.#cancellationRetry.get(assignmentId)?.delayMs ?? 50;
    const delayMs = Math.min(previous * 2, 5_000);
    this.#cancellationRetry.set(assignmentId, {
      delayMs,
      nextAttemptAt: Date.now() + previous,
    });
  }

  async #dispatchCancellationOnce(
    assignmentId: string,
    fence: PendingJobFence["fence"],
  ): Promise<boolean> {
    if (await this.#submitCancellation(assignmentId)) return true;
    await this.#executor.cancel(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.cancel", fence),
    );
    await this.#onCancelAccepted?.(assignmentId);
    if (await this.#submitCancellation(assignmentId)) return true;
    await this.#executor.cancel(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.cancel", fence),
    );
    return this.#submitCancellation(assignmentId);
  }

  async supersede(assignmentId: string, requestId: string): Promise<SupersedeProof> {
    if (!this.#enabled) throw new Error("In-process job dispatch is disabled");
    const fence = await this.#journal.requestSupersede(assignmentId, requestId);
    const proof = await this.#executor.supersede(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.supersede", fence),
    );
    await this.#journal.acceptSupersedeProof(proof);
    return proof;
  }

  async recoverSupersedes(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingSupersedes();
    for (const item of pending) {
      const proof = await this.#executor.supersede(
        item.assignmentId,
        item.fence,
        this.#fenceContext(item.assignmentId, "executor.supersede", item.fence),
      );
      await this.#journal.acceptSupersedeProof(proof);
    }
    return pending.length;
  }

  async recoverAssignments(): Promise<number> {
    if (!this.#enabled) return 0;
    const candidates = await this.#journal.assignmentsAwaitingRecovery();
    let recovered = 0;
    for (const candidate of candidates) {
      const ledger = await this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          candidate.assignmentId,
          this.#queryContext(candidate.assignmentId),
        ),
      );
      if (ledger.phase === "dispatch-rejected") {
        if (candidate.stoppedProofKinds.includes("dispatch-rejection")) {
          // owner 已耐久拒绝该矛盾的 dispatch-rejection 证明：本恢复动作
          // 永久停止，保持 uncertain 与 open fact 待用户裁决或迟到 bundle。
          continue;
        }
        const result = await this.#journal.validateExecutorDispatchResult(
          await this.#executor.dispatch(
            candidate.dispatch.envelope,
            candidate.dispatch.activation,
            this.#dispatchContext(candidate.dispatch),
          ),
        );
        if (result.accepted || result.outcome !== "rejected-before-received") {
          throw new Error("Rejected job dispatch did not replay its terminal proof");
        }
        await this.#journal.acceptDispatchRejection(result);
        recovered += 1;
        continue;
      }
      if (ledger.phase === "failed") {
        if (!ledger.failure) {
          throw new Error("Failed executor job assignment has no durable failure fact");
        }
        await this.#journal.failAssigned(
          candidate.dispatch.envelope.work.jobRunId,
          candidate.assignmentId,
          ledger.failure.usageFinal,
        );
        recovered += 1;
        continue;
      }
      if (ledger.cancelProof) {
        if (
          candidate.stoppedProofKinds.includes(
            terminationProofKind(ledger.cancelProof),
          )
        ) {
          // owner 已耐久拒绝同 kind 的矛盾 not-started 证明（executor 侧
          // 终态证明不可变，账本里的正是被拒证明）：停止重提，其余 kind
          // 的恢复义务与迟到 bundle 路径不受影响。
          continue;
        }
        if (!(await this.#submitCancellation(candidate.assignmentId))) {
          throw new Error("Durable job cancel proof disappeared before submission");
        }
        recovered += 1;
        continue;
      }
      if (ledger.phase === "acked") {
        if (candidate.state === "dispatched") {
          await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
        }
        await this.#journal.observeBundleAcknowledgement(
          candidate.assignmentId,
          ledger,
        );
        recovered += 1;
        continue;
      }
      if (ledger.phase === "sealed") {
        let progressed = false;
        if (candidate.state === "dispatched") {
          await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
          progressed = true;
        }
        const result = await this.#submitSealedBundle(candidate.assignmentId);
        if (result.committed) {
          const acknowledged = await this.#journal.validateExecutorLedgerSnapshot(
            await this.#executor.queryLedger(
              candidate.assignmentId,
              this.#queryContext(candidate.assignmentId),
            ),
          );
          await this.#journal.observeBundleAcknowledgement(
            candidate.assignmentId,
            acknowledged,
          );
          progressed = true;
        }
        if (progressed) recovered += 1;
        continue;
      }
      if (candidate.state === "uncertain" || ledger.lastSeq <= 0) continue;
      const assignmentId = candidate.assignmentId;
      const executor = this.#executor;
      const contexts = this.#contexts;
      const pages = (async function* (): AsyncGenerator<LedgerEvidencePage> {
        let fromSeq = 1;
        while (fromSeq <= ledger.lastSeq) {
          const page = await executor.queryLedger(
            assignmentId,
            contexts.create(assignmentId, "executor.queryLedger", {
              requestId: `ledger:${assignmentId}:${fromSeq}:${Math.min(256, ledger.lastSeq - fromSeq + 1)}`,
              body: {
                range: {
                  fromSeq,
                  limit: Math.min(256, ledger.lastSeq - fromSeq + 1),
                },
              },
            }),
            { fromSeq, limit: Math.min(256, ledger.lastSeq - fromSeq + 1) },
          );
          if (!("entries" in page)) {
            throw new TypeError("Executor returned a snapshot for job evidence query");
          }
          yield page;
          fromSeq = page.toSeq + 1;
        }
      })();
      if (
        await this.#journal.reconcileCancellationEvidence(
          candidate.assignmentId,
          ledger,
          pages,
        )
      ) {
        recovered += 1;
        continue;
      }
      if (ledger.phase === "started" && candidate.state === "dispatched") {
        await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
        recovered += 1;
      }
    }
    return recovered;
  }

  async #submitCancellation(assignmentId: string): Promise<boolean> {
    if (!this.#cancellationSubmission) {
      throw new Error("In-process job cancellation submission is not configured");
    }
    return this.#cancellationSubmission.submitCancellation(assignmentId);
  }

  #dispatchContext(item: PendingJobDispatch): AuthorityCallContext {
    return this.#contexts.create(item.assignmentId, "executor.dispatch", {
      requestId: `dispatch:${item.assignmentId}`,
      body: {
        dispatchDigest: dispatchEnvelopeDigest(item.envelope),
        activationDigest: assignmentActivationDigest(
          withoutSignature(item.activation),
        ),
      },
    });
  }

  #queryContext(
    assignmentId: string,
    range?: { readonly fromSeq: number; readonly limit: number },
  ): AuthorityCallContext {
    return this.#contexts.create(assignmentId, "executor.queryLedger", {
      requestId: range
        ? `ledger:${assignmentId}:${range.fromSeq}:${range.limit}`
        : `ledger:${assignmentId}:snapshot`,
      body: { range: range ?? null },
    });
  }

  #fenceContext(
    assignmentId: string,
    method: "executor.cancel" | "executor.supersede",
    fence: { readonly fenceSeq: number; readonly requestId: string },
  ): AuthorityCallContext {
    return this.#contexts.create(assignmentId, method, {
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
  }

  async #submitSealedBundle(
    assignmentId: string,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  > {
    if (!this.#bundleSubmission) {
      throw new Error("In-process job bundle submission is not configured");
    }
    return this.#bundleSubmission.submitSealedBundle(assignmentId);
  }
}

interface ValidatedJobBundleClosure {
  readonly artifact: ReturnType<typeof sealedBundleArtifact>;
  readonly batch?: import("@zhixing/core/contracts").MutationBatch;
  readonly references: ArtifactRef[];
}

class JobBundleClosureError extends Error {
  constructor(
    readonly code: "invalid" | "missing-base",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JobBundleClosureError";
  }
}


function jobStatusNotice(
  taskId: string,
  anchorEpoch: number,
  jobRunId: string,
  entry: JobStatusHistoryEntry,
): JobStatusNotice | undefined {
  const ref = { execution: "job" as const, taskId, jobRunId, anchorEpoch };
  if (entry.uncertainTransition === "opened") {
    if (entry.state !== "uncertain") {
      throw corruptJobJournal("Job uncertainty opening has a non-uncertain state");
    }
    return {
      v: 1,
      ref,
      state: "uncertain",
      statusRevision: entry.statusRevision,
      actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
    };
  }
  if (entry.uncertainTransition === "closed") {
    if (entry.resultingState !== entry.state) {
      throw corruptJobJournal("Job uncertainty closure has a mismatched successor state");
    }
    return {
      v: 1,
      ref,
      state: "uncertain-closed",
      statusRevision: entry.statusRevision,
      actions: [],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
      closedBy: entry.closedBy,
      resultingState: entry.resultingState,
    } as JobStatusNotice;
  }
  if (entry.state === "committed") return undefined;
  if (entry.state === "uncertain") {
    throw corruptJobJournal("Job uncertainty has no durable open fact identity");
  }
  return {
    v: 1,
    ref,
    state: entry.state,
    statusRevision: entry.statusRevision,
    actions: [],
    at: entry.at,
  };
}

function jobStatusNoticesForCommit(
  state: JobProjection,
  envelope: CommitEnvelope<unknown>,
  taskId: string,
  anchorEpoch: number,
): JobStatusNotice[] {
  const notices: JobStatusNotice[] = [];
  for (const record of envelope.entries) {
    if (record.stream !== jobStream(taskId)) continue;
    const body = record.body as JobJournalRecord;
    const identity =
      body.t === "occurrence"
        ? { jobRunId: body.occ.jobRunId, statusRevision: 1 }
        : body.t === "state"
          ? { jobRunId: body.jobRunId, statusRevision: body.statusRevision }
          : undefined;
    if (!identity) continue;
    const entry = state.statusHistoryByRun
      .get(identity.jobRunId)
      ?.find((candidate) => candidate.statusRevision === identity.statusRevision);
    if (!entry) throw corruptJobJournal("Committed job status has no history projection");
    const notice = jobStatusNotice(
      taskId,
      anchorEpoch,
      identity.jobRunId,
      entry,
    );
    if (notice) notices.push(notice);
  }
  return notices;
}

function jobLifecycleEventsForCommit(
  state: JobProjection,
  envelope: CommitEnvelope<unknown>,
  taskId: string,
  anchorEpoch: number,
): JobLifecycleEvent[] {
  const events: JobLifecycleEvent[] = [];
  const retiredCandidates = new Set<string>();
  const seenStates = new Set<string>();
  for (const record of envelope.entries) {
    if (record.stream !== jobStream(taskId)) continue;
    const body = record.body as JobJournalRecord;
    const identity =
      body.t === "occurrence"
        ? { jobRunId: body.occ.jobRunId, statusRevision: 1 }
        : body.t === "state"
          ? { jobRunId: body.jobRunId, statusRevision: body.statusRevision }
          : undefined;
    if (identity) {
      const key = `${identity.jobRunId}:${identity.statusRevision}`;
      if (!seenStates.has(key)) {
        seenStates.add(key);
        const projected = state.statusHistoryByRun
          .get(identity.jobRunId)
          ?.find((entry) => entry.statusRevision === identity.statusRevision);
        if (!projected) {
          throw corruptJobJournal("Committed job lifecycle state has no projection");
        }
        const assignmentId = assignmentIdFromJobRecord(body);
        events.push({
          kind: "job-state-changed",
          ref: {
            execution: "job",
            taskId,
            jobRunId: identity.jobRunId,
            anchorEpoch,
          },
          state: projected.state,
          statusRevision: projected.statusRevision,
          ...(assignmentId ? { assignmentId } : {}),
          at: envelope.at,
        });
      }
    }
    const assignmentId = assignmentIdFromJobRecord(body);
    if (assignmentId) retiredCandidates.add(assignmentId);
  }
  for (const assignmentId of retiredCandidates) {
    if (
      state.recoveryAssignments.has(assignmentId) ||
      state.bundleAcknowledgementOutbox.has(assignmentId)
    ) {
      continue;
    }
    const assigned = state.assignedById.get(assignmentId);
    if (!assigned) continue;
    events.push({
      kind: "assignment-retired",
      ref: {
        execution: "job",
        taskId,
        jobRunId: assigned.record.jobRunId,
        anchorEpoch,
      },
      assignmentId,
      at: envelope.at,
    });
  }
  return events;
}

function assignmentIdFromJobRecord(
  record: JobJournalRecord,
): string | undefined {
  if (
    "assignmentId" in record &&
    typeof record.assignmentId === "string"
  ) {
    return record.assignmentId;
  }
  return record.t === "resolution"
    ? record.fact.subject.assignmentId
    : undefined;
}

function jobStream(taskId: string): string {
  return `job:${taskId}`;
}

function jobStatusDeliveryInputs(
  taskId: string,
  state: JobProjection,
  entries: readonly LogicalRecord<unknown>[],
  at: string,
): JobStatusDeliveryInput[] {
  const result: JobStatusDeliveryInput[] = [];
  for (const entry of entries) {
    if (entry.stream !== jobStream(taskId)) continue;
    const body = entry.body as Partial<JobJournalRecord>;
    if (
      body.t !== "state" ||
      !("jobRunId" in body) ||
      !("state" in body) ||
      !("statusRevision" in body)
    ) {
      continue;
    }
    const jobRunId = body.jobRunId as string;
    const occurrence = state.occurrences.get(jobRunId) ?? occurrenceInEntries(entries, taskId, jobRunId);
    if (!occurrence) throw corruptJobJournal("Job state has no occurrence for status delivery");
    const definition = state.definitions.get(occurrence.taskRevision);
    if (!definition) throw corruptJobJournal("Job status delivery has no task definition");
    result.push({
      at,
      occurrence,
      definition,
      state: body.state as JobRunState,
      statusRevision: body.statusRevision as number,
    });
  }
  return result;
}

function occurrenceInEntries(
  entries: readonly LogicalRecord<unknown>[],
  taskId: string,
  jobRunId: string,
): JobOccurrence | undefined {
  for (const entry of entries) {
    if (entry.stream !== jobStream(taskId)) continue;
    const body = entry.body as Partial<JobJournalRecord>;
    if (body.t === "occurrence" && "occ" in body) {
      const occurrence = body.occ as JobOccurrence;
      if (occurrence.jobRunId === jobRunId) return occurrence;
    }
  }
  return undefined;
}

function prepareJobQueuedTerminal(
  coordinator: AssignmentResourceCoordinator | SystemJobResourceCoordinator | undefined,
  state: JobProjection,
  jobRunId: string,
  reason: "cancelled" | "failed" | "expired",
): readonly LogicalRecord<GovernorRecord>[] {
  return (coordinator?.prepareQueuedTerminal({
    workload: { kind: "job", id: jobRunId, attempt: nextJobAssignmentAttempt(state, jobRunId) },
    reason,
  }) ?? [queuedTerminalDequeueRecord({
    kind: "job",
    id: jobRunId,
    attempt: nextJobAssignmentAttempt(state, jobRunId),
  }, reason)]) as readonly LogicalRecord<GovernorRecord>[];
}

function nextJobAssignmentAttempt(
  state: {
    readonly assignmentAttemptByRun: Pick<ReadonlyMap<string, number>, "get">;
    readonly systemFences: Pick<ReadonlyMap<string, SystemJobFence>, "get">;
  },
  jobRunId: string,
): number {
  let latest = state.assignmentAttemptByRun.get(jobRunId) ?? 0;
  const systemFence = state.systemFences.get(jobRunId);
  if (systemFence !== undefined) latest = Math.max(latest, systemFence.attempt);
  if (latest >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Job assignment attempt is exhausted");
  }
  return latest + 1;
}

function jobRecord(
  taskId: string,
  body: JobJournalRecord,
): LogicalRecord<JobJournalRecord> {
  assertJobRecordFits(body);
  return { stream: jobStream(taskId), body };
}

function relayAdoptionAtCursor(
  state: JobChannelInteractions,
  assignmentId: string,
  frame: StreamFrame,
  checkpoint: StreamVerifierCheckpoint,
): JobChannelRelayAdoption {
  if (
    frame.payload.kind !== "interaction"
  ) {
    return { checkpoint: structuredClone(checkpoint) };
  }
  const challengeId = state.challengeByInteraction.get(
    `${assignmentId}\u0000${frame.payload.event.requestId}`,
  );
  if (!challengeId) {
    return { checkpoint: structuredClone(checkpoint) };
  }
  const prepared = state.preparedByChallenge.get(challengeId);
  const closed = state.closedByChallenge.get(challengeId);
  const jobPrepared =
    prepared?.ref.execution === "job"
      ? (prepared as JobChannelChallengePreparedRecord)
      : undefined;
  return {
    checkpoint: structuredClone(checkpoint),
    ...(frame.payload.event.t === "requested" && jobPrepared
      ? { prepared: jobPrepared }
      : {}),
    ...(frame.payload.event.t === "finished" && closed ? { closed } : {}),
  };
}

function channelRelayFinishedOutcome(
  outcome: InteractionMirrorEntry["outcome"],
): "allowed" | "denied" | "cancelled" | "expired" {
  switch (outcome.t) {
    case "answered":
      return outcome.decision.allowed ? "allowed" : "denied";
    case "auto-resolved":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
  }
}

function taskRevisionRecord(
  definition: TaskDefinition,
  stored: Stored<TaskDefinition>,
  operation?: {
    readonly operationId: string;
    readonly operationDigest: string;
  },
): Extract<JobJournalRecord, { t: "task-revision" }> {
  return {
    t: "task-revision",
    taskId: definition.taskId,
    taskRevision: definition.taskRevision,
    state: definition.state,
    kind: definition.definition.kind,
    def: stored,
    ...(operation
      ? {
          operationId: operation.operationId,
          operationDigest: operation.operationDigest,
        }
      : {}),
  };
}

interface PreparedJobStored<T> {
  readonly stored: Stored<T>;
  readonly references: readonly ArtifactRef[];
}

async function prepareJobStored<T>(
  value: T,
  containingRecord: (stored: Stored<T>) => JobJournalRecord,
  artifacts: ArtifactStore,
): Promise<PreparedJobStored<T>> {
  const inlineRecord = containingRecord(value);
  if (jobRecordFits(inlineRecord)) {
    return { stored: value, references: [] };
  }
  const bytes = Buffer.from(canonicalize(value), "utf8");
  const ref = await artifacts.put(bytes);
  const stored = { ref };
  assertJobRecordFits(containingRecord(stored));
  return { stored, references: [ref] };
}

async function loadJobStored<T>(
  stored: Stored<T>,
  artifacts: ArtifactStore,
  label: string,
): Promise<T> {
  if (!isStoredJobReference(stored)) {
    return snapshot(stored);
  }
  const text = Buffer.from(await artifacts.get(stored.ref)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} artifact is not valid JSON`,
      { cause: error },
    );
  }
  if (canonicalize(parsed) !== text) {
    throw corruptJobJournal(`${label} artifact is not canonical`);
  }
  return parsed as T;
}

function isStoredJobReference<T>(
  value: Stored<T>,
): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

function jobRecordFits(body: JobJournalRecord): boolean {
  return (
    Buffer.byteLength(canonicalize(body), "utf8") <=
    MAX_INLINE_LOGICAL_RECORD_BYTES
  );
}

function assertJobRecordFits(body: JobJournalRecord): void {
  if (!jobRecordFits(body)) {
    throw new TypeError("Job journal record exceeds the durable record limit");
  }
}

function stateRecord(
  taskId: string,
  jobRunId: string,
  state: JobRunState,
  statusRevision: number,
  assignmentId?: string,
  usageFinal?: { readonly reportDigest: string; readonly upToUsageSeq: number },
): LogicalRecord<JobJournalRecord> {
  return jobRecord(taskId, {
    t: "state",
    jobRunId,
    ...(assignmentId === undefined ? {} : { assignmentId }),
    ...(usageFinal === undefined ? {} : { usageFinal: snapshot(usageFinal) }),
    state,
    statusRevision,
  });
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function createManualJobRunId(input: {
  readonly taskId: string;
  readonly requestId: string;
  readonly scheduledFor: string;
}): string {
  const timestamp = Date.parse(input.scheduledFor);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new TypeError("Manual job timestamp is outside the ULID range");
  }
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  createHash("sha256")
    .update(canonicalize(input))
    .digest()
    .subarray(0, 10)
    .copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `jobrun-${encoded}`;
}

function requireControlIngress(
  context: AtomicControlApplicationContext<JobControlEnvelope>,
): IngressContext {
  if (!context.ingress) {
    throw corruptJobJournal("Manual job control has no durable ingress context");
  }
  return validateIngressContext(context.ingress);
}

function requireDefinition(state: JobProjection): TaskDefinition {
  if (!state.definition) throw corruptJobJournal("Job journal has no task definition");
  return state.definition;
}

function throwTaskDefinitionViolation(
  violation: TaskRevisionReplayViolation,
): never {
  switch (violation) {
    case "different-task":
      throw new TypeError("Task definition belongs to a different job journal");
    case "first-revision":
      throw new Error("First task definition must use revision 1");
    case "deleted-resurrection":
      throw new Error("Deleted task definitions cannot be resurrected");
    case "noncontiguous-revision":
      throw new Error("Task definition revision must advance exactly once");
    case "missing-previous-kind":
    case "kind-change":
      throw new Error("Task definition kind is immutable");
    case "missing-queued-cancellation":
    case "missing-assigned-cancellation":
    case "missing-uncertain-cancellation":
      throw corruptJobJournal("Task revision construction lacks its atomic cancellation");
  }
}

function taskRevisionStopsQueued(definition: TaskDefinition): boolean {
  return definition.state !== "enabled";
}

function taskRevisionStopsAssigned(definition: TaskDefinition): boolean {
  return definition.state === "deleted";
}

function taskRevisionAtomicFacts(input: {
  readonly records: readonly JobJournalRecord[];
  readonly taskRevision: number;
  readonly activeJobRunId: string | undefined;
  readonly active: JobStateEntry | undefined;
  readonly assignmentId: string | undefined;
  readonly cancelFences: Pick<ReadonlyMap<string, unknown>, "has">;
  readonly envelopeLsn: number;
}): {
  readonly hasAtomicQueuedCancellation: boolean;
  readonly hasAtomicAssignedCancellation: boolean;
  readonly hasExistingCancelFence: boolean;
  readonly hasAtomicUncertainFence: boolean;
} {
  const { activeJobRunId, active, assignmentId } = input;
  const hasRevisionFence =
    assignmentId !== undefined &&
    input.records.some(
      (record) =>
        record.t === "cancel-fence" &&
        record.assignmentId === assignmentId &&
        record.fenceSeq === input.envelopeLsn &&
        record.requestId === `task-revision:${input.taskRevision}`,
    );
  return {
    hasAtomicQueuedCancellation:
      activeJobRunId !== undefined &&
      active !== undefined &&
      recordsHaveJobState(
        input.records,
        activeJobRunId,
        "cancelled",
        active.statusRevision + 1,
        undefined,
      ),
    hasAtomicAssignedCancellation:
      activeJobRunId !== undefined &&
      active !== undefined &&
      hasRevisionFence &&
      recordsHaveJobState(
        input.records,
        activeJobRunId,
        "cancel-requested",
        active.statusRevision + 1,
        assignmentId,
      ),
    hasExistingCancelFence:
      assignmentId !== undefined && input.cancelFences.has(assignmentId),
    hasAtomicUncertainFence:
      activeJobRunId !== undefined && active !== undefined && hasRevisionFence,
  };
}

function notStartedTargetState(
  state: JobProjection,
  current: JobStateEntry,
): "queued" | "cancelled" {
  return current.state === "cancel-requested" || state.definition?.state !== "enabled"
    ? "cancelled"
    : "queued";
}

function notStartedResolutionKind(
  target: "queued" | "cancelled",
): "proven-not-started-redispatched" | "proven-not-started-cancelled" {
  return target === "queued"
    ? "proven-not-started-redispatched"
    : "proven-not-started-cancelled";
}

function requireDefinitionRevision(
  state: JobProjection,
  taskRevision: number,
): TaskDefinition {
  const definition = state.definitions.get(taskRevision);
  if (!definition) {
    throw corruptJobJournal("Job occurrence names an unknown task definition revision");
  }
  return definition;
}

function requireReplayAssignment(
  state: JobProjection,
  assignmentId: string,
): AssignedJob {
  const assigned = state.assignedById.get(assignmentId);
  if (!assigned) throw corruptJobJournal("Job record names an unknown assignment");
  return assigned;
}

function requireCurrentAssignment(
  state: JobProjection,
  assignmentId: string,
): AssignedJob {
  const assigned = requireReplayAssignment(state, assignmentId);
  if (state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId) {
    throw new Error("Job operation names a historical assignment");
  }
  return assigned;
}

function deliveryPlan(
  definition: TaskDefinitionBody,
): JobOccurrence["deliveryPlan"] {
  const configured = definition.kind === "user" ? definition.spec.delivery : undefined;
  const delivery = definition.kind === "system"
    ? { kind: "none" as const }
    : configured && configured.kind !== "none"
      ? configured
      : definition.origin
        ? {
            kind: "channel" as const,
            channel: definition.origin.channelId,
            to: definition.origin.to,
            ...(definition.origin.threadId
              ? { threadId: definition.origin.threadId }
              : {}),
          }
        : { kind: "none" as const };
  return {
    delivery: snapshot(delivery),
    planDigest: jobDeliveryPlanDigest(delivery),
  };
}

function assertDispatchMatchesOccurrence(
  envelope: JobEnvelope,
  occurrence: JobOccurrence,
  definition: TaskDefinition,
  anchorEpoch: number,
): void {
  if (definition.definition.kind !== "user") {
    throw corruptJobJournal("System task was materialized as an executor dispatch");
  }
  const expectedFence = createJobCommitFence({
    taskId: occurrence.taskId,
    jobRunId: occurrence.jobRunId,
    scheduledFor: occurrence.scheduledFor,
    taskRevision: occurrence.taskRevision,
    deliveryPlanDigest: occurrence.deliveryPlan.planDigest,
    anchorEpoch,
    assignmentId: envelope.assignmentId,
    executorId: envelope.executorId,
  });
  validateJobCommitFence(envelope.work.fence);
  if (
    envelope.execution !== "job" ||
    envelope.work.t !== "job" ||
    envelope.work.taskId !== occurrence.taskId ||
    envelope.work.jobRunId !== occurrence.jobRunId ||
    canonicalize(envelope.work.fence) !== canonicalize(expectedFence) ||
    canonicalize(envelope.work.instruction) !==
      canonicalize(definition.definition.spec.action)
  ) {
    throw corruptJobJournal("Job dispatch does not bind its frozen occurrence");
  }
}

function assertCapabilityMatchesAssignedEnvelope(
  capability: import("@zhixing/core/contracts").AuthorityCapability,
  envelope: Extract<
    import("@zhixing/core/contracts").DispatchEnvelope,
    { execution: "job" }
  >,
): void {
  const assigned = envelope.capabilities.find(
    (candidate) => candidate.capId === capability.capId,
  );
  if (!assigned || canonicalize(assigned) !== canonicalize(capability)) {
    throw new TypeError(
      "Assignment capability does not match the durable dispatch capability",
    );
  }
}

function jobBundleBindsAssignedOccurrence(
  bundle: JobBundle,
  assigned: AssignedJob,
  occurrence: JobOccurrence,
): boolean {
  return (
    bundle.assignmentId === assigned.record.assignmentId &&
    bundle.executorId === assigned.record.executorId &&
    bundle.body.taskId === assigned.record.taskId &&
    bundle.body.jobRunId === assigned.record.jobRunId &&
    occurrence.taskId === assigned.record.taskId &&
    occurrence.jobRunId === assigned.record.jobRunId &&
    canonicalize(bundle.body.fence) ===
      canonicalize(assigned.envelope.work.fence) &&
    bundle.body.fence.deliveryPlanDigest === occurrence.deliveryPlan.planDigest
  );
}

function materializeDispatch(
  assigned: AssignedJob,
  signer: ProtocolSigner,
): PendingJobDispatch {
  const activation = signJobActivation(
    buildJobActivationPayload({
      envelope: assigned.envelope,
      dispatchRef: assigned.record.dispatchRef,
      commit: {
        lsn: assigned.commit.lsn,
        envelopeDigest: assigned.commit.envelopeDigest,
      },
      issuedAt: assigned.commit.at,
    }),
    signer,
  );
  return {
    assignmentId: assigned.record.assignmentId,
    envelope: snapshot(assigned.envelope),
    activation,
  };
}

function assignedActivationDigest(assigned: {
  readonly record: Extract<JobJournalRecord, { t: "assigned" }>;
  readonly commit: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
}): string {
  return protocolDigest(
    "AssignmentActivationPayload",
    1,
    buildJobActivationPayloadFromBinding({
      binding: {
        jobRunId: assigned.record.jobRunId,
        taskId: assigned.record.taskId,
        anchorEpoch: assigned.record.anchorEpoch,
        assignmentId: assigned.record.assignmentId,
        executorId: assigned.record.executorId,
        dispatchRef: assigned.record.dispatchRef,
        manifestDigest: assigned.record.manifestDigest,
        permissionLeaseDigest: assigned.record.permissionLeaseDigest,
        capIds: assigned.record.capIds,
        reservation: assigned.record.reservation,
      },
      commit: {
        lsn: assigned.commit.lsn,
        envelopeDigest: assigned.commit.envelopeDigest,
      },
      issuedAt: assigned.commit.at,
    }),
  );
}

function capabilityRevocations(
  taskId: string,
  state: JobProjection,
  assigned: AssignedJob,
): LogicalRecord<JobJournalRecord>[] {
  const capabilities = assigned.record.capIds
    .filter(
      (capId) =>
        !state.revokedCapabilities.has(
          revokedCapabilityKey(assigned.record.assignmentId, capId),
        ),
    )
    .map((capId) =>
      jobRecord(taskId, {
        t: "capability-revoked",
        capId,
        assignmentId: assigned.record.assignmentId,
      }),
    );
  const tickets = [
    ...(state.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? []),
  ]
    .filter((ticketId) => !state.revokedTickets.has(ticketId))
    .map((ticketId) =>
      jobRecord(taskId, {
        t: "ticket-revoked" as const,
        ticketId,
      }),
    );
  return [...capabilities, ...tickets];
}

function dataPlaneTicketRevocations(
  taskId: string,
  state: Pick<JobProjection, "ticketIdsByAssignment" | "revokedTickets">,
  assignmentId: string,
): LogicalRecord<JobJournalRecord>[] {
  return [...(state.ticketIdsByAssignment.get(assignmentId) ?? [])]
    .filter((ticketId) => !state.revokedTickets.has(ticketId))
    .map((ticketId) =>
      jobRecord(taskId, {
        t: "ticket-revoked",
        ticketId,
      }),
    );
}

function allJobCapabilitiesRevoked(
  envelopeRecords: readonly JobJournalRecord[],
  state: {
    readonly revokedCapabilities: Pick<ReadonlySet<string>, "has">;
    readonly ticketIdsByAssignment: Pick<ReadonlyMap<string, ReadonlySet<string>>, "get">;
    readonly revokedTickets: Pick<ReadonlySet<string>, "has">;
  },
  assigned: {
    readonly record: {
      readonly assignmentId: string;
      readonly capIds: readonly string[];
    };
  },
): boolean {
  return assigned.record.capIds.every(
    (capId) =>
      state.revokedCapabilities.has(
        revokedCapabilityKey(assigned.record.assignmentId, capId),
      ) ||
      envelopeRecords.some(
        (record) =>
          record.t === "capability-revoked" &&
          record.assignmentId === assigned.record.assignmentId &&
          record.capId === capId,
      ),
  ) && [
    ...(state.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? []),
  ].every(
    (ticketId) =>
      state.revokedTickets.has(ticketId) ||
      envelopeRecords.some(
        (record) =>
          record.t === "ticket-revoked" && record.ticketId === ticketId,
      ),
  );
}

function validateJobTicketIssueRequest(input: DataPlaneTicketIssueRequest): void {
  assertIdentifier(input.ticketId, "Data-plane ticket id");
  assertIdentifier(input.assignmentId, "Data-plane ticket assignment id");
  assertIdentifier(
    input.surfacePrincipal,
    "Data-plane ticket surface principal",
  );
  assertDataPlaneTicketTtlMs(input.ttlMs);
  if (input.replacesTicketId !== undefined) {
    assertIdentifier(input.replacesTicketId, "Replaced data-plane ticket id");
    if (input.replacesTicketId === input.ticketId) {
      throw new TypeError("Ticket renewal requires a new ticket id");
    }
  }
}

async function applyJobTicketRecord(input: {
  readonly state: Pick<
    JobProjection,
    | "ticketsById"
    | "ticketIdsByAssignment"
    | "ticketReplacementsById"
    | "revokedTickets"
    | "ticketSyncFrontier"
    | "ticketExpiry"
  >;
  readonly record: Extract<
    JobJournalRecord,
    { t: "ticket-issued" | "ticket-revoked" }
  >;
  readonly verifier: ProtocolSignatureVerifier;
  readonly envelopeAt: string;
  readonly taskId: string;
  readonly assigned?: Extract<JobJournalRecord, { t: "assigned" }>;
  readonly assignmentIsCurrent: boolean;
  readonly assignmentAcknowledged: boolean;
  readonly assignmentClosed: boolean;
  readonly assignmentActive: boolean;
  readonly originalSurfacePrincipal?: string;
  readonly hasAtomicReplacementRevocation?: boolean;
}): Promise<void> {
  const { state, record } = input;
  if (record.t === "ticket-revoked") {
    assertIdentifier(record.ticketId, "Revoked data-plane ticket id");
    if (!state.ticketsById.has(record.ticketId)) {
      throw corruptJobJournal("Ticket revocation names an unknown ticket");
    }
    if (state.revokedTickets.has(record.ticketId)) {
      throw corruptJobJournal("Ticket is revoked more than once");
    }
    state.revokedTickets.add(record.ticketId);
    return;
  }
  const ticket = validateDataPlaneTicket(record.ticket, input.verifier);
  const assigned = input.assigned;
  const replaced =
    record.replacesTicketId === undefined
      ? undefined
      : state.ticketsById.get(record.replacesTicketId);
  if (
    !assigned ||
    !input.assignmentIsCurrent ||
    !input.assignmentAcknowledged ||
    input.assignmentClosed ||
    !input.assignmentActive ||
    state.ticketsById.has(ticket.ticketId) ||
    ticket.assignmentId !== assigned.assignmentId ||
    ticket.executorId !== assigned.executorId ||
    ticket.issuedAt !== input.envelopeAt ||
    ticket.ref.execution !== "job" ||
    ticket.ref.jobRunId !== assigned.jobRunId ||
    ticket.ref.taskId !== input.taskId ||
    ticket.ref.anchorEpoch !== assigned.anchorEpoch ||
    ticketPrecedesSyncFrontier(ticket, state.ticketSyncFrontier) ||
    (record.replacesTicketId !== undefined &&
      (!replaced ||
        !input.hasAtomicReplacementRevocation ||
        state.revokedTickets.has(record.replacesTicketId) ||
        !replaced.renewable ||
        ticket.kind === "abort" ||
        replaced.assignmentId !== ticket.assignmentId ||
        replaced.surfacePrincipal !== ticket.surfacePrincipal ||
        replaced.kind !== ticket.kind))
  ) {
    throw corruptJobJournal("Issued ticket does not bind an active acknowledged assignment");
  }
  if (
    ticket.kind !== "run-observe" &&
    ticket.surfacePrincipal !== input.originalSurfacePrincipal
  ) {
    throw corruptJobJournal("Interactive ticket does not bind the original surface");
  }
  state.ticketsById.set(ticket.ticketId, ticket);
  if (record.replacesTicketId !== undefined) {
    state.ticketReplacementsById.set(
      ticket.ticketId,
      record.replacesTicketId,
    );
  }
  const byAssignment =
    state.ticketIdsByAssignment.get(ticket.assignmentId) ?? new Set<string>();
  byAssignment.add(ticket.ticketId);
  state.ticketIdsByAssignment.set(ticket.assignmentId, byAssignment);
  state.ticketExpiry.add(dataPlaneTicketSyncBoundary(ticket), ticket.ticketId);
}

function applyJobTicketSyncFrontier(
  state: Pick<JobProjection, "ticketsById" | "ticketSyncFrontier" | "ticketExpiry">,
  expiresThrough: string,
  envelopeAt: string,
): void {
  const passed = ticketsBetween(state, state.ticketSyncFrontier, envelopeAt);
  const expected = nextDataPlaneTicketSyncFrontier(
    passed.map((row) => row.ticket),
    state.ticketSyncFrontier,
    envelopeAt,
  );
  if (expected !== expiresThrough) {
    throw corruptJobJournal("Ticket sync frontier is not the next durable boundary");
  }
  state.ticketSyncFrontier = expiresThrough;
  // 前沿之前的票据不再参与同步：索引行一并删除，在用票据的区间读取不随历史增长
  for (const row of passed) {
    if (row.sortKey <= expiresThrough) state.ticketExpiry.remove(row.sortKey, row.ticket.ticketId);
  }
}

/** 同步边界在 (after, through] 内的票据，按边界升序。 */
function ticketsBetween(
  state: Pick<JobProjection, "ticketsById" | "ticketExpiry">,
  after: string | undefined,
  through: string | undefined,
): { readonly sortKey: string; readonly ticket: DataPlaneTicket }[] {
  return state.ticketExpiry.range({ ...(after ? { after } : {}), ...(through ? { through } : {}) }).map((row) => {
    const ticket = state.ticketsById.get(row.subject);
    if (!ticket) throw corruptJobJournal("Ticket expiry index names an unknown ticket");
    return { sortKey: row.sortKey, ticket };
  });
}

function recordsHaveJobState(
  records: readonly JobJournalRecord[],
  jobRunId: string,
  state: JobRunState,
  statusRevision: number,
  assignmentId: string | undefined,
): boolean {
  return records.some(
    (record) =>
      record.t === "state" &&
      record.jobRunId === jobRunId &&
      record.assignmentId === assignmentId &&
      record.state === state &&
      record.statusRevision === statusRevision,
  );
}

function recordsCloseJobAssignment(
  records: readonly JobJournalRecord[],
  jobRunId: string,
  assignmentId: string,
): boolean {
  return records.some(
    (record) =>
      (record.t === "assignment-superseded" &&
        record.assignmentId === assignmentId) ||
      (record.t === "committed" && record.assignmentId === assignmentId) ||
      (record.t === "state" &&
        record.jobRunId === jobRunId &&
        record.assignmentId === assignmentId &&
        (record.state === "queued" ||
          record.state === "committed" ||
          record.state === "cancelled" ||
          record.state === "failed")),
  );
}

function envelopeHasManualJobRunApplied(
  envelope: CommitEnvelope<unknown>,
  jobRunId: string,
): boolean {
  return envelope.entries.some((entry) => {
    if (
      entry.stream !== "control" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const applied = entry.body as {
      readonly t?: unknown;
      readonly authorityRevision?: unknown;
      readonly result?: unknown;
    };
    if (
      applied.t !== "applied" ||
      applied.authorityRevision !== envelope.lsn ||
      typeof applied.result !== "object" ||
      applied.result === null
    ) {
      return false;
    }
    const result = applied.result as {
      readonly v?: unknown;
      readonly status?: unknown;
      readonly body?: unknown;
    };
    if (
      result.v !== 1 ||
      result.status !== "ok" ||
      typeof result.body !== "object" ||
      result.body === null
    ) {
      return false;
    }
    const body = result.body as { readonly t?: unknown; readonly jobRunId?: unknown };
    return body.t === "job-run" && body.jobRunId === jobRunId;
  });
}

function envelopeHasSuccessfulJobUncertainControl(
  envelope: CommitEnvelope<unknown>,
  state: JobRunState,
  factDigest: string,
): boolean {
  return envelope.entries.some((entry) => {
    if (
      entry.stream !== "control" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const applied = entry.body as {
      readonly t?: unknown;
      readonly authorityRevision?: unknown;
      readonly result?: unknown;
    };
    if (
      applied.t !== "applied" ||
      applied.authorityRevision !== envelope.lsn ||
      typeof applied.result !== "object" ||
      applied.result === null
    ) {
      return false;
    }
    const result = applied.result as {
      readonly v?: unknown;
      readonly status?: unknown;
      readonly body?: unknown;
    };
    if (
      result.v !== 1 ||
      result.status !== "ok" ||
      typeof result.body !== "object" ||
      result.body === null
    ) {
      return false;
    }
    const body = result.body as {
      readonly t?: unknown;
      readonly state?: unknown;
      readonly factDigest?: unknown;
    };
    return (
      body.t === "uncertain-resolve" &&
      body.state === state &&
      body.factDigest === factDigest
    );
  });
}

function revokedCapabilityKey(assignmentId: string, capId: string): string {
  return `${assignmentId}\0${capId}`;
}

function batchRepeatsRequestId(
  batch: InteractionMirrorBatch,
  mirroredRequestIds: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  for (const entry of batch.entries) {
    if (mirroredRequestIds.has(entry.requestId) || seen.has(entry.requestId)) {
      return true;
    }
    seen.add(entry.requestId);
  }
  return false;
}

function openResolution(
  taskId: string,
  jobRunId: string,
  anchorEpoch: number,
  assignmentId: string,
  cause: JobResolutionFact["cause"],
  openedAt: string,
): JobResolutionFact {
  const subject = {
    execution: "job" as const,
    taskId,
    jobRunId,
    anchorEpoch,
    assignmentId,
  };
  return {
    subject,
    openedAt,
    cause,
    openFactDigest: protocolDigest("UncertainOpenFact", 1, {
      subject,
      openedAt,
      cause,
    }),
  };
}

function closeResolution(
  fact: JobResolutionFact,
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
  by: string,
  at: string,
): JobResolutionFact {
  return snapshot({
    ...fact,
    resolution: {
      kind,
      by,
      at,
      factDigest: resolutionFactDigest(fact.openFactDigest, kind, by, at),
    },
  });
}

function terminationProofKind(
  proof: AssignmentTerminationProof | CancelProofBody,
): NotStartedProofKind {
  if ("dispatchDigest" in proof) return "dispatch-rejection";
  if (proof.decision === "not-started-fenced") return "supersede";
  return proof.cause === "owner-fence"
    ? "cancel-owner-fence"
    : "cancel-abort-ticket";
}

function proofBindsJobSource(
  state: Pick<
    JobProjection,
    | "supersedeRequests"
    | "cancelFences"
    | "ticketIdsByAssignment"
    | "ticketsById"
  >,
  assigned: Pick<AssignedJob, "record">,
  proof: AssignmentTerminationProof | CancelProofBody | SupersedeProof,
  anchorEpoch: number,
  legacy: ConversationAbortTicketAuthorizer | undefined,
): boolean {
  const assignmentId = assigned.record.assignmentId;
  const abortTicketProofBindsDurableSource =
    "cause" in proof && proof.cause === "abort-ticket"
      ? abortTicketProofBindsOwnerHistory({
          assignmentId,
          ticketIds:
            state.ticketIdsByAssignment.get(assignmentId) ?? new Set<string>(),
          ticketsById: state.ticketsById,
          proof,
          ...(legacy ? { legacy } : {}),
        })
      : false;
  return terminationProofBindsDurableSource({
    execution: "job",
    proof,
    assignmentId,
    executorId: assigned.record.executorId,
    taskId: assigned.record.taskId,
    anchorEpoch,
    dispatchDigest: assigned.record.dispatchDigest,
    supersedeRequest: state.supersedeRequests.get(assignmentId),
    cancelFence: state.cancelFences.get(assignmentId),
    abortTicketProofBindsDurableSource,
  });
}

function rejected(
  code: AuthorityError["code"],
  message: string,
  retryable: boolean,
): { readonly committed: false; readonly error: AuthorityError } {
  return { committed: false, error: { code, message, retryable } };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 65_536);
  }
  return "System job handler failed";
}

function rejectedControl(
  code: AuthorityError["code"],
  message: string,
): Extract<import("@zhixing/core/contracts").ControlResult, { status: "rejected" }> {
  return {
    v: 1,
    status: "rejected",
    error: { code, message, retryable: false },
  };
}

async function assertArtifactsPresent(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<ArtifactRef[]> {
  const references = collectArtifactRefs(value);
  for (const reference of references) {
    if (!(await artifacts.has(reference))) {
      throw new TypeError(`Dispatch dependency is not present: ${reference.digest}`);
    }
  }
  return references;
}

interface CompiledJobDeliveryContents {
  readonly result?: CompiledDeliveryContent;
  readonly stagedContents: ReadonlyMap<
    number,
    import("@zhixing/core/contracts").DeliveryIntentDto["content"]
  >;
  readonly stagedContentErrors: ReadonlyMap<number, AuthorityError>;
  readonly references: readonly ArtifactRef[];
}

async function compileJobDeliveryContents(
  bundle: JobBundle,
  batch: MutationBatch | undefined,
  artifacts: ArtifactStore,
  deliveryRequired: boolean,
): Promise<CompiledJobDeliveryContents> {
  const result = deliveryRequired
    ? await compileDeliveryContent(bundle.body.outcome.summary, artifacts)
    : undefined;
  const stagedContents = new Map<
    number,
    import("@zhixing/core/contracts").DeliveryIntentDto["content"]
  >();
  const stagedContentErrors = new Map<number, AuthorityError>();
  const references: ArtifactRef[] = [...(result?.references ?? [])];
  for (const record of batch?.records ?? []) {
    if (record.mutation.kind !== "delivery-enqueue") continue;
    try {
      const compiled = await compileDeliveryContent(
        record.mutation.request.content,
        artifacts,
      );
      stagedContents.set(record.seq, compiled.content);
      references.push(...compiled.references);
    } catch (error) {
      if (!(error instanceof DeliveryContentValidationError)) throw error;
      stagedContentErrors.set(record.seq, {
        code: "invalid",
        message: "Delivery content is invalid or unavailable",
        retryable: false,
      });
    }
  }
  return { result, stagedContents, stagedContentErrors, references };
}

async function validateJobBundleClosure(
  bundle: JobBundle,
  artifacts: ArtifactStore,
): Promise<ValidatedJobBundleClosure> {
  const artifact = sealedBundleArtifact(bundle);
  if (!(await artifacts.has(artifact.ref))) {
    throw new JobBundleClosureError(
      "missing-base",
      "Sealed job bundle artifact is not present",
    );
  }
  let closure: Awaited<ReturnType<typeof resolveSealedBundleArtifactClosure>>;
  try {
    closure = await resolveSealedBundleArtifactClosure(bundle, artifacts);
  } catch (error) {
    throw jobBundleClosureReadError(error, "Invalid sealed job bundle closure");
  }

  const references = [artifact.ref, ...closure.transfer];
  let batch: import("@zhixing/core/contracts").MutationBatch | undefined;
  if (bundle.body.mutationBatch) {
    try {
      const bytes = await artifacts.get(bundle.body.mutationBatch.ref);
      const text = Buffer.from(bytes).toString("utf8");
      batch = validateJobMutationBatch(
        JSON.parse(text) as import("@zhixing/core/contracts").MutationBatch,
      );
      const batchArtifact = mutationBatchArtifact(batch);
      if (
        canonicalize(batchArtifact.ref) !==
          canonicalize(bundle.body.mutationBatch.ref) ||
        canonicalize(batch) !== text ||
        bundle.body.mutationBatch.sessionCount !== 0 ||
        bundle.body.mutationBatch.globalCount !== batch.count ||
        batch.assignmentId !== bundle.assignmentId
      ) {
        throw new TypeError("Mutation batch does not bind the job bundle summary");
      }
    } catch (error) {
      throw jobBundleClosureReadError(error, "Invalid job mutation batch");
    }
  }
  return {
    artifact,
    ...(batch ? { batch } : {}),
    references,
  };
}

function jobBundleClosureReadError(
  error: unknown,
  message: string,
): JobBundleClosureError {
  return error instanceof AuthorityStorageError && error.code === "artifact-missing"
    ? new JobBundleClosureError(
        "missing-base",
        `${message}: artifact is not present`,
        { cause: error },
      )
    : new JobBundleClosureError(
        "invalid",
        error instanceof Error ? `${message}: ${error.message}` : message,
        { cause: error },
      );
}

function assertSystemLease(
  lease: SystemJobResourceLease,
  taskId: string,
  jobRunId: string,
  anchorEpoch: number,
  attempt: number,
  verifier: ProtocolSignatureVerifier,
): void {
  validateSystemJobResourceLease(lease, verifier);
  if (
    lease.activation.kind !== "system-job" ||
    lease.activation.jobRunId !== jobRunId ||
    lease.workload.kind !== "job" ||
    lease.workload.id !== jobRunId ||
    lease.workload.attempt !== attempt ||
    lease.scopeBinding.kind !== "job" ||
    lease.scopeBinding.taskId !== taskId ||
    lease.scopeBinding.anchorEpoch !== anchorEpoch ||
    lease.domain.kind !== "anchor" ||
    lease.domain.anchorEpoch !== anchorEpoch
  ) {
    throw new Error("System job lease does not bind its anchor workload");
  }
}

function assertForeignRecords(
  records: readonly LogicalRecord<unknown>[],
  authorityStream: string,
  label = "System resource transition",
): void {
  if (records.length === 0) {
    throw new Error(`${label} must produce durable records`);
  }
  if (records.some((record) => record.stream === authorityStream)) {
    throw new Error(`${label} cannot write the job authority stream`);
  }
}

function isTerminal(state: JobRunState): boolean {
  return isTerminalJobState(state);
}

function isTaggedJobRecord(value: unknown): value is JobJournalRecord {
  return typeof value === "object" && value !== null && "t" in value;
}

function withoutSignature<T extends { signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return payload;
}

function sameTerminationProofIdentity(
  left: AssignmentTerminationProof,
  right: AssignmentTerminationProof,
): boolean {
  return (
    canonicalize(withoutSignature(left)) ===
    canonicalize(withoutSignature(right))
  );
}

function bundleAcknowledgementRecord(
  assignmentId: string,
  committed: Extract<JobJournalRecord, { t: "committed" }>,
): Extract<JobJournalRecord, { t: "bundle-ack-observed" }> {
  return {
    t: "bundle-ack-observed",
    assignmentId,
    bundleRef: committed.bundle.ref,
    jobRevision: committed.jobRevision,
  };
}


function assertLedgerAcknowledgesCommittedBundle(
  ledger: Pick<
    LedgerSnapshot,
    "sealedBundleRef" | "acknowledgedCommitRevision"
  >,
  expected: Extract<JobJournalRecord, { t: "bundle-ack-observed" }>,
): void {
  if (!bundleAcknowledgementBindsCommitted({
    observedBundleRef: ledger.sealedBundleRef,
    observedCommitRevision: ledger.acknowledgedCommitRevision,
    expectedBundleRef: expected.bundleRef,
    expectedCommitRevision: expected.jobRevision,
  })) {
    throw new Error("Bundle acknowledgement does not bind the committed job revision");
  }
}

function assertPositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function assertNever(value: never): never {
  throw corruptJobJournal(`Unknown job journal record: ${canonicalize(value)}`);
}
