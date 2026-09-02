import {
  assertLocalConversationIdForDevice,
  isLocalConversationId,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  AuthorityError,
  GlobalStatePort,
  ResourceReservationPort,
  TrustRuleSnapshot,
  UsageReport,
} from "@zhixing/core/contracts";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import type {
  ExecutorCapabilityDirectory,
  GovernorProjection,
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import { protocolDigest } from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { ExecutorAssignmentResourceCoordinator } from "@zhixing/executor";
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
    reclaimExpired(): Promise<number>;
  };

export interface ConversationResourceRecoveryPort {
  reclaimExpired(): Promise<number>;
  activeConversationReservations(): Promise<readonly {
    readonly reservationId: string;
    readonly conversationId: string;
    readonly ownerEpoch: number;
    readonly revision: string;
  }[]>;
}

interface ConversationResourceReclaimer {
  reclaimExpired(): Promise<number>;
}

interface ConversationResourceReservationReader {
  snapshot(): Promise<GovernorProjection>;
}

/** Correctness adapter for owner recovery; consumers never receive a governor snapshot. */
export function createConversationResourceRecoveryPort(options: {
  readonly primary: ConversationResourceReclaimer;
  readonly additionalRecovery?: ConversationResourceReclaimer;
  readonly acceptedWork?: ConversationResourceReservationReader;
}): ConversationResourceRecoveryPort {
  return Object.freeze({
    reclaimExpired: async () => {
      const primary = await options.primary.reclaimExpired();
      return options.additionalRecovery && options.additionalRecovery !== options.primary
        ? primary + await options.additionalRecovery.reclaimExpired()
        : primary;
    },
    activeConversationReservations: async () => {
      if (!options.acceptedWork) return [];
      const projection = await options.acceptedWork.snapshot();
      return [...projection.reservations.entries()]
        .filter(([, reservation]) =>
          reservation.state === "active" &&
          reservation.lease.scopeBinding.kind === "conversation"
        )
        .map(([reservationId, reservation]) => {
          const scope = reservation.lease.scopeBinding;
          if (scope.kind !== "conversation") {
            throw new Error("Conversation resource projection changed during filtering");
          }
          return Object.freeze({
            reservationId,
            conversationId: scope.conversationId,
            ownerEpoch: scope.ownerEpoch,
            revision: protocolDigest("ActiveLocalLeaseClosure", 1, reservation),
          });
        });
    },
  });
}

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
  readonly executionResources?: ResourceReservationPort;
  readonly assignmentResources?: ExecutorAssignmentResourceCoordinator;
  readonly resourceRecovery: ConversationResourceRecoveryPort;
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
    contextFor: (report: UsageReport) => AuthorityCallContext,
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
  readonly executionResources: ResourceReservationPort;
  readonly assignmentResources: ExecutorAssignmentResourceCoordinator;
  readonly executionAssetCatalog: ExecutionAssetCatalogPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly globalPublishing: false;
}

export function anchorConversationOwnerRuntime(
  authority: AuthorityRuntimeStack,
): ConversationOwnerRuntimeStack {
  return {
    get domain() {
      return { kind: "anchor" as const, anchorEpoch: authority.anchorEpoch };
    },
    get ownerEpoch() {
      return authority.anchorEpoch;
    },
    deviceId: authority.deviceId,
    executorId: authority.executorId,
    signer: authority.signer,
    verifier: authority.verifier,
    get log() {
      return authority.authorityLog;
    },
    get authorityLog() {
      return authority.authorityLog;
    },
    ...(authority.localExecutorEnabled
      ? { executorLog: authority.executorLog }
      : {}),
    artifacts: authority.artifacts,
    get controlAdmission() {
      return authority.controlAdmission;
    },
    executorCapabilities: authority.executorCapabilities,
    get resources() {
      return authority.resourceGovernor;
    },
    ...(authority.localExecutorEnabled
      ? {
          executionResources: authority.executorResourceGovernor,
          assignmentResources: authority.executorResourceGovernor,
        }
      : {}),
    resourceRecovery: createConversationResourceRecoveryPort({
      primary: authority.resourceGovernor,
      ...(authority.localExecutorEnabled
        ? {
            additionalRecovery: authority.executorResourceGovernor,
            acceptedWork: authority.executorResourceGovernor,
          }
        : {}),
    }),
    get surfaceAssets() {
      return authority.surfaceAssets;
    },
    get delivery() {
      return authority.participant;
    },
    get participant() {
      return authority.participant;
    },
    get globalState() {
      return authority.globalState;
    },
    executionAssetCatalog: authority.executionAssetCatalog,
    globalPublishing: true,
    get anchorEpoch() {
      return authority.anchorEpoch;
    },
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
> & {
  readonly resources: ConversationOwnerResourceAuthority;
  readonly executionResources: ResourceReservationPort;
  readonly assignmentResources: ExecutorAssignmentResourceCoordinator;
  readonly resourceRecovery: ConversationResourceRecoveryPort;
  readonly finalizeUsage: ConversationOwnerRuntimeStack["finalizeUsage"];
};

export function localConversationOwnerRuntime(
  deps: LocalConversationOwnerRuntimeDependencies,
): LocalConversationOwnerRuntimeStack {
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
    resources: deps.resources,
    executionResources: deps.executionResources,
    assignmentResources: deps.assignmentResources,
    resourceRecovery: deps.resourceRecovery,
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
    finalizeUsage: deps.finalizeUsage,
  };
}
