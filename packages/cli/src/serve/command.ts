/**
 * `zhixing serve` 命令 — 启动常驻服务（核心宿主）
 *
 * 核心宿主 = 恒定核心（runtime + 会话态 owner 位 + Scheduler + RPC server）+ 一组**可挂载的
 * 接入面**（access surface）。装配主干：
 *   1. 备齐恒定核心前置（token / transcript / confirmationHub / mcpHub / builtinExtraTools /
 *      runtimeFactory / CleanupRegistry）—— 接入面 setup 从这里读依赖
 *   2. 建 AssemblyContext，`setupAssemblyUnits(pre-server)` 数据驱动装入稳定核心单元与 profile 接入面
 *      （MCP / 会话执行面 / 通道 / 投递栈 / 文本确认渲染器，产物写回 ctx）
 *   3. 恒定核心后置（ephemeralRuntime / runAgentTurn / systemHandlers）—— ephemeralRuntime 消费
 *      mcp 接入面 connectAll 后的工具目录，故排在 pre-server 接入面之后构造
 *   4. 构造核心 Scheduler（读 ctx.deliveryStack）+ start + seed 系统任务
 *   5. createServerContext + runServer
 *   6. `setupAssemblyUnits(post-server)`（confirmationBridge，依赖 runServer 后的 connections）
 *   7. registerCoreCleanup 用接入面产物注册 teardown（shutdown-chain，LIFO）
 *   8. banner / idle reaper / waitForShutdown
 *
 * profile 不"砍主干"，只声明启用哪组接入面（见 PROFILES 描述符）；新增接入面 = 写一个
 * AccessSurface 单元 + 在集合加名字，装配主干一行不改。接入面体系详见 access-surface.ts。
 */

import {
  computeStatusSummary,
  isInternal,
  createEventBus,
  getZhixingHome,
  loadLayeredGuidance,
  type AgentEventMap,
  type SchedulerEventMap,
  type SchedulerFacade,
  type SchedulerBackend,
  LocalSchedulerFacade,
  ConversationRepository,
  parseConversationId,
  ShardedTranscriptStore,
  SnapshotStore,
  conversationsDir,
  runRetentionSweep,
  getWorkScenesRoot,
  getWorkSceneConversationsRoot,
  type DeliveryLifecycleSourcePermit,
} from "@zhixing/core";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import {
  protocolDigest,
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
  registerCleanup,
  createAdvancementEventSink,
  createAdvancementOriginalTaskAdmissionPort,
  createAdvancementProxyTurnPort,
  LlmPerspectiveAllocationStrategy,
  PerspectivesController,
  RuntimePerspectivesOrchestrationExecutor,
  getDefaultLogPath,
  resolveProcessStartTime,
  type RunningServer,
  type ProcessLockPaths,
  type ServerContext,
} from "@zhixing/server";
import {
  AnchorSchedulerGlobalStateAdapter,
  AnchorSchedulerProductPort,
  ConfirmationHub,
  type ConversationManager,
} from "@zhixing/owner-kernel";
import {
  createRunEventForwarder,
  SESSION_NOTIFICATIONS,
  type SessionActivityBroadcast,
  type SessionBroadcast,
  type SessionChangedPayload,
} from "@zhixing/rpc";
import { AssignmentStreamPathUnavailableError } from "./assignment-stream-path-manager.js";
import {
  createAdvancementRecoveryMaintenance,
  renderRecentContextFromMessages,
  type AdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import {
  loadCredentials,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers";
import fsp from "node:fs/promises";
import chalk from "chalk";
import { isProcessAlive } from "@zhixing/server";
import {
  RuntimeHost,
  createBuiltinExtraToolsAssembly,
  createTransientSegmentDeps,
} from "@zhixing/runtime-host";
import type {
  ExecutorRoleModule,
  ServeBootstrapContext,
  ServeTopologyPlan,
} from "./role-topology.js";
import { createRenderSubscribers } from "../render.js";
import { createStdoutWriter } from "../screen/index.js";
import {
  createBlockedRenderer,
} from "../security/index.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import { createMcpHub } from "@zhixing/mcp";
import { parseServerSpecs } from "../runtime/mcp-config.js";
import {
  RoutedConversationRepoTaskListStore,
  type ConversationRepoTaskListRoute,
} from "../runtime/task-list-stores.js";
import { registerCliTurnContextProviders } from "../runtime/turn-context-providers.js";
import { applyTaskListAction } from "../runtime/task-list-actions.js";
import { createServeAdvancementController } from "./advancement-controller.js";
import { createAdvancementAcceptanceLifecycle } from "./advancement-acceptance-lifecycle.js";
import { createZhixingGuidanceLifecycle } from "./zhixing-guidance-lifecycle.js";
import { readGuidanceFile } from "./read-guidance-file.js";
import { createConversationAliveCheck } from "./advancement-gc.js";
import { createConversationDirectory } from "./conversation-directory.js";
import { createWorksceneDirectory } from "./workscene-directory.js";
import { createWorksceneStorageCleanup } from "./workscene-storage-cleanup.js";
import {
  createTrustDirectory,
  createSkillDirectory,
} from "./management-directories.js";
import { PostAdoptionReviewCoordinator } from "./post-adoption-review.js";
import { loadOrCreateToken } from "./token.js";
import { resolveHostProcessMode } from "./self-exec.js";
import { homeToPort } from "./host-port.js";
import { registerTailCleanup, registerCoreCleanup } from "./shutdown-chain.js";
import { shouldIdleExit } from "./idle-policy.js";
import { setupAssemblyUnits, type AssemblyContext } from "./access-surface.js";
import { DEFAULT_PROFILE, type ServerProfile } from "./profile.js";
import { createAssemblyUnits } from "./access-surfaces.js";
import { DurableConversationInteractionObserver } from "./conversation-protocol-runtime.js";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import { createExecutorReadinessSource } from "./executor-readiness.js";
import { StartupRollback } from "./startup-rollback.js";
import {
  createConfiguredCheckpointOwner,
  projectRecoveryBackupStatus,
} from "./backup-runtime-owner.js";
import {
  governControlProvider,
  governControlTextCall,
  type GovernedTextCall,
} from "./governed-control-llm.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { createAgentJobRuntimePort } from "./agent-job-runtime.js";
import { AnchorSchedulerRuntime } from "./anchor-scheduler-runtime.js";
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
import { loadExecutorRemovalLifecycleDecision } from "./device-removal.js";
import { AnchorUninstallCoordinator } from "./anchor-uninstall.js";
import { createMeshCompatibilityStateProjection } from "./mesh-compatibility-state.js";
import { buildManagedHostPublicStatus } from "./status.js";
import {
  HostStopCoordinator,
  hostStopAlreadySettled,
  hostStopDeliveryLifecycleSources,
  loadHostStopAcceptedWork,
  type HostStopAcceptedWorkItem,
  type HostStopAcceptedWorkPorts,
  type HostStopAcceptedWorkSnapshot,
} from "./host-stop-lifecycle.js";
import { deleteDeviceKey, deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import { ownsCurrentSuccessorEndpoint } from "./startup-server-owner.js";
import {
  createAnchorInternalStopPort,
  type AnchorInternalStopPort,
  type AnchorInternalStopRequest,
} from "./anchor-internal-stop.js";

const SERVER_VERSION = ZHIXING_CLI_VERSION;

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
  bootstrap: ServeBootstrapContext,
  executor: ExecutorRoleModule | undefined,
  plan: ServeTopologyPlan,
): Promise<void> {
  await runServerProcess(opts, bootstrap, executor, plan);
}

async function runServerProcess(
  opts: ServeOptions,
  bootstrap: ServeBootstrapContext,
  executor: ExecutorRoleModule | undefined,
  plan: ServeTopologyPlan,
): Promise<void> {
  const startupRollback = new StartupRollback();
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
  const serverLogLifecycle = isBackground
    ? new ServerLogLifecycle({
        logger: {
          info: (msg) => console.log(chalk.dim(`[server-log] ${msg}`)),
          error: (msg, err) =>
            console.error(chalk.red(`[server-log] ${msg}`), err instanceof Error ? err.message : err),
        },
      })
    : undefined;
  const serverLogCleanup = serverLogLifecycle
    ? startupRollback.register("serverLogLifecycle.stop", () =>
        serverLogLifecycle.stop(),
      )
    : undefined;
  await serverLogLifecycle?.start();
  // 端口按 home 派生（同 home 同端口 → listen 的 EADDRINUSE 原子仲裁单例 + 并发安全；
  // 不同 home 不同端口 → 多实例并行不撞）。受控内部入口仍可显式传入端口。
  const port = opts.port ?? homeToPort(zhixingHome);
  const host = opts.host ?? DEFAULT_SERVER_CONFIG.host;

  const startupResult = bootstrap.startup;

  const config: ZhixingConfig = startupResult.config;
  const credentials: ZhixingCredentials = startupResult.credentials;
  const credentialGeneration = startupResult.credentialGeneration;
  const systemProtectedPaths = resolveSystemProtectedSecretPaths();

  // ============================================================================
  // 恒定核心前置 —— 接入面 setup 从这里读依赖。
  // ============================================================================

  // 1. token
  const tokenInfo = await loadOrCreateToken();
  if (tokenInfo.generated && processMode !== "managed") {
    console.log(chalk.dim(`Generated new token: ${tokenInfo.path}`));
  }

  // 2. 分片 transcript store + 派生摘要快照 —— 会话执行面接入时读写；schedule 档无副作用留位。
  const convDir = conversationsDir({ kind: "user" });
  const transcript = new ShardedTranscriptStore(convDir);
  const snapshots = new SnapshotStore(convDir);
  // user 域对话 meta 仓——对话目录与 turn 后维护(自动命名)共用同一实例。
  const convRepo = new ConversationRepository({ kind: "user" });
  const sceneConversationRepos = new Map<string, ConversationRepository>();
  const repoForConversationId = (
    conversationId: string,
  ): ConversationRepoTaskListRoute => {
    const { scope, localId } = parseConversationId(conversationId);
    if (scope.kind === "workscene") {
      let repo = sceneConversationRepos.get(scope.sceneId);
      if (!repo) {
        repo = new ConversationRepository(scope);
        sceneConversationRepos.set(scope.sceneId, repo);
      }
      return { repo, localId };
    }
    return { repo: convRepo, localId };
  };
  const worksceneStorageCleanup = createWorksceneStorageCleanup({
    storageMaintenance: deviceCapacity.storage,
  });
  // 对话目录(盘上事实:清单 / 建删 / 改名 / 清空 / 倒读)——session.* 命令
  // 执行体的持久层,与 REPL 同 scope(同 home 同目录)。task_list cache 清理
  // 经 lazy 闭包接 builtinExtraTools(声明在后,运行期调用时已就位)。
  const conversationDirectory = createConversationDirectory({
    repo: convRepo,
    transcript,
    worksceneStorageCleanup,
    repoForConversationId,
    clearTaskListCache: (conversationId) =>
      builtinExtraTools.taskListService.clear(conversationId),
  });
  // ConversationManager lazy ref——会话执行面(access surface)setup 后回填;
  // 工作场景领域服务与 workmode 工具删除入口运行期读取。
  const conversationsRef: { current: ConversationManager | null } = {
    current: null,
  };
  const authorityRuntimeRef: { current: AuthorityRuntimeStack | undefined } = {
    current: undefined,
  };
  const meshRuntimeRef: {
    current: import("./mesh-runtime-assembly.js").MeshRuntimeAssembly | undefined;
  } = { current: undefined };
  const conversationAuthorityRef: {
    current: import("./conversation-protocol-runtime.js").ConversationProtocolRuntime | undefined;
  } = { current: undefined };
  // 工作场景域——注册表单例(管理面 + factory 的场景装配路由共用)与场景对话取建。
  const worksceneDirectory = createWorksceneDirectory({
    authority: () => authorityRuntimeRef.current,
    conversations: () => conversationsRef.current,
    conversationAuthority: () => conversationAuthorityRef.current,
    conversationDirectory,
    worksceneStorageCleanup,
    recoverWorksceneState: async () => {
      await authorityRuntimeRef.current?.recoverWorksceneState();
    },
    replayWorksceneMutation: async (requestId) =>
      (await authorityRuntimeRef.current?.replayWorksceneMutation(requestId)) ??
      null,
    probeRemote: (deviceId, request) => {
      const mesh = meshRuntimeRef.current;
      if (!mesh) throw new Error("目标设备当前不可达，无法确认工作区状态");
      return mesh.workspaceProbeForDevice(deviceId).probe(request);
    },
  });
  const providerCredentials = credentials.providers
    ? { providers: credentials.providers }
    : {};
  // 管理面两域——trust(盘上持久规则);skill 经锚点
  // GlobalStatePort 的 path-free query/control 合同装配。
  const trustDirectory = createTrustDirectory({
    config,
  });
  // 3. Scheduler facade lazy ref —— 打破组合根装配顺序依赖。
  let schedulerRef: SchedulerBackend | null = null;
  let schedulerProductRef: SchedulerBackend | undefined;
  const currentSchedulerProduct = (): SchedulerBackend => {
    if (!schedulerProductRef) throw new Error("Scheduler generation is not installed");
    return schedulerProductRef;
  };
  const schedulerBackend: SchedulerBackend = {
    start: () => currentSchedulerProduct().start(),
    stop: () => currentSchedulerProduct().stop(),
    createTask: (...args) => currentSchedulerProduct().createTask(...args),
    listTasks: () => currentSchedulerProduct().listTasks(),
    updateTask: (...args) => currentSchedulerProduct().updateTask(...args),
    deleteTask: (...args) => currentSchedulerProduct().deleteTask(...args),
    runTask: (...args) => currentSchedulerProduct().runTask(...args),
    getTask: (id) => currentSchedulerProduct().getTask(id),
    abortRun: (runId, requestId, source) =>
      currentSchedulerProduct().abortRun?.(runId, requestId, source) ?? false,
    get activeTaskCount() {
      return currentSchedulerProduct().activeTaskCount;
    },
  };
  // schedule 工具经门面接入锚点唯一 scheduler 权威。实例化落点在权威创建后；
  // per-runtime 工具只持 getter，不持第二套 scheduler 状态。
  let schedulerFacadeRef: LocalSchedulerFacade | null = null;
  const getSchedulerFacade = (): SchedulerFacade => {
    if (!schedulerFacadeRef) throw new Error("Scheduler not initialized yet");
    return schedulerFacadeRef;
  };

  // serve 模式无 spinner —— 不传 renderer,pauseUI 退化为 no-op。
  // 写屏走 stdout writer（后台宿主无 chrome），retry/compact 等事件
  // 直接打到 stdout 日志。工厂结果在多个 runtime 之间共享:每次 runtime.run() 各自
  // 装配独立 listener,工厂自身无跨 run 状态,共享安全且节省一次函数创建开销。
  const serveWriter = createStdoutWriter();
  const renderDecorator = createRenderSubscribers({ writer: serveWriter });

  // 带外事件转发——per-run bus 的 UI 订阅集事件经统一信封组播给会话 observers
  // (session.event 通知)。组播设施在 runServer 后才回填(connections 那时才有),
  // 此处经 lazy ref 闭包接线——与 schedulerRef 同构;未就绪时静默丢弃(装配期
  // 无会话 turn 流动,丢弃面为零)。
  const sessionBroadcastRef: { current: SessionBroadcast | null } = {
    current: null,
  };
  const sessionActivityBroadcastRef: { current: SessionActivityBroadcast | null } = {
    current: null,
  };
  // 推进恢复设施 lazy ref——recovery 依赖 conversations(接入面产物),建成后回填;
  // turn 提交触发的补审 catch-up 经此读最新值。
  const advancementRecoveryRef: { current: AdvancementRecoveryMaintenance | null } = {
    current: null,
  };
  const runEventForwarder = createRunEventForwarder((conversationId, envelope) =>
    sessionBroadcastRef.current?.(conversationId, SESSION_NOTIFICATIONS.event, envelope),
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
  const perspectivesController = new PerspectivesController({
    allocationStrategy: new LlmPerspectiveAllocationStrategy(),
    orchestrationExecutor: new RuntimePerspectivesOrchestrationExecutor(),
    createRunEventBus: () => createEventBus<AgentEventMap>(),
    decorateRunBus: serveDecorateRunBus,
  });

  // 3a. ConfirmationHub —— 远程权限确认聚合层（见 remote-confirmation-execution.md）
  //   在会话执行面 / 通道 / ephemeralRuntime / ServerContext 之前创建，以便各组件构造时能接入。
  const confirmationHub = new ConfirmationHub();

  // 3b. MCP host —— 创建（不 eager 连接）。connectAll 由 mcp 接入面在 pre-server 阶段触发，
  //   故 schedule 档（无 mcp 接入面）省去 eager 连接，仅 hub 对象在位、ephemeral 可用 builtin 工具。
  //   serve 进程内单例，多 session 共享同一批连接。空配置时为 no-op。
  const mcpHub = createMcpHub(parseServerSpecs(config.mcp, credentials.mcp), {
    networkProxy: config.network?.proxy,
  });

  // 3c. Builtin extra tools assembly —— task_list / schedule 工具的装配点，所有
  //   per-session runtime 共享同一 service 单例（cache by sessionId/conversationId）。
  //   task_list 盘上状态按全域 conversationId 路由到所属 scope repo；user / workscene
  //   与目录 clear 共用同一 repo 实例，保 meta 写入锁一致。
  const builtinExtraTools = createBuiltinExtraToolsAssembly(
    new RoutedConversationRepoTaskListStore(repoForConversationId),
    mcpHub,
  );
  // task_list 状态变更 → 会话级变更组播(meta 变更):接入面屏底任务区的
  // 实时数据源。装配期 broadcast 未回填时静默丢弃(无会话 turn 流动)。
  builtinExtraTools.taskListService.subscribe(({ conversationId, state }) => {
    sessionBroadcastRef.current?.(conversationId, SESSION_NOTIFICATIONS.changed, {
      conversationId,
      change: "taskList",
      taskList: state,
    } satisfies SessionChangedPayload);
  });

  // 3c'. 段切换外部依赖 —— serve 全部 runtime（per-session + ephemeral）共享：
  //   注意力窗口的段保护对一切运行体生效。persistence 为 no-op（serve 未接
  //   ConversationRepository，segmentMeta 缺写无害）；taskListReader 复用同一
  //   TaskListService，in-progress 守卫与 REPL 同源。
  const serveSegmentDeps = createTransientSegmentDeps({
    taskListService: builtinExtraTools.taskListService,
  });

  const channelCredentials = credentials.channels
    ? { channels: credentials.channels }
    : {};
  const durableInteractions = new DurableConversationInteractionObserver();
  const assemblyUnits = createAssemblyUnits(channelCredentials);
  const advancementController = await createServeAdvancementController({
    config,
    credentials: providerCredentials,
    // control 治理端口——authority runtime 在 pre-server surface 装配（晚于此处），
    // 惰性取值；advancement 外调发生在运行期，届时必已就绪
    governor: () => ctx.authorityRuntime?.resourceGovernor,
    // 会话状态端口——conversation 权威运行时在 surface 装配期创建，惰性取值
    sessionState: () => ctx.conversationProtocol?.sessionState,
    evidenceRuntime: () => {
      const authority = ctx.authorityRuntime;
      const protocol = ctx.conversationProtocol;
      if (!authority || !protocol) return undefined;
      return {
        signer: authority.signer,
        verifier: authority.verifier,
        resolveTarget: (conversationId: string, runId: string) =>
          protocol.advancementEvidenceTarget(conversationId, runId),
        clientFor: (executorId: string) => {
          if (executorId === authority.executorId) return ctx.evidenceHandler;
          try {
            return ctx.meshRuntime?.evidenceForExecutor(executorId);
          } catch {
            return undefined;
          }
        },
      };
    },
    rubricRuntime: () => {
      const authority = ctx.authorityRuntime;
      if (!authority?.globalState) return undefined;
      return {
        globalState: authority.globalState,
        artifacts: authority.artifacts,
        anchorEpoch: authority.anchorEpoch,
      };
    },
    // 准入投影：活跃会话窗口尾部（lazy ref，manager 未就绪时无投影）；
    // 延迟基线进 serve 日志作观测数据。
    recentContextProvider: async (conversationId) =>
      renderRecentContextFromMessages(
        conversationsRef.current?.getHistory(conversationId, 6),
      ),
    onAdmissionTiming: (elapsedMs) => {
      console.log(chalk.dim(`[advancement] admission ${elapsedMs}ms`));
    },
  });

  // 3d. RuntimeHost —— 宿主侧 runtime 装配点:共享资产(skillStore / segmentDeps /
  //   mcpHub / 渲染装饰)单一持有,会话与 ephemeral 两条发放路径同一装配体。
  //   投递 origin 执行期从 RunContext 派生,实例装配不再按对话定制。
  //   turn-context provider 注册收拢进 onRuntimeCreated——scheduler 是 lazy ref
  //   （顶层 let schedulerRef），LLM 调用时刻 ref 已就绪；未就绪时 fallback 空状态。
  const resolveWorksceneRoot = async (sceneId: string): Promise<string | null> => {
    const scene = await worksceneDirectory.get(sceneId);
    if (!scene?.workspace) return null;
    const runtime = authorityRuntimeRef.current;
    if (!runtime?.environment || scene.workspace.deviceId !== runtime.deviceId) {
      throw new Error(`工作场景 "${sceneId}" 的工作区不属于当前 executor`);
    }
    const resolved = await runtime.environment.resolveWorkspace(
      scene.workspace.bindingRef,
    );
    return resolved.absolutePath;
  };

  const runtimeHost = new RuntimeHost({
    providerConfiguration: {
      config,
      credentials: providerCredentials,
    },
    confirmationLifecycleObserver: durableInteractions,
    systemProtectedPaths,
    artifactStore: () => {
      const runtime = authorityRuntimeRef.current;
      if (!runtime) throw new Error("Runtime artifact store is not ready");
      return runtime.artifacts;
    },
    segmentDeps: serveSegmentDeps,
    deviceCapacity: {
      interactive: deviceCapacity.workload("workload-interactive"),
      scheduler: deviceCapacity.workload("workload-scheduler"),
      orchestration: deviceCapacity.workload("workload-orchestration"),
    },
    extraTools: builtinExtraTools,
    scheduler: getSchedulerFacade,
    // 推进闭环 active 期间把契约验收条件注入执行侧发送视图——订阅者按
    // conversationId 运行期查推进会话状态，装配期不绑定任何对话。
    lifecycle: [
      createAdvancementAcceptanceLifecycle(advancementController),
      createZhixingGuidanceLifecycle({
        getZhixingHome,
        resolveWorksceneRoot,
        readGuidanceFile,
        loadLayeredGuidance,
      }),
    ],
    // 渠道下游(飞书/RPC)可看到子 agent 冒泡事件,renderDecorator 在非 TTY
    // 模式下退化为只输出 Task 起止帧(子工具中间事件静默,避免日志爆炸)。
    decorateRunBus: serveDecorateRunBus,
    onSecurityBlocked: createBlockedRenderer(serveWriter),
    // workmode 工具组的领域服务——LLM 管理入口与 RPC / CLI 管理入口共用
    // 同一校验、静默与运行态守卫。
    worksceneDirectory: () => worksceneDirectory,
    onRuntimeCreated: (runtime) => {
      registerCliTurnContextProviders(runtime, {
        getSchedulerStatus: () =>
          schedulerRef
            ? computeStatusSummary(
                schedulerRef.listTasks().filter((t) => !isInternal(t)),
                new Date(),
              )
            : { active: [], recentlyCompleted: [], recentlyFailed: [] },
        taskListService: builtinExtraTools.taskListService,
      });
    },
  });

  // RuntimeFactory —— 会话执行面（接入面）建 per-session runtime 的工厂。schedule 档无
  //   会话执行面，工厂作无副作用留位（不连接、不建目录）。
  //   注：工厂内实例发放是 lazy（session 调用时才建），那时 mcp 接入面 connectAll
  //   早已完成（pre-server 阶段），故工厂装配可前置、不受 connectAll 时序约束（与 eager 的
  //   ephemeralRuntime 不同——后者须排在接入面之后，见下）。
  const executorRole = executor?.createExecutorRole({
    createAgentRuntime: async (sessionId, environment) => {
      // 对话归属编码在全域键里:ws: 前缀 → 该场景的 power 装配;其余 main。
      const { scope } = parseConversationId(sessionId);
      if (scope.kind === "workscene") {
        const scene = await worksceneDirectory.get(scope.sceneId);
        if (!scene) {
          throw new Error(`工作场景 "${scope.sceneId}" 不存在,无法装配会话`);
        }
        if (environment) {
          return runtimeHost.createWorksceneRuntime({
            scene,
            absolutePath: environment.workspaceRoot,
          });
        }
        if (!scene.workspace) {
          return runtimeHost.createWorksceneRuntime({
            scene,
            absolutePath: null,
          });
        }
        const absolutePath = await resolveWorksceneRoot(scope.sceneId);
        if (!absolutePath) {
          throw new Error(
            `工作场景 "${scope.sceneId}" 的工作区无法在当前 executor 解析`,
          );
        }
        const runtime = authorityRuntimeRef.current!;
        const probe = await runtime.environment!.probePath(absolutePath);
        if (probe === "missing") {
          await fsp.mkdir(absolutePath, { recursive: true });
        } else if (probe !== "directory") {
          throw new Error(
            `工作场景 "${scope.sceneId}" 的工作区不可用于执行: ${probe}`,
          );
        }
        return runtimeHost.createWorksceneRuntime({
          scene,
          absolutePath,
        });
      }
      return runtimeHost.createConversationRuntime(
        environment?.workspaceRoot,
      );
    },
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
        create: (instruction, confirmationBroker) =>
          runtimeHost.createJobRuntime({ instruction, confirmationBroker }),
      })
    : undefined;
  const executorReadiness = createExecutorReadinessSource({
    runtime: runtimeHost,
    credentials,
    credentialGeneration,
  });

  // Device lifecycle admission is reconstructed from the durable operation before
  // any access surface can recover a producer. The authority runtime consumes this
  // projection first; downstream surfaces only decide whether frozen work may be
  // resumed, never whether fresh work may enter.
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

  // The final home endpoint is the only cross-process startup owner. Every
  // production start, including the no-active-operation path, acquires it
  // before any pre-server owner can recover or publish effects. Until the
  // existing server object is activated it serves only the stable inactive
  // response and never dispatches HTTP/WebSocket work.
  const serverBinding = await bindServer({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
  });
  startupRollback.register("serverBinding.close", () => serverBinding.close());

  // 4. CleanupRegistry —— 唯一清理出口。LIFO 语义 + 跨包注入。注册序列封装在
  //    shutdown-chain.ts，方便单测顺序正确性。post-server 接入面在自己 setup 内注册到此。
  const registry = new CleanupRegistry({
    activeOwners: plan.activeCleanupOwners,
    logger: {
      info: (msg) => console.log(chalk.dim(`[cleanup] ${msg}`)),
      error: (msg, err) =>
        console.error(chalk.red(`[cleanup] ${msg}`), err instanceof Error ? err.message : err),
    },
  });
  startupRegistry = registry;
  if (serverLogLifecycle) {
    registerCleanup(
      registry,
      { owner: "anchor-host", role: "runtime", id: "serverLogLifecycle.stop" },
      () => serverLogCleanup!.run(),
    );
  }

  const stopEndpointLock = {
    pid: process.pid,
    port: serverBinding.port,
    startTime: processStartTime,
    startedAt: processStartedAt,
  } as const;
  const stateFile = new ServerStateFile({ publishReadyMarker: isBackground });
  const meshConnectionProjection = createMeshCompatibilityStateProjection(stateFile, {
    ...stopEndpointLock,
    host: serverBinding.host,
  });
  await meshConnectionProjection.replaceCurrent([]);
  const heartbeatTimerRef: { current: NodeJS.Timeout | null } = { current: null };

  // lockPaths —— 单一事实源。同时传给 runServer（acquireLock）和 registerTailCleanup（releaseLock），
  // 保证 acquire/release 走同一路径。当前 undefined = 默认 ~/.zhixing/server.pid。
  const lockPaths: ProcessLockPaths | undefined = undefined;

  // ============================================================================
  // 有序装配 —— 稳定核心单元恒启用，profile 仅选择可选接入面；setupAssemblyUnits
  // 按依赖拓扑序遍历、各自 setup（产物写回 ctx）。主干不出现任何 `if (profile === ...)`。
  // ============================================================================
  const startupCleanups: AssemblyContext["startupCleanups"] = {};
  const channelHttpRoutes: AssemblyContext["channelHttpRoutes"] = new Map();
  const anchorInternalStop = {
    current: undefined as AnchorInternalStopPort | undefined,
  };
  const requestAnchorInternalStop = (
    request: AnchorInternalStopRequest,
  ): Promise<void> => {
    const stop = anchorInternalStop.current;
    if (!stop) {
      return Promise.reject(new Error("Anchor internal stop is not ready"));
    }
    return stop.requestStop(request);
  };
  let assemblyContext: AssemblyContext | undefined;
  const onTrustApplied = () => coordinateManagedHostTrustTransition({
    processMode,
    expectedAdmission: initialManagedHostAdmission,
    refuseNewMessages: () => assemblyContext?.inboundRouter?.refuseNewMessages(),
    requestShutdown: () => requestAnchorInternalStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    }),
  }).then(() => undefined);

  const ctx: AssemblyContext = {
    profile,
    config,
    providerCredentials,
    zhixingHome,
    secretStore: startupResult.secretStore,
    durableInteractions,
    perspectives: perspectivesController,
    deviceCapacity: deviceCapacity.arbiter,
    advancementCapacity: deviceCapacity.workload("workload-advancement"),
    storageMaintenance: deviceCapacity.storage,
    localWorkspaceIdentity: bootstrap.localWorkspaceIdentity,
    confirmationHub,
    mcpHub,
    transcript,
    snapshots,
    runtimeFactory,
    assignmentRuntimeFactory,
    ...(jobRuntime ? { jobRuntime } : {}),
    executorReadiness,
    ...(executor ? { executorRoleModule: executor } : {}),
    convRepo,
    conversationDirectory,
    conversationRepoFor: repoForConversationId,
    taskListService: builtinExtraTools.taskListService,
    conversationAuthorityRef,
    worksceneDirectory,
    sessionBroadcastRef,
    sessionActivityBroadcastRef,
    advancementRecoveryRef,
    cleanup: registry,
    startupRollback,
    startupCleanups,
    channelHttpRoutes,
    advancement: advancementController,
    enabledRoles: bootstrap.mesh.roles,
    meshBootstrap: bootstrap.mesh,
    meshConnectionProjection,
    onTrustApplied,
    ...(startupLifecycle ? { startupLifecycle } : {}),
  };
  assemblyContext = ctx;

  // pre-server 接入面：MCP（connectAll）/ 会话执行面 / 无损数据面 / 通道门面 / 投递栈。
  // 产物写回 ctx.conversations / losslessDataPlane / channels / inboundRouter / deliveryStack。
  await setupAssemblyUnits(assemblyUnits, ctx, "pre-server");
  ctx.authorityCheckpointOwner = await createConfiguredCheckpointOwner({
    zhixingHome,
    mesh: ctx.meshBootstrap,
    ...(ctx.meshRuntime ? { meshRuntime: ctx.meshRuntime } : {}),
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
  await ctx.authorityCheckpointOwner?.start();
  ctx.meshRuntime?.bindAuthorityCheckpointOwner(ctx.authorityCheckpointOwner);
  authorityRuntimeRef.current = ctx.authorityRuntime;
  meshRuntimeRef.current = ctx.meshRuntime;
  conversationsRef.current = ctx.conversations ?? null;
  await worksceneDirectory.recover();

  // ============================================================================
  // 恒定核心后置 —— 须在 pre-server 接入面之后构造。
  // ephemeralRuntime 经 builtinExtraTools.assembleTools 同步物化 mcpHub.catalog()（MCP 工具目录），
  // 而 catalog 由 mcp 接入面 connectAll 填充；故这个 eager runtime 必须排在 mcp 接入面之后，
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
  const ephemeralRuntime = await runtimeHost.createEphemeralRuntime();

  if (ctx.authorityRuntime) {
    await publishRequiredCredentialRotations({
      authority: new CredentialExposureAuthority({
        deviceId: ctx.authorityRuntime.deviceId,
        log: ctx.authorityRuntime.authorityLog,
        secretStore: ctx.secretStore,
      }),
      deviceId: ctx.authorityRuntime.deviceId,
      config,
      credentials,
      credentialGeneration,
      readCredentials: async () =>
        loadCredentials({ store: startupResult.secretStore }),
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
      mcpStatuses: () => ctx.mcpHub.serverStatuses(),
      channelStatuses: () => ctx.channels?.listStatuses() ?? [],
      ...(ctx.channelConnections
        ? { waitForChannels: () => ctx.channelConnections!.ready }
        : {}),
    });
  }

  // Scheduler job 由 executor owner 的耐久数据面执行；管理用 ephemeral
  // runtime 只服务 llm.complete，不再充当 scheduler runtime 或确认 broker。
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  // 本 home 全部对话根：用户域 + 各工作场景域。按物理目录枚举——保留清理是
  // 物理层维护，场景目录存在即纳入，不依赖注册表状态（注册表丢失不该让
  // 孤儿场景的过期数据永生）。
  const collectConversationRoots = async (): Promise<string[]> => {
    const roots = [conversationsDir({ kind: "user" })];
    try {
      const entries = await fsp.readdir(getWorkScenesRoot(), {
        withFileTypes: true,
      });
      for (const e of entries) {
        if (e.isDirectory()) roots.push(getWorkSceneConversationsRoot(e.name));
      }
    } catch {
      // 无工作场景目录——合法空域
    }
    return roots;
  };

  const systemHandlers = buildSystemHandlers({
    transcript: {
      runSweep: async () =>
        runRetentionSweep({ roots: await collectConversationRoots() }),
    },
    advancement: {
      runSweep: async () =>
        await advancementController.sweepOrphanData(
          createConversationAliveCheck(),
        ),
    },
  });

  // Anchor 是 scheduler/job 唯一 owner。非 anchor 拓扑不装 timer、journal
  // recovery 或兼容迁移器，schedule 产品入口保持明确不可用。
  let schedulerRuntime: AnchorSchedulerRuntime | undefined;
  let adoptionReview: PostAdoptionReviewCoordinator | undefined;
  let schedulerCleanup: ReturnType<StartupRollback["register"]> | undefined;
  let startupLifecycleFrozenRecoveryStarted = startupLifecycle?.recoverAcceptedWork ?? true;
  const recoverStartupLifecycleAcceptedWork = async (
    sources: readonly DeliveryLifecycleSourcePermit[],
  ): Promise<void> => {
    if (!startupLifecycle || startupLifecycleFrozenRecoveryStarted) return;
    startupLifecycleFrozenRecoveryStarted = true;
    try {
      await ctx.localConversationOwner?.recoverAcceptedWorkForLifecycle();
      await ctx.executorJobOwner?.recoverAcceptedWorkForLifecycle();
      await ctx.meshRuntime?.recoverAcceptedWorkForLifecycle();
      await ctx.channelCoordinator?.recover();
      await schedulerRuntime?.recoverAcceptedWorkForLifecycle(
        sources
          .filter((source) => source.owner === "scheduler")
          .map(({ id, revision }) => ({ id, revision })),
      );
    } catch (error) {
      startupLifecycleFrozenRecoveryStarted = false;
      throw error;
    }
  };
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
      capabilities: runtimeHost.capabilityCatalog(),
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
    schedulerRuntime = await createSchedulerRuntime();
    schedulerCleanup = startupRollback.register(
      "scheduler.stop",
      async () => {
        adoptionReview?.close();
        await schedulerRuntime?.stop();
      },
    );
    const installSchedulerGeneration = async (
      runtime: AnchorSchedulerRuntime,
      activate: boolean,
    ) => {
      const schedulerGlobalState = new AnchorSchedulerGlobalStateAdapter(
        runtime.scheduler,
        ctx.authorityRuntime!.anchorEpoch,
      );
      const schedulerProduct = new AnchorSchedulerProductPort(
        runtime.scheduler,
        schedulerGlobalState,
        ctx.authorityRuntime!.anchorEpoch,
      );
      schedulerProductRef = schedulerProduct;
      schedulerRef = schedulerBackend;
      schedulerFacadeRef ??= new LocalSchedulerFacade(
        schedulerBackend,
        schedulerEventBus,
      );
      ctx.authorityRuntime!.installSchedulerGlobalState(schedulerGlobalState);
      await runtime.start();
      if (startupLifecycle) {
        runtime.scheduler.closeAdmissionForLifecycle();
        if (startupLifecycle.recoverAcceptedWork) {
          await runtime.recoverAcceptedWorkForLifecycle(
            startupLifecycle.delivery.sources
              .filter((source) => source.owner === "scheduler")
              .map(({ id, revision }) => ({ id, revision })),
          );
        }
      }
      if (activate && !startupLifecycle) {
        runtime.activate();
        await runtime.resumeManualJobSurfaces();
      }
      adoptionReview?.close();
      adoptionReview = new PostAdoptionReviewCoordinator({
        review: runtime.deferredIntents,
        hub: confirmationHub,
        workingDirectory: ephemeralRuntime.resolvedWorkspace.path ?? process.cwd(),
      });
    };
    await installSchedulerGeneration(schedulerRuntime, false);
    ctx.meshRuntime?.bindPlannedAnchorLifecycle({
      stopAccepting: async () => {
        ctx.inboundRouter?.refuseNewMessages();
        await ctx.inboundRouter?.drainAcceptedMessages();
        await ctx.channelConnections?.disconnectConfigured();
        await ctx.deliveryStack?.quiesceForAuthorityTransfer();
        await schedulerRuntime!.scheduler.pauseForAuthorityTransfer();
      },
      drainAccepted: async () => {
        await ctx.conversations?.abortAllAndWait(
          { kind: "external", origin: "planned-duty-migration" },
          30_000,
        );
        if (ctx.conversations?.hasActiveWork()) {
          throw new Error("Duty-device migration could not drain accepted conversation work");
        }
        await ctx.executorJobOwner?.drain();
        await ctx.conversationProtocol?.stopRecoveryLoop();
      },
      resumeAfterAbort: async () => {
        await ctx.deliveryStack?.resumeAfterAuthorityTransfer();
        ctx.conversationProtocol?.startRecoveryLoop();
        schedulerRuntime!.scheduler.resumeAfterAuthorityTransfer();
        ctx.inboundRouter?.resumeNewMessages();
        await ctx.channelConnections?.connectConfigured();
      },
    });
    if (ctx.meshRuntime) {
      await ctx.meshRuntime.bindPostAdoptionReview({
        reviewAfterAdoption: (conversationId) => {
          if (!adoptionReview) {
            throw new Error("Post-adoption review generation is unavailable");
          }
          return adoptionReview.reviewAfterAdoption(conversationId);
        },
      });
    }
    await ctx.meshRuntime?.bindPlannedAnchorPostInstallConsumers({
      rebindAuthorityGeneration: async (generation) => {
        const previousAnchorEpoch = ctx.authorityRuntime!.anchorEpoch;
        const receipt = await ctx.authorityRuntime!.rebindInstalledAuthority(generation);
        if (previousAnchorEpoch !== receipt.generation.anchorEpoch) {
          ctx.conversationProtocol!.beginInstalledAuthorityGeneration();
        }
        return receipt;
      },
      recoverScheduler: async (obligations) => {
        if (schedulerRuntime!.anchorEpoch !== ctx.authorityRuntime!.anchorEpoch) {
          await schedulerRuntime!.stop();
          const replacement = await createSchedulerRuntime();
          schedulerRuntime = replacement;
          await installSchedulerGeneration(replacement, runner !== undefined);
        } else {
          await schedulerRuntime!.recoverInstalledAuthority();
        }
        return obligations;
      },
      recoverConversation: async (obligations) => {
        const protocol = ctx.conversationProtocol;
        if (!protocol) return obligations;
        await protocol.recoverInstalledAuthority();
        return obligations;
      },
      recoverDelivery: async (obligations) => {
        await ctx.deliveryStack?.recoverInstalledAuthority();
        return obligations;
      },
      openCurrentOwnerSurfaces: async () => {
        await ctx.channelConnections?.connectConfigured();
      },
    });
  }
  const scheduler: SchedulerBackend | undefined =
    ctx.enabledRoles.includes("anchor") ? schedulerBackend : undefined;

  // ============================================================================
  // ServerContext + runServer —— 读接入面产物（conversations / channels）。
  // ============================================================================
  const advancementRecovery =
    ctx.advancement && ctx.conversations
      ? createAdvancementRecoveryMaintenance({
          advancement: ctx.advancement,
          directory: conversationDirectory,
          proxyTurns: createAdvancementProxyTurnPort({
            manager: ctx.conversations,
            sessionBroadcast: () => sessionBroadcastRef.current,
            conversationExists: (conversationId) =>
              conversationDirectory.exists(conversationId),
          }),
          originalTasks: createAdvancementOriginalTaskAdmissionPort(
            ctx.conversations,
            { conversationExists: (conversationId) =>
              conversationDirectory.exists(conversationId) },
          ),
          events: createAdvancementEventSink(
            () => sessionBroadcastRef.current,
          ),
          logger: console,
        })
      : undefined;
  advancementRecoveryRef.current = advancementRecovery ?? null;

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

  const authorityRuntime = authorityRuntimeRef.current;
  if (!authorityRuntime?.globalState) {
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
  const captureStopAcceptedWork = async (
    owner: keyof HostStopAcceptedWorkPorts,
    operationId: string,
  ) => {
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
      return (ctx.channels?.listStatuses() ?? [])
        .filter((status) => status.state !== "disconnected")
        .map((status) => ({
          id: status.channelId,
          revision: protocolDigest("HostStopChannel", 1, { channelId: status.channelId }),
        }));
    }
    if (owner === "scheduler") {
      return await schedulerRuntime?.scheduler.acceptedWorkItems() ?? [];
    }
    if (owner === "delivery") {
      return ctx.deliveryStack?.acceptedWorkItems() ?? [];
    }
    return [];
  };
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
    const current = owner === "delivery"
      ? await ctx.deliveryStack?.lifecycleAcceptedWorkItems(operationId) ?? []
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
      if ((ctx.channels?.listStatuses() ?? []).some((status) => status.state !== "disconnected")) {
        throw new Error("Channel accepted work is not settled");
      }
      return;
    }
    if (owner === "scheduler") {
      if (current.length !== 0) throw new Error("Scheduler accepted work is not settled");
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
        ? await ctx.deliveryStack?.lifecycleAcceptedWorkItems(input.operationId) ?? []
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
      await schedulerRuntime?.scheduler.pauseForAuthorityTransfer();
      await ctx.executorJobOwner?.drain();
    }),
    delivery: stopPort("delivery", async ({ operationId, strategy, timeoutMs }) => {
      await ctx.deliveryStack?.sealLifecycleAdmission(operationId);
      await ctx.deliveryStack?.settleAcceptedWorkForLifecycle(
        operationId,
        strategy,
        timeoutMs,
      );
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
      await ctx.deliveryStack?.installLifecycleAdmission({
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
        schedulerRuntime?.scheduler.closeAdmissionForLifecycle();
        ctx.deliveryStack?.closeAdmissionForLifecycle();
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
    await ctx.deliveryStack?.releaseLifecycleAdmission(operationId);
    await ctx.deliveryStack?.resumeAfterAuthorityTransfer();
    if (!startupLifecycleFrozenRecoveryStarted) {
      await recoverStartupLifecycleAcceptedWork(
        startupLifecycle?.delivery.sources ?? [],
      );
    }
    await recoverAdvancementAcceptedWork();
    schedulerRuntime?.scheduler.resumeAfterAuthorityTransfer();
    ctx.executorJobOwner?.resumeAccepting();
    ctx.meshRuntime?.resumeAcceptingAfterLifecycle();
    ctx.inboundRouter?.resumeNewMessages();
    await ctx.channelConnections?.resumeConfigured();
    ctx.localConversationOwner?.resumeRecoveryAfterLifecycle();
    startupLifecycle = undefined;
    delete ctx.startupLifecycle;
    managedHostStopping = false;
  }
  let localRetirementCompletedBeforeServerStart = false;
  const cleanupLocalDevice = async () => {
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
      unregisterFuture: async () => {
        if (!current.spec || !adapter || !expected) return;
        await adapter.unregisterFutureExact(
          current.spec,
          expected,
          new AbortController().signal,
        );
      },
    });
  };
  const requestRemovedDeviceStop = async () => {
    const stop = anchorInternalStop.current;
    if (stop) {
      await requestAnchorInternalStop({
        reason: "device-removed",
        strategy: "immediate",
      });
      return;
    }
    localRetirementCompletedBeforeServerStart = true;
  };
  const finishLocalRetirement = async () => {
    await deleteDeviceKey(bootstrap.secretStore, bootstrap.mesh.deviceKey.deviceId);
    await requestRemovedDeviceStop();
  };
  const finishRemovedDevice = requestRemovedDeviceStop;
  let removalAdmissionOperationId: string | undefined;
  await ctx.meshRuntime?.bindDeviceRemovalLifecycle({
    closeAdmission: async (operationId) => {
      if (
        removalAdmissionOperationId !== undefined &&
        removalAdmissionOperationId !== operationId
      ) {
        throw new Error("Another device-removal operation owns external admission");
      }
      removalAdmissionOperationId = operationId;
      ctx.inboundRouter?.refuseNewMessages();
      ctx.executorJobOwner?.pauseAccepting();
      await ctx.channelConnections?.suspendConfigured();
      schedulerRuntime?.scheduler.closeAdmissionForLifecycle();
      ctx.deliveryStack?.closeAdmissionForLifecycle();
    },
    captureAcceptedWork: async (operationId) => {
      const items = [] as Array<{
        owner: "remote" | "channel" | "scheduler" | "delivery";
        id: string;
        revision: string;
      }>;
      for (const owner of ["remote", "channel", "scheduler", "delivery"] as const) {
        for (const item of await captureStopAcceptedWork(owner, operationId)) {
          items.push({ owner, ...item });
        }
      }
      return Object.freeze(items.sort((left, right) =>
        `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US")));
    },
    settleAcceptedWork: async ({ operationId, ownerItems }) => {
      if (removalAdmissionOperationId !== operationId) {
        throw new Error("Device-removal settlement does not own external admission");
      }
      await ctx.deliveryStack?.installLifecycleAdmission({
        operationId,
        sources: deliveryLifecycleSourcesFromOwnerItems(ownerItems),
        deliveries: ownerItems
          .filter((item) => item.owner === "delivery")
          .map(({ id, revision }) => ({ id, revision })),
      });
      await recoverStartupLifecycleAcceptedWork(
        deliveryLifecycleSourcesFromOwnerItems(ownerItems),
      );
      for (const owner of ["remote", "channel", "scheduler", "delivery"] as const) {
        const frozen = ownerItems
          .filter((item) => item.owner === owner)
          .map(({ id, revision }) => ({ id, revision }));
        const current = owner === "delivery"
          ? await ctx.deliveryStack?.lifecycleAcceptedWorkItems(operationId) ?? []
          : await captureStopAcceptedWork(owner, operationId);
        if (owner !== "delivery") {
          assertAcceptedWorkSubset(current, frozen, `device-removal ${owner} settlement`);
        }
        if (owner === "remote") {
          await ctx.inboundRouter?.drainAcceptedMessages();
          await ctx.executorJobOwner?.drain();
        } else if (owner === "channel") {
          await ctx.channelConnections?.disconnectConfigured();
        } else if (owner === "scheduler") {
          await schedulerRuntime?.scheduler.pauseForAuthorityTransfer();
        } else {
          await ctx.deliveryStack?.sealLifecycleAdmission(operationId);
          await ctx.deliveryStack?.settleAcceptedWorkForLifecycle(
            operationId,
            "drain",
            30_000,
          );
        }
        const after = owner === "delivery"
          ? await ctx.deliveryStack?.lifecycleAcceptedWorkItems(operationId) ?? []
          : await captureStopAcceptedWork(owner, operationId);
        if (owner !== "delivery") {
          assertAcceptedWorkSubset(after, frozen, `device-removal ${owner} read-back`);
        }
        if (after.length !== 0) {
          throw new Error(`Device-removal ${owner} accepted work is not settled`);
        }
      }
      await ctx.authorityRuntime?.resourceGovernor.coordinate(async () => undefined);
    },
    releaseAdmission: async (operationId) => {
      if (removalAdmissionOperationId === undefined) return;
      if (removalAdmissionOperationId !== operationId) {
        throw new Error("Device-removal release does not own external admission");
      }
      await ctx.deliveryStack?.releaseLifecycleAdmission(operationId);
      await ctx.deliveryStack?.resumeAfterAuthorityTransfer();
      schedulerRuntime?.scheduler.resumeAfterAuthorityTransfer();
      ctx.executorJobOwner?.resumeAccepting();
      ctx.inboundRouter?.resumeNewMessages();
      await ctx.channelConnections?.resumeConfigured();
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
        throw new Error("Device removal key finalizer does not own the frozen key generation");
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
    onRemoved: finishRemovedDevice,
  });
  const uninstallIssuerKey = bootstrap.mesh.mode === "trusted-home" &&
    bootstrap.mesh.trust.issuer.deviceId === bootstrap.mesh.deviceKey.deviceId
    ? bootstrap.mesh.anchorIssuerKey ?? bootstrap.mesh.deviceKey
    : undefined;
  const anchorUninstall = ctx.meshRuntime && uninstallIssuerKey
    ? new AnchorUninstallCoordinator({
        log: lifecycleAuthorityLog,
        store: bootstrap.mesh.bootstrapStore,
        currentDeviceId: bootstrap.mesh.deviceKey.deviceId,
        issuerKey: uninstallIssuerKey,
        verifier: ctx.authorityRuntime!.verifier,
        anchorEpoch: () => ctx.authorityRuntime!.anchorEpoch,
        migrationTargets: () => ctx.meshRuntime!.plannedAnchorTargets(),
        commitMigration: async (input) => {
          await ctx.meshRuntime!.preparePlannedAnchorTransfer(input);
          await ctx.meshRuntime!.commitPlannedAnchorTransfer(input);
        },
        verifyMigration: async (targetDeviceId) => {
          const trust = await bootstrap.mesh.bootstrapStore.loadTrustRecord();
          if (
            !trust ||
            trust.issuer.deviceId !== targetDeviceId ||
            ctx.meshRuntime!.currentAnchorDeviceId() !== targetDeviceId
          ) {
            throw new Error("The new duty device installation is not current");
          }
        },
        retireMigratedDevice: (operationId) =>
          ctx.meshRuntime!.retireLocalDeviceAfterMigration({ operationId }),
        ...(ctx.authorityCheckpointOwner
          ? { checkpointOwner: ctx.authorityCheckpointOwner }
          : {}),
        closeAdmission: async () => {
          ctx.inboundRouter?.refuseNewMessages();
          await ctx.inboundRouter?.drainAcceptedMessages();
          await ctx.channelConnections?.disconnectConfigured();
          await ctx.deliveryStack?.quiesceForAuthorityTransfer();
          await schedulerRuntime?.scheduler.pauseForAuthorityTransfer();
        },
        releaseAdmission: async (operationId) => {
          await ctx.deliveryStack?.releaseLifecycleAdmission(operationId);
          await ctx.deliveryStack?.resumeAfterAuthorityTransfer();
          ctx.conversationProtocol?.startRecoveryLoop();
          schedulerRuntime?.scheduler.resumeAfterAuthorityTransfer();
          ctx.inboundRouter?.resumeNewMessages();
          await ctx.channelConnections?.connectConfigured();
        },
        recoveryAcceptedWork: {
          ports: acceptedWork,
          artifactStore: bootstrap.mesh.bootstrapStore.artifactStore(),
          closeAdmission: async (operationId) => {
            managedHostStopping = true;
            ctx.inboundRouter?.refuseNewMessages();
            ctx.executorJobOwner?.pauseAccepting();
            schedulerRuntime?.scheduler.closeAdmissionForLifecycle();
            ctx.deliveryStack?.closeAdmissionForLifecycle();
            await Promise.all([
              ctx.localConversationOwner?.closeHostStopAdmission(operationId),
              ctx.channelConnections?.suspendConfigured(),
            ]);
          },
          onFrozen: async (snapshot) => {
            const sources = hostStopDeliveryLifecycleSources(snapshot);
            await ctx.deliveryStack?.installLifecycleAdmission({
              operationId: snapshot.operationId,
              sources,
              deliveries: snapshot.owners.delivery,
            });
            await recoverStartupLifecycleAcceptedWork(sources);
          },
          flushDurableState: async () => {
            const [checkpoint, localOwnerDigest] = await Promise.all([
              lifecycleAuthorityLog.checkpoint(),
              ctx.localConversationOwner?.checkpointAcceptedWork(),
            ]);
            return [{
              kind: "accepted-work" as const,
              digest: protocolDigest("AnchorUninstallDurableFlush", 1, {
                lifecycle: checkpoint.prefixDigest,
                localOwner: localOwnerDigest ?? null,
              }),
            }];
          },
          settlePhysicalSteps: async () => {
            await ctx.authorityRuntime?.resourceGovernor.coordinate(async () => undefined);
          },
        },
        cleanupRecovery: cleanupLocalDevice,
        onRetired: finishLocalRetirement,
      })
    : undefined;
  await anchorUninstall?.resumeActive();
  if (localRetirementCompletedBeforeServerStart) {
    throw new Error("This device has completed local retirement and cannot start normally");
  }
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
    ...(scheduler ? { scheduler } : {}),
    conversations: ctx.conversations,
    advancement: ctx.advancement,
    advancementRecovery,
    perspectives: perspectivesController,
    conversationDirectory,
    workscenes: worksceneDirectory,
    trust: trustDirectory,
    skills: createSkillDirectory({
      globalState: () => authorityRuntime.globalState!,
      anchorEpoch: () => authorityRuntime.anchorEpoch,
    }),
    hostInfo: {
      // 宿主单点解析的工作区——接入面 @ 补全 root 取此
      workspace: ephemeralRuntime.resolvedWorkspace.path ?? undefined,
      logPath: daemonLogPath,
    },
    managedHostPublicStatus: () => buildManagedHostPublicStatus(
      { status: "running", phase: managedHostStopping ? "stopping" : "running" },
      { readiness: managedHostStopping ? "stopping" : "ready" },
    ),
    recoveryBackupStatus: async () => projectRecoveryBackupStatus(ctx.authorityCheckpointOwner
      ? await ctx.authorityCheckpointOwner.status()
      : { state: "not-configured" as const, fullBackupReady: false }),
    ...(anchorUninstall
      ? {
          anchorUninstall: {
            preflight: () => anchorUninstall.preflight(),
            begin: (input: Parameters<AnchorUninstallCoordinator["beginMigration"]>[0] & {
              readonly path?: "migration";
            } | Parameters<AnchorUninstallCoordinator["beginRecoveryBackup"]>[0] & {
              readonly path: "recovery-backup";
            }) => input.path === "recovery-backup"
              ? anchorUninstall.beginRecoveryBackup(input)
              : anchorUninstall.beginMigration(input),
            continue: (input: {
              readonly operationId: string;
              readonly confirmBackup: true;
              readonly recoveryPackage: string;
            }) => anchorUninstall.confirmRecoveryBackup(
              input.operationId,
              input.recoveryPackage,
            ),
            cancel: (input: { readonly operationId: string }) =>
              anchorUninstall.abort(input.operationId),
            status: (input: { readonly operationId: string }) =>
              anchorUninstall.state(input.operationId),
          },
        }
      : {}),
    ...(ctx.meshRuntime
      ? {
          dutyMigration: {
            targets: async () => ctx.meshRuntime!.plannedAnchorTargets(),
            prepare: async (input: {
              readonly requestId: string;
              readonly transferId: string;
              readonly targetDeviceId: string;
            }) => {
              await ctx.meshRuntime!.preparePlannedAnchorTransfer(input);
              return { stage: "ready" as const };
            },
            commit: async (input: { readonly requestId: string; readonly transferId: string }) => {
              await ctx.meshRuntime!.commitPlannedAnchorTransfer(input);
              return { stage: "completed" as const };
            },
            cancel: async (input: { readonly requestId: string; readonly transferId: string }) => {
              await ctx.meshRuntime!.abortPlannedAnchorTransfer(input);
              return { stage: "cancelled" as const };
            },
          },
          deviceLifecycle: {
            list: () => ctx.meshRuntime!.removableDevices(),
            remove: (input: {
              readonly requestId: string;
              readonly operationId: string;
              readonly targetName: string;
            }) => ctx.meshRuntime!.beginDeviceRemoval(input),
            continue: (input:
              | {
                  readonly targetName: string;
                  readonly mode: "transfer" | "destroy" | "lost";
                }
              | {
                  readonly targetName: string;
                  readonly mode: "cancel";
                  readonly operationId?: string;
                }) => ctx.meshRuntime!.continueDeviceRemoval(input),
            status: (input: {
              readonly targetName: string;
            }) => ctx.meshRuntime!.deviceRemovalStatus(input),
          },
        }
      : {}),
    // /mcp 状态显示与接入向导的宿主侧数据面(MCP 连接在宿主)
    mcpStatuses: () => mcpHub.serverStatuses(),
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
    // /task new·done 的执行体——写单点在宿主 task_list 服务,变更经
    // taskListService.subscribe 的组播自然回流接入面视图
    taskListUpdate: (conversationId, action) =>
      applyTaskListAction(
        builtinExtraTools.taskListService,
        conversationId,
        action,
      ),
    taskListSnapshot: async (conversationId) => {
      await builtinExtraTools.taskListService.prime(conversationId);
      return builtinExtraTools.taskListService.getCached(conversationId);
    },
    channels: ctx.channels,
    channelHttpRoutes,
    confirmationHub,
    ...(adoptionReview
      ? {
          conversationAdoptionReview: (
            input: Parameters<PostAdoptionReviewCoordinator["reviewForSurface"]>[0],
          ) =>
            adoptionReview!.reviewForSurface(input),
        }
      : {}),
    runtimeControl: {
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
      conversationFinalHistory: async (conversationId, afterCommitRevision) =>
        (await ctx.conversationProtocol?.finalHistory(
          conversationId,
          afterCommitRevision,
        ) ?? []).map(({ frame, publishResults }) => ({ frame, publishResults })),
      jobStatus: (after) =>
        ctx.jobStatus?.statusHistory(after) ??
        Promise.resolve({ notices: [], next: [] }),
      schedulerNotices: (afterRevision) =>
        ctx.jobStatus?.schedulerHistory(afterRevision) ??
        Promise.resolve({ notices: [], nextRevision: afterRevision }),
      resolveDelivery: async (input) => {
        if (!ctx.deliveryStack) throw new Error("Delivery stack is unavailable");
        return ctx.deliveryStack.resolve({
          requestId: input.requestId,
          source: { principal: input.principal },
          body: {
            t: "delivery-resolve",
            itemId: input.itemId,
            attempt: input.attempt,
            anchorEpoch: input.anchorEpoch,
            openFactDigest: input.openFactDigest,
            decision: input.decision,
          },
        });
      },
      beginDrain: async () => {
        managedHostStopping = true;
        ctx.inboundRouter?.refuseNewMessages();
        await ctx.channelConnections?.disconnectConfigured();
        await ctx.deliveryStack?.quiesceForAuthorityTransfer();
        await schedulerRuntime?.scheduler.pauseForAuthorityTransfer();
      },
      drainAcceptedWork: async () => {
        await ctx.inboundRouter?.drainAcceptedMessages();
        await ctx.executorJobOwner?.drain();
      },
      flushDelivery: async () => {
        await ctx.deliveryStack?.flush();
      },
    },
    lifecycleShutdown: stopCoordinator,
  });
  if (ctx.meshRuntime) {
    ctx.meshRuntime.bindFirstPartyConversationSurface({
      dispatch: ({ method, params, connection }) =>
        serverRegistry.dispatchCanonical(method, params, {
          connection,
          server: serverCtx,
        }),
    });
  }

  if (ctx.authorityCheckpointOwner) {
    const checkpointOwner = ctx.authorityCheckpointOwner;
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "authorityCheckpointOwner.stop" }, async () => {
      await checkpointOwner.stop();
    });
  }

  ctx.deliveryStack?.onStatus((notice) => {
    serverCtx.broadcastAll?.("delivery.status", notice);
  });

  // runServer 之前：尾部清理（LIFO 最后执行 —— releaseLock / state 文件）
  registerTailCleanup(registry, { stateFile, heartbeatTimerRef, lockPaths });

  // runServer —— 内部会向 registry 注册 server.close（注入模式）
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
    ...(scheduler ? { scheduler } : {}),
    schedulerEventBus,
    cleanupRegistry: registry,
    lockPaths, // 与 registerTailCleanup 使用同一引用——acquire/release 路径一致
    processInfo: {
      version: SERVER_VERSION,
      kind: processMode,
      logPath: daemonLogPath,
      startTime: processStartTime,
      startedAt: processStartedAt,
    },
    logger: {
      info: (msg) => console.log(chalk.dim(`[server] ${msg}`)),
      warn: (msg) => console.warn(chalk.yellow(`[server] ${msg}`)),
      error: (msg) => console.error(chalk.red(`[server] ${msg}`)),
    },
  });
  anchorInternalStop.current = createAnchorInternalStopPort({
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

  // 组播设施已由 startServer 回填到 serverCtx —— 接通带外事件转发的 lazy ref。
  sessionBroadcastRef.current = serverCtx.sessionBroadcast ?? null;
  sessionActivityBroadcastRef.current =
    serverCtx.sessionActivityBroadcast ?? null;

  // External handlers and transports become active only after the product
  // ingress is listening; preparation above is intentionally side-effect free.
  ctx.deliveryStack?.activate();
  if (!startupLifecycle) schedulerRuntime?.activate();

  // runServer resolve 后填 runner，供 post-server 接入面读 server.connections。
  ctx.runner = runner;
  if (!startupLifecycle || startupLifecycleFrozenRecoveryStarted) {
    await schedulerRuntime?.resumeManualJobSurfaces();
  }

  // runServer 之后：核心资源清理（LIFO 最先执行 —— markStopping / scheduler / channels /
  // delivery / heartbeat）。接入面产物（channels / deliveryStack）从 ctx 取。
  registerCoreCleanup(registry, {
    stateFile,
    heartbeatTimerRef,
    authorityRuntime: ctx.authorityRuntime,
    channels: ctx.channels,
    deliveryStack: ctx.deliveryStack,
    mcpHub: builtinExtraTools.mcpHub,
    startupCleanups: {
      authorityRuntime: startupCleanups.authorityRuntime,
      localWorkspaceHost: startupCleanups.localWorkspaceHost,
      localConversationOwner: startupCleanups.localConversationOwner,
      channels: startupCleanups.channels,
      deliveryStack: startupCleanups.deliveryStack,
      mcp: startupCleanups.mcp,
    },
  });

  // post-server 接入面：confirmationBridge（依赖 runner.server.connections，在自己 setup 内
  // 注册 dispose 到 ctx.cleanup —— LIFO 落在 registerCoreCleanup 之后、即更先执行）。
  await setupAssemblyUnits(assemblyUnits, ctx, "post-server");

  // pre-server 接入面 teardown —— 时序硬约束（必须在 server.close 之前 = runServer 之后注册）
  // 决定它们不能在自己 setup 内自注册，故由主干用 ctx 产物注册到 shutdown-chain。LIFO 顺序：
  //   后注册 = 更先执行。以下三项都在 registerCoreCleanup 之后注册，先于核心资源清理执行。

  if (ctx.meshRuntime) {
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "meshRuntime.stop" }, async () => {
      await startupCleanups.meshRuntime!.run();
    });
  }

  if (ctx.executorDataPlane) {
    registerCleanup(registry, { owner: "anchor-local-executor", role: "runtime", id: "executorDataPlane.close" }, async () => {
      await startupCleanups.executorDataPlane!.run();
    });
  }

  if (ctx.jobStatus) {
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "jobStatus.dispose" }, async () => {
      await startupCleanups.jobStatus!.run();
    });
  }

  if (ctx.assetMaintenance) {
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "assetMaintenance.stop" }, async () => {
      await startupCleanups.assetMaintenance!.run();
    });
  }

  if (ctx.executorJobOwner) {
    registerCleanup(registry, { owner: "anchor-local-executor", role: "runtime", id: "executorJobOwner.close" }, async () => {
      await startupCleanups.jobOwner!.run();
    });
  }

  // 无损会话先于其依赖的 mesh / executor / channel 关停；下方执行 drain
  // 更晚注册，仍会先停止新工作并收束在途执行。
  if (ctx.losslessDataPlane) {
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "losslessDataPlane.close" }, async () => {
      await startupCleanups.losslessDataPlane!.run();
    });
  }

  // 远程中断模块关停链 —— LIFO 最先执行（在 channels.dispose / scheduler.stop / server.close 之前）：
  //   1. inboundRouter.refuseNew  拒新入站，避免下游 drain 期间又来新消息
  //   2. conversationProtocol.stopRecovery  等恢复协调器静默，禁止 drain 后再生任务
  //   3. execution.abortAllAndWait  并行 fire abort + 等所有 in-flight 走完 cleanup
  //                                 （partial yields + RunResult + 取消反馈）
  // 必须 await drain —— 没有它 server.close / channels.dispose 抢断 partial 流和取消反馈，
  // 违反"关停期反馈不丢"。30s 总超时兜底由 abortAllAndWait 自身实现，超时不抛直接进下一步。
  registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "execution.abortAllAndWait" }, async () => {
    await Promise.all([
      ...(ctx.conversations
        ? [
            ctx.conversations.abortAllAndWait(
              { kind: "external", origin: "scheduler-shutdown" },
              30_000,
            ),
          ]
        : []),
    ]);
  });

  if (ctx.conversationProtocol) {
    const protocol = ctx.conversationProtocol;
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "conversationProtocol.stopRecovery" }, async () => {
      await protocol.stopRecoveryLoop();
    });
  }

  // Scheduler owns trigger admission and job recovery loops. Stop it before
  // executor/job/channel owners are released so no new occurrence can enter
  // while every accepted assignment is already durable and restartable.
  if (schedulerCleanup) {
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "scheduler.stop" }, async () => {
      await schedulerCleanup!.run();
    });
  }

  if (ctx.inboundRouter) {
    const router = ctx.inboundRouter;
    registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "inboundRouter.refuseNew" }, () => {
      router.refuseNewMessages();
    });
  }

  if (ctx.evidenceHandler) {
    const evidenceHandler = ctx.evidenceHandler;
    registerCleanup(registry, { owner: "anchor-local-executor", role: "runtime", id: "evidenceHandler.stopAccepting" }, () => {
      evidenceHandler.stopAccepting();
    });
  }

  // 正常停机链已经完整接管所有已取得资源；启动补偿事务不再持有独立责任。
  startupRollback.commit();

  // Post-runServer 启动步骤（startup guard 包裹）
  //   不变量：runServer 已 resolve → server listening + PID 锁持有 + registry 全注册完毕。
  //   此后若任何步骤抛错（markReady / banner 等），必须走 runner.shutdown 让 registry 完整跑完，
  //   否则后台 child 会孤儿化 + PID 锁/state 文件残留 —— 下次启动被假 "already running" 误挡。
  try {
    // All listener owners publish the same local generation; only background
    // startup uses the separate ready marker handshake.
    // 紧邻调用：running 才是稳态；ready 仅作为 .ready marker 的语义锚点
    await stateFile.markReady({
      pid: process.pid,
      startedAt: processStartedAt,
      port: runner.server.port,
      host: runner.server.host,
    });
    await stateFile.markRunning();
    const hbTimer = setInterval(() => {
      void stateFile.heartbeat();
    }, 60_000);
    hbTimer.unref();
    heartbeatTimerRef.current = hbTimer;

    if (processMode !== "managed") {
      console.log();
      console.log(chalk.green("  知行服务已启动"));
      console.log(chalk.dim(`  HTTP:      http://${runner.server.host}:${runner.server.port}`));
      console.log(chalk.dim(`  WebSocket: ws://${runner.server.host}:${runner.server.port}/ws`));
      console.log(chalk.dim(`  Token:     ${tokenInfo.path}`));
      if (ctx.channels) {
        const statuses = ctx.channels.listStatuses();
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
  } catch (err) {
    // Post-runServer startup 失败 → runner.shutdown 让 registry 跑完（release lock / close server / stop scheduler 等）
    // runner.shutdown 幂等 + 内部吞错，保证资源最大化回收
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Startup failed after server listening: ${msg}`));
    await runner.shutdown("startup-error").catch(() => {});
    throw err;
  }

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
    const idleTimer = setInterval(() => {
      const exit = shouldIdleExit({
        connectionCount: runner!.server.connections.size,
        channelStates:
          ctx.channels?.listStatuses().map((s) => s.state) ?? [],
        hasUserPendingWork:
          scheduler?.listTasks().some((t) => !isInternal(t) && t.enabled) ?? false,
      });
      if (exit) {
        void requestAnchorInternalStop({ reason: "idle", strategy: "drain" })
          .catch((error) => {
            console.error(
              chalk.red("[idle] durable Host stop failed; the same operation will retry"),
              error instanceof Error ? error.message : String(error),
            );
          });
      }
    }, IDLE_CHECK_MS);
    idleTimer.unref();
    registerCleanup(
      registry,
      { owner: "anchor-host", role: "runtime", id: "idleReaper.clear" },
      () => clearInterval(idleTimer),
    );
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
