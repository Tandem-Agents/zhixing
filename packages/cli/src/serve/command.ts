/**
 * `zhixing serve` 命令 — 启动常驻服务
 *
 * 流程：
 * 1. 加载/生成 token
 * 2. 创建 TranscriptStore
 * 3. 创建 RuntimeFactory + ConversationManager
 * 4. 连接社交通道（Channel Adapters — 按配置启用）
 * 5. 创建 DeliveryPipeline（依赖通道）
 * 6. 创建 Scheduler（注入 delivery）
 * 7. 创建 ServerContext + 启动 runServer
 * 8. 等待停机（信号触发或主动 shutdown）
 */

import {
  Scheduler,
  JsonTaskStore,
  createEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
  type ChannelRegistry,
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
  DEFAULT_SERVER_CONFIG,
  type RunningServer,
} from "@zhixing/server";
import { loadConfig } from "@zhixing/providers";
import { createScheduleTool } from "@zhixing/tools-builtin";
import chalk from "chalk";
import { createAgentRuntime } from "../run-agent.js";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";
import { setupChannels } from "./channels.js";
import { createCliRuntimeFactory } from "./session-adapter.js";
import { loadOrCreateToken } from "./token.js";
import path from "node:path";

const SERVER_VERSION = "0.1.0";

export interface ServeOptions {
  port?: number;
  host?: string;
  model?: string;
  provider?: string;
  workspace?: string;
}

export async function runServeCommand(opts: ServeOptions): Promise<void> {
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
    persistTurn: async (conversationId, turn) => {
      await transcript.appendTurn(conversationId, turn);
    },
  });

  // 4. Channels
  const config = loadConfig({ cwd: workspace });
  let channels: ChannelRegistry | undefined;
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
      });
      channels = result.registry;
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
  }

  // 6. Scheduler
  const schedulerEventBus = createEventBus<SchedulerEventMap>();
  const runAgentTurn = async (params: {
    prompt: string;
    context?: "scheduled-task";
  }): Promise<AgentTurnResult> => {
    const startTime = Date.now();
    try {
      const taskPrompt = params.context === "scheduled-task"
        ? `[系统] 这是一个定时任务的自动执行。请直接执行以下指令并输出结果，不要反问用户、不要引导对话。\n\n${params.prompt}`
        : params.prompt;
      const managed = await conversations.getOrCreate();
      const runtime = managed.runtime;
      const gen = runtime.run(taskPrompt);
      let lastText = "";
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          return {
            status: value.reason === "completed" ? "ok" : "error",
            output: lastText || undefined,
            error:
              value.reason === "error"
                ? value.error.message
                : value.reason === "max_turns"
                  ? "Max turns reached"
                  : undefined,
            durationMs: Date.now() - startTime,
          };
        }
        if (value.type === "text_delta") {
          lastText += value.text;
        }
      }
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
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

  // 7. ServerContext + runServer
  const ctx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    scheduler,
    conversations,
    channels,
  });

  let runner: RunningServer;
  try {
    runner = await runServer({
      context: ctx,
      scheduler,
      schedulerEventBus,
      logger: {
        info: (msg) => console.log(chalk.dim(`[server] ${msg}`)),
        warn: (msg) => console.warn(chalk.yellow(`[server] ${msg}`)),
        error: (msg) => console.error(chalk.red(`[server] ${msg}`)),
      },
    });
  } catch (err) {
    await scheduler.stop().catch(() => {});
    await deliveryStack?.stop().catch(() => {});
    await channels?.dispose().catch(() => {});
    throw err;
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
      console.log(chalk.dim(`    ${icon} ${s.channelId}: ${s.state}${s.error ? ` (${s.error})` : ""}`));
    }
  }
  console.log(chalk.dim(`  Ctrl+C 停止`));
  console.log();

  // 等待停机
  await runner.waitForShutdown();

  // 优雅清理
  await scheduler.stop().catch(() => {});
  await deliveryStack?.stop().catch(() => {});
  await channels?.dispose().catch(() => {});
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
