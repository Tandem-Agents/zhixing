/**
 * 接入面单元定义 —— 把 runServerProcess 里各接入面的内联装配等价搬成自包含 setup 单元。
 *
 * 数组 ACCESS_SURFACES 的顺序 = pre-server 依赖拓扑序（conversation→channel 门面
 * →delivery→text-renderer），setupAccessSurfaces 按此序遍历。每个 setup 内聚自己的
 * 运行时条件（如 channel 判 messaging 配置）与失败处理；profile 是否启用由
 * PROFILES.surfaces 决定、不在 setup 内判 profile。teardown 策略见 access-surface.ts
 * 文件头（pre-server 走 shutdown-chain、post-server 在 setup 内自注册）。
 */

import chalk from "chalk";
import {
  ShardedTranscriptStore,
  SnapshotStore,
  buildStartupBootstrap,
  conversationsDir,
  countRuns,
  createTokenEstimator,
  parseConversationId,
} from "@zhixing/core";
import {
  ConversationManager,
  TextConfirmationRenderer,
  createConfirmationBridge,
  SESSION_NOTIFICATIONS,
  type SessionChangedPayload,
} from "@zhixing/server";
import { resolveModelCapability } from "@zhixing/providers";
import { setupChannels } from "./channels.js";
import { setupDelivery } from "../setup-delivery.js";
import { createTurnMaintenance } from "./turn-maintenance.js";
import type { AccessSurface } from "./access-surface.js";

/** MCP —— eager 连接外部 server，使工具目录进入 system prompt。 */
const mcpSurface: AccessSurface = {
  name: "mcp",
  phase: "pre-server",
  async setup(ctx) {
    await ctx.mcpHub.connectAll();
  },
};

/** 会话执行面 —— 持久用户 / channel / 工作场景会话（ConversationManager）。 */
const conversationSurface: AccessSurface = {
  name: "conversation",
  phase: "pre-server",
  async setup(ctx) {
    const { transcript, snapshots, config } = ctx;
    // 装填预算按主模型能力取值（serve 会话统一用 main 模型；未知模型有保守兜底）
    const capability = resolveModelCapability(config.llm?.main?.model ?? "");

    // 持久化路由——对话归属编码在全域键里(ws: 前缀 = 场景对话),持久层
    // 操作按 scope 选 store、用库内 id。场景库 store 惰性建、按 sceneId 缓存。
    const sceneStores = new Map<
      string,
      { transcript: ShardedTranscriptStore; snapshots: SnapshotStore }
    >();
    const storesFor = (conversationId: string) => {
      const { scope, localId } = parseConversationId(conversationId);
      if (scope.kind === "workscene") {
        let entry = sceneStores.get(scope.sceneId);
        if (!entry) {
          const dir = conversationsDir(scope);
          entry = {
            transcript: new ShardedTranscriptStore(dir),
            snapshots: new SnapshotStore(dir),
          };
          sceneStores.set(scope.sceneId, entry);
        }
        return { ...entry, localId };
      }
      return { transcript, snapshots, localId: conversationId };
    };

    ctx.conversations = new ConversationManager(ctx.runtimeFactory, undefined, {
      loadHistory: async (conversationId) => {
        try {
          const s = storesFor(conversationId);
          // 倒读自带索引自愈（分片文件在，会话就在）——计数与装填都不做
          // 裸文件存在性短路。无任何记录（真·新对话 / 刚清空）→ undefined，
          // 交 doCreate 按需确保持久身份（幂等）。
          const turnCount = await countRuns(s.transcript, s.localId);
          if (turnCount === 0) return undefined;
          const bootstrap = await buildStartupBootstrap({
            conversationId: s.localId,
            store: s.transcript,
            snapshots: s.snapshots,
            capability: { optimalMaxTokens: capability.optimalMaxTokens },
            estimator: createTokenEstimator(),
          });
          return { bootstrap, turnCount };
        } catch {
          return undefined;
        }
      },
      initTranscript: async (conversationId) => {
        const s = storesFor(conversationId);
        await s.transcript.init(s.localId);
      },
      ensureConversation: async (conversationId) => {
        await ctx.conversationDirectory.ensure(conversationId);
      },
      appendRun: async (conversationId, input) => {
        const s = storesFor(conversationId);
        return await s.transcript.appendRunRecord(s.localId, input);
      },
      writeSnapshot: async (conversationId, input) => {
        const s = storesFor(conversationId);
        await s.snapshots.write(s.localId, input);
      },
      confirmationHub: ctx.confirmationHub,
      // turn 后维护(自动命名 + journal 凝练)——所有入口的 turn 经
      // recordTurn 唯一汇聚;自动命名成功组播 session.changed renamed,
      // 各端列表与标题随之刷新。
      onTurnCommitted: createTurnMaintenance({
        convRepo: ctx.convRepo,
        journal: ctx.journalStore,
        onRenamed: (conversationId, name) => {
          ctx.sessionBroadcastRef.current?.(
            conversationId,
            SESSION_NOTIFICATIONS.changed,
            {
              conversationId,
              change: "renamed",
              name,
            } satisfies SessionChangedPayload,
          );
        },
      }),
    });
  },
};

/** 社交通道 —— 先装稳定门面，外部连接异步进入状态机；setup 失败非致命。 */
const channelSurface: AccessSurface = {
  name: "channel",
  phase: "pre-server",
  async setup(ctx) {
    const { conversations, config, credentials, confirmationHub } = ctx;
    if (
      !conversations ||
      !config.messaging ||
      Object.keys(config.messaging).length === 0
    ) {
      return;
    }
    const channelLogger = {
      debug: (msg: string, ...args: unknown[]) =>
        console.log(chalk.dim(`[channel] ${msg}`), ...args),
      info: (msg: string, ...args: unknown[]) =>
        console.log(chalk.dim(`[channel] ${msg}`), ...args),
      warn: (msg: string, ...args: unknown[]) =>
        console.warn(chalk.yellow(`[channel] ${msg}`), ...args),
      error: (msg: string, ...args: unknown[]) =>
        console.error(chalk.red(`[channel] ${msg}`), ...args),
    };
    try {
      const result = await setupChannels({
        entries: config.messaging,
        credentials,
        conversations,
        logger: channelLogger,
        confirmationHub,
        cancelKeywords: config.intent?.cancelKeywords,
        sessionBroadcast: () => ctx.sessionBroadcastRef.current,
        sessionActivityBroadcast: () => ctx.sessionActivityBroadcastRef.current,
      });
      ctx.channels = result.registry;
      ctx.inboundRouter = result.router;
    } catch (err) {
      console.warn(
        chalk.yellow(
          `[channel] Setup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};

/** 投递栈 —— 依赖通道；late-bind Outbox 到 inboundRouter。 */
const deliverySurface: AccessSurface = {
  name: "delivery",
  phase: "pre-server",
  async setup(ctx) {
    const { channels, config, zhixingHome } = ctx;
    if (!channels || !config.messaging) return;
    const deliveryStack = await setupDelivery({
      channels,
      zhixingHome,
      logger: {
        info: (msg) => console.log(chalk.dim(msg)),
        warn: (msg) => console.warn(chalk.yellow(msg)),
        error: (msg) => console.error(chalk.red(msg)),
      },
    });
    ctx.deliveryStack = deliveryStack;
    if (ctx.inboundRouter) {
      ctx.inboundRouter.setOutboxRegistry(deliveryStack.outboxRegistry);
    }
  },
};

/** 文本确认渲染器 —— 把 hub 的 request 事件翻译为通道纯文本消息；依赖通道。 */
const textRendererSurface: AccessSurface = {
  name: "text-renderer",
  phase: "pre-server",
  async setup(ctx) {
    const { channels, confirmationHub } = ctx;
    if (!channels) return;
    const textRenderer = new TextConfirmationRenderer({
      hub: confirmationHub,
      channels,
      logger: {
        debug: (msg, ...args) =>
          console.log(chalk.dim(`[confirm] ${msg}`), ...args),
        info: (msg, ...args) =>
          console.log(chalk.dim(`[confirm] ${msg}`), ...args),
        warn: (msg, ...args) =>
          console.warn(chalk.yellow(`[confirm] ${msg}`), ...args),
        error: (msg, ...args) =>
          console.error(chalk.red(`[confirm] ${msg}`), ...args),
      },
    });
    textRenderer.start();
    ctx.textRenderer = textRenderer;
  },
};

/**
 * 远程确认桥 —— hub 事件 → RPC notification；依赖 runServer 之后的 server.connections
 * 与会话执行面。post-server 阶段，teardown 在此 setup 内自注册（时序正确）。
 */
const confirmationBridgeSurface: AccessSurface = {
  name: "confirmation-bridge",
  phase: "post-server",
  async setup(ctx) {
    const { conversations, confirmationHub, runner, cleanup } = ctx;
    if (!conversations || !runner) return;
    const confirmationBridge = createConfirmationBridge({
      connections: runner.server.connections,
      hub: confirmationHub,
      conversations,
    });
    cleanup.register("confirmationBridge.dispose", () => {
      confirmationBridge.dispose();
    });
  },
};

/**
 * 全部接入面单元，按 pre-server 依赖拓扑序排列（post-server 项排最后）。
 * 新增接入面 = 在此加一个单元 + 在 access-surface.ts 的 PROFILES 对应 surfaces 集合加名字。
 */
export const ACCESS_SURFACES: readonly AccessSurface[] = [
  mcpSurface,
  conversationSurface,
  channelSurface,
  deliverySurface,
  textRendererSurface,
  confirmationBridgeSurface,
];
