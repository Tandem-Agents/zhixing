import type {
  ArtifactRef,
  DeliveryTargetDto,
  Digest,
  IsoTime,
  Signature,
  WireContractV1,
} from "./foundation.js";
import type { WireSchemaV1 } from "../types/distributed.js";

export type ExecutionKind = "conversation" | "job";

export type AuthorityEpochRef =
  | {
      execution: "conversation";
      conversationId: string;
      ownerEpoch: number;
    }
  | { execution: "job"; taskId: string; anchorEpoch: number };

export type ExecutionRef =
  | {
      execution: "conversation";
      runId: string;
      conversationId: string;
      ownerEpoch: number;
    }
  | {
      execution: "job";
      jobRunId: string;
      taskId: string;
      anchorEpoch: number;
    };

export type AuthorityEpochRefFor<E extends ExecutionKind> = Extract<
  AuthorityEpochRef,
  { execution: E }
>;
export type ExecutionRefFor<E extends ExecutionKind> = Extract<
  ExecutionRef,
  { execution: E }
>;

export interface DataPlaneTicketBase extends WireContractV1 {
  ticketId: string;
  ref: ExecutionRef;
  assignmentId: string;
  surfacePrincipal: string;
  executorId: string;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export type DataPlaneTicket = WireSchemaV1<"DataPlaneTicket"> &
  (
    | (DataPlaneTicketBase & { kind: "run-observe"; renewable: true })
    | (DataPlaneTicketBase & { kind: "run-interact"; renewable: true })
    | (DataPlaneTicketBase & { kind: "abort"; renewable: false })
  );

export interface ChannelResponderRef {
  channelId: string;
  platformSubject: string;
  tenant?: string;
}

export interface ChannelChallengeTokenBase<R extends ExecutionRef>
  extends WireContractV1 {
  challengeId: string;
  ref: R;
  assignmentId: string;
  interactionRequestId: string;
  route: DeliveryTargetDto;
  displayDigest: Digest;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export type ConversationChannelChallengeToken = ChannelChallengeTokenBase<
  ExecutionRefFor<"conversation">
>;
export type JobChannelChallengeToken = ChannelChallengeTokenBase<
  ExecutionRefFor<"job">
>;
export type ChannelChallengeToken = WireSchemaV1<"ChannelChallengeToken"> &
  (ConversationChannelChallengeToken | JobChannelChallengeToken);

export interface ChannelMessageRef {
  channelId: string;
  messageId: string;
  threadId?: string;
}

export interface ChannelInteractionGrant
  extends WireSchemaV1<"ChannelInteractionGrant"> {
  grantId: string;
  ref: ExecutionRefFor<"job">;
  assignmentId: string;
  interactionRequestId: string;
  challengeToken: JobChannelChallengeToken;
  route: DeliveryTargetDto;
  responder: ChannelResponderRef;
  decision: { allowed: boolean; reason?: string };
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export type InteractionAnswerAuthority =
  | { via: "surface-ticket"; ticketId: string }
  | { via: "channel-grant"; grant: ChannelInteractionGrant };

export type AuthorityPortMethodId =
  | "session.readSessionMeta"
  | "session.readTranscriptTail"
  | "session.readTaskList"
  | "session.readAdvancementState"
  | "session.mutate"
  | "global.read"
  | "global.mutate"
  | "intent.record"
  | "intent.list"
  | "intent.decide"
  | "reservation.prepareAssignmentRoot"
  | "reservation.prepareSystemJobRoot"
  | "reservation.acquireRoot"
  | "reservation.acquireChild"
  | "reservation.consume"
  | "reservation.settle"
  | "reservation.release"
  | "submission.reportStarted"
  | "submission.submitBundle"
  | "submission.submitCancelProof"
  | "submission.mirrorInteractions"
  | "governor.submitUsageReport"
  | "executor.dispatch"
  | "executor.cancel"
  | "executor.supersede"
  | "executor.queryLedger";

export type AssignmentMethodId = Extract<
  AuthorityPortMethodId,
  | "session.readSessionMeta"
  | "session.readTranscriptTail"
  | "session.readTaskList"
  | "session.readAdvancementState"
  | "session.mutate"
  | "global.read"
  | "global.mutate"
  | "reservation.acquireChild"
  | "reservation.consume"
  | "reservation.settle"
  | "reservation.release"
  | "submission.reportStarted"
  | "submission.submitBundle"
  | "submission.submitCancelProof"
  | "submission.mirrorInteractions"
>;

export type SurfaceMethodId = Extract<
  AuthorityPortMethodId,
  | "session.readSessionMeta"
  | "session.readTranscriptTail"
  | "session.readTaskList"
  | "session.readAdvancementState"
  | "session.mutate"
  | "global.read"
  | "global.mutate"
  | "intent.list"
  | "intent.decide"
>;

export type SubmissionMethodId = Extract<
  AuthorityPortMethodId,
  | "submission.reportStarted"
  | "submission.submitBundle"
  | "submission.submitCancelProof"
  | "submission.mirrorInteractions"
>;

export type OwnerControlMethodId = Extract<
  AuthorityPortMethodId,
  | "executor.dispatch"
  | "executor.cancel"
  | "executor.supersede"
  | "executor.queryLedger"
>;

export type UsageReporterMethodId = Extract<
  AuthorityPortMethodId,
  "governor.submitUsageReport"
>;

export type HostMethodId = Exclude<
  AuthorityPortMethodId,
  OwnerControlMethodId | UsageReporterMethodId | SubmissionMethodId
>;

export interface PrincipalMethodMatrix {
  assignment: AssignmentMethodId;
  surface: SurfaceMethodId;
  host: HostMethodId;
  "owner-control": OwnerControlMethodId;
  "usage-reporter": UsageReporterMethodId;
}

export type ResourceSelector = `${
  | "conversation"
  | "task"
  | "asset"
  | "memory-domain"}:${string}`;

export type AuthorityCapability<E extends ExecutionKind = ExecutionKind> =
  WireSchemaV1<"AuthorityCapability"> &
    (E extends "conversation"
      ? {
          capId: string;
          executorId: string;
          scope: { execution: "conversation"; conversationId: string };
          ownerEpoch: number;
          methods: AssignmentMethodId[];
          resources: ResourceSelector[];
          assignmentId: string;
          issuedAt: IsoTime;
          expiry: IsoTime;
          signature: Signature;
        }
      : {
          capId: string;
          executorId: string;
          scope: { execution: "job"; taskId: string };
          anchorEpoch: number;
          methods: AssignmentMethodId[];
          resources: ResourceSelector[];
          assignmentId: string;
          issuedAt: IsoTime;
          expiry: IsoTime;
          signature: Signature;
        });

export type AdmissionClass =
  | "interactive"
  | "advancement"
  | "scheduler"
  | "orchestration";

export interface ResourceLease extends WireSchemaV1<"ResourceLease"> {
  reservationId: string;
  parentId?: string;
  admissionClass: AdmissionClass;
  workload: {
    kind: "run" | "job" | "orchestration-node" | "control" | "evidence";
    id: string;
    attempt: number;
  };
  scopeBinding:
    | { kind: "conversation"; conversationId: string; ownerEpoch: number }
    | { kind: "job"; taskId: string; anchorEpoch: number }
    | { kind: "control"; subject: string };
  audience: { executorId?: string; provider?: string; model?: string };
  budget: { maxTokens?: number; maxCalls?: number; maxCostMinor?: number };
  domain:
    | { kind: "anchor"; anchorEpoch: number }
    | {
        kind: "local";
        localDomainId: string;
        localGovernorEpoch: number;
      };
  delegation?: {
    executorId: string;
    maxDepth: number;
    maxBudget: {
      maxTokens?: number;
      maxCalls?: number;
      maxCostMinor?: number;
    };
  };
  parentDigest?: Digest;
  issuedAt: IsoTime;
  expiry: IsoTime;
  digest: Digest;
  signature: Signature;
}

export type AssignmentWorkload =
  | { kind: "run"; id: string; attempt: number }
  | { kind: "job"; id: string; attempt: number };

type ConversationAssignmentLease = Omit<
  ResourceLease,
  "parentId" | "parentDigest" | "workload" | "scopeBinding" | "audience"
> & {
  parentId?: never;
  parentDigest?: never;
  workload: Extract<AssignmentWorkload, { kind: "run" }>;
  scopeBinding: Extract<
    ResourceLease["scopeBinding"],
    { kind: "conversation" }
  >;
  audience: ResourceLease["audience"] & { executorId: string };
  activation: { kind: "assignment"; assignmentId: string };
};

type JobAssignmentLease = Omit<
  ResourceLease,
  | "parentId"
  | "parentDigest"
  | "workload"
  | "scopeBinding"
  | "audience"
  | "domain"
> & {
  parentId?: never;
  parentDigest?: never;
  workload: Extract<AssignmentWorkload, { kind: "job" }>;
  scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
  audience: ResourceLease["audience"] & { executorId: string };
  domain: Extract<ResourceLease["domain"], { kind: "anchor" }>;
  activation: { kind: "assignment"; assignmentId: string };
};

export type AssignmentResourceLease<
  E extends ExecutionKind = ExecutionKind,
> = E extends "conversation" ? ConversationAssignmentLease : JobAssignmentLease;

export type ImmediateRootWorkload = {
  kind: "control";
  id: string;
  attempt: number;
};

export type SystemJobResourceLease = Omit<
  ResourceLease,
  "parentId" | "parentDigest" | "workload" | "scopeBinding" | "domain"
> & {
  parentId?: never;
  parentDigest?: never;
  workload: Extract<AssignmentWorkload, { kind: "job" }>;
  scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
  domain: Extract<ResourceLease["domain"], { kind: "anchor" }>;
  activation: { kind: "system-job"; jobRunId: string };
};

export type ImmediateRootResourceLease = Omit<
  ResourceLease,
  "parentId" | "parentDigest" | "workload"
> & {
  parentId?: never;
  parentDigest?: never;
  workload: ImmediateRootWorkload;
};

export type ChildResourceLease = Omit<
  ResourceLease,
  "parentId" | "parentDigest" | "workload"
> & {
  parentId: string;
  parentDigest: Digest;
  workload: {
    kind: "orchestration-node" | "evidence";
    id: string;
    attempt: number;
  };
};

export type ReservableResourceLease =
  | AssignmentResourceLease
  | SystemJobResourceLease
  | ImmediateRootResourceLease
  | ChildResourceLease;

export type AssignmentReservationRequest<
  E extends ExecutionKind = ExecutionKind,
> = E extends "conversation"
  ? {
      assignmentId: string;
      executorId: string;
      workload: Extract<AssignmentWorkload, { kind: "run" }>;
      scopeBinding: Extract<
        ResourceLease["scopeBinding"],
        { kind: "conversation" }
      >;
      budget: ResourceLease["budget"];
    }
  : {
      assignmentId: string;
      executorId: string;
      workload: Extract<AssignmentWorkload, { kind: "job" }>;
      scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
      budget: ResourceLease["budget"];
    };

export interface SystemJobReservationRequest {
  workload: Extract<AssignmentWorkload, { kind: "job" }>;
  scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
  budget: ResourceLease["budget"];
}

export interface UsageReport extends WireSchemaV1<"UsageReport"> {
  reporterId: string;
  rootReservationId: string;
  workloadRef:
    | { kind: "assignment"; assignmentId: string }
    | { kind: "evidence"; requestId: string };
  fromUsageSeq: number;
  toUsageSeq: number;
  usages: Array<{
    usageSeq: number;
    reservationId: string;
    usageId: string;
    tokens?: number;
    calls?: number;
    costMinor?: number;
  }>;
  digest: Digest;
  signature: Signature;
}

export interface ControlLease extends WireSchemaV1<"ControlLease"> {
  controlLeaseId: string;
  assignmentId: string;
  authority: AuthorityEpochRef;
  renewalSeq: number;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export type PermissionLeaseDigest = Digest;

export interface PermissionSnapshotLease<
  E extends ExecutionKind = ExecutionKind,
> extends WireSchemaV1<"PermissionSnapshotLease"> {
  snapshotVersion: number;
  snapshotDigest: Digest;
  binding: ExecutionRefFor<E>;
  assignmentId: string;
  executorId: string;
  controlLeaseId: string;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}

export interface AssignmentActivationProof<
  E extends ExecutionKind = ExecutionKind,
> extends WireSchemaV1<"AssignmentActivationProof"> {
  ref: ExecutionRefFor<E>;
  assignmentId: string;
  executorId: string;
  dispatchRef: ArtifactRef;
  manifestDigest: Digest;
  permissionLeaseDigest: PermissionLeaseDigest;
  capIds: string[];
  reservation: { reservationId: string; attempt: number };
  commit: { lsn: number; envelopeDigest: Digest };
  issuedAt: IsoTime;
  signature: Signature;
}

export type AssignmentActivationPayload<
  E extends ExecutionKind = ExecutionKind,
> = Omit<AssignmentActivationProof<E>, "signature">;

export interface OwnerControlGrant extends WireSchemaV1<"OwnerControlGrant"> {
  assignmentId: string;
  scope: AuthorityEpochRef;
  methods: OwnerControlMethodId[];
  callerDeviceId: string;
  requestId: string;
  requestDigest: Digest;
  controlLease: ControlLease;
  issuedAt: IsoTime;
  expiry: IsoTime;
  signature: Signature;
}
