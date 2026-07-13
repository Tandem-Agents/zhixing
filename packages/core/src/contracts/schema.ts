import type { TrustRuleSnapshot } from "../security/types.js";
import type { CommitEnvelope } from "./commit-log.js";
import type {
  AnchorTransferCommit,
  CheckpointEnvelope,
  ConversationTransferCommit,
  HomeTrustEvent,
  HomeTrustRecord,
  PairingAcceptance,
  PairingJoin,
  PairingOffer,
  PakeRound,
  RecoveryActivationPlan,
  RecoveryCheckpointVerification,
  SourceFreezeProof,
} from "./identity.js";
import type {
  AssignmentActivationProof,
  AuthorityCapability,
  ChannelChallengeToken,
  ChannelInteractionGrant,
  ControlLease,
  DataPlaneTicket,
  OwnerControlGrant,
  PermissionSnapshotLease,
  ResourceLease,
  UsageReport,
} from "./authorization.js";
import type { ConfigAssetRecord } from "./state.js";
import type {
  CapabilityDescriptor,
  ControlEnvelope,
  DispatchEnvelope,
  EnvironmentControlGrant,
  EvidenceBundle,
  EvidenceRequest,
  ExecutionAbortRequest,
  ExecutionManifest,
  ExecutionStatusNotice,
  ExecutorVersionInventory,
  FinalFrame,
  JobCommitFence,
  SealedBundle,
  StreamAck,
  StreamFrame,
  StreamSubscribe,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "./protocol.js";
import type {
  AssignmentRecord,
  CancelProofBody,
  ControlResult,
  DispatchConflictProof,
  DispatchRejectionProof,
  MutationBatch,
  SupersedeProof,
} from "./records.js";
import type {
  DispatchResult,
  LedgerEvidencePage,
  LedgerSnapshot,
} from "./ports.js";

/** 顶层 wire schema 的单一类型注册表。 */
export interface WireSchemaMap {
  CommitEnvelope: CommitEnvelope;
  HomeTrustEvent: HomeTrustEvent;
  HomeTrustRecord: HomeTrustRecord;
  AnchorTransferCommit: AnchorTransferCommit;
  SourceFreezeProof: SourceFreezeProof;
  ConversationTransferCommit: ConversationTransferCommit;
  PairingOffer: PairingOffer;
  PairingJoin: PairingJoin;
  PakeRound: PakeRound;
  PairingAcceptance: PairingAcceptance;
  RecoveryActivationPlan: RecoveryActivationPlan;
  RecoveryCheckpointVerification: RecoveryCheckpointVerification;
  CheckpointEnvelope: CheckpointEnvelope;
  TrustRuleSnapshot: TrustRuleSnapshot;
  DataPlaneTicket: DataPlaneTicket;
  ChannelChallengeToken: ChannelChallengeToken;
  ChannelInteractionGrant: ChannelInteractionGrant;
  AuthorityCapability: AuthorityCapability;
  ResourceLease: ResourceLease;
  UsageReport: UsageReport;
  ControlLease: ControlLease;
  PermissionSnapshotLease: PermissionSnapshotLease;
  AssignmentActivationProof: AssignmentActivationProof;
  OwnerControlGrant: OwnerControlGrant;
  ConfigAssetRecord: ConfigAssetRecord;
  ControlEnvelope: ControlEnvelope;
  CapabilityDescriptor: CapabilityDescriptor;
  ExecutorVersionInventory: ExecutorVersionInventory;
  ExecutionManifest: ExecutionManifest;
  EnvironmentControlGrant: EnvironmentControlGrant;
  WorkspaceProbeRequest: WorkspaceProbeRequest;
  WorkspaceProbeResult: WorkspaceProbeResult;
  JobCommitFence: JobCommitFence;
  DispatchEnvelope: DispatchEnvelope;
  SealedBundle: SealedBundle;
  ExecutionStatusNotice: ExecutionStatusNotice;
  StreamFrame: StreamFrame;
  FinalFrame: FinalFrame;
  StreamSubscribe: StreamSubscribe;
  StreamAck: StreamAck;
  EvidenceRequest: EvidenceRequest;
  EvidenceBundle: EvidenceBundle;
  ExecutionAbortRequest: ExecutionAbortRequest;
  ControlResult: ControlResult;
  DispatchRejectionProof: DispatchRejectionProof;
  DispatchConflictProof: DispatchConflictProof;
  SupersedeProof: SupersedeProof;
  CancelProofBody: CancelProofBody;
  AssignmentRecord: AssignmentRecord;
  MutationBatch: MutationBatch;
  LedgerSnapshot: LedgerSnapshot;
  LedgerEvidencePage: LedgerEvidencePage;
  DispatchResult: DispatchResult;
}

export type WireSchemaId = keyof WireSchemaMap;
export type WireSchemaVersion = { [K in WireSchemaId]: 1 };

type Assert<T extends true> = T;
type EverySchemaIsV1 = {
  [K in WireSchemaId]: [WireSchemaMap[K]] extends [{ readonly v: 1 }]
    ? true
    : false;
}[WireSchemaId] extends true
  ? true
  : false;

/** 编译失败即表示注册 schema 缺少或混入了非 v1 顶层合同。 */
export type WireSchemaVersionInvariant = Assert<EverySchemaIsV1>;
