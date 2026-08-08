import {
  assertLocalConversationIdForDevice,
  isLocalConversationId,
} from "@zhixing/core";
import type {
  AuthorityError,
  GlobalStatePort,
  ResourceReservationPort,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import type {
  ExecutorCapabilityDirectory,
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { ExecutorResourceGovernor } from "@zhixing/executor";
import type {
  AssignmentResourceCoordinator,
  ControlAdmissionJournal,
  ConversationDeliveryParticipant,
} from "@zhixing/owner-kernel";
import type {
  AuthorityRuntimeStack,
  PreparedConversationAssignmentAuthority,
} from "../setup-delivery.js";
import type { ExecutionAssetCatalogPort } from "./execution-asset-cache.js";

export type ConversationOwnerDomain =
  | { readonly kind: "anchor"; readonly anchorEpoch: number }
  | {
      readonly kind: "local";
      readonly localDomainId: string;
      readonly localOwnerEpoch: number;
      readonly localGovernorEpoch: number;
    };

export type ConversationOwnerResourceAuthority = ResourceReservationPort &
  AssignmentResourceCoordinator & {
    enqueueRoot: AuthorityRuntimeStack["resourceGovernor"]["enqueueRoot"];
    reclaimExpired(): Promise<number>;
  };

export interface ConversationOwnerRuntimeStack {
  readonly domain: ConversationOwnerDomain;
  readonly ownerEpoch: number;
  readonly deviceId: string;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly log: AuthorityCommitLog;
  /** Compatibility aliases kept inside the composition boundary while consumers are domain-neutral. */
  readonly authorityLog: AuthorityCommitLog;
  readonly executorLog?: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly controlAdmission: ControlAdmissionJournal;
  readonly executorCapabilities: ExecutorCapabilityDirectory;
  readonly resources: ConversationOwnerResourceAuthority;
  readonly resourceGovernor: ConversationOwnerResourceAuthority;
  readonly executorResources?: ExecutorResourceGovernor;
  readonly executorResourceGovernor?: ExecutorResourceGovernor;
  readonly surfaceAssets?: SurfaceAssetCoordinator;
  readonly delivery?: ConversationDeliveryParticipant;
  readonly participant?: ConversationDeliveryParticipant;
  readonly globalState?: GlobalStatePort;
  readonly executionAssetCatalog?: ExecutionAssetCatalogPort;
  readonly globalPublishing: boolean;
  readonly anchorEpoch: number;
  acceptsConversationId(conversationId: string): boolean;
  permissionSnapshotFor(digest: string): TrustRuleSnapshot | undefined;
  prepareConversationAssignment(
    input: Parameters<AuthorityRuntimeStack["prepareConversationAssignment"]>[0],
  ): Promise<PreparedConversationAssignmentAuthority>;
  validateConversationRuntimeBinding: AuthorityRuntimeStack["validateConversationRuntimeBinding"];
  preflightLocalConversationEnvironment: AuthorityRuntimeStack["preflightLocalConversationEnvironment"];
  releaseLocalConversationEnvironmentPreflight: AuthorityRuntimeStack["releaseLocalConversationEnvironmentPreflight"];
  validateLocalConversationManifest(
    manifest: Parameters<AuthorityRuntimeStack["validateLocalConversationManifest"]>[0],
  ): AuthorityError | undefined;
  finalizeUsage(
    assignmentId: string,
    contextFor: Parameters<ExecutorResourceGovernor["flushAssignment"]>[2],
  ): Promise<{ readonly reportDigest: string; readonly upToUsageSeq: number }>;
}

export interface LocalConversationOwnerRuntimeStack
  extends Omit<
    ConversationOwnerRuntimeStack,
    | "domain"
    | "surfaceAssets"
    | "delivery"
    | "participant"
    | "globalState"
    | "globalPublishing"
  > {
  readonly domain: Extract<ConversationOwnerDomain, { readonly kind: "local" }>;
  readonly surfaceAssets?: never;
  readonly delivery?: never;
  readonly participant?: never;
  readonly globalState?: never;
  readonly executorLog: AuthorityCommitLog;
  readonly executorResources: ExecutorResourceGovernor;
  readonly executorResourceGovernor: ExecutorResourceGovernor;
  readonly executionAssetCatalog: ExecutionAssetCatalogPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly globalPublishing: false;
}

export function anchorConversationOwnerRuntime(
  authority: AuthorityRuntimeStack,
): ConversationOwnerRuntimeStack {
  return {
    domain: { kind: "anchor", anchorEpoch: authority.anchorEpoch },
    ownerEpoch: authority.anchorEpoch,
    deviceId: authority.deviceId,
    executorId: authority.executorId,
    signer: authority.signer,
    verifier: authority.verifier,
    log: authority.authorityLog,
    authorityLog: authority.authorityLog,
    ...(authority.localExecutorEnabled
      ? { executorLog: authority.executorLog }
      : {}),
    artifacts: authority.artifacts,
    controlAdmission: authority.controlAdmission,
    executorCapabilities: authority.executorCapabilities,
    resources: authority.resourceGovernor,
    resourceGovernor: authority.resourceGovernor,
    ...(authority.localExecutorEnabled
      ? {
          executorResources: authority.executorResourceGovernor,
          executorResourceGovernor: authority.executorResourceGovernor,
        }
      : {}),
    surfaceAssets: authority.surfaceAssets,
    delivery: authority.participant,
    participant: authority.participant,
    ...(authority.globalState ? { globalState: authority.globalState } : {}),
    executionAssetCatalog: authority.executionAssetCatalog,
    globalPublishing: true,
    anchorEpoch: authority.anchorEpoch,
    acceptsConversationId: (conversationId) => !isLocalConversationId(conversationId),
    permissionSnapshotFor: authority.permissionSnapshotFor,
    prepareConversationAssignment: authority.prepareConversationAssignment,
    validateConversationRuntimeBinding: authority.validateConversationRuntimeBinding,
    preflightLocalConversationEnvironment:
      authority.preflightLocalConversationEnvironment,
    releaseLocalConversationEnvironmentPreflight:
      authority.releaseLocalConversationEnvironmentPreflight,
    validateLocalConversationManifest: authority.validateLocalConversationManifest,
    finalizeUsage: async (assignmentId, contextFor) => {
      const domain = await authority.executorResourceGovernor.assignmentDomain(
        assignmentId,
      );
      return domain?.kind === "local"
        ? authority.executorResourceGovernor.finalizeLocalAssignment(assignmentId)
        : authority.executorResourceGovernor.flushAssignment(
            assignmentId,
            authority.resourceGovernor,
            contextFor,
          );
    },
  };
}

/**
 * 本地域 owner 工厂实际读取的依赖全集:两个生产组合根各以显式对象字面量
 * 构造传入,完整 AuthorityRuntimeStack 不作为运行值进入本地域构造闭包;
 * 键集冻结,由结构门禁对工厂参数与两处字面量逐键机械核对。
 */
export type LocalConversationOwnerRuntimeDependencies = Pick<
  AuthorityRuntimeStack,
  | "artifacts"
  | "deviceId"
  | "executorCapabilities"
  | "executorId"
  | "executorLog"
  | "executorResourceGovernor"
  | "executionAssetCatalog"
  | "localControlAdmission"
  | "localDomainId"
  | "localGovernorEpoch"
  | "localOwnerEpoch"
  | "permissionSnapshotFor"
  | "preflightLocalConversationEnvironment"
  | "prepareLocalConversationAssignment"
  | "releaseLocalConversationEnvironmentPreflight"
  | "signer"
  | "storageMaintenance"
  | "validateConversationRuntimeBinding"
  | "validateLocalConversationManifest"
  | "verifier"
>;

export function localConversationOwnerRuntime(
  deps: LocalConversationOwnerRuntimeDependencies,
): LocalConversationOwnerRuntimeStack {
  const resources = deps.executorResourceGovernor as ConversationOwnerResourceAuthority;
  return {
    domain: {
      kind: "local",
      localDomainId: deps.localDomainId,
      localOwnerEpoch: deps.localOwnerEpoch,
      localGovernorEpoch: deps.localGovernorEpoch,
    },
    ownerEpoch: deps.localOwnerEpoch,
    deviceId: deps.deviceId,
    executorId: deps.executorId,
    signer: deps.signer,
    verifier: deps.verifier,
    log: deps.executorLog,
    authorityLog: deps.executorLog,
    executorLog: deps.executorLog,
    artifacts: deps.artifacts,
    controlAdmission: deps.localControlAdmission,
    executorCapabilities: deps.executorCapabilities,
    resources,
    resourceGovernor: resources,
    executorResources: deps.executorResourceGovernor,
    executorResourceGovernor: deps.executorResourceGovernor,
    executionAssetCatalog: deps.executionAssetCatalog,
    storageMaintenance: deps.storageMaintenance,
    globalPublishing: false,
    anchorEpoch: deps.localOwnerEpoch,
    acceptsConversationId(conversationId) {
      try {
        assertLocalConversationIdForDevice(conversationId, deps.deviceId);
        return true;
      } catch {
        return false;
      }
    },
    permissionSnapshotFor: deps.permissionSnapshotFor,
    prepareConversationAssignment: (input) =>
      deps.prepareLocalConversationAssignment({
        conversationId: input.conversationId,
        executionProfile: input.executionProfile,
        permissionRules: input.permissionRules,
        ...(input.environment ? { environment: input.environment } : {}),
      }),
    validateConversationRuntimeBinding: deps.validateConversationRuntimeBinding,
    preflightLocalConversationEnvironment:
      deps.preflightLocalConversationEnvironment,
    releaseLocalConversationEnvironmentPreflight:
      deps.releaseLocalConversationEnvironmentPreflight,
    validateLocalConversationManifest: deps.validateLocalConversationManifest,
    finalizeUsage: (assignmentId) =>
      deps.executorResourceGovernor.finalizeLocalAssignment(assignmentId),
  };
}
