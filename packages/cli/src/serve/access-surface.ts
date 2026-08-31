/**
 * 接入面（access surface）单元化 + 数据驱动装配。
 *
 * 核心宿主 = 恒定核心（runtime + 会话态 owner 位 + Scheduler + RPC server）+ 一组**可挂载的
 * 接入面**。profile 不"砍核心"，声明该档完整行为画像（接入面集合 + 校验模式 + 生命周期，
 * 见 PROFILES 描述符）；接入面装配 = 遍历启用集合各自 setup，而非在主干用 `if (profile === ...)`
 * 顺序枚举——新增接入面 = 写一个单元 + 在 PROFILES 的 surfaces 集合加一个名字，装配主干一行
 * 不改（杜绝"每加一面改主干"的声明面领先生效面复发）。
 *
 * 真实装配拓扑有交织（核心 Scheduler 构造期吃 delivery 接入面、confirmationBridge 依赖
 * Server 内部设施准备后的 connections），故接入面带 phase：
 * - pre-server：runServer 之前装（MCP / 会话执行面 / channel 门面 / delivery / 文本确认渲染器）。
 * - post-server：同一 bound handle 激活前装（confirmationBridge，依赖 prepared connections）。
 * 核心 Scheduler 排在 pre-server 接入面之后构造（读 ctx.deliveryStack）。
 *
 * pre-server 资源取得后立即进入启动回滚事务；公开入口激活前把同一幂等清理 handle
 * 按既有 LIFO 时序登记到正常停机链。启动补偿与正常停机各自决定顺序，但不会双重释放。
 */

import { PROFILES, type ServerProfile } from "./profile.js";
import type { SurfaceAssetMaintenance } from "./surface-asset-maintenance.js";
import type { ZhixingConfig } from "@zhixing/providers";
import type {
  ChannelRegistry,
  ConversationRepository,
  ShardedTranscriptStore,
  SnapshotStore,
} from "@zhixing/core";
import type { ConversationClearProjectionPort } from "@zhixing/core/conversation/application";
import type {
  DeviceRole,
  EvidenceHandlerPort,
  SecretStorePort,
} from "@zhixing/core/contracts";
import type {
  DeviceCapacityArbiterPort,
  StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type {
  InboundRouter,
  PerspectivesController,
  RunningServer,
} from "@zhixing/server";
import type {
  ConfirmationHub,
  ConversationManager,
  RuntimeFactory,
} from "@zhixing/owner-kernel";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc";
import type {
  AdvancementConversationDirectory,
  AdvancementController,
  AdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import type { McpHub } from "@zhixing/mcp";
import type { TaskListService } from "@zhixing/tools-builtin";
import type {
  AuthorityRuntimeStack,
  DeliveryStack,
  ExecutorReadiness,
} from "../setup-delivery.js";
import type { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";
import type { ExecutorRoleModule } from "./role-topology.js";
import type { JobStatusDirectory } from "./job-status-directory.js";
import type { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import type { JobRuntimePort } from "./job-assignment-worker.js";
import type {
  ExecutorJobOwner,
  ExecutorJobOwnerAssembly,
} from "./executor-job-owner.js";
import type { LosslessDataPlaneRuntime } from "./lossless-data-plane-runtime.js";
import type {
  ChannelInteractionCoordinator,
  JobRelayObligationDirectory,
} from "./channel-interaction-coordinator.js";
import type {
  ExecutionStatusHub,
  FirstPartyFinalitySession,
  FirstPartyFinalitySessionOptions,
} from "./first-party-finality-session.js";
import type { StartupRollback } from "./startup-rollback.js";
import type { AssemblyLifecycleContributions } from "./assembly-lifecycle.js";
import type { LocalWorkspaceAssemblyIdentity } from "../runtime/local-workspace-bootstrap.js";
import type { AgentRuntimeCapacityBinding } from "@zhixing/orchestrator/runtime";
import type { ProviderCredentialProjection } from "@zhixing/providers";
import type { LocalConversationOwnerAssembly } from "./local-conversation-owner.js";
import type { DeliveryLifecycleRestoration } from "@zhixing/core";
import type { MeshConnectionProjectionPort } from "@zhixing/mesh/bootstrap";
import type { ConversationIdentityLifecycleApplication } from "@zhixing/core/conversation/application";
import type {
  AdvancementConversationLifecycleApplication,
  AdvancementReviewAttemptApplication,
} from "@zhixing/core/advancement/application";

/** 接入面装配阶段 —— 适配真实交织（confirmationBridge 依赖 prepared connections）。 */
export type SurfacePhase = "pre-server" | "post-server";

/**
 * 装配期共享上下文 —— 接入面 setup 从这里读依赖、把产物写回，后续接入面 / 核心再读。
 * 单线程顺序装配，共享安全。分两区：
 * - 输入 / 恒定核心（readonly）：外层在装配接入面前已备好。
 * - 接入面产物（mutable）：各 surface.setup 写回，下游 surface 与核心读（依赖链
 *   conversations → channel → delivery → scheduler、connections → confirmationBridge）。
 */
export interface AssemblyContext {
  // ── 输入（外层准备） ──
  readonly profile: ServerProfile;
  readonly enabledRoles: readonly DeviceRole[];
  readonly config: ZhixingConfig;
  readonly providerCredentials?: ProviderCredentialProjection;
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly durableInteractions: DurableConversationInteractionObserver;
  readonly perspectives: PerspectivesController;
  readonly deviceCapacity: DeviceCapacityArbiterPort;
  readonly advancementCapacity: AgentRuntimeCapacityBinding;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly localWorkspaceIdentity: LocalWorkspaceAssemblyIdentity;
  readonly onTrustApplied?: (record: import("@zhixing/core/contracts").HomeTrustRecord) => void | Promise<void>;
  readonly meshConnectionProjection?: MeshConnectionProjectionPort;
  /** Durable lifecycle projection loaded before any producer recovery or ingress. */
  startupLifecycle?: {
    readonly kind: "stop" | "executor-removal" | "anchor-uninstall";
    readonly artifactReady: boolean;
    readonly recoverAcceptedWork: boolean;
    readonly alreadySettled: boolean;
    readonly delivery: DeliveryLifecycleRestoration;
  };

  // ── 恒定核心（接入面 setup 前已建，供其读） ──
  readonly confirmationHub: ConfirmationHub;
  readonly mcpHub: McpHub;
  readonly transcript: ShardedTranscriptStore;
  readonly snapshots: SnapshotStore;
  readonly runtimeFactory: RuntimeFactory;
  readonly assignmentRuntimeFactory: RuntimeFactory;
  readonly jobRuntime?: JobRuntimePort;
  readonly executorReadiness: () => ExecutorReadiness;
  readonly executorRoleModule?: ExecutorRoleModule;
  /** user 域对话 meta 仓——turn 后维护(自动命名)与对话目录共用同一实例 */
  readonly convRepo: ConversationRepository;
  /** Conversation-owned identity/shell lifecycle; no physical storage leaks. */
  readonly conversationIdentityLifecycle: ConversationIdentityLifecycleApplication;
  /** Conversation-owned clear projection; never exposed through ServerContext. */
  readonly conversationClearProjection: Pick<
    ConversationClearProjectionPort,
    "clearStoredView"
  >;
  /** Conversation-owned delete projection; never exposed through ServerContext. */
  readonly conversationDeleteProjection: {
    deleteStoredConversation(conversationId: string): Promise<boolean>;
  };
  readonly conversationRepoFor: (conversationId: string) => {
    readonly repo: import("@zhixing/core").IConversationRepository;
    readonly localId: string;
  };
  readonly taskListService: TaskListService;
  readonly conversationAuthorityRef: {
    current: ConversationProtocolRuntime | undefined;
  };
  /**
   * 会话组播 lazy ref(runServer 后回填)——turn 后维护的改名通知等运行期
   * 推送经此读最新值;装配期为 null,运行期必已就位。
   */
  readonly sessionBroadcastRef: { current: SessionBroadcast | null };
  /**
   * 工作台活动提示 lazy ref(runServer 后回填)。它只传非内容活动信号,不承担
   * 当前对话的内容回显。
   */
  readonly sessionActivityBroadcastRef: { current: SessionActivityBroadcast | null };
  readonly advancementDirectory: AdvancementConversationDirectory;
  readonly startupRollback: StartupRollback;
  readonly lifecycleContributions: AssemblyLifecycleContributions;
  readonly channelHttpRoutes: Map<
    string,
    import("@zhixing/core").HttpHandler
  >;

  // ── 接入面产物（surface.setup 写回） ──
  conversations?: ConversationManager;
  advancementRecovery?: AdvancementRecoveryMaintenance;
  advancement?: AdvancementController;
  readonly advancementReviews: AdvancementReviewAttemptApplication;
  readonly advancementConversationLifecycle: AdvancementConversationLifecycleApplication;
  channels?: ChannelRegistry;
  inboundRouter?: InboundRouter | null;
  channelConnections?: {
    readonly ready: Promise<void>;
    connectConfigured(): Promise<void>;
    disconnectConfigured(): Promise<void>;
    suspendConfigured(): Promise<void>;
    resumeConfigured(): Promise<void>;
  };
  authorityRuntime?: AuthorityRuntimeStack;
  executorDataPlane?: ExecutorDataPlaneRuntime;
  evidenceHandler?: EvidenceHandlerPort & { stopAccepting(): void };
  meshBootstrap: MeshRuntimeBootstrap;
  meshRuntime?: MeshRuntimeAssembly;
  executorJobOwnerAssembly?: ExecutorJobOwnerAssembly;
  executorJobOwner?: ExecutorJobOwner;
  losslessDataPlane?: LosslessDataPlaneRuntime;
  channelCoordinator?: ChannelInteractionCoordinator;
  jobRelayObligations?: JobRelayObligationDirectory;
  executionStatusHub?: ExecutionStatusHub;
  firstPartyFinality?: (
    input: Omit<FirstPartyFinalitySessionOptions, "sources">,
  ) => FirstPartyFinalitySession;
  assetMaintenance?: SurfaceAssetMaintenance;
  conversationProtocol?: ConversationProtocolRuntime;
  localConversationOwner?: LocalConversationOwnerAssembly;
  jobStatus?: JobStatusDirectory;
  deliveryStack?: DeliveryStack;
  authorityCheckpointOwner?: import("@zhixing/mesh/checkpoint-owner").AuthorityCheckpointOwnerPort;

  // ── post-server 输入（runServer resolve 后填，供 post-server 接入面读） ──
  runner?: RunningServer;
}

/**
 * 接入面单元 —— 把"某个接入面的装配"封成自包含单元：条件（如 channel 判 messaging 配置）、
 * 失败处理、对 ctx 的依赖读取与产物写回，全内聚在 setup 内；主干不再有它的 if。
 * teardown 见文件头说明。
 */
interface OrderedAssemblyUnit {
  readonly name: string;
  readonly phase: SurfacePhase;
  setup(ctx: AssemblyContext): Promise<void>;
}

/** Optional adapter selected by the active server profile. */
export interface AccessSurface extends OrderedAssemblyUnit {
  readonly kind?: "access-surface";
}

/** Stable core capability that no profile may remove. */
export interface CoreAssemblyUnit extends OrderedAssemblyUnit {
  readonly kind: "core";
}

export type AssemblyUnit = AccessSurface | CoreAssemblyUnit;

/**
 * One ordered assembly engine for stable core units and profile-selected
 * adapters. Classification is explicit; core capabilities are never disguised
 * as mandatory access surfaces.
 */
export async function setupAssemblyUnits(
  units: readonly AssemblyUnit[],
  ctx: AssemblyContext,
  phase: SurfacePhase,
): Promise<void> {
  const enabled = new Set(PROFILES[ctx.profile].surfaces);
  for (const unit of units) {
    if (
      unit.phase === phase &&
      (unit.kind === "core" || enabled.has(unit.name))
    ) {
      await unit.setup(ctx);
    }
  }
}
