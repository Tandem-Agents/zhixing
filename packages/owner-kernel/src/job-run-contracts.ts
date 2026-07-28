import { AuthorityStorageError } from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentTerminationProof,
  CancelProofBody,
  DataPlaneTicket,
  DispatchConflictProof,
  InteractionMirrorBatch,
  IngressContext,
  JobOccurrence,
  JobRunState,
  SupersedeProof,
  SystemJobFence,
  TaskDefinition,
  UncertainResolutionFact,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  isProtocolIdentifier,
  systemJobParamsDigest,
  validateAssignmentTerminationProof,
  validateCancelProof,
  validateDispatchConflictProof,
  validateDispatchRejectionProof,
  validateDataPlaneTicket,
  validateAssignmentInteractionMirrorBatch,
  validateIngressContext,
  validateJobOccurrence,
  validateSupersedeProof,
  validateSystemJobFence,
  validateTaskDefinition,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import {
  validateResolutionFact,
  type Stored,
} from "./conversation-run-contracts.js";
import {
  validateChannelInteractionRelayRecord,
  type ChannelInteractionRelayRecord,
} from "./channel-interaction-records.js";

export type JobJournalRecord =
  | {
      readonly t: "task-revision";
      readonly taskId: string;
      readonly taskRevision: number;
      readonly state: TaskDefinition["state"];
      readonly kind: TaskDefinition["definition"]["kind"];
      readonly def: Stored<TaskDefinition>;
    }
  | { readonly t: "occurrence"; readonly occ: JobOccurrence }
  | {
      readonly t: "system-miss-coalesced";
      readonly requestedJobRunId: string;
      readonly scheduledFor: string;
      readonly coalescedJobRunId: string;
    }
  | {
      readonly t: "admitted";
      readonly taskId: string;
      readonly jobRunId: string;
      readonly scheduledFor: string;
      readonly ingress?: IngressContext;
    }
  | {
      readonly t: "assigned";
      readonly taskId: string;
      readonly jobRunId: string;
      readonly assignmentId: string;
      readonly executorId: string;
      readonly anchorEpoch: number;
      readonly taskRevision: number;
      readonly deliveryPlanDigest: string;
      readonly dispatchDigest: string;
      readonly manifestDigest: string;
      readonly dispatchRef: ArtifactRef;
      readonly permissionLeaseDigest: string;
      readonly capIds: string[];
      readonly reservation: { readonly reservationId: string; readonly attempt: number };
    }
  | { readonly t: "dispatch-acked"; readonly assignmentId: string }
  | {
      readonly t: "dispatch-conflict";
      readonly assignmentId: string;
      readonly proof: DispatchConflictProof;
      readonly handling: "acked-original" | "opened-uncertain";
    }
  | {
      readonly t: "dispatch-conflict-contained";
      readonly assignmentId: string;
      readonly openFactDigest: string;
      readonly proof:
        | CancelProofBody
        | Extract<SupersedeProof, { decision: "not-started-fenced" }>;
    }
  | {
      readonly t: "assignment-superseded";
      readonly assignmentId: string;
      readonly proof: AssignmentTerminationProof;
    }
  | {
      readonly t: "supersede-requested";
      readonly assignmentId: string;
      readonly fenceSeq: number;
      readonly requestId: string;
    }
  | {
      readonly t: "supersede-started-observed";
      readonly assignmentId: string;
      readonly proof: Extract<SupersedeProof, { decision: "already-started" }>;
    }
  | {
      readonly t: "cancel-fence";
      readonly assignmentId: string;
      readonly fenceSeq: number;
      readonly requestId: string;
    }
  | {
      readonly t: "cancel-contained";
      readonly assignmentId: string;
      readonly openFactDigest: string;
      readonly proof: CancelProofBody;
    }
  | {
      readonly t: "cancel-proof-accepted";
      readonly assignmentId: string;
      readonly proof: CancelProofBody;
    }
  | {
      readonly t: "not-started-rejected";
      readonly assignmentId: string;
      readonly proof: AssignmentTerminationProof;
    }
  | {
      readonly t: "capability-revoked";
      readonly capId: string;
      readonly assignmentId: string;
    }
  | {
      readonly t: "ticket-issued";
      readonly ticket: DataPlaneTicket;
      readonly replacesTicketId?: string;
    }
  | { readonly t: "ticket-revoked"; readonly ticketId: string }
  | { readonly t: "ticket-sync-frontier"; readonly expiresThrough: string }
  | {
      readonly t: "interaction-mirror";
      readonly assignmentId: string;
      readonly batch: InteractionMirrorBatch;
    }
  | {
      readonly t: "state";
      readonly jobRunId: string;
      readonly assignmentId?: string;
      readonly state: JobRunState;
      readonly statusRevision: number;
      readonly usageFinal?: {
        readonly reportDigest: string;
        readonly upToUsageSeq: number;
      };
    }
  | {
      readonly t: "committed";
      readonly jobRunId: string;
      readonly assignmentId: string;
      readonly bundle: Stored<{ readonly ref: ArtifactRef }>;
      readonly jobRevision: number;
    }
  | {
      readonly t: "bundle-ack-observed";
      readonly assignmentId: string;
      readonly bundleRef: ArtifactRef;
      readonly jobRevision: number;
    }
  | {
      readonly t: "resolution";
      readonly jobRunId: string;
      readonly fact: Extract<UncertainResolutionFact, { subject: { execution: "job" } }>;
    }
  | {
      readonly t: "system-started";
      readonly jobRunId: string;
      readonly fence: SystemJobFence;
    }
  | {
      readonly t: "system-result";
      readonly jobRunId: string;
      readonly fence: SystemJobFence;
      readonly outcome: "committed" | "failed";
      readonly detail: Stored<SystemJobResultDetail>;
    }
  | ChannelInteractionRelayRecord;

export type JobJournalRecordType = JobJournalRecord["t"];

interface RecordShape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

export const JOB_JOURNAL_RECORD_SHAPES = {
  "task-revision": {
    required: ["def", "kind", "state", "t", "taskId", "taskRevision"],
  },
  occurrence: { required: ["occ", "t"] },
  "system-miss-coalesced": {
    required: ["coalescedJobRunId", "requestedJobRunId", "scheduledFor", "t"],
  },
  admitted: {
    required: ["jobRunId", "scheduledFor", "t", "taskId"],
    optional: ["ingress"],
  },
  assigned: {
    required: [
      "anchorEpoch",
      "assignmentId",
      "capIds",
      "deliveryPlanDigest",
      "dispatchDigest",
      "dispatchRef",
      "executorId",
      "jobRunId",
      "manifestDigest",
      "permissionLeaseDigest",
      "reservation",
      "t",
      "taskId",
      "taskRevision",
    ],
  },
  "dispatch-acked": { required: ["assignmentId", "t"] },
  "dispatch-conflict": {
    required: ["assignmentId", "handling", "proof", "t"],
  },
  "dispatch-conflict-contained": {
    required: ["assignmentId", "openFactDigest", "proof", "t"],
  },
  "assignment-superseded": { required: ["assignmentId", "proof", "t"] },
  "supersede-requested": {
    required: ["assignmentId", "fenceSeq", "requestId", "t"],
  },
  "supersede-started-observed": {
    required: ["assignmentId", "proof", "t"],
  },
  "cancel-fence": {
    required: ["assignmentId", "fenceSeq", "requestId", "t"],
  },
  "cancel-contained": {
    required: ["assignmentId", "openFactDigest", "proof", "t"],
  },
  "cancel-proof-accepted": { required: ["assignmentId", "proof", "t"] },
  "not-started-rejected": { required: ["assignmentId", "proof", "t"] },
  "capability-revoked": { required: ["assignmentId", "capId", "t"] },
  "ticket-issued": {
    required: ["t", "ticket"],
    optional: ["replacesTicketId"],
  },
  "ticket-revoked": { required: ["t", "ticketId"] },
  "ticket-sync-frontier": { required: ["expiresThrough", "t"] },
  "interaction-mirror": { required: ["assignmentId", "batch", "t"] },
  "channel-challenge-prepared": {
    required: [
      "assignmentId",
      "display",
      "frameSeq",
      "ref",
      "responder",
      "t",
      "token",
      "toolName",
    ],
  },
  "channel-challenge-delivered": {
    required: ["challengeId", "receipt", "t"],
  },
  "channel-challenge-closed": {
    required: ["at", "challengeId", "outcome", "t"],
  },
  "channel-relay-cursor": {
    required: ["assignmentId", "checkpoint", "jobRunId", "t", "upToSeq"],
  },
  "channel-challenge-granted": {
    required: ["challengeId", "grant", "jobRunId", "t"],
  },
  state: {
    required: ["jobRunId", "state", "statusRevision", "t"],
    optional: ["assignmentId", "usageFinal"],
  },
  committed: {
    required: ["assignmentId", "bundle", "jobRevision", "jobRunId", "t"],
  },
  "bundle-ack-observed": {
    required: ["assignmentId", "bundleRef", "jobRevision", "t"],
  },
  resolution: { required: ["fact", "jobRunId", "t"] },
  "system-started": { required: ["fence", "jobRunId", "t"] },
  "system-result": {
    required: ["detail", "fence", "jobRunId", "outcome", "t"],
  },
} as const satisfies Record<JobJournalRecordType, RecordShape>;

export interface SystemJobResultDetail {
  readonly summary?: string;
  readonly error?: string;
}

export interface MaterializedSystemJobResult {
  readonly t: "system-result";
  readonly jobRunId: string;
  readonly fence: SystemJobFence;
  readonly outcome: "committed" | "failed";
  readonly summary?: string;
  readonly error?: string;
}

const JOB_STATES = new Set<JobRunState>([
  "queued",
  "dispatched",
  "running",
  "cancel-requested",
  "committed",
  "cancelled",
  "failed",
  "expired",
  "missed",
  "uncertain",
]);

export function validateJobJournalRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): JobJournalRecord {
  assertRecord(value, "Job journal record");
  if (typeof value.t !== "string" || !(value.t in JOB_JOURNAL_RECORD_SHAPES)) {
    throw corruptJobJournal("Job record type is invalid");
  }
  const type = value.t as JobJournalRecordType;
  const shape: RecordShape = JOB_JOURNAL_RECORD_SHAPES[type];
  assertKeys(
    value,
    [...shape.required, ...(shape.optional ?? [])],
    `${type} job record`,
    shape.optional ?? [],
  );
  switch (type) {
    case "task-revision":
      assertIdentifier(value.taskId, "Task revision taskId");
      assertPositive(value.taskRevision, "Task revision number");
      if (value.state !== "enabled" && value.state !== "disabled" && value.state !== "deleted") {
        throw corruptJobJournal("Task revision state is invalid");
      }
      if (value.kind !== "user" && value.kind !== "system") {
        throw corruptJobJournal("Task revision kind is invalid");
      }
      if (isStoredReference(value.def)) {
        assertArtifactRef(value.def.ref, "Task definition ref");
      } else {
        const definition = validateTaskDefinition(value.def as TaskDefinition);
        if (
          definition.taskId !== value.taskId ||
          definition.taskRevision !== value.taskRevision ||
          definition.state !== value.state ||
          definition.definition.kind !== value.kind
        ) {
          throw corruptJobJournal("Task revision binding differs from its definition");
        }
      }
      break;
    case "occurrence":
      validateJobOccurrence(value.occ as JobOccurrence);
      break;
    case "system-miss-coalesced":
      assertIdentifier(value.requestedJobRunId, "Requested system jobRunId");
      assertIdentifier(value.coalescedJobRunId, "Coalesced system jobRunId");
      assertTime(value.scheduledFor, "Coalesced system job scheduledFor");
      break;
    case "admitted":
      assertIdentifier(value.taskId, "Admission taskId");
      assertIdentifier(value.jobRunId, "Admission jobRunId");
      assertTime(value.scheduledFor, "Admission scheduledFor");
      if (value.ingress !== undefined) validateIngressContext(value.ingress);
      break;
    case "assigned":
      for (const key of ["taskId", "jobRunId", "assignmentId", "executorId"] as const) {
        assertIdentifier(value[key], `Assignment ${key}`);
      }
      for (const key of [
        "deliveryPlanDigest",
        "dispatchDigest",
        "manifestDigest",
        "permissionLeaseDigest",
      ] as const) {
        assertDigest(value[key], `Assignment ${key}`);
      }
      assertPositive(value.anchorEpoch, "Assignment anchorEpoch");
      assertPositive(value.taskRevision, "Assignment taskRevision");
      assertArtifactRef(value.dispatchRef, "Assignment dispatchRef");
      assertIdentifiers(value.capIds, "Assignment capability ids", true);
      assertRecord(value.reservation, "Assignment reservation");
      assertKeys(value.reservation, ["attempt", "reservationId"], "Assignment reservation");
      assertIdentifier(value.reservation.reservationId, "Assignment reservationId");
      assertPositive(value.reservation.attempt, "Assignment attempt");
      break;
    case "ticket-issued":
      validateDataPlaneTicket(value.ticket, verifier);
      if (value.replacesTicketId !== undefined) {
        assertIdentifier(value.replacesTicketId, "Replaced ticket id");
      }
      break;
    case "ticket-revoked":
      assertIdentifier(value.ticketId, "Revoked ticket id");
      break;
    case "ticket-sync-frontier":
      assertTime(value.expiresThrough, "Ticket sync frontier");
      break;
    case "dispatch-acked":
      assertIdentifier(value.assignmentId, "Dispatch acknowledgement assignmentId");
      break;
    case "dispatch-conflict":
      assertIdentifier(value.assignmentId, "Dispatch conflict assignmentId");
      if (value.handling !== "acked-original" && value.handling !== "opened-uncertain") {
        throw corruptJobJournal("Dispatch conflict handling is invalid");
      }
      validateDispatchConflictProof(value.proof as DispatchConflictProof, verifier);
      break;
    case "dispatch-conflict-contained":
      assertIdentifier(value.assignmentId, "Conflict containment assignmentId");
      assertDigest(value.openFactDigest, "Conflict containment fact digest");
      validateConflictContainmentProof(value.proof, verifier);
      break;
    case "assignment-superseded":
    case "not-started-rejected":
      assertIdentifier(value.assignmentId, "Assignment termination assignmentId");
      validateAssignmentTerminationProof(value.proof as AssignmentTerminationProof, verifier);
      break;
    case "supersede-requested":
    case "cancel-fence":
      assertIdentifier(value.assignmentId, "Assignment fence assignmentId");
      assertIdentifier(value.requestId, "Assignment fence requestId");
      assertPositive(value.fenceSeq, "Assignment fence sequence");
      break;
    case "supersede-started-observed":
      assertIdentifier(value.assignmentId, "Supersede observation assignmentId");
      if (validateSupersedeProof(value.proof as SupersedeProof, verifier).decision !== "already-started") {
        throw corruptJobJournal("Supersede observation must prove already-started");
      }
      break;
    case "cancel-contained":
    case "cancel-proof-accepted":
      assertIdentifier(value.assignmentId, "Cancel proof assignmentId");
      if (value.t === "cancel-contained") {
        assertDigest(value.openFactDigest, "Cancel containment fact digest");
      }
      validateCancelProof(value.proof as CancelProofBody, verifier);
      break;
    case "capability-revoked":
      assertIdentifier(value.assignmentId, "Capability revocation assignmentId");
      assertIdentifier(value.capId, "Capability revocation capId");
      break;
    case "interaction-mirror":
      assertIdentifier(value.assignmentId, "Job interaction mirror assignmentId");
      validateAssignmentInteractionMirrorBatch(value.batch, verifier);
      break;
    case "channel-challenge-prepared":
    case "channel-challenge-delivered":
    case "channel-challenge-closed":
    case "channel-relay-cursor":
    case "channel-challenge-granted":
      validateChannelInteractionRelayRecord(value, verifier);
      break;
    case "state":
      assertIdentifier(value.jobRunId, "Job state jobRunId");
      if (value.assignmentId !== undefined) assertIdentifier(value.assignmentId, "Job state assignmentId");
      if (!JOB_STATES.has(value.state as JobRunState)) throw corruptJobJournal("Job state is invalid");
      assertPositive(value.statusRevision, "Job status revision");
      if (value.usageFinal !== undefined) {
        if (value.state !== "failed" || value.assignmentId === undefined) {
          throw corruptJobJournal("Only assigned failed job state may carry final usage");
        }
        assertRecord(value.usageFinal, "Job failure final usage");
        assertKeys(
          value.usageFinal,
          ["reportDigest", "upToUsageSeq"],
          "Job failure final usage",
        );
        assertDigest(
          value.usageFinal.reportDigest,
          "Job failure final usage report digest",
        );
        if (
          !Number.isSafeInteger(value.usageFinal.upToUsageSeq) ||
          (value.usageFinal.upToUsageSeq as number) < 0
        ) {
          throw corruptJobJournal("Job failure final usage sequence is invalid");
        }
      }
      break;
    case "committed":
      assertIdentifier(value.assignmentId, "Job commit assignmentId");
      assertIdentifier(value.jobRunId, "Job commit jobRunId");
      assertPositive(value.jobRevision, "Job revision");
      assertRecord(value.bundle, "Job commit bundle reference");
      assertKeys(value.bundle, ["ref"], "Job commit bundle reference");
      assertArtifactRef(value.bundle.ref, "Job commit bundle ref");
      break;
    case "bundle-ack-observed":
      assertIdentifier(value.assignmentId, "Job bundle acknowledgement assignmentId");
      assertArtifactRef(value.bundleRef, "Job bundle acknowledgement ref");
      assertPositive(value.jobRevision, "Job bundle acknowledgement revision");
      break;
    case "resolution": {
      assertIdentifier(value.jobRunId, "Job resolution jobRunId");
      const fact = validateResolutionFact(value.fact);
      if (fact.subject.execution !== "job" || fact.subject.jobRunId !== value.jobRunId) {
        throw corruptJobJournal("Job resolution subject is inconsistent");
      }
      break;
    }
    case "system-started":
      assertIdentifier(value.jobRunId, "System job start jobRunId");
      if (validateSystemJobFence(value.fence as SystemJobFence).jobRunId !== value.jobRunId) {
        throw corruptJobJournal("System job fence names a different occurrence");
      }
      break;
    case "system-result":
      assertIdentifier(value.jobRunId, "System job result jobRunId");
      if (validateSystemJobFence(value.fence as SystemJobFence).jobRunId !== value.jobRunId) {
        throw corruptJobJournal("System job result fence names a different occurrence");
      }
      if (value.outcome !== "committed" && value.outcome !== "failed") {
        throw corruptJobJournal("System job result outcome is invalid");
      }
      if (isStoredReference(value.detail)) {
        assertArtifactRef(value.detail.ref, "System job result detail ref");
      } else {
        validateSystemJobResultDetail(
          value.detail as SystemJobResultDetail,
          value.outcome as "committed" | "failed",
        );
      }
      break;
    default:
      throw corruptJobJournal(`Unsupported job record type: ${value.t}`);
  }
  return value as unknown as JobJournalRecord;
}

export function validateSystemJobSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  assertBoundedText(value, "System job summary");
  return value;
}

export function validateSystemJobResultDetail(
  value: unknown,
  outcome: "committed" | "failed",
): SystemJobResultDetail {
  assertRecord(value, "System job result detail");
  assertKeys(value, ["error", "summary"], "System job result detail", ["error", "summary"]);
  const summary = validateSystemJobSummary(value.summary);
  if (value.error !== undefined) assertBoundedText(value.error, "System job error");
  if (outcome === "committed" && value.error !== undefined) {
    throw corruptJobJournal("Committed system job result cannot contain an error");
  }
  if (outcome === "failed" && value.error === undefined) {
    throw corruptJobJournal("Failed system job result must contain an error");
  }
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(value.error === undefined ? {} : { error: value.error as string }),
  };
}

function validateConflictContainmentProof(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): void {
  assertRecord(value, "Assignment termination proof");
  if ("dispatchDigest" in value) {
    validateDispatchRejectionProof(
      value as unknown as import("@zhixing/core/contracts").DispatchRejectionProof,
      verifier,
    );
    throw corruptJobJournal(
      "Dispatch rejection proof cannot contain an uncertain dispatch conflict",
    );
  }
  if (value.decision === "not-started-fenced" || value.decision === "already-started") {
    const proof = validateSupersedeProof(value as unknown as SupersedeProof, verifier);
    if (proof.decision !== "not-started-fenced") {
      throw corruptJobJournal(
        "Already-started proof cannot contain an uncertain dispatch conflict",
      );
    }
    return;
  }
  validateCancelProof(value as unknown as CancelProofBody, verifier);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corruptJobJournal(`${label} must be an object`);
  }
}

function isStoredReference(value: unknown): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (optional.length > 0) {
    if (keys.some((key) => !expected.includes(key))) {
      throw corruptJobJournal(`${label} contains an unknown field`);
    }
    const required = expected.filter((key) => !optional.includes(key));
    if (required.some((key) => !keys.includes(key))) {
      throw corruptJobJournal(`${label} is incomplete`);
    }
  } else if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw corruptJobJournal(`${label} fields are incomplete or unknown`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (!isProtocolIdentifier(value)) {
    throw corruptJobJournal(`${label} must be a non-empty bounded string`);
  }
}

function assertIdentifiers(value: unknown, label: string, sorted: boolean): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw corruptJobJournal(`${label} must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    assertIdentifier(value[index], label);
    if (seen.has(value[index])) throw corruptJobJournal(`${label} contains duplicates`);
    if (sorted && index > 0 && value[index - 1] >= value[index]) {
      throw corruptJobJournal(`${label} must be sorted`);
    }
    seen.add(value[index]);
  }
}

function assertPositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw corruptJobJournal(`${label} must be a positive safe integer`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw corruptJobJournal(`${label} must be a sha256 digest`);
  }
}

function assertTime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw corruptJobJournal(`${label} must be a canonical ISO timestamp`);
  }
}

function assertBoundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 65_536) {
    throw corruptJobJournal(`${label} must be a bounded string`);
  }
}

function assertArtifactRef(value: unknown, label: string): asserts value is ArtifactRef {
  assertRecord(value, label);
  assertKeys(value, ["bytes", "digest"], label);
  assertDigest(value.digest, `${label} digest`);
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) {
    throw corruptJobJournal(`${label} bytes must be a non-negative safe integer`);
  }
}

export function corruptJobJournal(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

// --- Job replay predicates shared by the full reducer and the submission guard ---
// Structure-identical contracts (acknowledgement, conflict, supersede, cancel
// acceptance, resolution open/close, committed, capability revocation) are
// reused from ./conversation-run-contracts.js; the predicates below carry the
// genuinely job-specific semantics (job transition table, system branches and
// the conflict cancel fence that lands after its uncertain state record).

const JOB_TRANSITIONS: Readonly<Record<JobRunState, ReadonlySet<JobRunState>>> = {
  queued: new Set(["dispatched", "running", "cancelled", "failed", "expired"]),
  dispatched: new Set([
    "running",
    "queued",
    "cancel-requested",
    "committed",
    "cancelled",
    "uncertain",
  ]),
  running: new Set([
    "cancel-requested",
    "committed",
    "cancelled",
    "failed",
    "uncertain",
  ]),
  "cancel-requested": new Set(["cancelled", "committed", "uncertain"]),
  uncertain: new Set(["queued", "committed", "cancelled", "failed"]),
  committed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  expired: new Set(),
  missed: new Set(),
};

export function isValidJobTransition(
  previous: JobRunState,
  next: JobRunState,
): boolean {
  return JOB_TRANSITIONS[previous].has(next);
}

// 矛盾 not-started 证明的四类来源；owner 以 (assignmentId, proofKind) 耐久
// 拒绝后，同 kind 的恢复动作永久停止、其余 kind 的恢复义务不受影响。
export type NotStartedProofKind =
  | "cancel-owner-fence"
  | "cancel-abort-ticket"
  | "supersede"
  | "dispatch-rejection";

export const NOT_STARTED_PROOF_KINDS: readonly NotStartedProofKind[] = [
  "cancel-owner-fence",
  "cancel-abort-ticket",
  "supersede",
  "dispatch-rejection",
];

/**
 * 停止锚键合同：not-started-rejected 投影与全部恢复消费链（cancel outbox、
 * supersede outbox、dispatch-rejected 重放、账本 cancel-proof 重提）共用
 * 同一键构造，"该恢复动作是否被对应 proofKind 停止"即对本键的存在性判定。
 */
export function notStartedRejectionKey(
  assignmentId: string,
  kind: NotStartedProofKind,
): string {
  return `${assignmentId}:${kind}`;
}

// user 域携 assignment 的合法状态边（按域封闭，比两域转移超集更窄）：
// 携 assignment 的 user 状态记录只能落在这些边上；user 无 assignment 的合法边
// 仅为 queued→cancelled/failed/expired，system 域三类边由 system 分支单独封闭。
const USER_ASSIGNED_TRANSITIONS: Readonly<
  Record<JobRunState, ReadonlySet<JobRunState>>
> = {
  queued: new Set(["dispatched"]),
  dispatched: new Set([
    "running",
    "cancel-requested",
    "committed",
    "uncertain",
    "queued",
    "cancelled",
  ]),
  running: new Set(["cancel-requested", "committed", "cancelled", "uncertain"]),
  "cancel-requested": new Set(["cancelled", "committed", "uncertain"]),
  uncertain: new Set(["queued", "committed", "cancelled", "failed"]),
  committed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  expired: new Set(),
  missed: new Set(),
};

export function isTerminalJobState(state: JobRunState): boolean {
  return (
    state === "committed" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "expired" ||
    state === "missed"
  );
}

export type TaskRevisionReplayViolation =
  | "different-task"
  | "first-revision"
  | "deleted-resurrection"
  | "noncontiguous-revision"
  | "missing-previous-kind"
  | "kind-change"
  | "missing-queued-cancellation"
  | "missing-assigned-cancellation"
  | "missing-uncertain-cancellation";

/**
 * Compact task-revision contract shared by online construction, full replay
 * and the zero-ArtifactStore submission guard. Definition-sidecar binding and
 * immutable creation provenance are layered on by the two callers that have
 * the materialized definition.
 */
export function taskRevisionReplayViolation(input: {
  readonly taskIdMatches: boolean;
  readonly taskRevision: number;
  readonly state: TaskDefinition["state"];
  readonly kind: TaskDefinition["definition"]["kind"];
  readonly previousRevision: number | undefined;
  readonly previousState: TaskDefinition["state"] | undefined;
  readonly previousKind: TaskDefinition["definition"]["kind"] | undefined;
  readonly activeState: JobRunState | undefined;
  readonly hasAtomicQueuedCancellation: boolean;
  readonly hasAtomicAssignedCancellation: boolean;
  readonly hasExistingCancelFence: boolean;
  readonly hasAtomicUncertainFence: boolean;
}): TaskRevisionReplayViolation | undefined {
  if (!input.taskIdMatches) return "different-task";
  if (input.previousRevision === undefined) {
    if (input.taskRevision !== 1) return "first-revision";
  } else {
    if (input.previousState === "deleted") return "deleted-resurrection";
    if (input.taskRevision !== input.previousRevision + 1) {
      return "noncontiguous-revision";
    }
    if (input.previousKind === undefined) return "missing-previous-kind";
    if (input.kind !== input.previousKind) return "kind-change";
  }
  if (
    input.state !== "enabled" &&
    input.activeState === "queued" &&
    !input.hasAtomicQueuedCancellation
  ) {
    return "missing-queued-cancellation";
  }
  if (
    input.state === "deleted" &&
    (input.activeState === "dispatched" || input.activeState === "running") &&
    !input.hasAtomicAssignedCancellation
  ) {
    return "missing-assigned-cancellation";
  }
  if (
    input.state === "deleted" &&
    input.activeState === "uncertain" &&
    !input.hasExistingCancelFence &&
    !input.hasAtomicUncertainFence
  ) {
    return "missing-uncertain-cancellation";
  }
  return undefined;
}

export function assertTaskRevisionReplayContract(input: Parameters<
  typeof taskRevisionReplayViolation
>[0]): void {
  const violation = taskRevisionReplayViolation(input);
  if (violation !== undefined) {
    throw corruptJobJournal(`Task revision replay contract failed: ${violation}`);
  }
}

/** Creation identity is immutable even when the editable user task changes. */
export function taskCreationProvenanceMatches(
  current: TaskDefinition,
  candidate: TaskDefinition,
): boolean {
  if (
    current.definition.kind !== "user" ||
    candidate.definition.kind !== "user"
  ) {
    return true;
  }
  return canonicalize({
    origin: current.definition.origin ?? null,
    interactionResponder: current.definition.interactionResponder ?? null,
    createdInTurn: current.definition.createdInTurn ?? null,
  }) === canonicalize({
    origin: candidate.definition.origin ?? null,
    interactionResponder: candidate.definition.interactionResponder ?? null,
    createdInTurn: candidate.definition.createdInTurn ?? null,
  });
}

export function assertJobOccurrenceReplayContract(input: {
  readonly taskIdMatches: boolean;
  readonly definitionPresent: boolean;
  readonly definitionState: TaskDefinition["state"] | undefined;
  readonly definitionRevisionMatches: boolean;
  readonly definitionKind: "user" | "system" | undefined;
  readonly identifierUnused: boolean;
  readonly occurrenceState: JobOccurrence["state"];
  readonly activeState: JobRunState | undefined;
  readonly hasAtomicAdmission: boolean;
}): void {
  if (
    !input.taskIdMatches ||
    !input.definitionPresent ||
    input.definitionState !== "enabled" ||
    !input.definitionRevisionMatches ||
    !input.definitionKind ||
    !input.identifierUnused ||
    (input.occurrenceState !== "queued" && input.occurrenceState !== "missed")
  ) {
    throw corruptJobJournal("Job occurrence does not bind the current task definition");
  }
  if (
    input.occurrenceState === "queued" &&
    (input.activeState !== undefined || !input.hasAtomicAdmission)
  ) {
    throw corruptJobJournal("Queued occurrence does not atomically replace task availability");
  }
  if (
    input.occurrenceState === "missed" &&
    (input.activeState === undefined ||
      isTerminalJobState(input.activeState) ||
      (input.definitionKind === "user" && input.activeState === "queued"))
  ) {
    throw corruptJobJournal("Missed occurrence does not bind an in-flight task occurrence");
  }
}

/** Shared source and identity contract for a durable job admission. */
export function assertJobAdmissionReplayContract(input: {
  readonly taskIdMatches: boolean;
  readonly occurrencePresent: boolean;
  readonly scheduleMatches: boolean;
  readonly occurrenceState: JobRunState | undefined;
  readonly definitionKind: "user" | "system" | undefined;
  readonly admissionAlreadyExists: boolean;
  readonly ingressPresent: boolean;
  readonly hasAtomicManualControlResult: boolean;
}): void {
  if (
    !input.taskIdMatches ||
    !input.occurrencePresent ||
    !input.scheduleMatches ||
    input.occurrenceState !== "queued" ||
    input.definitionKind === undefined ||
    input.admissionAlreadyExists
  ) {
    throw corruptJobJournal("Job admission does not bind its occurrence");
  }
  if (
    input.definitionKind === "system" &&
    (input.ingressPresent || input.hasAtomicManualControlResult)
  ) {
    throw corruptJobJournal("System job admission cannot originate from a surface");
  }
  if (
    input.definitionKind === "user" &&
    input.ingressPresent !== input.hasAtomicManualControlResult
  ) {
    throw corruptJobJournal(
      "Manual job admission does not bind its atomic control result",
    );
  }
}

/** Maintains the single pending missed occurrence used by system coalescing. */
export function registerPendingSystemMiss(input: {
  readonly currentPendingJobRunId: string | undefined;
  readonly jobRunId: string;
  readonly definitionKind: "user" | "system" | undefined;
  readonly occurrenceState: JobRunState;
}): string | undefined {
  if (input.definitionKind !== "system" || input.occurrenceState !== "missed") {
    return input.currentPendingJobRunId;
  }
  if (input.currentPendingJobRunId !== undefined) {
    throw corruptJobJournal("System task recorded more than one coalesced miss");
  }
  return input.jobRunId;
}

/** Shared acceptance contract for the durable alias of a coalesced system miss. */
export function assertSystemMissCoalescedReplayContract(input: {
  readonly definitionKind: "user" | "system" | undefined;
  readonly requestedIdentifierUnused: boolean;
  readonly pendingMatchesCoalesced: boolean;
  readonly coalescedState: JobRunState | undefined;
  readonly activeState: JobRunState | undefined;
}): void {
  if (
    input.definitionKind !== "system" ||
    !input.requestedIdentifierUnused ||
    !input.pendingMatchesCoalesced ||
    input.coalescedState !== "missed" ||
    input.activeState === undefined ||
    isTerminalJobState(input.activeState)
  ) {
    throw corruptJobJournal("System missed-occurrence alias is invalid");
  }
}

export function assertJobConflictContainmentReplayContract(input: {
  readonly proofDecision: "halted" | "not-started";
  readonly conflictOpen: boolean;
  readonly hasAtomicSupersedeWithSameProof: boolean;
  readonly hasAtomicResolutionClose: boolean;
  readonly hasAtomicTargetState: boolean;
  readonly allCapabilitiesRevoked: boolean;
}): void {
  if (!input.conflictOpen) {
    throw corruptJobJournal("Conflict containment does not bind an open conflict");
  }
  if (
    input.proofDecision === "not-started" &&
    (!input.hasAtomicSupersedeWithSameProof ||
      !input.hasAtomicResolutionClose ||
      !input.hasAtomicTargetState ||
      !input.allCapabilitiesRevoked)
  ) {
    throw corruptJobJournal(
      "Not-started conflict containment lacks its atomic closure",
    );
  }
}

/**
 * Validates the system activation facts available without dereferencing a
 * task-definition sidecar. Online construction, full replay and the compact
 * submission guard all project into this predicate.
 */
export function assertSystemJobActivationReplayContract(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly anchorEpoch: number;
  readonly definitionKind: "user" | "system" | undefined;
  readonly occurrence:
    | {
        readonly scheduledFor: string;
        readonly taskRevision: number;
      }
    | undefined;
  readonly currentState: JobRunState | undefined;
  readonly previousFence: SystemJobFence | undefined;
  readonly fence: SystemJobFence;
  readonly hasForeignRecords: boolean;
  readonly hasAtomicRunningState: boolean;
}): void {
  const { occurrence, fence, previousFence } = input;
  if (
    input.definitionKind !== "system" ||
    !occurrence ||
    fence.taskId !== input.taskId ||
    fence.jobRunId !== input.jobRunId ||
    fence.anchorEpoch !== input.anchorEpoch ||
    fence.scheduledFor !== occurrence.scheduledFor ||
    fence.taskRevision !== occurrence.taskRevision ||
    !input.hasForeignRecords
  ) {
    throw corruptJobJournal(
      "System job fence does not bind its occurrence and resource records",
    );
  }
  if (previousFence === undefined) {
    if (
      input.currentState !== "queued" ||
      fence.attempt !== 1 ||
      !input.hasAtomicRunningState
    ) {
      throw corruptJobJournal(
        "Initial system job fence lacks its atomic running transition",
      );
    }
    return;
  }
  if (
    input.currentState !== "running" ||
    fence.attempt !== previousFence.attempt + 1 ||
    fence.taskId !== previousFence.taskId ||
    fence.jobRunId !== previousFence.jobRunId ||
    fence.scheduledFor !== previousFence.scheduledFor ||
    fence.taskRevision !== previousFence.taskRevision ||
    fence.anchorEpoch !== previousFence.anchorEpoch ||
    fence.handler !== previousFence.handler ||
    fence.paramsDigest !== previousFence.paramsDigest
  ) {
    throw corruptJobJournal(
      "Replacement system job fence does not extend the current attempt",
    );
  }
}

/** Full-replay/producer layer for fields stored in the task-definition body. */
export function assertSystemJobDefinitionReplayContract(input: {
  readonly definition: TaskDefinition | undefined;
  readonly fence: SystemJobFence;
}): void {
  const definition = input.definition;
  if (
    !definition ||
    definition.definition.kind !== "system" ||
    input.fence.taskId !== definition.taskId ||
    input.fence.taskRevision !== definition.taskRevision ||
    input.fence.handler !== definition.definition.handler ||
    input.fence.paramsDigest !==
      systemJobParamsDigest(definition.definition.params)
  ) {
    throw corruptJobJournal(
      "System job fence does not bind its task definition",
    );
  }
}

/** Shared compact contract for a system result and its terminal transition. */
export function assertSystemJobTerminalReplayContract(input: {
  readonly jobRunId: string;
  readonly definitionKind: "user" | "system" | undefined;
  readonly currentState: JobRunState | undefined;
  readonly currentFence: SystemJobFence | undefined;
  readonly resultFence: SystemJobFence;
  readonly resultAlreadyExists: boolean;
  readonly hasForeignRecords: boolean;
  readonly hasAtomicTerminalState: boolean;
}): void {
  if (
    input.definitionKind !== "system" ||
    input.currentState !== "running" ||
    !input.currentFence ||
    input.resultFence.jobRunId !== input.jobRunId ||
    canonicalize(input.currentFence) !== canonicalize(input.resultFence) ||
    input.resultAlreadyExists ||
    !input.hasForeignRecords ||
    !input.hasAtomicTerminalState
  ) {
    throw corruptJobJournal(
      "System job result is stale, duplicated, or lacks atomic settlement",
    );
  }
}

export function assertJobStateReplayContract(input: {
  readonly currentState: JobRunState | undefined;
  readonly currentRevision: number | undefined;
  readonly nextState: JobRunState;
  readonly nextRevision: number;
  readonly assignmentId: string | undefined;
  readonly assignmentBindingValid: boolean;
  readonly systemFencePresent: boolean;
  readonly definitionKind: "user" | "system" | undefined;
  readonly hasAtomicAssignment: boolean;
  readonly hasAtomicSystemActivation: boolean;
  readonly hasAtomicSystemResult: boolean;
}): void {
  if (input.definitionKind === undefined) {
    throw corruptJobJournal("Job state transition has no task definition kind");
  }
  if (
    input.currentState === undefined ||
    !isValidJobTransition(input.currentState, input.nextState)
  ) {
    throw corruptJobJournal("Job state transition is invalid");
  }
  if (input.nextRevision !== (input.currentRevision ?? 0) + 1) {
    throw corruptJobJournal("Job status revision is not contiguous");
  }
  if (input.definitionKind === "system") {
    if (input.assignmentId !== undefined) {
      throw corruptJobJournal("System job entered the assignment data plane");
    }
    const validSystemTransition =
      (input.currentState === "queued" &&
        input.nextState === "running" &&
        input.systemFencePresent &&
        input.hasAtomicSystemActivation) ||
      (input.currentState === "queued" &&
        input.nextState === "cancelled" &&
        !input.systemFencePresent) ||
      (input.currentState === "running" &&
        (input.nextState === "committed" || input.nextState === "failed") &&
        input.systemFencePresent &&
        input.hasAtomicSystemResult);
    if (!validSystemTransition) {
      throw corruptJobJournal("System job state transition crossed into user semantics");
    }
    return;
  }
  if (input.assignmentId !== undefined) {
    if (input.systemFencePresent) {
      throw corruptJobJournal("User job state transition carries a system fence");
    }
    if (!input.assignmentBindingValid) {
      throw corruptJobJournal("Job state transition names a historical assignment");
    }
    if (!USER_ASSIGNED_TRANSITIONS[input.currentState].has(input.nextState)) {
      throw corruptJobJournal(
        "User job state transition is not a legal assigned edge",
      );
    }
  } else {
    if (
      input.systemFencePresent ||
      input.currentState !== "queued" ||
      (input.nextState !== "cancelled" &&
        input.nextState !== "failed" &&
        input.nextState !== "expired")
    ) {
      throw corruptJobJournal("User job state transition lacks assignment identity");
    }
  }
  if (input.nextState === "dispatched" && !input.hasAtomicAssignment) {
    throw corruptJobJournal("Dispatched state lacks atomic assignment");
  }
  if (
    input.assignmentId !== undefined &&
    input.nextState === "failed" &&
    input.currentState !== "uncertain"
  ) {
    throw corruptJobJournal("Assigned job failure lacks an uncertainty resolution");
  }
}

/**
 * Job cancel fences land either before their cancel-requested state record
 * (dispatched/running origin) or after the uncertain state record of a
 * dispatch conflict that opened in the same envelope; both must be atomic.
 */
export function assertJobCancelFenceReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: JobRunState | undefined;
  readonly fenceAlreadyExists: boolean;
  readonly fenceSeq: number;
  readonly envelopeLsn: number;
  readonly hasAtomicCancelRequestedState: boolean;
  readonly hasAtomicOpenedConflict: boolean;
  readonly hasAtomicDeletedTaskRevision: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    input.fenceAlreadyExists ||
    !Number.isSafeInteger(input.fenceSeq) ||
    input.fenceSeq !== input.envelopeLsn ||
    ((input.currentState === "dispatched" || input.currentState === "running") &&
      !input.hasAtomicCancelRequestedState) ||
    (input.currentState === "uncertain" &&
      !input.hasAtomicOpenedConflict &&
      !input.hasAtomicDeletedTaskRevision) ||
    (input.currentState !== "dispatched" &&
      input.currentState !== "running" &&
      input.currentState !== "uncertain")
  ) {
    throw corruptJobJournal("Cancel fence is invalid or duplicated");
  }
}

/**
 * Interaction mirror submission contract: fresh batches are active in
 * dispatched/running, audit-only settlement in cancel-requested/uncertain
 * only under a durable cancel fence, rejected everywhere else; request
 * identities are unique across all mirrored batches of the assignment.
 * The producer decision and the replay reducer execute this same predicate.
 */
export function assertJobMirrorReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly executorMatches: boolean;
  readonly batchBindsRecord: boolean;
  readonly currentState: JobRunState | undefined;
  readonly hasDurableCancelFence: boolean;
  readonly batchAlreadyMirrored: boolean;
  readonly extendsCursor: boolean;
  readonly repeatsRequestId: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    !input.executorMatches ||
    !input.batchBindsRecord ||
    input.batchAlreadyMirrored ||
    !input.extendsCursor ||
    input.repeatsRequestId ||
    (input.currentState !== "dispatched" &&
      input.currentState !== "running" &&
      !(
        (input.currentState === "cancel-requested" ||
          input.currentState === "uncertain") &&
        input.hasDurableCancelFence
      ))
  ) {
    throw corruptJobJournal("Job interaction mirror replay contract is invalid");
  }
}

export function assertJobResolutionBinding(input: {
  readonly execution: unknown;
  readonly subjectTaskId: unknown;
  readonly subjectJobRunId: unknown;
  readonly recordJobRunId: string;
  readonly authorityTaskId: string;
  readonly subjectAnchorEpoch: unknown;
  readonly authorityAnchorEpoch: number;
}): void {
  if (
    input.execution !== "job" ||
    input.subjectTaskId !== input.authorityTaskId ||
    input.subjectJobRunId !== input.recordJobRunId ||
    input.subjectAnchorEpoch !== input.authorityAnchorEpoch
  ) {
    throw corruptJobJournal("Job resolution authority binding is invalid");
  }
}
