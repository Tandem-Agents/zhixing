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
   * 统一出口：所有 user-facing 消息走此方法，保证顺序不变量。
   *
   * 三种路径按签名自动选择，调用方不需要知道具体走哪一条：
   *   1. 有 outboxRegistry + 有 turnId（turn 内回复）→
   *      `outbox.fillSlot(turnId, entry)`：原子地发回复 + 关闭 slot，
   *      让本 turn 内创建的 `afterSlot=turnId` entry（如 task fire）排在回复之后
   *   2. 有 outboxRegistry + 无 turnId（pre-turn 错误、系统消息）→
   *      `outbox.post(entry)`：普通入队，无 slot 语义
   *   3. 无 outboxRegistry（REPL / 未接入 Outbox 的测试）→ `adapter.send`
   *
   * Caller 按"是否是 turn 内的主回复"决定要不要传 turnId，签名显式表达语义。
   */
  private async emitReply(
    target: DeliveryTarget,
    content: OutboundContent,
    source: EmissionSource,
    turnId?: string,
  ): Promise<DeliveryResult | void> {
    if (this.outboxRegistry) {
      const outbox = this.outboxRegistry.of(target);
      if (turnId) {
        return outbox.fillSlot(turnId, { target, content, source });
      }
      return outbox.post({ target, content, source });
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
      await this.emitReply(
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
      await this.emitReply(
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
    // 出口统一走 this.emitReply（Outbox / fillSlot / 降级 adapter.send 按签名自动选择）
    const turnStartedAt = new Date().toISOString();
    this.logger.info(`[开始处理] conv=${conversationId} text="${msg.text}"`);

    // 构造 turnContext，把 commitToUser 绑定到当前 user target
    //   - turnId 用于观测 + 作为 Outbox Turn Slot 的 key（Phase 3）
    //   - commitToUser 让工具（如 schedule）可直接发 commitment 消息，不依赖 LLM 叙述
    //   - outboxRegistry 未绑定时 commitToUser 为 undefined → 工具降级为 LLM 叙述路径
    const replyTarget = buildReplyTarget(msg);
    const turnId = generateTurnId();
    const turnContext: TurnContext = {
      turnId,
      emissionTarget: replyTarget,
      commitToUser: this.outboxRegistry
        ? (content: OutboundContent, meta?: { toolName?: string }) =>
            this.outboxRegistry!.of(replyTarget).post({
              target: replyTarget,
              content,
              source: {
                kind: "tool-commitment",
                conversationId,
                turnId,
                // AgentLoop wrapper 会在每次 tool.call 自动填入当前 tool.name；
                // 兜底 "unknown" 仅在理论不应出现的场景触发（可用作异常监控信号）
                toolName: meta?.toolName ?? "unknown",
              },
            })
        : undefined,
    };

    // Phase 3：turn 启动即 open slot，让本 turn 内工具创建的任务（afterSlot=turnId）
    // 被阻塞到本 turn 的最终回复之后才发出。TTL 兜底防 slot 泄漏（INV-4）。
    if (this.outboxRegistry) {
      this.outboxRegistry.of(replyTarget).openSlot({ slotId: turnId });
    }

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

        const content = buildOutboundContent(result);
        const hasContent = content.text.trim().length > 0;
        this.logger.info(
          `[回复] conv=${conversationId} len=${content.text.length} empty=${!hasContent} text="${content.text}"`,
        );
        if (hasContent) {
          await this.emitReply(
            replyTarget,
            content,
            { kind: "llm-reply", conversationId, turnId },
            turnId,
          ).catch((e) =>
            this.logger.error(`Failed to send reply to ${msg.channelId}: ${errMsg(e)}`),
          );
        } else if (this.outboxRegistry) {
          // 协同：LLM 被 commitment 完全抑制（content 空）时，
          // 不发空 entry（会被 adapter reject 或产生无用告警），仅关 slot
          // 释放等待 afterSlot=turnId 的 task fire。
          await this.outboxRegistry
            .of(replyTarget)
            .fillSlot(turnId)
            .catch((e) =>
              this.logger.error(`Failed to close slot: ${errMsg(e)}`),
            );
        }
        // 无 outboxRegistry + 空内容：REPL/测试场景，静默不发（channel 路径必有 registry）
      } else if (result) {
        const errorText =
          result.reason === "error"
            ? `处理出错：${result.error.message}`
            : result.reason === "max_turns"
              ? "达到最大轮次限制。"
              : "处理被中止。";
        this.logger.warn(`[错误回复] conv=${conversationId} reason=${result.reason}`);
        await this.emitReply(
          replyTarget,
          { text: errorText },
          { kind: "llm-reply", conversationId, turnId },
          turnId,
        ).catch((e) =>
          this.logger.error(`Failed to send error reply: ${errMsg(e)}`),
        );
      }
    } catch (err) {
      this.logger.error(`[异常] conv=${conversationId}: ${errMsg(err)}`);
      await this.emitReply(
        replyTarget,
        { text: "内部错误，请稍后重试。" },
        { kind: "system", handler: "inbound-router-error" },
        turnId,
      ).catch(() => {});
    } finally {
      // Phase 3 安全网：若 slot 仍 pending（理论不该发生——上面三个分支之一必填了它），
      // abandon 以释放 afterSlot 等待者，防止因意外路径导致 task-fire 悬挂到 TTL。
      // 对已终态 slot 的 abandon 是 no-op（outbox.ts slot 状态机保证）。
      if (this.outboxRegistry) {
        this.outboxRegistry
          .of(replyTarget)
          .abandonSlot(turnId, "turn ended without reply emission");
      }
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
