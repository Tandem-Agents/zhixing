import * as lark from "@larksuiteoapi/node-sdk";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelContext,
  ChannelLogger,
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "@zhixing/core";
import { buildReplyCard } from "./cards.js";
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
}
