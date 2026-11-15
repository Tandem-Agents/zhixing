import type {
  ArtifactStore,
  AuthorityCommitLog,
  DurableProjectionReadContext,
  ProjectionCursor,
  ProjectionTransactionContext,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationProof,
  AuthorityCallContext,
  AuthorityError,
  DataPlaneTicket,
  DispatchEnvelope,
  EnvironmentRequirement,
  IngressContext,
  InteractionAnswerMirrorEntry,
  JobOccurrence,
  JobRunState,
  JobUncertainClosure,
  JsonValue,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  RootResourceWorkload,
  RunExecutorPort,
  SystemHandlerId,
  SystemJobFence,
  SystemJobResourceLease,
  TaskDefinition,
  TrustSedimentMirrorEntry,
  UncertainResolutionFact,
} from "@zhixing-ai/core/contracts";
import type {
  ExecutorCapabilitySnapshot,
  ProtocolSignatureVerifier,
  ProtocolSigner,
  StreamVerifierCheckpoint,
  UnsignedJobEnvelope,
  validateJobSealedBundle,
} from "@zhixing-ai/core/protocol";
import type {
  ScheduleCapabilityGapState,
  ScheduleOccurrence,
} from "@zhixing-ai/core/scheduler/application";
import type {
  ChannelInteractionJournalState,
  ChannelInteractionRelayRecord,
  JobChannelChallengePreparedRecord,
} from "../channel-interaction-records.js";
import type { ConversationAbortTicketAuthorizer } from "../conversation-journal/contracts.js";
import type { JobDeliveryParticipant } from "../delivery-participant.js";
import {
  missingFailureSummaryNodes,
  type FailureSummaryNode,
  type FailureSummaryPosition,
} from "../job-failure-summary.js";
import {
  JOB_JOURNAL_RECORD_SHAPES,
  type JobJournalRecord,
  type JobJournalRecordType,
  type MaterializedSystemJobResult,
  type NotStartedProofKind,
} from "../job-run-contracts.js";
import {
  JobStateBinding,
  JobStateSet,
  KeyedMap,
  KeyedOrder,
  KeyedSet,
  jobStateTaskBase,
  loadJobState,
  type JobStateField,
} from "../job-run-state.js";
import type { AssignmentResourceCoordinator } from "../resource-governor.js";
import type { SchedulerUserNoticeJournal } from "../scheduler-user-notices.js";
import type {
  AssignmentSubmissionAuthorizer,
  InProcessBundleSubmission,
  InProcessDispatchContextFactory,
} from "../shared-protocol/contracts.js";
import type { TrustRuleHitPort } from "../trust-rule-hits.js";

export { JOB_JOURNAL_RECORD_SHAPES };
export type { JobJournalRecord, JobJournalRecordType };

type ChannelTables = Omit<ChannelInteractionJournalState, "domain">;
export type JobChannelInteractions = { readonly domain: "job" } & {
  readonly [Name in keyof ChannelTables]: ChannelTables[Name] extends ReadonlyMap<infer K, infer V>
    ? KeyedMap<K & string, V> : never;
};

export type JobEnvelope = Extract<DispatchEnvelope, { execution: "job" }>;
export type JobBundle = ReturnType<typeof validateJobSealedBundle>;
export type JobResolutionFact = Extract<
  UncertainResolutionFact,
  { subject: { execution: "job" } }
>;

export interface AssignedJob {
  readonly record: Extract<JobJournalRecord, { t: "assigned" }>;
  readonly envelope: JobEnvelope;
  readonly commit: { readonly lsn: number; readonly envelopeDigest: string; readonly at: string };
  acked: boolean;
}

export interface JobStateEntry {
  readonly state: JobRunState;
  readonly statusRevision: number;
}

export type JobStatusHistoryEntry = JobStateEntry & {
  readonly at: string;
} & (
    | { readonly uncertainTransition?: undefined }
    | { readonly uncertainTransition: "opened"; readonly openFactDigest: string }
    | ({ readonly uncertainTransition: "closed"; readonly openFactDigest: string } &
        JobUncertainClosure)
  );

export interface JobSubmissionGuardProjection {
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
        InteractionAnswerMirrorEntry["outcome"]
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
  readonly assignmentAttemptByRun: KeyedMap<string, number>;
  readonly ticketExpiry: KeyedOrder<string>;
  nextJobRevision: number;
}

export interface JobProjection {
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
        InteractionAnswerMirrorEntry["outcome"]
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
  readonly systemResults: KeyedMap<string, MaterializedSystemJobResult>;
  readonly channelInteractions: JobChannelInteractions;
  readonly assignmentAttemptByRun: KeyedMap<string, number>;
  readonly ticketExpiry: KeyedOrder<string>;
  readonly occurrenceOrder: KeyedOrder<string>;
  readonly failureSummaryNodes: KeyedMap<number, FailureSummaryNode>;
  failureSummaryRoot: number | undefined;
  failureSummaryNextNode: number;
  readonly failureFlagByRun: KeyedMap<string, boolean>;
  runCount: number;
  readonly openRuns: KeyedSet<string>;
  readonly openAssignments: KeyedSet<string>;
  readonly pendingSettlements: KeyedSet<string>;
  readonly openChallenges: KeyedSet<string>;
  readonly pendingGrants: KeyedSet<string>;
  readonly pendingAutoDisable: KeyedSet<string>;
  readonly pendingMissed: KeyedSet<string>;
}

export interface JobStateLayout {
  readonly maps: readonly string[];
  readonly sets: readonly string[];
  readonly enumerable: readonly string[];
  readonly orders: readonly string[];
  readonly root: Readonly<Record<string, unknown>>;
}

export const JOB_CHANNEL_FIELDS = {
  preparedByChallenge: "chPrepared",
  challengeByInteraction: "chInteraction",
  deliveredByChallenge: "chDelivered",
  closedByChallenge: "chClosed",
  grantByChallenge: "chGranted",
  cursorByAssignment: "chCursor",
} as const;

export const JOB_MAIN_LAYOUT: JobStateLayout = {
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

export const JOB_GUARD_LAYOUT: JobStateLayout = {
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

export const JOB_MAIN_FIELDS = layoutFields(JOB_MAIN_LAYOUT);
export const JOB_GUARD_FIELDS = layoutFields(JOB_GUARD_LAYOUT);

export function jobMainStatePrefix(taskId: string): string { return `${jobStateTaskBase(taskId)}m/`; }
export function jobGuardStatePrefix(taskId: string): string { return `${jobStateTaskBase(taskId)}g/`; }

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

export function jobProjectionView(binding: JobStateBinding): JobProjection {
  return buildJobView(binding, JOB_MAIN_LAYOUT) as unknown as JobProjection;
}

export function jobSubmissionGuardView(binding: JobStateBinding): JobSubmissionGuardProjection {
  return buildJobView(binding, JOB_GUARD_LAYOUT) as unknown as JobSubmissionGuardProjection;
}

export function jobViewStore(state: { readonly states: KeyedMap<string, unknown> }): JobStateSet {
  return state.states.binding.store;
}

export function occurrenceSortKey(scheduledFor: string): string {
  const at = Date.parse(scheduledFor);
  if (!Number.isFinite(at) || at < 0) throw new TypeError("Occurrence time is invalid");
  return String(8_640_000_000_000_000 - at).padStart(16, "0");
}

const ORDER_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function occurrenceOrderKey(occurrence: Pick<JobOccurrence, "scheduledFor" | "jobRunId">): string {
  let encoded = "";
  for (let index = 0; index < occurrence.jobRunId.length; index += 1) {
    const value = 65535 - occurrence.jobRunId.charCodeAt(index);
    encoded += ORDER_DIGITS[Math.floor(value / 3844)]! + ORDER_DIGITS[Math.floor(value / 62) % 62]! + ORDER_DIGITS[value % 62]!;
  }
  return `${occurrenceSortKey(occurrence.scheduledFor)}${encoded}~`;
}

const SCHEDULE_FAILURE_STATES: ReadonlySet<unknown> = new Set(["failed", "expired", "committed"]);

export function failureSummaryCandidates(
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

export async function preloadFailureSummaryPaths(
  set: JobStateSet,
  bodies: readonly unknown[],
  read: DurableProjectionReadContext,
): Promise<void> {
  if (!set.isLoaded(set.rootKey)) return;
  const view = jobProjectionView(new JobStateBinding(set));
  const positions = failureSummaryCandidates(view, bodies);
  for (;;) {
    const missing = missingFailureSummaryNodes(view, positions);
    if (!missing.length) return;
    await loadJobState(set, missing.map((key) => ({ key })), read);
  }
}

export interface JobSchedulerReadView {
  readonly definition?: TaskDefinition;
  readonly runCount: number;
  readonly consecutiveFailures: number;
  readonly last?: ScheduleOccurrence;
  readonly open: readonly ScheduleOccurrence[];
}

export type JobSubjectKind = "run" | "assignment" | "ticket" | "challenge" | "revision" | "operation";

export const JOB_MAIN_SUBJECTS: Readonly<Record<string, JobSubjectKind>> = {
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

export const JOB_GUARD_SUBJECTS: Readonly<Record<string, JobSubjectKind>> = {
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

export function scopeKeys(set: JobStateSet, subjects: Readonly<Record<string, JobSubjectKind>>, scope: JobScope): string[] {
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

export async function preloadJobScope(
  sets: { readonly main?: JobStateSet; readonly guard?: JobStateSet },
  scope: JobScope,
  read: DurableProjectionReadContext,
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

export interface JobJournalSession {
  main: JobStateSet;
  guard: JobStateSet;
  head: number | undefined;
  cursor: ProjectionCursor | undefined;
}

export const MAX_JOB_SESSION_ROWS = 4096;

export interface PendingJobDispatch {
  readonly assignmentId: string;
  readonly envelope: JobEnvelope;
  readonly activation: AssignmentActivationProof<"job">;
}

export interface PendingJobFence {
  readonly assignmentId: string;
  readonly fence: { readonly fenceSeq: number; readonly requestId: string };
}

export interface JobRecoveryCandidate {
  readonly assignmentId: string;
  readonly state:
    | "dispatched"
    | "running"
    | "cancel-requested"
    | "uncertain"
    | "committed";
  readonly stoppedProofKinds: readonly NotStartedProofKind[];
  readonly dispatch: PendingJobDispatch;
}

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
  readonly params: JsonValue | undefined;
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

export interface JobTrustSedimentPort {
  prepare(input: {
    readonly taskId: string;
    readonly assignmentId: string;
    readonly executorId: string;
    readonly environment: EnvironmentRequirement;
    readonly entry: TrustSedimentMirrorEntry;
    readonly answered: (requestId: string) => Promise<boolean>;
  }): Promise<void>;
  accept(input: {
    readonly taskId: string;
    readonly assignmentId: string;
    readonly entry: TrustSedimentMirrorEntry;
  }): Promise<void>;
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
  readonly trustSediments?: JobTrustSedimentPort;
  readonly trustRuleHits?: TrustRuleHitPort;
}

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

export type JobStateFamilyOwner =
  | "task-schedule-summary"
  | "occurrence-admission-system"
  | "assignment-control-settlement"
  | "commit-publish-channel";

export const JOB_RECORD_FAMILY_OWNERS = {
  "task-revision": "task-schedule-summary",
  "legacy-next-fire": "task-schedule-summary",
  "missed-next-fire": "task-schedule-summary",
  "failure-policy": "task-schedule-summary",
  "auto-disable-settled": "task-schedule-summary",
  "capability-gap-opened": "task-schedule-summary",
  "capability-gap-updated": "task-schedule-summary",
  "capability-gap-closed": "task-schedule-summary",
  occurrence: "occurrence-admission-system",
  "system-miss-coalesced": "occurrence-admission-system",
  admitted: "occurrence-admission-system",
  "system-started": "occurrence-admission-system",
  "system-result": "occurrence-admission-system",
  assigned: "assignment-control-settlement",
  "dispatch-acked": "assignment-control-settlement",
  "dispatch-conflict": "assignment-control-settlement",
  "dispatch-conflict-contained": "assignment-control-settlement",
  "assignment-superseded": "assignment-control-settlement",
  "supersede-requested": "assignment-control-settlement",
  "supersede-started-observed": "assignment-control-settlement",
  "cancel-fence": "assignment-control-settlement",
  "cancel-contained": "assignment-control-settlement",
  "cancel-proof-accepted": "assignment-control-settlement",
  "execution-failure-accepted": "assignment-control-settlement",
  "not-started-rejected": "assignment-control-settlement",
  "capability-revoked": "assignment-control-settlement",
  "interaction-settlement-fence": "assignment-control-settlement",
  "interaction-settlement-completed": "assignment-control-settlement",
  state: "assignment-control-settlement",
  resolution: "assignment-control-settlement",
  "ticket-issued": "commit-publish-channel",
  "ticket-revoked": "commit-publish-channel",
  "ticket-sync-frontier": "commit-publish-channel",
  "interaction-mirror": "commit-publish-channel",
  committed: "commit-publish-channel",
  "bundle-ack-observed": "commit-publish-channel",
  "channel-challenge-prepared": "commit-publish-channel",
  "channel-challenge-delivered": "commit-publish-channel",
  "channel-challenge-closed": "commit-publish-channel",
  "channel-challenge-granted": "commit-publish-channel",
  "channel-relay-cursor": "commit-publish-channel",
} as const satisfies Record<JobJournalRecord["t"], JobStateFamilyOwner>;

export type JobDispatcherExecutorPort = RunExecutorPort;
export type JobDispatcherContexts = InProcessDispatchContextFactory;
