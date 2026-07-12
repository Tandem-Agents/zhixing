import type {
  AgentYield,
  ArtifactRef,
  ConversationRunState,
  Digest,
  EvidenceKind,
  EvidenceLocator,
  IsoTime,
  JobRunState,
  Message,
  SessionEventProjection,
  Signature,
  TranscriptRunRecord,
  TurnOrigin,
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
  DataPlaneTicket,
  ExecutionKind,
  ExecutionRef,
  ExecutionRefFor,
  PermissionSnapshotLease,
  ResourceLease,
} from "./authorization.js";
import type {
  ContentAssetRef,
  DeliveryResolutionFact,
  GlobalControlMutation,
  SessionControlMutation,
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

export type ControlRequest =
  | {
      t: "input";
      conversationId: string;
      ingress: { ingressId: string; source: IngressContext["kind"] };
      input: UserTurnInput;
      ownerEpoch: number;
    }
  | { t: "cancel"; conversationId: string; runId: string; ownerEpoch: number }
  | { t: "session-create"; requestedName?: string; sceneId?: string }
  | {
      t: "session-write";
      conversationId: string;
      mutation: SessionControlMutation;
      ownerEpoch: number;
      domainRevision: number;
    }
  | {
      t: "global-write";
      mutation: GlobalControlMutation;
      anchorEpoch: number;
      domainRevision: number;
    }
  | { t: "job-run"; taskId: string; anchorEpoch: number }
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
  protocolVersion: string;
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
    permissionSnapshotVersion: number;
  };
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
  requires: ExecutorVersionInventory["configVersions"] &
    ExecutorVersionInventory["assetVersions"];
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

export type ConversationStatusNotice =
  | StatusNoticeBase<ExecutionRefFor<"conversation">, "uncertain", ResolutionActionSet>
  | StatusNoticeBase<
      ExecutionRefFor<"conversation">,
      Exclude<ConversationRunState, "committed" | "uncertain">,
      []
    >;

export type JobStatusNotice =
  | StatusNoticeBase<ExecutionRefFor<"job">, "uncertain", ResolutionActionSet>
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
    > & { attempt: number; anchorEpoch: number })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-failed", []> & {
      attempt: number;
      anchorEpoch: number;
    })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-resolved", []> & {
      attempt: number;
      anchorEpoch: number;
      decision: DeliveryResolutionFact["decision"];
    });

export type ExecutionStatusNotice = WireSchemaV1<"ExecutionStatusNotice"> &
  (ConversationStatusNotice | JobStatusNotice | DeliveryStatusNotice);

export type StreamFramePayload =
  | { kind: "agent-yield"; yield: AgentYield }
  | { kind: "agent-event"; event: SessionEventProjection }
  | {
      kind: "interaction";
      event:
        | {
            t: "requested";
            requestId: string;
            toolName: string;
            display: { title: string; lines: string[] };
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
