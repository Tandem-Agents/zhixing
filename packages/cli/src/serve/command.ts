/**
 * `zhixing serve` 命令 — 启动常驻服务
 *
 * 流程：
 * 1. 加载/生成 token
 * 2. 创建 Scheduler（共享存储 ~/.zhixing/scheduler.json）
 * 3. 创建 RuntimeFactory（绑定 createAgentRuntime）
 * 4. 创建 ServerContext + 启动 runServer
 * 5. 等待停机（信号触发或主动 shutdown）
 */

import {
  Scheduler,
  JsonTaskStore,
  createEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
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
  DEFAULT_SERVER_CONFIG,
  type RunningServer,
} from "@zhixing/server";
import chalk from "chalk";
import { createAgentRuntime } from "../run-agent.js";
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
  const runtimeFactory = createCliRuntimeFactory({
    createAgentRuntime: () =>
      createAgentRuntime({
        model: opts.model,
        provider: opts.provider,
        workspace: opts.workspace,
      }),
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

  // 4. Scheduler
  const schedulerEventBus = createEventBus<SchedulerEventMap>();
  const runAgentTurn = async (params: {
    prompt: string;
  }): Promise<AgentTurnResult> => {
    const startTime = Date.now();
    try {
      const managed = await conversations.getOrCreate();
      const runtime = managed.runtime;
      const gen = runtime.run(params.prompt);
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
  });
  await scheduler.start();

  // 5. ServerContext + runServer
  const ctx = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port, host },
    version: SERVER_VERSION,
    token: tokenInfo.token,
    scheduler,
    conversations,
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

  // 等待停机
  await runner.waitForShutdown();
}
