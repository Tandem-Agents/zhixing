import type {
  AgentYield,
  ArtifactRef,
  ConversationRunState,
  Digest,
  EvidenceKind,
  EvidenceLocator,
  IsoTime,
  InteractionDisplay,
  JobRunState,
  Message,
  ProtocolVersion,
  RunRecordAdvancementMetadata,
  SessionEventProjection,
  Signature,
  TranscriptRunRecord,
  TurnOrigin,
  TurnSource,
  UserTurnInput,
  WindowCompactInstruction,
  WireContractV1,
} from "./foundation.js";
import type { WireSchemaV1 } from "../types/distributed.js";
import type {
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityEpochRef,
  ChannelInteractionGrant,
  ChannelResponderRef,
  ControlLease,
  DataPlaneTicket,
  ExecutionKind,
  ExecutionRef,
  ExecutionRefFor,
  PermissionSnapshotLease,
  ResourceLease,
} from "./authorization.js";

export const MAX_CONVERSATION_QUESTION_BYTES = 8 * 1024;
export const MAX_INTERACTION_RESPONSE_TEXT_BYTES = 8 * 1024;
export const MAX_INLINE_INTERACTION_DISPLAY_BYTES = 8 * 1024;
export const MAX_INLINE_STREAM_ITEM_BYTES = 32 * 1024;
export const MAX_LEDGER_EVIDENCE_PAGE_ENTRIES = 256;
export const MAX_LEDGER_EVIDENCE_PAGE_BYTES = 512 * 1024;
export const MAX_CONTROL_INPUT_ATTACHMENTS = 16;
import type {
  ContentAssetRef,
  DeliveryFailure,
  DeliveryResolutionFact,
  GlobalControlMutation,
  SessionControlMutation,
  SessionStagedMutation,
} from "./state.js";

export interface ControlEnvelope extends WireSchemaV1<"ControlEnvelope"> {
  requestId: string;
  principal: {
    surfacePrincipal: string;
    deviceId: string;
    connectionId: string;
  };
  dependencyArtifacts: ArtifactRef[];
  payloadDigest: Digest;
  at: IsoTime;
  body: ControlRequest;
}

export type IngressContext =
  | {
      kind: "first-party";
      surfacePrincipal: string;
      deviceId: string;
      ingressId: string;
      turnOrigin?: TurnOrigin;
      receivedAt: IsoTime;
    }
  | {
      kind: "channel";
      surfacePrincipal: string;
      responder: ChannelResponderRef;
      replyTarget: import("./foundation.js").DeliveryTargetDto;
      deviceId: string;
      ingressId: string;
      turnOrigin?: TurnOrigin;
      receivedAt: IsoTime;
    };

/** Durable execution semantics for an admitted conversation input. */
export type ConversationInvocation =
  | {
      kind: "agent";
      source: TurnSource;
      advancement?: RunRecordAdvancementMetadata;
    }
  | {
      kind: "perspectives";
      source: "interactive" | "channel";
      question: string;
    };

export interface ExplicitEnvironmentSelection {
  workspace: { deviceId: string; bindingRef: string };
}

export type ControlRequest =
  | {
      t: "input";
      conversationId: string;
      ingress: { ingressId: string; source: IngressContext["kind"] };
      input: UserTurnInput;
      attachments?: ContentAssetRef[];
      invocation: ConversationInvocation;
      environment?: ExplicitEnvironmentSelection;
      ownerEpoch: number;
    }
  | { t: "cancel"; conversationId: string; runId: string; ownerEpoch: number }
  | {
      // 批量取消以外层 surface 请求为唯一线性化点:候选集在权威 apply 时刻冻结,
      // 重放返回原批次,零重新枚举、零追加。response 为渠道回执绑定,
      // 空批次时由同一权威决定产出唯一 response delivery item。
      t: "cancel-batch";
      conversationId: string;
      ownerEpoch: number;
      response?: { replyTarget: import("./foundation.js").DeliveryTargetDto };
    }
  | { t: "session-create"; requestedName?: string; sceneId?: string }
  | {
      t: "session-write";
      conversationId: string;
      mutation: SessionControlMutation | SessionStagedMutation;
      ownerEpoch: number;
      domainRevision: number;
    }
  | {
      t: "global-write";
      mutation: GlobalControlMutation;
      anchorEpoch: number;
      domainRevision: number;
    }
  | {
      t: "job-run";
      taskId: string;
      anchorEpoch: number;
    }
  | { t: "job-cancel"; taskId: string; jobRunId: string; anchorEpoch: number }
  | {
      t: "allow-once";
      assignmentId: string;
      interactionRequestId: string;
      response:
        | {
            via: "surface-ticket";
            ticketId: string;
            decision: { allowed: boolean; reason?: string };
          }
        | { via: "channel-grant"; grant: ChannelInteractionGrant };
    }
  | {
      t: "uncertain-resolve";
      ref: ExecutionRef;
      openFactDigest: Digest;
      decision:
        | "user-verified-side-effects"
        | "user-abandoned"
        | "user-retry-acknowledged";
    }
  | {
      t: "delivery-resolve";
      itemId: string;
      attempt: number;
      anchorEpoch: number;
      openFactDigest: Digest;
      decision: "user-verified-sent" | "abandon" | "retry-risk-ack";
    };

export interface CapabilityDescriptor
  extends WireSchemaV1<"CapabilityDescriptor"> {
  executorId: string;
  revision: number;
  protocolVersion: ProtocolVersion;
  workspaces: Array<{
    bindingRef: string;
    workspaceBindingRevision: number;
    displayName: string;
  }>;
  tools: string[];
  mcpServers: string[];
  credentialBindings: CredentialBindingDescriptor[];
  evidenceCapabilities: EvidenceKind[];
  at: IsoTime;
  signature: Signature;
}

export interface ExecutorVersionInventory
  extends WireSchemaV1<"ExecutorVersionInventory"> {
  executorId: string;
  inventoryRevision: number;
  capabilityRevision: number;
  configVersions: {
    runtimeConfigRev: number;
    modelProfileRev: number;
    policyRev: number;
  };
  assetVersions: {
    skillsRev: number;
    rubricsRev: number;
    promptAssetsRev: number;
  };
  permissionSnapshotHighWater: number;
  credentialBindingRevisions: Array<{ bindingId: string; revision: number }>;
  at: IsoTime;
  signature: Signature;
}

export interface CredentialBindingDescriptor {
  bindingId: string;
  service: string;
  resource?: string;
  principalFingerprint?: Digest;
  tenant?: string;
  scopes?: string[];
  verification: "service-verified" | "user-alias";
  revision: number;
}

export type ManifestBaseRef<E extends ExecutionKind> = E extends "conversation"
  ? { execution: "conversation"; conversationId: string; baseRevision: number }
  : {
      execution: "job";
      taskId: string;
      jobRunId: string;
      taskRevision: number;
    };

export interface ExecutionManifest<
  E extends ExecutionKind = ExecutionKind,
> extends WireSchemaV1<"ExecutionManifest"> {
  baseRef: ManifestBaseRef<E>;
  protocolVersion: ProtocolVersion;
  requires: ExecutorVersionInventory["configVersions"] &
    ExecutorVersionInventory["assetVersions"] & {
      permissionSnapshotVersion: number;
    };
  tools: string[];
  mcpServers: string[];
  environment: EnvironmentRequirement;
  credentialBindings: Array<{
    service: string;
    bindingId: string;
    revision: number;
  }>;
  digest: Digest;
}

export interface EnvironmentRequirement {
  deviceId?: string;
  workspace?: {
    deviceId: string;
    bindingRef: string;
    workspaceBindingRevision: number;
  };
  credentialBindings?: Array<{ service: string; bindingId: string }>;
  evidenceKinds?: EvidenceKind[];
}

export interface EnvironmentControlGrant
  extends WireSchemaV1<"EnvironmentControlGrant"> {
  grantId: string;
  deviceId: string;
  bindingRef: string;
  methods: ["environment.probe"];
  requestId: string;
  resourceLeaseDigest: Digest;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export interface WorkspaceProbeRequest
  extends WireSchemaV1<"WorkspaceProbeRequest"> {
  requestId: string;
  deviceId: string;
  bindingRef: string;
  grant: EnvironmentControlGrant;
  resourceLease: import("./authorization.js").ImmediateRootResourceLease;
  at: IsoTime;
}

export interface WorkspaceProbeResult
  extends WireSchemaV1<"WorkspaceProbeResult"> {
  requestId: string;
  bindingRef: string;
  workspaceBindingRevision: number;
  probe:
    | "directory"
    | "missing"
    | "non_directory"
    | "inaccessible"
    | "error";
  executorId: string;
  signature: Signature;
}

export interface ConversationDispatch {
  t: "conversation";
  runId: string;
  conversationId: string;
  ownerEpoch: number;
  baseRevision: number;
  ingress: IngressContext;
  contentAssets: ContentAssetRef[];
  windowInput: WindowInput;
  controlContext: Array<{ source: string; block: string }>;
}

export interface JobCommitFence extends WireSchemaV1<"JobCommitFence"> {
  taskId: string;
  jobRunId: string;
  scheduledFor: IsoTime;
  taskRevision: number;
  deliveryPlanDigest: Digest;
  anchorEpoch: number;
  assignmentId: string;
  executorId: string;
  digest: Digest;
}

export interface JobExecutionInstruction {
  kind: "agent-turn";
  prompt: string;
  model?: string;
  tools?: string[];
}

export interface JobDispatch {
  t: "job";
  jobRunId: string;
  taskId: string;
  fence: JobCommitFence;
  instruction: JobExecutionInstruction;
}

export type WindowInput =
  | {
      t: "full";
      windowEpoch: number;
      messages: Message[] | { ref: ArtifactRef };
    }
  | {
      t: "delta";
      baseEpoch: number;
      baseDigest: Digest;
      targetEpoch: number;
      targetDigest: Digest;
      appended: Message[];
    };

type DispatchWork<E extends ExecutionKind> = E extends "conversation"
  ? ConversationDispatch
  : JobDispatch;

type DispatchEnvelopeFor<E extends ExecutionKind> = WireContractV1 & {
  execution: E;
  assignmentId: string;
  executorId: string;
  manifest: ExecutionManifest<E>;
  controlLease: ControlLease;
  permissionLease: PermissionSnapshotLease<E>;
  capabilities: AuthorityCapability<E>[];
  resourceLease: AssignmentResourceLease<E>;
  dependencyArtifacts: ArtifactRef[];
  issuedAt: IsoTime;
  signature: Signature;
  work: DispatchWork<E>;
};

export type DispatchEnvelope = WireSchemaV1<"DispatchEnvelope"> & {
  [E in ExecutionKind]: DispatchEnvelopeFor<E>;
}[ExecutionKind];

export interface SealedBundle extends WireSchemaV1<"SealedBundle"> {
  assignmentId: string;
  executorId: string;
  digest: Digest;
  streamFinal: { finalSeq: number; streamDigest: Digest };
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  usageFinal: { reportDigest: Digest; upToUsageSeq: number };
  dependencyArtifacts: ArtifactRef[];
  body: ConversationCommitBundle | JobCommitBundle;
}

export interface ConversationCommitBundle {
  t: "conversation";
  runId: string;
  conversationId: string;
  ownerEpoch: number;
  baseRevision: number;
  runRecord: TranscriptRunRecord | { ref: ArtifactRef };
  windowCompact?: WindowCompactInstruction;
  contentAssets: ContentAssetRef[];
  mutationBatch?: {
    ref: ArtifactRef;
    sessionCount: number;
    globalCount: number;
  };
}

export interface JobCommitBundle {
  t: "job";
  jobRunId: string;
  taskId: string;
  fence: JobCommitFence;
  outcome: { status: "completed" | "failed"; summary: string };
  contentAssets: ContentAssetRef[];
  mutationBatch?: { ref: ArtifactRef; sessionCount: 0; globalCount: number };
}

export type ResolutionActionSet = [
  "verify-side-effects",
  "abandon",
  "retry-risk-ack",
];

export interface StatusNoticeBase<R, S, A extends [] | ResolutionActionSet>
  extends WireContractV1 {
  ref: R;
  state: S;
  reason?: string;
  statusRevision: number;
  actions: A;
  at: IsoTime;
}

export type ConversationUncertainClosure =
  | { closedBy: "late-bundle-committed"; resultingState: "committed" }
  | {
      closedBy: "proven-not-started-redispatched";
      resultingState: "queued";
    }
  | { closedBy: "user-verified-side-effects"; resultingState: "failed" }
  | { closedBy: "user-abandoned"; resultingState: "cancelled" }
  | { closedBy: "user-retry-acknowledged"; resultingState: "queued" };

export type JobUncertainClosure =
  | ConversationUncertainClosure
  | {
      closedBy: "proven-not-started-cancelled";
      resultingState: "cancelled";
    };

export type ConversationStatusNotice =
  | (StatusNoticeBase<
      ExecutionRefFor<"conversation">,
      "uncertain",
      ResolutionActionSet
    > & { openFactDigest: Digest })
  | (StatusNoticeBase<ExecutionRefFor<"conversation">, "uncertain-closed", []> &
      { openFactDigest: Digest } & ConversationUncertainClosure)
  | StatusNoticeBase<
      ExecutionRefFor<"conversation">,
      Exclude<ConversationRunState, "committed" | "uncertain">,
      []
    >;

export type JobStatusNotice =
  | (StatusNoticeBase<ExecutionRefFor<"job">, "uncertain", ResolutionActionSet> & {
      openFactDigest: Digest;
    })
  | (StatusNoticeBase<ExecutionRefFor<"job">, "uncertain-closed", []> &
      { openFactDigest: Digest } & JobUncertainClosure)
  | StatusNoticeBase<
      ExecutionRefFor<"job">,
      Exclude<JobRunState, "committed" | "uncertain">,
      []
    >;

export type DeliveryStatusRef = { execution: "delivery"; itemId: string };

export type DeliveryStatusNotice =
  | (StatusNoticeBase<
      DeliveryStatusRef,
      "delivery-uncertain",
      ResolutionActionSet
    > & { attempt: number; anchorEpoch: number; openFactDigest: Digest })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-failed", []> & {
      attempt: number;
      anchorEpoch: number;
    })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-resolved", []> & {
      attempt: number;
      anchorEpoch: number;
      openFactDigest: Digest;
      decision: DeliveryResolutionFact["decision"];
    })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-uncertain-closed", []> & {
      attempt: number;
      anchorEpoch: number;
      openFactDigest: Digest;
    } & (
      | { closedBy: "late-sent" | "late-retry-scheduled" }
      | { closedBy: "late-failed"; error: DeliveryFailure }
    ));

export type ExecutionStatusNotice = WireSchemaV1<"ExecutionStatusNotice"> &
  (ConversationStatusNotice | JobStatusNotice | DeliveryStatusNotice);

/** Narrow, durable scheduler notices that do not correspond to one job-state revision. */
export interface SchedulerUserNotice {
  readonly noticeId: string;
  /** Authority commit LSN; the scalar server.info continuation cursor. */
  readonly revision: number;
  readonly kind:
    | "missed-summary"
    | "capability-gap"
    | "publish-result"
    | "journal-maintenance";
  readonly state: "prepared" | "open" | "updated" | "closed";
  readonly ref:
    | {
        readonly kind: "missed-summary";
        readonly batchId: string;
        readonly memberCount: number;
      }
    | {
        readonly kind: "capability-gap";
        readonly taskId: string;
        readonly jobRunId: string;
        readonly round: number;
      }
    | {
        readonly kind: "publish-result";
        readonly taskId: string;
        readonly jobRunId: string;
        readonly assignmentId: string;
        readonly seq: number;
        readonly decision: "conflicted" | "applied";
      }
    | {
        readonly kind: "journal-maintenance";
        readonly planDigest: Digest;
        readonly monthCount: number;
        readonly fileCount: number;
        readonly attempt: number;
        readonly completed: number;
      };
  readonly reason: string;
  readonly actions: readonly string[];
  readonly at: IsoTime;
}

export type StreamFramePayload =
  | { kind: "agent-yield"; yield: AgentYield | { ref: ArtifactRef } }
  | {
      kind: "agent-event";
      event: SessionEventProjection | { ref: ArtifactRef };
    }
  | {
      kind: "interaction";
      event:
        | {
            t: "requested";
            requestId: string;
            toolName: string;
            display: InteractionDisplay;
            issuedAt: IsoTime;
            ttlMs: number;
            expiresAt: IsoTime;
          }
        | {
            t: "finished";
            requestId: string;
            outcome: "allowed" | "denied" | "cancelled" | "expired";
          };
    }
  | { kind: "provisional-final"; finalSeq: number; streamDigest: Digest };

export interface StreamFrame extends WireSchemaV1<"StreamFrame"> {
  ref: ExecutionRef;
  assignmentId: string;
  streamEpoch: number;
  seq: number;
  payload: StreamFramePayload;
  meta: { lineage?: string; turnOrigin?: TurnOrigin };
}

export interface FinalFrame extends WireSchemaV1<"FinalFrame"> {
  conversationId: string;
  runId: string;
  commitRevision: number;
  digest: Digest;
  publishConflicts?: number;
}

export type StreamConsumerAuth =
  | { kind: "surface-ticket"; ticketId: string }
  | {
      kind: "owner-relay";
      authority: Extract<AuthorityEpochRef, { execution: "job" }>;
      controlLeaseId: string;
    };

export interface StreamSubscribe extends WireSchemaV1<"StreamSubscribe"> {
  ref: ExecutionRef;
  assignmentId: string;
  consumer: StreamConsumerAuth;
  afterSeq: number;
}

export interface StreamAck extends WireSchemaV1<"StreamAck"> {
  assignmentId: string;
  consumer: StreamConsumerAuth;
  ackSeq: number;
}

export interface EvidenceRequest extends WireSchemaV1<"EvidenceRequest"> {
  requestId: string;
  reviewId: string;
  runId: string;
  conversationId: string;
  ownerEpoch: number;
  executorId: string;
  workspace: { bindingRef: string; workspaceBindingRevision: number };
  items: Array<{
    kind: EvidenceKind;
    locator: EvidenceLocator;
    digestHint?: Digest;
  }>;
  lease: ResourceLease;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export interface ObservationToken {
  observedAt: IsoTime;
  preStateFingerprint: Digest;
  postStateFingerprint: Digest;
  consistent: boolean;
}

export interface EvidenceBundle extends WireSchemaV1<"EvidenceBundle"> {
  requestId: string;
  requestDigest: Digest;
  observation: ObservationToken;
  items: Array<{
    kind: EvidenceKind;
    locator: EvidenceLocator;
    contentDigest: Digest;
    summary: string;
    source: "independent";
  }>;
  executorId: string;
  signature: Signature;
}

export interface ExecutionAbortRequest
  extends WireSchemaV1<"ExecutionAbortRequest"> {
  assignmentId: string;
  ref: ExecutionRef;
  ticket: Extract<DataPlaneTicket, { kind: "abort" }>;
  reason: string;
  at: IsoTime;
}
