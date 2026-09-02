/**
 * 投递基础设施组装 — serve 和 repl 共用
 *
 * 职责：
 * - 创建 OutboxRegistry（顺序层，per-target FIFO）
 * - 组装 conversation 使用的权威 delivery 生产链
 * - 两条链路共享 per-target FIFO Outbox
 *
 * 不关心通道具体类型（飞书/Slack/...），只依赖 Delivery 拥有的有限发送效果端口。
 * 不关心运行模式（REPL/serve），两端调用方式一样。
 */

import {
  type RuntimeExecutionProfile,
  createEventBus,
  type PermissionRule,
} from "@zhixing/core";
import {
  AuthorityDeliveryPipeline,
  DeliveryAuthority,
  DeliveryTransportRegistry,
  DEFAULT_AUTHORITY_DELIVERY_CONFIG,
  type AuthorityDeliveryEventMap,
  type AuthorityDeliveryStats,
  type DeliveryStatusNotice,
  type OutboxEvent,
  type OutboxRegistry,
} from "@zhixing/core/delivery";
import {
  createChannelDeliveryEffect,
  type ChannelDeliveryEffectSource,
} from "@zhixing/core/delivery/channel-effect";
import type {
  AuthorityError,
  CapabilityDescriptor,
  CredentialBindingDescriptor,
  DeviceIdentity,
  EnvironmentPort,
  EnvironmentRequirement,
  ExecutionAssetBundle,
  ExecutionManifest,
  ExplicitEnvironmentSelection,
  GlobalStatePort,
  JobExecutionInstruction,
  SecretStorePort,
  TrustRuleSnapshot,
  WorksceneAppliedResult,
  WorkspaceBindingAdminPort,
  WorkspaceBindingMigrationPort,
  WorkspaceBindingRecoveryPort,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedCapabilityDescriptor,
  createSignedExecutorVersionInventory,
  compareCanonicalStrings,
  createAuthorityPrincipalMethodGuard,
  EXECUTION_PROTOCOL_VERSION,
  ExecutorCapabilityDirectory,
  matchManifest,
  normalizeTrustRulesForSnapshot,
  protocolDigest,
  type ExecutorCapabilitySnapshot,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import {
  runInMaintenanceContext,
  StorageMaintenanceTaskRunner,
  type DeviceCapacityArbiterPort,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import {
  deriveEnvironmentRequirement,
  executionProfileForEnvironment,
  EnvironmentProbeOwner,
  ExecutorSelectionRequiredError,
  preflightWorkspaceRequirement,
  selectExecutorForEnvironment,
  WorkspaceBindingCatalog,
  workspaceCatalogGenerationStorageKey,
  WorkspaceProbeHandler,
  type WorkspaceProbePort,
} from "@zhixing/core/environment";
import {
  AnchorRubricGlobalStateAdapter,
  AnchorSkillGlobalStateAdapter,
  AnchorWorksceneGlobalStateAdapter,
  parseConversationId,
} from "@zhixing/core";
import {
  DeliveryUncertainResolutionApplicationService,
  type DeliveryUncertainResolutionApplication,
} from "@zhixing/core/delivery/application";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  type SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import type {
  ControlAdmissionJournal,
  AnchorResourceGovernor,
  OwnerDeliveryParticipant,
  ConversationAssignmentCredentialPolicy,
  JobAssignmentCredentialPolicy,
  GlobalMutationCommitParticipant,
} from "@zhixing/owner-kernel";
import {
  createOwnerDeliveryLifecycleBinding,
  createOwnerDeliveryParticipant,
  type OwnerDeliveryLifecycleBinding,
} from "@zhixing/owner-kernel/delivery";
import type { ExecutorResourceGovernor } from "@zhixing/executor";
import {
  DeviceKey,
  deviceIdFromPublicKey,
  enrollDeviceIdentity,
} from "@zhixing/mesh/device-identity";

import * as fsp from "node:fs/promises";
import path from "node:path";
import {
  FileExecutionSnapshotVersionStore,
  FileExecutorCapabilityDirectoryStore,
  FileTrustRuleSnapshotCatalog,
} from "./executor-snapshot-version-store.js";
import { loadOrCreateDeviceKey } from "./serve/mesh-device-key.js";
import {
  createSurfaceAssetAuthority,
  rebindSurfaceAssetAuthority,
} from "./serve/surface-asset-authority.js";
import { createLiveTrustedDeviceProtocolVerifier } from "./serve/trusted-device-protocol-verifier.js";
import { SchedulerCapabilityGapError } from "./serve/scheduler-capability-gap.js";
import { CredentialExposureAuthority } from "./serve/credential-exposure-authority.js";
import {
  StartupRollback,
  type StartupCleanupHandle,
} from "./serve/startup-rollback.js";
import {
  FileExecutionAssetCache,
  type ExecutionAssetCatalogPort,
} from "./serve/execution-asset-cache.js";
import type { InstalledAuthorityGeneration } from "./serve/planned-anchor-transfer.js";
import { FileWorkspaceProbePersistence } from "./serve/workspace-probe-persistence.js";
import { FileWorkspaceBindingGenerationPersistenceFactory } from "./serve/workspace-binding-generation-persistence.js";
import { FileWorkspaceBindingCatalogPersistence } from "./serve/workspace-binding-catalog-persistence.js";

export const INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS = Object.freeze([
  "runtime-epoch",
  "delivery-authority",
  "control-admission",
  "resource-governor",
  "surface-assets",
  "workscene-global-state",
  "skill-global-state",
  "rubric-global-state",
] as const);

export interface InstalledAuthorityGenerationReceipt {
  readonly generation: InstalledAuthorityGeneration;
  readonly participants: typeof INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS;
}

export interface PlannedAnchorReadySnapshot {
  readonly configuredCapabilities: {
    readonly providers: readonly string[];
    readonly mcpServers: readonly string[];
    readonly channels: readonly string[];
  };
  readonly protocolRevision: string;
  readonly assetRevision: string;
  readonly serviceRevision: string;
  readonly credentialRevision: string;
}

export interface PlannedAnchorReadinessPort {
  snapshot(): Promise<PlannedAnchorReadySnapshot>;
  reserve(input: {
    readonly transferId: string;
    readonly expiresAt: string;
  }): Promise<PlannedAnchorReadySnapshot>;
  release(transferId: string): Promise<void>;
}

export function createProductionAnchorReadySnapshot(input: {
  readonly configurationSnapshot: unknown;
  readonly assetRevision: string;
  readonly credentialRevision: string;
  readonly anchorEnabled: boolean;
  readonly executorEnabled: boolean;
}): PlannedAnchorReadySnapshot {
  const configured = plannedAnchorCapabilities(input.configurationSnapshot);
  return Object.freeze({
    configuredCapabilities: configured.capabilities,
    protocolRevision: protocolDigest("PlannedAnchorProtocolRevision", 1, {
      executableVersion: configured.executableVersion,
      executionProtocolVersion: EXECUTION_PROTOCOL_VERSION,
    }),
    assetRevision: input.assetRevision,
    serviceRevision: protocolDigest("PlannedAnchorServiceRevision", 1, {
      capabilities: configured.capabilities,
      anchor: input.anchorEnabled,
      executor: input.executorEnabled,
    }),
    credentialRevision: input.credentialRevision,
  });
}

export function createPlannedAnchorReadinessCoordinator(
  snapshot: () => Promise<PlannedAnchorReadySnapshot>,
): {
  readonly port: PlannedAnchorReadinessPort;
  runRevisionChange<T>(operation: () => Promise<T>): Promise<T>;
} {
  const operations = new SerialTaskQueue();
  let reservation: {
    readonly transferId: string;
    readonly expiresAt: string;
  } | undefined;
  const port: PlannedAnchorReadinessPort = Object.freeze({
    snapshot: () => operations.run(snapshot),
    reserve: (input: {
      readonly transferId: string;
      readonly expiresAt: string;
    }) => operations.run(async () => {
      if (reservation && reservation.transferId !== input.transferId) {
        throw new Error("Another duty-device migration owns the readiness reservation");
      }
      const current = await snapshot();
      reservation = Object.freeze({ ...input });
      return current;
    }),
    release: (transferId: string) => operations.run(async () => {
      if (reservation?.transferId === transferId) reservation = undefined;
    }),
  });
  return Object.freeze({
    port,
    runRevisionChange: <T>(operation: () => Promise<T>) => operations.run(async () => {
      if (reservation) {
        throw new Error("Execution assets are reserved by a duty-device migration");
      }
      return operation();
    }),
  });
}

export interface AuthorityRuntimeStack {
  readonly anchorEpoch: number;
  readonly localDomainId: string;
  readonly localOwnerEpoch: number;
  readonly localGovernorEpoch: number;
  readonly deviceId: string;
  readonly identityKey: DeviceKey;
  readonly identity: DeviceIdentity;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly authority: DeliveryAuthority;
  readonly deliveryLifecycle?: OwnerDeliveryLifecycleBinding;
  readonly authorityLog: FileAuthorityCommitLog;
  readonly localExecutorEnabled: boolean;
  readonly executorLog: FileAuthorityCommitLog;
  readonly artifacts: FileArtifactStore;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly surfaceAssets: SurfaceAssetCoordinator;
  readonly checkpointRetention: import("@zhixing/core/authority").ArtifactCheckpointRetentionPort;
  readonly participant: OwnerDeliveryParticipant;
  readonly controlAdmission: ControlAdmissionJournal;
  readonly localControlAdmission: ControlAdmissionJournal;
  readonly executorCapabilities: ExecutorCapabilityDirectory;
  readonly resourceGovernor: AnchorResourceGovernor;
  readonly executorResourceGovernor: ExecutorResourceGovernor;
  readonly environment?: EnvironmentPort;
  readonly workspaceBindingAdmin?: WorkspaceBindingAdminPort;
  readonly workspaceBindingMigration?: WorkspaceBindingMigrationPort;
  readonly workspaceBindingRecovery?: WorkspaceBindingRecoveryPort;
  readonly workspaceProbe?: WorkspaceProbePort;
  readonly environmentProbeOwner?: EnvironmentProbeOwner;
  readonly globalState?: GlobalStatePort;
  readonly rubricGlobalState?: AnchorRubricGlobalStateAdapter;
  readonly globalMutationParticipants: readonly GlobalMutationCommitParticipant[];
  readonly installSchedulerGlobalState: (state: GlobalStatePort) => void;
  readonly rebindInstalledAuthority: (
    generation: InstalledAuthorityGeneration,
  ) => Promise<InstalledAuthorityGenerationReceipt>;
  readonly recoverWorksceneState: () => Promise<void>;
  readonly replayWorksceneMutation: (
    requestId: string,
  ) => Promise<WorksceneAppliedResult | null>;
  readonly installWorksceneCleanup: (
    cleanup: (
      sceneId: string,
      conversationIds: readonly string[],
    ) => Promise<void>,
  ) => void;
  readonly workspaceCatalog: () => readonly {
    executorId: string;
    deviceId: string;
    deviceName: string;
    bindingRef: string;
    displayName: string;
    workspaceBindingRevision: number;
  }[];
  readonly permissionSnapshotFor: (
    digest: string,
  ) => TrustRuleSnapshot | undefined;
  readonly latestPermissionSnapshot: () => Promise<TrustRuleSnapshot | undefined>;
  readonly executionAssetCatalog: ExecutionAssetCatalogPort;
  readonly currentExecutionAssetBundle: () => Promise<ExecutionAssetBundle | undefined>;
  readonly installExecutionAssetBundle: (
    bundle: ExecutionAssetBundle,
  ) => Promise<ExecutorCapabilitySnapshot>;
  readonly currentExecutorSnapshot: () => Promise<ExecutorCapabilitySnapshot>;
  readonly plannedAnchorReadiness: PlannedAnchorReadinessPort;
  readonly installPermissionSnapshot: (
    snapshot: TrustRuleSnapshot,
  ) => Promise<ExecutorCapabilitySnapshot>;
  readonly acceptExecutorSnapshot: (
    snapshot: ExecutorCapabilitySnapshot,
  ) => Promise<void>;
  readonly reconcileTrustedDevices: (
    identities: readonly DeviceIdentity[],
    authorizedDeviceIds: readonly string[],
  ) => void;
  readonly prepareConversationAssignment: (input: {
    readonly conversationId: string;
    readonly executionProfile: RuntimeExecutionProfile;
    readonly permissionRules: readonly PermissionRule[];
    readonly environment?: ExplicitEnvironmentSelection;
    readonly recentExecutorId?: string;
    readonly targets?: readonly {
      readonly executorId: string;
      readonly deviceId: string;
      readonly synchronizePermission: (
        snapshot: TrustRuleSnapshot,
        executionAssets?: ExecutionAssetBundle,
      ) => Promise<ExecutorCapabilitySnapshot>;
    }[];
  }) => Promise<PreparedConversationAssignmentAuthority>;
  readonly prepareLocalConversationAssignment: (input: {
    readonly conversationId: string;
    readonly executionProfile: RuntimeExecutionProfile;
    readonly permissionRules: readonly PermissionRule[];
    readonly environment?: ExplicitEnvironmentSelection;
  }) => Promise<PreparedConversationAssignmentAuthority>;
  readonly prepareJobAssignment: (input: {
    readonly instruction: JobExecutionInstruction;
    readonly capabilities: {
      readonly tools: readonly string[];
      readonly mcpServers: readonly string[];
    };
    readonly targets?: readonly {
      readonly executorId: string;
      readonly deviceId: string;
      readonly synchronizePermission: (
        snapshot: TrustRuleSnapshot,
        executionAssets?: ExecutionAssetBundle,
      ) => Promise<ExecutorCapabilitySnapshot>;
    }[];
  }) => Promise<{
    readonly executorId: string;
    readonly policy: JobAssignmentCredentialPolicy;
    readonly environment: EnvironmentRequirement;
  }>;
  readonly validateConversationRuntimeBinding: (input: {
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
    readonly binding: ConversationRuntimeBinding;
  }) => Promise<AuthorityError | undefined>;
  readonly preflightLocalConversationEnvironment: (
    manifest: ExecutionManifest<"conversation">,
    assignmentId?: string,
  ) => Promise<{
    readonly workspaceRoot: string | null;
    readonly error?: AuthorityError;
  }>;
  readonly takeLocalConversationEnvironmentPreflight: (
    manifest: ExecutionManifest<"conversation">,
    assignmentId: string,
  ) => Promise<{
    readonly workspaceRoot: string | null;
    readonly error?: AuthorityError;
  }>;
  readonly releaseLocalConversationEnvironmentPreflight: (
    manifest: ExecutionManifest<"conversation">,
    assignmentId: string,
  ) => void;
  readonly validateLocalConversationManifest: (
    manifest: ExecutionManifest<"conversation">,
  ) => AuthorityError | undefined;
  readonly stopStorageMaintenance: () => Promise<void>;
  /**
   * 启动阶段的清理句柄:在任何资源取得之前注册进启动回滚事务,内部失败、外层
   * 启动失败与正常停机复用同一幂等 handle,维护任务恰一次停止。
   */
  readonly startupCleanup: StartupCleanupHandle;
}

export interface ConversationRuntimeBinding {
  readonly executionProfile: RuntimeExecutionProfile;
  readonly deviceDigest: string;
}

export interface PreparedConversationAssignmentAuthority {
  readonly executorId: string;
  readonly policy: ConversationAssignmentCredentialPolicy;
  readonly binding: ConversationRuntimeBinding;
  readonly environment: EnvironmentRequirement;
}

export interface DeliveryStack {
  authorityDelivery: AuthorityDeliveryPipeline;
  /** Enables transport side effects after the RPC server is listening. */
  activate(): void;
  stats(): AuthorityDeliveryStats;
  readonly lifecycle: DeliveryAcceptedWorkLifecyclePort;
  flush(): Promise<void>;
  quiesceForAuthorityTransfer(): Promise<void>;
  resumeAfterAuthorityTransfer(): Promise<void>;
  recoverInstalledAuthority(): Promise<void>;
  authority: DeliveryAuthority;
  authorityLog: FileAuthorityCommitLog;
  artifacts: FileArtifactStore;
  participant: OwnerDeliveryParticipant;
  controlAdmission: ControlAdmissionJournal;
  outboxRegistry: OutboxRegistry;
  statusHistory: (
    afterByItem?: Readonly<Record<string, number>>,
  ) => Promise<readonly DeliveryStatusNotice[]>;
  onStatus: (
    listener: (notice: DeliveryStatusNotice) => void | Promise<void>,
  ) => () => void;
  resolutionApplication: DeliveryUncertainResolutionApplication;
  startupCleanup: StartupCleanupHandle;
  stop: () => Promise<void>;
}

export interface DeliveryAcceptedWorkLifecyclePort {
  capture(): readonly { readonly id: string; readonly revision: string }[];
  install(input: import("@zhixing/core").DeliveryLifecycleAdmission): Promise<void>;
  restore(input: import("@zhixing/core").DeliveryLifecycleRestoration): Promise<void>;
  seal(operationId: string): Promise<void>;
  release(operationId: string): Promise<void>;
  read(
    operationId: string,
  ): Promise<readonly { readonly id: string; readonly revision: string }[]>;
  close(): void;
  settle(input: {
    readonly operationId: string;
    readonly strategy: "immediate" | "drain" | "cancel";
    readonly timeoutMs: number;
  }): Promise<void>;
  resume(): Promise<void>;
}

export interface SetupDeliveryOptions {
  channels: ChannelDeliveryEffectSource;
  zhixingHome: string;
  authorityRuntime: AuthorityRuntimeStack;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 可选：观测 Outbox 事件（测试/调试；生产留空由 logger 承接） */
  onOutboxEvent?: (event: OutboxEvent) => void;
  startupRollback?: StartupRollback;
}

export interface ExecutorReadiness {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly credentialBindings: readonly Omit<
    CredentialBindingDescriptor,
    "revision"
  >[];
  readonly deviceScopedCredentialBindingIds: readonly string[];
  /** Opaque SecretStore commit generation; never published on protocol surfaces. */
  readonly credentialGeneration: string | null;
}

export interface SetupAuthorityRuntimeOptions {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly deviceKey?: DeviceKey;
  readonly trustedIdentities?: readonly DeviceIdentity[];
  readonly authorizedDeviceIds?: readonly string[];
  readonly executorId?: string;
  readonly anchorEpoch?: number;
  readonly installedAuthorityGeneration?: InstalledAuthorityGeneration;
  readonly configurationSnapshot?: unknown;
  /**
   * Omit only for the target-device local workspace settings process. In that
   * mode the previously published non-secret readiness is preserved while the
   * workspace projection advances.
   */
  readonly executorReadiness?: ExecutorReadiness | (() => ExecutorReadiness);
  readonly enableAnchor?: boolean;
  readonly enableLocalExecutor?: boolean;
  readonly resourceCandidateTtlMs?: number;
  readonly clock?: () => string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly deviceCapacity?: DeviceCapacityArbiterPort;
  readonly startupRollback?: StartupRollback;
}

export async function setupAuthorityRuntime(
  options: SetupAuthorityRuntimeOptions,
): Promise<AuthorityRuntimeStack> {
  // 清理所有权先于任何资源取得建立:恢复与首次日志使用会在本函数中途启动维护
  // 义务与定时任务,等函数返回后再注册,"恢复后、返回前失败"的窗口里就没有任何
  // 人持有停止句柄。闭包读取下方逐步赋值的资源变量,未构造的部分停止即空操作,
  // 因此注册点不需要判断"第一个可能启动维护的步骤在哪"。
  let authorityLog: FileAuthorityCommitLog | undefined;
  let executorLog: FileAuthorityCommitLog | undefined;
  let surfaceAssets: ReturnType<typeof createSurfaceAssetAuthority> | undefined;
  let worksceneGlobalState: AnchorWorksceneGlobalStateAdapter | undefined;
  let skillGlobalState: AnchorSkillGlobalStateAdapter | undefined;
  let rubricGlobalState: AnchorRubricGlobalStateAdapter | undefined;
  let schedulerGlobalState: GlobalStatePort | undefined;
  let workspaceBindings: WorkspaceBindingCatalog | undefined;
  let workspaceProbe: WorkspaceProbeHandler | undefined;
  const stopStorageMaintenance = async () => {
    await workspaceProbe?.stopRetentionMaintenance();
    await surfaceAssets?.stopStorageMaintenance();
    await worksceneGlobalState?.stop();
    await workspaceBindings?.stop();
    await authorityLog?.stopStorageMaintenance();
    await executorLog?.stopStorageMaintenance();
  };
  const startupRollback = options.startupRollback ?? new StartupRollback();
  const startupCleanup = startupRollback.register(
    "authorityRuntime.stopStorageMaintenance",
    stopStorageMaintenance,
  );
  try {
    const authorityRoot = path.join(options.zhixingHome, "distributed-runtime");
    const artifacts = new FileArtifactStore(
      path.join(authorityRoot, "artifacts"),
    );
    const anchorEnabled = options.enableAnchor ?? true;
    authorityLog = anchorEnabled
      ? new FileAuthorityCommitLog(
          path.join(authorityRoot, "authority"),
          artifacts,
          {
            storageMaintenance: options.storageMaintenance,
            // commit 时间戳与本 stack 其余组件必须同钟:租约活性等判定
            // 以 commit.at 与注入时钟做差,分裂时钟会产生假过期。
            ...(options.clock ? { clock: options.clock } : {}),
          },
        )
      : undefined;
    const localExecutorEnabled = options.enableLocalExecutor ?? true;
    const ownerRuntime = anchorEnabled || localExecutorEnabled
      ? await import("@zhixing/owner-kernel")
      : undefined;
    const executorRuntime = localExecutorEnabled
      ? await import("@zhixing/executor")
      : undefined;
    executorLog = localExecutorEnabled
      ? new FileAuthorityCommitLog(
          path.join(authorityRoot, "executor-authority"),
          artifacts,
          {
            storageMaintenance: options.storageMaintenance,
            ...(options.clock ? { clock: options.clock } : {}),
          },
        )
      : undefined;
    let anchorEpoch = options.anchorEpoch ?? 1;
    if (
      options.installedAuthorityGeneration &&
      options.installedAuthorityGeneration.anchorEpoch !== anchorEpoch
    ) {
      throw new Error("Installed authority generation does not match the configured anchor epoch");
    }
    let installedAuthorityGeneration = options.installedAuthorityGeneration;
    let authority = authorityLog
      ? new DeliveryAuthority({ log: authorityLog, anchorEpoch })
      : undefined;
    let participant = authority
      ? createOwnerDeliveryParticipant({ authority })
      : undefined;
    let deliveryLifecycle = authority
      ? createOwnerDeliveryLifecycleBinding({ authority })
      : undefined;
    let controlAdmission = authorityLog
      ? new ownerRuntime!.ControlAdmissionJournal(authorityLog, artifacts)
      : undefined;
    const localControlAdmission = executorLog
      ? new ownerRuntime!.ControlAdmissionJournal(executorLog, artifacts)
      : undefined;
    const key =
      options.deviceKey ?? (await loadOrCreateDeviceKey(options.secretStore));
    const identity = enrollDeviceIdentity(key, {
      displayName: "local-anchor",
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux",
      enrolledAt: new Date().toISOString(),
    });
    const trustedIdentities = new Map(
      [identity, ...(options.trustedIdentities ?? [])].map((candidate) => [
        candidate.deviceId,
        candidate,
      ]),
    );
    const authorizedDeviceIds = new Set(
      options.authorizedDeviceIds ?? [...trustedIdentities.keys()],
    );
    authorizedDeviceIds.add(identity.deviceId);
    const verifier = createLiveTrustedDeviceProtocolVerifier((deviceId) =>
      trustedIdentities.get(deviceId)
    );
    const clock = options.clock ?? (() => new Date().toISOString());
    surfaceAssets = authorityLog
      ? createSurfaceAssetAuthority({
          authorityRoot,
          log: authorityLog,
          retentionLogs: [authorityLog, ...(executorLog ? [executorLog] : [])],
          artifacts,
          signer: key,
          verifier,
          anchorEpoch,
          storageMaintenance: options.storageMaintenance,
          clock,
        })
      : undefined;
    // 启动恢复没有任何调用在等它,但它决定权威何时可用:按恢复档准入,既不与
    // 小时级回收同档竞争,也不冒充前台抢占正在服务的请求。
    const recoveringAssets = surfaceAssets;
    if (recoveringAssets) {
      await runInMaintenanceContext("recovery", () =>
        recoveringAssets.recover(),
      );
    }
    const executorId = options.executorId ?? "executor:local";
    const capabilityDirectoryStore = new FileExecutorCapabilityDirectoryStore(
      path.join(authorityRoot, "executor-capability-directory.json"),
    );
    let capabilityDirectoryEstablished =
      (await capabilityDirectoryStore.load()) !== undefined;
    const versionStore = localExecutorEnabled
      ? new FileExecutionSnapshotVersionStore(
          path.join(authorityRoot, "executor-snapshot-version.json"),
          clock,
        )
      : undefined;
    await versionStore?.assertCapabilityDirectoryCoherence(
      capabilityDirectoryEstablished,
    );
    const permissionSnapshots = await FileTrustRuleSnapshotCatalog.open(
      path.join(authorityRoot, "permission-snapshots"),
      verifier,
    );
    const executionAssets = new FileExecutionAssetCache(
      path.join(authorityRoot, "execution-assets.json"),
      artifacts,
      verifier,
    );
    const executorCapabilities = await ExecutorCapabilityDirectory.open({
      verifier,
      store: capabilityDirectoryStore,
      isDeviceAuthorized: (deviceKeyId) => authorizedDeviceIds.has(deviceKeyId),
      allowInitialize: !capabilityDirectoryEstablished,
    });
    const resourceGuard = createAuthorityPrincipalMethodGuard({
      "resource-governor": [
        "reservation.enqueueRoot",
        "reservation.prepareAssignmentRoot",
        "reservation.prepareSystemJobRoot",
        "reservation.acquireRoot",
        "reservation.acquireChild",
        "reservation.reserveUsage",
        "reservation.consume",
        "reservation.settle",
        "reservation.release",
      ],
      // control 类轻推理治理边界（llm.complete / turn 后台维护）——最小方法面
      "control-llm": [
        "reservation.acquireRoot",
        "reservation.reserveUsage",
        "reservation.consume",
        "reservation.settle",
        "reservation.release",
      ],
    });
    let resourceGovernor = authorityLog
      ? new ownerRuntime!.AnchorResourceGovernor({
          log: authorityLog,
          signer: key,
          verifier,
          guard: resourceGuard,
          anchorEpoch,
          localExecutorId: executorId,
          reporterKeyFor: (candidateExecutorId) =>
            executorCapabilities.snapshotFor(candidateExecutorId)?.descriptor
              .signature.keyId,
          ...(options.resourceCandidateTtlMs === undefined
            ? {}
            : { candidateTtlMs: options.resourceCandidateTtlMs }),
          clock,
        })
      : undefined;
    const localOwnerEpoch = 1;
    const localGovernorEpoch = 1;
    const localDomainId = `local:${key.deviceId}`;
    const executorResourceGovernor = executorLog
      ? new executorRuntime!.ExecutorResourceGovernor({
          log: executorLog,
          signer: key,
          verifier,
          guard: resourceGuard,
          executorId,
          localDomainId,
          localGovernorEpoch,
          ...(options.resourceCandidateTtlMs === undefined
            ? {}
            : { candidateTtlMs: options.resourceCandidateTtlMs }),
          clock,
        })
      : undefined;
    const publicationQueue = new SerialTaskQueue();
    let publishedWorkspaces: CapabilityDescriptor["workspaces"] = [];
    let publishedWorkspaceCatalog = {
      catalogGeneration: "catalog-uninitialized",
      state: "degraded" as "healthy" | "degraded",
    };
    let latestLocalExecutorPublication:
      | {
          readonly snapshot: ExecutorCapabilitySnapshot;
          readonly deviceDigest: string;
        }
      | undefined;
    const readinessSource = () => {
      const configured = options.executorReadiness;
      if (configured !== undefined) {
        return normalizeExecutorReadiness(
          typeof configured === "function" ? configured() : configured,
          key.deviceId,
        );
      }
      const published =
        executorCapabilities.snapshotFor(executorId)?.descriptor;
      if (!published) {
        throw new Error(
          "Local workspace settings require an established executor capability snapshot",
        );
      }
      return {
        tools: [...published.tools],
        mcpServers: [...published.mcpServers],
        credentialBindings: published.credentialBindings.map(
          ({ revision: _revision, ...binding }) => binding,
        ),
        credentialGeneration: null,
      } satisfies NormalizedExecutorReadiness;
    };
    const deviceDigestFor = (
      readiness: NormalizedExecutorReadiness,
      workspaces: CapabilityDescriptor["workspaces"] = publishedWorkspaces,
      workspaceCatalog = publishedWorkspaceCatalog,
    ) =>
      protocolDigest("LocalTransitionConfiguration", 1, {
        configuration: options.configurationSnapshot ?? { profile: "default" },
        executorReadiness: {
          tools: readiness.tools,
          mcpServers: readiness.mcpServers,
          credentialBindings: readiness.credentialBindings,
          credentialGeneration: readiness.credentialGeneration,
          evidenceCapabilities: ["artifact", "file-diff", "log"],
        },
        workspaceCatalog: {
          catalogGeneration: workspaceCatalog.catalogGeneration,
          state: workspaceCatalog.state,
          workspaces: [...workspaces]
            .map((workspace) => ({ ...workspace }))
            .sort((left, right) =>
              left.bindingRef.localeCompare(right.bindingRef, "en-US"),
            ),
        },
      });
    const publishLocalExecutorSnapshot = async (
      permissionSnapshotHighWater: number,
      readiness = readinessSource(),
      workspaces: CapabilityDescriptor["workspaces"] = publishedWorkspaces,
      workspaceCatalog = publishedWorkspaceCatalog,
    ): Promise<{
      readonly snapshot: ExecutorCapabilitySnapshot;
      readonly deviceDigest: string;
    }> => {
      if (!versionStore) {
        throw new Error("Local executor role is not enabled on this device");
      }
      const deviceDigest = deviceDigestFor(
        readiness,
        workspaces,
        workspaceCatalog,
      );
      const executionAssetSnapshot = await executionAssets.current().catch(() => undefined);
      const inventoryDigest = protocolDigest("LocalTransitionInventory", 1, {
        deviceDigest,
        permissionSnapshotHighWater,
        executionAssetDigest: executionAssetSnapshot?.digest ?? null,
      });
      const versionResolution = await versionStore.synchronize(
        executorId,
        deviceDigest,
        inventoryDigest,
        { allowInitialize: !capabilityDirectoryEstablished },
      );
      const capabilityRevision = versionResolution.deviceRevision;
      const versionedCredentialBindings = readiness.credentialBindings.map(
        (binding) => ({
          ...binding,
          revision: capabilityRevision,
        }),
      );
      const descriptor = createSignedCapabilityDescriptor(
        {
          executorId,
          revision: capabilityRevision,
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          workspaces: workspaces.map((workspace) => ({ ...workspace })),
          tools: [...readiness.tools],
          mcpServers: [...readiness.mcpServers],
          credentialBindings: versionedCredentialBindings,
          evidenceCapabilities: ["artifact", "file-diff", "log"],
          at: versionResolution.deviceGeneratedAt,
        },
        key,
      );
      const inventory = createSignedExecutorVersionInventory(
        {
          executorId,
          inventoryRevision: versionResolution.inventoryRevision,
          capabilityRevision,
          configVersions: {
            runtimeConfigRev: capabilityRevision,
            modelProfileRev: capabilityRevision,
            policyRev: capabilityRevision,
          },
          assetVersions: {
            skillsRev:
              executionAssetSnapshot?.snapshotRevision ??
              FileExecutionAssetCache.emptyRevision(),
            rubricsRev:
              executionAssetSnapshot?.snapshotRevision ??
              FileExecutionAssetCache.emptyRevision(),
            promptAssetsRev:
              executionAssetSnapshot?.snapshotRevision ??
              FileExecutionAssetCache.emptyRevision(),
          },
          permissionSnapshotHighWater,
          credentialBindingRevisions: versionedCredentialBindings.map(
            ({ bindingId, revision }) => ({ bindingId, revision }),
          ),
          at: versionResolution.inventoryGeneratedAt,
        },
        key,
      );
      const snapshotUpdate = await executorCapabilities.accept({
        descriptor,
        inventory,
      });
      if (!snapshotUpdate.ok) {
        throw new Error(
          `Local executor capability snapshot rejected: ${snapshotUpdate.error.message}`,
        );
      }
      if (authorityLog) {
        await new CredentialExposureAuthority({
          deviceId: key.deviceId,
          log: authorityLog,
          secretStore: options.secretStore,
        }).publishActiveBindings({
          bindings: descriptor.credentialBindings,
          markedAt: descriptor.at,
        });
      }
      await versionStore.markCapabilityDirectoryEstablished({
        executorId,
        deviceDigest,
        deviceRevision: versionResolution.deviceRevision,
        inventoryDigest,
        inventoryRevision: versionResolution.inventoryRevision,
      });
      capabilityDirectoryEstablished = true;
      const publication = {
        snapshot: snapshotUpdate.snapshot,
        deviceDigest,
      };
      latestLocalExecutorPublication = publication;
      return publication;
    };
    if (localExecutorEnabled) {
      if (!options.deviceCapacity) {
        // Library callers that only exercise authority protocols may omit the
        // device runtime. Production assembly always supplies it; the local
        // environment ports remain physically absent otherwise.
      } else {
        const bindingRoot = path.join(authorityRoot, "workspace-bindings");
        const bindingArtifacts = new FileArtifactStore(
          path.join(bindingRoot, "artifacts"),
        );
        const bindingGenerationPersistence =
          new FileWorkspaceBindingGenerationPersistenceFactory({
            zhixingHome: options.zhixingHome,
          });
        const initialWorkspaceBindingLog = executorLog!;
        workspaceBindings = new WorkspaceBindingCatalog({
          rootPersistence: new FileWorkspaceBindingCatalogPersistence({
            zhixingHome: options.zhixingHome,
          }),
          initialGeneration: {
            log: initialWorkspaceBindingLog,
            persistence: bindingGenerationPersistence.create(
              "catalog-initial",
              initialWorkspaceBindingLog,
            ),
          },
          createGeneration: (generation) => {
            const log = new FileAuthorityCommitLog(
              path.join(
                bindingRoot,
                "catalogs",
                workspaceCatalogGenerationStorageKey(generation),
              ),
              bindingArtifacts,
              {
                storageMaintenance: options.storageMaintenance,
                clock,
              },
            );
            return {
              log,
              persistence: bindingGenerationPersistence.create(
                generation,
                log,
              ),
            };
          },
          service: {
            deviceId: key.deviceId,
            executorId,
            verifier,
            capacity: options.deviceCapacity,
            capabilitySnapshot: async (publication) => {
              const nextCatalog = {
                catalogGeneration: publication.catalogGeneration,
                state: publication.state,
              };
              const nextWorkspaces = publication.workspaces.map(
                (workspace) => ({
                  ...workspace,
                }),
              );
              return publicationQueue.run(async () => {
                const publication = await publishLocalExecutorSnapshot(
                  await permissionSnapshots.highWater(),
                  readinessSource(),
                  nextWorkspaces,
                  nextCatalog,
                );
                publishedWorkspaceCatalog = nextCatalog;
                publishedWorkspaces = nextWorkspaces;
                return publication.snapshot.descriptor;
              });
            },
            versionInventory: async () =>
              (
                await publicationQueue.run(async () =>
                  publishLocalExecutorSnapshot(
                    await permissionSnapshots.highWater(),
                    readinessSource(),
                    publishedWorkspaces,
                  ),
                )
              ).snapshot.inventory,
            clock,
          },
          recoveryRunner: new StorageMaintenanceTaskRunner(
            options.storageMaintenance,
          ),
          storageMaintenance: options.storageMaintenance,
          clock,
        });
        await workspaceBindings.initialize();
        workspaceProbe = new WorkspaceProbeHandler({
          executorId,
          environment: workspaceBindings,
          log: executorLog!,
          persistence: new FileWorkspaceProbePersistence({
            zhixingHome: options.zhixingHome,
            authorityLog: executorLog!,
          }),
          signer: key,
          verifier,
          capacity: options.deviceCapacity,
          storageMaintenance: options.storageMaintenance,
          clock,
        });
        workspaceProbe.startRetentionMaintenance();
      }
    }
    const environmentProbeOwner = anchorEnabled
      ? new EnvironmentProbeOwner({
          signer: key,
          verifier,
          clock,
        })
      : undefined;
    let worksceneCleanup:
      | ((sceneId: string, conversationIds: readonly string[]) => Promise<void>)
      | undefined;
    worksceneGlobalState = authorityLog
      ? new AnchorWorksceneGlobalStateAdapter({
          log: authorityLog,
          anchorEpoch,
          removeScene: (sceneId, conversationIds) => {
            if (!worksceneCleanup) {
              throw new Error("Workscene cleanup owner is not installed");
            }
            return worksceneCleanup(sceneId, conversationIds);
          },
          storageMaintenance: options.storageMaintenance,
          clock,
        })
      : undefined;
    skillGlobalState = authorityLog
      ? new AnchorSkillGlobalStateAdapter({
          log: authorityLog,
          anchorEpoch,
          clock,
        })
      : undefined;
    rubricGlobalState = authorityLog
      ? new AnchorRubricGlobalStateAdapter({
          log: authorityLog,
          artifacts,
          anchorEpoch,
          clock,
        })
      : undefined;
    await worksceneGlobalState?.initializeStagedPublishing();
    const refreshLocalExecutorSnapshot = async (
      permissionSnapshotHighWater?: number,
    ): Promise<{
      readonly snapshot: ExecutorCapabilitySnapshot;
      readonly deviceDigest: string;
    }> => {
      if (workspaceBindings) {
        await workspaceBindings.capabilitySnapshot();
        return publicationQueue.run(async () => {
          const refreshed = executorCapabilities.snapshotFor(executorId);
          if (
            !refreshed ||
            !latestLocalExecutorPublication ||
            latestLocalExecutorPublication.snapshot.descriptor.revision !==
              refreshed.descriptor.revision
          ) {
            throw new Error(
              "Workspace capability publication did not establish the local executor snapshot",
            );
          }
          return latestLocalExecutorPublication;
        });
      }
      return publicationQueue.run(async () =>
        publishLocalExecutorSnapshot(
          permissionSnapshotHighWater ??
            (await permissionSnapshots.highWater()),
        ),
      );
    };
    const currentExecutorSnapshot = async () =>
      (await refreshLocalExecutorSnapshot()).snapshot;
    const plannedAnchorReadinessSnapshot = async (): Promise<PlannedAnchorReadySnapshot> => {
      const assetSnapshot = await executionAssets.current().catch(() => undefined);
      const snapshot = isPlainRecord(options.configurationSnapshot)
        ? options.configurationSnapshot
        : {};
      return createProductionAnchorReadySnapshot({
        configurationSnapshot: options.configurationSnapshot,
        assetRevision: assetSnapshot?.digest ??
          protocolDigest("PlannedAnchorAssetRevision", 1, { state: "empty" }),
        credentialRevision: protocolDigest("PlannedAnchorCredentialRevision", 1, {
          generation: typeof snapshot.credentialGeneration === "string"
            ? snapshot.credentialGeneration
            : null,
          capabilities: plannedAnchorCapabilities(options.configurationSnapshot).capabilities,
        }),
        anchorEnabled,
        executorEnabled: localExecutorEnabled,
      });
    };
    const plannedAnchorReadiness = createPlannedAnchorReadinessCoordinator(
      plannedAnchorReadinessSnapshot,
    );
    const installPermissionSnapshot = async (
      snapshot: TrustRuleSnapshot,
    ): Promise<ExecutorCapabilitySnapshot> => {
      await permissionSnapshots.publish(snapshot);
      return currentExecutorSnapshot();
    };
    const installExecutionAssetBundle = async (
      bundle: ExecutionAssetBundle,
    ): Promise<ExecutorCapabilitySnapshot> => plannedAnchorReadiness.runRevisionChange(async () => {
      await executionAssets.installBundle(bundle);
      return currentExecutorSnapshot();
    });
    const acceptExecutorSnapshot = async (
      snapshot: ExecutorCapabilitySnapshot,
    ): Promise<void> => {
      const accepted = await executorCapabilities.accept(snapshot);
      if (!accepted.ok) {
        throw new Error(
          `Remote executor capability snapshot rejected: ${accepted.error.message}`,
        );
      }
    };
    const prepareConversationAssignment = async (input: {
      readonly conversationId: string;
      readonly executionProfile: RuntimeExecutionProfile;
      readonly permissionRules: readonly PermissionRule[];
      readonly environment?: ExplicitEnvironmentSelection;
      readonly recentExecutorId?: string;
      readonly targets?: readonly {
        readonly executorId: string;
        readonly deviceId: string;
      readonly synchronizePermission: (
        snapshot: TrustRuleSnapshot,
        executionAssets?: ExecutionAssetBundle,
      ) => Promise<ExecutorCapabilitySnapshot>;
      }[];
    }): Promise<PreparedConversationAssignmentAuthority> => {
      if (!anchorEnabled) {
        throw new Error("Anchor authority role is not enabled on this device");
      }
      const inputExecutionProfile = normalizeRuntimeExecutionProfile(
        input.executionProfile,
      );
      const parsedConversation = parseConversationId(input.conversationId);
      const worksceneRead =
        parsedConversation.scope.kind === "workscene" && worksceneGlobalState
          ? await worksceneGlobalState.read(
              {
                kind: "workscene-get",
                sceneId: parsedConversation.scope.sceneId,
              },
              {
                principal: {
                  kind: "host",
                  component: "conversation-assignment-owner",
                },
                requestId: `workscene-get:${input.conversationId}`,
                authority: { domain: "global", anchorEpoch },
                deadlineAt: new Date(Date.now() + 30_000).toISOString(),
              },
            )
          : undefined;
      const workscene =
        worksceneRead?.kind === "workscene-get"
          ? (worksceneRead.scene ?? undefined)
          : undefined;
      const environmentRequirement = deriveEnvironmentRequirement({
        ...(input.environment ? { explicit: input.environment } : {}),
        ...(workscene ? { workscene } : {}),
      });
      const executionProfile = executionProfileForEnvironment(
        inputExecutionProfile,
        environmentRequirement,
      );
      const permissionPublication = await permissionSnapshots.publishRules({
        rules: input.permissionRules,
        signer: key,
        generatedAt: canonicalTime(clock(), "Permission snapshot time"),
      });
      const prepareTarget = (
        target: ExecutorCapabilitySnapshot,
        deviceDigest: string,
        environment: EnvironmentRequirement,
      ): PreparedConversationAssignmentAuthority => {
        const requiredCredentialBindings = requiredBindingsForRuntime(
          executionProfile,
          target.descriptor.credentialBindings,
        );
        assertRuntimeAvailable(executionProfile, {
          tools: target.descriptor.tools,
          mcpServers: target.descriptor.mcpServers,
          credentialBindings: target.descriptor.credentialBindings,
          credentialGeneration: null,
        });
        const frozenEnvironment: EnvironmentRequirement = {
          ...environment,
          credentialBindings: requiredCredentialBindings.map(
            ({ service, bindingId }) => ({ service, bindingId }),
          ),
        };
        return {
          executorId: target.descriptor.executorId,
          policy: {
            credentialTtlMs: 24 * 60 * 60 * 1_000,
            manifestRequires: {
              ...target.inventory.configVersions,
              ...target.inventory.assetVersions,
            },
            manifestCapabilities: {
              protocolVersion: target.descriptor.protocolVersion,
              tools: executionProfile.tools,
              mcpServers: executionProfile.mcpServers,
              credentialBindings: requiredCredentialBindings,
            },
            permissionSnapshot: permissionPublication.snapshot,
            budget: { maxCalls: 64, maxTokens: 256_000 },
          },
          binding: { executionProfile, deviceDigest },
          environment: frozenEnvironment,
        };
      };
      const candidateErrors: Error[] = [];
      const candidates: Array<{
        snapshot: ExecutorCapabilitySnapshot;
        deviceId: string;
        deviceDigest: string;
      }> = [];
      for (const candidate of input.targets ?? []) {
        if (
          environmentRequirement.workspace &&
          candidate.deviceId !== environmentRequirement.workspace.deviceId
        ) {
          continue;
        }
        try {
          const synchronized = await candidate.synchronizePermission(
            permissionPublication.snapshot,
            await executionAssets.bundle(),
          );
          if (synchronized.descriptor.executorId !== candidate.executorId) {
            throw new TypeError(
              "Synchronized executor snapshot belongs to another executor",
            );
          }
          await acceptExecutorSnapshot(synchronized);
          const target = executorCapabilities.snapshotFor(candidate.executorId);
          if (!target)
            throw new Error(
              "Target executor capability snapshot is unavailable",
            );
          assertRuntimeAvailable(executionProfile, {
            tools: target.descriptor.tools,
            mcpServers: target.descriptor.mcpServers,
            credentialBindings: target.descriptor.credentialBindings,
            credentialGeneration: null,
          });
          candidates.push({
            snapshot: target,
            deviceId: candidate.deviceId,
            deviceDigest: protocolDigest("ExecutorRuntimeBinding", 1, target),
          });
        } catch (error) {
          candidateErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      if (
        localExecutorEnabled &&
        (!environmentRequirement.workspace ||
          environmentRequirement.workspace.deviceId === key.deviceId)
      ) {
        const publication = await refreshLocalExecutorSnapshot(
          permissionPublication.highWater,
        );
        const target = publication.snapshot;
        candidates.push({
          snapshot: target,
          deviceId: key.deviceId,
          deviceDigest: publication.deviceDigest,
        });
      }
      const selection = selectExecutorForEnvironment(
        environmentRequirement,
        candidates.map(({ snapshot, deviceId }) => ({
          executorId: snapshot.descriptor.executorId,
          deviceId,
          descriptor: snapshot.descriptor,
        })),
        input.recentExecutorId,
      );
      if (selection.kind === "queued") {
        throw new AggregateError(
          candidateErrors,
          `Conversation environment is queued: ${selection.reason}`,
        );
      }
      if (selection.kind === "selection-required") {
        throw new ExecutorSelectionRequiredError(selection.candidates);
      }
      const selected = candidates.find(
        ({ snapshot }) =>
          snapshot.descriptor.executorId === selection.executorId,
      );
      if (!selected) {
        throw new Error("Selected executor capability snapshot disappeared");
      }
      return prepareTarget(
        selected.snapshot,
        selected.deviceDigest,
        selection.environment,
      );
    };
    const prepareLocalConversationAssignment: AuthorityRuntimeStack["prepareLocalConversationAssignment"] =
      async (input) => {
        if (!localExecutorEnabled) {
          throw new Error("Local executor role is not enabled on this device");
        }
        const permissionSnapshot = await permissionSnapshots.latest();
        if (!permissionSnapshot) {
          throw new SchedulerCapabilityGapError(
            "Local conversation is waiting for a synchronized permission snapshot",
            1,
          );
        }
        const requestedRules = normalizeTrustRulesForSnapshot(input.permissionRules);
        const cachedRules = normalizeTrustRulesForSnapshot(permissionSnapshot.rules);
        if (canonicalize(requestedRules) !== canonicalize(cachedRules)) {
          throw new SchedulerCapabilityGapError(
            "Local conversation permissions are not present in the synchronized cache",
            permissionSnapshot.snapshotVersion,
          );
        }
        const environment = deriveEnvironmentRequirement({
          ...(input.environment ? { explicit: input.environment } : {}),
        });
        if (
          environment.workspace &&
          environment.workspace.deviceId !== key.deviceId
        ) {
          throw new TypeError(
            "Local conversation workspace must belong to its birth device",
          );
        }
        const executionProfile = executionProfileForEnvironment(
          normalizeRuntimeExecutionProfile(input.executionProfile),
          environment,
        );
        const publication = await refreshLocalExecutorSnapshot();
        const target = publication.snapshot;
        assertRuntimeAvailable(executionProfile, {
          tools: target.descriptor.tools,
          mcpServers: target.descriptor.mcpServers,
          credentialBindings: target.descriptor.credentialBindings,
          credentialGeneration: null,
        });
        const credentialBindings = requiredBindingsForRuntime(
          executionProfile,
          target.descriptor.credentialBindings,
        );
        const frozenWorkspace = environment.workspace
          ? target.descriptor.workspaces.find(
              (workspace) =>
                workspace.bindingRef === environment.workspace!.bindingRef &&
                target.descriptor.signature.keyId === environment.workspace!.deviceId,
            )
          : undefined;
        if (environment.workspace && !frozenWorkspace) {
          throw new SchedulerCapabilityGapError(
            "Local conversation workspace binding is not present in the synchronized executor snapshot",
            permissionSnapshot.snapshotVersion,
          );
        }
        const frozenEnvironment: EnvironmentRequirement = {
          ...(environment.deviceId === undefined
            ? {}
            : { deviceId: environment.deviceId }),
          ...(environment.evidenceKinds === undefined
            ? {}
            : { evidenceKinds: environment.evidenceKinds }),
          ...(environment.workspace
            ? {
                workspace: {
                  deviceId: environment.workspace!.deviceId,
                  bindingRef: frozenWorkspace!.bindingRef,
                  workspaceBindingRevision:
                    frozenWorkspace!.workspaceBindingRevision,
                },
              }
            : {}),
          credentialBindings: credentialBindings.map(
            ({ service, bindingId }) => ({ service, bindingId }),
          ),
        };
        return {
          executorId,
          policy: {
            credentialTtlMs: 24 * 60 * 60 * 1_000,
            manifestRequires: {
              ...target.inventory.configVersions,
              ...target.inventory.assetVersions,
            },
            manifestCapabilities: {
              protocolVersion: target.descriptor.protocolVersion,
              tools: executionProfile.tools,
              mcpServers: executionProfile.mcpServers,
              credentialBindings,
            },
            permissionSnapshot,
            budget: { maxCalls: 64, maxTokens: 256_000 },
          },
          binding: {
            executionProfile,
            deviceDigest: publication.deviceDigest,
          },
          environment: frozenEnvironment,
        };
      };
    const prepareJobAssignment: AuthorityRuntimeStack["prepareJobAssignment"] = async (
      input,
    ) => {
      if (!anchorEnabled) {
        throw new Error("Anchor authority role is not enabled on this device");
      }
      const requestedTools = input.instruction.tools
        ? [...new Set(input.instruction.tools)].sort()
        : [...new Set(input.capabilities.tools)].sort();
      const requestedMcpServers = [...new Set(input.capabilities.mcpServers)].sort();
      const permissionPublication = await permissionSnapshots.publishRules({
        rules: [],
        signer: key,
        generatedAt: canonicalTime(clock(), "Permission snapshot time"),
      });
      const candidates: ExecutorCapabilitySnapshot[] = [];
      for (const candidate of input.targets ?? []) {
        try {
          const synchronized = await candidate.synchronizePermission(
            permissionPublication.snapshot,
            await executionAssets.bundle(),
          );
          if (synchronized.descriptor.executorId !== candidate.executorId) {
            throw new TypeError(
              "Synchronized executor snapshot belongs to another executor",
            );
          }
          await acceptExecutorSnapshot(synchronized);
          const accepted = executorCapabilities.snapshotFor(candidate.executorId);
          if (accepted) candidates.push(accepted);
        } catch {
          // A disappearing remote candidate is a recoverable capability gap;
          // another compatible executor may still accept this occurrence.
        }
      }
      if (localExecutorEnabled) {
        candidates.push(
          (await refreshLocalExecutorSnapshot(permissionPublication.highWater))
            .snapshot,
        );
      }
      const selected = candidates
        .filter((candidate) =>
          requestedTools.every((tool) => candidate.descriptor.tools.includes(tool)) &&
          requestedMcpServers.every((server) =>
            candidate.descriptor.mcpServers.includes(server),
          ),
        )
        .sort((left, right) =>
          Number(right.descriptor.executorId === executorId) -
            Number(left.descriptor.executorId === executorId) ||
          left.descriptor.executorId.localeCompare(right.descriptor.executorId),
        )[0];
      if (!selected) {
        throw new SchedulerCapabilityGapError(
          "Scheduled job is queued because no compatible executor is available",
          Math.max(
            1,
            ...candidates.map((candidate) => candidate.inventory.capabilityRevision),
          ),
        );
      }
      const credentialBindings = selected.descriptor.credentialBindings
        .map((binding) => ({
          service: binding.service,
          bindingId: binding.bindingId,
          revision: binding.revision,
        }))
        .sort((left, right) =>
          left.service.localeCompare(right.service) ||
          left.bindingId.localeCompare(right.bindingId),
        );
      return {
        executorId: selected.descriptor.executorId,
        policy: {
          credentialTtlMs: 24 * 60 * 60 * 1_000,
          manifestRequires: {
            ...selected.inventory.configVersions,
            ...selected.inventory.assetVersions,
          },
          manifestCapabilities: {
            protocolVersion: selected.descriptor.protocolVersion,
            tools: requestedTools,
            mcpServers: requestedMcpServers,
            credentialBindings,
          },
          permissionSnapshot: permissionPublication.snapshot,
          budget: { maxCalls: 64, maxTokens: 256_000 },
        },
        environment: {
          credentialBindings: credentialBindings.map(
            ({ service, bindingId }) => ({ service, bindingId }),
          ),
        },
      };
    };
    const performLocalConversationEnvironmentPreflight = async (
      manifest: ExecutionManifest<"conversation">,
    ): Promise<{
      readonly workspaceRoot: string | null;
      readonly error?: AuthorityError;
    }> => {
      if (!workspaceBindings) {
        return manifest.environment.workspace
          ? {
              workspaceRoot: null,
              error: {
                code: "capability-gap",
                message: "Local workspace environment is unavailable",
                retryable: true,
              },
            }
          : { workspaceRoot: null };
      }
      const result = await preflightWorkspaceRequirement(
        workspaceBindings,
        manifest.environment,
      );
      if (result.ok) {
        if (result.state === "missing" && result.absolutePath) {
          try {
            await fsp.mkdir(result.absolutePath, { recursive: true });
            if (
              (await workspaceBindings.probePath(result.absolutePath)) !==
              "directory"
            ) {
              throw new Error("created workspace did not become a directory");
            }
          } catch (error) {
            return {
              workspaceRoot: null,
              error: {
                code: "capability-gap",
                message: `Workspace creation failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                retryable: true,
              },
            };
          }
        }
        return { workspaceRoot: result.absolutePath ?? null };
      }
      return {
        workspaceRoot: null,
        error: {
          code:
            result.reason === "revision-conflict"
              ? "revision-conflict"
              : "capability-gap",
          message: `Workspace execution preflight failed: ${result.reason}`,
          retryable: true,
        },
      };
    };
    const environmentPreflights = new Map<
      string,
      {
        readonly promise: Promise<{
          readonly workspaceRoot: string | null;
          readonly error?: AuthorityError;
        }>;
        claimed: boolean;
      }
    >();
    const createEnvironmentPreflight = (
      key: string,
      manifest: ExecutionManifest<"conversation">,
      claimed: boolean,
    ): {
      readonly promise: Promise<{
        readonly workspaceRoot: string | null;
        readonly error?: AuthorityError;
      }>;
      claimed: boolean;
    } => {
      let promise!: Promise<{
        readonly workspaceRoot: string | null;
        readonly error?: AuthorityError;
      }>;
      promise = performLocalConversationEnvironmentPreflight(manifest).then(
        (result) => {
          if (
            result.error &&
            environmentPreflights.get(key)?.promise === promise
          ) {
            environmentPreflights.delete(key);
          }
          return result;
        },
        (error) => {
          if (environmentPreflights.get(key)?.promise === promise) {
            environmentPreflights.delete(key);
          }
          throw error;
        },
      );
      const entry = { promise, claimed };
      environmentPreflights.set(key, entry);
      return entry;
    };
    const preflightLocalConversationEnvironment = (
      manifest: ExecutionManifest<"conversation">,
      assignmentId?: string,
    ): Promise<{
      readonly workspaceRoot: string | null;
      readonly error?: AuthorityError;
    }> => {
      if (assignmentId === undefined) {
        return performLocalConversationEnvironmentPreflight(manifest);
      }
      const key = `${assignmentId}\u0000${manifest.digest}`;
      const existing = environmentPreflights.get(key);
      if (existing) return existing.promise;
      const entry = createEnvironmentPreflight(key, manifest, false);
      return entry.promise;
    };
    const takeLocalConversationEnvironmentPreflight = async (
      manifest: ExecutionManifest<"conversation">,
      assignmentId: string,
    ): Promise<{
      readonly workspaceRoot: string | null;
      readonly error?: AuthorityError;
    }> => {
      const key = `${assignmentId}\u0000${manifest.digest}`;
      let entry = environmentPreflights.get(key);
      if (!entry) {
        entry = createEnvironmentPreflight(key, manifest, true);
      } else {
        if (entry.claimed) {
          throw new Error(
            "Local conversation environment preflight was already claimed",
          );
        }
        entry.claimed = true;
      }
      return entry.promise;
    };
    const releaseLocalConversationEnvironmentPreflight = (
      manifest: ExecutionManifest<"conversation">,
      assignmentId: string,
    ): void => {
      environmentPreflights.delete(`${assignmentId}\u0000${manifest.digest}`);
    };
    const validateConversationRuntimeBinding = async (input: {
      readonly assignmentId: string;
      readonly manifest: ExecutionManifest<"conversation">;
      readonly binding: ConversationRuntimeBinding;
    }): Promise<AuthorityError | undefined> => {
      try {
        const profile = normalizeRuntimeExecutionProfile(
          input.binding.executionProfile,
        );
        const readiness = readinessSource();
        assertRuntimeAvailable(profile, readiness);
        if (input.binding.deviceDigest !== deviceDigestFor(readiness)) {
          return {
            code: "revision-conflict",
            message:
              "Executor device generation changed before durable receipt",
            retryable: true,
          };
        }
        const versionedBindings = readiness.credentialBindings.map(
          (binding) => ({
            ...binding,
            revision: input.manifest.requires.runtimeConfigRev,
          }),
        );
        const expectedBindings = requiredBindingsForRuntime(
          profile,
          versionedBindings,
        );
        if (
          canonicalize(input.manifest.tools) !== canonicalize(profile.tools) ||
          canonicalize(input.manifest.mcpServers) !==
            canonicalize(profile.mcpServers) ||
          canonicalize(input.manifest.credentialBindings) !==
            canonicalize(expectedBindings)
        ) {
          return {
            code: "revision-conflict",
            message: "Execution manifest does not bind the assembled runtime",
            retryable: true,
          };
        }
        return (
          await preflightLocalConversationEnvironment(
            input.manifest,
            input.assignmentId,
          )
        ).error;
      } catch (error) {
        return {
          code: "capability-gap",
          message:
            error instanceof Error
              ? error.message
              : "Runtime readiness is unavailable",
          retryable: true,
        };
      }
    };
    const validateLocalConversationManifest = (
      manifest: ExecutionManifest<"conversation">,
    ): AuthorityError | undefined => {
      if (!localExecutorEnabled) {
        return {
          code: "capability-gap",
          message: "Local executor role is not enabled on this device",
          retryable: true,
        };
      }
      const snapshot = executorCapabilities.snapshotFor(executorId);
      if (!snapshot) {
        return {
          code: "capability-gap",
          message: "Local executor capability snapshot is unavailable",
          retryable: true,
        };
      }
      const result = matchManifest(
        manifest,
        snapshot.descriptor,
        snapshot.inventory,
      );
      return result.ok ? undefined : result.error;
    };
    const routedGlobalState = worksceneGlobalState && skillGlobalState && rubricGlobalState
      ? createGlobalStateRouter(
          () => worksceneGlobalState!,
          () => skillGlobalState!,
          () => schedulerGlobalState,
          () => rubricGlobalState!,
        )
      : undefined;
    const rebindInstalledAuthority = async (
      generation: InstalledAuthorityGeneration,
    ): Promise<InstalledAuthorityGenerationReceipt> => {
      if (!authorityLog || !ownerRuntime || !anchorEnabled || !routedGlobalState) {
        throw new Error("Installed authority generation requires the anchor runtime");
      }
      if (
        installedAuthorityGeneration &&
        canonicalize(installedAuthorityGeneration) === canonicalize(generation)
      ) {
        return Object.freeze({
          generation: installedAuthorityGeneration,
          participants: INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS,
        });
      }
      if (
        !Number.isSafeInteger(generation.anchorEpoch) ||
        generation.anchorEpoch <= anchorEpoch ||
        generation.trustEpoch <= 0 ||
        generation.installLsn <= 0
      ) {
        throw new Error("Installed authority generation is stale or invalid");
      }
      const targetOrigin = await authorityLog.originCheckpoint();
      if (targetOrigin.logId !== generation.targetLogId) {
        throw new Error("Installed authority generation targets another authority log");
      }

      await worksceneGlobalState?.stop();

      const nextAuthority = new DeliveryAuthority({
        log: authorityLog,
        anchorEpoch: generation.anchorEpoch,
      });
      const nextParticipant = createOwnerDeliveryParticipant({
        authority: nextAuthority,
      });
      const nextControlAdmission = new ownerRuntime.ControlAdmissionJournal(
        authorityLog,
        artifacts,
      );
      const nextSurfaceAssetOptions = {
        authorityRoot,
        log: authorityLog,
        retentionLogs: [authorityLog, ...(executorLog ? [executorLog] : [])],
        artifacts,
        signer: key,
        verifier,
        anchorEpoch: generation.anchorEpoch,
        storageMaintenance: options.storageMaintenance,
        clock,
      } satisfies Parameters<typeof createSurfaceAssetAuthority>[0];
      const nextResourceGovernor = new ownerRuntime.AnchorResourceGovernor({
        log: authorityLog,
        signer: key,
        verifier,
        guard: resourceGuard,
        anchorEpoch: generation.anchorEpoch,
        localExecutorId: executorId,
        reporterKeyFor: (candidateExecutorId) =>
          executorCapabilities.snapshotFor(candidateExecutorId)?.descriptor
            .signature.keyId,
        ...(options.resourceCandidateTtlMs === undefined
          ? {}
          : { candidateTtlMs: options.resourceCandidateTtlMs }),
        clock,
      });
      const nextWorkscene = new AnchorWorksceneGlobalStateAdapter({
        log: authorityLog,
        anchorEpoch: generation.anchorEpoch,
        removeScene: (sceneId, conversationIds) => {
          if (!worksceneCleanup) {
            throw new Error("Workscene cleanup owner is not installed");
          }
          return worksceneCleanup(sceneId, conversationIds);
        },
        storageMaintenance: options.storageMaintenance,
        clock,
      });
      const nextSkill = new AnchorSkillGlobalStateAdapter({
        log: authorityLog,
        anchorEpoch: generation.anchorEpoch,
        clock,
      });
      const nextRubric = new AnchorRubricGlobalStateAdapter({
        log: authorityLog,
        artifacts,
        anchorEpoch: generation.anchorEpoch,
        clock,
      });

      try {
        await nextWorkscene.initializeStagedPublishing();
      } catch (error) {
        nextWorkscene.stop();
        throw error;
      }

      const nextGlobalState = createGlobalStateRouter(
        () => nextWorkscene,
        () => nextSkill,
        () => undefined,
        () => nextRubric,
      );
      try {
        await executionAssets.publishFromAuthority({
          state: nextGlobalState,
          anchorEpoch: generation.anchorEpoch,
          signer: key,
          generatedAt: canonicalTime(clock(), "Execution asset snapshot time"),
        });
      } catch (error) {
        nextWorkscene.stop();
        throw error;
      }

      const nextSurfaceAssets = await runInMaintenanceContext(
        "recovery",
        () => rebindSurfaceAssetAuthority(surfaceAssets!, nextSurfaceAssetOptions),
      );

      authority = nextAuthority;
      participant = nextParticipant;
      deliveryLifecycle = createOwnerDeliveryLifecycleBinding({ authority: nextAuthority });
      controlAdmission = nextControlAdmission;
      surfaceAssets = nextSurfaceAssets;
      resourceGovernor = nextResourceGovernor;
      worksceneGlobalState = nextWorkscene;
      skillGlobalState = nextSkill;
      rubricGlobalState = nextRubric;
      schedulerGlobalState = undefined;
      anchorEpoch = generation.anchorEpoch;
      installedAuthorityGeneration = Object.freeze(structuredClone(generation));
      return Object.freeze({
        generation: installedAuthorityGeneration,
        participants: INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS,
      });
    };
    if (routedGlobalState) {
      await executionAssets
        .publishFromAuthority({
          state: routedGlobalState,
          anchorEpoch,
          signer: key,
          generatedAt: canonicalTime(clock(), "Execution asset snapshot time"),
        })
        .catch(() => undefined);
      if (localExecutorEnabled) await refreshLocalExecutorSnapshot();
    }
    return {
      get anchorEpoch() {
        return anchorEpoch;
      },
      localDomainId,
      localOwnerEpoch,
      localGovernorEpoch,
      deviceId: key.deviceId,
      identityKey: key,
      identity,
      executorId,
      localExecutorEnabled,
      signer: key,
      verifier,
      get authority() {
        if (!authority) throw new Error("Anchor authority role is not enabled");
        return authority;
      },
      get deliveryLifecycle() {
        return deliveryLifecycle;
      },
      get authorityLog() {
        if (!authorityLog)
          throw new Error("Anchor authority role is not enabled");
        return authorityLog;
      },
      get executorLog() {
        if (!executorLog) throw new Error("Local executor role is not enabled");
        return executorLog;
      },
      artifacts,
      storageMaintenance: options.storageMaintenance,
      get surfaceAssets() {
        if (!surfaceAssets)
          throw new Error("Anchor authority role is not enabled");
        return surfaceAssets;
      },
      get checkpointRetention() {
        if (!surfaceAssets)
          throw new Error("Anchor authority role is not enabled");
        return surfaceAssets.checkpointRetention;
      },
      get participant() {
        if (!participant)
          throw new Error("Anchor authority role is not enabled");
        return participant;
      },
      get controlAdmission() {
        if (!controlAdmission)
          throw new Error("Anchor authority role is not enabled");
        return controlAdmission;
      },
      get localControlAdmission() {
        if (!localControlAdmission)
          throw new Error("Local executor role is not enabled");
        return localControlAdmission;
      },
      executorCapabilities,
      get resourceGovernor() {
        if (!resourceGovernor)
          throw new Error("Anchor authority role is not enabled");
        return resourceGovernor;
      },
      get executorResourceGovernor() {
        if (!executorResourceGovernor) {
          throw new Error("Local executor role is not enabled");
        }
        return executorResourceGovernor;
      },
      environment: workspaceBindings,
      workspaceBindingAdmin: workspaceBindings,
      workspaceBindingMigration: workspaceBindings,
      workspaceBindingRecovery: workspaceBindings,
      workspaceProbe,
      environmentProbeOwner,
      globalState: routedGlobalState,
      get rubricGlobalState() {
        return rubricGlobalState;
      },
      get globalMutationParticipants() {
        return worksceneGlobalState && skillGlobalState
          ? [worksceneGlobalState, skillGlobalState]
          : [];
      },
      installSchedulerGlobalState: (state) => {
        if (schedulerGlobalState) {
          throw new Error("Scheduler global state owner is already installed");
        }
        schedulerGlobalState = state;
      },
      rebindInstalledAuthority,
      recoverWorksceneState: async () => {
        await worksceneGlobalState?.recoverPendingDeletions();
      },
      replayWorksceneMutation: (requestId) =>
        worksceneGlobalState?.replayMutation(requestId) ?? Promise.resolve(null),
      installWorksceneCleanup: (cleanup) => {
        if (worksceneCleanup) {
          throw new Error("Workscene cleanup owner is already installed");
        }
        worksceneCleanup = cleanup;
      },
      workspaceCatalog: () =>
        executorCapabilities
          .activeSnapshots()
          .flatMap((snapshot) => {
            const deviceId = snapshot.descriptor.signature.keyId;
            const deviceName =
              trustedIdentities.get(deviceId)?.displayName ?? deviceId;
            return snapshot.descriptor.workspaces.map((workspace) => ({
              executorId: snapshot.descriptor.executorId,
              deviceId,
              deviceName,
              bindingRef: workspace.bindingRef,
              displayName: workspace.displayName,
              workspaceBindingRevision: workspace.workspaceBindingRevision,
            }));
          })
          .sort(
            (left, right) =>
              left.deviceName.localeCompare(right.deviceName) ||
              left.displayName.localeCompare(right.displayName) ||
              left.bindingRef.localeCompare(right.bindingRef),
          ),
      permissionSnapshotFor: (digest) =>
        permissionSnapshots.snapshotFor(digest),
      latestPermissionSnapshot: () => permissionSnapshots.latest(),
      executionAssetCatalog: executionAssets,
      currentExecutionAssetBundle: () => executionAssets.bundle(),
      plannedAnchorReadiness: plannedAnchorReadiness.port,
      installExecutionAssetBundle,
      currentExecutorSnapshot,
      installPermissionSnapshot,
      acceptExecutorSnapshot,
      reconcileTrustedDevices: (identities, deviceIds) => {
        for (const candidate of identities) {
          if (
            deviceIdFromPublicKey(candidate.publicKey) !== candidate.deviceId
          ) {
            throw new TypeError(
              "Trusted device identity does not match its public key",
            );
          }
          const existing = trustedIdentities.get(candidate.deviceId);
          if (existing && canonicalize(existing) !== canonicalize(candidate)) {
            throw new TypeError(
              "Trusted device identity changed for an existing device id",
            );
          }
          trustedIdentities.set(candidate.deviceId, candidate);
        }
        authorizedDeviceIds.clear();
        authorizedDeviceIds.add(identity.deviceId);
        for (const deviceId of deviceIds) authorizedDeviceIds.add(deviceId);
      },
      prepareConversationAssignment,
      prepareLocalConversationAssignment,
      prepareJobAssignment,
      validateConversationRuntimeBinding,
      preflightLocalConversationEnvironment,
      takeLocalConversationEnvironmentPreflight,
      releaseLocalConversationEnvironmentPreflight,
      validateLocalConversationManifest,
      startupCleanup,
      stopStorageMaintenance,
    };
  } catch (error) {
    // 失败即执行同一幂等 handle;handle 缓存执行结果,外层回滚事务再跑它只会
    // 复用同一次。原始失败优先上抛,清理自身的失败经外层回滚事务可观测。
    await startupCleanup.run().catch(() => undefined);
    throw error;
  }
}

function plannedAnchorCapabilities(input: unknown): {
  readonly executableVersion: string;
  readonly capabilities: {
    readonly providers: readonly string[];
    readonly mcpServers: readonly string[];
    readonly channels: readonly string[];
  };
} {
  const snapshot = isPlainRecord(input) ? input : {};
  const config = isPlainRecord(snapshot.config) ? snapshot.config : {};
  const llm = isPlainRecord(config.llm) ? config.llm : {};
  const providers = ["main", "light", "power"]
    .flatMap((role) => {
      const value = isPlainRecord(llm[role]) ? llm[role] : undefined;
      return typeof value?.provider === "string" ? [value.provider] : [];
    });
  const mcp = isPlainRecord(config.mcp) ? config.mcp : {};
  const servers = isPlainRecord(mcp.servers) ? Object.keys(mcp.servers) : [];
  const messaging = isPlainRecord(config.messaging) ? Object.keys(config.messaging) : [];
  return {
    executableVersion:
      typeof snapshot.executableVersion === "string"
        ? snapshot.executableVersion
        : "unknown",
    capabilities: {
      providers: canonicalIdentifiers(providers),
      mcpServers: canonicalIdentifiers(servers),
      channels: canonicalIdentifiers(messaging),
    },
  };
}

function canonicalIdentifiers(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) =>
    compareCanonicalStrings(left, right));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface NormalizedExecutorReadiness {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly credentialBindings: readonly Omit<
    CredentialBindingDescriptor,
    "revision"
  >[];
  readonly credentialGeneration: string | null;
}

function createGlobalStateRouter(
  workscene: () => GlobalStatePort,
  skills: () => GlobalStatePort,
  scheduler: () => GlobalStatePort | undefined,
  rubrics: () => GlobalStatePort,
): GlobalStatePort {
  const routeMutation = (
    mutation: Parameters<GlobalStatePort["mutate"]>[0],
  ): GlobalStatePort => {
    if (mutation.kind.startsWith("rubric-")) return rubrics();
    if (mutation.kind.startsWith("skill-")) return skills();
    if (!mutation.kind.startsWith("schedule-")) return workscene();
    const owner = scheduler();
    if (!owner) {
      throw new Error("Scheduler authority is not ready");
    }
    return owner;
  };
  return {
    read: (query, context) => {
      if (query.kind === "asset-index" && query.asset === "rubrics") {
        return rubrics().read(query, context);
      }
      if (
        query.kind === "skill-catalog" ||
        query.kind === "skill-get" ||
        (query.kind === "asset-index" && query.asset === "skills")
      ) {
        return skills().read(query, context);
      }
      if (query.kind !== "schedule-list") {
        return workscene().read(query, context);
      }
      const owner = scheduler();
      if (!owner) {
        throw new Error("Scheduler authority is not ready");
      }
      return owner.read(query, context);
    },
    mutate: ((
      mutation:
        | import("@zhixing/core/contracts").GlobalControlMutation
        | import("@zhixing/core/contracts").GlobalStagedMutation,
      context: import("@zhixing/core/contracts").AuthorityCallContext,
    ) =>
      routeMutation(mutation).mutate(
        mutation,
        context,
      )) as GlobalStatePort["mutate"],
  };
}

function normalizeExecutorReadiness(
  input: ExecutorReadiness,
  deviceId: string,
): NormalizedExecutorReadiness {
  const tools = normalizeIdentifiers(input.tools, "Executor tools");
  const mcpServers = normalizeIdentifiers(
    input.mcpServers,
    "Executor MCP servers",
  );
  const deviceScopedBindingIds = new Set(
    input.deviceScopedCredentialBindingIds,
  );
  const logicalBindingIds = new Set<string>();
  const credentialBindings = input.credentialBindings
    .map((binding) => {
      requireIdentifier(binding.bindingId, "Executor credential binding id");
      requireIdentifier(binding.service, "Executor credential service");
      if (logicalBindingIds.has(binding.bindingId)) {
        throw new TypeError("Executor credential binding ids must be unique");
      }
      logicalBindingIds.add(binding.bindingId);
      const deviceScoped = deviceScopedBindingIds.delete(binding.bindingId);
      if (deviceScoped && binding.verification !== "user-alias") {
        throw new TypeError(
          "Only user-alias credential bindings can be device-scoped",
        );
      }
      return {
        bindingId: deviceScoped
          ? deviceScopedUserAliasBindingId(deviceId, binding.bindingId)
          : binding.bindingId,
        service: binding.service,
        verification: binding.verification,
        ...(binding.resource === undefined
          ? {}
          : { resource: binding.resource }),
        ...(binding.principalFingerprint === undefined
          ? {}
          : { principalFingerprint: binding.principalFingerprint }),
        ...(binding.tenant === undefined ? {} : { tenant: binding.tenant }),
        ...(binding.scopes === undefined
          ? {}
          : { scopes: [...binding.scopes] }),
      } satisfies Omit<CredentialBindingDescriptor, "revision">;
    })
    .sort((left, right) =>
      compareCanonicalStrings(left.bindingId, right.bindingId),
    );
  if (deviceScopedBindingIds.size > 0) {
    throw new TypeError(
      "Device-scoped executor credential binding is not published",
    );
  }
  if (
    input.credentialGeneration !== null &&
    (typeof input.credentialGeneration !== "string" ||
      input.credentialGeneration.length === 0)
  ) {
    throw new TypeError("Executor credential generation is invalid");
  }
  return {
    tools,
    mcpServers,
    credentialBindings,
    credentialGeneration: input.credentialGeneration,
  };
}

function normalizeRuntimeExecutionProfile(
  input: RuntimeExecutionProfile,
): RuntimeExecutionProfile {
  return {
    tools: normalizeIdentifiers(input.tools, "Runtime tools"),
    mcpServers: normalizeIdentifiers(input.mcpServers, "Runtime MCP servers"),
    providerIds: normalizeIdentifiers(input.providerIds, "Runtime providers"),
  };
}

function assertRuntimeAvailable(
  profile: RuntimeExecutionProfile,
  readiness: NormalizedExecutorReadiness,
): void {
  const tools = new Set(readiness.tools);
  const mcpServers = new Set(readiness.mcpServers);
  if (profile.tools.some((tool) => !tools.has(tool))) {
    throw new Error("Assembled runtime requires an unavailable tool");
  }
  if (profile.mcpServers.some((server) => !mcpServers.has(server))) {
    throw new Error("Assembled runtime requires an unavailable MCP server");
  }
}

function requiredBindingsForRuntime(
  profile: RuntimeExecutionProfile,
  available: readonly CredentialBindingDescriptor[],
): Array<{
  readonly service: string;
  readonly bindingId: string;
  readonly revision: number;
}> {
  const byService = new Map<string, CredentialBindingDescriptor>();
  for (const binding of available) {
    if (byService.has(binding.service)) {
      throw new TypeError(
        `Executor publishes multiple bindings for service ${binding.service}`,
      );
    }
    byService.set(binding.service, binding);
  }
  const required: CredentialBindingDescriptor[] = [];
  for (const providerId of profile.providerIds) {
    const binding = byService.get(`provider-${providerId}`);
    if (binding === undefined) {
      throw new Error(
        `Resolved provider credential is not ready: ${providerId}`,
      );
    }
    required.push(binding);
  }
  for (const serverId of profile.mcpServers) {
    const binding = byService.get(`mcp-${serverId}`);
    if (binding !== undefined) required.push(binding);
  }
  return required
    .map(({ service, bindingId, revision }) => ({
      service,
      bindingId,
      revision,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(
        `${left.service}\u0000${left.bindingId}`,
        `${right.service}\u0000${right.bindingId}`,
      ),
    );
}

function normalizeIdentifiers(
  values: readonly string[],
  label: string,
): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    requireIdentifier(value, label);
    normalized.add(value);
  }
  return [...normalized].sort(compareCanonicalStrings);
}

function requireIdentifier(value: string, label: string): void {
  if (!value || value.length > 480 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} contains an invalid identifier`);
  }
}

function canonicalTime(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function deviceScopedUserAliasBindingId(
  deviceId: string,
  logicalBindingId: string,
): string {
  const bindingId = `user-alias:${deviceId}:${logicalBindingId}`;
  if (bindingId.length > 480) {
    throw new TypeError("Device-scoped credential binding id is too long");
  }
  return bindingId;
}

export async function setupDelivery(
  options: SetupDeliveryOptions,
): Promise<DeliveryStack> {
  const { channels, logger } = options;
  const { createDeliveryResolutionCorrectnessPort } =
    await import("@zhixing/owner-kernel/delivery");

  // Delivery owns the effect contract; this concrete binding only combines
  // Channel readiness/send evidence with the shared per-target Outbox.
  const channelDelivery = createChannelDeliveryEffect(channels, {
      onEvent: options.onOutboxEvent,
      logger: {
        debug: logger.debug,
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
        error: (msg) => logger.error(msg),
      },
    });
  const { outboxRegistry } = channelDelivery;
  const statusListeners = new Set<
    (notice: DeliveryStatusNotice) => void | Promise<void>
  >();
  let authorityDelivery: AuthorityDeliveryPipeline | undefined;
  let activated = false;
  const startupRollback = options.startupRollback ?? new StartupRollback();
  const startupCleanup = startupRollback.register(
    "deliveryStack.stop",
    async () => {
      statusListeners.clear();
      await authorityDelivery?.stop();
      await outboxRegistry.dispose();
    },
  );

  try {
    const { artifacts, authorityLog } = options.authorityRuntime;

    const transports = new DeliveryTransportRegistry();
    transports.register(channelDelivery.transport);
    const eventBus = createEventBus<AuthorityDeliveryEventMap>();
    const publishNotice = async (notice: DeliveryStatusNotice) => {
      await Promise.allSettled(
        [...statusListeners].map(async (listener) => listener(notice)),
      );
    };
    eventBus.on("delivery:notice", ({ notice }) => publishNotice(notice));
    const resolutionApplication = new DeliveryUncertainResolutionApplicationService(
      createDeliveryResolutionCorrectnessPort({
        admission: options.authorityRuntime.controlAdmission,
        authority: options.authorityRuntime.authority,
        onResolved: (notice) => eventBus.emit("delivery:notice", { notice }),
      }),
    );
    const deliveryLifecycle = () => {
      const binding = options.authorityRuntime.deliveryLifecycle;
      if (!binding) {
        throw new Error("Delivery lifecycle application is unavailable without the Anchor role");
      }
      return binding;
    };

    // 权威 Pipeline 只消费已提交事实；conversation 生产入口在 owner commit。
    const buildAuthorityDelivery = async () => {
      const pipeline = new AuthorityDeliveryPipeline({
        application: deliveryLifecycle().application,
        projection: deliveryLifecycle().projection,
        artifacts,
        transport: transports,
        eventBus,
        config: {
          ...DEFAULT_AUTHORITY_DELIVERY_CONFIG,
        },
        logger: {
          debug: () => {},
          info: (msg: string) => logger.info(`[delivery] ${msg}`),
          warn: (msg: string) => logger.warn(`[delivery] ${msg}`),
          error: (msg: string) => logger.error(`[delivery] ${msg}`),
        },
      });
      try {
        await pipeline.prepare();
      } catch (error) {
        await pipeline.stop().catch(() => undefined);
        throw error;
      }
      if (activated) pipeline.activate();
      return pipeline;
    };
    authorityDelivery = await buildAuthorityDelivery();

    return {
      get authorityDelivery() {
        return authorityDelivery!;
      },
      activate: () => {
        authorityDelivery!.activate();
        activated = true;
      },
      stats: () => authorityDelivery!.stats(),
      lifecycle: Object.freeze({
        capture: () => deliveryLifecycle().application.captureAcceptedWork(),
        install: (input) => deliveryLifecycle().application.installAdmission(input),
        restore: (input) => deliveryLifecycle().application.restoreAdmission(input),
        seal: (operationId) => deliveryLifecycle().application.sealAdmission(operationId),
        release: (operationId) => deliveryLifecycle().application.releaseAdmission(operationId),
        read: (operationId) => deliveryLifecycle().application.acceptedWorkItems(operationId),
        close: () => deliveryLifecycle().application.closeAdmission(authorityDelivery!),
        settle: (input) => deliveryLifecycle().application.settleAcceptedWork({
          ...input,
          effects: authorityDelivery!,
        }),
        resume: () => deliveryLifecycle().application.resume(authorityDelivery!),
      } satisfies DeliveryAcceptedWorkLifecyclePort),
      flush: async () => {
        await authorityDelivery!.flush();
      },
      quiesceForAuthorityTransfer: () =>
        authorityDelivery!.quiesceForAuthorityTransfer(),
      resumeAfterAuthorityTransfer: () =>
        authorityDelivery!.resumeAfterAuthorityTransfer(),
      recoverInstalledAuthority: async () => {
        const previous = authorityDelivery!;
        const replacement = await buildAuthorityDelivery();
        authorityDelivery = replacement;
        await previous.stop();
      },
      get authority() {
        return options.authorityRuntime.authority;
      },
      authorityLog,
      artifacts,
      get participant() {
        return options.authorityRuntime.participant;
      },
      get controlAdmission() {
        return options.authorityRuntime.controlAdmission;
      },
      outboxRegistry,
      statusHistory: (afterByItem = {}) =>
        options.authorityRuntime.authority.statusNotices(afterByItem),
      onStatus: (listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      resolutionApplication,
      startupCleanup,
      stop: () => startupCleanup.run(),
    };
  } catch (error) {
    await startupCleanup.run().catch(() => undefined);
    throw error;
  }
}
