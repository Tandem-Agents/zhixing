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
  SchedulerProvider,
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
import { loadConfig } from "@zhixing/providers";
import { createScheduleTool } from "@zhixing/tools-builtin";
import chalk from "chalk";
import { createAgentRuntime } from "../run-agent.js";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";
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

  // 1. token
  const tokenInfo = await loadOrCreateToken();
  if (tokenInfo.generated) {
    console.log(chalk.dim(`Generated new token: ${tokenInfo.path}`));
  }

  // 2. TranscriptStore
  const workspace = opts.workspace ?? process.cwd();
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

  // 3a. ConfirmationHub —— 远程权限确认聚合层（remote-confirmation-execution.md §3.2）
  //   在 ConversationManager / setupChannels / ephemeralRuntime / ServerContext 之前创建，
  //   以便各组件构造时能接入。未提供 hub 时 serve 模式会回退到"confirmation 永久 pending → expire"。
  const confirmationHub = new ConfirmationHub();

  const runtimeFactory = createCliRuntimeFactory({
    createAgentRuntime: async (sessionId: string) => {
      // 从 sessionId（如 dm:feishu:ou_xxx）解析 origin，用于任务创建时自动捕获投递目标
      const origin = parseOriginFromSessionId(sessionId);
      const scheduleTool = createScheduleTool(getSchedulerRef, () => origin);

      const runtime = await createAgentRuntime({
        model: opts.model,
        provider: opts.provider,
        workspace: opts.workspace,
        extraTools: [scheduleTool],
      });
      runtime.registerTurnContextProvider(
        new SchedulerProvider(() => {
          if (!schedulerRef) return { active: [], recentlyCompleted: [], recentlyFailed: [] };
          return schedulerRef.getStatusSummary();
        }),
      );
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

  // 4. Channels
  const config = loadConfig({ cwd: workspace });
  let channels: ChannelRegistry | undefined;
  let inboundRouter: InboundRouter | null = null;
  if (config.channels && Object.keys(config.channels).length > 0) {
    const channelLogger = {
      debug: (msg: string, ...args: unknown[]) => console.log(chalk.dim(`[channel] ${msg}`), ...args),
      info: (msg: string, ...args: unknown[]) => console.log(chalk.dim(`[channel] ${msg}`), ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(chalk.yellow(`[channel] ${msg}`), ...args),
      error: (msg: string, ...args: unknown[]) => console.error(chalk.red(`[channel] ${msg}`), ...args),
    };

    try {
      const result = await setupChannels({
        entries: config.channels,
        conversations,
        logger: channelLogger,
        // InboundRouter pending-aware 拦截依赖 hub（§3.5）
        confirmationHub,
      });
      channels = result.registry;
      inboundRouter = result.router;
    } catch (err) {
      console.warn(chalk.yellow(`[channel] Setup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 5. Delivery Pipeline（共享模块，serve/repl 同一路径）
  let deliveryStack: DeliveryStack | undefined;
  if (channels && config.channels) {
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
  const ephemeralRuntime = await createAgentRuntime({
    model: opts.model,
    provider: opts.provider,
    workspace: opts.workspace,
    extraTools: [createScheduleTool(getSchedulerRef, () => null)],
  });
  ephemeralRuntime.registerTurnContextProvider(
    new SchedulerProvider(() => {
      if (!schedulerRef) return { active: [], recentlyCompleted: [], recentlyFailed: [] };
      return schedulerRef.getStatusSummary();
    }),
  );

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

    return runEphemeralTurn({
      runtime: ephemeralRuntime,
      prompt: taskPrompt,
      turnContext,
    });
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
