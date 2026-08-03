import type {
  AdvancementSnapshot,
  AuthorityError,
  Message,
  TaskListState,
} from "./foundation.js";
import type {
  AdvancementReviewRunInput,
  AdvancementReviewRunOutcome,
} from "../advancement/review.js";
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
  GlobalControlMutationResult,
  GlobalQuery,
  GlobalReadResult,
  GlobalStagedMutation,
  GlobalStagedMutationResult,
  SessionControlMutation,
  SessionMeta,
  SessionStagedMutation,
  TranscriptCursor,
  TranscriptPage,
} from "./state.js";
import type {
  CapabilityDescriptor,
  DispatchEnvelope,
  EvidenceBundle,
  EvidenceRequest,
  ExecutorVersionInventory,
  IngressContext,
  SealedBundle,
} from "./protocol.js";
import type {
  AssignmentRecord,
  CancelProofBody,
  DispatchConflictProof,
  DispatchRejectionProof,
  InteractionSettlementStreamProof,
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
  /**
   * 读取该对话折叠后的推进头状态：open（awaiting / active）会话优先，
   * 否则最新的终态会话；对话无任何推进历史时返回 null。
   */
  readAdvancementState(
    conversationId: string,
    ctx: AuthorityCallContext,
  ): Promise<AdvancementSnapshot | null>;
  mutate(
    conversationId: string,
    mutation: SessionControlMutation | SessionStagedMutation,
    ctx: AuthorityCallContext,
  ): Promise<{ revision: number }>;
}

export interface GlobalStatePort {
  read(q: GlobalQuery, ctx: GlobalReadCallContext): Promise<GlobalReadResult>;
  mutate<M extends GlobalControlMutation>(
    mutation: M,
    ctx: GlobalControlCallContext,
  ): Promise<GlobalControlMutationResult<M>>;
  mutate<M extends GlobalStagedMutation>(
    mutation: M,
    ctx: GlobalStagedCallContext,
  ): Promise<GlobalStagedMutationResult<M>>;
  mutate(
    mutation: GlobalControlMutation | GlobalStagedMutation,
    ctx: AuthorityCallContext,
  ): Promise<
    | GlobalControlMutationResult<GlobalControlMutation>
    | GlobalStagedMutationResult<GlobalStagedMutation>
  >;
}

export interface GlobalAuthorityFence {
  readonly domain: "global";
  readonly anchorEpoch: number;
}

export type GlobalReadCallContext = AuthorityCallContext & {
  readonly authority: GlobalAuthorityFence;
};

export type GlobalControlCallContext = AuthorityCallContext & {
  principal: Extract<AuthorityPrincipal, { kind: "surface" | "host" }>;
  readonly authority: GlobalAuthorityFence;
  /** Digest of the caller's original mutation intent for durable replay checks. */
  readonly operationDigest?: string;
  /** Authenticated product ingress retained when a global mutation creates provenance. */
  readonly ingress?: IngressContext;
};

export type GlobalStagedCallContext = AuthorityCallContext & {
  principal: Extract<AuthorityPrincipal, { kind: "assignment" }>;
  readonly authority: GlobalAuthorityFence;
};

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

export interface LocalWorkspaceBinding {
  bindingRef: string;
  revision: number;
  displayName: string;
  absolutePath: string;
  workspaceBindingRevision: number;
}

export interface LocalEnvironmentControlContext {
  requestId: string;
  lease: ImmediateRootResourceLease;
  abort: AbortSignal;
}

export interface LocalEnvironmentRecoveryContext
  extends LocalEnvironmentControlContext {
  confirmation: {
    kind: "workspace-binding-reset";
    token: string;
    requestId: string;
    catalogGeneration: string;
    issuedAt: IsoTime;
  };
}

export interface WorkspaceBindingResetReceipt {
  requestId: string;
  confirmationDigest: Digest;
  previousCatalogGeneration: string;
  catalogGeneration: string;
  logId: string;
  capabilityRevision: number;
  preparedAt: IsoTime;
}

export interface WorkspaceBindingResetReservation {
  requestId: string;
  confirmationDigest: Digest;
  previousCatalogGeneration: string;
  catalogGeneration: string;
  preparedAt: IsoTime;
}

export interface WorkspaceBindingRootManifest {
  catalogGeneration: string;
  logId: string;
  capabilityRevision: number;
  state: "healthy" | "degraded";
  degradedReason?: string;
  pendingReset?: WorkspaceBindingResetReservation;
}

export type WorkspaceBindingPatch =
  | { displayName: string; absolutePath?: string }
  | { absolutePath: string; displayName?: string };

export interface WorkspaceBindingAdminPort {
  list(
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding[]>;
  create(
    input: { displayName: string; absolutePath: string },
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding>;
  update(
    bindingRef: string,
    patch: WorkspaceBindingPatch,
    expectedRevision: number,
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding>;
  remove(
    bindingRef: string,
    expectedRevision: number,
    control: LocalEnvironmentControlContext,
  ): Promise<void>;
}

export interface WorkspaceBindingRecoveryPort {
  status(): Promise<{
    state: "healthy" | "degraded";
    catalogGeneration: string;
    reason?: string;
  }>;
  beginReset(
    input: { expectedCatalogGeneration: string },
    control: LocalEnvironmentRecoveryContext,
  ): Promise<WorkspaceBindingResetReservation>;
  completeReset(
    requestId: string,
    abort: AbortSignal,
  ): Promise<WorkspaceBindingResetReceipt>;
}

export interface WorkspaceBindingMigrationPort {
  importLegacy(
    input: {
      migrationId: string;
      sourceSnapshotToken: string;
      displayName: string;
      absolutePath: string;
    },
    abort: AbortSignal,
  ): Promise<LocalWorkspaceBinding>;
  activateLegacy(
    input: {
      migrationId: string;
      sourceSnapshotToken: string;
    },
    abort: AbortSignal,
  ): Promise<void>;
  abandonLegacy(
    input: {
      migrationId: string;
      sourceSnapshotToken: string;
      reason: string;
    },
    abort: AbortSignal,
  ): Promise<void>;
}

export type ReservationOrigin =
  | { admissionClass: "interactive"; entry: "conversation-input" }
  | { admissionClass: "interactive"; entry: "environment-control" }
  | { admissionClass: "advancement"; entry: "advancement-control" }
  | { admissionClass: "scheduler"; entry: "schedule-trigger" }
  | { admissionClass: "orchestration"; entry: "orchestration" };

export type SystemJobReservationOrigin = Extract<
  ReservationOrigin,
  { entry: "schedule-trigger" }
>;

export interface ResourceReservationPort {
  enqueueRoot(
    reservationId: string,
    workload: import("./authorization.js").RootResourceWorkload,
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<void>;
  prepareAssignmentRoot<E extends ExecutionKind>(
    request: AssignmentReservationRequest<E>,
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<AssignmentResourceLease<E>>;
  prepareSystemJobRoot(
    request: SystemJobReservationRequest,
    origin: SystemJobReservationOrigin,
    ctx: AuthorityCallContext,
  ): Promise<SystemJobResourceLease>;
  acquireRoot(
    workload: ImmediateRootWorkload,
    budget: ResourceLease["budget"],
    origin: ReservationOrigin,
    ctx: AuthorityCallContext,
    audience?: { readonly executorId: string },
    scopeBinding?: ResourceLease["scopeBinding"],
  ): Promise<ImmediateRootResourceLease>;
  acquireChild(
    parent: ResourceLease,
    workload: import("./authorization.js").ChildResourceLease["workload"],
    budget: ResourceLease["budget"],
    ctx: AuthorityCallContext,
  ): Promise<import("./authorization.js").ChildResourceLease>;
  reserveUsage(
    lease: ResourceLease,
    usage: {
      usageId: string;
      tokens?: number;
      calls?: number;
      costMinor?: number;
    },
    ctx: AuthorityCallContext,
  ): Promise<void>;
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
  /** 仅在无法形成可核验 usage 水位时使用；正常业务终结仍须 settle/release。 */
  reclaim?(lease: ResourceLease): Promise<void>;
}

/** executor 取证入口的封闭结果；typed-stale 由签名 bundle 的观测令牌导出。 */
export type EvidenceExecutionResult =
  | { readonly kind: "bundle"; readonly bundle: EvidenceBundle }
  | { readonly kind: "capability-gap" };

/** owner 到目标 executor 的取证传输端口；进程内与 mesh 共享同一合同。 */
export interface EvidenceClientPort {
  collect(
    request: EvidenceRequest,
    abort: AbortSignal,
  ): Promise<EvidenceExecutionResult>;
}

/** executor 侧唯一受限取证入口，不创建 assignment，也不复用 run dispatch。 */
export interface EvidenceHandlerPort extends EvidenceClientPort {}

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
  /**
   * 推进侧裁判调用——输入是 advancement 模块的唯一领域合同（被审 run、
   * 确认版 Rubric、既往 review、推进窗口与 owner 已验真 canonical
   * evidence）；返回结论或挂起分流，不直接写任何权威状态。
   */
  review(
    input: AdvancementReviewRunInput,
    lease: ResourceLease,
    abort: AbortSignal,
  ): Promise<AdvancementReviewRunOutcome>;
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
    | "failed"
    | "sealed"
    | "acked";
  sealedBundleRef?: import("./foundation.js").ArtifactRef;
  acknowledgedCommitRevision?: number;
  cancelProof?: CancelProofBody;
  failure?: {
    reason: string;
    usageFinal: { reportDigest: Digest; upToUsageSeq: number };
  };
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

/**
 * Job-only audit settlement after an abort-ticket leaves a verified executor
 * prefix whose interaction projections still need to converge.
 */
export interface JobInteractionSettlementPort {
  completeInteractionSettlement(
    assignmentId: string,
    proof: InteractionSettlementStreamProof | undefined,
    ctx: AuthorityCallContext,
  ): Promise<void>;
}

export interface ResourceUsageIntake {
  submitUsageReport(
    report: UsageReport,
    ctx: AuthorityCallContext,
  ): Promise<{ ackedThroughSeq: number }>;
}

/** Per-run bridge that durably reserves and settles every real provider call. */
export interface ModelCallResourceMeter {
  reserve(input: {
    readonly callIndex: number;
    readonly tokenUpperBound: number;
  }): Promise<{ readonly usageId: string }>;
  consume(input: {
    readonly usageId: string;
    readonly tokens: number;
  }): Promise<void>;
}
