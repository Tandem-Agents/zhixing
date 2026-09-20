/**
 * Concrete Host factories. Each factory receives only its construction inputs
 * and returns its products; command.ts connects the static graph and owns
 * activation. Lifecycle contributions retain the shared rollback/normal-close
 * handles, not references to services or a general-purpose setup registry.
 */
import { createHostAdvancementModelProviderFactory } from "../runtime/advancement-model-provider.js";
import { WorksceneContinuationApplication } from "@zhixing/core/workscene/application";
import { createWorksceneContinuationPort } from "./workscene-continuation-adapter.js";
import {
  createExecutorLocalWorkspaceHost,
  type LocalWorkspaceAssemblyIdentity,
} from "../runtime/local-workspace-bootstrap.js";
import type {
  RuntimeAdvancementConfigurationProjection,
  RuntimeChannelConfigurationProjection,
} from "../runtime/runtime-configuration-projections.js";
import { type AuthorityRuntimeStack, setupDelivery } from "../setup-delivery.js";
import type {
  AdvancementConversationComposition,
  ConversationRuntimeStoragePort,
  MeshRuntimePreparation,
  PreparedChannelMechanism,
  StartupLifecycleRestoration,
} from "./access-surface.js";
import {
  type AdvancementEvidenceHostBindingPort,
  AdvancementEvidenceTopologyAdapter,
} from "./advancement-evidence-topology.js";
import type { AssemblyLifecycleContributions } from "./assembly-lifecycle.js";
import {
  createAssignmentArtifactReceiverInfrastructure,
} from "./assignment-artifact-receiver-infrastructure.js";
import type { AssignmentArtifactReceiverPort } from "./assignment-artifact-receiver.js";
import { AssignmentDataPlaneTopologyAdapter } from "./assignment-data-plane-topology.js";
import { createAssignmentGlobalQueryPort } from "./assignment-global-state-ports.js";
import { AssignmentInteractionRouter } from "./assignment-operations-router.js";
import { ChannelConversationProductBinding } from "./channel-conversation-product-binding.js";
import {
  type ChannelInteractionCoordinator,
  JobRelayObligationDirectory,
} from "./channel-interaction-coordinator.js";
import { createInboundChannelRouter, setupChannels } from "./channels.js";
import { ChannelConfiguration } from "../runtime/extensions/channel-configuration.js";
import { createAnchorConversationDeleteProjectionPort } from "./conversation-delete-binding.js";
import { createConversationEvidenceAuthorityVerifier } from "./conversation-evidence-authority.js";
import {
  type ConversationExecutorTopologyDirectory,
  createConversationAssignmentArtifactAuthorityIndex,
  createConversationExecutorHostBoundary,
  NO_REMOTE_CONVERSATION_EXECUTORS,
} from "./conversation-executor-dispatch.js";
import {
  anchorConversationOwnerRuntime,
  createConversationResourceRecoveryPort,
  localConversationOwnerRuntime,
} from "./conversation-owner-runtime.js";
import { projectConversationPerspectivesRuntime } from "./conversation-perspectives-correctness.js";
import {
  ConversationProtocolRuntime,
  createConversationAuxiliaryRecoveryAssemblyHandle,
  createConversationCommittedTurnListenerAssemblyHandle,
  createConversationManagerAssemblyHandle,
  type DurableConversationInteractionObserver,
} from "./conversation-protocol-runtime.js";
import {
  createConversationTransferStagingInfrastructure,
} from "./conversation-transfer-staging-infrastructure.js";
import { JobInteractionRuntimeUnavailableError } from "./durable-job-interactions.js";
import {
  createExecutorDataPlaneAssignmentPair,
  type ExecutorDataPlaneRuntime,
} from "./executor-data-plane-runtime.js";
import { type ExecutorJobOwner, ExecutorJobOwnerAssembly } from "./executor-job-owner.js";
import { governControlTextCall } from "./governed-control-llm.js";
import type { JobRuntimePort } from "./job-assignment-worker.js";
import { JobStatusDirectory } from "./job-status-directory.js";
import { LocalConversationOwnerAssembly } from "./local-conversation-owner.js";
import {
  type ConversationLosslessDataPlaneAssemblyHandle,
  createLosslessDataPlaneComposition,
  type LosslessDataPlaneComposition,
} from "./lossless-data-plane-composition.js";
import { createFileMeshPairingContinuationRepository } from "./mesh-pairing-continuation.js";
import {
  executorIdForDevice,
  MeshConversationExecutorTopologyDirectory,
  MeshRuntimeAssembly,
  type MeshRuntimeAssemblyOptions,
} from "./mesh-runtime-assembly.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import {
  createPersistentPairedCheckpointCommandReceiverInfrastructure,
} from "./paired-checkpoint-incoming-infrastructure.js";
import type { ExecutorRoleModule } from "./role-topology.js";
import type { StartupRollback } from "./startup-rollback.js";
import { SurfaceAssetMaintenance } from "./surface-asset-maintenance.js";
import { createTurnMaintenance, type NamerConversationRepo } from "./turn-maintenance.js";
import {
  createAnchorWorksceneAdvancementApplicationPort,
  createAnchorWorksceneApplicationPorts,
} from "./workscene-application-adapter.js";
import type { AnchorWorksceneAuthorityProjection } from "./workscene-authority-projection.js";
import { createWorksceneDirectory } from "./workscene-directory.js";
import type { WorksceneSceneStorageRemovalPort } from "./workscene-storage-removal.js";
import {
  AdvancementAcceptedTurnApplicationService,
  AdvancementReviewResultProjectionApplicationService,
} from "@zhixing/core/advancement/application";
import type {
  AuthorityCallContext,
  DeviceRole,
  EvidenceHandlerPort,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  type ConversationClearProjectionPort,
  type ConversationCommittedViewStorage,
  type ConversationIdentityLifecycleApplication,
  type ConversationPerspectivesApplication,
  createConversationTaskListChangedFact,
  projectConversationClear,
  projectConversationDelete,
  type TaskListService,
} from "@zhixing/core/conversation/application";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  WorksceneApplicationService,
  type WorksceneConversationStorageProjectionCleanupPort,
} from "@zhixing/core/workscene/application";
import type { ConversationAssignmentLedger } from "@zhixing/executor";
import type { MeshConnectionRegistry } from "@zhixing/mesh/bootstrap";
import { EvidenceJournal, ExecutorEvidenceHandler } from "@zhixing/orchestrator/advancement";
import type { AgentRuntimeCapacityBinding } from "@zhixing/orchestrator/runtime";
import type { ConfirmationHub } from "@zhixing/owner-kernel/confirmation-hub";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import type { RuntimeFactory } from "@zhixing/owner-kernel/types";
import {
  type AdvancementConversationDirectory,
  createAdvancementRecoveryMaintenance,
  renderRecentContextFromMessages,
} from "@zhixing/owner-services/advancement";
import {
  createAdvancementReviewProxySchedulePort,
} from "@zhixing/owner-services/advancement/proxy-scheduler";
import type { ProviderCredentialProjection } from "@zhixing/providers";
import {
  createConfirmationBridge,
  createControlSessionEventEnvelope,
  SESSION_NOTIFICATIONS,
  type SessionActivityBroadcast,
  type SessionBroadcast,
  type SessionChangedPayload,
} from "@zhixing/rpc";
import {
  createAdvancementEventSink,
  createAdvancementOriginalTaskAdmissionPort,
  createAdvancementProxyTurnPort,
  type RunningServer,
} from "@zhixing/server";
import chalk from "chalk";
import path from "node:path";

/** Durable authority substrate shared by conversation and delivery composition. */
export interface PrepareAuthorityServicesInput {
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly enabledRoles: readonly DeviceRole[];
  readonly localWorkspaceIdentity: LocalWorkspaceAssemblyIdentity;
  readonly zhixingHome: string;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly advancementCapacity: AgentRuntimeCapacityBinding;
  readonly meshBootstrap: MeshRuntimeBootstrap;
  readonly meshExecutorTopologyTrust?: import("./mesh-runtime-assembly.js").MeshExecutorTopologyTrustState;
}

export async function prepareAuthorityServices(
  input: PrepareAuthorityServicesInput,
) {
  const { meshBootstrap: inputMeshBootstrap, meshExecutorTopologyTrust: inputMeshExecutorTopologyTrust } = input;
  const authorityRuntime = input.authorityRuntime;
  if (!authorityRuntime) {
    throw new Error("Authority integration requires the prepared Authority runtime");
  }
  const jobRelayObligations = new JobRelayObligationDirectory();
  let evidenceHandler: (EvidenceHandlerPort & { stopAccepting(): void }) | undefined;
  if (input.enabledRoles.includes("executor")) {
    const admin = authorityRuntime.workspaceBindingAdmin;
    const recovery = authorityRuntime.workspaceBindingRecovery;
    if (!admin || !recovery) throw new Error("Local workspace management ports are unavailable");
    const host = createExecutorLocalWorkspaceHost({
      identity: input.localWorkspaceIdentity,
      host: {
        zhixingHome: input.zhixingHome,
        management: {
          deviceId: authorityRuntime.deviceId,
          executorId: executorIdForDevice(authorityRuntime.deviceId),
          admin,
          recovery,
          resources: authorityRuntime.executorResourceGovernor,
        },
        storageMaintenance: input.storageMaintenance,
      },
    });
    if (!host) throw new Error("Local workspace management host is unavailable");
    input.lifecycleContributions.acquire("localWorkspaceHost.close", () =>
      host.close()
    );
    await host.start();
    if (!authorityRuntime.environment) {
      throw new Error("Executor evidence requires the local environment authority");
    }
    const handler = new ExecutorEvidenceHandler({
      executorId: authorityRuntime.executorId,
      environment: authorityRuntime.environment,
      journal: new EvidenceJournal({
        file: path.join(
          input.zhixingHome,
          "distributed-runtime",
          "evidence",
          `${authorityRuntime.executorId}.jsonl`,
        ),
        verifier: authorityRuntime.verifier,
      }),
      signer: authorityRuntime.signer,
      verifier: authorityRuntime.verifier,
      verifyCurrentOwner: createConversationEvidenceAuthorityVerifier({
        authority: authorityRuntime,
        currentAnchorDeviceId: () =>
          inputMeshBootstrap.mode === "trusted-home"
            ? inputMeshExecutorTopologyTrust!.currentAnchorDeviceId()
            : authorityRuntime.deviceId,
      }),
      capacity: input.advancementCapacity,
    });
    input.lifecycleContributions.acquire(
      "evidenceHandler.stopAccepting",
      () => handler.stopAccepting(),
    );
    evidenceHandler = handler;
  }
  const jobStatus = new JobStatusDirectory();
  input.lifecycleContributions.acquire("jobStatus.dispose", () =>
    jobStatus.dispose()
  );
  return Object.freeze({ jobStatus, jobRelayObligations, evidenceHandler });
}

/**
 * 会话内容资产的周期回收。
 *
 * 持有者必须在全部拓扑下都存在:回收是锚点权威的生命周期治理义务,不能挂在只于
 * 多机拓扑创建的 mesh 控制面上,否则默认单机锚点永不回收临时件与已释放叶。
 */
export interface StartAssetMaintenanceInput {
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
}

export async function startAssetMaintenance(
  input: StartAssetMaintenanceInput,
) {
  const authority = input.authorityRuntime;
  if (!authority) {
    throw new Error("Asset maintenance requires the authority runtime");
  }
  // 治理端口注入协调器而非调度器:容量在协调器内部的叶级物理步骤取得,
  // 调度器只声明这轮回收的阻塞关系。
  const maintenance = new SurfaceAssetMaintenance({
    surfaceAssets: () => authority.surfaceAssets,
    onError: (error) =>
      console.warn(chalk.yellow(`[assets] ${error.message}`)),
  });
  input.lifecycleContributions.acquire("assetMaintenance.stop", () =>
    maintenance.stop()
  );
  await maintenance.start();
  return maintenance;
}

/** Authenticated mesh control plane; absent in the no-genesis single-machine topology. */
export interface PrepareMeshRuntimeInput {
  readonly meshBootstrap: Extract<MeshRuntimeBootstrap, { mode: "trusted-home" }>;
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly conversationProtocol: ConversationProtocolRuntime;
  readonly meshConnections: MeshConnectionRegistry;
  readonly meshExecutorTopologyTrust: import("./mesh-runtime-assembly.js").MeshExecutorTopologyTrustState;
  readonly conversationExecutorTopologyDirectory: ConversationExecutorTopologyDirectory;
  readonly assignmentArtifactReceiver: import("./assignment-artifact-receiver.js").AssignmentArtifactReceiverPort;
  readonly zhixingHome: string;
  readonly localConversationOwner?: LocalConversationOwnerAssembly;
  readonly jobRelayObligations: JobRelayObligationDirectory;
  readonly executor?: MeshRuntimeAssemblyOptions["executor"];
  readonly secretStore: SecretStorePort;
  readonly onTrustApplied?: (record: import("@zhixing/core/contracts").HomeTrustRecord) => void | Promise<void>;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
}

export async function prepareMeshRuntime(
  input: PrepareMeshRuntimeInput,
) {
  const bootstrap = input.meshBootstrap;
  if (
    !input.authorityRuntime ||
    !input.conversationProtocol ||
    !input.meshConnections ||
    !input.meshExecutorTopologyTrust ||
    !input.conversationExecutorTopologyDirectory ||
    !input.assignmentArtifactReceiver
  ) {
    throw new Error("Mesh control requires authority and conversation protocol runtimes");
  }
  const pairedCheckpointDeviceId = input.authorityRuntime.deviceId;
  const mesh = new MeshRuntimeAssembly({
    zhixingHome: input.zhixingHome,
    trust: bootstrap.trust,
    configuration: bootstrap.configuration,
    endpoints: bootstrap.endpoints,
    transportPeers: bootstrap.transportPeers,
    bootstrapStore: bootstrap.bootstrapStore,
    bootstrapProjection: bootstrap.bootstrapProjection,
    pairingContinuations: createFileMeshPairingContinuationRepository(
      input.zhixingHome,
    ),
    pairedCheckpointReceiver:
      createPersistentPairedCheckpointCommandReceiverInfrastructure({
        zhixingHome: input.zhixingHome,
        trust: bootstrap.trust,
        deviceId: pairedCheckpointDeviceId,
        bootstrapStore: bootstrap.bootstrapStore,
        storageMaintenance: input.authorityRuntime.storageMaintenance,
      }),
    ...(bootstrap.anchorIssuerKey
      ? { plannedAnchorIssuerKey: bootstrap.anchorIssuerKey }
      : {}),
    ...(bootstrap.plannedAnchorPostInstall
      ? { plannedAnchorPostInstall: bootstrap.plannedAnchorPostInstall }
      : {}),
    authority: input.authorityRuntime,
    assignmentArtifactReceiver: input.assignmentArtifactReceiver,
    conversationTransferStaging: createConversationTransferStagingInfrastructure({
      zhixingHome: input.zhixingHome,
    }),
    plannedAnchorTransferStaging: bootstrap.plannedAnchorTransferStaging,
    disasterRecoveryStaging: bootstrap.disasterRecoveryStaging,
    protocol: input.conversationProtocol,
    executorTopologyDirectory: input.conversationExecutorTopologyDirectory,
    executorTopologyTrust: input.meshExecutorTopologyTrust,
    connections: input.meshConnections,
    ...(input.localConversationOwner
      ? { localConversationOwner: input.localConversationOwner }
      : {}),
    jobRelays: input.jobRelayObligations,
    ...(input.executor ? { executor: input.executor } : {}),
    secretStore: input.secretStore,
    ...(bootstrap.localEndpoint ? { localEndpoint: bootstrap.localEndpoint } : {}),
    onError: (error) => console.warn(chalk.yellow(`[mesh] ${error.message}`)),
    ...(input.onTrustApplied ? { onTrustApplied: input.onTrustApplied } : {}),
  });
  const preparation = Object.freeze({
    runtime: mesh,
    connections: mesh.connections,
    advancementEvidence: mesh,
    assignmentDataPlane: mesh,
    currentAnchorDeviceId: () => mesh.currentAnchorDeviceId(),
    plannedCurrentOwnerReady: () => mesh.plannedCurrentOwnerReady(),
    start: async (
      options: Parameters<MeshRuntimeAssembly["start"]>[0],
    ) => {
      await mesh.start(options);
      return mesh;
    },
    stop: () => mesh.stop(),
  });
  input.lifecycleContributions.acquire("meshRuntime.stop", preparation.stop);
  return preparation;
}

/** Host-owned local/Mesh evidence selector installed after every mechanism exists. */
export interface BindAdvancementEvidenceTopologyInput {
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly conversationProtocol: ConversationProtocolRuntime;
  readonly advancementEvidenceRuntime: AdvancementEvidenceHostBindingPort;
  readonly evidenceHandler?: EvidenceHandlerPort & { stopAccepting(): void };
  readonly meshRuntimePreparation?: MeshRuntimePreparation;
}

export async function bindAdvancementEvidenceTopology(
  input: BindAdvancementEvidenceTopologyInput,
) {
  const authority = input.authorityRuntime;
  const protocol = input.conversationProtocol;
  if (!authority || !protocol) {
    throw new Error(
      "Advancement evidence topology requires authority and conversation runtimes",
    );
  }
  input.advancementEvidenceRuntime.bind({
    signer: authority.signer,
    verifier: authority.verifier,
    resolveTarget: (conversationId, runId) =>
      protocol.advancementEvidenceTarget(conversationId, runId),
    targets: new AdvancementEvidenceTopologyAdapter({
      ...(input.evidenceHandler
        ? {
            local: {
              executorId: authority.executorId,
              client: input.evidenceHandler,
            },
          }
        : {}),
      ...(input.meshRuntimePreparation
        ? { remote: input.meshRuntimePreparation.advancementEvidence }
        : {}),
    }),
  });
}

/**
 * S6 无损数据面唯一产品组合根。
 *
 * Channel mechanism 先以显式 available/absent profile 完成；随后 conversation
 * 协议、executor 端点、mesh adapter 与 challenge effect 一次性形成闭环。
 */
export interface CreateHostLosslessDataPlaneInput {
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly jobStatus: JobStatusDirectory;
  readonly channelMechanism: PreparedChannelMechanism;
  readonly localExecutor?: Readonly<{
    dataPlane: ExecutorDataPlaneRuntime;
    ledger: ConversationAssignmentLedger;
    jobOwner: ExecutorJobOwner;
  }>;
  readonly durableInteractions: DurableConversationInteractionObserver;
  readonly meshRuntimePreparation?: MeshRuntimePreparation;
  readonly jobRelayObligations: JobRelayObligationDirectory;
  readonly meshBootstrap: MeshRuntimeBootstrap;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
}

export async function createHostLosslessDataPlane(
  input: CreateHostLosslessDataPlaneInput,
  assembly: ConversationLosslessDataPlaneAssemblyHandle,
) {
  if (!input.authorityRuntime || !input.jobStatus) {
    throw new Error(
      "Lossless data plane requires authority and job-status runtimes",
    );
  }
  const channelMechanism = input.channelMechanism;
  if (!channelMechanism) {
    throw new Error("Lossless data plane requires a selected Channel mechanism");
  }
  const channelChallenges = channelMechanism.kind === "available"
    ? { kind: "available" as const, delivery: channelMechanism.channels.challenges }
    : { kind: "absent" as const, reason: channelMechanism.reason };
  const composition = createLosslessDataPlaneComposition({
    verifier: input.authorityRuntime.verifier,
    targets: new AssignmentDataPlaneTopologyAdapter({
      ...(input.localExecutor
        ? {
            local: {
              executorId: input.authorityRuntime.executorId,
              ownerDeviceId: input.authorityRuntime.deviceId,
              transport: input.localExecutor.dataPlane.localTransport,
              interactions: new AssignmentInteractionRouter({
                ledger: input.localExecutor.ledger,
                conversation: input.durableInteractions,
                job: input.localExecutor.jobOwner,
              }),
            },
          }
        : {}),
      ...(input.meshRuntimePreparation
        ? { remote: input.meshRuntimePreparation.assignmentDataPlane }
        : {}),
    }),
    jobRelayObligations: input.jobRelayObligations,
    channelChallenges,
    isCurrentOwner: channelOwnership(input.meshBootstrap, input.meshRuntimePreparation),
    jobStatus: input.jobStatus,
    onDataPlaneError: (error) =>
      console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
    onCoordinatorError: (error) =>
      console.warn(chalk.yellow(`[channel-coordinator] ${error.message}`)),
  });
  input.lifecycleContributions.acquire("losslessDataPlane.close", () =>
    composition.close()
  );
  assembly.complete(composition.coordinator);
  return composition;
}

/** 会话执行面 —— 持久用户 / channel / 工作场景会话（ConversationManager）。 */
export interface CreateConversationServicesInput {
  readonly onRunStatus?: (notice: import("@zhixing/core/contracts").ConversationStatusNotice) => void;
  readonly mcp?: import("@zhixing/core/mcp-management").McpConnectionPort;
  readonly conversationNamingStorage: NamerConversationRepo;
  readonly meshBootstrap: MeshRuntimeBootstrap;
  readonly meshConnections?: MeshConnectionRegistry;
  readonly meshExecutorTopologyTrust?: import("./mesh-runtime-assembly.js").MeshExecutorTopologyTrustState;
  readonly durableInteractions: DurableConversationInteractionObserver;
  readonly runtimeFactory: RuntimeFactory;
  readonly conversationRuntimeStorage: ConversationRuntimeStoragePort;
  readonly confirmationHub: ConfirmationHub;
  readonly createConversationPerspectives: (manager: ConversationManager) => ConversationPerspectivesApplication;
  readonly advancementConversationComposition: AdvancementConversationComposition;
  readonly advancementDirectory: AdvancementConversationDirectory;
  readonly worksceneAuthority: AnchorWorksceneAuthorityProjection;
  readonly worksceneConversationStorageProjectionCleanup: WorksceneConversationStorageProjectionCleanupPort;
  readonly worksceneSceneStorageRemoval: WorksceneSceneStorageRemovalPort;
  readonly zhixingHome: string;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly executorRoleModule?: ExecutorRoleModule;
  readonly assignmentRuntimeFactory: RuntimeFactory;
  readonly sessionBroadcast: SessionBroadcast;
  readonly conversationIdentityLifecycle: ConversationIdentityLifecycleApplication;
  readonly conversationClearProjection: Pick<
    ConversationClearProjectionPort,
    "clearStoredView"
  >;
  readonly conversationDeleteProjection: {
    deleteStoredConversation(conversationId: string): Promise<boolean>;
  };
  readonly conversationCommittedViewStorage: ConversationCommittedViewStorage;
  readonly taskListService: TaskListService;
}

export async function createConversationServices(
  input: CreateConversationServicesInput,
  losslessDataPlane: ConversationLosslessDataPlaneAssemblyHandle,
) {
  const { zhixingHome: inputZhixingHome, storageMaintenance: inputStorageMaintenance, lifecycleContributions: inputLifecycleContributions } = input;
  const {
    authorityRuntime: inputAuthorityRuntime,
    executorRoleModule: inputExecutorRoleModule,
    assignmentRuntimeFactory: inputAssignmentRuntimeFactory,
    sessionBroadcast: inputSessionBroadcast,
    conversationIdentityLifecycle: inputConversationIdentityLifecycle,
    conversationClearProjection: inputConversationClearProjection,
    conversationDeleteProjection: inputConversationDeleteProjection,
    conversationCommittedViewStorage: inputConversationCommittedViewStorage,
    taskListService: inputTaskListService,
  } = input;
  if (!inputAuthorityRuntime) {
    throw new Error("Conversation surface requires the durable authority runtime");
  }

  const turnMaintenance = createTurnMaintenance({
    convRepo: input.conversationNamingStorage,
    // turn 后台维护（自动命名）是宿主维护类工作——scheduler 准入，
    // 每次外调经 control 治理边界预占计量
    governCallText: (call) =>
      governControlTextCall(
        {
          governor: inputAuthorityRuntime!.resourceGovernor,
          origin: { admissionClass: "scheduler", entry: "schedule-trigger" },
          workPrefix: "turn-maintenance",
        },
        call,
      ),
    onRenamed: (conversationId, name) => {
      inputSessionBroadcast(
        conversationId,
        SESSION_NOTIFICATIONS.changed,
        {
          conversationId,
          change: "renamed",
          name,
        } satisfies SessionChangedPayload,
      );
    },
  });
  let manager: ConversationManager;
  const managerAssembly = createConversationManagerAssemblyHandle();
  const auxiliaryRecoveryAssembly =
    createConversationAuxiliaryRecoveryAssemblyHandle();
  const committedTurnListenerAssembly =
    createConversationCommittedTurnListenerAssemblyHandle();
  const assignmentArtifacts = createConversationAssignmentArtifactAuthorityIndex();
  let topologyDirectory = NO_REMOTE_CONVERSATION_EXECUTORS;
  let assignmentArtifactReceiver: AssignmentArtifactReceiverPort | undefined;
  if (input.meshBootstrap.mode !== "single-machine") {
    if (!input.meshConnections || !input.meshExecutorTopologyTrust) {
      throw new Error("Conversation executor requires the Host mesh topology ports");
    }
    const receiver = createAssignmentArtifactReceiverInfrastructure({
      zhixingHome: inputZhixingHome,
      artifacts: inputAuthorityRuntime.artifacts,
    });
    topologyDirectory = new MeshConversationExecutorTopologyDirectory({
      trust: input.meshExecutorTopologyTrust,
      connections: input.meshConnections,
      localDeviceId: inputAuthorityRuntime.deviceId,
      artifacts: inputAuthorityRuntime.artifacts,
      receiver,
      signer: inputAuthorityRuntime.signer,
      verifier: inputAuthorityRuntime.verifier,
      assignmentArtifacts,
    });
    assignmentArtifactReceiver = receiver;
  }
  const conversationAuthority = anchorConversationOwnerRuntime(inputAuthorityRuntime);
  let dataPlane: ExecutorDataPlaneRuntime | undefined;
  const executorBoundary = inputExecutorRoleModule
    ? (() => {
        const pair = createExecutorDataPlaneAssignmentPair(
          {
            zhixingHome: inputZhixingHome,
            authority: inputAuthorityRuntime!,
            module: inputExecutorRoleModule!,
            ...(inputStorageMaintenance
              ? { storageMaintenance: inputStorageMaintenance }
              : {}),
            onError: (error) =>
              console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
          },
          (dataPlaneAssembly) => {
            const boundary = createConversationExecutorHostBoundary({
              authority: conversationAuthority,
              directory: topologyDirectory,
              clock: () => new Date().toISOString(),
              local: {
                ConversationAssignmentLedger:
                  inputExecutorRoleModule!.ConversationAssignmentLedger,
                InProcessAssignmentSubmission:
                  inputExecutorRoleModule!.InProcessAssignmentSubmission,
                dataPlaneTickets: dataPlaneAssembly.assignmentTickets,
                runtimeFactory: inputAssignmentRuntimeFactory,
                createStream: dataPlaneAssembly.createStream,
              },
            });
            if (!boundary.localLedger) {
              throw new Error(
                "Conversation executor pair did not provide its local ledger",
              );
            }
            return Object.freeze({
              assignment: boundary,
              authority: boundary.localLedger,
            });
          },
        );
        dataPlane = pair.dataPlane;
        inputLifecycleContributions.acquire("executorDataPlane.close", () =>
          pair.dataPlane.close()
        );
        return pair.assignment;
      })()
    : createConversationExecutorHostBoundary({
        authority: conversationAuthority,
        directory: topologyDirectory,
        clock: () => new Date().toISOString(),
      });
  const protocol = new ConversationProtocolRuntime({
    authority: inputAuthorityRuntime,
    manager: managerAssembly.resolve,
    recoverAuxiliary: auxiliaryRecoveryAssembly.resolve,
    losslessDataPlane: Object.freeze({
      kind: "available",
      port: losslessDataPlane.port,
    }),
    executorDispatch: executorBoundary.application,
    assignmentArtifactAuthority: assignmentArtifacts,
    ...(executorBoundary.staging
      ? { assignmentStaging: executorBoundary.staging }
      : {}),
    interactions: input.durableInteractions,
    executeRecoveredPerspective: async (input) => {
      const execution = await conversationPerspectives.executePerspectiveWork({
        runtime: projectConversationPerspectivesRuntime(
          input.managed,
          input.managed.runtime,
        ),
        originalInput: input.originalInput,
        question: input.question,
        source: input.source,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        turnContext: input.turnContext,
        ...(input.authorizeToolExecution
          ? { authorizeToolExecution: input.authorizeToolExecution }
          : {}),
        ...(input.modelCallMetering
          ? { modelCallMetering: input.modelCallMetering }
          : {}),
      });
      return execution.runResult;
    },
    onStatus: (notice) => {
      input.onRunStatus?.(notice);
      inputSessionBroadcast(
        notice.ref.conversationId,
        SESSION_NOTIFICATIONS.status,
        notice,
      );
    },
    onFinal: (frame) => {
      inputSessionBroadcast(
        frame.conversationId,
        SESSION_NOTIFICATIONS.final,
        frame,
      );
    },
    onPublishResult: (notice) => {
      inputSessionBroadcast(
        notice.conversationId,
        SESSION_NOTIFICATIONS.event,
        createControlSessionEventEnvelope({
          conversationId: notice.conversationId,
          runId: notice.runId,
          seq: notice.seq,
          event: "publish:result",
          payload: notice,
        }),
      );
    },
    onFirstPartyFrame: (frame) => {
      if (frame.ref.execution !== "conversation") return;
      inputSessionBroadcast(
        frame.ref.conversationId,
        SESSION_NOTIFICATIONS.assignmentStream,
        frame,
      );
    },

    projectLifecycle: async (input) => {
      if (input.mutation === "clear") {
        await projectConversationClear({
          conversationId: input.conversationId,
          operationId: input.requestId,
          projection: {
            clearStoredView: async (conversationId) => {
              await inputConversationIdentityLifecycle.ensureShell(
                conversationId,
              );
              return inputConversationClearProjection.clearStoredView(
                conversationId,
              );
            },
            clearRuntimeView: (conversationId, persist) =>
              manager.clear(conversationId, persist),
          },
          publishFact: (fact) => {
            inputSessionBroadcast(
              fact.conversationId,
              SESSION_NOTIFICATIONS.changed,
              { conversationId: fact.conversationId, change: "cleared" },
            );
          },
        });
        return;
      }
      await projectConversationDelete({
        conversationId: input.conversationId,
        operationId: input.requestId,
        deletionAlreadyCommitted: true,
        dependentFailure: "propagate",
        projection: createAnchorConversationDeleteProjectionPort({
          conversations: manager,
          storage: {
            exists: (conversationId) =>
              inputConversationIdentityLifecycle.identityExists(
                conversationId,
              ),
            deleteStoredConversation: (conversationId) =>
              inputConversationDeleteProjection.deleteStoredConversation(
                conversationId,
              ),
          },
          related: {
            cancelDependentLifecycle: (conversationId) =>
              advancementConversationLifecycle.cancelConversationLifecycle(
                conversationId,
              ),
            removeDependentData: (conversationId) =>
              advancementConversationLifecycle.removeConversationData(
                conversationId,
              ),
          },
        }),
        publishFact: (fact) => {
          inputSessionBroadcast(
            fact.conversationId,
            SESSION_NOTIFICATIONS.changed,
            { conversationId: fact.conversationId, change: "deleted" },
          );
        },
      });
    },
  });
  manager = new ConversationManager(input.runtimeFactory, undefined, {
    onRelease: (conversationId) => protocol.releaseConversation(conversationId),
    ...input.conversationRuntimeStorage,
    ensureConversation: async (conversationId) => {
      await protocol.ensureSession(conversationId);
      await inputConversationIdentityLifecycle.initializeRuntimeStorage(
        conversationId,
      );
    },
    applyCommittedSessionMutations: async (conversationId, mutations) => {
      for (const record of [...mutations].sort((a, b) => a.seq - b.seq)) {
        if (record.mutation.kind === "task-list-op") {
          await inputConversationCommittedViewStorage.persistTaskList(
            conversationId,
            record.mutation.op.state,
          );
          inputTaskListService.acceptCommitted(
            conversationId,
            record.mutation.op.state,
          );
          const fact = createConversationTaskListChangedFact(
            conversationId,
            record.mutation.op.state,
          );
          inputSessionBroadcast(
            conversationId,
            SESSION_NOTIFICATIONS.changed,
            {
              conversationId: fact.conversationId,
              change: "taskList",
              taskList: fact.taskList,
            } satisfies SessionChangedPayload,
          );
          continue;
        }
        await inputConversationCommittedViewStorage.appendSegment(
          conversationId,
          record.mutation.segment,
        );
      }
    },
    confirmationHub: input.confirmationHub,
    durableTurnExecutor: protocol,
    onTurnCommitted: committedTurnListenerAssembly.notify,
  });
  managerAssembly.complete(manager);
  const conversationPerspectives = input.createConversationPerspectives(manager);
  const advancementComposition =
    await input.advancementConversationComposition.create({
      sessionState: protocol.sessionState,
      recentContext: Object.freeze({
        read: async (conversationId: string) =>
          renderRecentContextFromMessages(
            manager.getHistory(conversationId, 6),
          ),
      }),
    });
  const advancementController = advancementComposition.controller;
  const advancementReviews = advancementComposition.reviews;
  const advancementConversationLifecycle = advancementComposition.lifecycle;
  const conversationExists = (conversationId: string) =>
    inputConversationIdentityLifecycle.identityExists(conversationId);
  const proxyTurns = createAdvancementProxyTurnPort({
    manager,
    sessionBroadcast: inputSessionBroadcast,
    conversationExists,
  });
  const reviewResults = new AdvancementReviewResultProjectionApplicationService({
    events: createAdvancementEventSink(inputSessionBroadcast),
    proxySchedule: createAdvancementReviewProxySchedulePort(proxyTurns),
  });
  const advancementRecovery = createAdvancementRecoveryMaintenance({
    advancement: advancementController,
    reviews: advancementReviews,
    directory: input.advancementDirectory,
    proxyTurns,
    originalTasks: createAdvancementOriginalTaskAdmissionPort(
      manager,
      { conversationExists },
    ),
    events: createAdvancementEventSink(inputSessionBroadcast),
    reviewResults,
    logger: console,
  });
  const advancementAcceptedTurns =
    new AdvancementAcceptedTurnApplicationService({
      catchUp: {
        catchUpAcceptedTurn: (conversationId, beforeRunIndex) =>
          advancementRecovery.recoverConversation(conversationId, {
            beforeRunIndex,
          }),
      },
      review: advancementReviews,
      results: reviewResults,
    });
  auxiliaryRecoveryAssembly.complete(async (conversationId) => {
    await worksceneContinuation.recover(conversationId);
    if (!await protocol.sessionExists(conversationId)) return;
    const result = await advancementRecovery.recoverConversation(conversationId);
    if (
      result.status === "failed" ||
      result.status === "full" ||
      result.status === "busy" ||
      result.status === "not-found" ||
      result.status === "missing-proxy"
    ) {
      throw new Error(
        result.message ??
          `Advancement recovery did not converge: ${result.status}`,
      );
    }
  });
  // Complete the constructor-owned fire-and-forget listener before the
  // manager becomes reachable through any production ingress.
  committedTurnListenerAssembly.complete((info) => {
    turnMaintenance(info);
    advancementAcceptedTurns.acceptCommittedTurn(info);
  });
  const worksceneDirectory = createWorksceneDirectory({
    authority: input.worksceneAuthority,
    conversations: manager,
    conversationAuthority: protocol,
    conversationStorageProjectionCleanup:
      input.worksceneConversationStorageProjectionCleanup,
    sceneStorageRemoval: input.worksceneSceneStorageRemoval,
  });
  const worksceneApplicationPorts =
    createAnchorWorksceneApplicationPorts(worksceneDirectory);
  const worksceneAdvancementApplicationPort =
    createAnchorWorksceneAdvancementApplicationPort({
      recovery: advancementRecovery,
      activeState: advancementReviews,
      logger: console,
    });
  const worksceneApplication = new WorksceneApplicationService(
    worksceneApplicationPorts.management,
    worksceneApplicationPorts.workspaces,
    worksceneApplicationPorts.entry,
    worksceneApplicationPorts.runtime,
    worksceneAdvancementApplicationPort,
  );
  const worksceneContinuation = new WorksceneContinuationApplication(
    createWorksceneContinuationPort({
      manager,
      protocol,
      workscene: worksceneApplication,
      advancement: advancementReviews,
      mcp: input.mcp,
      canRunIsolatedMain: Boolean(inputExecutorRoleModule),
    }),
  );
  inputLifecycleContributions.acquire(
    "execution.abortAllAndWait",
    () => manager.abortAllAndWait(
      { kind: "external", origin: "scheduler-shutdown" },
      30_000,
    ).then(() => undefined),
  );
  if (dataPlane) await dataPlane.start();
  await protocol.recoverReadinessProjections();
  return Object.freeze({
    conversations: manager,
    conversationProtocol: protocol,
    conversationPerspectives,
    advancementRecovery,
    advancement: advancementController,
    advancementReviews,
    advancementConversationLifecycle,
    worksceneDirectory,
    worksceneApplication,
    worksceneContinuation,
    conversationExecutorDispatch: executorBoundary.application,
    conversationExecutorTopologyDirectory: topologyDirectory,
    conversationAssignmentStaging: executorBoundary.staging,
    conversationExecutorLedger: executorBoundary.localLedger,
    executorDataPlane: dataPlane,
    assignmentArtifactReceiver,
  });
}

/** Device-local owner: internal-only and present exactly when an executor is loaded. */
export interface CreateLocalConversationOwnerInput {
  readonly onRunStatus?: (notice: import("@zhixing/core/contracts").ConversationStatusNotice) => void;
  readonly executorRoleModule: ExecutorRoleModule;
  readonly evidenceHandler: EvidenceHandlerPort & { stopAccepting(): void };
  readonly assignmentRuntimeFactory: RuntimeFactory;
  readonly durableInteractions: DurableConversationInteractionObserver;
  readonly advancementConfiguration: RuntimeAdvancementConfigurationProjection;
  readonly providerCredentials?: ProviderCredentialProjection;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly executorDataPlane: ExecutorDataPlaneRuntime;
  readonly meshBootstrap: MeshRuntimeBootstrap;
  readonly meshExecutorTopologyTrust?: import("./mesh-runtime-assembly.js").MeshExecutorTopologyTrustState;
  readonly authorityRuntime: AuthorityRuntimeStack;
}

export async function createLocalConversationOwner(
  input: CreateLocalConversationOwnerInput,
) {
  const {
    executorDataPlane: inputExecutorDataPlane,
    meshBootstrap: inputMeshBootstrap,
    meshExecutorTopologyTrust: inputMeshExecutorTopologyTrust,
    authorityRuntime: inputAuthorityRuntime,
  } = input;
  if (
    !inputAuthorityRuntime ||
    !input.executorRoleModule ||
    !inputExecutorDataPlane ||
    !input.evidenceHandler
  ) {
    throw new Error(
      "Local conversation owner requires authority, executor, data-plane, and evidence runtime",
    );
  }
  const executorResources = inputAuthorityRuntime.executorResourceGovernor;
  const localOwner = localConversationOwnerRuntime({
    artifacts: inputAuthorityRuntime.artifacts,
    deviceId: inputAuthorityRuntime.deviceId,
    executorCapabilities: inputAuthorityRuntime.executorCapabilities,
    executorId: inputAuthorityRuntime.executorId,
    executorLog: inputAuthorityRuntime.executorLog,
    resources: executorResources,
    executionResources: executorResources,
    assignmentResources: executorResources,
    resourceRecovery: createConversationResourceRecoveryPort({
      primary: executorResources,
      acceptedWork: executorResources,
    }),
    finalizeUsage: (assignmentId) =>
      executorResources.finalizeLocalAssignment(assignmentId),
    executionAssetCatalog: inputAuthorityRuntime.executionAssetCatalog,
    localControlAdmission: inputAuthorityRuntime.localControlAdmission,
    localDomainId: inputAuthorityRuntime.localDomainId,
    localGovernorEpoch: inputAuthorityRuntime.localGovernorEpoch,
    localOwnerEpoch: inputAuthorityRuntime.localOwnerEpoch,
    permissionSnapshotFor: inputAuthorityRuntime.permissionSnapshotFor,
    preflightLocalConversationEnvironment:
      inputAuthorityRuntime.preflightLocalConversationEnvironment,
    prepareLocalConversationAssignment:
      inputAuthorityRuntime.prepareLocalConversationAssignment,
    releaseLocalConversationEnvironmentPreflight:
      inputAuthorityRuntime.releaseLocalConversationEnvironmentPreflight,
    signer: inputAuthorityRuntime.signer,
    storageMaintenance: inputAuthorityRuntime.storageMaintenance,
    validateConversationRuntimeBinding:
      inputAuthorityRuntime.validateConversationRuntimeBinding,
    validateLocalConversationManifest:
      inputAuthorityRuntime.validateLocalConversationManifest,
    verifier: inputAuthorityRuntime.verifier,
  });
  const localExecutorBoundary = createConversationExecutorHostBoundary({
    authority: localOwner,
    directory: NO_REMOTE_CONVERSATION_EXECUTORS,
    clock: () => new Date().toISOString(),
    local: {
      ConversationAssignmentLedger:
        input.executorRoleModule.ConversationAssignmentLedger,
      InProcessAssignmentSubmission:
        input.executorRoleModule.InProcessAssignmentSubmission,
      runtimeFactory: input.assignmentRuntimeFactory,
      dataPlaneTickets: inputExecutorDataPlane.assignmentTickets,
      createStream: (input) => inputExecutorDataPlane!.createStream(input),
    },
  });
  if (!localExecutorBoundary.staging) {
    throw new Error("Local Conversation owner requires assignment staging");
  }
  const assembly = await LocalConversationOwnerAssembly.create({
    onRunStatus: input.onRunStatus,
    owner: localOwner,
    executorDispatch: localExecutorBoundary.application,
    assignmentStaging: localExecutorBoundary.staging,
    runtimeFactory: input.assignmentRuntimeFactory,
    interactions: input.durableInteractions,
    advancementModelProvider: createHostAdvancementModelProviderFactory({
      configuration: input.advancementConfiguration,
      credentials: input.providerCredentials ?? {},
    }),
    evidence: input.evidenceHandler,
    currentAnchorDeviceId: () =>
      inputMeshBootstrap.mode === "trusted-home"
        ? inputMeshExecutorTopologyTrust!.currentAnchorDeviceId()
        : inputAuthorityRuntime!.deviceId,
  });
  input.lifecycleContributions.acquire("localConversationOwner.close", () =>
    assembly.close()
  );
  return assembly;
}

/**
 * Stable executor-owned job convergence owner.
 *
 * The worker is created before optional transports so every adapter receives
 * the same instance. Readiness is published only after recovery is scheduled.
 */
export interface CreateExecutorJobOwnerInput {
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly executorRoleModule: ExecutorRoleModule;
  readonly jobRuntime: JobRuntimePort;
  readonly jobRelayObligations: JobRelayObligationDirectory;
  readonly conversationExecutorLedger: ConversationAssignmentLedger;
  readonly executorDataPlane: ExecutorDataPlaneRuntime;
}

export async function createExecutorJobOwner(
  input: CreateExecutorJobOwnerInput,
) {
  const { executorDataPlane: inputExecutorDataPlane } = input;
  if (
    !input.authorityRuntime ||
    !inputExecutorDataPlane ||
    !input.executorRoleModule ||
    !input.jobRuntime
  ) {
    throw new Error(
      "Executor job owner requires authority, ledger, data-plane, module, and job runtime",
    );
  }
  const jobRelays = input.jobRelayObligations;
  const authority = input.authorityRuntime;
  const assembly = new ExecutorJobOwnerAssembly({
    ledger: input.conversationExecutorLedger!,
    runtime: input.jobRuntime,
    submissionFor: (envelope, signal) => {
      return jobRelays.submissionFor(envelope.assignmentId) ??
        jobRelays.waitForSubmission(envelope.assignmentId, signal);
    },
    finalizeUsage: ({ assignmentId }) => {
      return authority.executorResourceGovernor.flushAssignment(
        assignmentId,
        authority.resourceGovernor,
        (report) => usageReporterContext(report.reporterId, report.digest),
      );
    },
    globalQueryFor: (capability, anchorEpoch) => {
      if (!authority.globalState) {
        throw new JobInteractionRuntimeUnavailableError("Anchor global authority state is unavailable");
      }
      return createAssignmentGlobalQueryPort({ state: authority.globalState, capability, anchorEpoch });
    },
    InProcessAssignmentSubmission:
      input.executorRoleModule.InProcessAssignmentSubmission,
    resources: input.authorityRuntime.executorResourceGovernor,
    createStream: (input) => inputExecutorDataPlane!.createStream(input),
    onError: (_assignmentId, error) =>
      console.warn(chalk.yellow(`[job-worker] ${error.message}`)),
  });
  return assembly;
}

/**
 * Starts durable recovery only after every enabled adapter has received the
 * stable owner reference. Keeping this as a core unit prevents any optional
 * transport from owning the job capability lifecycle.
 */
export interface StartExecutorJobOwnerInput {
  readonly executorJobOwnerAssembly: ExecutorJobOwnerAssembly;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly startupLifecycle?: StartupLifecycleRestoration;
}

export async function startExecutorJobOwner(
  input: StartExecutorJobOwnerInput,
) {
  const assembly = input.executorJobOwnerAssembly;
  input.lifecycleContributions.acquire("executorJobOwner.close", () =>
    assembly.close()
  );
  await assembly.start({
    admissionClosed: true,
    recoverAcceptedWork: input.startupLifecycle?.recoverAcceptedWork ?? true,
  });
}

const channelLogger = Object.freeze({
  debug: (msg: string, ...args: unknown[]) =>
    console.log(chalk.dim(`[channel] ${msg}`), ...args),
  info: (msg: string, ...args: unknown[]) =>
    console.log(chalk.dim(`[channel] ${msg}`), ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(chalk.yellow(`[channel] ${msg}`), ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(chalk.red(`[channel] ${msg}`), ...args),
});

function channelOwnership(
  bootstrap: MeshRuntimeBootstrap,
  mesh: MeshRuntimePreparation | undefined,
): () => boolean {
  return () => {
    if (bootstrap.mode === "single-machine") return true;
    const currentDeviceId = mesh?.currentAnchorDeviceId() ?? bootstrap.trust.issuer.deviceId;
    const ready = mesh?.plannedCurrentOwnerReady() ?? bootstrap.plannedAnchorPostInstall === undefined;
    return currentDeviceId === bootstrap.deviceKey.deviceId && ready;
  };
}

/** 社交通道 —— 只装稳定机制；inbound consumer 与物理连接等待 Delivery Outbox。 */
export interface PrepareChannelInput {
  readonly notifyOperation?: (operation: import("@zhixing/core/extensions/contracts").ExtensionOperation) => Promise<unknown>;
  readonly preparationClosed?: (operation: import("@zhixing/core/extensions/contracts").ExtensionOperation) => Promise<boolean>;
  readonly repairSource?: (instance: import("@zhixing/core/extensions/contracts").ExtensionInstance) => Promise<import("@zhixing/core/extensions/contracts").ExtensionOperation["source"] | undefined>;
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly zhixingHome: string;
  readonly configPath: string;
  readonly secretStore: import("@zhixing/core/contracts").SecretStorePort & import("@zhixing/providers").CredentialStoreCoordinator;
  readonly isCurrentOwner: () => boolean;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly channelHttpRoutes: Map<
    string,
    import("@zhixing/core/channels").HttpHandler
  >;
  readonly conversations: ConversationManager;
  readonly channelConfiguration: RuntimeChannelConfigurationProjection;
}

export async function prepareChannel(
  input: PrepareChannelInput,
): Promise<PreparedChannelMechanism> {
  const { channelHttpRoutes: inputChannelHttpRoutes } = input;
  const {
    conversations,
  } = input;
  if (!conversations) {
    throw new Error("Configured Channel requires Conversation application");
  }
  try {
    const conversationProduct = new ChannelConversationProductBinding(
      conversations,
    );
    const result = await setupChannels({
      authorityLog: () => input.authorityRuntime.authorityLog,
      commitDecision: input.authorityRuntime.commitExtensionDecision,
      isCurrentOwner: input.isCurrentOwner,
      configuration: new ChannelConfiguration(input.configPath, input.secretStore),
      artifactDirectory: path.join(input.zhixingHome, "extensions", "artifacts"),
      httpRoutes: inputChannelHttpRoutes,
      logger: channelLogger,
      notifyOperation: input.notifyOperation,
      preparationClosed: input.preparationClosed,
      repairSource: input.repairSource,
    });
    input.lifecycleContributions.acquire("channels.dispose", async () => {
      conversationProduct.close();
      await result.dispose();
    });
    return Object.freeze({
      kind: "available",
      channels: result,
      conversationProduct,
    });
  } catch (err) {
    console.warn(
      chalk.yellow(
        `[channel] Setup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return Object.freeze({ kind: "absent", reason: "setup-failed" });
  }
}

/** Recover durable Channel obligations only after S6 and the job owner both exist. */
export interface RecoverChannelInteractionsInput {
  readonly channelMechanism: PreparedChannelMechanism;
  readonly channelCoordinator: ChannelInteractionCoordinator;
  readonly startupLifecycle?: StartupLifecycleRestoration;
}

export async function recoverChannelInteractions(
  input: RecoverChannelInteractionsInput,
) {
  const mechanism = input.channelMechanism;
  const coordinator = input.channelCoordinator;
  if (!mechanism || !coordinator) {
    throw new Error("Channel interaction recovery requires the complete S6 graph");
  }
  if (
    mechanism.kind === "available" &&
    (!input.startupLifecycle || input.startupLifecycle.recoverAcceptedWork)
  ) {
    await coordinator.recover();
  }
}

/** 投递栈 —— 取得唯一 Outbox 后才构造、发布并连接 inbound router。 */
export interface PrepareDeliveryInput {
  readonly authorityRuntime: AuthorityRuntimeStack;
  readonly startupRollback: StartupRollback;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly startupLifecycle?: StartupLifecycleRestoration;
  readonly confirmationHub: ConfirmationHub;
  readonly sessionBroadcast: SessionBroadcast;
  readonly sessionActivityBroadcast: SessionActivityBroadcast;
  readonly meshBootstrap: MeshRuntimeBootstrap;
  readonly meshRuntimePreparation?: MeshRuntimePreparation;
  readonly channelConfiguration: RuntimeChannelConfigurationProjection;
  readonly channelChallengeAction: LosslessDataPlaneComposition["onChallengeAction"];
  readonly channelMechanism: PreparedChannelMechanism;
  readonly zhixingHome: string;
}

export async function prepareDelivery(
  input: PrepareDeliveryInput,
) {
  const {
    channelConfiguration,
    channelChallengeAction,
    channelMechanism,
    zhixingHome,
  } = input;
  if (!channelMechanism) {
    throw new Error("Delivery requires a selected Channel mechanism");
  }
  if (channelMechanism.kind === "absent") return;
  const preparedChannels = channelMechanism.channels;
  const channelDelivery = preparedChannels.delivery;
  const channelConversationProduct = channelMechanism.conversationProduct;
  if (!input.authorityRuntime) {
    throw new Error("Delivery requires the durable authority runtime");
  }
  const deliveryStack = await setupDelivery({
    channels: channelDelivery,
    zhixingHome,
    authorityRuntime: input.authorityRuntime,
    startupRollback: input.startupRollback,
    logger: {
      info: (msg) => console.log(chalk.dim(msg)),
      warn: (msg) => console.warn(chalk.yellow(msg)),
      error: (msg) => console.error(chalk.red(msg)),
    },
  });
  input.lifecycleContributions.contribute(
    "deliveryStack.stop",
    deliveryStack.startupCleanup,
  );
  if (input.startupLifecycle) {
    await deliveryStack.lifecycle.restore(input.startupLifecycle.delivery);
  }
  deliveryStack.lifecycle.close();
  const isCurrentOwner = channelOwnership(input.meshBootstrap, input.meshRuntimePreparation);
  const router = createInboundChannelRouter({
    conversation: channelConversationProduct,
    channels: preparedChannels.inbound,
    deliveryOutbox: deliveryStack.outboxRegistry,
    logger: channelLogger,
    confirmationHub: input.confirmationHub,
    cancelKeywords: channelConfiguration.intent?.cancelKeywords,
    sessionBroadcast: input.sessionBroadcast,
    sessionActivityBroadcast: input.sessionActivityBroadcast,
    isCurrentOwner,
  });
  input.lifecycleContributions.acquire(
    "inboundRouter.refuseNew",
    () => router.refuseNewMessages(),
  );
  router.refuseNewMessages();
  const inbound = Object.freeze({
    kind: "router" as const,
    handleMessage: (message: import("@zhixing/core/channels").InboundMessage) =>
      router.handleMessage(message),
    handleControlMessage: (message: import("@zhixing/core/channels").InboundMessage) => router.handleControlMessage(message),
  });
  const consumers = Object.freeze({
    inbound,
    // 完整 S6 composition 在发布 protocol consumer 前已冻结此 callback。
    onChallengeAction: channelChallengeAction,
  });
  const channelConnections = Object.freeze({
    ready: Promise.resolve(),
    activate: async () => {
      channelConversationProduct.assertBound();
      if (!isCurrentOwner()) await preparedChannels.disconnectConfigured();
      await preparedChannels.activate();
    },
    connectConfigured: () => preparedChannels.connectConfigured(consumers),
    disconnectConfigured: () => preparedChannels.disconnectConfigured(),
    suspendConfigured: () => preparedChannels.suspendConfigured(),
    resumeConfigured: () => preparedChannels.resumeConfigured(consumers),
  });
  return Object.freeze({ deliveryStack, inboundRouter: router, channelConnections });
}

/**
 * 远程确认桥 —— hub 事件 → RPC notification；依赖 runServer 之后的 server.connections
 * 与会话执行面。post-server 阶段取得同一 rollback provenance handle，随后由
 * activation gate 统一移交正常关闭链。
 */
export interface InstallConfirmationBridgeInput {
  readonly continuationSource?: import("@zhixing/rpc").ConfirmationContinuationSource;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly conversations: ConversationManager;
  readonly confirmationHub: ConfirmationHub;
  readonly runner: RunningServer;
}

export async function installConfirmationBridge(
  input: InstallConfirmationBridgeInput,
) {
  const { conversations, confirmationHub, runner } = input;
  const confirmationBridge = createConfirmationBridge({
    connections: runner.server.connections,
    hub: confirmationHub,
    conversations,
    continuationSource: input.continuationSource,
  });
  input.lifecycleContributions.acquire(
    "confirmationBridge.dispose",
    () => confirmationBridge.dispose(),
  );
}

/** Work resumption starts only after RPC, channel, delivery and confirmation consumers exist. */
export interface StartConversationRecoveryInput {
  readonly conversationProtocol: ConversationProtocolRuntime;
  readonly startupLifecycle?: StartupLifecycleRestoration;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
}

export async function startConversationRecovery(
  input: StartConversationRecoveryInput,
) {
  const protocol = input.conversationProtocol;
  if (input.startupLifecycle) return;
  input.lifecycleContributions.acquire(
    "conversationProtocol.stopRecovery",
    () => protocol.stopRecoveryLoop(),
  );
  protocol.startRecoveryLoop();
}

function usageReporterContext(
  executorId: string,
  reportDigest: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId },
    requestId: `usage-report:${reportDigest}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
