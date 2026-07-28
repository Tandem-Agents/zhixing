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
} from "@zhixing/core";
import { buildChallengeCard, buildReplyCard } from "./cards.js";
import { FeishuApiError, FeishuClient, detectReceiveIdType, resolveDomain } from "./client.js";
import { resolveConfig } from "./config.js";
import { DedupCache } from "./dedup.js";
import { normalizeMessage } from "./events.js";
import { toFeishuMarkdown } from "./format.js";

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu";
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: false,
    edit: false,
    streaming: false,
  };

  private client: FeishuClient | null = null;
  private wsClient: lark.WSClient | null = null;
  private dedup: DedupCache | null = null;
  private logger: ChannelLogger | null = null;

  async connect(ctx: ChannelContext): Promise<void> {
    const config = resolveConfig(ctx.config.credentials, ctx.config.options);
    this.logger = ctx.logger;

    this.client = new FeishuClient(config);
    this.dedup = new DedupCache({
      ttlMs: config.dedupTtlMs,
      maxSize: config.dedupMaxSize,
    });

    const dedup = this.dedup;
    const logger = this.logger;
    const adapterId = this.id;
    const botOpenId = config.botOpenId;

    const handler = new lark.CardActionHandler(
      {
        verificationToken: config.verificationToken,
        encryptKey: config.encryptKey,
      },
      async (event: lark.InteractiveCardActionEvent) => {
        const action = parseChallengeAction(event.action?.value);
        ctx.onChallengeAction({
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

    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try {
          if (ctx.abortSignal.aborted) return;

          if (data.message?.message_id && dedup.isDuplicate(data.message.message_id)) {
            logger?.debug("Duplicate message skipped: %s", data.message.message_id);
            return;
          }

          const msg = normalizeMessage(data, adapterId, botOpenId);
          if (!msg) return;

          ctx.onMessage(msg);
        } catch (err) {
          logger?.error("Event handler error: %s", err);
        }
      },
    });

    const domain = resolveDomain(config.domain);
    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
    });

    ctx.abortSignal.addEventListener("abort", () => {
      this.wsClient?.close();
    }, { once: true });

    try {
      await this.wsClient.start({ eventDispatcher });
    } catch (err) {
      this.wsClient = null;
      this.client = null;
      this.dedup = null;
      throw err;
    }

    this.logger?.info("Feishu adapter connected via WSClient");
  }

  async disconnect(): Promise<void> {
    this.wsClient?.close();
    this.wsClient = null;
    this.client = null;
    this.dedup?.clear();
    this.dedup = null;
    this.logger?.info("Feishu adapter disconnected");
    this.logger = null;
  }

  async send(target: DeliveryTarget, content: OutboundContent): Promise<DeliveryResult> {
    if (!this.client) {
      return { success: false, error: "Adapter not connected", retryable: true };
    }

    try {
      const markdown = content.markdown ?? content.text;
      const formatted = toFeishuMarkdown(markdown);
      const card = buildReplyCard(formatted);
      const receiveIdType = detectReceiveIdType(target.to);

      const messageId = await this.client.sendCard(target.to, card, receiveIdType);
      return { success: true, messageId, retryable: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof FeishuApiError ? err.retryable : true;
      this.logger?.error("Send failed: %s", message);
      return { success: false, error: message, retryable };
    }
  }

  async sendChallenge(message: ChannelChallengeMessage): Promise<DeliveryResult> {
    if (!this.client) {
      return { success: false, error: "Adapter not connected", retryable: true };
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
      );
      return { success: true, messageId, retryable: false };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error,
        retryable: err instanceof FeishuApiError ? err.retryable : true,
      };
    }
  }
}

function parseChallengeAction(value: unknown): {
  readonly token: import("@zhixing/core").ChannelChallengeAction["token"];
  readonly decision: import("@zhixing/core").ChannelChallengeAction["decision"];
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Feishu challenge action is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate["v"] !== 1 ||
    !candidate["token"] ||
    typeof candidate["token"] !== "object" ||
    !candidate["decision"] ||
    typeof candidate["decision"] !== "object"
  ) {
    throw new TypeError("Feishu challenge action is incomplete");
  }
  const decision = candidate["decision"] as Record<string, unknown>;
  if (typeof decision["allowed"] !== "boolean") {
    throw new TypeError("Feishu challenge decision is invalid");
  }
  if (
    decision["reason"] !== undefined &&
    typeof decision["reason"] !== "string"
  ) {
    throw new TypeError("Feishu challenge reason is invalid");
  }
  return {
    token: candidate["token"] as import("@zhixing/core").ChannelChallengeAction["token"],
    decision: {
      allowed: decision["allowed"],
      ...(typeof decision["reason"] === "string"
        ? { reason: decision["reason"] }
        : {}),
    },
  };
}
