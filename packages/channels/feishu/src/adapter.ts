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
import { validateChannelChallengeCallback } from "@zhixing/core/protocol";
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
    this.dedup = new DedupCache({
      ttlMs: config.dedupTtlMs,
      maxSize: config.dedupMaxSize,
    });

    const dedup = this.dedup;
    const logger = this.logger;
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
          "Basic messaging stays available; restart after adding the credentials.",
      );
    }

    const eventDispatcher = new lark.EventDispatcher({}).register({
      [FEISHU_INBOUND_EVENT_NAMES[0]]: async (data) => {
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
    delete this.sendChallenge;
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

  private async deliverChallenge(
    message: ChannelChallengeMessage,
  ): Promise<DeliveryResult> {
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
/** Actual Feishu ingress events registered by this adapter. */
export const FEISHU_INBOUND_EVENT_NAMES = ["im.message.receive_v1"] as const;

