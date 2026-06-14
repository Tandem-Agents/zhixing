/**
 * `zhixing serve` 命令 — 启动常驻服务（核心宿主）
 *
 * 核心宿主 = 恒定核心（runtime + 会话态 owner 位 + Scheduler + RPC server）+ 一组**可挂载的
 * 接入面**（access surface）。装配主干：
 *   1. 备齐恒定核心前置（token / transcript / confirmationHub / mcpHub / builtinExtraTools /
 *      runtimeFactory / CleanupRegistry）—— 接入面 setup 从这里读依赖
 *   2. 建 AssemblyContext，`setupAccessSurfaces(pre-server)` 数据驱动装入 profile 启用的接入面
 *      （MCP / 会话执行面 / 通道 / 投递栈 / 文本确认渲染器，产物写回 ctx）
 *   3. 恒定核心后置（ephemeralRuntime / runAgentTurn / systemHandlers）—— ephemeralRuntime 消费
 *      mcp 接入面 connectAll 后的工具目录，故排在 pre-server 接入面之后构造
 *   4. 构造核心 Scheduler（读 ctx.deliveryStack）+ start + seed 系统任务
 *   5. createServerContext + runServer
 *   6. `setupAccessSurfaces(post-server)`（confirmationBridge，依赖 runServer 后的 connections）
 *   7. registerCoreCleanup 用接入面产物注册 teardown（shutdown-chain，LIFO）
 *   8. banner / idle reaper / waitForShutdown
 *
 * profile 不"砍主干"，只声明启用哪组接入面（见 PROFILES 描述符）；新增接入面 = 写一个
 * AccessSurface 单元 + 在集合加名字，装配主干一行不改。接入面体系详见 access-surface.ts。
 */

import {
  Scheduler,
  JsonTaskStore,
  RunRegistry,
  computeStatusSummary,
  isInternal,
  createEventBus,
  generateTurnId,
  getZhixingHome,
  type AgentTurnParams,
  type SchedulerEventMap,
  type AgentTurnResult,
  type SchedulerFacade,
  LocalSchedulerFacade,
  type TurnContext,
  JournalStore,
  ConversationRepository,
  FsWorkSceneRegistry,
  parseConversationId,
  WORKSCENE_CONVERSATION_PREFIX,
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
  ConfirmationHub,
  DEFAULT_SERVER_CONFIG,
  ServerStateFile,
  CleanupRegistry,
  createRunEventForwarder,
  getDefaultLogPath,
  SESSION_NOTIFICATIONS,
  type SessionChangedPayload,
  type SessionBroadcast,
  type RunningServer,
  type ProcessLockPaths,
  type ConversationManager,
} from "@zhixing/server";
import type {
  ZhixingConfig,
  ZhixingCredentials,
} from "@zhixing/providers";
import fsp from "node:fs/promises";
import { runStartupCheck } from "../startup.js";
import chalk from "chalk";
import { RuntimeHost } from "../runtime/runtime-host.js";
import { createRenderSubscribers } from "../render.js";
import { createStdoutWriter } from "../screen/index.js";
import {
  createBlockedRenderer,
} from "../security/index.js";
import { createMcpHub } from "@zhixing/mcp";
import { createBuiltinExtraToolsAssembly } from "../runtime/builtin-extra-tools.js";
import { createServeSegmentDeps } from "../runtime/segment-deps.js";
import { parseServerSpecs } from "../runtime/mcp-config.js";
import {
  RoutedConversationRepoTaskListStore,
  type ConversationRepoTaskListRoute,
} from "../runtime/task-list-stores.js";
import { registerCliTurnContextProviders } from "../runtime/turn-context-providers.js";
import { applyTaskListAction } from "../runtime/task-list-actions.js";
import { createCliRuntimeFactory } from "./session-adapter.js";
import { createConversationDirectory } from "./conversation-directory.js";
import { createWorksceneDirectory } from "./workscene-directory.js";
import {
  createTrustDirectory,
  createSkillDirectory,
  createMemoryDirectory,
} from "./management-directories.js";
import { runEphemeralTurn } from "./ephemeral-executor.js";
import { loadOrCreateToken } from "./token.js";
import { isDaemonChild } from "./self-exec.js";
import { spawnDaemon } from "./daemon.js";
import { homeToPort } from "./host-port.js";
import { registerTailCleanup, registerCoreCleanup } from "./shutdown-chain.js";
import { shouldIdleExit } from "./idle-policy.js";
import { setupAccessSurfaces, type AssemblyContext } from "./access-surface.js";
import { DEFAULT_PROFILE, type ServerProfile } from "./profile.js";
import { ACCESS_SURFACES } from "./access-surfaces.js";
import { ZHIXING_CLI_VERSION } from "../version.js";

const SERVER_VERSION = ZHIXING_CLI_VERSION;

export interface ServeOptions {
  port?: number;
  host?: string;
  /** 后台模式：父进程 spawn 一个 detached child 并握手确认就绪 */
  daemon?: boolean;
}

/**
 * `zhixing serve` 入口。
 *
 * 三种进入方式：
 * 1. 前台 (`zhixing serve`) → 直接跑 server 逻辑（现状）
 * 2. 父进程 (`zhixing serve --daemon`，非 child) → spawn daemon child 后返回
 * 3. Daemon child (env `ZHIXING_DAEMON_CHILD=1`) → 跟前台一样跑 server，但 stdio
 *    已被父进程重定向到 log 文件
 *
 * 分支 1 和 3 走同一条代码路径——server 本身不感知 daemon 概念。
 */
export async function runServeCommand(opts: ServeOptions): Promise<void> {
  // 分支 2：父进程需要 fork 出 detached child
  if (opts.daemon && !isDaemonChild()) {
    const forwardedArgs = buildForwardedArgs(opts);
    const result = await spawnDaemon({ forwardedArgs });
    if (!result.ok) {
      process.exit(1);
    }
    return; // 父进程退出，child 继续运行
  }

  // 分支 1 + 3：实际 server 运行
  await runServerProcess(opts);
}

/**
 * 从 ServeOptions 重建传给 child 的 argv（不含 --daemon，child 应走分支 1）。
 */
function buildForwardedArgs(opts: ServeOptions): string[] {
  const args: string[] = ["serve"];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  if (opts.host) args.push("--host", opts.host);
  return args;
}

async function runServerProcess(opts: ServeOptions): Promise<void> {
  const profile: ServerProfile = DEFAULT_PROFILE;
  const zhixingHome = getZhixingHome();
  // 端口按 home 派生（同 home 同端口 → listen 的 EADDRINUSE 原子仲裁单例 + 并发安全；
  // 不同 home 不同端口 → 多实例并行不撞）。用户显式 --port 覆盖。
  const port = opts.port ?? homeToPort(zhixingHome);
  const host = opts.host ?? DEFAULT_SERVER_CONFIG.host;

  // 启动期检查——加载 config + credentials、校验 schema,只校 model(messaging
  // 可选,凭证不全由 channel 装配警告跳过)。缺字段且 TTY 触发配置编辑器,否则 fail-fast。
  const startupResult = await runStartupCheck({ mode: "host" });

  if (startupResult.kind !== "ready") {
    if (startupResult.kind === "schema-error") {
      console.error(chalk.red(`[配置错误] ${startupResult.message}`));
      console.error(chalk.dim(`请修复或删除文件后重试：${startupResult.filePath}`));
    } else if (startupResult.kind === "semantic-error") {
      console.error(
        chalk.red(
          `[配置错误] ${startupResult.filePath} 含 ${startupResult.issues.length} 处废弃字段：`,
        ),
      );
      console.error("");
      for (const [index, issue] of startupResult.issues.entries()) {
        console.error(chalk.yellow(`${index + 1}. 字段：${issue.field}`));
        console.error(chalk.dim(`   原因：${issue.reason}`));
        console.error(chalk.dim(`   修复：${issue.fix}`));
        console.error("");
      }
      console.error(chalk.dim("修复后重启 server。"));
    } else if (startupResult.kind === "non-tty") {
      console.error(chalk.red("Server 缺少必要配置，且当前环境非交互终端。"));
      console.error(
        chalk.dim("请先在交互终端运行 `zhixing` 完成基础配置。缺失项："),
      );
      for (const label of startupResult.missingLabels) {
        console.error(chalk.dim(`  - ${label}`));
      }
    } else if (startupResult.kind === "cancelled") {
      console.log(chalk.dim("已取消配置。"));
      process.exit(0);
    }
    process.exit(2);
  }

  const config: ZhixingConfig = startupResult.config;
  const credentials: ZhixingCredentials = startupResult.credentials;

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
  // 对话目录(盘上事实:清单 / 建删 / 改名 / 清空 / 倒读)——session.* 命令
  // 执行体的持久层,与 REPL 同 scope(同 home 同目录)。task_list cache 清理
  // 经 lazy 闭包接 builtinExtraTools(声明在后,运行期调用时已就位)。
  const conversationDirectory = createConversationDirectory({
    repo: convRepo,
    transcript,
    repoForConversationId,
    clearTaskListCache: (conversationId) =>
      builtinExtraTools.taskListService.clear(conversationId),
  });
  // 工作场景域——注册表单例(管理面 + factory 的场景装配路由共用)与场景对话取建。
  const workSceneRegistry = new FsWorkSceneRegistry();
  const worksceneDirectory = createWorksceneDirectory({
    registry: workSceneRegistry,
  });
  // 管理面三域——trust(盘上持久规则)/ memory(只读查看);skill 目录在
  // serveSkillStore 创建后装配(共享同一锁域与结构版本)。
  const trustDirectory = createTrustDirectory({
    config,
  });
  const memoryDirectory = createMemoryDirectory();

  // ConversationManager lazy ref——会话执行面(access surface)setup 后回填;
  // workModeController 的删除守卫运行期读(LLM 工具调用必晚于装配完成)。
  const conversationsRef: { current: ConversationManager | null } = {
    current: null,
  };

  // 3. Scheduler facade lazy ref —— 打破循环依赖（标准 IoC 模式）：
  //    scheduleTool → Scheduler → runAgentTurn → ephemeralRuntime → scheduleTool
  let schedulerRef: Scheduler | null = null;
  // schedule 工具经门面接入——daemon 内直调本进程 Scheduler（LocalSchedulerFacade，恒定核心）。
  // 实例化落点在核心 Scheduler 创建之后（见下）。getSchedulerFacade 惰性返回：会话执行面
  // （per-session runtimeFactory，装配早于 scheduler）与 ephemeralRuntime 的 schedule 工具
  // 都经它共用同一实例、直调同一本进程 Scheduler——工具 call 必在 daemon 跑起来后、ref 已就位。
  let schedulerFacadeRef: LocalSchedulerFacade | null = null;
  const getSchedulerFacade = (): SchedulerFacade => {
    if (!schedulerFacadeRef) throw new Error("Scheduler not initialized yet");
    return schedulerFacadeRef;
  };

  // serve 模式无 spinner —— 不传 renderer,pauseUI 退化为 no-op。
  // 写屏走 stdout writer（serve 是后台 daemon 无 chrome），retry/compact 等事件
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

  // 3a. ConfirmationHub —— 远程权限确认聚合层（remote-confirmation-execution.md §3.2）
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
  const serveSegmentDeps = createServeSegmentDeps({
    taskListService: builtinExtraTools.taskListService,
  });

  // 3c''. 技能库 —— serve 全部 runtime(per-session + ephemeral)共享单实例:
  //   索引重建靠 store 内存结构版本比对,实例分散会让"会话 A 经 save_skill
  //   存技能、会话 B 下窗不知道"(各自版本各自计);共享后任一保存,全部
  //   runtime 下个窗口换代即见。磁盘本就同一目录,共享无额外耦合。
  const serveSkillStore = new SkillStore();

  // 3d. RuntimeHost —— 宿主侧 runtime 装配点:共享资产(skillStore / segmentDeps /
  //   mcpHub / 渲染装饰)单一持有,会话与 ephemeral 两条发放路径同一装配体。
  //   投递 origin 执行期从 RunContext 派生,实例装配不再按对话定制。
  //   turn-context provider 注册收拢进 onRuntimeCreated——scheduler 是 lazy ref
  //   （顶层 let schedulerRef），LLM 调用时刻 ref 已就绪；未就绪时 fallback 空状态。
  const runtimeHost = new RuntimeHost({
    skillStore: serveSkillStore,
    segmentDeps: serveSegmentDeps,
    extraTools: builtinExtraTools,
    scheduler: getSchedulerFacade,
    // 渠道下游(飞书/RPC)可看到子 agent 冒泡事件,renderDecorator 在非 TTY
    // 模式下退化为只输出 Task 起止帧(子工具中间事件静默,避免日志爆炸)。
    decorateRunBus: serveDecorateRunBus,
    onSecurityBlocked: createBlockedRenderer(serveWriter),
    // workmode 工具组的控制器——LLM 进出场景意图的产生面在宿主 runtime。
    // 删除守卫与 workscene.delete RPC 方法同判据:场景对话活跃即拒绝
    // (物理删会让进行中的记忆写入 / 持久化撞 ENOENT)。
    workModeController: () => ({
      registry: workSceneRegistry,
      async removeWorkScene(id: string): Promise<void> {
        const scenePrefix = `${WORKSCENE_CONVERSATION_PREFIX}${id}:`;
        const hasActive = conversationsRef.current
          ?.list()
          .some((s) => s.conversationId.startsWith(scenePrefix));
        if (hasActive) {
          throw new Error(`工作场景 "${id}" 有活跃会话,请先退出再删除`);
        }
        await workSceneRegistry.remove(id);
      },
    }),
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
  const runtimeFactory = createCliRuntimeFactory({
    createAgentRuntime: async (sessionId) => {
      // 对话归属编码在全域键里:ws: 前缀 → 该场景的 power 装配;其余 main。
      const { scope } = parseConversationId(sessionId);
      if (scope.kind === "workscene") {
        const scene = await workSceneRegistry.get(scope.sceneId);
        if (!scene) {
          throw new Error(`工作场景 "${scope.sceneId}" 不存在,无法装配会话`);
        }
        return runtimeHost.createWorksceneRuntime(scene);
      }
      return runtimeHost.createConversationRuntime();
    },
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

  // 4a. Daemon child 才启用 ServerStateFile——前台模式不写 state 文件
  const isChild = isDaemonChild();
  const stateFile = isChild ? new ServerStateFile() : undefined;
  const heartbeatTimerRef: { current: NodeJS.Timeout | null } = { current: null };

  // lockPaths —— 单一事实源。同时传给 runServer（acquireLock）和 registerTailCleanup（releaseLock），
  // 保证 acquire/release 走同一路径。当前 undefined = 默认 ~/.zhixing/server.pid。
  const lockPaths: ProcessLockPaths | undefined = undefined;

  // ============================================================================
  // 接入面装配 —— 数据驱动。profile 经 PROFILES.surfaces 声明启用哪组接入面，setupAccessSurfaces
  // 按依赖拓扑序遍历、各自 setup（产物写回 ctx）。主干不出现任何 `if (profile === ...)`。
  // ============================================================================
  // journal 域仓——turn 后维护(conversation 接入面)与系统维护任务共用。
  const journalStore = new JournalStore();

  const ctx: AssemblyContext = {
    profile,
    config,
    credentials,
    zhixingHome,
    confirmationHub,
    mcpHub,
    transcript,
    snapshots,
    runtimeFactory,
    convRepo,
    journalStore,
    sessionBroadcastRef,
    cleanup: registry,
  };

  // pre-server 接入面：MCP（connectAll）/ 会话执行面 / 通道 / 投递栈 / 文本确认渲染器。
  // 产物写回 ctx.conversations / channels / inboundRouter / deliveryStack / textRenderer。
  await setupAccessSurfaces(ACCESS_SURFACES, ctx, "pre-server");
  conversationsRef.current = ctx.conversations ?? null;

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
  // - ConversationManager 为持久用户会话设计，会 initTranscript → 创建 conv_xxx/ 目录、累积
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

  // 4c. 把 ephemeralRuntime 的 broker 挂到 hub —— 定时任务的 confirmation 从这里流出。
  //     命名空间用 "ephemeral"（与 conversation broker 的 "conv:${convId}" 命名规约区分）。
  //     进程生命周期内不 detach——ephemeralRuntime 也不单独 dispose。
  //     attach 与 hub.onEvent（textRenderer / bridge 订阅）相互独立，hub 是中介；装配期无
  //     confirmation 流动，故 attach 落在 textRenderer 接入面之后亦安全。
  confirmationHub.attach("ephemeral", ephemeralRuntime.confirmationBroker);

  // 4d. Scheduler 装配的恒定核心料件（eventBus / runRegistry / runAgentTurn / systemHandlers）。
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  // RunRegistry —— 每个 ephemeral run 注册一个 AbortController,允许:
  //   - schedule.abortRun(runId) RPC 主动中断
  //   - graceful shutdown 通过 abortAllAndWait 让所有 in-flight 走完 cleanup
  // Scheduler 对同 task 不允许并发(executeSingleTask 入口的 activeTasks 守卫保证),
  // 故 params.taskId 与 in-flight run 一一对应,作为 RunRegistry key 安全。
  const runRegistry = new RunRegistry();

  const runAgentTurn = async (
    params: AgentTurnParams,
  ): Promise<AgentTurnResult> => {
    const taskPrompt = params.context === "scheduled-task"
      ? `[系统] 这是一个定时任务的自动执行。请直接执行以下指令并输出结果，不要反问用户、不要引导对话。\n\n${params.prompt}`
      : params.prompt;

    // 远程确认回程地址（remote-confirmation-execution.md §3.3）：
    //   scheduler → ephemeralRuntime 路径下，任何工具触发的 confirmation
    //   按 turnOrigin.target 路由回创建任务时的通道对话。
    //   无 target 时（e.g. system 任务、未绑定通道的任务）降级为 defaultTarget / 仅 RPC。
    const turnContext: TurnContext = {
      turnId: generateTurnId(),
      turnOrigin: {
        channel: "scheduler",
        target: params.deliveryTarget,
        triggeredBy: params.taskId,
      },
    };

    const runKey = params.taskId ?? "anon";
    const abortSignal = runRegistry.registerRun(runKey);
    try {
      return await runEphemeralTurn({
        runtime: ephemeralRuntime,
        prompt: taskPrompt,
        turnContext,
        abortSignal,
      });
    } finally {
      runRegistry.unregisterRun(runKey);
    }
  };

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
  });

  // ============================================================================
  // 核心 Scheduler —— 吃 ctx.deliveryStack（delivery 构造期 readonly 不能 late-bind）。
  // schedule 档 ctx.deliveryStack 为 undefined → 无投递。
  // ============================================================================
  const scheduler = new Scheduler({
    store: new JsonTaskStore(),
    eventBus: schedulerEventBus,
    runAgentTurn,
    systemHandlers,
    delivery: ctx.deliveryStack?.delivery,
    logger: {
      info: (msg, data) => console.log(chalk.dim(`[scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      warn: (msg, data) => console.warn(chalk.yellow(`[scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      error: (msg, data) => console.error(chalk.red(`[scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      debug: () => {},
    },
  });
  schedulerRef = scheduler;
  // LocalSchedulerFacade —— 在恒定核心装配点实例化一次（绑核心 Scheduler、与执行面正交）：
  // daemon 内会话执行面 / ephemeralRuntime 的 schedule 工具经 getSchedulerFacade 共用它，
  // 直调本进程 Scheduler（不绕 RPC）；cli 侧对称用 RpcSchedulerFacade。统一 SchedulerFacade 缝。
  schedulerFacadeRef = new LocalSchedulerFacade(scheduler, schedulerEventBus);
  await scheduler.start();

  // 系统维护任务落地（seed-if-absent、幂等）——handler 已在 systemHandlers 注册。
  // 各自 cron、各自周期；未来 __skill-evict 等同此追加。
  await scheduler.ensureSystemTask({
    id: "__journal-gc",
    name: "journal-gc",
    handler: "__journal-gc",
    schedule: { kind: "cron", expr: "0 3 * * *" },
  });
  // transcript 保留清理（分片 + 摘要快照的时间窗真删）——天级足够（判据
  // 以天计），与 journal-gc 错开半小时避免维护任务扎堆。
  await scheduler.ensureSystemTask({
    id: "__transcript-gc",
    name: "transcript-gc",
    handler: "__transcript-gc",
    schedule: { kind: "cron", expr: "30 3 * * *" },
  });

  // ============================================================================
  // ServerContext + runServer —— 读接入面产物（conversations / channels）。
  // ============================================================================
  const serverCtx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    scheduler,
    conversations: ctx.conversations,
    conversationDirectory,
    workscenes: worksceneDirectory,
    trust: trustDirectory,
    skills: createSkillDirectory({ skillStore: serveSkillStore }),
    memory: memoryDirectory,
    hostInfo: {
      // 宿主单点解析的工作区——接入面 @ 补全 root 取此
      workspace: ephemeralRuntime.resolvedWorkspace.path ?? undefined,
      logPath: isChild ? getDefaultLogPath() : undefined,
    },
    // /mcp 状态显示与接入向导的宿主侧数据面(MCP 连接在宿主)
    mcpStatuses: () => mcpHub.serverStatuses(),
    // 轻推理通道(llm.complete,仅可信面)——管理流程的单发文本调用
    llmComplete: (prompt, role) => ephemeralRuntime.callText(prompt, role),
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
    confirmationHub,
    runRegistry,
  });

  // runServer 之前：尾部清理（LIFO 最后执行 —— releaseLock / state 文件）
  registerTailCleanup(registry, { stateFile, heartbeatTimerRef, lockPaths });

  // runServer —— 内部会向 registry 注册 server.close（注入模式）
  let runner: RunningServer;
  try {
    runner = await runServer({
      context: serverCtx,
      scheduler,
      schedulerEventBus,
      cleanupRegistry: registry,
      lockPaths, // 与 registerTailCleanup 使用同一引用——acquire/release 路径一致
      logger: {
        info: (msg) => console.log(chalk.dim(`[server] ${msg}`)),
        warn: (msg) => console.warn(chalk.yellow(`[server] ${msg}`)),
        error: (msg) => console.error(chalk.red(`[server] ${msg}`)),
      },
    });
  } catch (err) {
    // runServer 抛错（startServer / acquireLock 冲突）—— server 未运行。
    // 清理策略：先跑 registry.runAll（已注册的 tail 项对未完成 acquire 场景全 no-op 安全）
    // → 再手动清理 registry 未感知的资源（scheduler / 接入面产物在 registerCoreCleanup
    // 之前启动，还没进入 registry）。
    await registry.runAll("startup-failure").catch(() => {});
    await scheduler.stop().catch(() => {});
    await ctx.deliveryStack?.stop().catch(() => {});
    await ctx.channels?.dispose().catch(() => {});
    ctx.textRenderer?.stop();
    throw err;
  }

  // 组播设施已由 startServer 回填到 serverCtx —— 接通带外事件转发的 lazy ref。
  sessionBroadcastRef.current = serverCtx.sessionBroadcast ?? null;

  // runServer resolve 后填 runner，供 post-server 接入面读 server.connections。
  ctx.runner = runner;

  // runServer 之后：核心资源清理（LIFO 最先执行 —— markStopping / scheduler / channels /
  // delivery / heartbeat）。接入面产物（channels / deliveryStack）从 ctx 取。
  registerCoreCleanup(registry, {
    stateFile,
    heartbeatTimerRef,
    scheduler,
    channels: ctx.channels,
    deliveryStack: ctx.deliveryStack,
    mcpHub: builtinExtraTools.mcpHub,
  });

  // post-server 接入面：confirmationBridge（依赖 runner.server.connections，在自己 setup 内
  // 注册 dispose 到 ctx.cleanup —— LIFO 落在 registerCoreCleanup 之后、即更先执行）。
  await setupAccessSurfaces(ACCESS_SURFACES, ctx, "post-server");

  // pre-server 接入面 teardown —— 时序硬约束（必须在 server.close 之前 = runServer 之后注册）
  // 决定它们不能在自己 setup 内自注册，故由主干用 ctx 产物注册到 shutdown-chain。LIFO 顺序：
  //   后注册 = 更先执行。以下三项都在 registerCoreCleanup 之后注册，先于核心资源清理执行。

  // 文本确认渲染器停订阅（防 shutdown 期间还有 confirmation 派发到即将断开的 channel）。
  if (ctx.textRenderer) {
    const renderer = ctx.textRenderer;
    registry.register("confirmationRenderer.stop", () => {
      renderer.stop();
    });
  }

  // 远程中断模块关停链 —— LIFO 最先执行（在 channels.dispose / scheduler.stop / server.close 之前）：
  //   1. inboundRouter.refuseNew  拒新入站，避免下游 drain 期间又来新消息
  //   2. execution.abortAllAndWait  并行 fire abort + 等所有 in-flight 走完 cleanup
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
      runRegistry.abortAllAndWait(
        { kind: "external", origin: "scheduler-shutdown" },
        30_000,
      ),
    ]);
  });

  if (ctx.inboundRouter) {
    const router = ctx.inboundRouter;
    registry.register("inboundRouter.refuseNew", () => {
      router.refuseNewMessages();
    });
  }

  // Post-runServer 启动步骤（startup guard 包裹）
  //   不变量：runServer 已 resolve → server listening + PID 锁持有 + registry 全注册完毕。
  //   此后若任何步骤抛错（markReady / banner 等），必须走 runner.shutdown 让 registry 完整跑完，
  //   否则 daemon child 会孤儿化 + PID 锁/state 文件残留 —— 下次启动被假 "already running" 误挡。
  try {
    // markReady + markRunning + heartbeat（仅 daemon child）
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

  // idle reaper —— 仅后台 daemon 装配:前台进程的生命周期归终端(用户
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
        connectionCount: runner.server.connections.size,
        channelStates:
          ctx.channels?.listStatuses().map((s) => s.state) ?? [],
        hasUserPendingWork: scheduler
          .listTasks()
          .some((t) => !isInternal(t) && t.enabled),
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
}
