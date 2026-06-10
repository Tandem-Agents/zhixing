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
}

export class InboundRouter {
  private readonly conversations: ConversationManager;
  private readonly channels: ChannelRegistry;
  private readonly logger: ChannelLogger;
  private outboxRegistry?: OutboxRegistry;
  private readonly confirmationHub?: ConfirmationHub;
  private readonly intentClassifier: IntentClassifier;
  /** graceful shutdown 期间拒新标记 —— `refuseNewMessages()` 置 false */
  private acceptingNew = true;

  constructor(options: InboundRouterOptions) {
    this.conversations = options.conversations;
    this.channels = options.channels;
    this.logger = options.logger;
    this.outboxRegistry = options.outboxRegistry;
    this.confirmationHub = options.confirmationHub;
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
  /**
   * graceful shutdown 期间拒收新入站消息 —— 关停链 LIFO 第 1 步触发(最先执行)。
   *
   * 调用后,后续 `handleMessage` 直接对每条消息回固定文案 + log + return,
   * 不进 IntentClassifier / confirmation / agent 任何路径(避免在已 drain 的
   * ConversationManager 上启动新 turn)。反馈走 `adapter.send` 绕过 Outbox
   * (与 `handleControlIntent` 同源 —— 关停期间 Outbox 也在 drain),send 失败
   * try-catch 仅 log,不影响关停链。
   *
   * 幂等:重复调用 no-op。
   */
  refuseNewMessages(): void {
    this.acceptingNew = false;
  }

  async handleMessage(msg: InboundMessage): Promise<void> {
    const adapter = this.channels.get(msg.channelId);
    if (!adapter) {
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
      await adapter
        .send(replyTarget, { text: SHUTDOWN_REFUSAL_NOTICE_ZH })
        .catch((e) => this.logger.error(`refusal notice send failed: ${errMsg(e)}`));
      return;
    }

    const conversationId = resolveConversationId(msg, adapter.bindingPolicy);
    this.logger.info(`[收到] "${msg.text}" from=${msg.from} conv=${conversationId}`);

    // ── 控制意图前置识别(优先于一切其它路径) ──
    // 词集互斥由 IntentClassifier 启动期校验,不会与下方 confirmation 词集冲突;
    // 识别为 non-control 时让原 confirmation / agent 路径接管。
    const intent = this.intentClassifier.classify(msg);
    if (intent.kind === "control") {
      await this.handleControlIntent(intent.control, conversationId, msg);
      return;
    }

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
   * 处理控制意图(当前仅 cancel)。按 `AbortResult` 双维度做反馈三分支:
   *
   *   - `abortedInFlight === true`: **不在此处反馈** —— in-flight turn 走主模块
   *     cleanup 路径(≤200ms)产出 RunResult.aborted,由 `runChannelTurn` 走
   *     `formatAbortReasonZh` 产生唯一一条反馈。在这里再 emit 会让用户收到两条
   *     重复消息(反馈单源原则)
   *   - `cancelledPending > 0`: 无 in-flight 但 pending queue 有任务被清,直接
   *     反馈"已取消队列中的 N 条待处理消息"
   *   - 都假: 既无 in-flight 也无 pending,反馈"当前没有正在处理的任务"
   *
   * 反馈直接 `adapter.send` 绕过 Outbox(与 confirmation 回执 §3.7 同源策略) ——
   * Outbox 排队会让控制响应被业务消息延迟,违反"控制响应即时反馈"原则。
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

    const result = this.conversations.abort(conversationId, {
      kind: "user-cancel",
      source: "rpc",
      pressedAt: Date.now(),
    });

    if (result.abortedInFlight) {
      // 反馈单源:让 cleanup 路径产出
      return;
    }

    const replyTarget = buildReplyTarget(msg);
    const adapter = this.channels.get(replyTarget.channelId);
    if (!adapter) {
      this.logger.warn(
        `cancel ack: adapter not found for channel ${replyTarget.channelId}`,
      );
      return;
    }

    const text =
      result.cancelledPending > 0
        ? `已取消队列中的 ${result.cancelledPending} 条待处理消息。`
        : "当前没有正在处理的任务。";

    await adapter
      .send(replyTarget, { text })
      .catch((e) => this.logger.error(`cancel ack send failed: ${errMsg(e)}`));
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
      // runTurnWithCommit：run + 按结果 recordTurn（接受协议：先持久化、后入窗）。
      //   · 非 completed / 持久化 throw / runtime throw 三条异常路径下窗口都
      //     停在 run 前基底，防止 orphan userMsg 污染下一轮 LLM 输入
      //   · 持久化失败通过 onCommitFailure hook 路由到 logger（observability）
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
        // turnStartedAt 不用作 run record 的 timestamp（buildRunRecord 在 run 结束时
        // 精确设定）—— 保留变量避免未来诊断字段需要 turn 入口时间时重新加逻辑
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
