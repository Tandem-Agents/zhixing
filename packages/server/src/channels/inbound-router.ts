import {
  type ChannelBindingPolicy,
  type ChannelLogger,
  type DeliveryResult,
  type DeliveryTarget,
  type EmissionSource,
  type InboundMessage,
  type OutboundContent,
  type OutboxRegistry,
  type TurnContext,
  extractText,
  isFreeTextDeny,
  type AgentResult,
} from "@zhixing/core";
import type { ConfirmationHub } from "@zhixing/owner-kernel";
import type {
  ConversationAbortedResult,
  ConversationPreparedAgentTurnIdentity,
} from "@zhixing/core/conversation/application";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc/session-broadcast";
import {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  matchTextToDecision,
  formatResolutionReceipt,
} from "../confirmation/match.js";
import { resolveConversationId } from "./conversation-binder.js";
import { formatAbortReasonZh } from "./abort-formatter-zh.js";
import {
  createDefaultIntentClassifier,
  type ControlIntent,
  type IntentClassifier,
} from "../intent/index.js";

// ─── InboundRouter 入站消息路由器 ───
// 将入站消息路由到对应的对话会话中，并执行 Agent 处理

/**
 * graceful shutdown 期间对新到入站消息的统一文案。
 *
 * 关停链 LIFO 第 1 步触发 `refuseNewMessages()` 后,handleMessage 入口直接 emit
 * 这个文案 + log + return,不进 IntentClassifier / confirmation / agent。
 *
 * 设计:固定文案,与 abort 渲染层独立(那是 in-flight turn 被打断的反馈,这是
 * 关停期间新到孤立消息的反馈)—— 不进 abort formatter,不依赖 reason kind。
 */
const SHUTDOWN_REFUSAL_NOTICE_ZH = "服务暂时不可用,请稍后重新发送。";

/** 生产路由入口 descriptor；类本体与 S7 覆盖门禁共同消费。 */
export const INBOUND_ROUTER_ENTRY_DESCRIPTOR = {
  name: "InboundRouter",
} as const;

/** Finite Channel effect required by the inbound product surface. */
export interface InboundChannelPort {
  has(channelId: string): boolean;
  bindingPolicy(channelId: string): ChannelBindingPolicy | undefined;
  send(
    target: DeliveryTarget,
    content: OutboundContent,
  ): Promise<DeliveryResult>;
}

export type InboundConversationTurnOutcome =
  | Readonly<{ kind: "settled"; result: AgentResult }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "error"; error: unknown }>;

/**
 * Finite Conversation Product API binding consumed by the Channel Surface.
 * Conversation admission, Owner queues, durable protocol and terminal release
 * stay behind this port; the router owns only Surface projection and replies.
 */
export interface InboundConversationApplicationPort {
  prepareAgentTurn(input: Readonly<{
    channelId: string;
    platformSubject: string;
    messageId?: string;
  }>): Promise<ConversationPreparedAgentTurnIdentity>;
  admitAgentTurn(input: Readonly<{
    conversationId: string;
    text: string;
    turnIdentity: ConversationPreparedAgentTurnIdentity;
    turnContext: TurnContext;
    channelId: string;
    platformSubject: string;
    onStarted(): void;
    onPendingCancelled(): void;
    onProtocolEvent(method: string, params: unknown): void;
    onCommitFailure(error: unknown): void;
    onFinalPublishFailure(error: unknown): void;
    onOutcome(
      outcome: InboundConversationTurnOutcome,
      delivery: "authoritative" | "surface",
    ): Promise<void>;
    onSettled(delivery: "authoritative" | "surface"): void;
  }>): Promise<
    Readonly<{
      status:
        | "immediate"
        | "queued"
        | "replayed"
        | "queue-full"
        | "lifecycle-busy"
        | "not-found";
      conversationId: string;
      turnId: string;
    }>
  >;
  abort(input: Readonly<{
    conversationId: string;
    channelId: string;
    platformSubject: string;
    messageId?: string;
    replyTarget: DeliveryTarget;
  }>): Promise<ConversationAbortedResult>;
}

export interface InboundRouterOptions {
  conversation: InboundConversationApplicationPort;
  channels: InboundChannelPort;
  logger: ChannelLogger;
  /** Final side-effect gate for channel callbacks racing a current-owner switch. */
  isCurrentOwner?: () => boolean;
  /**
   * 可选 Outbox 顺序层。提供时，所有发往用户的回复经 Outbox.post 串行化；
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
   */
  confirmationHub?: ConfirmationHub;
  /**
   * 可选 IntentClassifier —— 在 confirmation 拦截**之前**做 control intent 识别。
   * 用户发"中止"/"/cancel"等关键词时优先 abort in-flight + 清 pending,而不是
   * 走 confirmation 或 agent 路径。
   *
   * 未提供时使用 `createDefaultIntentClassifier()` 兜底,保证 server 默认带 cancel
   * 能力(无声地接受 cancel 关键词,避免"飞书用户发取消但 agent 不停"的体验断崖)。
   * 显式传 classifier 可注入自定义 keyword 集合 / 关闭 cancel 能力(传一个永远返
   * non-control 的 stub)。
   */
  intentClassifier?: IntentClassifier;
  /**
   * 会话 observer 组播 getter。channel 消息属于同一 conversation 事实,
   * 其 assistant 输出也要投影给正在旁观该会话的接入面。
   */
  sessionBroadcast?: () => SessionBroadcast | null | undefined;
  /**
   * 非当前会话活动提示。只面向工作台类接入面,不携带消息内容。
   */
  sessionActivityBroadcast?: () => SessionActivityBroadcast | null | undefined;
}

export class InboundRouter {
  static readonly entryDescriptor = INBOUND_ROUTER_ENTRY_DESCRIPTOR;

  private readonly conversation: InboundConversationApplicationPort;
  private readonly channels: InboundChannelPort;
  private readonly logger: ChannelLogger;
  private readonly isCurrentOwner: () => boolean;
  private outboxRegistry?: OutboxRegistry;
  private readonly confirmationHub?: ConfirmationHub;
  private readonly intentClassifier: IntentClassifier;
  private readonly sessionBroadcast?: () => SessionBroadcast | null | undefined;
  private readonly sessionActivityBroadcast?: () =>
    | SessionActivityBroadcast
    | null
    | undefined;
  /** graceful shutdown 期间拒新标记 —— `refuseNewMessages()` 置 false */
  private acceptingNew = true;
  private acceptedInFlight = 0;
  private readonly acceptedDrainWaiters = new Set<() => void>();

  constructor(options: InboundRouterOptions) {
    this.conversation = options.conversation;
    this.channels = options.channels;
    this.logger = options.logger;
    this.isCurrentOwner = options.isCurrentOwner ?? (() => true);
    this.outboxRegistry = options.outboxRegistry;
    this.confirmationHub = options.confirmationHub;
    this.sessionBroadcast = options.sessionBroadcast;
    this.sessionActivityBroadcast = options.sessionActivityBroadcast;
    // 默认 classifier 注入 confirmation 词集让启动期互斥校验实际生效;
    // 显式注入的 classifier 自负其责(测试场景 / 关闭 cancel 能力等)。
    this.intentClassifier =
      options.intentClassifier ??
      createDefaultIntentClassifier({
        confirmationApproveKeywords: APPROVE_KEYWORDS,
        confirmationDenyKeywords: DENY_KEYWORDS,
      });
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
    if (!this.channels.has(target.channelId)) {
      this.logger.warn(`No adapter found for channel: ${target.channelId}`);
      return;
    }
    return this.channels.send(target, content);
  }

  /**
   * 处理入站消息。由 Host Channel runtime 的 onMessage 回调触发。
   *
   * 流程：
   * 1. 对话归组 → conversationId
   * 2. Conversation Product API 准入 → durable accepted/queued
   * 3. 有限 execution mechanism 执行 → 结果投影
   * 5. adapter.send() → 回复到触发通道
   */
  /**
   * graceful shutdown 期间拒收新入站消息 —— 关停链 LIFO 第 1 步触发(最先执行)。
   *
   * 调用后,后续 `handleMessage` 直接对每条消息回固定文案 + log + return,
   * 不进 IntentClassifier / confirmation / agent 任何路径(避免在已 drain 的
   * Conversation 应用入口启动新 turn)。反馈走 `adapter.send` 绕过 Outbox
   * (与 `handleControlIntent` 同源 —— 关停期间 Outbox 也在 drain),send 失败
   * try-catch 仅 log,不影响关停链。
   *
   * 幂等:重复调用 no-op。
   */
  refuseNewMessages(): void {
    this.acceptingNew = false;
  }

  /** Reopens the same admission gate after a pre-commit duty-device migration abort. */
  resumeNewMessages(): void {
    this.acceptingNew = true;
  }

  async drainAcceptedMessages(): Promise<void> {
    if (this.acceptedInFlight === 0) return;
    await new Promise<void>((resolve) => this.acceptedDrainWaiters.add(resolve));
  }

  async handleMessage(msg: InboundMessage): Promise<void> {
    if (!this.isCurrentOwner()) {
      this.logger.info(
        `[非当前owner拒绝] channel=${msg.channelId} from=${msg.from}`,
      );
      return;
    }
    if (!this.channels.has(msg.channelId)) {
      this.logger.warn(`No adapter found for channel: ${msg.channelId}`);
      return;
    }

    // 关停期间拒新 —— LIFO 关停顺序保证 channels.dispose 在第 5 步,acceptingNew=false
    // 到 server.close 之间(0~30s)channel 完全活着,反馈能送达;不进 IntentClassifier
    // / confirmation / agent 任何路径。
    if (!this.acceptingNew) {
      this.logger.info(
        `[拒新] conv shutdown channel=${msg.channelId} from=${msg.from}`,
      );
      const replyTarget = buildReplyTarget(msg);
      await this.channels
        .send(replyTarget, { text: SHUTDOWN_REFUSAL_NOTICE_ZH })
        .catch((e) => this.logger.error(`refusal notice send failed: ${errMsg(e)}`));
      return;
    }

    this.acceptedInFlight += 1;
    try {
      const conversationId = resolveConversationId(
        msg,
        this.channels.bindingPolicy(msg.channelId),
      );
      this.logger.info(`[收到] "${msg.text}" from=${msg.from} conv=${conversationId}`);

    // ── 控制意图前置识别(优先于一切其它路径) ──
    // 词集互斥由 IntentClassifier 启动期校验,不会与下方 confirmation 词集冲突;
    // 识别为 non-control 时让原 confirmation / agent 路径接管。
      const intent = this.intentClassifier.classify(msg);
      if (intent.kind === "control") {
        await this.handleControlIntent(intent.control, conversationId, msg);
        return;
      }

    // ── pending-aware 拦截 ──
    // 必须在 conversations.getOrCreate / enqueue **之前**：
    //   · 不占队列位（用户回复不是对 agent 的提问）
    //   · 不触发会话创建（会话已 idle release 的场景 "好" 不应重建会话）
    //   · 不进入 agent 推理（避免把 "好" 当成用户提问走 LLM）
      if (this.confirmationHub) {
        const handled = await this.tryHandleAsConfirmationReply(msg, conversationId);
        if (handled) return;
      }

      const replyTarget = buildReplyTarget(msg);
      const turnIdentity = await this.conversation.prepareAgentTurn({
        channelId: msg.channelId,
        platformSubject: msg.from,
        ...(msg.messageId ? { messageId: msg.messageId } : {}),
      });
      const turnId = turnIdentity.turnId;
      const turnContext = buildChannelTurnContext(
        msg,
        conversationId,
        turnId,
        replyTarget,
        this.outboxRegistry,
      );
      let admission: Awaited<
        ReturnType<InboundConversationApplicationPort["admitAgentTurn"]>
      >;
      try {
        admission = await this.conversation.admitAgentTurn({
          conversationId,
          text: msg.text,
          turnIdentity,
          turnContext,
          channelId: msg.channelId,
          platformSubject: msg.from,
          onStarted: () => {
            this.logger.info(`[开始处理] conv=${conversationId} text="${msg.text}"`);
            if (this.outboxRegistry) {
              this.outboxRegistry.of(replyTarget).openSlot({ slotId: turnId });
            }
          },
          onPendingCancelled: () => {
            this.logger.info(`[排队取消] conv=${conversationId}`);
          },
          onProtocolEvent: (method, params) => {
            this.sessionBroadcast?.()?.(conversationId, method, params);
          },
          onCommitFailure: (error) => {
            this.logger.warn(
              `[持久化失败] conv=${conversationId}: ${errMsg(error)} (adapter state 已 rollback)`,
            );
          },
          onFinalPublishFailure: (error) => {
            this.logger.warn(
              `[权威投递待重试] conv=${conversationId}: ${errMsg(error)}`,
            );
          },
          onOutcome: (outcome, delivery) =>
            this.projectExecutionOutcome({
              outcome,
              delivery,
              conversationId,
              channelId: msg.channelId,
              replyTarget,
              turnId,
            }),
          onSettled: (delivery) => {
            if (this.outboxRegistry && delivery === "surface") {
              this.outboxRegistry
                .of(replyTarget)
                .abandonSlot(turnId, "turn ended without reply emission");
            }
            this.logger.info(`[释放] conv=${conversationId} busy=false`);
            this.sessionActivityBroadcast?.()?.({
              conversationId,
              source: msg.channelId,
              lastActiveAt: new Date().toISOString(),
              unreadHint: true,
              listInvalidated: true,
            });
          },
        });
      } catch (err) {
        this.logger.error(`Failed to admit conversation ${conversationId}: ${errMsg(err)}`);
        await this.emitReply(
          replyTarget,
          { text: "场景正在切换或目录变更，请稍后重试。" },
          { kind: "system", handler: "conversation-admission-failed" },
        ).catch(() => {});
        return;
      }

      if (admission.status === "not-found") return;
      const status = admission.status;

      this.logger.info(`[调度] status=${status} conv=${conversationId}`);

      if (status === "queue-full") {
        this.logger.warn(`[丢弃] status=${status} conv=${conversationId}`);
        await this.emitReply(
          replyTarget,
          { text: "消息队列已满，请稍后再试。" },
          {
            kind: "system",
            handler: "conversation-queue-full",
          },
        ).catch((e) => this.logger.error(`Failed to send busy reply: ${errMsg(e)}`));
        return;
      }

      if (status === "lifecycle-busy") {
        await this.emitReply(
          replyTarget,
          { text: "场景正在切换或目录变更，请稍后重试。" },
          { kind: "system", handler: "conversation-admission-failed" },
        ).catch(() => {});
      }
    } finally {
      this.acceptedInFlight -= 1;
      if (this.acceptedInFlight === 0) {
        for (const resolve of this.acceptedDrainWaiters) resolve();
        this.acceptedDrainWaiters.clear();
      }
    }
  }

  /**
   * 处理控制意图(当前仅 cancel)。
   *
   * 耐久协议:整个批量取消是一个以渠道 messageId 派生 requestId 线性化的
   * cancel-batch 权威决定——候选冻结、逐 run 结果与空批次回执 item 都在该
   * 决定内产生,渠道重投经 exact replay 返回原批次、零重复副作用。用户反馈
   * 单源:非空批次由逐 run 权威 cancelled/aborted 投递承担,空批次回执由
   * DeliveryAuthority item 承担(幂等键 + 补投 + 负结果重驱),router 一律
   * 不直接发送。
   *
   * 兼容路径(未启用耐久协议)保留旧行为:按 `AbortResult` 三分支反馈,
   * abortedInFlight 时由 cleanup 路径产出唯一反馈,其余直接 `adapter.send`。
   */
  private async handleControlIntent(
    control: ControlIntent,
    conversationId: string,
    msg: InboundMessage,
  ): Promise<void> {
    if (control.kind !== "cancel") return;

    this.logger.info(
      `[控制] cancel keyword="${control.matchedKeyword}" conv=${conversationId} from=${msg.from}`,
    );

    const replyTarget = buildReplyTarget(msg);
    const result = await this.conversation.abort({
      conversationId,
      channelId: msg.channelId,
      platformSubject: msg.from,
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      replyTarget,
    });
    if (
      result.feedback.kind === "authoritative" ||
      result.feedback.kind === "in-flight"
    ) {
      // 反馈单源:让 cleanup 路径产出
      return;
    }
    if (!this.channels.has(replyTarget.channelId)) {
      this.logger.warn(
        `cancel ack: adapter not found for channel ${replyTarget.channelId}`,
      );
      return;
    }

    const text =
      result.feedback.kind === "pending"
        ? `已取消队列中的 ${result.feedback.count} 条待处理消息。`
        : "当前没有正在处理的任务。";

    await this.channels
      .send(replyTarget, { text })
      .catch((e) => this.logger.error(`cancel ack send failed: ${errMsg(e)}`));
  }

  /**
   * pending-aware 拦截：若当前会话有 pending confirmation，按词集匹配规则解决。
   *
   * 返回 true 表示已处理（调用方 return 不走 agent 流程）；false 表示未处理（正常排队）。
   *
   * 语义：
   *   - 无 pending → 正常进入 agent 流程
   *   - 空消息 → 不拦截（避免空字符串误命中）
   *   - 匹配允许词集 → broker.resolve(allow-once)
   *   - 匹配拒绝词集 → broker.resolve(deny)
   *   - 其他任意文本 → broker.resolve(deny, reason=整条消息)（自由文本理由）
   *
   * 埋点：
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
    // 已知限制：群 target 会向全员展示确认内容。这里的发起者校验只阻止他人
    //   代答，不解决内容披露；私聊降级需要通道能力合同明确支持后才能实施。
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
    let ok = false;
    let resolutionError: unknown;
    try {
      ok = broker!.resolveDurably
        ? await broker!.resolveDurably(target.request.id, decision)
        : broker!.resolve(target.request.id, decision);
    } catch (error) {
      resolutionError = error;
      this.logger.error(`confirmation resolution failed: ${errMsg(error)}`);
    }
    const channelId = msg.channelId;

    // 埋点：结构化 match vs 自由文本 reason 通过 isFreeTextDeny 辨别
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

    // 回执——控制流直接 adapter.send 绕过 Outbox
    //
    // 为什么不走 this.emitReply：emitReply 在 outboxRegistry 存在时会走
    //   outbox.post，排在目标 target 已有的 pending entry（如等待 slot fill
    //   的 LLM 回复）之后——用户"好"的回执会被延迟到 LLM 回复之后才到达，
    //   违反"控制响应即时反馈"原则。
    // 语义对齐：TextRenderer 发 confirmation 消息就是直接 adapter.send 绕过
    //   outbox；对应的回执作为控制响应的另一端，同源同策。
    // 边界：渠道 confirmation 交互（challenge/token、回执耐久性与崩溃重驱）的
    //   终态协议归执行计划第 24 单元；本回执在此前保持既有直发语义。
    //   批量取消的回执已迁入 cancel-batch 权威决定的 DeliveryAuthority item，
    //   与本分支无关。
    const replyTarget = buildReplyTarget(msg);
    const replyText = resolutionError
      ? `⚠️ 确认结果尚未耐久保存，请重试：${target.request.display.title}`
      : formatResolutionReceipt(target.request, decision, ok);
    if (this.channels.has(replyTarget.channelId)) {
      try {
        await this.channels.send(replyTarget, { text: replyText });
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

  private async projectExecutionOutcome(input: Readonly<{
    outcome: InboundConversationTurnOutcome;
    delivery: "authoritative" | "surface";
    conversationId: string;
    channelId: string;
    replyTarget: DeliveryTarget;
    turnId: string;
  }>): Promise<void> {
    const { outcome, delivery, conversationId, channelId, replyTarget, turnId } = input;
    try {
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "aborted") return;

      const agentResult = outcome.result;
      this.logger.info(`[处理完成] conv=${conversationId} reason=${agentResult?.reason ?? "no-result"}`);

      if (agentResult.reason === "completed") {
        const content = buildOutboundContent(agentResult);
        const hasContent = content.text.trim().length > 0;
        this.logger.info(
          `[回复] conv=${conversationId} len=${content.text.length} empty=${!hasContent} text="${content.text}"`,
        );
        if (delivery === "authoritative") {
          // Non-empty finals atomically fill the slot through the authority transport.
          // An empty final has no delivery item, so only that case closes the slot here.
          if (!hasContent && this.outboxRegistry) {
            await this.outboxRegistry.of(replyTarget).fillSlot(turnId);
          }
        } else if (hasContent) {
          await this.emitReply(
            replyTarget,
            content,
            { kind: "llm-reply", conversationId, turnId },
            turnId,
          ).catch((e) =>
            this.logger.error(`Failed to send reply to ${channelId}: ${errMsg(e)}`),
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
      } else {
        // 显式 if 分支而非三元链:三元链下 TS 没法把 reason narrow 排除 "completed"
        // (跨分支 narrowing 失效),会让 abortReason 字段访问报 TS2339
        let errorText: string;
        if (agentResult.reason === "error") {
          errorText = `处理出错：${agentResult.error.message}`;
        } else if (agentResult.reason === "max_turns") {
          errorText = "达到最大轮次限制。";
        } else if (agentResult.reason === "aborted") {
          errorText = formatAbortReasonZh(agentResult.abortReason);
        } else {
          // reason === "completed" 已被外层 if 分支处理,这里不可达
          errorText = "处理已完成。";
        }
        this.logger.warn(`[错误回复] conv=${conversationId} reason=${agentResult.reason}`);
        if (delivery === "surface") {
          await this.emitReply(
            replyTarget,
            { text: errorText },
            { kind: "llm-reply", conversationId, turnId },
            turnId,
          ).catch((e) =>
            this.logger.error(`Failed to send error reply: ${errMsg(e)}`),
          );
        }
      }
    } catch (err) {
      this.logger.error(`[异常] conv=${conversationId}: ${errMsg(err)}`);
      if (delivery === "surface") {
        await this.emitReply(
          replyTarget,
          { text: "内部错误，请稍后重试。" },
          { kind: "system", handler: "inbound-router-error" },
          turnId,
        ).catch(() => {});
      }
    }
  }
}

// ─── 工具函数 ───

function buildChannelTurnContext(
  msg: InboundMessage,
  conversationId: string,
  turnId: string,
  replyTarget: DeliveryTarget,
  outboxRegistry: OutboxRegistry | undefined,
): TurnContext {
  return {
    turnId,
    emissionTarget: replyTarget,
    commitToUser: outboxRegistry
      ? (content: OutboundContent, meta?: { toolName?: string }) =>
          outboxRegistry.of(replyTarget).post({
            target: replyTarget,
            content,
            source: {
              kind: "tool-commitment",
              conversationId,
              turnId,
              toolName: meta?.toolName ?? "unknown",
            },
          })
      : undefined,
    turnOrigin: {
      channel: msg.channelId,
      target: replyTarget,
      triggeredBy: msg.from,
    },
  };
}

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
