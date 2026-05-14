/**
 * `zhixing serve` 命令 — 启动常驻服务
 *
 * 流程：
 * 1. 加载/生成 token
 * 2. 创建 TranscriptStore
 * 3. 创建 RuntimeFactory + ConversationManager（用户/channel 会话）
 * 4. 连接社交通道（Channel Adapters — 按配置启用）
 * 5. 创建 DeliveryPipeline（依赖通道）
 * 6. 创建 Ephemeral Runtime（定时任务专用，绕过 ConversationManager）
 * 7. 创建 Scheduler（注入 delivery + runAgentTurn→ephemeral）
 * 8. 创建 ServerContext + 启动 runServer
 * 9. 等待停机（信号触发或主动 shutdown）
 */

import {
  Scheduler,
  JsonTaskStore,
  RunRegistry,
  createEventBus,
  generateTurnId,
  type AgentTurnParams,
  type SchedulerEventMap,
  type AgentTurnResult,
  type ChannelRegistry,
  type TurnContext,
  JournalStore,
  TranscriptStore,
  getZhixingHome,
  getProjectId,
} from "@zhixing/core";
import {
  createServerContext,
  runServer,
  buildSystemHandlers,
  ConversationManager,
  ConfirmationHub,
  DEFAULT_SERVER_CONFIG,
  ServerStateFile,
  CleanupRegistry,
  TextConfirmationRenderer,
  createConfirmationBridge,
  type InboundRouter,
  type RunningServer,
  type ProcessLockPaths,
  type ConfirmationBridge,
} from "@zhixing/server";
import type {
  ZhixingConfig,
  ZhixingCredentials,
} from "@zhixing/providers";
import { runStartupCheck } from "../startup.js";
import chalk from "chalk";
import { createAgentRuntime } from "@zhixing/orchestrator/runtime";
import { createRenderSubscribers } from "../render.js";
import { createStdoutWriter } from "../screen/index.js";
import {
  createBlockedRenderer,
} from "../security/index.js";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";
import { createBuiltinExtraToolsAssembly } from "../runtime/builtin-extra-tools.js";
import { InMemoryTaskListStore } from "../runtime/task-list-stores.js";
import {
  EMPTY_TASK_STATUS_SUMMARY,
  registerCliTurnContextProviders,
} from "../runtime/turn-context-providers.js";
import { setupChannels } from "./channels.js";
import { createCliRuntimeFactory } from "./session-adapter.js";
import { runEphemeralTurn } from "./ephemeral-executor.js";
import { loadOrCreateToken } from "./token.js";
import { isDaemonChild } from "./self-exec.js";
import { spawnDaemon } from "./daemon.js";
import { registerTailCleanup, registerCoreCleanup } from "./shutdown-chain.js";
import path from "node:path";

const SERVER_VERSION = "0.1.0";

export interface ServeOptions {
  port?: number;
  host?: string;
  model?: string;
  provider?: string;
  workspace?: string;
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
  if (opts.model) args.push("--model", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  return args;
}

async function runServerProcess(opts: ServeOptions): Promise<void> {
  const port = opts.port ?? DEFAULT_SERVER_CONFIG.port;
  const host = opts.host ?? DEFAULT_SERVER_CONFIG.host;
  const workspace = opts.workspace ?? process.cwd();

  // 启动期检查——加载 config + credentials，校验 schema，按 server 模式
  // 检查 model + messaging 必要字段；缺字段且 TTY 触发配置编辑器，否则 fail-fast。
  const startupResult = await runStartupCheck({
    cwd: workspace,
    mode: "server",
  });

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

  // 1. token
  const tokenInfo = await loadOrCreateToken();
  if (tokenInfo.generated) {
    console.log(chalk.dim(`Generated new token: ${tokenInfo.path}`));
  }

  // 2. TranscriptStore
  const zhixingHome = getZhixingHome();
  const projectId = getProjectId(path.resolve(workspace));
  const conversationsDir = path.join(zhixingHome, "projects", projectId, "conversations");
  const transcript = new TranscriptStore(conversationsDir, workspace);

  // 3. RuntimeFactory + ConversationManager
  // scheduleTool → Scheduler → runAgentTurn → ConversationManager → runtimeFactory → scheduleTool
  // 用 lazy getter 打破循环依赖（标准 IoC 模式）
  let schedulerRef: Scheduler | null = null;
  const getSchedulerRef = () => {
    if (!schedulerRef) throw new Error("Scheduler not initialized yet");
    return schedulerRef;
  };

  // serve 模式无 spinner —— 不传 renderer,pauseUI 退化为 no-op。
  // 写屏走 stdout writer（serve 是后台 daemon 无 chrome），retry/compact 等事件
  // 直接打到 stdout 日志。工厂结果在多个 runtime 之间共享:每次 runtime.run() 各自
  // 装配独立 listener,工厂自身无跨 run 状态,共享安全且节省一次函数创建开销。
  const serveWriter = createStdoutWriter();
  const renderDecorator = createRenderSubscribers({ writer: serveWriter });

  // 3a. ConfirmationHub —— 远程权限确认聚合层（remote-confirmation-execution.md §3.2）
  //   在 ConversationManager / setupChannels / ephemeralRuntime / ServerContext 之前创建，
  //   以便各组件构造时能接入。未提供 hub 时 serve 模式会回退到"confirmation 永久 pending → expire"。
  const confirmationHub = new ConfirmationHub();

  // 3b. Builtin extra tools assembly —— task_list / schedule 工具的装配点，所有
  //   per-session runtime 共享同一 service 单例（cache by sessionId/conversationId）。
  //
  // serve 模式当前用 InMemoryTaskListStore 作过渡 —— serve 不接入
  // ConversationRepository，没有 meta.json 持久化路径。后续独立 PR 让 serve 接入
  // conversation meta 后，把此处切换为 ConversationRepoTaskListStore（其余装配
  // 代码不动，演化路径线性）。
  const builtinExtraTools = createBuiltinExtraToolsAssembly(
    new InMemoryTaskListStore(),
  );

  const runtimeFactory = createCliRuntimeFactory({
    createAgentRuntime: async (sessionId: string) => {
      // 从 sessionId（如 dm:feishu:ou_xxx）解析 origin，用于任务创建时自动捕获投递目标
      const origin = parseOriginFromSessionId(sessionId);
      const extraTools = builtinExtraTools.assembleTools({
        scheduler: getSchedulerRef,
        scheduleOrigin: () => origin,
      });

      const runtime = await createAgentRuntime({
        model: opts.model,
        provider: opts.provider,
        workspace: opts.workspace,
        extraTools,
        decorateRunBus: renderDecorator,
        onSecurityBlocked: createBlockedRenderer(serveWriter),
        // Task 工具由默认 mainProfile().enabledTools 含 "Task" 自动装配；
        // 渠道下游(飞书/RPC)可看到子 agent 冒泡事件,renderDecorator 在
        // 非 TTY 模式下退化为只输出 Task 起止帧(子工具中间事件静默,
        // 避免日志爆炸)。
      });
      // 注册 cli builtin TurnContextProvider（SchedulerProvider + TaskListProvider）
      // 走统一 helper —— 与 REPL 模式同源装配，杜绝两入口不对齐回归。
      // scheduler 是 lazy ref（顶层 let schedulerRef），LLM 调用时刻 ref 已就绪；
      // 未就绪时 fallback 空状态保鲁棒性。
      registerCliTurnContextProviders(runtime, {
        getSchedulerStatus: () =>
          schedulerRef?.getStatusSummary() ?? EMPTY_TASK_STATUS_SUMMARY,
        taskListService: builtinExtraTools.taskListService,
      });
      return runtime;
    },
  });
  const conversations = new ConversationManager(runtimeFactory, undefined, {
    loadHistory: async (conversationId) => {
      try {
        if (!(await transcript.exists(conversationId))) return undefined;
        const loaded = await transcript.load(conversationId);
        return loaded.messages;
      } catch {
        return undefined;
      }
    },
    initTranscript: async (conversationId) => {
      await transcript.init(conversationId, {
        model: opts.model ?? "default",
        provider: opts.provider ?? "default",
      });
    },
    // commitTurn 唯一原子持久化入口，返 canonical → ConversationManager
    // 内部走 session.runtime.updateMessages(canonical) 完成单一事实源回喂
    commitTurn: async (conversationId, payload) => {
      return await transcript.commitTurn(conversationId, payload);
    },
    // 每次 getOrCreate 后自动把 runtime.confirmationBroker attach 到 hub；
    // 四处 dispose（delete / grace / idle / disposeAll）前自动 detach（§3.2 INV-H3）
    confirmationHub,
  });

  // 4. Channels（config + credentials 已在启动期顶部 load 完成）
  let channels: ChannelRegistry | undefined;
  let inboundRouter: InboundRouter | null = null;
  if (config.messaging && Object.keys(config.messaging).length > 0) {
    const channelLogger = {
      debug: (msg: string, ...args: unknown[]) => console.log(chalk.dim(`[channel] ${msg}`), ...args),
      info: (msg: string, ...args: unknown[]) => console.log(chalk.dim(`[channel] ${msg}`), ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(chalk.yellow(`[channel] ${msg}`), ...args),
      error: (msg: string, ...args: unknown[]) => console.error(chalk.red(`[channel] ${msg}`), ...args),
    };

    try {
      const result = await setupChannels({
        entries: config.messaging,
        credentials,
        conversations,
        logger: channelLogger,
        // InboundRouter pending-aware 拦截依赖 hub
        confirmationHub,
        // 用户配置的 cancel 关键词扩展（与 DEFAULT_CANCEL_KEYWORDS append 合并）
        cancelKeywords: config.intent?.cancelKeywords,
      });
      channels = result.registry;
      inboundRouter = result.router;
    } catch (err) {
      console.warn(chalk.yellow(`[channel] Setup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 5. Delivery Pipeline（共享模块，serve/repl 同一路径）
  let deliveryStack: DeliveryStack | undefined;
  if (channels && config.messaging) {
    deliveryStack = await setupDelivery({
      channels,
      zhixingHome,
      logger: {
        info: (msg) => console.log(chalk.dim(msg)),
        warn: (msg) => console.warn(chalk.yellow(msg)),
        error: (msg) => console.error(chalk.red(msg)),
      },
    });

    // 5b. Late-bind Outbox 到 InboundRouter —— LLM 回复现在也过 Outbox（ADR-007 Phase 1）
    if (inboundRouter) {
      inboundRouter.setOutboxRegistry(deliveryStack.outboxRegistry);
    }
  }

  // 6. Ephemeral Runtime — 定时任务专用（Step 16e）
  //
  // 为什么独立于 conversations：
  // - conversations (ConversationManager) 是为持久用户会话设计，会 initTranscript → 创建
  //   conv_xxx/ 目录、累积消息历史、依赖 idle-reaper 释放。定时任务若走此路径，每次执行
  //   都留下磁盘痕迹（即使内存被 reaper 回收），导致 conversations/ 无限膨胀。
  // - Ephemeral 执行对标 K8s Job / Serverless / Claude Code 子 Agent：任务独立、无身份、
  //   不累积历史、零磁盘痕迹。与持久用户会话是两套完全独立的语义。
  //
  // 为什么共享单例 runtime 而非每任务新建：
  // - createAgentRuntime 有 provider 连接、系统提示、项目上下文加载等启动成本
  // - AgentRuntime.run() 本身对会话历史无状态（messages 每次传入），复用安全
  // - Token estimator 校准、permission 规则跨任务共享是正收益
  //
  // scheduleTool 的 origin：定时任务 AI 若创建子任务，origin=null（非用户发起）。
  // 用户发起的任务走 channel → ConversationManager 路径，在那里 origin 已从
  // sessionId（dm:feishu:ou_xxx）解析并在 task.origin 持久化。
  // ephemeral 定时任务 runtime 用同一个 assembly 装配 extra tools —— 与持久会话
  // runtime 共享同一 TaskListService。定时任务不传 conversationId 到 runtime.run，
  // task_list 工具内部 ALS 取不到 conversationId 直接 isError 拒绝调用（不污染
  // 任何 conversation 的 cache）—— 装配一致性 + 行为隔离两全。
  const ephemeralRuntime = await createAgentRuntime({
    model: opts.model,
    provider: opts.provider,
    workspace: opts.workspace,
    extraTools: builtinExtraTools.assembleTools({
      scheduler: getSchedulerRef,
      // 定时任务自创建子任务 origin=null（非用户发起，渠道无投递目标）
      scheduleOrigin: () => null,
    }),
    decorateRunBus: renderDecorator,
    onSecurityBlocked: createBlockedRenderer(serveWriter),
    // Task 工具由默认 mainProfile().enabledTools 含 "Task" 自动装配；定时任务
    // 的 ephemeral 执行路径同样可派发子 agent 隔离子任务（并发探查 / 大文档
    // 检索 / 复杂工具链），与持久会话能力对齐。
  });
  // ephemeral 定时任务 runtime 也走同一 helper —— 装配契约与 main session runtime
  // 完全对称。定时任务路径 runtime.run 不传 conversationId，TaskListProvider 闭包
  // 内 ALS 取不到 → getItems 返 [] → 整段跳过，不污染 turn-context。
  registerCliTurnContextProviders(ephemeralRuntime, {
    getSchedulerStatus: () =>
      schedulerRef?.getStatusSummary() ?? EMPTY_TASK_STATUS_SUMMARY,
    taskListService: builtinExtraTools.taskListService,
  });

  // 6a. 把 ephemeralRuntime 的 broker 挂到 hub —— 定时任务的 confirmation 从这里流出。
  //     命名空间用 "ephemeral"（与 conversation broker 的 "conv:${convId}" 命名规约区分）。
  //     进程生命周期内不 detach——ephemeralRuntime 也不单独 dispose。
  confirmationHub.attach("ephemeral", ephemeralRuntime.confirmationBroker);

  // 6b. TextConfirmationRenderer —— 把 hub 的 request 事件翻译为通道纯文本消息。
  //     必须在 channels 就绪后才有意义；无 channels 时本地只有 RPC 推送（未来 Bridge 接入后生效）。
  let textRenderer: TextConfirmationRenderer | undefined;
  if (channels) {
    textRenderer = new TextConfirmationRenderer({
      hub: confirmationHub,
      channels,
      logger: {
        debug: (msg, ...args) => console.log(chalk.dim(`[confirm] ${msg}`), ...args),
        info: (msg, ...args) => console.log(chalk.dim(`[confirm] ${msg}`), ...args),
        warn: (msg, ...args) => console.warn(chalk.yellow(`[confirm] ${msg}`), ...args),
        error: (msg, ...args) => console.error(chalk.red(`[confirm] ${msg}`), ...args),
      },
    });
    textRenderer.start();
  }

  // 7. Scheduler
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  // RunRegistry —— 每个 ephemeral run 注册一个 AbortController,允许:
  //   - schedule.abortRun(runId) RPC 主动中断
  //   - graceful shutdown 通过 abortAllAndWait 让所有 in-flight 走完 cleanup
  // Scheduler 本身对同 task 不允许并发(scheduler.ts 互斥锁保证),params.taskId
  // 与 in-flight run 一一对应,作为 RunRegistry key 安全。
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

  const journalStore = new JournalStore();
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
  });

  const scheduler = new Scheduler({
    store: new JsonTaskStore(),
    eventBus: schedulerEventBus,
    runAgentTurn,
    systemHandlers,
    delivery: deliveryStack?.delivery,
    logger: {
      info: (msg, data) => console.log(chalk.dim(`[scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      warn: (msg, data) => console.warn(chalk.yellow(`[scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      error: (msg, data) => console.error(chalk.red(`[scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      debug: () => {},
    },
  });
  schedulerRef = scheduler;
  await scheduler.start();

  // 8. ServerContext + runServer
  const ctx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    scheduler,
    conversations,
    channels,
    confirmationHub,
    runRegistry,
  });

  // 8a. Daemon child 才启用 ServerStateFile——前台模式不写 state 文件
  const isChild = isDaemonChild();
  const stateFile = isChild ? new ServerStateFile() : undefined;
  const heartbeatTimerRef: { current: NodeJS.Timeout | null } = { current: null };

  // lockPaths —— 单一事实源。同时传给 runServer（acquireLock）和 registerTailCleanup（releaseLock），
  // 保证 acquire/release 走同一路径。当前 undefined = 默认 ~/.zhixing/server.pid。
  const lockPaths: ProcessLockPaths | undefined = undefined;

  // 8b. CleanupRegistry —— 唯一清理出口。LIFO 语义 + 跨包注入。
  //     注册序列封装在 shutdown-chain.ts，方便单测顺序正确性。
  const registry = new CleanupRegistry({
    logger: {
      info: (msg) => console.log(chalk.dim(`[cleanup] ${msg}`)),
      error: (msg, err) =>
        console.error(chalk.red(`[cleanup] ${msg}`), err instanceof Error ? err.message : err),
    },
  });

  // 8b.1 runServer 之前：尾部清理（LIFO 最后执行 —— releaseLock / state 文件）
  registerTailCleanup(registry, { stateFile, heartbeatTimerRef, lockPaths });

  // 8b.2 runServer —— 内部会向 registry 注册 server.close（注入模式）
  let runner: RunningServer;
  try {
    runner = await runServer({
      context: ctx,
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
    // 清理策略：先跑 registry.runAll（已注册的 tail 项对未完成 acquire 场景全 no-op 安全，
    // 保证与正常路径的清理一致性）→ 再手动清理 registry 未感知的资源（scheduler / channels /
    // delivery 是在 command.ts step 4-7 启动的，还没进入 registry）。
    await registry.runAll("startup-failure").catch(() => {});
    await scheduler.stop().catch(() => {});
    await deliveryStack?.stop().catch(() => {});
    await channels?.dispose().catch(() => {});
    textRenderer?.stop();
    throw err;
  }

  // 8b.3 runServer 之后：核心资源清理（LIFO 最先执行 —— markStopping / scheduler / channels / delivery / heartbeat）
  registerCoreCleanup(registry, {
    stateFile,
    heartbeatTimerRef,
    scheduler,
    channels,
    deliveryStack,
  });

  // 8b.4 ConfirmationBridge —— hub 事件 → RPC notification 单一出口。
  //     依赖 runner.server.connections（runServer 之后才可用），放在 registerCoreCleanup 后。
  //     LIFO：bridge.dispose 在 textRenderer.stop 之前执行（两者都在 LIFO 最先执行的位置）。
  const confirmationBridge: ConfirmationBridge = createConfirmationBridge({
    connections: runner.server.connections,
    hub: confirmationHub,
    conversations,
  });
  registry.register("confirmationBridge.dispose", () => {
    confirmationBridge.dispose();
  });

  // 8b.5 最后注册 = LIFO 最先执行——停止 hub 事件订阅（防止 shutdown 期间还有
  //     confirmation 请求被派发到即将断开的 channel adapter）。仅 textRenderer 存在时注册。
  if (textRenderer) {
    registry.register("confirmationRenderer.stop", () => {
      textRenderer!.stop();
    });
  }

  // 8b.6 远程中断模块的关停链 —— LIFO 最先执行(在 channels.dispose / scheduler.stop /
  //     server.close 之前)。两条新增项的 LIFO 执行序:
  //       1. inboundRouter.refuseNew         (LIFO 1) 拒新入站,避免下游 drain 期间又来新消息
  //       2. execution.abortAllAndWait       (LIFO 2) Promise.all([conv, run]) 并行 fire abort
  //                                                   + 等所有 in-flight 走完主模块 cleanup
  //                                                   (partial yields + RunResult + 取消反馈)
  //
  //     必须 await drain —— 没有它 server.close / channels.dispose 抢断 partial 流和取消反馈,
  //     违反"关停期反馈不丢"。30s 总超时兜底由 abortAllAndWait 自身实现,超时不抛
  //     直接进下一步,避免 grace 类工具 hang 整条关停链。
  registry.register("execution.abortAllAndWait", async () => {
    await Promise.all([
      conversations.abortAllAndWait(
        { kind: "external", origin: "scheduler-shutdown" },
        30_000,
      ),
      runRegistry.abortAllAndWait(
        { kind: "external", origin: "scheduler-shutdown" },
        30_000,
      ),
    ]);
  });

  if (inboundRouter) {
    registry.register("inboundRouter.refuseNew", () => {
      inboundRouter!.refuseNewMessages();
    });
  }

  // 8c. Post-runServer 启动步骤（startup guard 包裹）
  //     不变量：runServer 已 resolve → server listening + PID 锁持有 + registry 全注册完毕。
  //     此后若任何步骤抛错（markReady / banner 等），必须走 runner.shutdown 让 registry 完整跑完，
  //     否则 daemon child 会孤儿化 + PID 锁/state 文件残留 —— 下次启动被假 "already running" 误挡。
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
    if (channels) {
      const statuses = channels.listStatuses();
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

  // 等待停机 —— 所有清理由 lifecycle.ts 的 shutdown → registry.runAll 统一完成
  await runner.waitForShutdown();
}

/**
 * 从 sessionId（如 "dm:feishu:ou_xxx"）解析投递 origin。
 * 非 channel 会话返回 null。
 */
function parseOriginFromSessionId(sessionId: string): { channelId: string; to: string } | null {
  const parts = sessionId.split(":");
  if (parts.length >= 3 && parts[0] === "dm") {
    return { channelId: parts[1]!, to: parts.slice(2).join(":") };
  }
  return null;
}
