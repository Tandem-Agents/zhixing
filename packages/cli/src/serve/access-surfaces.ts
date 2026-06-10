/**
 * 接入面单元定义 —— 把 runServerProcess 里各接入面的内联装配等价搬成自包含 setup 单元。
 *
 * 数组 ACCESS_SURFACES 的顺序 = pre-server 依赖拓扑序（conversation→channel→delivery→
 * text-renderer），setupAccessSurfaces 按此序遍历。每个 setup 内聚自己的运行时条件
 * （如 channel 判 messaging 配置）与失败处理；profile 是否启用由 PROFILES.surfaces 决定、
 * 不在 setup 内判 profile。teardown 策略见 access-surface.ts 文件头（pre-server 走
 * shutdown-chain、post-server 在 setup 内自注册）。
 */

import chalk from "chalk";
import {
  ConversationManager,
  TextConfirmationRenderer,
  createConfirmationBridge,
} from "@zhixing/server";
import { setupChannels } from "./channels.js";
import { setupDelivery } from "../setup-delivery.js";
import { loadRunRecords } from "../runtime/load-run-records.js";
import type { AccessSurface } from "./access-surface.js";

/** MCP —— eager 连接外部 server，使工具目录进入 system prompt。 */
const mcpSurface: AccessSurface = {
  name: "mcp",
  phase: "pre-server",
  async setup(ctx) {
    await ctx.mcpHub.connectAll();
  },
};

/** 会话执行面 —— 持久用户 / channel 会话（ConversationManager）。 */
const conversationSurface: AccessSurface = {
  name: "conversation",
  phase: "pre-server",
  async setup(ctx) {
    const { transcript } = ctx;
    ctx.conversations = new ConversationManager(ctx.runtimeFactory, undefined, {
      loadHistory: async (conversationId) => {
        try {
          // 不做裸文件存在性短路 —— 倒读自带索引自愈（分片文件在，会话
          // 就在），索引层事故不丢历史。无任何记录（真·新对话 / 刚清空）
          // → undefined，交 doCreate 按需走 initTranscript（幂等）。
          const records = await loadRunRecords(transcript, conversationId);
          return records.length > 0 ? records : undefined;
        } catch {
          return undefined;
        }
      },
      initTranscript: async (conversationId) => {
        await transcript.init(conversationId);
      },
      appendRun: async (conversationId, input) =>
        await transcript.appendRunRecord(conversationId, input),
      confirmationHub: ctx.confirmationHub,
    });
  },
};

/** 社交通道 —— 依赖会话执行面 + messaging 配置；setup 失败非致命。 */
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
