import {
  type ChannelLogger,
  type ChannelRegistry,
  type DeliveryResult,
  type DeliveryTarget,
  type EmissionSource,
  type InboundMessage,
  type OutboundContent,
  type OutboxRegistry,
  type TurnContext,
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
  /**
   * 可选 Outbox 顺序层（ADR-007）。提供时，所有发往用户的回复经 Outbox.post 串行化；
   * 未提供时降级为直接 adapter.send（测试/尚未接入 Outbox 的场景）。
   */
  outboxRegistry?: OutboxRegistry;
}

export class InboundRouter {
  private readonly conversations: ConversationManager;
  private readonly channels: ChannelRegistry;
  private readonly logger: ChannelLogger;
  private outboxRegistry?: OutboxRegistry;

  constructor(options: InboundRouterOptions) {
    this.conversations = options.conversations;
    this.channels = options.channels;
    this.logger = options.logger;
    this.outboxRegistry = options.outboxRegistry;
  }

  /**
   * Late-bind OutboxRegistry（解决 setupChannels → setupDelivery 的初始化顺序）。
   * 应在任何 inbound 消息到达之前完成。
   *
   * Write-once：重复绑定抛异常——防止误配置 / 测试时静默覆盖导致的隐蔽 bug。
   * 若确需替换（如热更新），应显式先 unset（当前不支持）。
   */
  setOutboxRegistry(registry: OutboxRegistry): void {
    if (this.outboxRegistry) {
      throw new Error(
        "InboundRouter.setOutboxRegistry: registry already bound (write-once)",
      );
    }
    this.outboxRegistry = registry;
  }

  /**
   * 统一出口：经 Outbox（若已注入）或降级为 adapter.send。
   * 所有 user-facing 消息走此方法，保证顺序不变量。
   */
  private async emit(
    target: DeliveryTarget,
    content: OutboundContent,
    source: EmissionSource,
  ): Promise<DeliveryResult | void> {
    if (this.outboxRegistry) {
      return this.outboxRegistry.of(target).post({ target, content, source });
    }
    const adapter = this.channels.get(target.channelId);
    if (!adapter) {
      this.logger.warn(`No adapter found for channel: ${target.channelId}`);
      return;
    }
    return adapter.send(target, content);
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
    this.logger.info(`[收到] "${msg.text}" from=${msg.from} conv=${conversationId}`);

    let managed: ManagedSession;
    try {
      managed = await this.conversations.getOrCreate(conversationId);
    } catch (err) {
      this.logger.error(`Failed to get/create conversation ${conversationId}: ${errMsg(err)}`);
      const replyTarget = buildReplyTarget(msg);
      await this.emit(
        replyTarget,
        { text: "会话创建失败，请稍后重试。" },
        { kind: "system", handler: "conversation-create-failed" },
      ).catch(() => {});
      return;
    }

    const status = this.conversations.enqueue(conversationId, {
      execute: () => this.runChannelTurn(managed, msg),
      cancel: () => {
        this.logger.info(`[排队取消] conv=${conversationId}`);
      },
    });

    this.logger.info(`[调度] status=${status} busy=${managed.busy} conv=${conversationId}`);

    if (status === "full") {
      this.logger.warn(`[丢弃] 队列满 conv=${conversationId}`);
      const replyTarget = buildReplyTarget(msg);
      await this.emit(
        replyTarget,
        { text: "消息队列已满，请稍后再试。" },
        { kind: "system", handler: "conversation-queue-full" },
      ).catch((e) => this.logger.error(`Failed to send busy reply: ${errMsg(e)}`));
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
    // 出口统一走 this.emit（Outbox 或降级 adapter.send），adapter 直引用不再需要
    const turnStartedAt = new Date().toISOString();
    this.logger.info(`[开始处理] conv=${conversationId} text="${msg.text}"`);

    // 构造 turnContext，把 commitToUser 绑定到当前 user target
    //   - turnId 用于观测（Phase 3 起接 Outbox Turn Slot）
    //   - commitToUser 让工具（如 schedule）可直接发 commitment 消息，不依赖 LLM 叙述
    //   - outboxRegistry 未绑定时 commitToUser 为 undefined → 工具降级为 LLM 叙述路径
    const replyTarget = buildReplyTarget(msg);
    const turnContext: TurnContext = {
      turnId: generateTurnId(),
      emissionTarget: replyTarget,
      commitToUser: this.outboxRegistry
        ? (content: OutboundContent, meta?: { toolName?: string }) =>
            this.outboxRegistry!.of(replyTarget).post({
              target: replyTarget,
              content,
              source: {
                kind: "tool-commitment",
                conversationId,
                // AgentLoop wrapper 会在每次 tool.call 自动填入当前 tool.name；
                // 兜底 "unknown" 仅在理论不应出现的场景触发（可用作异常监控信号）
                toolName: meta?.toolName ?? "unknown",
              },
            })
        : undefined,
    };

    try {
      const gen = managed.runtime.run(msg.text, { turnContext });
      let result: AgentResult | undefined;

      while (true) {
        const iter = await gen.next();
        if (iter.done) {
          result = iter.value;
          break;
        }
      }

      this.logger.info(`[处理完成] conv=${conversationId} reason=${result?.reason ?? "no-result"}`);

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
        this.logger.info(`[回复] conv=${conversationId} len=${content.text.length} text="${content.text}"`);
        await this.emit(replyTarget, content, {
          kind: "llm-reply",
          conversationId,
        }).catch((e) =>
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
        this.logger.warn(`[错误回复] conv=${conversationId} reason=${result.reason}`);
        await this.emit(
          replyTarget,
          { text: errorText },
          { kind: "llm-reply", conversationId },
        ).catch((e) =>
          this.logger.error(`Failed to send error reply: ${errMsg(e)}`),
        );
      }
    } catch (err) {
      this.logger.error(`[异常] conv=${conversationId}: ${errMsg(err)}`);
      const replyTarget = buildReplyTarget(msg);
      await this.emit(
        replyTarget,
        { text: "内部错误，请稍后重试。" },
        { kind: "system", handler: "inbound-router-error" },
      ).catch(() => {});
    } finally {
      this.logger.info(`[释放] conv=${conversationId} busy=false`);
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

/**
 * 生成全局 Turn ID（ADR-007 Phase 2 / conversation-model.md §5.3）。
 * 格式：`turn_${base36Time}_${rand}`——与 Outbox entry id 相似以便日志交叉定位。
 * Phase 3 起此 ID 作为 Outbox Turn Slot 的 key。
 */
function generateTurnId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `turn_${ts}_${rand}`;
}
