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
  JsonTaskStore,
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
  JournalStore,
  ConversationRepository,
  parseConversationId,
  ShardedTranscriptStore,
  SnapshotStore,
  SkillStore,
  conversationsDir,
  runRetentionSweep,
  getWorkScenesRoot,
  getWorkSceneConversationsRoot,
} from "@zhixing/core";
import {
  createServerContext,
  runServer,
  buildSystemHandlers,
  DEFAULT_SERVER_CONFIG,
  ServerStateFile,
  ServerLogLifecycle,
  CleanupRegistry,
  createAdvancementEventSink,
  createAdvancementProxyTurnPort,
  LlmPerspectiveAllocationStrategy,
  PerspectivesController,
  RuntimePerspectivesOrchestrationExecutor,
  getDefaultLogPath,
  type RunningServer,
  type ProcessLockPaths,
} from "@zhixing/server";
import {
  AnchorSchedulerGlobalStateAdapter,
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
import {
  createAdvancementRecoveryMaintenance,
  renderRecentContextFromMessages,
  type AdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import fsp from "node:fs/promises";
import chalk from "chalk";
import {
  RuntimeHost,
  createBuiltinExtraToolsAssembly,
  createTransientSegmentDeps,
} from "@zhixing/runtime-host";
import type {
  ExecutorRoleModule,
  ServeBootstrapContext,
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
  createMemoryDirectory,
} from "./management-directories.js";
import { loadOrCreateToken } from "./token.js";
import { isDaemonChild } from "./self-exec.js";
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
  governControlTextCall,
  type GovernedTextCall,
} from "./governed-control-llm.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { createAgentJobRuntimePort } from "./agent-job-runtime.js";
import { AnchorSchedulerRuntime } from "./anchor-scheduler-runtime.js";

const SERVER_VERSION = ZHIXING_CLI_VERSION;

export interface ServeOptions {
  port?: number;
  host?: string;
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
  executor?: ExecutorRoleModule,
): Promise<void> {
  await runServerProcess(opts, bootstrap, executor);
}

async function runServerProcess(
  opts: ServeOptions,
  bootstrap: ServeBootstrapContext,
  executor: ExecutorRoleModule | undefined,
): Promise<void> {
  const startupRollback = new StartupRollback();
  let startupRegistry: CleanupRegistry | undefined;
  let runner: RunningServer | undefined;
  try {
  const profile: ServerProfile = DEFAULT_PROFILE;
  const zhixingHome = getZhixingHome();
  const deviceCapacity = bootstrap.deviceCapacity;
  const isChild = isDaemonChild();
  const daemonLogPath = isChild ? getDefaultLogPath() : undefined;
  const serverLogLifecycle = isChild
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
  if (tokenInfo.generated) {
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
  // 管理面三域——trust(盘上持久规则)/ memory(只读查看);skill 目录在
  // serveSkillStore 创建后装配(共享同一锁域与结构版本)。
  const trustDirectory = createTrustDirectory({
    config,
  });
  const memoryDirectory = createMemoryDirectory();

  // 3. Scheduler facade lazy ref —— 打破组合根装配顺序依赖。
  let schedulerRef: SchedulerBackend | null = null;
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

  // 3c''. 技能库 —— serve 全部 runtime(per-session + ephemeral)共享单实例:
  //   索引重建靠 store 内存结构版本比对,实例分散会让"会话 A 经 save_skill
  //   存技能、会话 B 下窗不知道"(各自版本各自计);共享后任一保存,全部
  //   runtime 下个窗口换代即见。磁盘本就同一目录,共享无额外耦合。
  const serveSkillStore = new SkillStore();
  const providerCredentials = credentials.providers
    ? { providers: credentials.providers }
    : {};
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
    deviceCapacity: deviceCapacity.workload("workload-advancement"),
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
    skillStore: serveSkillStore,
    segmentDeps: serveSegmentDeps,
    deviceCapacity: {
      interactive: deviceCapacity.workload("workload-interactive"),
      scheduler: deviceCapacity.workload("workload-scheduler"),
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

  // 4. CleanupRegistry —— 唯一清理出口。LIFO 语义 + 跨包注入。注册序列封装在
  //    shutdown-chain.ts，方便单测顺序正确性。post-server 接入面在自己 setup 内注册到此。
  const registry = new CleanupRegistry({
    logger: {
      info: (msg) => console.log(chalk.dim(`[cleanup] ${msg}`)),
      error: (msg, err) =>
        console.error(chalk.red(`[cleanup] ${msg}`), err instanceof Error ? err.message : err),
    },
  });
  startupRegistry = registry;
  if (serverLogLifecycle) {
    registry.register("serverLogLifecycle.stop", () => serverLogCleanup!.run());
  }

  // 4a. Daemon child 才启用 ServerStateFile——前台模式不写 state 文件
  const stateFile = isChild ? new ServerStateFile() : undefined;
  const heartbeatTimerRef: { current: NodeJS.Timeout | null } = { current: null };

  // lockPaths —— 单一事实源。同时传给 runServer（acquireLock）和 registerTailCleanup（releaseLock），
  // 保证 acquire/release 走同一路径。当前 undefined = 默认 ~/.zhixing/server.pid。
  const lockPaths: ProcessLockPaths | undefined = undefined;

  // ============================================================================
  // 有序装配 —— 稳定核心单元恒启用，profile 仅选择可选接入面；setupAssemblyUnits
  // 按依赖拓扑序遍历、各自 setup（产物写回 ctx）。主干不出现任何 `if (profile === ...)`。
  // ============================================================================
  // journal 域仓——turn 后维护(conversation 接入面)与系统维护任务共用。
  const journalStore = new JournalStore();
  const startupCleanups: AssemblyContext["startupCleanups"] = {};
  const channelHttpRoutes: AssemblyContext["channelHttpRoutes"] = new Map();

  const ctx: AssemblyContext = {
    profile,
    config,
    zhixingHome,
    secretStore: startupResult.secretStore,
    durableInteractions,
    perspectives: perspectivesController,
    deviceCapacity: deviceCapacity.arbiter,
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
    conversationAuthorityRef,
    worksceneDirectory,
    journalStore,
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
  };

  // pre-server 接入面：MCP（connectAll）/ 会话执行面 / 无损数据面 / 通道门面 / 投递栈。
  // 产物写回 ctx.conversations / losslessDataPlane / channels / inboundRouter / deliveryStack。
  await setupAssemblyUnits(assemblyUnits, ctx, "pre-server");
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
    journal: {
      runJournalLifecycle: async () => {
        const expired = await journalStore.expireOld();
        const plan = await journalStore.scan();
        return {
          condensed: plan.condensePlan?.months.length ?? 0,
          expired: expired.deleted,
        };
      },
    },
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
  let schedulerCleanup: ReturnType<StartupRollback["register"]> | undefined;
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
    schedulerRuntime = await AnchorSchedulerRuntime.create({
      authority: ctx.authorityRuntime,
      protocol: ctx.conversationProtocol,
      eventBus: schedulerEventBus,
      compatibilityStore: new JsonTaskStore(),
      jobStatus: ctx.jobStatus,
      jobRelays: ctx.jobRelayObligations,
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
            const connections = runner?.server.connections;
            const recipients = connections
              ? [...connections].filter(
                  (connection) => connection.authenticated && !connection.closed,
                )
              : [];
            if (recipients.length === 0) {
              throw new Error("Manual job surface is disconnected");
            }
            for (const connection of recipients) {
              connection.notify(SESSION_NOTIFICATIONS.assignmentStream, frame);
            }
          },
        });
        session.start();
      },
      ...(ctx.executorJobOwner ? { localJobOwner: ctx.executorJobOwner } : {}),
      mesh: () => ctx.meshRuntime,
      capabilities: runtimeHost.capabilityCatalog(),
      systemHandlers,
      systemTasks: new Map([
        [
          "__journal-gc",
          {
            id: "__journal-gc",
            name: "journal-gc",
            handler: "__journal-gc",
            schedule: { kind: "cron", expr: "0 3 * * *" },
          },
        ],
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
      migrateLegacyDelivery: async (delivery, taskId) => {
        if (!delivery) return undefined;
        if (delivery.kind === "none") return { kind: "none" };
        if (delivery.kind === "channel") {
          return {
            kind: "channel",
            channel: delivery.channel,
            to: delivery.to,
            ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
          };
        }
        if ("endpoint" in delivery) {
          return { kind: "webhook", endpoint: delivery.endpoint };
        }
        const legacy = delivery as unknown as {
          readonly url: string;
          readonly headers?: Readonly<Record<string, string>>;
        };
        const endpoint = {
          kind: "webhook" as const,
          bindingId: `scheduler/${taskId}/webhook`,
        };
        await startupResult.secretStore.put(
          endpoint,
          JSON.stringify({ url: legacy.url, headers: legacy.headers ?? {} }),
        );
        return { kind: "webhook", endpoint };
      },
      onError: (error) =>
        console.error(chalk.red(`[scheduler] ${error.message}`)),
    });
    const runtime = schedulerRuntime;
    schedulerCleanup = startupRollback.register(
      "scheduler.stop",
      () => runtime.stop(),
    );
    schedulerRef = runtime.scheduler;
    schedulerFacadeRef = new LocalSchedulerFacade(
      runtime.scheduler,
      schedulerEventBus,
    );
    ctx.authorityRuntime.installSchedulerGlobalState(
      new AnchorSchedulerGlobalStateAdapter(
        runtime.scheduler,
        ctx.authorityRuntime.anchorEpoch,
      ),
    );
    await runtime.start();
  }
  const scheduler = schedulerRuntime?.scheduler;

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
          events: createAdvancementEventSink(
            () => sessionBroadcastRef.current,
          ),
          logger: console,
        })
      : undefined;
  advancementRecoveryRef.current = advancementRecovery ?? null;

  const serverCtx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    ...(scheduler ? { scheduler } : {}),
    conversations: ctx.conversations,
    advancement: ctx.advancement,
    advancementRecovery,
    perspectives: perspectivesController,
    conversationDirectory,
    workscenes: worksceneDirectory,
    trust: trustDirectory,
    skills: createSkillDirectory({ skillStore: serveSkillStore }),
    memory: memoryDirectory,
    hostInfo: {
      // 宿主单点解析的工作区——接入面 @ 补全 root 取此
      workspace: ephemeralRuntime.resolvedWorkspace.path ?? undefined,
      logPath: daemonLogPath,
    },
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
      jobStatus: (after) =>
        ctx.jobStatus?.statusHistory(after) ??
        Promise.resolve({ notices: [], next: [] }),
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
      flushDelivery: async () => {
        await ctx.deliveryStack?.flush();
      },
    },
  });

  ctx.deliveryStack?.onStatus((notice) => {
    serverCtx.broadcastAll?.("delivery.status", notice);
  });

  // runServer 之前：尾部清理（LIFO 最后执行 —— releaseLock / state 文件）
  registerTailCleanup(registry, { stateFile, heartbeatTimerRef, lockPaths });

  // runServer —— 内部会向 registry 注册 server.close（注入模式）
  runner = await runServer({
      context: serverCtx,
      ...(scheduler ? { scheduler } : {}),
      schedulerEventBus,
      cleanupRegistry: registry,
      lockPaths, // 与 registerTailCleanup 使用同一引用——acquire/release 路径一致
      processInfo: {
        version: SERVER_VERSION,
        logPath: daemonLogPath,
      },
      logger: {
        info: (msg) => console.log(chalk.dim(`[server] ${msg}`)),
        warn: (msg) => console.warn(chalk.yellow(`[server] ${msg}`)),
        error: (msg) => console.error(chalk.red(`[server] ${msg}`)),
      },
    });

  // 组播设施已由 startServer 回填到 serverCtx —— 接通带外事件转发的 lazy ref。
  sessionBroadcastRef.current = serverCtx.sessionBroadcast ?? null;
  sessionActivityBroadcastRef.current =
    serverCtx.sessionActivityBroadcast ?? null;

  // runServer resolve 后填 runner，供 post-server 接入面读 server.connections。
  ctx.runner = runner;
  await schedulerRuntime?.resumeManualJobSurfaces();

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
    registry.register("meshRuntime.stop", async () => {
      await startupCleanups.meshRuntime!.run();
    });
  }

  if (ctx.executorDataPlane) {
    registry.register("executorDataPlane.close", async () => {
      await startupCleanups.executorDataPlane!.run();
    });
  }

  if (ctx.jobStatus) {
    registry.register("jobStatus.dispose", async () => {
      await startupCleanups.jobStatus!.run();
    });
  }

  if (ctx.assetMaintenance) {
    registry.register("assetMaintenance.stop", async () => {
      await startupCleanups.assetMaintenance!.run();
    });
  }

  if (ctx.executorJobOwner) {
    registry.register("executorJobOwner.close", async () => {
      await startupCleanups.jobOwner!.run();
    });
  }

  // 无损会话先于其依赖的 mesh / executor / channel 关停；下方执行 drain
  // 更晚注册，仍会先停止新工作并收束在途执行。
  if (ctx.losslessDataPlane) {
    registry.register("losslessDataPlane.close", async () => {
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
  registry.register("execution.abortAllAndWait", async () => {
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
    registry.register("conversationProtocol.stopRecovery", async () => {
      await protocol.stopRecoveryLoop();
    });
  }

  // Scheduler owns trigger admission and job recovery loops. Stop it before
  // executor/job/channel owners are released so no new occurrence can enter
  // while every accepted assignment is already durable and restartable.
  if (schedulerCleanup) {
    registry.register("scheduler.stop", async () => {
      await schedulerCleanup!.run();
    });
  }

  if (ctx.inboundRouter) {
    const router = ctx.inboundRouter;
    registry.register("inboundRouter.refuseNew", () => {
      router.refuseNewMessages();
    });
  }

  // 正常停机链已经完整接管所有已取得资源；启动补偿事务不再持有独立责任。
  startupRollback.commit();

  if (advancementRecovery) {
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
  }

  // Post-runServer 启动步骤（startup guard 包裹）
  //   不变量：runServer 已 resolve → server listening + PID 锁持有 + registry 全注册完毕。
  //   此后若任何步骤抛错（markReady / banner 等），必须走 runner.shutdown 让 registry 完整跑完，
  //   否则后台 child 会孤儿化 + PID 锁/state 文件残留 —— 下次启动被假 "already running" 误挡。
  try {
    // markReady + markRunning + heartbeat（仅后台 child）
    // 紧邻调用：running 才是稳态；ready 仅作为 .ready marker 的语义锚点
    if (stateFile) {
      await stateFile.markReady({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        port: runner.server.port,
        host: runner.server.host,
      });
      await stateFile.markRunning();
      const hbTimer = setInterval(() => {
        void stateFile.heartbeat();
      }, 60_000);
      hbTimer.unref();
      heartbeatTimerRef.current = hbTimer;
    }

    // 启动横幅
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
  if (isChild) {
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
        serverCtx.requestShutdown?.("idle");
      }
    }, IDLE_CHECK_MS);
    idleTimer.unref();
    registry.register("idleReaper.clear", () => clearInterval(idleTimer));
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
