import {
  type ChannelLogger,
  type ChannelRegistry,
  type DeliveryTarget,
  type InboundMessage,
  type OutboundContent,
  extractText,
  userMessage,
  type AgentResult,
  type Turn,
} from "@zhixing/core";
import type { ConversationManager, ManagedSession } from "../runtime/conversation-manager.js";
import { resolveConversationId } from "./conversation-binder.js";

// ─── InboundRouter 入站消息路由器 ─── 
// 将入站消息路由到对应的对话会话中，并执行 Agent 处理

export interface InboundRouterOptions {
  conversations: ConversationManager;
  channels: ChannelRegistry;
  logger: ChannelLogger;
}

export class InboundRouter {
  private readonly conversations: ConversationManager;
  private readonly channels: ChannelRegistry;
  private readonly logger: ChannelLogger;

  constructor(options: InboundRouterOptions) {
    this.conversations = options.conversations;
    this.channels = options.channels;
    this.logger = options.logger;
  }

  /**
   * 处理入站消息。由 ChannelRegistry 的 onMessage 回调触发。
   *
   * 流程（server-gateway.md §6.1 的 MVP 子集）：
   * 1. 对话归组 → conversationId
   * 2. getOrCreate → ManagedSession
   * 3. 并发守卫（enqueue / immediate）
   * 4. Agent 执行 → 结果
   * 5. adapter.send() → 回复到触发通道
   */
  async handleMessage(msg: InboundMessage): Promise<void> {
    const adapter = this.channels.get(msg.channelId);
    if (!adapter) {
      this.logger.warn(`No adapter found for channel: ${msg.channelId}`);
      return;
    }

    const conversationId = resolveConversationId(msg, adapter.bindingPolicy);
    this.logger.debug(`Routing message from ${msg.from} to conversation ${conversationId}`);

    let managed: ManagedSession;
    try {
      managed = await this.conversations.getOrCreate(conversationId);
    } catch (err) {
      this.logger.error(`Failed to get/create conversation ${conversationId}: ${errMsg(err)}`);
      const replyTarget = buildReplyTarget(msg);
      await adapter.send(replyTarget, { text: "会话创建失败，请稍后重试。" }).catch(() => {});
      return;
    }

    const status = this.conversations.enqueue(conversationId, {
      execute: () => this.runChannelTurn(managed, msg),
      cancel: () => {
        this.logger.debug(`Pending turn cancelled for ${conversationId}`);
      },
    });

    if (status === "full") {
      this.logger.warn(`Queue full for conversation ${conversationId}, dropping message`);
      const replyTarget = buildReplyTarget(msg);
      await adapter.send(replyTarget, {
        text: "消息队列已满，请稍后再试。",
      }).catch((e) => this.logger.error(`Failed to send busy reply: ${errMsg(e)}`));
      return;
    }

    if (status === "immediate") {
      this.conversations.setBusy(conversationId, true);
      void this.runChannelTurn(managed, msg);
    }
  }

  private async runChannelTurn(
    managed: ManagedSession,
    msg: InboundMessage,
  ): Promise<void> {
    const conversationId = managed.conversationId;
    const adapter = this.channels.get(msg.channelId);
    if (!adapter) return;

    const turnStartedAt = new Date().toISOString();

    try {
      const gen = managed.runtime.run(msg.text);
      let result: AgentResult | undefined;

      while (true) {
        const iter = await gen.next();
        if (iter.done) {
          result = iter.value;
          break;
        }
      }

      if (result && result.reason === "completed") {
        const turn: Turn = {
          type: "turn",
          turnIndex: managed.turnCount,
          timestamp: turnStartedAt,
          userMessage: userMessage(msg.text),
          assistantMessage: result.message,
          usage: result.usage,
          source: "channel",
        };
        try {
          await this.conversations.recordTurn(conversationId, turn);
        } catch {
          // persistence failure — non-fatal
        }

        const replyTarget = buildReplyTarget(msg);
        const content = buildOutboundContent(result);
        await adapter.send(replyTarget, content).catch((e) =>
          this.logger.error(`Failed to send reply to ${msg.channelId}: ${errMsg(e)}`),
        );
      } else if (result) {
        const replyTarget = buildReplyTarget(msg);
        const errorText =
          result.reason === "error"
            ? `处理出错：${result.error.message}`
            : result.reason === "max_turns"
              ? "达到最大轮次限制。"
              : "处理被中止。";
        await adapter.send(replyTarget, { text: errorText }).catch((e) =>
          this.logger.error(`Failed to send error reply: ${errMsg(e)}`),
        );
      }
    } catch (err) {
      this.logger.error(`Channel turn error for ${conversationId}: ${errMsg(err)}`);
      const replyTarget = buildReplyTarget(msg);
      await adapter.send(replyTarget, { text: "内部错误，请稍后重试。" }).catch(() => {});
    } finally {
      this.conversations.setBusy(conversationId, false);
    }
  }
}

// ─── 工具函数 ───

function buildReplyTarget(msg: InboundMessage): DeliveryTarget {
  return {
    channelId: msg.channelId,
    to: msg.groupId ?? msg.from,
    threadId: msg.threadId,
  };
}

function buildOutboundContent(result: AgentResult & { reason: "completed" }): OutboundContent {
  const text = extractText(result.message);
  return { text, markdown: text };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
