/**
 * `zhixing serve` 命令 — 启动常驻服务
 *
 * 流程：
 * 1. 加载/生成 token
 * 2. 创建 Scheduler（共享存储 ~/.zhixing/scheduler.json）
 * 3. 创建 SessionFactory（绑定 createSession）
 * 4. 创建 ServerContext + 启动 runServer
 * 5. 等待停机（信号触发或主动 shutdown）
 *
 * 设计要点：
 * - 复用 createSession()——不重复实现 provider/security/tools 设置
 * - Scheduler 的 runAgentTurn 通过 SessionRegistry 调用——任务也走会话化执行
 * - 系统任务 __journal-gc 注入 JournalStore lifecycle（通过 callText 的 LLM 调用）
 */

import {
  Scheduler,
  JsonTaskStore,
  createEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
  JournalStore,
} from "@zhixing/core";
import {
  createServerContext,
  runServer,
  buildSystemHandlers,
  SessionRegistry,
  DEFAULT_SERVER_CONFIG,
  type RunningServer,
} from "@zhixing/server";
import chalk from "chalk";
import { createSession } from "../run-agent.js";
import { createCliSessionFactory } from "./session-adapter.js";
import { loadOrCreateToken } from "./token.js";

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

  // 2. SessionFactory + SessionRegistry
  // 每个 session 独立创建 AgentSession（独立 provider + 工具集）
  const sessionFactory = createCliSessionFactory({
    createAgentSession: () =>
      createSession({
        model: opts.model,
        provider: opts.provider,
        workspace: opts.workspace,
      }),
  });
  const sessions = new SessionRegistry(sessionFactory);

  // 3. Scheduler
  // runAgentTurn 走 sessions registry：每个调度任务复用同一会话 ID（任务名作为 session 标识）
  // 这样定时任务能保留对话历史，符合 spec 的「持续性会话」理念
  const schedulerEventBus = createEventBus<SchedulerEventMap>();
  const runAgentTurn = async (params: {
    prompt: string;
  }): Promise<AgentTurnResult> => {
    const startTime = Date.now();
    try {
      // 调度任务用独立的临时 session（无持久化历史）
      const session = await sessions.getOrCreate();
      const gen = session.run(params.prompt);
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
        // S1 阶段 CLI 已实现 journal lifecycle 的简化版，此处直接调用
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
  });
  await scheduler.start();

  // 4. ServerContext + runServer
  const ctx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    scheduler,
    sessions,
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
    // 启动失败：scheduler 也得 stop
    await scheduler.stop().catch(() => {});
    throw err;
  }

  // 启动横幅
  console.log();
  console.log(chalk.green("  知行服务已启动"));
  console.log(chalk.dim(`  HTTP:      http://${runner.server.host}:${runner.server.port}`));
  console.log(chalk.dim(`  WebSocket: ws://${runner.server.host}:${runner.server.port}/ws`));
  console.log(chalk.dim(`  Token:     ${tokenInfo.path}`));
  console.log(chalk.dim(`  Ctrl+C 停止`));
  console.log();

  // 等待停机（SIGTERM/SIGINT 触发，或 runner.shutdown 调用）
  await runner.waitForShutdown();
}
