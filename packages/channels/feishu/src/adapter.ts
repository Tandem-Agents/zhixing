import * as lark from "@larksuiteoapi/node-sdk";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelChallengeMessage,
  ChannelContext,
  ChannelLogger,
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "@zhixing/core/channels";
import { validateChannelChallengeCallback } from "@zhixing/core/protocol";
import { buildChallengeCard, buildReplyCard } from "./cards.js";
import { FeishuApiError, FeishuClient, detectReceiveIdType, resolveDomain } from "./client.js";
import { resolveConfig } from "./config.js";
import { normalizeMessage } from "./events.js";
import { toFeishuMarkdown } from "./format.js";

export class FeishuAdapter implements ChannelAdapter {
  constructor(readonly id = "feishu") {}
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: false,
    edit: false,
    streaming: false,
  };

  private client: FeishuClient | null = null;
  private wsClient: lark.WSClient | null = null;
  private logger: ChannelLogger | null = null;
  private connected = false;

  health(): "ready" | "unavailable" { return this.connected ? "ready" : "unavailable"; }

  /**
   * 互动确认能力按凭据挂载:仅当 interactiveConfirmation 凭据在场时才存在,
   * `isChallengeChannel` 的鸭子探测因此如实反映当前能力——degraded 时宿主
   * 侧对该渠道 fail-closed,基础消息不受影响。
   */
  sendChallenge?: (message: ChannelChallengeMessage) => Promise<DeliveryResult>;

  async connect(ctx: ChannelContext): Promise<void> {
    const config = resolveConfig(ctx.config.credentials, ctx.config.options);
    this.logger = ctx.logger;

    this.client = new FeishuClient(config);
    const adapterId = this.id;
    const botOpenId = config.botOpenId;

    if (config.interactiveConfirmation) {
      const handler = new lark.CardActionHandler(
        {
          verificationToken: config.interactiveConfirmation.verificationToken,
          encryptKey: config.interactiveConfirmation.encryptKey,
        },
        async (event: lark.InteractiveCardActionEvent) => {
          const action = validateChannelChallengeCallback(event.action?.value);
          // 平台只有在耐久裁决完成后才收到成功响应;失败上抛让平台重投,
          // 耐久层的同键幂等保证重投只回放原结果。
          await ctx.onChallengeAction({
            token: action.token,
            responder: {
              channelId: adapterId,
              platformSubject: event.open_id,
              ...(event.tenant_key ? { tenant: event.tenant_key } : {}),
            },
            decision: action.decision,
            raw: event,
          });
          return {};
        },
      );
      ctx.registerHttpRoute(
        `/channels/${adapterId}/challenge`,
        lark.adaptDefault(
          `/channels/${adapterId}/challenge`,
          handler,
        ),
      );
      this.sendChallenge = (message) => this.deliverChallenge(message);
    } else {
      delete this.sendChallenge;
      this.logger?.warn(
        "Feishu interactive confirmation is disabled: add verificationToken and encryptKey " +
          "(飞书开放平台 → 事件与回调 → 加密策略) to enable signed challenge cards. " +
          "Basic messaging stays available; refresh this connection after adding the credentials.",
      );
    }

    // Coalesce transport retransmits only after the owner has acknowledged them.
    // Rejections are never cached; durable replay after restart remains core-owned.
    const acknowledged = new Set<string>();
    const admitting = new Map<string, Promise<void>>();
    const eventDispatcher = new lark.EventDispatcher({}).register({
      [FEISHU_INBOUND_EVENT_NAMES[0]]: async (data) => {
        if (ctx.abortSignal.aborted) throw new Error("Channel stopped before admission");
        const msg = normalizeMessage(data, adapterId, botOpenId);
        if (!msg) return;
        const id = msg.messageId;
        if (!id) throw new Error("Platform event identity missing");
        if (acknowledged.has(id)) return;
        const pending = admitting.get(id);
        if (pending) return pending;
        const admission = Promise.resolve().then(() => ctx.onMessage(msg));
        admitting.set(id, admission);
        try {
          await admission;
          acknowledged.add(id);
          if (acknowledged.size > 2048) acknowledged.delete(acknowledged.values().next().value!);
        } finally { admitting.delete(id); }
      },
    });

    const domain = resolveDomain(config.domain);
    let connected!: () => void;
    let failed!: (error: Error) => void;
    const connection = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject; });
    // The pinned SDK returns from start() before connection. Its logger is the
    // public connection-state hook; never forward its credential-bearing data.
    const observe = (...values: unknown[]) => {
      // LoggerProxy passes its argument list as one array to custom loggers.
      // Inspect only known literal signals; SDK diagnostics can contain secrets.
      const messages = values.flat(1);
      if (messages.includes("ws connect success")) { this.connected = true; connected(); }
      if (messages.some((value) => ["ws connect failed", "connect failed", "ws error", "client closed"].includes(value as string))) {
        this.connected = false;
        failed(new Error("Feishu transport unavailable"));
      }
    };
    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.trace,
      logger: { trace: observe, debug: observe, info: observe, warn: observe, error: observe },
      autoReconnect: false,
    });

    ctx.abortSignal.addEventListener("abort", () => {
      this.connected = false;
      failed(new Error("Channel stopped"));
      this.wsClient?.close();
    }, { once: true });

    try {
      await Promise.all([this.wsClient.start({ eventDispatcher }), connection]);
    } catch (err) {
      this.connected = false;
      this.wsClient?.close();
      this.wsClient = null;
      this.client = null;
      throw err;
    }

    this.logger?.info("Feishu adapter connected via WSClient");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient?.close();
    this.wsClient = null;
    this.client = null;
    delete this.sendChallenge;
    this.logger?.info("Feishu adapter disconnected");
    this.logger = null;
  }

  async send(target: DeliveryTarget, content: OutboundContent, meta?: import("@zhixing/core/channels").DeliveryAdapterSendMeta): Promise<DeliveryResult> {
    if (!this.client) {
      return { success: false, error: "Adapter not connected", retryable: true, attempted: false };
    }

    try {
      const markdown = content.markdown ?? content.text;
      const formatted = toFeishuMarkdown(markdown);
      const card = buildReplyCard(formatted);
      const receiveIdType = detectReceiveIdType(target.to);

      const messageId = await this.client.sendCard(target.to, card, receiveIdType, meta?.idempotencyKey);
      return { success: true, messageId, retryable: false, attempted: true };
    } catch (err) {
      if (!(err instanceof FeishuApiError)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof FeishuApiError ? err.retryable : true;
      this.logger?.error("Send failed: %s", message);
      return { success: false, error: message, retryable, attempted: true };
    }
  }

  private async deliverChallenge(
    message: ChannelChallengeMessage,
  ): Promise<DeliveryResult> {
    if (!this.client) {
      return { success: false, error: "Adapter not connected", retryable: true, attempted: false };
    }
    const display =
      "title" in message.display
        ? message.display
        : message.renderedDisplay;
    if (!display) {
      return {
        success: false,
        error: "Referenced challenge display was not materialized",
        retryable: false,
      };
    }
    try {
      const card = buildChallengeCard({
        title: display.title,
        lines: display.lines,
        token: message.token,
      });
      const receiveIdType = detectReceiveIdType(message.token.route.to);
      const messageId = await this.client.sendCard(
        message.token.route.to,
        card,
        receiveIdType,
        message.token.challengeId,
      );
      return { success: true, messageId, retryable: false, attempted: true };
    } catch (err) {
      if (!(err instanceof FeishuApiError)) throw err;
      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error,
        retryable: err instanceof FeishuApiError ? err.retryable : true,
        attempted: true,
      };
    }
  }
}
/** Actual Feishu ingress events registered by this adapter. */
export const FEISHU_INBOUND_EVENT_NAMES = ["im.message.receive_v1"] as const;

