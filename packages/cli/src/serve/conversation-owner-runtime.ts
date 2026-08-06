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

export function localConversationOwnerRuntime(
  authority: AuthorityRuntimeStack,
): LocalConversationOwnerRuntimeStack {
  const resources = authority.executorResourceGovernor as ConversationOwnerResourceAuthority;
  return {
    domain: {
      kind: "local",
      localDomainId: authority.localDomainId,
      localOwnerEpoch: authority.localOwnerEpoch,
      localGovernorEpoch: authority.localGovernorEpoch,
    },
    ownerEpoch: authority.localOwnerEpoch,
    deviceId: authority.deviceId,
    executorId: authority.executorId,
    signer: authority.signer,
    verifier: authority.verifier,
    log: authority.executorLog,
    authorityLog: authority.executorLog,
    executorLog: authority.executorLog,
    artifacts: authority.artifacts,
    controlAdmission: authority.localControlAdmission,
    executorCapabilities: authority.executorCapabilities,
    resources,
    resourceGovernor: resources,
    executorResources: authority.executorResourceGovernor,
    executorResourceGovernor: authority.executorResourceGovernor,
    executionAssetCatalog: authority.executionAssetCatalog,
    globalPublishing: false,
    anchorEpoch: authority.localOwnerEpoch,
    acceptsConversationId(conversationId) {
      try {
        assertLocalConversationIdForDevice(conversationId, authority.deviceId);
        return true;
      } catch {
        return false;
      }
    },
    permissionSnapshotFor: authority.permissionSnapshotFor,
    prepareConversationAssignment: (input) =>
      authority.prepareLocalConversationAssignment({
        conversationId: input.conversationId,
        executionProfile: input.executionProfile,
        permissionRules: input.permissionRules,
        ...(input.environment ? { environment: input.environment } : {}),
      }),
    validateConversationRuntimeBinding: authority.validateConversationRuntimeBinding,
    preflightLocalConversationEnvironment:
      authority.preflightLocalConversationEnvironment,
    releaseLocalConversationEnvironmentPreflight:
      authority.releaseLocalConversationEnvironmentPreflight,
    validateLocalConversationManifest: authority.validateLocalConversationManifest,
    finalizeUsage: (assignmentId) =>
      authority.executorResourceGovernor.finalizeLocalAssignment(assignmentId),
  };
}
