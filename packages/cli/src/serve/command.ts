/**
 * `zhixing serve` 命令 — 启动常驻服务（核心宿主）
 *
 * 核心宿主 = 恒定核心（runtime + 会话态 owner 位 + Scheduler + RPC server）+ 一组**可挂载的
 * 接入面**（access surface）。装配主干：
 *   1. 备齐恒定核心前置（token / transcript / confirmationHub / MCP runtime ports / builtinExtraTools /
 *      runtimeFactory / CleanupRegistry）—— 接入面 setup 从这里读依赖
 *   2. 建 AssemblyContext，`setupAssemblyUnits(pre-server)` 数据驱动装入稳定核心单元与 profile 接入面
 *      （MCP / 会话执行面 / 通道 / 投递栈 / 文本确认渲染器，产物写回 ctx）
 *   3. 恒定核心后置（ephemeralRuntime / runAgentTurn / systemHandlers）—— ephemeralRuntime 消费
 *      Host 前置阶段 connectAll 后的工具目录，故排在 pre-server 接入面之后构造
 *   4. 构造核心 Scheduler（读 ctx.deliveryStack）+ start + seed 系统任务
 *   5. createServerContext + runServer
 *   6. `setupAssemblyUnits(post-server)`（confirmationBridge，依赖 runServer 后的 connections）
 *   7. 类型化 lifecycle contribution 在 activation gate 内接管 teardown（LIFO）
 *   8. banner / idle reaper / waitForShutdown
 *
 * profile 不"砍主干"，只声明启用哪组接入面（见 PROFILES 描述符）；新增接入面 = 写一个
 * AccessSurface 单元 + 在集合加名字，装配主干一行不改。接入面体系详见 access-surface.ts。
 */

import {
  createEventBus,
  getZhixingHome,
  loadLayeredGuidance,
  type AgentEventMap,
  type SchedulerEventMap,
  worksceneConversationId,
  type DeliveryLifecycleSourcePermit,
} from "@zhixing/core";
import {
  createSkillCatalogProductApiContribution,
  SKILL_CATALOG_PRODUCT_API_EXACT_SET,
  SkillCatalogApplicationService,
} from "@zhixing/core/skills/catalog";
import { createAnchorSkillCatalogManagementCorrectnessPort } from "@zhixing/core/skills/catalog-correctness";
import {
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  ConversationPerspectivesApplicationService,
  ConversationDirectoryApplicationService,
  createConversationIdentityLifecycleApplication,
  createConversationDirectoryProductApiContribution,
} from "@zhixing/core/conversation/application";
import {
  ADVANCEMENT_PRODUCT_API_EXACT_SET,
  AdvancementApplicationService,
  AdvancementConversationLifecycleApplicationService,
  createAdvancementProductApiContribution,
} from "@zhixing/core/advancement/application";
import {
  createScheduleManagementProductApiContribution,
  createScheduleRuntimeProductApiContribution,
  SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
  SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET,
} from "@zhixing/core/scheduler/application";
import {
  createTrustAdministrationProductApiContribution,
  TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET,
} from "@zhixing/core/trust-administration";
import {
  createDeliveryResolutionProductApiContribution,
  DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET,
} from "@zhixing/core/delivery/application";
import {
  createDeviceAdministrationProductApiContribution,
  DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  DeviceAdministrationApplicationService,
  DeviceAdministrationCurrentRemovalMigrationApplicationService,
  DeviceAdministrationCurrentRemovalRecoveryApplicationService,
} from "@zhixing/core/device-administration/application";
import {
  createDeviceAdministrationCurrentRemovalAdmissionPort,
  createDeviceAdministrationCurrentRemovalMechanismPort,
  createDeviceAdministrationCurrentRemovalMigrationLifecyclePort,
  createDeviceAdministrationCurrentRemovalRecoveryBindingPort,
  createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort,
} from "@zhixing/core/device-administration/correctness";
import {
  BackupRecoveryCurrentRemovalApplicationService,
  projectBackupRecoveryPublicStatus,
} from "@zhixing/core/backup-recovery/application";
import {
  defineProductApiExactSet,
  ProductApiDispatcher,
} from "@zhixing/core/product-api";
import {
  createWorksceneProductApiContribution,
  projectWorksceneConversationRuntime,
  WORKSCENE_PRODUCT_API_EXACT_SET,
  WorksceneApplicationError,
  type WorksceneWorkspaceReference,
} from "@zhixing/core/workscene/application";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import {
  createSignedDeviceLifecycleAbort,
  protocolDigest,
  type DeviceLifecycleEvidenceRef,
  type StopHostGeneration,
} from "@zhixing/core/protocol";
import {
  createServerContext,
  bindServer,
  runServer,
  buildSystemHandlers,
  buildBuiltinRegistry,
  DEFAULT_SERVER_CONFIG,
  ServerStateFile,
  ServerLogLifecycle,
  CleanupRegistry,
  getDefaultLogPath,
  resolveProcessStartTime,
  type RunningServer,
  type ServerContext,
} from "@zhixing/server";
import {
  ConfirmationHub,
} from "@zhixing/owner-kernel";
import {
  createRunEventForwarder,
  SESSION_NOTIFICATIONS,
} from "@zhixing/rpc";
import { AssignmentStreamPathUnavailableError } from "./assignment-stream-path-manager.js";
import { AnchorSessionBroadcastLifecycle } from "./anchor-session-broadcast-lifecycle.js";
import { loadCredentials, resolveModelCapability } from "@zhixing/providers";
import chalk from "chalk";
import { isProcessAlive } from "@zhixing/server";
import { RuntimeHost } from "@zhixing/runtime-host";
import { createBuiltinExtraToolsAssembly } from "./builtin-extra-tools.js";
import { createTransientSegmentDeps } from "./segment-deps.js";
import { createConversationAgentTurnAdmissionPort } from "@zhixing/owner-kernel/conversation-agent-turn-admission";
import { createConversationPerspectivesCorrectnessPort } from "./conversation-perspectives-correctness.js";
import {
  createServerConfirmationBinding,
  createServerConversationBinding,
} from "./server-product-bindings.js";
import type {
  AnchorServeBootstrapContext,
  ExecutorRoleModule,
  ServeTopologyPlan,
} from "./role-topology.js";
import { projectRuntimeSecrets } from "../runtime/runtime-secret-projections.js";
import { createRenderSubscribers } from "../render.js";
import { createStdoutWriter } from "../screen/index.js";
import {
  createBlockedRenderer,
} from "../security/index.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import { parseServerSpecs } from "../runtime/mcp-config.js";
import { createHostMcpRuntime } from "../runtime/mcp-runtime-adapter.js";
import { createCliTurnContextProviders } from "../runtime/turn-context-providers.js";
import {
  createHostKernelModelProviderFactory,
  createHostKernelRuntimeEnvironmentFactory,
} from "../runtime/kernel-runtime-bindings.js";
import { createHostAdvancementModelProviderFactory } from "../runtime/advancement-model-provider.js";
import { createServeAdvancementApplications } from "./advancement-controller.js";
import { AdvancementEvidenceHostBinding } from "./advancement-evidence-topology.js";
import { createAdvancementAcceptanceLifecycle } from "./advancement-acceptance-lifecycle.js";
import {
  createAnchorAdvancementConfirmedOriginalTaskAdmissionPort,
  createAnchorAdvancementOriginalTaskExecutionPort,
} from "./advancement-original-task-application.js";
import { createZhixingGuidanceLifecycle } from "./zhixing-guidance-lifecycle.js";
import { readGuidanceFile } from "./read-guidance-file.js";
import { createConversationStorageInfrastructure } from "./conversation-storage-infrastructure.js";
import { createPermissionStorageInfrastructure } from "./permission-storage-infrastructure.js";
import { createAnchorConversationClearCommitPort } from "./conversation-clear-binding.js";
import { createAnchorConversationResumePort } from "./conversation-resume-binding.js";
import { createAnchorConversationRunControlPort } from "./conversation-run-control-binding.js";
import {
  createAnchorConversationTaskListPort,
  createAnchorConversationTaskListToolApplication,
} from "./conversation-task-list-application.js";
import { createAnchorConversationCompactPort } from "./conversation-compact-application.js";
import { createAnchorConversationUsageProjectionPort } from "./conversation-usage-application.js";
import { createAnchorConversationSecurityProjectionPort } from "./conversation-security-application.js";
import {
  createAnchorConversationDeleteCommitPort,
} from "./conversation-delete-binding.js";
import {
  createAnchorWorksceneAssignmentToolApplication,
  createAnchorWorksceneConversationStorageProjectionCleanup,
} from "./workscene-application-adapter.js";
import { createWorksceneStorageCleanupInfrastructure } from "./workscene-storage-cleanup.js";
import { createTrustAdministrationApplication } from "./trust-administration-adapter.js";
import { definePostAdoptionReviewLifecycleContribution } from "./post-adoption-review.js";
import { loadOrCreateToken } from "./token.js";
import { resolveHostProcessMode } from "./self-exec.js";
import { homeToPort } from "./host-port.js";
import { shouldIdleExit } from "./idle-policy.js";
import { setupAssemblyUnits, type AssemblyContext } from "./access-surface.js";
import { DEFAULT_PROFILE, type ServerProfile } from "./profile.js";
import { createAssemblyUnits } from "./access-surfaces.js";
import { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createExecutorReadinessSource } from "./executor-readiness.js";
import {
  createWorksceneConversationRuntimeFactory,
  createAnchorRuntimeCapabilityCatalog,
  createAnchorRuntimeProjectionAssembly,
} from "./workscene-runtime-projection.js";
import { StartupRollback } from "./startup-rollback.js";
import { AssemblyLifecycleContributions } from "./assembly-lifecycle.js";
import { createConfiguredCheckpointOwner } from "./backup-runtime-owner.js";
import { createBorrowedMeshPairedCheckpointTargetSessions } from "./paired-checkpoint-target-infrastructure.js";
import { createPublishedCheckpointTargetInfrastructure } from "./published-checkpoint-target-infrastructure.js";
import { createBackupTargetConfigurationInfrastructure } from "./backup-target-config-infrastructure.js";
import {
  governControlProvider,
  governControlTextCall,
  type GovernedTextCall,
} from "./governed-control-llm.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { createAgentJobRuntimePort } from "./agent-job-runtime.js";
import {
  AnchorSchedulerHostLifecycle,
  AnchorSchedulerRuntime,
} from "./anchor-scheduler-runtime.js";
import { CurrentAnchorFirstPartyRpcRouter } from "./first-party-conversation-mesh.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { publishRequiredCredentialRotations } from "./credential-rotation-publication.js";
import {
  captureManagedHostAdmission,
  coordinateManagedHostTrustTransition,
  loadCurrentManagedServiceState,
  reconcileCurrentManagedService,
  verifyManagedHostAdmission,
} from "./managed-service-runtime.js";
import {
  createManagedServiceAdapter,
  managedServiceDefinitionDigest,
} from "./managed-service.js";
import { cleanupExecutorDeviceLocalState } from "./device-removal-cleanup.js";
import { defineDeviceRemovalLifecycleContribution } from "./device-removal-lifecycle-contribution.js";
import { definePlannedDutyMigrationLifecycleContribution } from "./planned-duty-migration-lifecycle-contribution.js";
import { loadExecutorRemovalLifecycleDecision } from "./device-removal.js";
import {
  commitCurrentDeviceRetirementTransaction,
  readCurrentDeviceRemovalPhaseLsn,
} from "./current-device-retirement-transaction.js";
import { createMeshCompatibilityStateProjection } from "./mesh-compatibility-state.js";
import { buildManagedHostPublicStatus } from "./status.js";
import { createHostDefaultWorkspaceProjection } from "./host-default-workspace.js";
import {
  HostStopCoordinator,
  freezeHostStopAcceptedWork,
  hostStopAlreadySettled,
  hostStopDeliveryLifecycleSources,
  loadHostStopAcceptedWork,
  settleHostStopAcceptedWork,
  type HostStopAcceptedWorkItem,
  type HostStopAcceptedWorkPorts,
  type HostStopAcceptedWorkSnapshot,
} from "./host-stop-lifecycle.js";
import { deleteDeviceKey, deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import {
  decodeRecoveryPackage,
  requireCurrentRecoveryPackage,
} from "@zhixing/mesh/recovery-package";
import { replayTrustChain } from "@zhixing/mesh/trust-chain";
import { MeshConnectionRegistry } from "@zhixing/mesh/bootstrap";
import { ownsCurrentSuccessorEndpoint } from "./startup-server-owner.js";
import { AnchorInternalStopLifecycle } from "./anchor-internal-stop.js";
import { AnchorHostShellLifecycle } from "./anchor-host-shell-lifecycle.js";
import {
  executorIdForDevice,
  MeshExecutorTopologyTrustState,
} from "./mesh-runtime-assembly.js";
import {
  MeshWorksceneRemoteWorkspaceProbe,
  REJECT_REMOTE_WORKSPACE_PROBE,
} from "./workscene-remote-workspace-probe.js";
import { createAnchorWorksceneAuthorityProjection } from "./workscene-authority-projection.js";

const SERVER_VERSION = ZHIXING_CLI_VERSION;

/** Explicit finite contributions for profiles where the corresponding surface is absent. */
const EMPTY_REMOVAL_INBOUND = Object.freeze({
  refuseNewMessages: () => undefined,
  drainAcceptedMessages: async () => undefined,
  resumeNewMessages: () => undefined,
});
const EMPTY_REMOVAL_JOB_OWNER = Object.freeze({
  pauseAccepting: () => undefined,
  acceptedWorkItems: async () => [],
  drain: async () => undefined,
  recoverAcceptedWorkForLifecycle: async () => undefined,
  resumeAccepting: () => undefined,
});
const EMPTY_REMOVAL_CHANNEL = Object.freeze({
  statuses: () => [],
  suspendConfigured: async () => undefined,
  disconnectConfigured: async () => undefined,
  resumeConfigured: async () => undefined,
  connectConfigured: async () => undefined,
});
const EMPTY_REMOVAL_DELIVERY = Object.freeze({
  capture: async () => [],
  install: async (_input: unknown) => undefined,
  read: async (_operationId: string) => [],
  close: () => undefined,
  seal: async (_operationId: string) => undefined,
  settle: async (_input: unknown) => undefined,
  release: async (_operationId: string) => undefined,
  resume: async () => undefined,
});
const EMPTY_REMOVAL_LOCAL_OWNER = Object.freeze({
  recoverAcceptedWorkForLifecycle: async () => undefined,
});

const ABSENT_PLANNED_DUTY_CHANNEL = Object.freeze({
  kind: "absent" as const,
  reason: "channel-disabled" as const,
});
const ABSENT_PLANNED_DUTY_DELIVERY = Object.freeze({
  kind: "absent" as const,
  reason: "channel-disabled" as const,
});
const ABSENT_PLANNED_DUTY_JOB_OWNER = Object.freeze({
  kind: "absent" as const,
  reason: "anchor-only" as const,
});

export interface ServeOptions {
  port?: number;
  host?: string;
  managed?: boolean;
}

/**
 * `zhixing serve` 入口。
 *
 * 用户显式运行时是前台宿主；CLI 自动拉起时通过 env 标记进入后台 child，
 * 两者走同一条 server 逻辑，差异只在进程形态和 stdio/log 装配。
 */
export async function runServeCommand(
  opts: ServeOptions,
  bootstrap: AnchorServeBootstrapContext,
  executor: ExecutorRoleModule | undefined,
  plan: ServeTopologyPlan,
): Promise<void> {
  await runServerProcess(opts, bootstrap, executor, plan);
}

async function runServerProcess(
  opts: ServeOptions,
  bootstrap: AnchorServeBootstrapContext,
  executor: ExecutorRoleModule | undefined,
  plan: ServeTopologyPlan,
): Promise<void> {
  const startupRollback = new StartupRollback();
  const lifecycleContributions = new AssemblyLifecycleContributions(
    startupRollback,
  );
  let startupRegistry: CleanupRegistry | undefined;
  let runner: RunningServer | undefined;
  try {
  const profile: ServerProfile = DEFAULT_PROFILE;
  const zhixingHome = getZhixingHome();
  const deviceCapacity = bootstrap.deviceCapacity;
  const processMode = resolveHostProcessMode(opts.managed);
  const processStartedAt = new Date().toISOString();
  const processStartTime = await resolveProcessStartTime(process.pid);
  const initialManagedServiceState = await loadCurrentManagedServiceState(
    "activate",
    zhixingHome,
  );
  const initialManagedHostAdmission = await captureManagedHostAdmission(
    processMode,
    zhixingHome,
    async () => initialManagedServiceState,
  );
  const isBackground = processMode !== "foreground";
  const daemonLogPath = isBackground ? getDefaultLogPath() : undefined;
  const hostShellLifecycle = new AnchorHostShellLifecycle({
    startupRollback,
    processInfo: {
      version: SERVER_VERSION,
      kind: processMode,
      ...(daemonLogPath ? { logPath: daemonLogPath } : {}),
      startTime: processStartTime,
      startedAt: processStartedAt,
    },
  });
  const serverLogLifecycle = isBackground
    ? new ServerLogLifecycle({
        logger: {
          info: (msg) => console.log(chalk.dim(`[server-log] ${msg}`)),
          error: (msg, err) =>
            console.error(chalk.red(`[server-log] ${msg}`), err instanceof Error ? err.message : err),
        },
      })
    : undefined;
  if (serverLogLifecycle) hostShellLifecycle.acquireServerLog(serverLogLifecycle);
  await serverLogLifecycle?.start();
  // 端口按 home 派生（同 home 同端口 → listen 的 EADDRINUSE 原子仲裁单例 + 并发安全；
  // 不同 home 不同端口 → 多实例并行不撞）。受控内部入口仍可显式传入端口。
  const port = opts.port ?? homeToPort(zhixingHome);
  const host = opts.host ?? DEFAULT_SERVER_CONFIG.host;

  const modelConfiguration = bootstrap.modelConfiguration;
  const kernelEnvironmentConfiguration =
    bootstrap.kernelEnvironmentConfiguration;
  const advancementConfiguration = bootstrap.advancementConfiguration;
  const mcpConfiguration = bootstrap.mcpConfiguration;
  const channelConfiguration = bootstrap.channelConfiguration;
  const workspaceConfiguration = bootstrap.workspaceConfiguration;
  const credentialRotationConfiguration =
    bootstrap.credentialRotationConfiguration;
  const authorityConfiguration = bootstrap.authorityConfiguration;
  const providerCredentials = bootstrap.providerCredentials;
  const mcpCredentials = bootstrap.mcpCredentials;
  const channelCredentials = bootstrap.channelCredentials;
  const credentialExposureCredentials =
    bootstrap.credentialExposureCredentials;
  const credentialRotationCredentials =
    bootstrap.credentialRotationCredentials;
  const credentialGeneration = bootstrap.credentialGeneration;
  const systemProtectedPaths = resolveSystemProtectedSecretPaths();
  const hostDefaultWorkspace = createHostDefaultWorkspaceProjection(
    workspaceConfiguration,
  );
  const permissionStorage = createPermissionStorageInfrastructure({ zhixingHome });

  // ============================================================================
  // 恒定核心前置 —— 接入面 setup 从这里读依赖。
  // ============================================================================

  // 1. token
  const tokenInfo = await loadOrCreateToken();
  if (tokenInfo.generated && processMode !== "managed") {
    console.log(chalk.dim(`Generated new token: ${tokenInfo.path}`));
  }

  // Device lifecycle admission is reconstructed from the durable operation before
  // the inactive endpoint or any producer can be acquired. Downstream surfaces
  // only decide whether frozen work may resume, never whether fresh work may enter.
  const lifecycleAuthorityLog = bootstrap.mesh.bootstrapStore.authorityLog();
  const lifecycleHomeId = (await lifecycleAuthorityLog.originCheckpoint()).logId;
  const lifecycleJournal = new DeviceLifecycleJournal(lifecycleAuthorityLog);
  const localLifecycleOperations = (await lifecycleJournal.active()).filter((operation) =>
    (operation.identity.kind === "stop" &&
      operation.identity.localDeviceId === bootstrap.mesh.deviceKey.deviceId) ||
    (operation.identity.kind === "executor-removal" &&
      operation.identity.targetDeviceId === bootstrap.mesh.deviceKey.deviceId) ||
    (operation.identity.kind === "anchor-uninstall" &&
      operation.identity.currentDeviceId === bootstrap.mesh.deviceKey.deviceId));
  if (localLifecycleOperations.length > 1) {
    throw new Error("More than one local device lifecycle operation owns startup admission");
  }
  const startupLifecycleOperation = localLifecycleOperations[0];
  let startupLifecycle: AssemblyContext["startupLifecycle"];
  if (startupLifecycleOperation) {
    let sources: readonly DeliveryLifecycleSourcePermit[] = [];
    let deliveries: readonly { readonly id: string; readonly revision: string }[] = [];
    let artifactReady = false;
    const acceptedWorkArtifact = startupLifecycleOperation.evidence.some((item) =>
      item.kind === "accepted-work" && item.artifact);
    if (acceptedWorkArtifact && startupLifecycleOperation.identity.kind !== "executor-removal") {
      const snapshot = await loadHostStopAcceptedWork(
        startupLifecycleOperation,
        bootstrap.mesh.bootstrapStore.artifactStore(),
      );
      sources = hostStopDeliveryLifecycleSources(snapshot);
      deliveries = snapshot.owners.delivery;
      artifactReady = true;
    } else if (startupLifecycleOperation.identity.kind === "executor-removal") {
      const decision = await loadExecutorRemovalLifecycleDecision(
        lifecycleAuthorityLog,
        startupLifecycleOperation,
      );
      if (decision?.ownerItems) {
        sources = deliveryLifecycleSourcesFromOwnerItems(decision.ownerItems);
        deliveries = decision.ownerItems
          .filter((item) => item.owner === "delivery")
          .map(({ id, revision }) => ({ id, revision }));
        artifactReady = true;
      }
    }
    const phase = startupLifecycleOperation.phase;
    const sealed = startupLifecycleOperation.identity.kind === "stop"
      ? ["work-settled", "flushed", "ready-to-stop"].includes(phase)
      : startupLifecycleOperation.identity.kind === "executor-removal"
        ? ["authority-settled", "revocation-ready", "revoked", "cleanup-complete"].includes(phase)
        : startupLifecycleOperation.identity.path.kind === "migration"
          ? ["transfer-committed", "cleanup-complete"].includes(phase)
          : ["work-settled", "flushed", "final-checkpoint-verified", "cleanup-complete"].includes(phase);
    startupLifecycle = {
      kind: startupLifecycleOperation.identity.kind,
      artifactReady,
      // A successor must prove the old host stopped before replaying any frozen owner effect.
      recoverAcceptedWork: startupLifecycleOperation.identity.kind === "stop"
        ? false
        : artifactReady,
      alreadySettled: startupLifecycleOperation.identity.kind === "stop"
        ? hostStopAlreadySettled(phase)
        : false,
      delivery: {
        operationId: startupLifecycleOperation.identity.operationId,
        sources,
        deliveries,
        sealed,
      },
    };
  }

  // The final home endpoint is acquired inactive. Workscene receives its complete
  // topology demand only after this same endpoint owns the live connection projection.
  const serverBinding = await bindServer({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
  });
  hostShellLifecycle.acquireBinding(serverBinding);

  const registry = new CleanupRegistry({
    activeOwners: plan.activeCleanupOwners,
    logger: {
      info: (msg) => console.log(chalk.dim(`[cleanup] ${msg}`)),
      error: (msg, err) =>
        console.error(chalk.red(`[cleanup] ${msg}`), err instanceof Error ? err.message : err),
    },
  });
  startupRegistry = registry;

  const stopEndpointLock = {
    pid: process.pid,
    port: serverBinding.port,
    startTime: processStartTime,
    startedAt: processStartedAt,
  } as const;
  const stateFile = new ServerStateFile({ publishReadyMarker: isBackground });
  hostShellLifecycle.acquireStateFile(stateFile);
  const meshConnectionProjection = createMeshCompatibilityStateProjection(stateFile, {
    ...stopEndpointLock,
    host: serverBinding.host,
  });
  await meshConnectionProjection.replaceCurrent([]);
  const meshExecutorTopologyTrust = bootstrap.mesh.mode === "trusted-home"
    ? new MeshExecutorTopologyTrustState(bootstrap.mesh.trust)
    : undefined;
  const meshConnections = bootstrap.mesh.mode === "trusted-home"
    ? new MeshConnectionRegistry({
        projection: meshConnectionProjection,
        onProjectionError: (error) =>
          console.warn(chalk.yellow(`[mesh] ${error.message}`)),
      })
    : undefined;
  const remoteWorkspaceProbe = meshExecutorTopologyTrust && meshConnections
    ? new MeshWorksceneRemoteWorkspaceProbe({
        trust: meshExecutorTopologyTrust,
        connections: meshConnections,
      })
    : REJECT_REMOTE_WORKSPACE_PROBE;

  const worksceneStorageCleanup = createWorksceneStorageCleanupInfrastructure({
    zhixingHome,
    storageMaintenance: deviceCapacity.storage,
  });
  const conversationStorage = createConversationStorageInfrastructure({
    optimalMaxTokens: resolveModelCapability(
      modelConfiguration.llm?.main?.model ?? "",
    ).optimalMaxTokens,
    worksceneConversationStorageRemoval: worksceneStorageCleanup.conversations,
    clearTaskListCache: (conversationId) =>
      builtinExtraTools.taskListService.clear(conversationId),
  });
  // 对话目录(盘上事实:清单 / 建删 / 改名 / 清空 / 倒读)——session.* 命令
  // 执行体的持久层,与 REPL 同 scope(同 home 同目录)。task_list cache 清理
  // 经 lazy 闭包接 builtinExtraTools(声明在后,运行期调用时已就位)。
  const conversationDirectory = conversationStorage.directory;
  const conversationIdentityLifecycle =
    createConversationIdentityLifecycleApplication({
      exists: (conversationId) => conversationDirectory.exists(conversationId),
      create: async () =>
        (await conversationDirectory.create()).conversationId,
      ensure: async (conversationId) => {
        await conversationDirectory.ensure(conversationId);
      },
      ensureTranscript: (conversationId) =>
        conversationDirectory.ensureTranscript(conversationId),
    });
  const worksceneConversationStorageProjectionCleanup =
    createAnchorWorksceneConversationStorageProjectionCleanup(
      conversationDirectory,
    );
  const worksceneAssignmentTools =
    createAnchorWorksceneAssignmentToolApplication();
  // Trust Administration owns management semantics; the adapter below only
  // maps its finite repository port to the existing storage mechanism.
  const trustAdministration = createTrustAdministrationApplication({
    configuration: workspaceConfiguration,
    repository: permissionStorage.management,
    workspaceIdentity: permissionStorage.workspaceIdentity,
  });
  // serve 模式无 spinner —— 不传 renderer,pauseUI 退化为 no-op。
  // 写屏走 stdout writer（后台宿主无 chrome），retry/compact 等事件
  // 直接打到 stdout 日志。工厂结果在多个 runtime 之间共享:每次 runtime.run() 各自
  // 装配独立 listener,工厂自身无跨 run 状态,共享安全且节省一次函数创建开销。
  const serveWriter = createStdoutWriter();
  const renderDecorator = createRenderSubscribers({ writer: serveWriter });

  // 带外事件与活动提示在任何长期消费者之前取得同一稳定 Host port；真实
  // Server transport 只在 inactive endpoint 的 activation gate 内安装。
  const sessionBroadcastLifecycle = new AnchorSessionBroadcastLifecycle();
  const sessionBroadcast = sessionBroadcastLifecycle.port.session;
  const sessionActivityBroadcast = sessionBroadcastLifecycle.port.activity;
  const runEventForwarder = createRunEventForwarder((conversationId, envelope) =>
    sessionBroadcast(conversationId, SESSION_NOTIFICATIONS.event, envelope),
  );
  // 单钩子双装饰:本地日志渲染 + 跨进程转发,各自管理自己的订阅与 dispose
  const serveDecorateRunBus: typeof renderDecorator = (ctx) => {
    const disposeRender = renderDecorator(ctx);
    const disposeForward = runEventForwarder(ctx);
    return () => {
      disposeRender();
      disposeForward();
    };
  };
  let assemblyContext: AssemblyContext | undefined;
  const conversationPerspectives = new ConversationPerspectivesApplicationService({
    correctness: createConversationPerspectivesCorrectnessPort({
      manager: () => {
        const manager = assemblyContext?.conversations;
        if (!manager) {
          throw new Error("Conversation perspective correctness is not assembled");
        }
        return manager;
      },
    }),
    createRunEventBus: () => createEventBus<AgentEventMap>(),
    decorateRunBus: serveDecorateRunBus,
    onDurableFinalPublicationDeferred: (error) => {
      console.warn(
        "[perspectives] durable result committed; final publication will be retried",
        error,
      );
    },
  });

  // 3a. ConfirmationHub —— 远程权限确认聚合层（见 remote-confirmation-execution.md）
  //   在会话执行面 / 通道 / ephemeralRuntime / ServerContext 之前创建，以便各组件构造时能接入。
  const confirmationHub = new ConfirmationHub();
  // Scheduler generation owner 在任何长期消费者之前构造稳定产品端口；
  // 物理 mechanism/product 只由 owner 在 initial/replacement 事务中原子安装。
  const schedulerGenerationOwner = new AnchorSchedulerHostLifecycle({
    confirmationHub,
    workingDirectory: hostDefaultWorkspace.postAdoptionReviewWorkingDirectory,
  });
  const schedulerApplication = schedulerGenerationOwner.application;
  const schedulerManagement = schedulerGenerationOwner.management;
  const schedulerFacade = schedulerGenerationOwner.facade;

  // 3b. MCP host —— Authority 的 executor readiness 必须读取与实际 runtime 相同的
  //   已连接工具目录，因此连接与唯一 cleanup owner 在 Authority 构造前成立。
  //   serve 进程内单例，多 session 共享同一批连接。空配置时为 no-op。
  const mcpRuntime = createHostMcpRuntime(
    parseServerSpecs(mcpConfiguration.mcp, mcpCredentials.mcp),
    { networkProxy: mcpConfiguration.network?.proxy },
  );
  lifecycleContributions.acquire("mcpRuntime.close", () =>
    mcpRuntime.lifecycle.close(),
  );
  await mcpRuntime.lifecycle.connect();

  // 3c. Builtin extra tools assembly —— task_list / schedule 工具的装配点，所有
  //   per-session runtime 共享同一 service 单例（cache by sessionId/conversationId）。
  //   task_list 盘上状态按全域 conversationId 路由到所属 scope repo；user / workscene
  //   与目录 clear 共用同一 repo 实例，保 meta 写入锁一致。
  const builtinExtraTools = createBuiltinExtraToolsAssembly(
    conversationStorage.taskLists,
    createAnchorConversationTaskListToolApplication(),
  );
  const anchorRuntimeCapabilities = createAnchorRuntimeCapabilityCatalog({
    extraTools: builtinExtraTools,
    mcpTools: mcpRuntime.tools,
    scheduler: schedulerFacade,
  });
  const executorReadiness = createExecutorReadinessSource({
    runtime: anchorRuntimeCapabilities,
    credentials: credentialExposureCredentials,
    credentialGeneration,
  });
  const authorityRuntime = await setupAuthorityRuntime({
    zhixingHome,
    secretStore: bootstrap.secretStore,
    deviceKey: bootstrap.mesh.deviceKey,
    trustedIdentities: bootstrap.mesh.trustedIdentities,
    authorizedDeviceIds: bootstrap.mesh.authorizedDeviceIds,
    executorId: executorIdForDevice(bootstrap.mesh.deviceKey.deviceId),
    ...(bootstrap.mesh.mode === "trusted-home" &&
    bootstrap.mesh.installedAuthorityGeneration
      ? {
          anchorEpoch:
            bootstrap.mesh.installedAuthorityGeneration.anchorEpoch,
          installedAuthorityGeneration:
            bootstrap.mesh.installedAuthorityGeneration,
        }
      : {}),
    configurationSnapshot: {
      config: authorityConfiguration,
      executableVersion: ZHIXING_CLI_VERSION,
    },
    executorReadiness,
    enableLocalExecutor: bootstrap.mesh.roles.includes("executor"),
    storageMaintenance: deviceCapacity.storage,
    deviceCapacity: deviceCapacity.arbiter,
    startupRollback,
  });
  lifecycleContributions.contribute(
    "authorityRuntime.stopStorageMaintenance",
    authorityRuntime.startupCleanup,
  );
  const worksceneAuthority = createAnchorWorksceneAuthorityProjection({
    authority: authorityRuntime,
    remoteWorkspaceProbe,
  });
  const anchorRuntimeProjections = createAnchorRuntimeProjectionAssembly({
    capabilities: anchorRuntimeCapabilities,
    workscenes: worksceneAuthority.tools,
    worksceneAssignmentTools,
    extraTools: builtinExtraTools,
    mcpTools: mcpRuntime.tools,
    scheduler: schedulerFacade,
  });
  // 3c'. 段切换外部依赖 —— serve 全部 runtime（per-session + ephemeral）共享：
  //   注意力窗口的段保护对一切运行体生效。persistence 为 no-op（serve 未接
  //   ConversationRepository，segmentMeta 缺写无害）；taskListReader 复用同一
  //   TaskListService，in-progress 守卫与 REPL 同源。
  const serveSegmentDeps = createTransientSegmentDeps({
    taskListService: builtinExtraTools.taskListService,
  });

  const durableInteractions = new DurableConversationInteractionObserver();
  const advancementEvidenceRuntime = new AdvancementEvidenceHostBinding();
  const advancementConversationComposition: AssemblyContext["advancementConversationComposition"] =
    Object.freeze({
      async create(
        input: Parameters<
          AssemblyContext["advancementConversationComposition"]["create"]
        >[0],
      ) {
        const { controller, reviews } = await createServeAdvancementApplications({
          modelProvider: createHostAdvancementModelProviderFactory({
            configuration: advancementConfiguration,
            credentials: providerCredentials,
          }),
          // Authority is complete here; the existing generation-aware governor
          // projection remains intentionally dynamic and is outside this seam.
          governor: () => authorityRuntime.resourceGovernor,
          sessionState: input.sessionState,
          recentContext: input.recentContext,
          evidenceRuntime: advancementEvidenceRuntime,
          rubricRuntime: () => ({
            globalState: authorityRuntime.globalState!,
            artifacts: authorityRuntime.rubricArtifacts,
            anchorEpoch: authorityRuntime.anchorEpoch,
          }),
          onAdmissionTiming: (elapsedMs) => {
            console.log(chalk.dim(`[advancement] admission ${elapsedMs}ms`));
          },
        });
        const lifecycle =
          new AdvancementConversationLifecycleApplicationService({
            mechanism: {
              loadOpenConversationLifecycleSession: (conversationId) =>
                controller.loadOpenConversationLifecycleSession(conversationId),
              persistConversationLifecycleCancellation: (request) =>
                reviews.cancelSession(request),
              removeConversationData: (conversationId) =>
                controller.removeConversationLifecycleData(conversationId),
              listConversationDataCandidates: () =>
                controller.listConversationLifecycleDataCandidates(),
              removeConversationDataCandidate: (candidateId) =>
                controller.removeConversationLifecycleDataCandidate(candidateId),
            },
            conversationAlive: {
              isConversationDataAlive:
                conversationStorage.maintenance.isConversationDataAlive,
            },
          });
        return Object.freeze({ controller, reviews, lifecycle });
      },
    });

  // 3d. RuntimeHost —— 通用 runtime 装配点:共享 Kernel 资产与渲染装饰；
  //   Schedule / Task / MCP / Workscene 已由上面的 Anchor 产品投影统一裁决。
  //   投递 origin 执行期从 RunContext 派生,实例装配不再按对话定制。
  //   turn-context provider 集合在 runtime 发布前作为固定装配输入建立——scheduler
  //   是 generation-safe 的领域运行投影，LLM 调用时刻权威已就绪；未就绪时
  //   fallback 空状态。
  const resolveWorksceneWorkspaceRoot = (
    sceneId: string,
    workspace: WorksceneWorkspaceReference,
  ): Promise<string> =>
    worksceneAuthority.resolveWorkspaceRoot(sceneId, workspace);
  const resolveWorksceneRoot = async (sceneId: string): Promise<string | null> => {
    try {
      const projection = await projectWorksceneConversationRuntime(
        worksceneAuthority.runtime,
        { conversationId: worksceneConversationId(sceneId, "guidance") },
      );
      if (projection.kind !== "scene" || !projection.workspace) return null;
      return resolveWorksceneWorkspaceRoot(sceneId, projection.workspace);
    } catch (error) {
      if (error instanceof WorksceneApplicationError && error.kind === "not-found") {
        return null;
      }
      throw error;
    }
  };

  const createConversationAgentRuntime = createWorksceneConversationRuntimeFactory({
    issue: (projection) => runtimeHost.createConversationRuntime(projection),
    projections: anchorRuntimeProjections,
    projectConversationRuntime: (query) =>
      projectWorksceneConversationRuntime(worksceneAuthority.runtime, query),
    resolveWorkspaceRoot: resolveWorksceneWorkspaceRoot,
    prepareWorkspaceRoot: (sceneId, absolutePath) =>
      worksceneAuthority.prepareWorkspaceRoot(sceneId, absolutePath),
  });

  // RuntimeFactory —— 会话执行面（接入面）建 per-session runtime 的工厂。schedule 档无
  //   会话执行面，工厂作无副作用留位（不连接、不建目录）。
  //   注：工厂内实例发放是 lazy（session 调用时才建），那时 Host MCP 前置 connectAll
  //   早已完成，故工厂装配可前置、不受 connectAll 时序约束（与 eager 的
  //   ephemeralRuntime 不同——后者须排在接入面之后，见下）。
  const executorRole = executor?.createExecutorRole({
    createAgentRuntime: createConversationAgentRuntime,
  });
  const runtimeFactory = executorRole && executor
    ? executor.createInProcessRuntimeFactory(executorRole)
    : {
        async create(): Promise<never> {
          throw new Error("Local executor role is not enabled on this device");
        },
      };
  const assignmentRuntimeFactory = executorRole && executor
    ? executor.createInProcessAssignmentRuntimeFactory(executorRole)
    : runtimeFactory;
  const jobRuntime = executor
    ? createAgentJobRuntimePort({
        create: (instruction, confirmationBroker) => {
          const projection = anchorRuntimeProjections.job(instruction);
          return runtimeHost.createJobRuntime({
            confirmationBroker,
            ...projection,
          });
        },
      })
    : undefined;
  // ============================================================================
  // 有序装配 —— 稳定核心单元恒启用，profile 仅选择可选接入面；setupAssemblyUnits
  // 按依赖拓扑序遍历、各自 setup（产物写回 ctx）。主干不出现任何 `if (profile === ...)`。
  // ============================================================================
  const channelHttpRoutes: AssemblyContext["channelHttpRoutes"] = new Map();
  const anchorInternalStopLifecycle = new AnchorInternalStopLifecycle();
  const anchorInternalStop = anchorInternalStopLifecycle.port;
  const onTrustApplied = () => coordinateManagedHostTrustTransition({
    processMode,
    expectedAdmission: initialManagedHostAdmission,
    refuseNewMessages: () => assemblyContext?.inboundRouter?.refuseNewMessages(),
    requestShutdown: () => anchorInternalStop.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    }),
  }).then(() => undefined);

  const ctx: AssemblyContext = {
    profile,
    modelConfiguration,
    advancementConfiguration,
    channelConfiguration,
    authorityConfiguration,
    providerCredentials,
    zhixingHome,
    secretStore: bootstrap.secretStore,
    durableInteractions,
    conversationPerspectives,
    deviceCapacity: deviceCapacity.arbiter,
    advancementCapacity: deviceCapacity.workload("workload-advancement"),
    storageMaintenance: deviceCapacity.storage,
    localWorkspaceIdentity: bootstrap.localWorkspaceIdentity,
    confirmationHub,
    mcpStatus: mcpRuntime.status,
    conversationRuntimeStorage: conversationStorage.runtime,
    conversationCommittedViewStorage: conversationStorage.committedViews,
    conversationNamingStorage: conversationStorage.naming,
    runtimeFactory,
    assignmentRuntimeFactory,
    ...(jobRuntime ? { jobRuntime } : {}),
    executorReadiness,
    ...(executor ? { executorRoleModule: executor } : {}),
    conversationIdentityLifecycle,
    conversationClearProjection: conversationDirectory,
    conversationDeleteProjection: conversationDirectory,
    taskListService: builtinExtraTools.taskListService,
    authorityRuntime,
    worksceneAuthority,
    worksceneConversationStorageProjectionCleanup,
    worksceneSceneStorageRemoval: worksceneStorageCleanup.scenes,
    sessionBroadcast,
    sessionActivityBroadcast,
    advancementDirectory: {
      list: () => conversationDirectory.listForAdvancement(),
      exists: (conversationId) => conversationDirectory.exists(conversationId),
      readRunsReverse: (conversationId, options) =>
        conversationDirectory.readRunsReverse(conversationId, options),
    },
    advancementEvidenceRuntime,
    advancementConversationComposition,
    startupRollback,
    lifecycleContributions,
    channelHttpRoutes,
    enabledRoles: bootstrap.mesh.roles,
    meshBootstrap: bootstrap.mesh,
    meshConnectionProjection,
    ...(meshConnections ? { meshConnections } : {}),
    ...(meshExecutorTopologyTrust ? { meshExecutorTopologyTrust } : {}),
    onTrustApplied,
    ...(startupLifecycle ? { startupLifecycle } : {}),
  };
  assemblyContext = ctx;
  let startupLifecycleFrozenRecoveryStarted = startupLifecycle?.recoverAcceptedWork ?? true;
  let removalAdmissionOperationId: string | undefined;
  let removalBootstrapAdmissionClosed = true;
  const assemblyUnits = createAssemblyUnits(channelCredentials);

  // Conversation owner is the construction boundary for Advancement. Assemble
  // through that unit first, then create the one RuntimeHost from the completed
  // direct ports before any recovery, ingress, or Product API consumer can run.
  const conversationAssemblyIndex = assemblyUnits.findIndex(
    (unit) => unit.name === "conversation",
  );
  if (conversationAssemblyIndex < 0) {
    throw new Error("Conversation assembly unit is required");
  }
  await setupAssemblyUnits(
    assemblyUnits.slice(0, conversationAssemblyIndex + 1),
    ctx,
    "pre-server",
  );
  const advancementController = ctx.advancement;
  const advancementReviews = ctx.advancementReviews;
  const advancementConversationLifecycle =
    ctx.advancementConversationLifecycle;
  if (
    !advancementController ||
    !advancementReviews ||
    !advancementConversationLifecycle
  ) {
    throw new Error(
      "Conversation assembly did not publish the Advancement application",
    );
  }

  const runtimeHost = new RuntimeHost({
    modelProvider: createHostKernelModelProviderFactory({
      configuration: modelConfiguration,
      credentials: providerCredentials,
    }),
    runtimeEnvironment: createHostKernelRuntimeEnvironmentFactory({
      configuration: kernelEnvironmentConfiguration,
    }),
    toolImplementation: bootstrap.toolImplementation,
    permissionStorage: permissionStorage.runtime,
    confirmationLifecycleObserver: durableInteractions,
    systemProtectedPaths,
    artifactStore: () => authorityRuntime.artifacts,
    segmentDeps: serveSegmentDeps,
    deviceCapacity: {
      interactive: deviceCapacity.workload("workload-interactive"),
      scheduler: deviceCapacity.workload("workload-scheduler"),
      orchestration: deviceCapacity.workload("workload-orchestration"),
    },
    lifecycle: [
      createAdvancementAcceptanceLifecycle(advancementController),
      createZhixingGuidanceLifecycle({
        getZhixingHome,
        resolveWorksceneRoot,
        readGuidanceFile,
        loadLayeredGuidance,
      }),
    ],
    decorateRunBus: serveDecorateRunBus,
    onSecurityBlocked: createBlockedRenderer(serveWriter),
    turnContextProviders: () =>
      createCliTurnContextProviders({
        getSchedulerStatus: () => schedulerApplication.readStatus().turnContext,
        taskListService: builtinExtraTools.taskListService,
      }),
  });

  // Finish the pre-server graph only after the immutable Advancement/RuntimeHost
  // knot is closed. Later units may now publish recovery and ingress consumers.
  await setupAssemblyUnits(
    assemblyUnits.slice(conversationAssemblyIndex + 1),
    ctx,
    "pre-server",
  );
  ctx.authorityCheckpointOwner = await createConfiguredCheckpointOwner({
    backupTargets: createBackupTargetConfigurationInfrastructure(zhixingHome),
    publishedDirectoryTargets: createPublishedCheckpointTargetInfrastructure({
      zhixingHome,
      storageMaintenance: ctx.storageMaintenance,
    }).directory,
    mesh: ctx.meshBootstrap,
    pairedTargets: createBorrowedMeshPairedCheckpointTargetSessions(
      ctx.meshRuntimePreparation
        ? {
            kind: "available",
            connections: ctx.meshRuntimePreparation.connections,
            storageMaintenance: ctx.storageMaintenance,
          }
        : {
            kind: "runtime-unavailable",
            storageMaintenance: ctx.storageMaintenance,
          },
    ),
    storageMaintenance: ctx.storageMaintenance,
    ...(ctx.authorityRuntime
      ? {
          checkpointRetention: {
            checkpointRetentionSnapshot: () =>
              ctx.authorityRuntime!.checkpointRetention.checkpointRetentionSnapshot(),
            retainedAtCheckpoint: (snapshot, candidates) =>
              ctx.authorityRuntime!.checkpointRetention.retainedAtCheckpoint(
                snapshot,
                candidates,
              ),
          },
        }
      : {}),
    onError: (error) => console.error(
      chalk.red("[recovery-backup]"),
      error instanceof Error ? error.message : String(error),
    ),
  });
  if (ctx.authorityCheckpointOwner) {
    hostShellLifecycle.acquireCheckpointOwner(ctx.authorityCheckpointOwner);
  }
  await ctx.authorityCheckpointOwner?.start();
  const worksceneDirectory = ctx.worksceneDirectory;
  const worksceneApplication = ctx.worksceneApplication;
  if (!worksceneDirectory || !worksceneApplication) {
    throw new Error("Workscene product composition is incomplete");
  }
  await worksceneDirectory.recover();

  // ============================================================================
  // 恒定核心后置 —— 须在 pre-server 接入面之后构造。
  // Anchor 产品投影从有限 MCP 端口同步取得当前工具目录，而目录已在 Authority
  // readiness 之前 connectAll；故这个 eager runtime 必须排在 Host MCP 前置之后，
  // 否则其 system prompt 缺 MCP 工具（runtimeFactory 是 lazy，session 调用时 connectAll 已完成，
  // 不受此序约束、可前置）。
  // ============================================================================

  // 4b. Ephemeral Runtime — 定时任务专用（恒定核心，不属任何接入面）。
  //
  // 为什么独立于会话执行面：
  // - ConversationManager 为持久用户会话设计，会建立持久身份并累积
  //   消息历史、依赖 idle-reaper 释放。定时任务若走此路径，每次执行都留磁盘痕迹，导致
  //   conversations/ 无限膨胀。
  // - Ephemeral 执行对标 K8s Job / Serverless / Claude Code 子 Agent：任务独立、无身份、
  //   不累积历史、零磁盘痕迹。与持久用户会话是两套完全独立的语义。
  //
  // 为什么共享单例 runtime 而非每任务新建：createAgentRuntime 有 provider 连接、系统提示、
  // 项目上下文加载等启动成本；AgentRuntime.run() 对会话历史无状态（messages 每次传入），
  // 复用安全；token estimator 校准、permission 规则跨任务共享是正收益。
  //
  // 装配经 RuntimeHost 与会话实例完全对称（同资产层、同 turn-context 注册）；
  // 定时任务路径 runtime.run 不传 conversationId——schedule origin 派生为 null
  // （任务 AI 自创建子任务非用户发起），TaskListProvider 闭包内 ALS 取不到
  // → getItems 返 [] → 整段跳过，不污染 turn-context。
  const ephemeralRuntime = await runtimeHost.createEphemeralRuntime(
    anchorRuntimeProjections.ephemeral(),
  );
  lifecycleContributions.acquire("ephemeralRuntime.dispose", () =>
    ephemeralRuntime.dispose("session-dispose"),
  );

  if (ctx.authorityRuntime) {
    await publishRequiredCredentialRotations({
      authority: new CredentialExposureAuthority({
        deviceId: ctx.authorityRuntime.deviceId,
        log: ctx.authorityRuntime.authorityLog,
        secretStore: ctx.secretStore,
      }),
      deviceId: ctx.authorityRuntime.deviceId,
      configuration: credentialRotationConfiguration,
      credentials: credentialRotationCredentials,
      credentialGeneration,
      readCredentials: async () =>
        projectRuntimeSecrets(
          await loadCredentials({ store: bootstrap.secretStore }),
        ).credentialRotationCredentials,
      governProvider: (provider) =>
        governControlProvider(
          {
            governor: ctx.authorityRuntime!.resourceGovernor,
            origin: { admissionClass: "interactive", entry: "environment-control" },
            workPrefix: "credential-rotation-provider",
            defaultMaxOutputTokens: 1,
            deadlineMs: 15_000,
          },
          provider,
        ),
      mcpStatuses: () => ctx.mcpStatus.snapshot(),
      channelStatuses: () => ctx.channelStatuses?.() ?? [],
      ...(ctx.channelConnections
        ? { waitForChannels: () => ctx.channelConnections!.ready }
        : {}),
    });
  }

  // Scheduler job 由 executor owner 的耐久数据面执行；管理用 ephemeral
  // runtime 只服务 llm.complete，不再充当 scheduler runtime 或确认 broker。
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  const systemHandlers = buildSystemHandlers({
    transcript: {
      runSweep: conversationStorage.maintenance.runRetentionSweep,
    },
    advancement: {
      runSweep: () => advancementConversationLifecycle.sweepOrphanData(),
    },
  });

  // Anchor 是 scheduler/job 唯一 owner。非 anchor 拓扑不装 timer、journal
  // recovery 或兼容迁移器，schedule 产品入口保持明确不可用。
  async function settleScheduleForTransfer(): Promise<void> {
    await schedulerApplication.settleAcceptedWork({
      strategy: "drain",
      frozen: await schedulerApplication.captureAcceptedWork(),
    });
  }
  let schedulerCleanup: ReturnType<StartupRollback["register"]> | undefined;
  async function recoverStartupLifecycleAcceptedWork(
    sources: readonly DeliveryLifecycleSourcePermit[],
  ): Promise<void> {
    if (!startupLifecycle || startupLifecycleFrozenRecoveryStarted) return;
    startupLifecycleFrozenRecoveryStarted = true;
    try {
      await ctx.localConversationOwner?.recoverAcceptedWorkForLifecycle();
      await ctx.executorJobOwner?.recoverAcceptedWorkForLifecycle();
      await ctx.meshRuntime?.recoverAcceptedWorkForLifecycle();
      await ctx.channelCoordinator?.recover();
      await schedulerApplication.recoverAcceptedWork(
        sources
          .filter((source) => source.owner === "scheduler")
          .map(({ id, revision }) => ({ id, revision })),
      );
    } catch (error) {
      startupLifecycleFrozenRecoveryStarted = false;
      throw error;
    }
  }
  if (ctx.enabledRoles.includes("anchor")) {
    if (
      !ctx.authorityRuntime ||
      !ctx.conversationProtocol ||
      !ctx.jobStatus ||
      !ctx.jobRelayObligations
    ) {
      throw new Error(
        "Anchor scheduler requires authority, protocol, job status, and relay owners",
      );
    }
    const createSchedulerRuntime = () => AnchorSchedulerRuntime.create({
      authority: ctx.authorityRuntime!,
      protocol: ctx.conversationProtocol!,
      ...(ctx.enabledRoles.includes("executor") && ctx.conversationExecutorLedger
        ? { localExecutor: ctx.conversationExecutorLedger }
        : {}),
      eventBus: schedulerEventBus,
      jobStatus: ctx.jobStatus!,
      jobRelays: ctx.jobRelayObligations!,
      openManualJobSurface: async (input) => {
        const coordinator = ctx.channelCoordinator;
        if (!coordinator) {
          throw new Error("Manual job data plane is unavailable");
        }
        const session = await coordinator.openFirstPartySurfaceSession({
          executorId: input.executorId,
          assignmentId: input.assignmentId,
          ref: input.ref,
          ticket: input.ticket,
          surfacePrincipal: input.surfacePrincipal,
          adoptFrame: async (frame) => {
            const binding = runner?.server.context.rpcSurfaces?.current(
              input.surfacePrincipal,
            );
            if (
              !binding ||
              binding.connection.surfaceGeneration !== binding.generation ||
              !binding.connection.tryNotify?.(
                SESSION_NOTIFICATIONS.assignmentStream,
                frame,
              )
            ) {
              throw new AssignmentStreamPathUnavailableError(
                "Manual job surface is disconnected",
              );
            }
          },
        });
        session.start();
        return session;
      },
      ...(ctx.executorJobOwner ? { localJobOwner: ctx.executorJobOwner } : {}),
      mesh: () => ctx.meshRuntime,
      capabilities: anchorRuntimeProjections.capabilityCatalog(),
      systemHandlers,
      systemTasks: new Map([
        [
          "__transcript-gc",
          {
            id: "__transcript-gc",
            name: "transcript-gc",
            handler: "__transcript-gc",
            schedule: { kind: "cron", expr: "30 3 * * *" },
          },
        ],
        [
          "__advancement-gc",
          {
            id: "__advancement-gc",
            name: "advancement-gc",
            handler: "__advancement-gc",
            schedule: { kind: "cron", expr: "0 4 * * *" },
          },
        ],
      ]),
      onError: (error) =>
        console.error(chalk.red(`[scheduler] ${error.message}`)),
    });
    const prepareSchedulerGeneration = async (runtime: AnchorSchedulerRuntime) => {
      await runtime.start();
      if (startupLifecycle) {
        runtime.closeAdmission();
        if (startupLifecycle.recoverAcceptedWork) {
          await runtime.recoverAcceptedWork(
            startupLifecycle.delivery.sources
              .filter((source) => source.owner === "scheduler")
              .map(({ id, revision }) => ({ id, revision })),
          );
        }
      }
    };
    const publishSchedulerGeneration = (
      _runtime: AnchorSchedulerRuntime,
      globalState: ReturnType<AnchorSchedulerRuntime["createProductBoundary"]>["globalState"],
    ) => {
      const releaseGlobalState =
        ctx.authorityRuntime!.installSchedulerGlobalState(globalState);
      return releaseGlobalState;
    };
    const bindSchedulerGeneration = (runtime: AnchorSchedulerRuntime) => {
      return runtime.bindGeneration();
    };
    const activateSchedulerGeneration = (
      runtime: AnchorSchedulerRuntime,
      activate: boolean,
    ) => {
      if (activate && !startupLifecycle) {
        runtime.activate();
      }
    };
    const resumeSchedulerGeneration = async (
      runtime: AnchorSchedulerRuntime,
      activate: boolean,
    ) => {
      if (activate && !startupLifecycle) {
        await runtime.resumeManualSurfaces();
      }
    };
    const schedulerRuntime = await createSchedulerRuntime();
    schedulerCleanup = startupRollback.register(
      "scheduler.stop",
      () => schedulerGenerationOwner.stopAndRelease(),
    );
    lifecycleContributions.contribute("scheduler.stop", schedulerCleanup);
    await schedulerGenerationOwner.installInitial({
      mechanism: schedulerRuntime,
      prepare: prepareSchedulerGeneration,
      bind: bindSchedulerGeneration,
      publish: publishSchedulerGeneration,
      activate: (runtime) => activateSchedulerGeneration(runtime, false),
      resume: (runtime) => resumeSchedulerGeneration(runtime, false),
    });

    const preparedMesh = ctx.meshRuntimePreparation;
    if (preparedMesh) {
      const authority = ctx.authorityRuntime;
      const channelCoordinator = ctx.channelCoordinator;
      const jobRelays = ctx.jobRelayObligations;
      const conversations = ctx.conversations;
      const conversationProtocol = ctx.conversationProtocol;
      const plannedInbound = ctx.inboundRouter;
      if (
        !authority ||
        !channelCoordinator ||
        !jobRelays ||
        !conversations ||
        !conversationProtocol ||
        !plannedInbound
      ) {
        throw new Error(
          "Mesh lifecycle recovery requires authority, conversation, data-plane, and relay owners",
        );
      }
      const inbound = ctx.inboundRouter === undefined || ctx.inboundRouter === null
        ? EMPTY_REMOVAL_INBOUND
        : ctx.inboundRouter;
      const jobOwner = ctx.executorJobOwner === undefined
        ? EMPTY_REMOVAL_JOB_OWNER
        : ctx.executorJobOwner;
      const localOwner = ctx.localConversationOwner === undefined
        ? EMPTY_REMOVAL_LOCAL_OWNER
        : ctx.localConversationOwner;
      const delivery = ctx.deliveryStack === undefined
        ? EMPTY_REMOVAL_DELIVERY
        : ctx.deliveryStack.lifecycle;
      const channel = ctx.channelConnections && ctx.channelStatuses
        ? Object.freeze({
            statuses: ctx.channelStatuses,
            suspendConfigured: ctx.channelConnections.suspendConfigured,
            disconnectConfigured: ctx.channelConnections.disconnectConfigured,
            resumeConfigured: ctx.channelConnections.resumeConfigured,
            connectConfigured: ctx.channelConnections.connectConfigured,
          })
        : EMPTY_REMOVAL_CHANNEL;
      const plannedChannel = ctx.channelConnections
        ? Object.freeze({
            kind: "available" as const,
            connections: ctx.channelConnections,
          })
        : ABSENT_PLANNED_DUTY_CHANNEL;
      const plannedDelivery = ctx.deliveryStack
        ? Object.freeze({
            kind: "available" as const,
            stack: ctx.deliveryStack,
          })
        : ABSENT_PLANNED_DUTY_DELIVERY;
      const plannedJobOwner = ctx.executorJobOwner
        ? Object.freeze({
            kind: "available" as const,
            owner: ctx.executorJobOwner,
          })
        : ABSENT_PLANNED_DUTY_JOB_OWNER;
      const captureExternal = async (
        owner: "remote" | "channel" | "scheduler" | "delivery",
        _operationId: string,
      ): Promise<readonly HostStopAcceptedWorkItem[]> => {
        if (owner === "remote") {
          const relay = (await jobRelays.listOpen()).map((opening) => ({
            id: `relay:${opening.assignmentId}`,
            revision: opening.sourceRevision,
          }));
          const local = (await jobOwner.acceptedWorkItems()).map((item) => ({
            id: `local:${item.id}`,
            revision: item.revision,
          }));
          return [...relay, ...local].sort((left, right) =>
            left.id.localeCompare(right.id, "en-US"));
        }
        if (owner === "channel") {
          return channel.statuses()
            .filter((status) => status.state !== "disconnected")
            .map((status) => ({
              id: status.channelId,
              revision: protocolDigest("HostStopChannel", 1, {
                channelId: status.channelId,
              }),
            }));
        }
        if (owner === "scheduler") {
          return schedulerApplication.captureAcceptedWork();
        }
        return delivery.capture();
      };
      const recoverFrozenOwners = async (
        sources: readonly DeliveryLifecycleSourcePermit[],
      ): Promise<void> => {
        if (!startupLifecycle || startupLifecycleFrozenRecoveryStarted) return;
        startupLifecycleFrozenRecoveryStarted = true;
        try {
          await localOwner.recoverAcceptedWorkForLifecycle();
          await jobOwner.recoverAcceptedWorkForLifecycle();
          await channelCoordinator.recover();
          await schedulerApplication.recoverAcceptedWork(
            sources
              .filter((source) => source.owner === "scheduler")
              .map(({ id, revision }) => ({ id, revision })),
          );
        } catch (error) {
          startupLifecycleFrozenRecoveryStarted = false;
          throw error;
        }
      };
      const plannedDutyMigrationLifecycle =
        definePlannedDutyMigrationLifecycleContribution({
          kind: "anchor",
          checkpoint: ctx.authorityCheckpointOwner
            ? {
                kind: "available",
                owner: ctx.authorityCheckpointOwner,
              }
            : {
                kind: "unavailable",
                reason: "recovery-backup-unavailable",
              },
          transfer: {
            stopAccepting: async () => {
              plannedInbound.refuseNewMessages();
              await plannedInbound.drainAcceptedMessages();
              if (plannedChannel.kind === "available") {
                await plannedChannel.connections.disconnectConfigured();
              }
              if (plannedDelivery.kind === "available") {
                await plannedDelivery.stack.quiesceForAuthorityTransfer();
              }
              await schedulerApplication.settleAcceptedWork({
                strategy: "drain",
                frozen: await schedulerApplication.captureAcceptedWork(),
              });
            },
            drainAccepted: async () => {
              await conversations.abortAllAndWait(
                { kind: "external", origin: "planned-duty-migration" },
                30_000,
              );
              if (conversations.hasActiveWork()) {
                throw new Error(
                  "Duty-device migration could not drain accepted conversation work",
                );
              }
              if (plannedJobOwner.kind === "available") {
                await plannedJobOwner.owner.drain();
              }
              await conversationProtocol.stopRecoveryLoop();
            },
            resumeAfterAbort: async () => {
              if (plannedDelivery.kind === "available") {
                await plannedDelivery.stack.resumeAfterAuthorityTransfer();
              }
              conversationProtocol.startRecoveryLoop();
              schedulerApplication.resumeAdmission();
              plannedInbound.resumeNewMessages();
              if (plannedChannel.kind === "available") {
                await plannedChannel.connections.connectConfigured();
              }
            },
          },
          postInstall: {
            rebindAuthorityGeneration: async (generation) => {
              const receipt = await authority.rebindInstalledAuthority(generation);
              return receipt;
            },
            recoverScheduler: async (obligations) => {
              await schedulerGenerationOwner.recoverInstalledAuthority({
                currentAnchorEpoch: authority.anchorEpoch,
                create: createSchedulerRuntime,
                prepare: prepareSchedulerGeneration,
                bind: bindSchedulerGeneration,
                publish: publishSchedulerGeneration,
                activate: (replacement) =>
                  activateSchedulerGeneration(replacement, runner !== undefined),
                resume: (replacement) =>
                  resumeSchedulerGeneration(replacement, runner !== undefined),
              });
              return obligations;
            },
            recoverConversation: async (obligations) => {
              await conversationProtocol.recoverInstalledAuthority();
              return obligations;
            },
            recoverDelivery: async (obligations) => {
              if (plannedDelivery.kind === "available") {
                await plannedDelivery.stack.recoverInstalledAuthority();
              }
              return obligations;
            },
            openCurrentOwnerSurfaces: async () => {
              if (plannedChannel.kind === "available") {
                await plannedChannel.connections.connectConfigured();
              }
            },
          },
        });
      const postAdoptionReviewLifecycle =
        definePostAdoptionReviewLifecycleContribution({
          kind: "anchor",
          review: schedulerGenerationOwner.postAdoptionReview,
        });
      const deviceRemovalLifecycle = defineDeviceRemovalLifecycleContribution({
        closeAdmission: async (operationId) => {
          if (
            removalAdmissionOperationId !== undefined &&
            removalAdmissionOperationId !== operationId
          ) {
            throw new Error("Another device-removal operation owns external admission");
          }
          removalAdmissionOperationId = operationId;
          inbound.refuseNewMessages();
          jobOwner.pauseAccepting();
          await channel.suspendConfigured();
          schedulerApplication.closeAdmission();
          delivery.close();
        },
        captureAcceptedWork: async (operationId) => {
          const items = [] as Array<{
            owner: "remote" | "channel" | "scheduler" | "delivery";
            id: string;
            revision: string;
          }>;
          for (const owner of ["remote", "channel", "scheduler", "delivery"] as const) {
            for (const item of await captureExternal(owner, operationId)) {
              items.push({ owner, ...item });
            }
          }
          return Object.freeze(items.sort((left, right) =>
            `${left.owner}:${left.id}`.localeCompare(
              `${right.owner}:${right.id}`,
              "en-US",
            )));
        },
        settleAcceptedWork: async ({ operationId, ownerItems }) => {
          if (removalAdmissionOperationId !== operationId) {
            throw new Error("Device-removal settlement does not own external admission");
          }
          const sources = deliveryLifecycleSourcesFromOwnerItems(ownerItems);
          await delivery.install({
            operationId,
            sources,
            deliveries: ownerItems
              .filter((item) => item.owner === "delivery")
              .map(({ id, revision }) => ({ id, revision })),
          });
          await recoverFrozenOwners(sources);
          for (const owner of ["remote", "channel", "scheduler", "delivery"] as const) {
            const frozen = ownerItems
              .filter((item) => item.owner === owner)
              .map(({ id, revision }) => ({ id, revision }));
            const current = owner === "delivery"
              ? await delivery.read(operationId)
              : await captureExternal(owner, operationId);
            if (owner !== "delivery") {
              assertAcceptedWorkSubset(
                current,
                frozen,
                `device-removal ${owner} settlement`,
              );
            }
            if (owner === "remote") {
              await inbound.drainAcceptedMessages();
              await jobOwner.drain();
            } else if (owner === "channel") {
              await channel.disconnectConfigured();
            } else if (owner === "scheduler") {
              await settleScheduleForTransfer();
            } else {
              await delivery.seal(operationId);
              await delivery.settle({
                operationId,
                strategy: "drain",
                timeoutMs: 30_000,
              });
            }
            const after = owner === "delivery"
              ? await delivery.read(operationId)
              : await captureExternal(owner, operationId);
            if (owner !== "delivery") {
              assertAcceptedWorkSubset(
                after,
                frozen,
                `device-removal ${owner} read-back`,
              );
            }
            if (after.length !== 0) {
              throw new Error(`Device-removal ${owner} accepted work is not settled`);
            }
          }
          await authority.resourceGovernor.coordinate(async () => undefined);
        },
        releaseAdmission: async (operationId) => {
          if (removalAdmissionOperationId === undefined) return;
          if (removalAdmissionOperationId !== operationId) {
            throw new Error("Device-removal release does not own external admission");
          }
          await delivery.release(operationId);
          if (!removalBootstrapAdmissionClosed) {
            await delivery.resume();
            schedulerApplication.resumeAdmission();
            jobOwner.resumeAccepting();
            inbound.resumeNewMessages();
            await channel.resumeConfigured();
          }
          removalAdmissionOperationId = undefined;
        },
        cleanup: cleanupLocalDevice,
        finalizeDeviceKey: async (operationId, identity) => {
          const expectedGeneration = protocolDigest("DeviceKeyGeneration", 1, {
            deviceId: bootstrap.mesh.deviceKey.deviceId,
            publicKey: bootstrap.mesh.deviceKey.publicKey,
          });
          if (
            identity.targetDeviceId !== bootstrap.mesh.deviceKey.deviceId ||
            identity.targetDeviceKeyGeneration !== expectedGeneration
          ) {
            throw new Error(
              "Device removal key finalizer does not own the frozen key generation",
            );
          }
          await deleteDeviceKeyExact(bootstrap.secretStore, bootstrap.mesh.deviceKey);
          return [{
            kind: "cleanup" as const,
            digest: protocolDigest("ExecutorRemovalDeviceKeyDeleted", 1, {
              operationId,
              targetDeviceId: identity.targetDeviceId,
              targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
            }),
          }];
        },
        onRemoved: () => anchorInternalStop.requestStop({
          reason: "device-removed",
          strategy: "immediate",
        }),
      });
      const activeMesh = await preparedMesh.start({
        deviceRemovalLifecycle,
        plannedDutyMigrationLifecycle,
        postAdoptionReviewLifecycle,
        lifecycleAdmissionClosed: true,
        recoverAcceptedWork: startupLifecycle?.recoverAcceptedWork ?? true,
      });
      ctx.meshRuntime = activeMesh;
      delete ctx.meshRuntimePreparation;
      removalBootstrapAdmissionClosed = false;
      if (!startupLifecycle) {
        await delivery.resume();
        schedulerApplication.resumeAdmission();
        jobOwner.resumeAccepting();
        activeMesh.resumeAcceptingAfterLifecycle();
        inbound.resumeNewMessages();
        if (
          activeMesh.currentAnchorDeviceId() === bootstrap.mesh.deviceKey.deviceId &&
          activeMesh.plannedCurrentOwnerReady()
        ) {
          await channel.connectConfigured();
        }
      }
    }
    if (!preparedMesh && !startupLifecycle) {
      await ctx.deliveryStack?.lifecycle.resume();
      schedulerApplication.resumeAdmission();
      ctx.executorJobOwner?.resumeAccepting();
      ctx.inboundRouter?.resumeNewMessages();
      await ctx.channelConnections?.connectConfigured();
    }
  }
  // ============================================================================
  // ServerContext + runServer —— 读接入面产物（conversations / channels）。
  // ============================================================================
  const advancementRecovery = ctx.advancementRecovery;

  const recoverAdvancementAcceptedWork = async (): Promise<void> => {
    if (!advancementRecovery) return;
    try {
      const recovered = await advancementRecovery.recoverAllOpenSessions();
      const scheduledCount = recovered.filter(
        (item) =>
          item.status === "scheduled" ||
          item.status === "already-running" ||
          item.status === "accepted-run-recovered",
      ).length;
      if (scheduledCount > 0) {
        console.log(
          chalk.dim(
            `[advancement] recovered ${scheduledCount} active proxy turn(s)`,
          ),
        );
      }
    } catch (err) {
      console.warn(
        chalk.yellow("[advancement] recovery scan failed:"),
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Reconcile accepted-but-unreviewed runs and their durable evidence requests
  // before any control ingress starts listening. Recovery may schedule local
  // proxy work, but it never requires a connected surface.
  if (advancementRecovery && !startupLifecycleOperation) {
    await recoverAdvancementAcceptedWork();
  }

  if (!authorityRuntime.globalState) {
    throw new Error("Skill management requires the anchor global-state authority");
  }

  const serverRegistry = buildBuiltinRegistry();
  let managedHostStopping = false;
  const managedStopSpec = processMode === "managed"
    ? initialManagedServiceState.spec
    : undefined;
  if (processMode === "managed" && !managedStopSpec) {
    throw new Error("Managed host stop identity requires the installed service definition");
  }
  const stopHost: StopHostGeneration = processMode === "managed" && managedStopSpec
    ? {
        kind: "managed",
        serviceId: managedStopSpec.serviceId,
        definitionDigest: managedServiceDefinitionDigest(managedStopSpec),
        instanceId: `${process.pid}:${processStartedAt}`,
        endpointLock: stopEndpointLock,
      }
    : {
        kind: "foreground",
        processId: process.pid,
        startedAt: processStartedAt,
        endpointLock: stopEndpointLock,
      };
  async function captureStopAcceptedWork(
    owner: keyof HostStopAcceptedWorkPorts,
    operationId: string,
  ) {
    const localOwners = new Set(["conversation", "intent", "final", "assignment", "lease", "permit"]);
    if (localOwners.has(owner) && ctx.localConversationOwner) {
      return ctx.localConversationOwner.hostStopAcceptedWorkItems(
        operationId,
        owner as "conversation" | "intent" | "final" | "assignment" | "lease" | "permit",
      );
    }
    const conversations = (ctx.conversations?.list() ?? [])
      .map((item) => ({
        id: item.conversationId,
        revision: protocolDigest("HostStopConversation", 1, {
          conversationId: item.conversationId,
          sessionId: item.sessionId,
        }),
      }));
    if (owner === "conversation") return conversations;
    if (owner === "remote") {
      const relay = (await ctx.jobRelayObligations?.listOpen() ?? []).map((opening) => ({
        id: `relay:${opening.assignmentId}`,
        revision: opening.sourceRevision,
      }));
      const local = (await ctx.executorJobOwner?.acceptedWorkItems() ?? []).map((item) => ({
        id: `local:${item.id}`,
        revision: item.revision,
      }));
      return [...relay, ...local].sort((left, right) =>
        left.id.localeCompare(right.id, "en-US"));
    }
    if (owner === "channel") {
      return (ctx.channelStatuses?.() ?? [])
        .filter((status) => status.state !== "disconnected")
        .map((status) => ({
          id: status.channelId,
          revision: protocolDigest("HostStopChannel", 1, { channelId: status.channelId }),
        }));
    }
    if (owner === "scheduler") {
      return await schedulerApplication.captureAcceptedWork();
    }
    if (owner === "delivery") {
      return ctx.deliveryStack?.lifecycle.capture() ?? [];
    }
    return [];
  }
  const assertStopAcceptedWorkSettled = async (
    owner: keyof HostStopAcceptedWorkPorts,
    operationId: string,
    frozen: readonly HostStopAcceptedWorkItem[],
    strategy: "immediate" | "drain" | "cancel",
  ) => {
    if (
      ["conversation", "intent", "final", "assignment", "lease", "permit"].includes(owner) &&
      ctx.localConversationOwner
    ) {
      await ctx.localConversationOwner.assertHostStopAcceptedWorkSettled(
        operationId,
        owner as "conversation" | "intent" | "final" | "assignment" | "lease" | "permit",
        strategy,
        frozen,
      );
      return;
    }
    if (owner === "scheduler") {
      await schedulerApplication.assertAcceptedWorkSettled(frozen);
      return;
    }
    const current = owner === "delivery"
      ? await ctx.deliveryStack?.lifecycle.read(operationId) ?? []
      : await captureStopAcceptedWork(owner, operationId);
    assertAcceptedWorkSubset(current, frozen, `host-stop ${owner}`);
    if (owner === "conversation") {
      if ((ctx.conversations?.list() ?? []).some((item) => item.busy)) {
        throw new Error("Conversation accepted work is still active");
      }
      return;
    }
    if (["intent", "final", "assignment", "lease", "permit"].includes(owner)) {
      const closure = await ctx.conversationProtocol?.pendingClosureWork();
      const remaining = owner === "final"
        ? closure?.pendingFinals ?? 0
        : owner === "assignment"
          ? closure?.pendingAssignments ?? 0
          : owner === "intent"
            ? closure?.recoveryBacklog ?? 0
            : closure?.activeLocalLeases ?? 0;
      const durableImmediateOwner = owner === "intent" || owner === "final" || owner === "assignment";
      if (remaining !== 0 && !(strategy === "immediate" && durableImmediateOwner)) {
        throw new Error(`${owner} accepted work is not settled`);
      }
      return;
    }
    if (owner === "remote") {
      if (strategy !== "immediate" && current.length !== 0) {
        throw new Error("Remote accepted work is not settled");
      }
      return;
    }
    if (owner === "channel") {
      if ((ctx.channelStatuses?.() ?? []).some((status) => status.state !== "disconnected")) {
        throw new Error("Channel accepted work is not settled");
      }
      return;
    }
    if (owner === "delivery") {
      if (strategy !== "immediate" && current.length !== 0) {
        throw new Error("Delivery accepted work is not durably terminal");
      }
      return;
    }
  };
  const stopPort = (
    owner: keyof HostStopAcceptedWorkPorts,
    settle: (input: {
      readonly operationId: string;
      readonly strategy: "immediate" | "drain" | "cancel";
      readonly timeoutMs: number;
      readonly frozen: readonly HostStopAcceptedWorkItem[];
    }) => Promise<void>,
  ) => ({
    freeze: (operationId: string) => captureStopAcceptedWork(owner, operationId),
    settle: async (input: {
      readonly operationId: string;
      readonly strategy: "immediate" | "drain" | "cancel";
      readonly timeoutMs: number;
      readonly frozen: readonly HostStopAcceptedWorkItem[];
    }) => {
      const current = owner === "delivery"
        ? await ctx.deliveryStack?.lifecycle.read(input.operationId) ?? []
        : await captureStopAcceptedWork(owner, input.operationId);
      if (owner !== "delivery") {
        assertAcceptedWorkSubset(current, input.frozen, `host-stop ${owner} settlement`);
      }
      if (
        ["conversation", "intent", "final", "assignment", "lease", "permit"].includes(owner) &&
        ctx.localConversationOwner
      ) {
        await ctx.localConversationOwner.settleHostStopAcceptedWork(
          input.operationId,
          input.strategy,
          input.timeoutMs,
        );
        return;
      }
      await settle(input);
    },
    readBack: (input: {
      readonly operationId: string;
      readonly strategy: "immediate" | "drain" | "cancel";
      readonly frozen: readonly HostStopAcceptedWorkItem[];
    }) => assertStopAcceptedWorkSettled(
      owner,
      input.operationId,
      input.frozen,
      input.strategy,
    ),
  });
  const acceptedWork: HostStopAcceptedWorkPorts = {
    conversation: stopPort("conversation", async ({ strategy, timeoutMs }) => {
      if (strategy === "cancel") {
        await ctx.conversations?.abortAllAndWait(
          { kind: "external", origin: "server-shutdown" },
          timeoutMs,
        );
      }
      await ctx.inboundRouter?.drainAcceptedMessages();
    }),
    intent: stopPort("intent", async () => {
      await ctx.executorJobOwner?.drain();
    }),
    final: stopPort("final", async () => {
      await ctx.executorJobOwner?.drain();
    }),
    assignment: stopPort("assignment", async () => {
      await ctx.executorJobOwner?.drain();
    }),
    remote: stopPort("remote", async () => {
      await ctx.inboundRouter?.drainAcceptedMessages();
      await ctx.executorJobOwner?.drain();
    }),
    channel: stopPort("channel", async () => {
      await ctx.channelConnections?.disconnectConfigured();
    }),
    scheduler: stopPort("scheduler", async () => {
      await settleScheduleForTransfer();
      await ctx.executorJobOwner?.drain();
    }),
    delivery: stopPort("delivery", async ({ operationId, strategy, timeoutMs }) => {
      await ctx.deliveryStack?.lifecycle.seal(operationId);
      await ctx.deliveryStack?.lifecycle.settle({ operationId, strategy, timeoutMs });
    }),
    lease: stopPort("lease", async () => {
      await ctx.authorityRuntime?.resourceGovernor.coordinate(async () => undefined);
    }),
    permit: stopPort("permit", async () => {
      await ctx.authorityRuntime?.resourceGovernor.coordinate(async () => undefined);
    }),
  };
  const isLifecycleHostStopped = async (candidateHost: StopHostGeneration): Promise<boolean> => {
    const endpoint = candidateHost.endpointLock;
    if (!endpoint) return false;
    const currentReplacesEndpoint = ownsCurrentSuccessorEndpoint(
      serverBinding,
      endpoint,
      stopEndpointLock,
    );
    if (
      endpoint.pid === stopEndpointLock.pid &&
      endpoint.port === stopEndpointLock.port &&
      endpoint.startTime === stopEndpointLock.startTime &&
      endpoint.startedAt === stopEndpointLock.startedAt
    ) return false;
    if (isProcessAlive(endpoint.pid) && !currentReplacesEndpoint) return false;
    if (candidateHost.kind === "foreground") return candidateHost.processId === endpoint.pid;
    try {
      const state = await loadCurrentManagedServiceState("inspect", zhixingHome);
      if (
        !state.spec ||
        state.spec.serviceId !== candidateHost.serviceId ||
        managedServiceDefinitionDigest(state.spec) !== candidateHost.definitionDigest
      ) return false;
      const inspection = await createManagedServiceAdapter({
        storageGovernor: deviceCapacity.storage,
      }).inspect(state.spec, new AbortController().signal);
      const currentSuccessor = stopHost.kind === "managed" &&
        stopHost.serviceId === candidateHost.serviceId &&
        stopHost.definitionDigest === candidateHost.definitionDigest &&
        stopHost.endpointLock?.pid === process.pid &&
        currentReplacesEndpoint &&
        isProcessAlive(process.pid);
      return inspection.matches && (!inspection.running || currentSuccessor);
    } catch {
      return false;
    }
  };
  const stopCoordinator = new HostStopCoordinator({
    journal: new DeviceLifecycleJournal(lifecycleAuthorityLog),
    homeId: lifecycleHomeId,
    localDeviceId: bootstrap.mesh.deviceKey.deviceId,
    host: stopHost,
    acceptedWork,
    artifactStore: bootstrap.mesh.bootstrapStore.artifactStore(),
    onAcceptedWorkFrozen: async (snapshot) => {
      const sources = hostStopDeliveryLifecycleSources(snapshot);
      ctx.localConversationOwner?.restoreHostStopAcceptedWork(
        snapshot.operationId,
        Object.entries(snapshot.owners).flatMap(([owner, items]) =>
          items.map((item) => ({
            owner: owner as keyof HostStopAcceptedWorkSnapshot["owners"],
            ...item,
          }))),
      );
      await ctx.deliveryStack?.lifecycle.install({
        operationId: snapshot.operationId,
        sources,
        deliveries: snapshot.owners.delivery,
      });
      await recoverStartupLifecycleAcceptedWork(sources);
    },
    runtime: {
      closeAdmission: async (operationId) => {
        managedHostStopping = true;
        ctx.inboundRouter?.refuseNewMessages();
        ctx.executorJobOwner?.pauseAccepting();
        schedulerApplication.closeAdmission();
        ctx.deliveryStack?.lifecycle.close();
        await Promise.all([
          ctx.localConversationOwner?.closeHostStopAdmission(operationId),
          ctx.channelConnections?.suspendConfigured(),
        ]);
      },
      settleImmediate: async () => {
        await ctx.inboundRouter?.drainAcceptedMessages();
        await ctx.executorJobOwner?.drain();
      },
      drainAcceptedWork: async () => {
        await ctx.inboundRouter?.drainAcceptedMessages();
        await ctx.executorJobOwner?.drain();
      },
      cancelAcceptedWork: async (timeoutMs) => {
        await ctx.conversations?.abortAllAndWait(
          { kind: "external", origin: "server-shutdown" },
          timeoutMs,
        );
      },
      flushDurableState: async () => {
        const [checkpoint, localOwnerDigest] = await Promise.all([
          lifecycleAuthorityLog.checkpoint(),
          ctx.localConversationOwner?.checkpointAcceptedWork(),
        ]);
        return [{
          kind: "accepted-work",
          digest: protocolDigest("HostStopDurableFlush", 1, {
            lifecycle: checkpoint.prefixDigest,
            localOwner: localOwnerDigest ?? null,
          }),
        }];
      },
      settlePhysicalSteps: async () => {
        await ctx.authorityRuntime?.resourceGovernor.coordinate(async () => undefined);
      },
    },
    isHostStopped: isLifecycleHostStopped,
  });
  const stopResume = await stopCoordinator.resumeActive();
  if (startupLifecycleOperation?.identity.kind === "stop") {
    const operationId = startupLifecycleOperation.identity.operationId;
    const terminal = stopResume.find((operation) =>
      operation.identity.operationId === operationId && operation.phase === "terminal");
    if (!terminal) {
      throw new Error("Durable host-stop recovery did not prove the old host terminal");
    }
    await ctx.localConversationOwner?.releaseHostStopAdmission(operationId);
    await ctx.deliveryStack?.lifecycle.release(operationId);
    await ctx.deliveryStack?.lifecycle.resume();
    if (!startupLifecycleFrozenRecoveryStarted) {
      await recoverStartupLifecycleAcceptedWork(
        startupLifecycle?.delivery.sources ?? [],
      );
    }
    await recoverAdvancementAcceptedWork();
    schedulerApplication.resumeAdmission();
    ctx.executorJobOwner?.resumeAccepting();
    ctx.meshRuntime?.resumeAcceptingAfterLifecycle();
    ctx.inboundRouter?.resumeNewMessages();
    await ctx.channelConnections?.resumeConfigured();
    ctx.localConversationOwner?.resumeRecoveryAfterLifecycle();
    startupLifecycle = undefined;
    delete ctx.startupLifecycle;
    managedHostStopping = false;
  }
  async function cleanupLocalDevice() {
    const current = await loadCurrentManagedServiceState("activate", zhixingHome);
    const adapter = current.spec
      ? createManagedServiceAdapter({ storageGovernor: deviceCapacity.storage })
      : undefined;
    const expected = current.spec
      ? await adapter!.inspect(current.spec, new AbortController().signal)
      : undefined;
    return cleanupExecutorDeviceLocalState({
      zhixingHome,
      secretStore: bootstrap.secretStore,
      deviceKey: bootstrap.mesh.deviceKey,
      storageGovernor: deviceCapacity.storage,
      disasterRecoveryStaging: bootstrap.mesh.disasterRecoveryStaging,
      unregisterFuture: async () => {
        if (!current.spec || !adapter || !expected) return;
        await adapter.unregisterFutureExact(
          current.spec,
          expected,
          new AbortController().signal,
        );
      },
    });
  }
  const finishLocalRetirement = async () => {
    await deleteDeviceKey(bootstrap.secretStore, bootstrap.mesh.deviceKey.deviceId);
    await anchorInternalStop.requestStop({
      reason: "device-removed",
      strategy: "immediate",
    });
  };
  const uninstallIssuerKey = bootstrap.mesh.mode === "trusted-home" &&
    bootstrap.mesh.trust.issuer.deviceId === bootstrap.mesh.deviceKey.deviceId
    ? bootstrap.mesh.anchorIssuerKey ?? bootstrap.mesh.deviceKey
    : undefined;
  const closeAnchorUninstallAdmission = async () => {
    ctx.inboundRouter?.refuseNewMessages();
    await ctx.inboundRouter?.drainAcceptedMessages();
    await ctx.channelConnections?.disconnectConfigured();
    await ctx.deliveryStack?.quiesceForAuthorityTransfer();
    await settleScheduleForTransfer();
  };
  const currentRemovalAcceptedWork = {
    ports: acceptedWork,
    artifactStore: bootstrap.mesh.bootstrapStore.artifactStore(),
    closeAdmission: async (operationId: string) => {
      managedHostStopping = true;
      ctx.inboundRouter?.refuseNewMessages();
      ctx.executorJobOwner?.pauseAccepting();
      schedulerApplication.closeAdmission();
      ctx.deliveryStack?.lifecycle.close();
      await Promise.all([
        ctx.localConversationOwner?.closeHostStopAdmission(operationId),
        ctx.channelConnections?.suspendConfigured(),
      ]);
    },
    onFrozen: async (snapshot: HostStopAcceptedWorkSnapshot) => {
      const sources = hostStopDeliveryLifecycleSources(snapshot);
      await ctx.deliveryStack?.lifecycle.install({
        operationId: snapshot.operationId,
        sources,
        deliveries: snapshot.owners.delivery,
      });
      await recoverStartupLifecycleAcceptedWork(sources);
    },
    flushDurableState: async (): Promise<readonly DeviceLifecycleEvidenceRef[]> => {
      const [checkpoint, localOwnerDigest] = await Promise.all([
        lifecycleAuthorityLog.checkpoint(),
        ctx.localConversationOwner?.checkpointAcceptedWork(),
      ]);
      return [{
        kind: "accepted-work",
        digest: protocolDigest("AnchorUninstallDurableFlush", 1, {
          lifecycle: checkpoint.prefixDigest,
          localOwner: localOwnerDigest ?? null,
        }),
      }];
    },
    settlePhysicalSteps: async () => {
      await ctx.authorityRuntime?.resourceGovernor.coordinate(async () => undefined);
    },
  };
  const currentRemovalJournal = ctx.meshRuntime && uninstallIssuerKey
    ? new DeviceLifecycleJournal(lifecycleAuthorityLog, ctx.authorityRuntime!.verifier)
    : undefined;
  const readCurrentRemovalAuthority = currentRemovalJournal && uninstallIssuerKey
    ? async () => {
        const trust = replayTrustChain(await bootstrap.mesh.bootstrapStore.loadTrustEvents());
        return Object.freeze({
          homeId: trust.homeId,
          localDeviceId: bootstrap.mesh.deviceKey.deviceId,
          currentDutyDeviceId: trust.issuer.deviceId,
          localIssuerKeyId: uninstallIssuerKey.deviceId,
          currentDutyIssuerKeyId: trust.issuer.issuerKeyId,
          currentDeviceName: trust.members.find((member) =>
            member.device.deviceId === bootstrap.mesh.deviceKey.deviceId)
            ?.device.displayName,
          anchorEpoch: ctx.authorityRuntime!.anchorEpoch,
          trustHeadDigest: trust.chainHead.eventDigest,
          executorRemovalInProgress: (await currentRemovalJournal.active())
            .some((operation) => operation.identity.kind === "executor-removal"),
        });
      }
    : undefined;
  const currentRemovalAdmission = readCurrentRemovalAuthority
    ? createDeviceAdministrationCurrentRemovalAdmissionPort({
        readAuthority: readCurrentRemovalAuthority,
      })
    : undefined;
  const currentRemovalMigrationLifecycle = currentRemovalJournal && readCurrentRemovalAuthority
    ? createDeviceAdministrationCurrentRemovalMigrationLifecyclePort({
        journal: currentRemovalJournal,
        readAuthority: readCurrentRemovalAuthority,
      })
    : undefined;
  const currentRemovalRecoveryBinding = currentRemovalJournal && readCurrentRemovalAuthority
    ? createDeviceAdministrationCurrentRemovalRecoveryBindingPort()
    : undefined;
  const currentRemovalRecoveryLifecycle = currentRemovalJournal && readCurrentRemovalAuthority
      && currentRemovalRecoveryBinding
    ? createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort({
        journal: currentRemovalJournal,
        readAuthority: readCurrentRemovalAuthority,
        binding: currentRemovalRecoveryBinding,
        commitRetirement: ({ identity, acceptedWork }) =>
          commitCurrentDeviceRetirementTransaction({
            log: lifecycleAuthorityLog,
            verifier: ctx.authorityRuntime!.verifier,
            identity,
            acceptedWork,
          }),
        phaseLsn: ({ operationId, phase }) =>
          readCurrentDeviceRemovalPhaseLsn({
            log: lifecycleAuthorityLog,
            operationId,
            phase,
          }),
      })
    : undefined;
  const currentDeviceRemoval = currentRemovalJournal && uninstallIssuerKey
    ? createDeviceAdministrationCurrentRemovalMechanismPort({
        journal: currentRemovalJournal,
        signAbort: (input) => createSignedDeviceLifecycleAbort(input, uninstallIssuerKey),
        releaseAdmission: async (operationId) => {
          await ctx.deliveryStack?.lifecycle.release(operationId);
          await ctx.deliveryStack?.lifecycle.resume();
          ctx.conversationProtocol?.startRecoveryLoop();
          schedulerApplication.resumeAdmission();
          ctx.inboundRouter?.resumeNewMessages();
          await ctx.channelConnections?.connectConfigured();
        },
      })
    : undefined;
  const readCurrentRemovalRecoveryBindingContext = currentRemovalRecoveryBinding
    ? async () => {
        const trust = await bootstrap.mesh.bootstrapStore.loadTrustRecord();
        if (
          !trust ||
          !trust.recoveryRootPublicKey ||
          !trust.recoveryBackupPublicKey
        ) {
          throw new Error("Current home recovery root is unavailable");
        }
        return Object.freeze({
          authority: Object.freeze({
            homeId: trust.homeId,
            anchorEpoch: ctx.authorityRuntime!.anchorEpoch,
            trustHeadDigest: trust.chainHead.eventDigest,
          }),
          context: Object.freeze({
            recoveryRootPublicKey: trust.recoveryRootPublicKey,
            recoveryBackupPublicKey: trust.recoveryBackupPublicKey,
          }),
        });
      }
    : undefined;
  const currentRemovalRecoveryApplication = currentRemovalRecoveryLifecycle &&
      currentRemovalRecoveryBinding && readCurrentRemovalRecoveryBindingContext
    ? new DeviceAdministrationCurrentRemovalRecoveryApplicationService<
        DeviceLifecycleEvidenceRef
      >({
        backup: new BackupRecoveryCurrentRemovalApplicationService({
          hasCheckpointOwner: () => ctx.authorityCheckpointOwner !== undefined,
          readStatus: () => ctx.authorityCheckpointOwner
            ? ctx.authorityCheckpointOwner.status()
            : Promise.resolve({
                state: "not-configured" as const,
                fullBackupReady: false,
              }),
          decodeCurrentPackage: (value: string) => {
            const decoded = requireCurrentRecoveryPackage(decodeRecoveryPackage(value));
            return Object.freeze({
              package: decoded.root,
              identity: Object.freeze(decoded.root.publicIdentity()),
            });
          },
          prepareAcceptedBinding: async (input) => {
            const current = await readCurrentRemovalRecoveryBindingContext();
            return Object.freeze({
              context: current.context,
              binding: currentRemovalRecoveryBinding.create({
                authority: current.authority,
                checkpointTargetId: input.checkpointTargetId,
                rootKeyId: input.rootKeyId,
                recipientKeyId: input.recipientKeyId,
              }),
            });
          },
          verifyAcceptedBinding: async (input) => {
            const current = await readCurrentRemovalRecoveryBindingContext();
            currentRemovalRecoveryBinding.assertCurrent({
              authority: current.authority,
              binding: input.binding,
              rootKeyId: input.rootKeyId,
              recipientKeyId: input.recipientKeyId,
            });
            return current.context;
          },
          forceCheckpoint: async (requestId: string) => {
            const checkpoint = await ctx.authorityCheckpointOwner!.force(requestId);
            return Object.freeze({
              checkpoint,
              checkpointId: checkpoint.envelope.checkpointId,
              envelopeDigest: checkpoint.envelope.digest,
              upToLsn: checkpoint.envelope.manifest.upToLsn,
            });
          },
          verifyCheckpoint: async ({ checkpoint, recoveryPackage }) => {
            const verification = await ctx.authorityCheckpointOwner!.verify(
              checkpoint.envelope.checkpointId,
              recoveryPackage,
            );
            return Object.freeze({
              targetId: verification.targetId,
              checkpointId: verification.checkpointId,
              envelopeDigest: verification.envelopeDigest,
              evidence: Object.freeze({
                kind: "checkpoint" as const,
                digest: protocolDigest(
                  "RecoveryCheckpointVerification",
                  1,
                  verification,
                ),
              }),
            });
          },
        }),
        lifecycle: currentRemovalRecoveryLifecycle,
        effects: {
          closeAdmission: async (operationId) => {
            await closeAnchorUninstallAdmission();
            const operation = await lifecycleJournal.state(operationId);
            if (!operation || operation.identity.kind !== "anchor-uninstall") {
              throw new Error("Anchor uninstall recovery operation is unknown");
            }
            return Object.freeze({
              kind: "accepted-work" as const,
              digest: protocolDigest("AnchorUninstallAdmission", 1, operation.identity),
            });
          },
          closeAcceptedWorkAdmission: currentRemovalAcceptedWork.closeAdmission,
          freezeAcceptedWork: async (operationId) =>
            (await freezeHostStopAcceptedWork(
              operationId,
              currentRemovalAcceptedWork.ports,
              currentRemovalAcceptedWork.artifactStore,
            )).evidence,
          restoreAcceptedWork: async (operationId) => {
            const operation = await lifecycleJournal.state(operationId);
            if (
              !operation ||
              operation.identity.kind !== "anchor-uninstall" ||
              operation.identity.path.kind !== "recovery-backup"
            ) {
              throw new Error("Anchor uninstall recovery operation is unknown");
            }
            await currentRemovalAcceptedWork.onFrozen(
              await loadHostStopAcceptedWork(
                operation,
                currentRemovalAcceptedWork.artifactStore,
              ),
            );
          },
          settleAcceptedWork: async ({ operationId, strategy, timeoutMs }) => {
            const operation = await lifecycleJournal.state(operationId);
            if (
              !operation ||
              operation.identity.kind !== "anchor-uninstall" ||
              operation.identity.path.kind !== "recovery-backup"
            ) {
              throw new Error("Anchor uninstall recovery operation is unknown");
            }
            const snapshot = await loadHostStopAcceptedWork(
              operation,
              currentRemovalAcceptedWork.artifactStore,
            );
            await settleHostStopAcceptedWork({
              operationId,
              strategy,
              timeoutMs,
              snapshot,
              ports: currentRemovalAcceptedWork.ports,
            });
            const artifact = operation.evidence.filter((item) =>
              item.kind === "accepted-work" && item.artifact);
            if (artifact.length !== 1) {
              throw new Error("Anchor uninstall accepted-work artifact is missing or ambiguous");
            }
            return Object.freeze({
              kind: "accepted-work" as const,
              digest: protocolDigest("AnchorUninstallAcceptedWorkSettlement", 1, {
                operationId,
                artifactDigest: artifact[0]!.digest,
              }),
            });
          },
          flushDurableState: currentRemovalAcceptedWork.flushDurableState,
          settlePhysicalSteps: currentRemovalAcceptedWork.settlePhysicalSteps,
          cleanup: cleanupLocalDevice,
          onRetired: finishLocalRetirement,
        },
      })
    : undefined;
  const currentRemovalMigrationApplication = currentRemovalMigrationLifecycle && ctx.meshRuntime
    ? new DeviceAdministrationCurrentRemovalMigrationApplicationService<
        DeviceLifecycleEvidenceRef
      >({
        lifecycle: currentRemovalMigrationLifecycle,
        effects: {
          closeAdmission: closeAnchorUninstallAdmission,
          closeAcceptedWorkAdmission: currentRemovalAcceptedWork.closeAdmission,
          freezeAcceptedWork: async (operationId) =>
            (await freezeHostStopAcceptedWork(
              operationId,
              currentRemovalAcceptedWork.ports,
              currentRemovalAcceptedWork.artifactStore,
            )).evidence,
          settleAcceptedWork: async ({ operationId, strategy, timeoutMs }) => {
            const operation = await lifecycleJournal.state(operationId);
            if (
              !operation ||
              operation.identity.kind !== "anchor-uninstall" ||
              operation.identity.path.kind !== "migration"
            ) {
              throw new Error("Anchor uninstall migration operation is unknown");
            }
            const snapshot = await loadHostStopAcceptedWork(
              operation,
              currentRemovalAcceptedWork.artifactStore,
            );
            await currentRemovalAcceptedWork.onFrozen(snapshot);
            await settleHostStopAcceptedWork({
              operationId,
              strategy,
              timeoutMs,
              snapshot,
              ports: currentRemovalAcceptedWork.ports,
            });
          },
          flushDurableState: currentRemovalAcceptedWork.flushDurableState,
          settlePhysicalSteps: currentRemovalAcceptedWork.settlePhysicalSteps,
          commitTransfer: async (input) => {
            await ctx.meshRuntime!.preparePlannedAnchorTransfer(input);
            await ctx.meshRuntime!.commitPlannedAnchorTransfer(input);
          },
          verifyTransfer: async ({ transferId, targetDeviceId }) => {
            const trust = await bootstrap.mesh.bootstrapStore.loadTrustRecord();
            if (
              !trust ||
              trust.issuer.deviceId !== targetDeviceId ||
              ctx.meshRuntime!.currentAnchorDeviceId() !== targetDeviceId
            ) {
              throw new Error("The new duty device installation is not current");
            }
            return {
              kind: "authority-transfer",
              digest: protocolDigest("AnchorUninstallMigration", 1, {
                kind: "migration",
                targetDeviceId,
                transferId,
              }),
            };
          },
          retireLocalDevice: async ({ operationId, targetDeviceId }) => {
            await ctx.meshRuntime!.retireLocalDeviceAfterMigration({ operationId });
            return {
              kind: "cleanup",
              digest: protocolDigest("MigratedAnchorCleanup", 1, {
                operationId,
                targetDeviceId,
              }),
            };
          },
        },
      })
    : undefined;
  await currentRemovalMigrationApplication?.resumeActive();
  await currentRemovalRecoveryApplication?.resumeActive();
  anchorInternalStopLifecycle.assertServerStartAllowed();
  const deliveryProductApi = ctx.deliveryStack
    ? createDeliveryResolutionProductApiContribution(
        ctx.deliveryStack.resolutionApplication,
      )
    : undefined;
  const conversationApplication = new ConversationDirectoryApplicationService({
    storage: conversationDirectory,
    compact: createAnchorConversationCompactPort({
      conversations: ctx.conversations!,
      exists: (conversationId) => conversationDirectory.exists(conversationId),
    }),
    usage: createAnchorConversationUsageProjectionPort({
      conversations: ctx.conversations!,
      exists: (conversationId) => conversationDirectory.exists(conversationId),
    }),
    security: createAnchorConversationSecurityProjectionPort({
      conversations: ctx.conversations!,
      exists: (conversationId) => conversationDirectory.exists(conversationId),
    }),
    taskLists: createAnchorConversationTaskListPort({
      conversations: ctx.conversations!,
      exists: (conversationId) => conversationDirectory.exists(conversationId),
      taskLists: builtinExtraTools.taskListService,
    }),
    agentTurns: createConversationAgentTurnAdmissionPort({
      manager: ctx.conversations!,
    }),
    agentTurnIdentity: {
      exists: (conversationId) =>
        conversationIdentityLifecycle.identityExists(conversationId),
      create: () => conversationIdentityLifecycle.createIdentity(),
      ensure: (conversationId) =>
        conversationIdentityLifecycle.ensureShell(conversationId),
    },
    resume: createAnchorConversationResumePort({
      identity: conversationDirectory,
      ...(advancementRecovery ? { recovery: advancementRecovery } : {}),
      adoptionReview: schedulerGenerationOwner.postAdoptionReview,
    }),
    clear: createAnchorConversationClearCommitPort({
      conversations: ctx.conversations!,
      directory: conversationDirectory,
      publishFact: (fact) => {
        ctx.sessionBroadcast(
          fact.conversationId,
          SESSION_NOTIFICATIONS.changed,
          { conversationId: fact.conversationId, change: "cleared" },
        );
      },
    }),
    delete: createAnchorConversationDeleteCommitPort({
      conversations: ctx.conversations!,
      storage: {
        exists: (conversationId) =>
          conversationDirectory.exists(conversationId),
        deleteStoredConversation: (conversationId) =>
          conversationDirectory.deleteStoredConversation(conversationId),
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
      publishFact: (fact) => {
        ctx.sessionBroadcast(
          fact.conversationId,
          SESSION_NOTIFICATIONS.changed,
          { conversationId: fact.conversationId, change: "deleted" },
        );
      },
    }),
    runControl: createAnchorConversationRunControlPort({
      conversations: ctx.conversations!,
      advancement: {
        settle: ({ conversationId, ingressId }) =>
          advancementReviews
            .settleProxyRun({ conversationId, proxyMessageId: ingressId })
            .then(() => undefined),
        recover: async (conversationId) => {
          await advancementRecovery?.recoverConversation(conversationId);
        },
      },
    }),
    runtime: {
      read: (conversationId) => {
        const active = ctx.conversations?.getSession(conversationId);
        if (!ctx.conversations) return undefined;
        return {
          ...(active ? { lastActiveAt: active.lastActiveAt } : {}),
          active: active !== undefined,
          busy: active?.busy ?? false,
          observerCount: ctx.conversations.getObserverCount(conversationId),
          pendingCount: ctx.conversations.pendingCount(conversationId),
        };
      },
    },
    advancement: {
      read: async (conversationId) =>
        (await advancementReviews.queryActiveState(conversationId)) ?? undefined,
    },
    perspectives: conversationPerspectives,
  });
  const advancementDetailController = advancementController;
  const advancementApplication = new AdvancementApplicationService({
          activeState: advancementReviews,
          detail: {
            loadLatestSession: (conversationId) =>
              advancementDetailController.loadLatestSession(conversationId),
          },
          maintenance: {
            runNew: (conversationId, operation) =>
              ctx.conversations!.runMaintenance(conversationId, operation),
            runExisting: (conversationId, operation) =>
              ctx.conversations!.runMaintenanceExisting(
                conversationId,
                () => conversationDirectory.exists(conversationId),
                operation,
              ),
          },
          newTask: advancementDetailController,
          newTaskConversation: {
            ensureShell: (conversationId) =>
              conversationApplication
                .ensureShell({ kind: "ensure-shell", conversationId })
                .then(() => undefined),
          },
          activeUserTurn: advancementDetailController,
          activeUserTurnRuntime: {
            interruptProxy: async ({
              conversationId,
              outstandingProxyMessageId,
            }) => {
              const cancelledPending = await ctx.conversations!.cancelPendingBySource(
                conversationId,
                "advancement",
              );
              const abortedInFlight =
                ctx.conversations!.getBusySource(conversationId) ===
                  "advancement" &&
                ctx.conversations!.abortInFlight(conversationId, {
                  kind: "user-cancel",
                  source: "rpc",
                  pressedAt: Date.now(),
                });
              const interrupted = cancelledPending > 0 || abortedInFlight;
              return Object.freeze({
                interrupted,
                ...(interrupted && outstandingProxyMessageId
                  ? { proxyMessageId: outstandingProxyMessageId }
                  : {}),
              });
            },
            recoverInterruptedProxy: async (conversationId) => {
              await advancementRecovery?.recoverConversation(conversationId);
            },
          },
          rubricRevision: advancementDetailController,
          rubricCancellation: {
            loadRubricCancellationSession: (conversationId, sessionId) =>
              advancementDetailController.loadRubricCancellationSession(
                conversationId,
                sessionId,
              ),
            persistRubricCancellation: (input) =>
              advancementReviews.cancelSession(input),
          },
          awaitingRubricAdmission: advancementDetailController,
          rubricConfirmation: advancementDetailController,
          rubricPublication: {
            publish: (input) =>
              advancementDetailController.publishRubric(input),
          },
          originalTask:
            createAnchorAdvancementOriginalTaskExecutionPort(
              conversationApplication,
            ),
          confirmedOriginalTask:
            createAnchorAdvancementConfirmedOriginalTaskAdmissionPort(
              conversationApplication,
            ),
        });
  const advancementProductApi =
    createAdvancementProductApiContribution(advancementApplication);
  const deviceAdministrationProductApi = ctx.meshRuntime
    ? createDeviceAdministrationProductApiContribution(
        new DeviceAdministrationApplicationService({
          relationships: {
            list: () => ctx.meshRuntime!.removableDevices(),
          },
          removalState: {
            read: (targetName) =>
              ctx.meshRuntime!.deviceRemovalStatus({ targetName }),
          },
          dutyMigrationTargets: {
            list: () => ctx.meshRuntime!.plannedAnchorTargets(),
          },
          dutyMigrationAdmission: ctx.meshRuntime!.dutyMigrationAdmission,
          dutyMigration: {
            prepare: async (input) => {
              await ctx.meshRuntime!.preparePlannedAnchorTransfer(input);
            },
            commit: async (input) => {
              await ctx.meshRuntime!.commitPlannedAnchorTransfer(input);
            },
            cancel: async (input) => {
              await ctx.meshRuntime!.abortPlannedAnchorTransfer(input);
            },
          },
          ...(currentDeviceRemoval && currentRemovalAdmission
            ? {
                currentRemovalAdmission,
                currentRemovalMigrationTargets: {
                  list: () => ctx.meshRuntime!.plannedAnchorTargets(),
                },
                ...(currentRemovalMigrationApplication
                  ? { currentRemovalMigration: currentRemovalMigrationApplication }
                  : {}),
                ...(currentRemovalRecoveryApplication
                  ? { currentRemovalRecovery: currentRemovalRecoveryApplication }
                  : {}),
                currentDeviceRemoval,
              }
            : {}),
          removalContext: {
            read: () => ctx.meshRuntime!.deviceRemovalCommandContext(),
          },
          removalAuthority: {
            acceptForTarget: (input) =>
              ctx.meshRuntime!.acceptDeviceRemovalForTarget(input),
            operation: (operationId) =>
              ctx.meshRuntime!.deviceRemovalOperation(operationId),
            operationForTarget: (targetDeviceId) =>
              ctx.meshRuntime!.deviceRemovalOperationForTarget(targetDeviceId),
            abort: (operationId) =>
              ctx.meshRuntime!.abortDeviceRemoval(operationId),
            commitLost: (operationId) =>
              ctx.meshRuntime!.commitLostDeviceRemoval(operationId),
          },
          removalEffects: ctx.meshRuntime!.deviceRemovalTargetEffects,
        }),
      )
    : undefined;
  const productApi = new ProductApiDispatcher(
    defineProductApiExactSet({
      operations: [
        ...CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET.operations,
        ...SKILL_CATALOG_PRODUCT_API_EXACT_SET.operations,
        ...TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations,
        ...SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET.operations,
        ...SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET.operations,
        ...WORKSCENE_PRODUCT_API_EXACT_SET.operations,
        ...(advancementProductApi
          ? ADVANCEMENT_PRODUCT_API_EXACT_SET.operations
          : []),
        ...(deliveryProductApi
          ? DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET.operations
          : []),
        ...(deviceAdministrationProductApi
          ? DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations
          : []),
      ],
      factEvents: [
        ...CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET.factEvents,
        ...SKILL_CATALOG_PRODUCT_API_EXACT_SET.factEvents,
        ...TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents,
        ...SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET.factEvents,
        ...SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET.factEvents,
        ...WORKSCENE_PRODUCT_API_EXACT_SET.factEvents,
        ...(advancementProductApi
          ? ADVANCEMENT_PRODUCT_API_EXACT_SET.factEvents
          : []),
        ...(deliveryProductApi
          ? DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET.factEvents
          : []),
        ...(deviceAdministrationProductApi
          ? DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents
          : []),
      ],
    }),
    [
      createConversationDirectoryProductApiContribution(
        conversationApplication,
      ),
      createSkillCatalogProductApiContribution(
        new SkillCatalogApplicationService(
          createAnchorSkillCatalogManagementCorrectnessPort({
            globalState: () => authorityRuntime.globalState!,
            anchorEpoch: () => authorityRuntime.anchorEpoch,
          }),
        ),
      ),
      createTrustAdministrationProductApiContribution(trustAdministration),
      createScheduleManagementProductApiContribution(schedulerManagement),
      createScheduleRuntimeProductApiContribution(schedulerApplication),
      createWorksceneProductApiContribution(
        worksceneApplication,
      ),
      ...(advancementProductApi ? [advancementProductApi] : []),
      ...(deliveryProductApi ? [deliveryProductApi] : []),
      ...(deviceAdministrationProductApi ? [deviceAdministrationProductApi] : []),
    ],
  );
  ctx.channelConversationProduct?.bind(productApi);
  let serverCtx: ServerContext;
  serverCtx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    ...(ctx.meshRuntime && ctx.authorityRuntime
      ? {
          conversationRpc: new CurrentAnchorFirstPartyRpcRouter({
            deviceId: ctx.authorityRuntime.deviceId,
            currentAnchorDeviceId: () => ctx.meshRuntime!.currentAnchorDeviceId(),
            currentOwnerReady: () => ctx.meshRuntime!.plannedCurrentOwnerReady(),
            remoteFor: (deviceId) => ctx.meshRuntime!.firstPartyConversationFor(deviceId),
          }),
        }
      : {}),
    conversation: createServerConversationBinding(ctx.conversations!),
    productApi,
    hostInfo: {
      // 宿主单点解析的工作区——接入面 @ 补全 root 取此
      workspace: hostDefaultWorkspace.hostInfoWorkspace,
      logPath: daemonLogPath,
    },
    managedHostPublicStatus: () => buildManagedHostPublicStatus(
      { status: "running", phase: managedHostStopping ? "stopping" : "running" },
      { readiness: managedHostStopping ? "stopping" : "ready" },
    ),
    recoveryBackupStatus: async () => projectBackupRecoveryPublicStatus(ctx.authorityCheckpointOwner
      ? await ctx.authorityCheckpointOwner.status()
      : { state: "not-configured" as const, fullBackupReady: false }),
    // /mcp 状态显示与接入向导的宿主侧数据面(MCP 连接在宿主)
    mcpStatuses: () => [...mcpRuntime.status.snapshot()],
    // 轻推理通道(llm.complete,仅可信面)——管理流程的单发文本调用；
    // 经 control 治理边界准入计量(用户同步操作,interactive 类)。
    // 生产装配恒有 authorityRuntime(pre-server surface 已断言)——缺失即 fail-closed,不静默绕过治理
    llmComplete: (() => {
      const governor = ctx.authorityRuntime?.resourceGovernor;
      if (!governor) {
        throw new Error("llm.complete requires the durable authority runtime");
      }
      const raw: GovernedTextCall = (prompt, role, opts) =>
        ephemeralRuntime.callText(prompt, role, opts);
      return governControlTextCall(
        {
          governor,
          origin: { admissionClass: "interactive", entry: "conversation-input" },
          workPrefix: "llm-complete",
        },
        raw,
      );
    })(),
    channelStatuses: ctx.channelStatuses,
    channelHttpRoutes,
    confirmation: createServerConfirmationBinding(confirmationHub),
    serverInfoRuntime: {
      openFirstPartyFinality: async (input) => {
        const factory = ctx.firstPartyFinality;
        const authority = ctx.authorityRuntime;
        if (!factory || !authority) {
          throw new Error("First-party finality is unavailable");
        }
        const session = factory({
          lastSeen: input.lastSeen.map((cursor) => ({
            subject:
              cursor.subject.execution === "conversation"
                ? {
                    ...cursor.subject,
                    ownerEpoch: authority.anchorEpoch,
                  }
                : cursor.subject.execution === "job"
                  ? {
                      ...cursor.subject,
                      anchorEpoch: authority.anchorEpoch,
                    }
                  : cursor.subject,
            afterStatusRevision: cursor.afterStatusRevision,
          })),
          onStatus: input.onStatus,
          ...(input.onResyncRequired
            ? { onResyncRequired: input.onResyncRequired }
            : {}),
        });
        await session.start();
        return {
          next: session.nextCursors().map((cursor) => ({
            subject:
              cursor.subject.execution === "conversation"
                ? {
                    execution: "conversation" as const,
                    conversationId: cursor.subject.conversationId,
                    runId: cursor.subject.runId,
                  }
                : cursor.subject.execution === "job"
                  ? {
                      execution: "job" as const,
                      taskId: cursor.subject.taskId,
                      jobRunId: cursor.subject.jobRunId,
                    }
                  : cursor.subject,
            afterStatusRevision: cursor.afterStatusRevision,
          })),
          close: () => session.close(),
        };
      },
      deliveryStats: () => {
        if (!ctx.deliveryStack) {
          return {
            pending: 0,
            queued: 0,
            attempting: 0,
            delivered: 0,
            failed: 0,
            retrying: 0,
            uncertain: 0,
          };
        }
        return ctx.deliveryStack.stats();
      },
      deliveryStatus: (afterByItem) =>
        ctx.deliveryStack?.statusHistory(afterByItem) ?? Promise.resolve([]),
      conversationStatus: (after) =>
        ctx.conversationProtocol?.statusHistory(after) ??
        Promise.resolve({ notices: [], next: [] }),
      jobStatus: (after) =>
        ctx.jobStatus?.statusHistory(after) ??
        Promise.resolve({ notices: [], next: [] }),
      schedulerNotices: (afterRevision) =>
        ctx.jobStatus?.schedulerHistory(afterRevision) ??
        Promise.resolve({ notices: [], nextRevision: afterRevision }),
    },
    conversationFinalHistory: async (conversationId, afterCommitRevision) =>
      (await ctx.conversationProtocol?.finalHistory(
        conversationId,
        afterCommitRevision,
      ) ?? []).map(({ frame, publishResults }) => ({ frame, publishResults })),
    lifecycleShutdown: stopCoordinator,
  });
  if (ctx.meshRuntime) {
    const firstPartyConversationMeshSurface =
      ctx.meshRuntime.createFirstPartyConversationSurfaceLifecycle({
        dispatch: ({ method, params, connection }) =>
          serverRegistry.dispatchCanonical(method, params, {
            connection,
            server: serverCtx,
          }),
      });
    lifecycleContributions.acquire(
      "firstPartyConversationMeshSurface.close",
      () => firstPartyConversationMeshSurface.close(),
    );
  }

  ctx.deliveryStack?.onStatus((notice) => {
    serverCtx.broadcastAll?.("delivery.status", notice);
  });

  // runServer 将同一 prepared endpoint 单向转交给 Host shell；activation
  // gate、ready publication 与正常终止共享同一个幂等 owner。
  if (!await verifyManagedHostAdmission(
    initialManagedHostAdmission,
    processMode,
    zhixingHome,
  )) {
    ctx.inboundRouter?.refuseNewMessages();
    await reconcileCurrentManagedService("managed-preflight");
    throw new Error("Managed host admission changed during startup");
  }
  runner = await runServer({
    context: serverCtx,
    boundServer: serverBinding,
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    registry: serverRegistry,
    scheduleRuntimeEvents: schedulerApplication,
    cleanupRegistry: registry,
    lifecycleOwner: hostShellLifecycle,
    logger: {
      info: (msg) => console.log(chalk.dim(`[server] ${msg}`)),
      warn: (msg) => console.warn(chalk.yellow(`[server] ${msg}`)),
      error: (msg) => console.error(chalk.red(`[server] ${msg}`)),
    },
    beforeActivate: async (openingRunner) => {
      hostShellLifecycle.assertActivationOwnership({
        serverLog: !!serverLogLifecycle,
        checkpointOwner: !!ctx.authorityCheckpointOwner,
      });
      lifecycleContributions.acquire(
        "anchorInternalStop.close",
        () => anchorInternalStopLifecycle.close(),
      );
      anchorInternalStopLifecycle.install({
        requestId: `anchor-internal-stop:${protocolDigest("AnchorInternalStopRequest", 1, {
          homeId: lifecycleHomeId,
          host: stopHost,
        })}`,
        timeoutMs: 30_000,
        prepare: (request) => stopCoordinator.prepare(request),
        requestShutdown: (reason) => {
          const shutdown = serverCtx.requestShutdown;
          if (!shutdown) throw new Error("Anchor Server shutdown is not bound");
          shutdown(reason);
        },
      });

      // Server 内部设施已准备、公开入口仍为 inactive 503；同一 provenance
      // transport 在任何恢复/调度/Channel consumer 可达前原子装入稳定 Host port。
      lifecycleContributions.acquire(
        "sessionBroadcast.close",
        () => sessionBroadcastLifecycle.close(),
      );
      const sessionTransport = openingRunner.server.sessionBroadcastTransport;
      if (!sessionTransport) {
        throw new Error("Anchor Server did not provide a session broadcast transport");
      }
      sessionBroadcastLifecycle.install(sessionTransport);

      // Delivery/Scheduler 的既有 activation 是公开入口开放的必要前置。
      ctx.deliveryStack?.activate();
      if (!startupLifecycle) schedulerApplication.activate();

      // prepared runner 只提供内部 connection/cleanup 设施；activation gate 尚未释放。
      ctx.runner = openingRunner;
      if (!startupLifecycle || startupLifecycleFrozenRecoveryStarted) {
        await schedulerApplication.resumeManualSurfaces();
      }

      // Host shell 已接管 endpoint/state/discovery。既有 pre-server 贡献按
      // 稳定阶段转交，并在 LIFO 中先于 shell 终止。
      lifecycleContributions.transferTo(registry, "foundation");
      lifecycleContributions.transferTo(registry, "surface");

      // post-server contribution 依赖 prepared server.connections，但不要求入口已激活。
      // 每个资源先进入同一 startup rollback，再由 gate 作有限、类型化移交。
      await setupAssemblyUnits(assemblyUnits, ctx, "post-server");

      lifecycleContributions.transferExactTo(
        registry,
        "post-server",
        ctx.conversations ? ["confirmationBridge.dispose"] : [],
      );

      // pre-server units transfer their typed contributions in the established
      // registration order. The same handles remain idempotently owned by the
      // startup rollback until the full normal chain is complete.
      lifecycleContributions.transferTo(registry, "runtime");

      lifecycleContributions.transferExactTo(registry, "activation", [
        "anchorInternalStop.close",
        "sessionBroadcast.close",
        ...(ctx.conversations ? ["execution.abortAllAndWait" as const] : []),
        ...(
          ctx.conversationProtocol && !startupLifecycle
            ? ["conversationProtocol.stopRecovery" as const]
            : []
        ),
        ...(schedulerCleanup ? ["scheduler.stop" as const] : []),
        ...(ctx.inboundRouter ? ["inboundRouter.refuseNew" as const] : []),
        ...(
          ctx.evidenceHandler
            ? ["evidenceHandler.stopAccepting" as const]
            : []
        ),
        ...(ctx.meshRuntime
          ? ["firstPartyConversationMeshSurface.close" as const]
          : []),
      ]);

      // 正常停机链已经完整接管所有已取得资源；启动补偿事务不再持有独立责任。
      lifecycleContributions.assertTransferred();
      startupRollback.commit();
    },
    beforePublish: async (openingServer) => {
      hostShellLifecycle.assertActiveEndpoint(openingServer);
    },
    publishReady: async (openingRunner) => {
      // All listener owners publish the same local generation; only background
      // startup uses the separate ready marker handshake.
      // 只有同一 bound handle 已激活且 PID/port 已发布后，才发布 state/ready。
      await hostShellLifecycle.markReady({
        pid: process.pid,
        startedAt: processStartedAt,
        port: openingRunner.server.port,
        host: openingRunner.server.host,
      });
      await hostShellLifecycle.markRunning();
      hostShellLifecycle.startHeartbeat();

      if (processMode !== "managed") {
        console.log();
        console.log(chalk.green("  知行服务已启动"));
        console.log(chalk.dim(`  HTTP:      http://${openingRunner.server.host}:${openingRunner.server.port}`));
        console.log(chalk.dim(`  WebSocket: ws://${openingRunner.server.host}:${openingRunner.server.port}/ws`));
        console.log(chalk.dim(`  Token:     ${tokenInfo.path}`));
        if (ctx.channelStatuses) {
          const statuses = ctx.channelStatuses();
          const connected = statuses.filter((s) => s.state === "connected");
          console.log(chalk.dim(`  Channels:  ${connected.length}/${statuses.length} connected`));
          for (const s of statuses) {
            const icon = s.state === "connected" ? chalk.green("●") : chalk.red("●");
            console.log(
              chalk.dim(`    ${icon} ${s.channelId}: ${s.state}${s.error ? ` (${s.error})` : ""}`),
            );
          }
        }
        console.log(chalk.dim(`  Ctrl+C 停止`));
        console.log();
      }
    },
  });

  // idle reaper —— 仅后台宿主装配:前台进程的生命周期归终端(用户
  // Ctrl+C),reaper 管的是没有终端的后台宿主——这是进程形态差异,不是档位。
  // 退出条件 = 无人且无事:无活跃 RPC 连接、无活跃远程接入面、无用户待办。
  // - 接入面在场看真实连接状态而非 registry 对象存在性(配了渠道但全部连接
  //   失败 = 不在场,废宿主退出胜过空挂、下次拉起重试连接);connecting 算
  //   在场——断线重连窗口里杀进程会让恢复机制随进程消失。
  // - 用户待办 = 有 enabled 的非内部任务——定时任务的语义就是"我不在它也跑",
  //   这是调度 + 投递的核心价值;内部维护任务(retention 等)不算待办,否则
  //   宿主永不退。
  // 三者皆无即空闲退出(client 下次操作 ensure 重新拉起)。
  // 退出走正常 shutdown(drain 在跑任务)、不改 idempotent shutdown 契约。
  if (processMode === "on-demand") {
    const IDLE_CHECK_MS = 60_000;
    hostShellLifecycle.startIdleReaper(async () => {
      const exit = shouldIdleExit({
        connectionCount: runner!.server.connections.size,
        channelStates:
          ctx.channelStatuses?.().map((s) => s.state) ?? [],
        hasUserPendingWork:
          schedulerApplication.readStatus().enabledUserTaskCount > 0,
      });
      if (exit) {
        await anchorInternalStop.requestStop({ reason: "idle", strategy: "drain" });
      }
    }, (error) => {
      console.error(
        chalk.red("[idle] durable Host stop failed; the same operation will retry"),
        error instanceof Error ? error.message : String(error),
      );
    }, IDLE_CHECK_MS);
  }

  // 等待停机 —— 所有清理由 lifecycle.ts 的 shutdown → registry.runAll 统一完成
  await runner.waitForShutdown();
  } catch (error) {
    if (runner) {
      await runner.shutdown("startup-error").catch(() => {});
    } else {
      await startupRegistry?.runAll("startup-failure").catch(() => {});
    }
    await startupRollback.rollback().catch((rollbackError) => {
      console.error(
        chalk.red("[startup] rollback failed:"),
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError),
      );
    });
    throw error;
  }
}

function assertAcceptedWorkSubset(
  current: readonly HostStopAcceptedWorkItem[],
  frozen: readonly HostStopAcceptedWorkItem[],
  label: string,
): void {
  const expected = new Map(frozen.map((item) => [item.id, item.revision]));
  for (const item of current) {
    if (expected.get(item.id) !== item.revision) {
      throw new Error(`${label} observed an unowned or successor accepted-work item`);
    }
  }
}

function deliveryLifecycleSourcesFromOwnerItems(
  items: readonly {
    readonly owner: string;
    readonly id: string;
    readonly revision: string;
  }[],
): readonly DeliveryLifecycleSourcePermit[] {
  const sources = new Map<string, DeliveryLifecycleSourcePermit>();
  for (const item of items) {
    const source = item.owner === "conversation"
      ? {
          owner: "conversation" as const,
          id: item.id,
          revision: protocolDigest("ConversationDeliveryLifecycleSource", 1, {
            conversationId: item.id,
          }),
        }
      : item.owner === "final"
        ? {
            owner: "conversation" as const,
            id: item.id,
            revision: item.revision,
          }
      : item.owner === "assignment"
        ? {
            owner: "assignment" as const,
            id: item.id,
            revision: item.revision,
          }
        : item.owner === "scheduler"
          ? { owner: "scheduler" as const, id: item.id, revision: item.revision }
          : item.owner === "remote" && (item.id.startsWith("relay:") || item.id.startsWith("local:"))
            ? {
                owner: "assignment" as const,
                id: item.id,
                revision: item.revision,
              }
            : undefined;
    if (!source) continue;
    const key = `${source.owner}\u0000${source.id}`;
    const previous = sources.get(key);
    if (previous && previous.revision !== source.revision) {
      throw new Error("Lifecycle accepted-work contains conflicting delivery source revisions");
    }
    sources.set(key, Object.freeze(source));
  }
  return Object.freeze([...sources.values()].sort((left, right) =>
    `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US")));
}
