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
  generateTurnId,
  isFreeTextDeny,
  type AgentResult,
  type RunResult,
} from "@zhixing/core";
import type { ConversationManager, ManagedSession } from "../runtime/conversation-manager.js";
import { runTurnWithCommit } from "../runtime/run-turn.js";
import type { ConfirmationHub } from "../confirmation/hub.js";
import {
  matchTextToDecision,
  formatResolutionReceipt,
} from "../confirmation/match.js";
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
  /**
   * 可选 ConfirmationHub —— 提供时，handleMessage 会在 enqueue 之前检查当前
   * 会话是否有 pending confirmation。有则按词集匹配规则解决（不占队列位、不触发
   * agent 推理），匹配不到的任意文本作为拒绝理由回流给 LLM。
   *
   * 未提供时 InboundRouter 行为完全等价——所有消息正常排队进入 agent 流程。
   *
   * 参见 remote-confirmation-execution.md §3.5。
   */
  confirmationHub?: ConfirmationHub;
}

export class InboundRouter {
  private readonly conversations: ConversationManager;
  private readonly channels: ChannelRegistry;
  private readonly logger: ChannelLogger;
  private outboxRegistry?: OutboxRegistry;
  private readonly confirmationHub?: ConfirmationHub;

  constructor(options: InboundRouterOptions) {
    this.conversations = options.conversations;
    this.channels = options.channels;
    this.logger = options.logger;
    this.outboxRegistry = options.outboxRegistry;
    this.confirmationHub = options.confirmationHub;
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

    // ── pending-aware 拦截（remote-confirmation-execution.md §3.5） ──
    // 必须在 conversations.getOrCreate / enqueue **之前**：
    //   · 不占队列位（用户回复不是对 agent 的提问）
    //   · 不触发会话创建（会话已 idle release 的场景 "好" 不应重建会话）
    //   · 不进入 agent 推理（避免把 "好" 当成用户提问走 LLM）
    if (this.confirmationHub) {
      const handled = await this.tryHandleAsConfirmationReply(msg, conversationId);
      if (handled) return;
    }

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

  /**
   * pending-aware 拦截：若当前会话有 pending confirmation，按词集匹配规则解决。
   *
   * 返回 true 表示已处理（调用方 return 不走 agent 流程）；false 表示未处理（正常排队）。
   *
   * 语义（remote-confirmation-execution.md §3.5 + §3.6）：
   *   - 无 pending → 正常进入 agent 流程
   *   - 空消息 → 不拦截（避免空字符串误命中）
   *   - 匹配允许词集 → broker.resolve(allow-once)
   *   - 匹配拒绝词集 → broker.resolve(deny)
   *   - 其他任意文本 → broker.resolve(deny, reason=整条消息)（自由文本理由）
   *
   * 埋点（§3.10 事件表）：
   *   - `confirmation.reply.matched-structured`
   *   - `confirmation.reply.matched-reason`
   *   - `confirmation.reply.stale`（broker.resolve 返 false——已超时 / 已在其他端解决）
   */
  private async tryHandleAsConfirmationReply(
    msg: InboundMessage,
    conversationId: string,
  ): Promise<boolean> {
    const broker = this.confirmationHub!.findBrokerByConversation(conversationId);
    const pending = broker?.listPending() ?? [];
    if (pending.length === 0) return false;

    const text = msg.text.trim();
    if (!text) return false; // 空消息不拦截

    const target = pending[0]!; // broker FIFO 保证队首在 showing

    // ── 发起者身份校验（防止群聊下 B 用户误批准 A 的 pending） ──
    //
    // 背景：DEFAULT_BINDING_POLICY.group="per-group" 时，群里所有成员共享
    //       同一 conversationId——pending-aware 拦截会把任何人的回复路由到
    //       同一 broker。如果不校验身份，B 说 "好" 会误批准 A 的操作。
    //
    // 语义：
    //   - 仅当 pending 的 turnOrigin 来自"通道路径"（triggeredBy=userId，
    //     originChannel=msg.channelId）时才校验；其它来源（ephemeral/rpc）
    //     不应出现在 findBrokerByConversation 的查询里（它们无 conversationId）
    //   - 不匹配时**不拦截**（return false）—— 让消息走正常 agent 流程，
    //     不触碰 A 的 pending；A 自己回复时仍能正常解决
    //
    // 已知限制（非本 fix 范围）：A 的 confirmation 消息发到群 target 会被
    //   全员可见（隐私泄露）——DM 降级需要 adapter 能力扩展，记入 spec §9。
    const originSender = target.request.turnOrigin?.triggeredBy;
    const originChannel = target.request.turnOrigin?.channel;
    if (
      originSender &&
      originChannel === msg.channelId &&
      originSender !== msg.from
    ) {
      this.logger.info("confirmation.reply.not-owner-skip", {
        requestId: target.request.id,
        channelId: msg.channelId,
        conversationId,
        expectedSender: originSender,
        actualSender: msg.from,
      });
      return false;
    }

    const decision = matchTextToDecision(text);
    const ok = broker!.resolve(target.request.id, decision);
    const channelId = msg.channelId;

    // 埋点（§3.10 契约）：结构化 match vs 自由文本 reason 通过 isFreeTextDeny 辨别
    if (!ok) {
      this.logger.info("confirmation.reply.stale", {
        requestId: target.request.id,
        channelId,
      });
    } else if (isFreeTextDeny(decision)) {
      this.logger.info("confirmation.reply.matched-reason", {
        requestId: target.request.id,
        channelId,
        reasonLength: decision.reason.length,
      });
    } else {
      this.logger.info("confirmation.reply.matched-structured", {
        requestId: target.request.id,
        channelId,
        decision: decision.kind,
      });
    }

    // 回执——**控制流直接 adapter.send 绕过 Outbox**（spec §3.7）
    //
    // 为什么不走 this.emitReply：emitReply 在 outboxRegistry 存在时会走
    //   outbox.post，排在目标 target 已有的 pending entry（如等待 slot fill
    //   的 LLM 回复）之后——用户"好"的回执会被延迟到 LLM 回复之后才到达，
    //   违反"控制响应即时反馈"原则。
    // 语义对齐：TextRenderer 发 confirmation 消息就是直接 adapter.send 绕过
    //   outbox（§3.7）；对应的回执作为控制响应的另一端，同源同策。
    const replyTarget = buildReplyTarget(msg);
    const replyText = formatResolutionReceipt(target.request, decision, ok);
    const adapter = this.channels.get(replyTarget.channelId);
    if (adapter) {
      try {
        await adapter.send(replyTarget, { text: replyText });
      } catch (e) {
        this.logger.error(`confirmation reply failed: ${errMsg(e)}`);
      }
    } else {
      this.logger.warn(
        `confirmation reply: adapter not found for channel ${replyTarget.channelId}`,
      );
    }

    return true;
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
      // 远程确认回程地址（remote-confirmation-execution.md §3.3）：
      //   通道用户消息触发的 turn，任何 confirmation 请求按此 target 路由回原对话。
      turnOrigin: {
        channel: msg.channelId,
        target: replyTarget,
        triggeredBy: msg.from,
      },
    };

    // Phase 3：turn 启动即 open slot，让本 turn 内工具创建的任务（afterSlot=turnId）
    // 被阻塞到本 turn 的最终回复之后才发出。TTL 兜底防 slot 泄漏（INV-4）。
    if (this.outboxRegistry) {
      this.outboxRegistry.of(replyTarget).openSlot({ slotId: turnId });
    }

    try {
      // runTurnWithCommit：原子化 run + recordTurn + 异常 rollback。
      //   · 非 completed / commitTurn throw / runtime throw 三条异常路径均保证
      //     adapter state 回到 preRun，防止 orphan userMsg 污染下一轮 LLM 输入
      //   · commitTurn 失败通过 onCommitFailure hook 路由到 logger（observability）
      const gen = runTurnWithCommit(
        this.conversations,
        conversationId,
        msg.text,
        {
          turnContext,
          turnIndex: managed.turnCount,
          source: "channel",
        },
        {
          onCommitFailure: (err) => {
            this.logger.warn(
              `[持久化失败] conv=${conversationId}: ${errMsg(err)} (adapter state 已 rollback)`,
            );
          },
        },
      );
      let runResult: RunResult | undefined;

      while (true) {
        const iter = await gen.next();
        if (iter.done) {
          runResult = iter.value;
          break;
        }
        // inbound-router 消费 yield 但不 forward（channel 不做 streaming；
        // session.ts RPC 路径才用 session.delta 推送）
      }

      const agentResult = runResult?.agentResult;
      this.logger.info(`[处理完成] conv=${conversationId} reason=${agentResult?.reason ?? "no-result"}`);

      if (runResult && agentResult && agentResult.reason === "completed") {
        // turnStartedAt 不再用作 Turn.timestamp（buildTurn 在 run 结束时精确设定）——
        // 保留变量避免未来诊断字段需要 turn 入口时间时重新加逻辑
        void turnStartedAt;

        const content = buildOutboundContent(agentResult);
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
      } else if (agentResult) {
        const errorText =
          agentResult.reason === "error"
            ? `处理出错：${agentResult.error.message}`
            : agentResult.reason === "max_turns"
              ? "达到最大轮次限制。"
              : "处理被中止。";
        this.logger.warn(`[错误回复] conv=${conversationId} reason=${agentResult.reason}`);
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
