/**
 * 接入面单元定义 —— 把 runServerProcess 里各接入面的内联装配等价搬成自包含 setup 单元。
 *
 * createAccessSurfaces 返回数组的顺序 = pre-server 依赖拓扑序（conversation→channel 门面
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
  TextConfirmationRenderer,
} from "@zhixing/server";
import { ConversationManager } from "@zhixing/owner-kernel";
import {
  createConfirmationBridge,
  SESSION_NOTIFICATIONS,
  type SessionChangedPayload,
} from "@zhixing/rpc";
import {
  resolveModelCapability,
  type ChannelCredentialProjection,
} from "@zhixing/providers";
import { setupChannels } from "./channels.js";
import {
  setupAuthorityRuntime,
  setupDelivery,
} from "../setup-delivery.js";
import { createAdvancementReviewMaintenance } from "./advancement-review-maintenance.js";
import { createTurnMaintenance } from "./turn-maintenance.js";
import { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { AccessSurface } from "./access-surface.js";

/** MCP —— eager 连接外部 server，使工具目录进入 system prompt。 */
const mcpSurface: AccessSurface = {
  name: "mcp",
  phase: "pre-server",
  async setup(ctx) {
    await ctx.mcpHub.connectAll();
  },
};

/** Durable authority substrate shared by conversation and delivery composition. */
const authorityRuntimeSurface: AccessSurface = {
  name: "authority-runtime",
  phase: "pre-server",
  async setup(ctx) {
    ctx.authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: ctx.zhixingHome,
      secretStore: ctx.secretStore,
      configurationSnapshot: ctx.config,
    });
  },
};

/** 会话执行面 —— 持久用户 / channel / 工作场景会话（ConversationManager）。 */
const conversationSurface: AccessSurface = {
  name: "conversation",
  phase: "pre-server",
  async setup(ctx) {
    const { transcript, snapshots, config } = ctx;
    if (!ctx.authorityRuntime) {
      throw new Error("Conversation surface requires the durable authority runtime");
    }
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

    const turnMaintenance = createTurnMaintenance({
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
    });
    const advancementReviewMaintenance = createAdvancementReviewMaintenance({
      advancement: ctx.advancement,
      sessionBroadcast: () => ctx.sessionBroadcastRef.current,
      conversations: () => ctx.conversations ?? null,
      conversationExists: (conversationId) =>
        ctx.conversationDirectory.exists(conversationId),
      recoverConversation: (conversationId, options) =>
        ctx.advancementRecoveryRef?.current?.recoverConversation(
          conversationId,
          options,
        ) ?? Promise.resolve(),
    });

    let manager: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority: ctx.authorityRuntime,
      manager: () => manager,
      interactions: ctx.durableInteractions,
      executeRecoveredPerspective: async (input) => {
        const execution = await ctx.perspectives.executePerspectiveWork(input);
        return execution.runResult;
      },
      onStatus: (notice) => {
        ctx.sessionBroadcastRef.current?.(
          notice.ref.conversationId,
          SESSION_NOTIFICATIONS.status,
          notice,
        );
      },
      onFinal: (frame) => {
        ctx.sessionBroadcastRef.current?.(
          frame.conversationId,
          SESSION_NOTIFICATIONS.final,
          frame,
        );
      },
      projectLifecycle: async (input) => {
        if (input.mutation === "clear") {
          const outcome = await manager.clear(input.conversationId, async () => {
            await ctx.conversationDirectory.ensure(input.conversationId);
            await ctx.conversationDirectory.clear(input.conversationId);
            return true;
          });
          if (outcome === "busy") {
            throw new Error("Conversation lifecycle projection is busy");
          }
          if (outcome === "not-found") {
            throw new Error("Conversation lifecycle projection lost its identity");
          }
          ctx.sessionBroadcastRef.current?.(
            input.conversationId,
            SESSION_NOTIFICATIONS.changed,
            { conversationId: input.conversationId, change: "cleared" },
          );
          return;
        }
        const outcome = await manager.delete(input.conversationId, {
          removeDisk: async () => {
            await ctx.conversationDirectory.remove(input.conversationId);
            return true;
          },
          onDeleted: () => {
            ctx.sessionBroadcastRef.current?.(
              input.conversationId,
              SESSION_NOTIFICATIONS.changed,
              { conversationId: input.conversationId, change: "deleted" },
            );
          },
        });
        if (outcome === "busy") {
          throw new Error("Conversation lifecycle projection is busy");
        }
        // 权威删除的全部级联消费者在同一投影 claim 内幂等完成:推进会话
        // 取消与控制日志删除失败即抛错保持投影待办,由在线/启动恢复重驱;
        // advancement 子系统整体缺席时无级联数据,是显式判定而非能力兜底。
        if (ctx.advancement) {
          await ctx.advancement.cancelOpenConversationSession({
            conversationId: input.conversationId,
            reason: "user-cancelled",
            message: "原始对话已删除，推进会话已取消。",
          });
          await ctx.advancement.removeConversationData(input.conversationId);
        }
      },
      recoverAuxiliary: async (conversationId) => {
        const recovery = ctx.advancementRecoveryRef.current;
        if (!recovery) return;
        const result = await recovery.recoverConversation(conversationId);
        if (
          result.status === "failed" ||
          result.status === "full" ||
          result.status === "busy" ||
          result.status === "not-found" ||
          result.status === "missing-proxy"
        ) {
          throw new Error(
            result.message ??
              `Advancement recovery did not converge: ${result.status}`,
          );
        }
      },
    });
    manager = new ConversationManager(ctx.runtimeFactory, undefined, {
      onRelease: (conversationId) => protocol.releaseConversation(conversationId),
      loadHistory: async (conversationId) => {
        // 倒读自带索引自愈（分片文件在，会话就在）——计数与装填都不做
        // 裸文件存在性短路。undefined 只表示经成功读取确认的零历史
        // （真·新对话 / 刚清空）；任何 I/O、损坏或装填异常必须向调用面
        // 传播并保持会话未激活——把读取失败编码成空历史会让 agent 在
        // 缺失既有上下文时继续提交新权威结果,污染对话。
        const s = storesFor(conversationId);
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
      appendCommittedRun: async (conversationId, input) => {
        const s = storesFor(conversationId);
        return await s.transcript.appendCommittedRunRecord(s.localId, input);
      },
      writeSnapshot: async (conversationId, input) => {
        const s = storesFor(conversationId);
        await s.snapshots.write(s.localId, input);
      },
      confirmationHub: ctx.confirmationHub,
      // 所有入口的 accepted turn 经 recordTurn 汇聚；各维护任务各自
      // fire-and-forget，不能反向影响已落定的对话事实。
      onTurnCommitted: (info) => {
        turnMaintenance(info);
        advancementReviewMaintenance(info);
      },
      durableTurnExecutor: protocol,
    });
    await protocol.recoverReadinessProjections();
    ctx.conversations = manager;
    ctx.conversationProtocol = protocol;
  },
};

/** 社交通道 —— 先装稳定门面，外部连接异步进入状态机；setup 失败非致命。 */
function createChannelSurface(credentials: ChannelCredentialProjection): AccessSurface {
  return {
    name: "channel",
    phase: "pre-server",
    async setup(ctx) {
      const { conversations, config, confirmationHub } = ctx;
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
          sessionActivityBroadcast: () =>
            ctx.sessionActivityBroadcastRef.current,
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
}

/** 投递栈 —— 依赖通道；late-bind Outbox 到 inboundRouter。 */
const deliverySurface: AccessSurface = {
  name: "delivery",
  phase: "pre-server",
  async setup(ctx) {
    const { channels, config, zhixingHome } = ctx;
    if (!channels || !config.messaging) return;
    if (!ctx.authorityRuntime) {
      throw new Error("Delivery requires the durable authority runtime");
    }
    const deliveryStack = await setupDelivery({
      channels,
      zhixingHome,
      authorityRuntime: ctx.authorityRuntime,
      logger: {
        info: (msg) => console.log(chalk.dim(msg)),
        warn: (msg) => console.warn(chalk.yellow(msg)),
        error: (msg) => console.error(chalk.red(msg)),
      },
    });
    ctx.deliveryStack = deliveryStack;
    ctx.conversationProtocol?.bindDeliveryDrain(() =>
      deliveryStack.authorityDelivery.flush(),
    );
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

/** Work resumption starts only after RPC, channel, delivery and confirmation consumers exist. */
const conversationRecoverySurface: AccessSurface = {
  name: "conversation-recovery",
  phase: "post-server",
  async setup(ctx) {
    const protocol = ctx.conversationProtocol;
    if (!protocol) return;
    protocol.startRecoveryLoop();
  },
};

/**
 * 全部接入面单元，按 pre-server 依赖拓扑序排列（post-server 项排最后）。
 * 新增接入面 = 在此加一个单元 + 在 access-surface.ts 的 PROFILES 对应 surfaces 集合加名字。
 */
export function createAccessSurfaces(
  channelCredentials: ChannelCredentialProjection,
): readonly AccessSurface[] {
  return [
    mcpSurface,
    authorityRuntimeSurface,
    conversationSurface,
    createChannelSurface(channelCredentials),
    deliverySurface,
    textRendererSurface,
    confirmationBridgeSurface,
    conversationRecoverySurface,
  ];
}
