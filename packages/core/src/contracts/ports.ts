import type {
  AdvancementControlEvent,
  AdvancementSnapshot,
  AuthorityError,
  Message,
  TaskListState,
} from "./foundation.js";
import type {
  AssignmentActivationProof,
  AssignmentReservationRequest,
  AssignmentResourceLease,
  AuthorityCapability,
  ExecutionKind,
  ImmediateRootResourceLease,
  ImmediateRootWorkload,
  OwnerControlGrant,
  ResourceLease,
  SystemJobReservationRequest,
  SystemJobResourceLease,
  UsageReport,
} from "./authorization.js";
import type {
  DeferredGlobalIntent,
  GlobalControlMutation,
  GlobalQuery,
  GlobalReadResult,
  GlobalStagedMutation,
  SessionControlMutation,
  SessionMeta,
  SessionStagedMutation,
  TranscriptCursor,
  TranscriptPage,
} from "./state.js";
import type {
  CapabilityDescriptor,
  DispatchEnvelope,
  ExecutorVersionInventory,
  SealedBundle,
} from "./protocol.js";
import type {
  AssignmentRecord,
  CancelProofBody,
  DispatchConflictProof,
  DispatchRejectionProof,
  InteractionMirrorBatch,
  SupersedeProof,
} from "./records.js";
import type {
  DispatchConflictError,
  Digest,
  IsoTime,
  Signature,
} from "./foundation.js";
import type { WireSchemaV1 } from "../types/distributed.js";

export type AuthorityPrincipal =
  | { kind: "assignment"; capability: AuthorityCapability }
  | { kind: "surface"; surfacePrincipal: string; connectionId: string }
  | { kind: "host"; component: string }
  | { kind: "owner-control"; grant: OwnerControlGrant }
  | { kind: "usage-reporter"; executorId: string };

export interface AuthorityCallContext {
  principal: AuthorityPrincipal;
  requestId: string;
  expectedRevision?: number;
  deadlineAt: IsoTime;
}

export interface SessionStatePort {
  readSessionMeta(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<SessionMeta>;
  readTranscriptTail(
    conversationId: string,
    ctx: AuthorityCallContext,
    cursor?: TranscriptCursor,
    limit?: number,
  ): Promise<TranscriptPage>;
  readTaskList(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<TaskListState>;
  readAdvancementState(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<AdvancementSnapshot>;
  mutate(
    conversationId: string,
    mutation: SessionControlMutation | SessionStagedMutation,
    ctx: AuthorityCallContext,
  ): Promise<{ revision: number }>;
}

export interface GlobalStatePort {
  read(q: GlobalQuery, ctx: AuthorityCallContext): Promise<GlobalReadResult>;
  mutate(
    mutation: GlobalControlMutation | GlobalStagedMutation,
    ctx: AuthorityCallContext,
  ): Promise<{ revision: number }>;
}

export interface DeferredGlobalIntentPort {
  record(
    conversationId: string,
    mutation: DeferredGlobalIntent["mutation"],
    timeSensitive: boolean,
    ctx: AuthorityCallContext,
  ): Promise<{ intentId: string }>;
  list(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<DeferredGlobalIntent[]>;
  decide(
    intentId: string,
    decision: "confirmed" | "discarded",
    ctx: AuthorityCallContext,
  ): Promise<void>;
}

export interface EnvironmentPort {
  resolveWorkspace(
    bindingRef: string,
  ): Promise<{ absolutePath: string; workspaceBindingRevision: number }>;
  probePath(
    path: string,
  ): Promise<
    "directory" | "missing" | "non_directory" | "inaccessible" | "error"
  >;
  capabilitySnapshot(): Promise<CapabilityDescriptor>;
  versionInventory(): Promise<ExecutorVersionInventory>;
}

export interface ReservationOrigin {
  admissionClass: import("./authorization.js").AdmissionClass;
  entry:
    | "conversation-input"
    | "advancement-control"
    | "schedule-trigger"
    | "orchestration";
}

export interface ResourceReservationPort {
  prepareAssignmentRoot<E extends ExecutionKind>(
    request: AssignmentReservationRequest<E>,
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<AssignmentResourceLease<E>>;
  prepareSystemJobRoot(
    request: SystemJobReservationRequest,
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<SystemJobResourceLease>;
  acquireRoot(
    workload: ImmediateRootWorkload,
    budget: ResourceLease["budget"],
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<ImmediateRootResourceLease>;
  acquireChild(
    parent: ResourceLease,
    workload: import("./authorization.js").ChildResourceLease["workload"],
    budget: ResourceLease["budget"],
    ctx: AuthorityCallContext,
  ): Promise<import("./authorization.js").ChildResourceLease>;
  consume(
    lease: ResourceLease,
    usage: {
      usageId: string;
      tokens?: number;
      calls?: number;
      costMinor?: number;
    },
    ctx: AuthorityCallContext,
  ): Promise<void>;
  settle(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void>;
  release(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void>;
}

export interface ControlCompletionPort {
  complete(request: {
    role: "main" | "light";
    messages: Message[];
    schemaToolName?: string;
    lease: ResourceLease;
    abort: AbortSignal;
    deadlineAt: IsoTime;
  }): Promise<
    | {
        ok: true;
        text: string;
        toolCall?: { name: string; input: object };
        usage: { inputTokens: number; outputTokens: number };
      }
    | { ok: false; error: AuthorityError }
  >;
}

export interface AdvancementReviewerPort {
  review(
    input: AdvancementSnapshot,
    lease: ResourceLease,
    abort: AbortSignal,
  ): Promise<AdvancementControlEvent[]>;
}

export interface LedgerSnapshot extends WireSchemaV1<"LedgerSnapshot"> {
  assignmentId: string;
  lastSeq: number;
  phase:
    | "unknown"
    | "received"
    | "dispatch-rejected"
    | "supersede-fenced"
    | "started"
    | "halted"
    | "sealed"
    | "acked";
  sealedBundleRef?: import("./foundation.js").ArtifactRef;
  cancelProof?: CancelProofBody;
}

export interface LedgerEvidencePage
  extends WireSchemaV1<"LedgerEvidencePage"> {
  assignmentId: string;
  fromSeq: number;
  toSeq: number;
  entries: Array<{
    recordSeq: number;
    body: AssignmentRecord | { ref: import("./foundation.js").ArtifactRef };
  }>;
  chainDigest: Digest;
  executorId: string;
  signature: Signature;
}

export type DispatchResult = WireSchemaV1<"DispatchResult"> &
  (
    | { accepted: true }
    | {
        accepted: false;
        outcome: "rejected-before-received";
        error: AuthorityError;
        proof: DispatchRejectionProof;
      }
    | {
        accepted: false;
        outcome: "conflicting-redelivery";
        error: DispatchConflictError;
        proof: DispatchConflictProof;
      }
  );

export type RunDispatchArguments = {
  [E in ExecutionKind]: [
    envelope: Extract<DispatchEnvelope, { execution: E }>,
    activation: AssignmentActivationProof<E>,
    ctx: AuthorityCallContext,
  ];
}[ExecutionKind];

export interface RunExecutorPort {
  dispatch(...args: RunDispatchArguments): Promise<DispatchResult>;
  cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void>;
  supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<SupersedeProof>;
  queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage>;
}

export interface RunSubmissionPort {
  reportStarted(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<void>;
  submitBundle(
    bundle: SealedBundle,
    ctx: AuthorityCallContext,
  ): Promise<
    | { committed: true; commitRevision: number }
    | { committed: false; error: AuthorityError }
  >;
  submitCancelProof(
    assignmentId: string,
    proof: CancelProofBody,
    ctx: AuthorityCallContext,
  ): Promise<void>;
  mirrorInteractions(
    assignmentId: string,
    batch: InteractionMirrorBatch,
    ctx: AuthorityCallContext,
  ): Promise<{ mirroredUpTo: number; ordinal: number; mirrorDigest: Digest }>;
}

export interface ResourceUsageIntake {
  submitUsageReport(
    report: UsageReport,
    ctx: AuthorityCallContext,
  ): Promise<{ ackedThroughSeq: number }>;
}
